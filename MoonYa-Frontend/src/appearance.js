/*
 * 外观自定义：背景图/视频、模糊度、界面不透明度、配色与主题库。
 * 一切皆风格自定义 —— 基底只提供 浅色/深色/跟随系统，其它全部由这里叠加。
 *
 * 载入位置：<head> 的 bootstrap，紧随 theme.js。首屏必须先用缓存把 inline CSS 变量写好，
 * 否则会先亮一下基底再跳到用户配色。背景媒体依赖 DOM，推迟到 DOMContentLoaded。
 * 落盘：localStorage 作首屏缓存（每次都写），原生 appearance.json 走防抖 + 串行队列。
 */
(function () {
    'use strict';

    const CACHE_KEY = 'moonya.appearance.v1';
    const MAX_BLUR = 60;
    const MIN_OPACITY = 0.2;
    const MAX_OPACITY = 1;
    const DEFAULT_OPACITY = 0.85;
    const HEX = /^#[0-9a-fA-F]{6}$/;
    const BG_TYPES = ['none', 'image', 'video'];
    const FILLS = ['cover', 'contain', 'fill'];

    const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];
    const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv', '.m4v'];

    // 桌面端内嵌的 Chromium（CefSharp 官方 libcef）**不含专有编解码器**：
    //   canPlayType('video/mp4; codecs="avc1…"') → ''（H.264 无解码器）
    //   VideoDecoder.isConfigSupported(avc1) → false（三种硬件偏好全试过）
    // 后果：mp4/mov 即使路径、字节都完好，页面内也只会报 MEDIA_ELEMENT_ERROR: Format error，
    // 而 webm（VP8/VP9）正常。所以 mp4 交给宿主用 Windows Media Foundation 原生播放
    // （见 MainWindow.NativeVideo.cs），页面内只保留 webm 这条路。
    const DECODABLE_VIDEO_EXT = ['.webm'];
    const VIDEO_HINT = '请改用 WebM（VP9/VP8）视频';

    // 宿主原生播放能力（/runtime-config.js 注入）。旧客户端没有这个能力位，
    // 于是自动退回「页面内探测 + 诚实拒绝」的老行为，不需要判断版本号。
    const NATIVE_VIDEO_FALLBACK_EXT = ['.mp4', '.m4v', '.mov'];
    // 启动画面只有 WPF 层、没有页面内 <video> 兜底 → 视频一律走宿主 MF；.mkv 排除（MF 无 Matroska demuxer）。
    const SPLASH_VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm'];

    function nativeVideo() {
        return !!(window.MoonYaHost && window.MoonYaHost.nativeVideo);
    }

    function nativeVideoExtensions() {
        const list = window.MoonYaHost && window.MoonYaHost.nativeVideoExtensions;
        if (!Array.isArray(list) || !list.length) return NATIVE_VIDEO_FALLBACK_EXT;
        return list.map(ext => String(ext).toLowerCase());
    }

    /** 该路径是否由宿主原生播放（而不是页面内 <video>）。 */
    function usesNativeVideo(path) {
        return nativeVideo() && nativeVideoExtensions().includes(extensionOf(path));
    }

    // 颜色项 → 落点变量。surface 需要把 hex 同步成 "r, g, b" 三元组，
    // 否则依赖 rgba(var(--theme-surface-rgb), a) 的面板会变透明。
    const COLOR_DEFS = [
        { key: 'appBackground', label: '主背景', vars: ['--ui-shell', '--theme-shell'] },
        { key: 'sidebar', label: '侧边栏', vars: ['--theme-sidebar', '--ui-sidebar'] },
        { key: 'surface', label: '卡片 / 面板 / 气泡', vars: ['--theme-surface', '--dsw-specific-bubble', '--ui-bg'], rgb: '--theme-surface-rgb' },
        { key: 'inputBackground', label: '输入框背景', vars: ['--moonya-input-bg'] },
        { key: 'inputText', label: '输入框文字', vars: ['--moonya-input-text'] },
        { key: 'buttonBackground', label: '按钮背景', vars: ['--moonya-btn-bg'] },
        { key: 'buttonText', label: '按钮文字', vars: ['--moonya-btn-text'] },
        { key: 'border', label: '边框', vars: ['--theme-border', '--ui-border'] },
        { key: 'accent', label: '强调色', vars: ['--ui-accent', '--theme-accent-text'] },
        { key: 'textPrimary', label: '正文文字', vars: ['--theme-text'] },
        { key: 'textSecondary', label: '次要文字', vars: ['--theme-secondary'] }
    ];
    const COLOR_BY_KEY = new Map(COLOR_DEFS.map(def => [def.key, def]));
    const ALL_COLOR_VARS = COLOR_DEFS.reduce((all, def) => all.concat(def.vars), []);

    let model = normalize(readCache());
    let bridge = null;
    let revision = 0;
    let writes = Promise.resolve();
    let nativeTimer = null;
    let layer = null;

    /* ── 归一化 ────────────────────────────────────────────── */

    function defaultLayer() {
        return {
            background: { type: 'none', path: null, fill: 'cover', video: { muted: true, loop: true } },
            blur: 0,
            shellOpacity: DEFAULT_OPACITY,
            colors: {}
        };
    }

    function clamp(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, number));
    }

    function normalizeBucket(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const background = source.background && typeof source.background === 'object' ? source.background : {};
        const type = BG_TYPES.includes(background.type) ? background.type : 'none';
        const colors = {};
        if (source.colors && typeof source.colors === 'object') {
            Object.keys(source.colors).forEach(key => {
                if (!COLOR_BY_KEY.has(key)) return;
                const value = source.colors[key];
                if (typeof value === 'string' && HEX.test(value)) colors[key] = value.toLowerCase();
            });
        }
        return {
            background: {
                type,
                path: typeof background.path === 'string' && background.path ? background.path : null,
                fill: FILLS.includes(background.fill) ? background.fill : 'cover',
                video: { muted: true, loop: true }
            },
            blur: Math.round(clamp(source.blur, 0, MAX_BLUR, 0)),
            shellOpacity: clamp(source.shellOpacity, MIN_OPACITY, MAX_OPACITY, DEFAULT_OPACITY),
            colors
        };
    }

    // 启动画面背景：与主界面背景完全独立。图片走 WIC，视频由宿主原生播放（MF）。
    // 注意这里**不按能力位裁剪**：旧客户端读到视频设置也只做展示层降级，绝不把数据抹掉。
    function normalizeSplash(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const path = typeof source.path === 'string' && source.path ? source.path : null;
        const type = path && (source.type === 'image' || source.type === 'video') ? source.type : 'none';
        return {
            type,
            path: type === 'none' ? null : path,
            fill: FILLS.includes(source.fill) ? source.fill : 'cover'
        };
    }

    function normalize(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const result = {
            version: 1,
            activeThemeId: typeof source.activeThemeId === 'string' ? source.activeThemeId : 'default',
            // 内置主题的激活标记。C# 侧只校验已知字段，未知顶层字段照原样回存，所以无需改 C#。
            activeBuiltin: typeof source.activeBuiltin === 'string' && source.activeBuiltin ? source.activeBuiltin : null,
            splash: normalizeSplash(source.splash),
            working: normalizeBucket(source.working),
            themes: []
        };
        if (Array.isArray(source.themes)) {
            source.themes.forEach(entry => {
                if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return;
                result.themes.push(Object.assign(
                    { id: entry.id, name: typeof entry.name === 'string' && entry.name ? entry.name : '未命名主题' },
                    normalizeBucket(entry),
                    { updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null }
                ));
            });
        }
        if (result.activeThemeId !== 'default' && !result.themes.some(theme => theme.id === result.activeThemeId)) {
            result.activeThemeId = 'default';
        }
        return result;
    }

    function readCache() {
        try {
            const text = localStorage.getItem(CACHE_KEY);
            return text ? JSON.parse(text) : null;
        } catch (_) { return null; }
    }

    function clone(value) { return JSON.parse(JSON.stringify(value)); }

    /* ── 套用到 DOM ────────────────────────────────────────── */

    function hexToRgbTriplet(hex) {
        const value = parseInt(hex.slice(1), 16);
        return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
    }

    function applyColors() {
        const root = document.documentElement;
        ALL_COLOR_VARS.forEach(name => root.style.removeProperty(name));
        root.style.removeProperty('--theme-surface-rgb');
        const colors = model.working.colors;
        Object.keys(colors).forEach(key => {
            const def = COLOR_BY_KEY.get(key);
            if (!def) return;
            def.vars.forEach(name => root.style.setProperty(name, colors[key]));
            if (def.rgb) root.style.setProperty(def.rgb, hexToRgbTriplet(colors[key]));
        });
    }

    function applyMetrics() {
        const root = document.documentElement;
        root.style.setProperty('--moonya-bg-blur', `${model.working.blur}px`);
        root.style.setProperty('--moonya-shell-opacity', String(model.working.shellOpacity));
    }

    function mediaUrl(path) {
        const token = window.MoonYaHost && window.MoonYaHost.mediaToken;
        if (!path || !token) return null;
        return '/local-media?t=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(path);
    }

    function extensionOf(path) {
        const name = String(path || '').split(/[\\/]/).pop() || '';
        const dot = name.lastIndexOf('.');
        return dot < 0 ? '' : name.slice(dot).toLowerCase();
    }

    /**
     * 问一次 HTTP 状态：文件还在不在？
     * 媒体元素对「403」和「编码解不出来」都给同一个 MEDIA_ELEMENT_ERROR: Format error，
     * 光看 error.code 分不清 —— 所以必须另问一次路由。
     * 返回 true=能取到 / false=取不到（被移动、删除、或不在白名单）/ null=探测本身失败（不妄下结论）。
     */
    async function mediaReachable(url) {
        if (!url || typeof fetch !== 'function') return null;
        try {
            const response = await fetch(url, { method: 'HEAD' });
            return response.ok;
        } catch (_) {
            return null;
        }
    }

    /**
     * 让浏览器真解一遍这个 URL，而不是靠扩展名猜。
     * 'ok' 可播放 / 'unsupported' 取得到但解不出来（编码问题） / 'unreachable' 取不到 / 'timeout' 没结论。
     * 只读：节点不进 DOM、不改配置、结束即释放 src。
     */
    function probeMedia(kind, url, timeoutMs) {
        if (!url) return Promise.resolve('unreachable');
        const tag = kind === 'video' ? 'video' : 'img';
        if (typeof document.createElement !== 'function') return Promise.resolve('unknown');
        return new Promise(resolve => {
            let settled = false;
            const node = document.createElement(tag);
            const finish = outcome => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try {
                    node.removeAttribute('src');
                    if (tag === 'video' && typeof node.load === 'function') node.load();
                } catch (_) { /* 释放失败不影响结论 */ }
                resolve(outcome);
            };
            const timer = setTimeout(() => finish('timeout'), timeoutMs || 8000);
            node.addEventListener(tag === 'video' ? 'loadedmetadata' : 'load', () => finish('ok'));
            node.addEventListener('error', () => {
                mediaReachable(url).then(reachable => finish(reachable === false ? 'unreachable' : 'unsupported'));
            });
            if (tag === 'video') {
                node.muted = true;
                node.preload = 'metadata';
                node.setAttribute('muted', '');
                node.setAttribute('playsinline', '');
            } else {
                node.alt = '';
            }
            node.src = url;
        });
    }

    /** 把一次失败的加载翻译成用户能据此行动的原因，而不是笼统一句「文件可能已被删除」。 */
    function describeMediaFailure(path, reachable) {
        if (reachable === false) return '背景文件无法读取，可能已被移动或删除';
        const ext = extensionOf(path);
        if (ext && !DECODABLE_VIDEO_EXT.includes(ext)) {
            return `本客户端解不出 ${ext.slice(1).toUpperCase()} 视频（内嵌浏览器不含 H.264/AAC 专有编解码器），${VIDEO_HINT}`;
        }
        return `这段视频的编码本客户端也解不出来，${VIDEO_HINT}`;
    }

    /** 视频落盘前先验一遍；返回 null 表示通过（或没结论），否则返回给用户看的说明。 */
    async function rejectUnplayableVideo(path) {
        const url = mediaUrl(path);
        // 没有媒体令牌 = 旧客户端根本没有 /local-media，交给面板上那条提示说明。
        if (!url) return null;
        const outcome = await probeMedia('video', url);
        if (outcome !== 'unsupported' && outcome !== 'unreachable') return null;
        return describeMediaFailure(path, outcome === 'unreachable' ? false : true);
    }

    let fileOps = null;

    /**
     * 桌面桥是按需绑定的：CefSharp 不会把 moonYaFileOps 直接挂到 window 上，
     * 必须先 BindObjectAsync('moonYaFileOps')（同 script-1d-dom.js 的 getLocalPathBridge）。
     * 因此「能不能选本地文件」只能按宿主是否存在来判断，绑定在这里懒完成。
     */
    async function ensureFileOps() {
        if (fileOps && typeof fileOps.pickLocalFiles === 'function') return fileOps;
        if (!window.CefSharp || !window.CefSharp.BindObjectAsync) return null;
        try {
            await window.CefSharp.BindObjectAsync('moonYaFileOps');
        } catch (error) {
            console.warn('MoonYa file bridge could not be bound:', error);
            return null;
        }
        fileOps = window.moonYaFileOps && typeof window.moonYaFileOps.pickLocalFiles === 'function'
            ? window.moonYaFileOps
            : null;
        refreshPanel();
        return fileOps;
    }

    function ensureLayer() {
        if (layer && layer.isConnected) return layer;
        if (!document.body) return null;
        const existing = document.getElementById('moonyaAppearanceBackground');
        if (existing) { layer = existing; return layer; }
        layer = document.createElement('div');
        layer.id = 'moonyaAppearanceBackground';
        layer.setAttribute('aria-hidden', 'true');
        document.body.insertBefore(layer, document.body.firstChild);
        return layer;
    }

    function renderBackground() {
        const host = ensureLayer();
        if (!host) return;
        const background = model.working.background;
        const url = background.type === 'none' ? null : mediaUrl(background.path);
        const signature = [background.type, background.path, background.fill, url].join('|');
        if (host.dataset.signature === signature) return;
        host.dataset.signature = signature;
        host.replaceChildren();
        document.body.classList.remove('moonya-native-video');

        if (!url) {
            document.body.classList.remove('moonya-has-background');
            return;
        }

        if (background.type === 'video' && usesNativeVideo(background.path)) {
            document.body.classList.add('moonya-has-background', 'moonya-native-video');
            return;
        }

        if (background.type === 'video') {
            const video = document.createElement('video');
            video.className = 'moonya-bg-media';
            video.muted = true; video.loop = true; video.autoplay = true;
            video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
            video.style.objectFit = background.fill;
            video.addEventListener('error', () => onMediaError(background.path, url));
            video.src = url;
            const started = video.play();
            if (started && typeof started.catch === 'function') started.catch(() => {});
            host.appendChild(video);
        } else {
            const image = document.createElement('img');
            image.className = 'moonya-bg-media';
            image.alt = '';
            image.decoding = 'async';
            image.style.objectFit = background.fill;
            image.addEventListener('error', () => onMediaError(background.path, url));
            image.src = url;
            host.appendChild(image);
        }
        document.body.classList.add('moonya-has-background');
    }

    function onMediaError(path, url) {
        const host = document.getElementById('moonyaAppearanceBackground');
        if (host) host.replaceChildren();
        document.body.classList.remove('moonya-has-background');
        // 先问清是「文件没了」还是「编码解不出来」再说话 —— 后者过去被误报成前者。
        mediaReachable(url).then(reachable => {
            const reason = describeMediaFailure(path, reachable);
            notify(reason);
            setText('moonyaBgStatus', reason);
        });
    }

    function applyAll() {
        applyColors();
        applyMetrics();
        if (document.body) renderBackground();
    }

    /* ── 持久化 ────────────────────────────────────────────── */

    function notify(message) {
        if (typeof window.showToast === 'function') window.showToast(message);
    }

    function persistLocal() {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(model)); } catch (_) {}
    }

    function persistNative() {
        nativeTimer = null;
        if (!bridge) return;
        const snapshot = JSON.stringify(model);
        writes = writes
            .then(() => bridge.setAppearance(snapshot))
            .catch(error => {
                console.warn('MoonYa appearance preference could not be saved:', error);
                notify('外观已应用，客户端保存失败');
            });
    }

    function scheduleSave() {
        revision += 1;
        persistLocal();
        if (!bridge) return;
        if (nativeTimer) clearTimeout(nativeTimer);
        nativeTimer = setTimeout(persistNative, 200);
    }

    function flushNative() {
        if (!nativeTimer) return;
        clearTimeout(nativeTimer);
        persistNative();
    }

    function emit(name, detail) {
        window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    }

    function changed(themesToo) {
        applyAll();
        scheduleSave();
        emit('moonya:appearance-change', { working: clone(model.working), activeThemeId: model.activeThemeId });
        if (themesToo) emit('moonya:appearance-themes-change', { themes: clone(model.themes) });
    }

    function makeId() {
        return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function stamp() { return new Date().toISOString(); }

    /* ── 对外 API ──────────────────────────────────────────── */

    const api = {
        COLOR_DEFS,
        IMAGE_EXT,
        VIDEO_EXT,
        MAX_BLUR,
        get: () => clone(model),
        getBlur: () => model.working.blur,
        getShellOpacity: () => model.working.shellOpacity,
        getBackground: () => clone(model.working.background),
        getActiveThemeId: () => model.activeThemeId,
        hasBridge: () => !!bridge,
        mediaUrl,

        // 宿主存在即代表是桌面客户端；moonYaFileOps 由 ensureFileOps 按需绑定。
        canUseLocalMedia: () => !!(window.CefSharp && window.CefSharp.BindObjectAsync),

        setBlur(value) {
            const next = Math.round(clamp(value, 0, MAX_BLUR, model.working.blur));
            if (next === model.working.blur) return next;
            model.working.blur = next;
            changed(false);
            return next;
        },

        setShellOpacity(value) {
            const next = Math.round(clamp(value, MIN_OPACITY, MAX_OPACITY, model.working.shellOpacity) * 100) / 100;
            if (next === model.working.shellOpacity) return next;
            model.working.shellOpacity = next;
            changed(false);
            return next;
        },

        setColor(key, hex) {
            if (!COLOR_BY_KEY.has(key)) return false;
            if (typeof hex !== 'string' || !HEX.test(hex)) return false;
            model.working.colors[key] = hex.toLowerCase();
            changed(false);
            return true;
        },

        clearColor(key) {
            if (!COLOR_BY_KEY.has(key) || !(key in model.working.colors)) return false;
            delete model.working.colors[key];
            changed(false);
            return true;
        },

        isColorCustomized: key => key in model.working.colors,

        setBackground(patch) {
            const next = Object.assign({}, model.working.background, patch || {});
            if (!BG_TYPES.includes(next.type)) next.type = 'none';
            if (!FILLS.includes(next.fill)) next.fill = 'cover';
            if (next.type === 'none') next.path = null;
            if (next.type !== 'none' && !next.path) return false;
            model.working.background = next;
            // 用户自己换背景就不再是内置主题的那套了。
            if (patch && Object.prototype.hasOwnProperty.call(patch, 'path')) model.activeBuiltin = null;
            changed(false);
            return true;
        },

        clearBackground() {
            model.working.background = { type: 'none', path: null, fill: model.working.background.fill, video: { muted: true, loop: true } };
            model.activeBuiltin = null;
            changed(false);
        },

        nativeVideoFailed(message) {
            if (!usesNativeVideo(model.working.background.path) || model.working.background.type !== 'video') return;
            document.body.classList.remove('moonya-has-background', 'moonya-native-video');
            notify(message);
            setText('moonyaBgStatus', message);
        },

        getSplash: () => clone(model.splash),

        setSplash(patch) {
            const next = Object.assign({}, model.splash, patch || {});
            if ((next.type !== 'image' && next.type !== 'video') || !next.path) { next.type = 'none'; next.path = null; }
            // 视频只能由宿主原生播放；没有该能力就不接受，免得存下一个必然播不了的背景。
            if (next.type === 'video' && (!nativeVideo() || !SPLASH_VIDEO_EXT.includes(extensionOf(next.path)))) {
                next.type = 'none';
                next.path = null;
            }
            if (!FILLS.includes(next.fill)) next.fill = 'cover';
            model.splash = next;
            changed(false);
            return true;
        },

        clearSplash() {
            model.splash = { type: 'none', path: null, fill: model.splash.fill };
            changed(false);
        },

        getActiveBuiltin: () => model.activeBuiltin,

        listBuiltin: () => clone(builtinThemes),
        getAssetState: slug => builtinAssetState(slug),
        getAssetProgress: slug => assetProgress.get(slug) || 0,

        /** 应用一套已下载好的内置主题（背景路径指向本地缓存，完全离线）。 */
        applyBuiltin(slug, localPath) {
            const theme = builtinThemes.find(item => item.slug === slug);
            if (!theme || !localPath) return false;
            model.working = normalizeBucket({
                background: { type: theme.background.type, path: localPath, fill: theme.background.fill },
                blur: theme.blur,
                shellOpacity: theme.shellOpacity,
                colors: theme.colors
            });
            model.activeBuiltin = slug;
            model.activeThemeId = 'default';
            changed(false);
            return true;
        },

        /** C# 下载桥回调：window.MoonYaAppearance.acceptAssetProgress(slug, percent, loaded, total) */
        acceptAssetProgress(slug, percent, loaded, total) {
            if (typeof slug !== 'string' || !slug) return;
            const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
            if (builtinAssetState(slug) !== 'downloading') assetStates.set(slug, 'downloading');
            assetProgress.set(slug, clamped);
            updateCardState(slug);
            emit('moonya:appearance-asset-progress', {
                slug, percent: clamped, loaded: Number(loaded) || 0, total: Number(total) || 0
            });
        },

        reset() {
            model.working = defaultLayer();
            model.activeThemeId = 'default';
            model.activeBuiltin = null;
            changed(true);
        },

        listThemes: () => clone(model.themes),

        saveAsTheme(name) {
            const label = (typeof name === 'string' && name.trim()) || `主题 ${model.themes.length + 1}`;
            const entry = Object.assign({ id: makeId(), name: label }, clone(model.working), { updatedAt: stamp() });
            model.themes.push(entry);
            model.activeThemeId = entry.id;
            changed(true);
            return entry.id;
        },

        applyTheme(id) {
            if (id === 'default') {
                model.working = defaultLayer();
                model.activeThemeId = 'default';
                model.activeBuiltin = null;
                changed(false);
                return true;
            }
            const entry = model.themes.find(theme => theme.id === id);
            if (!entry) return false;
            model.working = normalizeBucket(entry);
            model.activeThemeId = id;
            model.activeBuiltin = null;
            changed(false);
            return true;
        },

        renameTheme(id, name) {
            const entry = model.themes.find(theme => theme.id === id);
            const label = typeof name === 'string' ? name.trim() : '';
            if (!entry || !label) return false;
            entry.name = label;
            entry.updatedAt = stamp();
            changed(true);
            return true;
        },

        removeTheme(id) {
            const index = model.themes.findIndex(theme => theme.id === id);
            if (index < 0) return false;
            model.themes.splice(index, 1);
            if (model.activeThemeId === id) model.activeThemeId = 'default';
            changed(true);
            return true;
        },

        exportTheme(id) {
            const entry = id === 'default'
                ? Object.assign({ id: 'default', name: '当前外观' }, clone(model.working))
                : model.themes.find(theme => theme.id === id);
            if (!entry) return false;
            const blob = new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(entry.name || 'moonya-theme').replace(/[\\/:*?"<>|]/g, '_')}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        },

        mountSettings,
        unmountSettings
    };

    /* ── 设置面板 ──────────────────────────────────────────── */

    let delegated = false;

    function $(selector, root) { return root ? root.querySelector(selector) : null; }

    /** 只写一格文字，不重画整块面板 —— 否则刚写下的失败原因会被 refreshPanel 冲掉。 */
    function setText(id, text) {
        const node = document.getElementById(id);
        if (node) node.textContent = text;
    }

    function effectiveColor(key) {
        const def = COLOR_BY_KEY.get(key);
        if (!def) return '#000000';
        const value = getComputedStyle(document.documentElement).getPropertyValue(def.vars[0]).trim();
        return HEX.test(value) ? value : '#000000';
    }

    /* ── 内置主题：后端目录 + 首次下载到 .moonya ─────────────── */

    const CATALOG_KEY = 'moonya.builtin-themes.v1';
    const CATALOG_TIMEOUT_MS = 8000;
    let builtinThemes = readCatalogCache();
    let catalogRequested = false;
    const assetPaths = new Map();     // slug -> 本地绝对路径（下载完成后写入）
    const assetProgress = new Map();  // slug -> 0..100  ← 进度真值放这里，不放 DOM
    const assetStates = new Map();    // slug -> idle | downloading | ready | error

    function normalizeBuiltinList(list) {
        if (!Array.isArray(list)) return [];
        return list
            .filter(item => item && typeof item.slug === 'string' && item.slug
                && typeof item.name === 'string'
                && item.background && typeof item.background.url === 'string' && item.background.url)
            .map(item => ({
                slug: item.slug,
                name: item.name,
                summary: typeof item.summary === 'string' ? item.summary : '',
                blur: Math.round(clamp(item.blur, 0, MAX_BLUR, 0)),
                shellOpacity: clamp(item.shellOpacity, MIN_OPACITY, MAX_OPACITY, DEFAULT_OPACITY),
                colors: item.colors && typeof item.colors === 'object' ? item.colors : {},
                background: {
                    type: item.background.type === 'video' ? 'video' : 'image',
                    fill: FILLS.includes(item.background.fill) ? item.background.fill : 'cover',
                    url: item.background.url,
                    sha256: typeof item.background.sha256 === 'string' ? item.background.sha256 : '',
                    bytes: Number(item.background.bytes) || 0
                },
                thumbUrl: typeof item.thumbUrl === 'string' ? item.thumbUrl : '',
                assetVersion: Number(item.assetVersion) || 1
            }));
    }

    function readCatalogCache() {
        try {
            const raw = localStorage.getItem(CATALOG_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return normalizeBuiltinList(parsed && parsed.themes);
        } catch (_) { return []; }
    }

    function builtinAssetState(slug) {
        return assetStates.get(slug) || (assetPaths.get(slug) ? 'ready' : 'idle');
    }

    /** 就地刷新某张内置卡的圆环，不重建整表（下载进度每秒会推很多次）。 */
    function updateCardState(slug) {
        const root = document.getElementById('settingsAppearanceView');
        if (!root) return;
        const card = root.querySelector('.appearance-theme-card[data-builtin="' + slug + '"]');
        if (!card) return;
        const state = builtinAssetState(slug);
        card.dataset.state = state;
        const label = card.querySelector('.appearance-theme-percent');
        if (!label) return;
        if (state === 'downloading') {
            const percent = assetProgress.get(slug) || 0;
            label.textContent = Math.round(percent) + '%';
            const arc = card.querySelector('.appearance-ring-arc');
            if (arc && window.MoonYaRing) window.MoonYaRing.setRing(arc, percent);
        } else if (state === 'error') {
            label.textContent = '重试';
        } else {
            label.textContent = '';
        }
    }

    /** 问一次本地缓存：哪些内置主题已经下载过了（纯本地文件系统查询，不联网）。 */
    async function refreshAssetStatuses() {
        const bridge = window.moonYaAppearance;
        if (!bridge || typeof bridge.themeAssetStatus !== 'function' || !builtinThemes.length) return;
        await Promise.all(builtinThemes.map(async theme => {
            try {
                const status = await bridge.themeAssetStatus(theme.slug, theme.background.sha256);
                if (status && status.success && status.cached && status.path) assetPaths.set(theme.slug, String(status.path));
            } catch (error) {
                console.warn('MoonYa theme asset status failed:', error);
            }
        }));
        refreshPanel();
    }

    async function loadCatalog() {
        if (catalogRequested) return;
        // 只在真实桌面宿主里拉目录：浏览器里没有下载桥，内置卡点了也没用，
        // 而且会给依赖「卡片计数」的既有测试平添卡片。
        if (!window.CefSharp || !window.CefSharp.BindObjectAsync || typeof fetch !== 'function') return;
        catalogRequested = true;
        try {
            // 自带 signal 可绕开 client.js 对远程 .php 强加的 10s 超时，失败时更快降级到本地缓存。
            const response = await fetch('/api/builtin_themes.php?action=catalog', { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
            const payload = await response.json();
            if (!payload || payload.success !== true || !payload.data) throw new Error('目录接口返回异常');
            builtinThemes = normalizeBuiltinList(payload.data.themes);
            try { localStorage.setItem(CATALOG_KEY, JSON.stringify({ fetchedAt: Date.now(), themes: builtinThemes })); } catch (_) {}
        } catch (error) {
            console.warn('MoonYa builtin theme catalog unavailable:', error);
            if (!builtinThemes.length) {
                const note = document.getElementById('moonyaBuiltinNote');
                if (note) note.hidden = false;
            }
        }
        refreshPanel();
        void refreshAssetStatuses();
    }

    /** 点内置卡片：命中缓存就直接应用；否则先下载（卡片中心显示圆环+百分比）再应用。 */
    async function applyBuiltinTheme(slug) {
        const theme = builtinThemes.find(item => item.slug === slug);
        if (!theme || builtinAssetState(slug) === 'downloading') return;
        const bridge = window.moonYaAppearance;
        if (!bridge || typeof bridge.fetchThemeAsset !== 'function') {
            notify('当前客户端不支持下载内置主题，需重新编译桌面端');
            return;
        }
        try {
            let path = assetPaths.get(slug);
            if (!path) {
                assetStates.set(slug, 'downloading');
                assetProgress.set(slug, 0);
                updateCardState(slug);
                const result = await bridge.fetchThemeAsset(
                    theme.background.url, slug, theme.background.sha256, theme.background.bytes);
                if (!result || result.success !== true) throw new Error((result && result.error) || '下载失败');
                path = String(result.path || '');
                if (!path) throw new Error('资源路径无效');
                assetPaths.set(slug, path);
            }
            assetStates.set(slug, 'ready');
            assetProgress.delete(slug);
            api.applyBuiltin(slug, path);
        } catch (error) {
            console.warn('MoonYa builtin theme failed:', error);
            assetStates.set(slug, 'error');
            assetProgress.delete(slug);
            notify('内置主题不可用：' + (error && error.message ? error.message : '未知错误'));
        }
        refreshPanel();
    }

    function renderColorRows(root) {
        const list = $('#moonyaColorList', root);
        if (!list) return;
        list.replaceChildren();
        COLOR_DEFS.forEach(def => {
            const row = document.createElement('label');
            row.className = 'appearance-color-row';
            row.dataset.colorKey = def.key;

            const name = document.createElement('span');
            name.className = 'appearance-color-name';
            name.textContent = def.label;

            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'appearance-color-input';
            input.dataset.colorKey = def.key;

            const reset = document.createElement('button');
            reset.type = 'button';
            reset.className = 'appearance-color-reset';
            reset.dataset.colorReset = def.key;
            reset.textContent = '恢复';

            row.append(name, input, reset);
            list.appendChild(row);
        });
    }

    /** 卡片预览底：本地已下载 > 服务器缩略图 > 调色板渐变。 */
    function previewBackground(kind, entry) {
        if (kind === 'builtin') {
            const local = assetPaths.get(entry.slug);
            const localUrl = local ? mediaUrl(local) : null;
            if (localUrl) return `url("${localUrl}")`;
            if (entry.theme.thumbUrl) return `url("${entry.theme.thumbUrl}")`;
        }
        if (kind === 'mine') {
            const bucket = entry.entry;
            const url = bucket.background && bucket.background.type !== 'none' ? mediaUrl(bucket.background.path) : null;
            if (url && bucket.background.type === 'image') return `url("${url}")`;
        }
        const swatchKeys = ['appBackground', 'sidebar', 'surface', 'accent'];
        const colors = kind === 'builtin' ? (entry.theme.colors || {}) : kind === 'mine' ? (entry.entry.colors || {}) : {};
        const stops = swatchKeys.map(key => colors[key] || effectiveColor(key));
        return `linear-gradient(135deg, ${stops.join(', ')})`;
    }

    function renderThemes(root) {
        const grid = $('#moonyaThemeGrid', root);
        if (!grid) return;
        grid.replaceChildren();

        // 一个网格：内置（来自后端）在前 → 默认外观 → 我的主题。
        const entries = builtinThemes
            .map(theme => ({ kind: 'builtin', key: 'builtin:' + theme.slug, slug: theme.slug, name: theme.name, theme }))
            .concat([{ kind: 'default', key: 'default', name: '默认外观' }],
                model.themes.map(entry => ({ kind: 'mine', key: entry.id, name: entry.name, entry })));

        entries.forEach(entry => {
            const card = document.createElement('div');
            card.className = 'appearance-theme-card';
            card.dataset.themeId = entry.key;
            const active = entry.kind === 'builtin' ? model.activeBuiltin === entry.slug
                : entry.kind === 'default' ? (model.activeThemeId === 'default' && !model.activeBuiltin)
                    : model.activeThemeId === entry.key;
            if (active) card.classList.add('active');

            const preview = document.createElement('div');
            preview.className = 'appearance-theme-preview';
            preview.style.backgroundImage = previewBackground(entry.kind, entry);

            if (entry.kind === 'builtin') {
                card.dataset.builtin = entry.slug;
                card.dataset.state = builtinAssetState(entry.slug);
                const badge = document.createElement('span');
                badge.className = 'appearance-theme-badge';
                badge.textContent = '内置';
                card.appendChild(badge);
                // 覆盖层必须随每次重建一起生成（renderThemes 会 replaceChildren）。
                // 真正的进度值存在 assetProgress 里，所以重建后 updateCardState 能立刻恢复。
                const progress = document.createElement('div');
                progress.className = 'appearance-theme-progress';
                progress.innerHTML = '<svg viewBox="0 0 52 52" aria-hidden="true">'
                    + '<circle class="appearance-ring-track" cx="26" cy="26" r="22"></circle>'
                    + '<circle class="appearance-ring-arc" cx="26" cy="26" r="22"></circle>'
                    + '</svg><span class="appearance-theme-percent"></span>';
                card.appendChild(progress);
            }

            const name = document.createElement('div');
            name.className = 'appearance-theme-name';
            name.textContent = entry.name;

            const actions = document.createElement('div');
            actions.className = 'appearance-theme-actions';
            const buttons = entry.kind === 'builtin' ? [['应用', 'apply']]
                : entry.kind === 'default' ? [['应用', 'apply'], ['导出', 'export']]
                    : [['应用', 'apply'], ['导出', 'export'], ['重命名', 'rename'], ['删除', 'remove']];
            buttons.forEach(([text, action]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'appearance-theme-action';
                button.dataset.themeAction = action;
                button.textContent = text;
                actions.appendChild(button);
            });

            card.append(preview, name, actions);
            grid.appendChild(card);
            if (entry.kind === 'builtin') updateCardState(entry.slug);
        });
    }

    function syncMediaPreview(preview, background, url) {
        const thumbnail = background.type === 'video' && url && window.MoonYaHost?.mediaThumbnails;
        const source = url && background.type !== 'none'
            ? (thumbnail ? `${url}&thumbnail=1` : url) : '';
        const signature = `${background.type}:${source}`;
        preview.dataset.empty = background.type === 'none' ? 'true' : 'false';
        preview.dataset.kind = background.type;
        preview.dataset.loadable = background.type === 'none' ? '' : String(!!url);
        if (preview.dataset.previewSource === signature) return;
        preview.dataset.previewSource = signature;
        preview.dataset.previewState = '';
        preview.style.backgroundImage = '';
        const previous = preview.querySelector('video');
        if (previous) { previous.pause(); previous.removeAttribute('src'); previous.load(); }
        preview.replaceChildren();
        if (!source) return;
        // MP4/MOV cannot be decoded by CefSharp: request a native thumbnail.
        const inPageVideo = background.type === 'video' && !thumbnail && !usesNativeVideo(background.path)
            && DECODABLE_VIDEO_EXT.includes(extensionOf(background.path));
        if (background.type === 'video' && !thumbnail && !inPageVideo) {
            preview.dataset.previewState = 'error';
            return;
        }
        preview.dataset.previewState = 'loading';
        const media = document.createElement(inPageVideo ? 'video' : 'img');
        media.className = 'appearance-preview-media';
        if (inPageVideo) {
            media.muted = true;
            media.loop = true;
            media.autoplay = true;
            media.playsInline = true;
        } else media.alt = '';
        const current = () => preview.dataset.previewSource === signature;
        media.addEventListener(inPageVideo ? 'loadeddata' : 'load', () => {
            if (current()) preview.dataset.previewState = 'ready';
        });
        media.addEventListener('error', () => {
            if (current()) preview.dataset.previewState = 'error';
        });
        media.src = source;
        preview.appendChild(media);
    }

    function syncControls(root) {
        const colors = model.working.colors;

        const blurRange = $('#moonyaBlurRange', root);
        if (blurRange) blurRange.value = String(model.working.blur);
        const blurValue = $('#moonyaBlurValue', root);
        if (blurValue) blurValue.textContent = String(model.working.blur);

        const opacityRange = $('#moonyaOpacityRange', root);
        if (opacityRange) opacityRange.value = String(Math.round(model.working.shellOpacity * 100));
        const opacityValue = $('#moonyaOpacityValue', root);
        if (opacityValue) opacityValue.textContent = `${Math.round(model.working.shellOpacity * 100)}%`;

        const background = model.working.background;
        const backgroundUrl = background.type !== 'none' ? mediaUrl(background.path) : null;
        root.querySelectorAll('[data-bg-fill]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.bgFill === background.fill));
        });
        const preview = $('#moonyaBgPreview', root);
        if (preview) {
            syncMediaPreview(preview, background, backgroundUrl);
        }
        const status = $('#moonyaBgStatus', root);
        if (status) {
            const label = `${background.type === 'video' ? '视频' : '图片'}：${background.path}`;
            // mediaUrl 依赖客户端注入的 mediaToken；旧客户端没有这条路由，选完也不会显示，
            // 必须说清楚是「要重编译桌面端」而不是「功能坏了」。
            status.textContent = background.type === 'none'
                ? '未设置背景'
                : backgroundUrl ? label : `${label}（当前客户端不支持按路径加载，需重新编译桌面端）`;
            status.title = background.path || '';
        }

        root.querySelectorAll('.appearance-color-row').forEach(row => {
            const key = row.dataset.colorKey;
            const input = row.querySelector('input[type="color"]');
            const customized = Object.prototype.hasOwnProperty.call(colors, key);
            if (input) input.value = customized ? colors[key] : effectiveColor(key);
            row.classList.toggle('customized', customized);
        });

        const localMedia = api.canUseLocalMedia();
        root.querySelectorAll('[data-bg-pick]').forEach(button => { button.disabled = !localMedia; });
        const note = $('#moonyaBgUnavailable', root);
        if (note) note.hidden = localMedia;

        // 启动画面和主背景共用预览，视频通过原生缩略图呈现。
        const splash = model.splash;
        const splashIsVideo = splash.type === 'video';
        const splashUrl = splash.type === 'none' ? null : mediaUrl(splash.path);
        const splashPreview = $('#moonyaSplashPreview', root);
        if (splashPreview) {
            syncMediaPreview(splashPreview, splash, splashUrl);
            splashPreview.dataset.kind = splashIsVideo ? 'video-native' : splash.type;
            if (splashIsVideo && !window.MoonYaHost?.mediaThumbnails) {
                splashPreview.dataset.loadable = String(nativeVideo());
            }
        }
        const splashStatus = $('#moonyaSplashStatus', root);
        if (splashStatus) {
            const label = `${splashIsVideo ? '视频' : '图片'}：${splash.path}`;
            splashStatus.textContent = splash.type === 'none'
                ? '未设置'
                : splashIsVideo
                    ? (nativeVideo() ? `${label}（由桌面端原生播放）` : `${label}（需要桌面客户端才能播放）`)
                    : (splashUrl ? label : `${label}（当前客户端不支持按路径加载，需重新编译桌面端）`);
            splashStatus.title = splash.path || '';
        }
        root.querySelectorAll('[data-splash-fill]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.splashFill === splash.fill));
        });
        // 视频按钮在没有原生播放能力的客户端上禁用；browser-only 时两个都禁用。
        root.querySelectorAll('[data-splash-pick]').forEach(button => {
            const wantsVideo = button.dataset.splashPick === 'video';
            button.disabled = !localMedia || (wantsVideo && !nativeVideo());
            button.title = wantsVideo && localMedia && !nativeVideo()
                ? '当前客户端不支持原生视频播放（需要重新编译桌面端）'
                : '';
        });
        const splashNote = $('#moonyaSplashUnavailable', root);
        if (splashNote) splashNote.hidden = localMedia;

        const nameInput = $('#moonyaThemeName', root);
        if (nameInput && !nameInput.value) nameInput.placeholder = `主题 ${model.themes.length + 1}`;
    }

    function refreshPanel() {
        const root = document.getElementById('settingsAppearanceView');
        if (!root) return;
        renderThemes(root);
        syncControls(root);
    }

    /** 打开原生选文件对话框，过滤扩展名；返回绝对路径或 null。 */
    async function chooseLocalFile(extensions, retryMessage) {
        const ops = await ensureFileOps();
        if (!ops) { notify('仅桌面客户端可选择本地文件'); return null; }
        try {
            const result = await ops.pickLocalFiles();
            const items = (result && result.items) || [];
            const picked = items.find(item => item && typeof item.path === 'string'
                && extensions.includes(('.' + String(item.path).split('.').pop()).toLowerCase()));
            if (!picked) {
                if (items.length) notify(retryMessage);
                return null;
            }
            return picked.path;
        } catch (error) {
            console.warn('MoonYa file picker failed:', error);
            notify('选择文件失败');
            return null;
        }
    }

    async function pickBackground(kind) {
        const path = await chooseLocalFile(kind === 'video' ? VIDEO_EXT : IMAGE_EXT,
            kind === 'video' ? '请选择视频文件' : '请选择图片文件');
        if (!path) return;
        if (kind === 'video' && !usesNativeVideo(path)) {
            // 关键一步：先真解一遍再落盘。否则会留下一个每次启动都失败的背景，
            // 而且失败原因会被错报成「文件被移动或删除」。
            // 被宿主接管的 MP4/MOV 跳过浏览器解码探测，保存后由原生播放器打开。
            setText('moonyaBgStatus', '正在检测视频格式…');
            const reason = await rejectUnplayableVideo(path);
            if (reason) {
                notify(reason);
                setText('moonyaBgStatus', reason);
                return;
            }
        }
        api.setBackground({ type: kind, path, fill: model.working.background.fill || 'cover' });
        refreshPanel();
    }

    async function pickSplash(kind) {
        const wantsVideo = kind === 'video';
        const path = await chooseLocalFile(wantsVideo ? SPLASH_VIDEO_EXT : IMAGE_EXT,
            wantsVideo ? '请选择视频文件' : '请选择图片文件');
        if (!path) return;
        api.setSplash({ type: wantsVideo ? 'video' : 'image', path, fill: model.splash.fill || 'cover' });
        refreshPanel();
    }

    function onPanelClick(event) {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest('#settingsAppearanceView')) return;
        const root = document.getElementById('settingsAppearanceView');
        if (!root) return;

        const pick = target.closest('[data-bg-pick]');
        if (pick) { void pickBackground(pick.dataset.bgPick); return; }

        if (target.closest('#moonyaBgClear')) {
            if (model.working.background.type === 'none') { notify('当前还没有设置背景'); return; }
            api.clearBackground();
            refreshPanel();
            return;
        }

        const fill = target.closest('[data-bg-fill]');
        if (fill) {
            // 没有背景时改填充方式看不出任何变化，容易误判成「按钮失灵」，直接给提示。
            if (model.working.background.type === 'none') { notify('请先选择背景图片或视频'); return; }
            api.setBackground({ fill: fill.dataset.bgFill });
            refreshPanel();
            return;
        }

        const splashPick = target.closest('[data-splash-pick]');
        if (splashPick) { void pickSplash(splashPick.dataset.splashPick); return; }

        if (target.closest('#moonyaSplashClear')) {
            if (model.splash.type === 'none') { notify('当前还没有设置启动画面背景'); return; }
            api.clearSplash();
            refreshPanel();
            return;
        }

        const splashFill = target.closest('[data-splash-fill]');
        if (splashFill) {
            if (model.splash.type === 'none') { notify('请先选择启动画面背景图片'); return; }
            api.setSplash({ fill: splashFill.dataset.splashFill });
            refreshPanel();
            return;
        }

        const reset = target.closest('[data-color-reset]');
        if (reset) {
            api.clearColor(reset.dataset.colorReset);
            refreshPanel();
            return;
        }

        const step = target.closest('[data-step-target]');
        if (step) {
            const delta = Number(step.dataset.stepDelta) || 0;
            if (step.dataset.stepTarget === 'blur') api.setBlur(model.working.blur + delta);
            else api.setShellOpacity(model.working.shellOpacity + delta / 100);
            syncControls(root);
            return;
        }

        const action = target.closest('[data-theme-action]');
        if (action) {
            const card = action.closest('[data-theme-id]');
            const id = card.dataset.themeId;
            const builtinSlug = card.dataset.builtin;
            if (action.dataset.themeAction === 'apply') {
                if (builtinSlug) { void applyBuiltinTheme(builtinSlug); return; }
                api.applyTheme(id);
            }
            else if (action.dataset.themeAction === 'export') api.exportTheme(id);
            else if (action.dataset.themeAction === 'rename') {
                const entry = model.themes.find(theme => theme.id === id);
                const next = window.prompt('重命名主题', entry ? entry.name : '');
                if (next != null) api.renameTheme(id, next);
            } else if (action.dataset.themeAction === 'remove') {
                api.removeTheme(id);
            }
            refreshPanel();
            return;
        }

        // 内置主题：点卡片任意位置即应用（下载中重复点击由状态机忽略）。
        const builtinCard = target.closest('.appearance-theme-card[data-builtin]');
        if (builtinCard) { void applyBuiltinTheme(builtinCard.dataset.builtin); return; }

        if (target.closest('#moonyaThemeSave')) {
            const input = $('#moonyaThemeName', root);
            api.saveAsTheme(input ? input.value : '');
            if (input) input.value = '';
            refreshPanel();
        }
    }

    function onPanelInput(event) {
        const target = event.target;
        if (!(target instanceof Element) || !target.closest('#settingsAppearanceView')) return;
        const root = document.getElementById('settingsAppearanceView');
        if (!root) return;

        if (target instanceof HTMLInputElement && target.type === 'color') {
            api.setColor(target.dataset.colorKey, target.value);
            const row = target.closest('.appearance-color-row');
            if (row) row.classList.add('customized');
            // 拖动取色器时只更新数值；松手（change）才重画主题预览，避免反复重建卡片。
            if (event.type === 'change') renderThemes(root);
            return;
        }
        if (target.id === 'moonyaBlurRange') { api.setBlur(target.value); $('#moonyaBlurValue', root).textContent = String(model.working.blur); return; }
        if (target.id === 'moonyaOpacityRange') {
            api.setShellOpacity(Number(target.value) / 100);
            $('#moonyaOpacityValue', root).textContent = `${Math.round(model.working.shellOpacity * 100)}%`;
        }
    }

    /**
     * 事件委托挂在 document 上（面板在设置弹窗里常驻 DOM），所以即使 settings-modal.js
     * 的挂载钩子没跑到，整块外观分区依然可用 —— 之前挂在面板元素上，钩子一失手就全废。
     */
    function mountSettings(root) {
        if (!delegated) {
            delegated = true;
            document.addEventListener('click', onPanelClick);
            document.addEventListener('input', onPanelInput);
            document.addEventListener('change', onPanelInput);
            void ensureFileOps();
        }
        const panel = root || document.getElementById('settingsAppearanceView');
        if (!panel) return;
        renderColorRows(panel);
        renderThemes(panel);
        syncControls(panel);
    }

    function unmountSettings() {
        if (!delegated) return;
        delegated = false;
        document.removeEventListener('click', onPanelClick);
        document.removeEventListener('input', onPanelInput);
        document.removeEventListener('change', onPanelInput);
    }

    /* ── 启动 ──────────────────────────────────────────────── */

    applyAll();

    // 明暗切换后：自定义值仍然钉在上面，但「未自定义」的项与主题预览依赖基底色，必须重画。
    window.addEventListener('moonya:theme-change', () => {
        applyColors();
        refreshPanel();
    });
    // 只同步控件，不重建主题卡片：滑条抖动会把事件打得很密。
    window.addEventListener('moonya:appearance-change', () => {
        const root = document.getElementById('settingsAppearanceView');
        if (root) syncControls(root);
    });
    window.addEventListener('moonya:appearance-themes-change', refreshPanel);
    window.addEventListener('pagehide', flushNative);
    window.addEventListener('beforeunload', flushNative);
    // 原生文件才是权威；storage 事件只在没有桥时（多标签页调试）当兜底。
    window.addEventListener('storage', event => {
        if (event.key !== CACHE_KEY || bridge) return;
        model = normalize(event.newValue ? JSON.parse(event.newValue) : null);
        applyAll();
    });

    async function connect() {
        if (!window.CefSharp || !window.CefSharp.BindObjectAsync) return;
        const initialRevision = revision;
        try {
            await window.CefSharp.BindObjectAsync('moonYaAppearance');
            const target = window.moonYaAppearance;
            if (!target) return;
            const remote = JSON.parse(await target.getAppearance());
            bridge = target;
            if (initialRevision === revision) {
                model = normalize(remote);
                applyAll();
                persistLocal();
                refreshPanel();
            } else {
                // 用户在原生连上之前就改了东西 —— 以他的修改为准，直接推回原生文件。
                persistNative();
            }
        } catch (error) {
            console.warn('MoonYa native appearance connection unavailable:', error);
        }
        refreshPanel();
        // 目录与本地缓存状态只在真实宿主里拉（loadCatalog 内部有宿主守卫）。
        void loadCatalog();
    }

    function boot() {
        if (document.body) renderBackground();
        else document.addEventListener('DOMContentLoaded', renderBackground, { once: true });
        // 面板常驻 DOM（只是 display:none）：首屏就把行/卡片画好并挂上事件委托。
        // settings-modal.js 的挂载钩子只是「重画一次」，不再是面板可用的前提。
        mountSettings(document.getElementById('settingsAppearanceView'));
        void connect();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();

    window.MoonYaAppearance = Object.freeze(api);
})();
