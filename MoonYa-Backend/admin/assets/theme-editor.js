/* ══ 内置主题编辑器：状态 · 预览 · 保存编排 ══════════════════════════════════
   常量在 theme-editor-base.js（纯数据、被守卫测试直接加载），本文件只管行为。

   预览的核心是「复刻客户端语义」而不是另创一套：
   客户端 appearance.js 的 applyColors() 先 removeProperty 清空全部自定义变量，
   再把「已自定义的键」inline 写到 :root——于是已填的钉死、未填的跟随明暗基底。
   这里把同一套逻辑作用在预览画布（.tp-preview）而不是 documentElement 上，
   于是画布内的子树实时预览，且不影响后台自身样式。
*/
(function () {
    'use strict';

    var LIB = window.MoonYaThemeBase || {};
    var COLOR_DEFS = LIB.COLOR_DEFS || [];
    var COLOR_GROUPS = LIB.COLOR_GROUPS || [];
    var BASE = LIB.BASE || {};
    var SCHEME = LIB.SCHEME || {};
    var COLOR_FALLBACK = LIB.COLOR_FALLBACK || {};
    var COLOR_HARD_FALLBACK = LIB.COLOR_HARD_FALLBACK || {};

    var BY_KEY = new Map(COLOR_DEFS.map(function (def) { return [def.key, def]; }));

    var MAX_BLUR = 60;
    var MIN_OPACITY = 0.2;
    var DEFAULT_OPACITY = 0.85;
    var MAX_BYTES = 67108864; // 与 BuiltinThemeService::MAX_ASSET_BYTES 一致
    var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
    var VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
    var HEX = /^#[0-9a-fA-F]{6}$/;
    var SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
    var REV_KEY = 'moonya.builtinThemes.rev';
    var LIST_URL = 'dashboard.php?section=themes';

    var TOKEN = localStorage.getItem('adminToken');
    if (!TOKEN) {
        window.location.href = 'login.php';
        return;
    }

    var state = {
        id: null,
        slug: '',
        name: '',
        summary: '',
        sortOrder: 0,
        enabled: true,
        colors: {},
        blur: 0,
        shellOpacity: DEFAULT_OPACITY,
        backgroundKind: 'image',
        backgroundFill: 'cover',
        backgroundKey: '',
        thumbKey: '',
        assetVersion: 1,
        assetBytes: 0,
        pendingFile: null,
        pendingUrl: null,
        baseView: 'light',
        slugTouched: false,
        dirty: false,
        saving: false
    };

    var $ = function (id) { return document.getElementById(id); };

    /* ── 小工具 ─────────────────────────────────────────────── */

    function hexToRgbTriplet(hex) {
        var body = hex.replace('#', '');
        return [
            parseInt(body.slice(0, 2), 16),
            parseInt(body.slice(2, 4), 16),
            parseInt(body.slice(4, 6), 16)
        ].join(', ');
    }

    function cssDecls(map) {
        return Object.keys(map).map(function (name) { return name + ':' + map[name]; }).join(';');
    }

    function toast(message, type) {
        var node = $('teAlert');
        if (!node) return;
        node.className = 'alert alert-' + (type === 'error' ? 'error' : 'success') + ' show';
        node.textContent = message;
        window.clearTimeout(toast._timer);
        toast._timer = window.setTimeout(function () { node.className = 'alert'; }, type === 'error' ? 4200 : 2600);
    }

    function markDirty() {
        if (state.dirty) return;
        state.dirty = true;
        updateChrome();
    }

    function markClean() {
        state.dirty = false;
        updateChrome();
    }

    function updateChrome() {
        $('teDirty').hidden = !state.dirty;
        var save = $('teSave');
        save.disabled = state.saving;
        save.textContent = state.saving ? '保存中…' : '保存主题';
        $('teTitle').textContent = state.id == null ? '新增主题' : '编辑主题';
        $('teSubtitle').textContent = state.id == null
            ? '改动会即时出现在右侧预览中'
            : '标识 ' + state.slug + ' · 改动会即时出现在右侧预览中';
    }

    /* ── 接口 ───────────────────────────────────────────────── */

    function api(action, body) {
        var options = { headers: { Authorization: 'Bearer ' + TOKEN } };
        if (body == null) {
            options.method = 'GET';
        } else {
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        return fetch('api/builtin_themes.php?action=' + action, options).then(function (response) {
            // 独立页没有 dashboard 的全局提示，登录态失效直接回登录页。
            if (response.status === 401 || response.status === 403) {
                window.location.href = 'login.php';
                throw new Error('登录状态已失效，请重新登录');
            }
            return response.json().catch(function () {
                return { success: false, error: '响应解析失败' };
            }).then(function (payload) {
                if (!payload.success) throw new Error(payload.error || '请求失败');
                return payload.data;
            });
        });
    }

    function uploadAsset(id, file) {
        return new Promise(function (resolve, reject) {
            var form = new FormData();
            form.append('id', String(id));
            form.append('kind', 'background');
            form.append('background', file);
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'api/builtin_themes.php?action=upload');
            xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
            var progress = $('teProgress');
            var bar = $('teBar');
            if (progress) progress.hidden = false;
            xhr.upload.onprogress = function (event) {
                if (!event.lengthComputable || !bar) return;
                var percent = Math.round(event.loaded / event.total * 100);
                bar.style.width = percent + '%';
                $('teAssetStatus').textContent = '上传中 ' + percent + '…';
            };
            xhr.onload = function () {
                if (progress) progress.hidden = true;
                if (bar) bar.style.width = '0';
                if (xhr.status === 401 || xhr.status === 403) {
                    window.location.href = 'login.php';
                    reject(new Error('登录状态已失效，请重新登录'));
                    return;
                }
                try {
                    var payload = JSON.parse(xhr.responseText);
                    if (payload.success) resolve(payload.data);
                    else reject(new Error(payload.error || '上传失败'));
                } catch (error) {
                    reject(new Error('上传响应解析失败'));
                }
            };
            xhr.onerror = function () {
                if (progress) progress.hidden = true;
                reject(new Error('上传失败，请检查网络'));
            };
            xhr.send(form);
        });
    }

    /* ── 预览 ───────────────────────────────────────────────── */

    function renderBase() {
        $('teBaseStyle').textContent =
            '.tp-preview[data-base="light"]{' + cssDecls(BASE.light || {}) + '}\n' +
            '.tp-preview[data-base="dark"]{' + cssDecls(BASE.dark || {}) + '}';
    }

    /* 镜像客户端的「已填钉住 / 未填跟随基底」语义。
       顺序也必须一致：先清空全部自定义变量，再写已填充的键。 */
    function renderPreview() {
        var root = $('tePreview');
        root.dataset.base = state.baseView;

        COLOR_DEFS.forEach(function (def) {
            def.vars.forEach(function (name) { root.style.removeProperty(name); });
            if (def.rgb) root.style.removeProperty(def.rgb);
        });

        COLOR_DEFS.forEach(function (def) {
            var value = state.colors[def.key];
            if (!HEX.test(value || '')) return;
            def.vars.forEach(function (name) { root.style.setProperty(name, value); });
            if (def.rgb) root.style.setProperty(def.rgb, hexToRgbTriplet(value));
        });
    }

    function applyMetrics() {
        var root = $('tePreview');
        root.style.setProperty('--moonya-bg-blur', state.blur + 'px');
        root.style.setProperty('--moonya-shell-opacity', String(state.shellOpacity));
    }

    function mediaSrc() {
        if (state.pendingUrl) return state.pendingUrl;
        if (state.backgroundKey) return '../uploads/themes/' + state.backgroundKey;
        return '';
    }

    function renderMedia() {
        var layer = $('teMediaLayer');
        var box = $('tePreview');
        var src = mediaSrc();
        var want = src === '' ? '' : (state.backgroundKind === 'video' ? 'video' : 'img');
        var current = layer.firstElementChild;
        var currentKind = current ? current.tagName.toLowerCase() : '';

        if (want === '') {
            layer.textContent = '';
            box.classList.remove('has-bg');
            updateAssetStatus();
            return;
        }

        if (currentKind !== want) {
            layer.textContent = '';
            var node = document.createElement(want);
            node.className = 'tp-media';
            if (want === 'video') {
                node.muted = true;
                node.loop = true;
                node.autoplay = true;
                node.playsInline = true;
            } else {
                node.alt = '';
            }
            layer.appendChild(node);
            current = node;
        }

        if (current.getAttribute('src') !== src) current.setAttribute('src', src);
        current.style.objectFit = state.backgroundFill;
        box.classList.add('has-bg');
        updateAssetStatus();

        var note = $('tePreviewNote');
        if (state.backgroundKind === 'video') {
            note.textContent = '提示：桌面客户端内置的浏览器只保证 WebM（VP8/VP9）可播，MP4/H.264 可能放不出来。';
        } else {
            note.textContent = state.blur > 0 || state.shellOpacity < 1
                ? '模糊与不透明度已应用到预览；拖动滑条可即时看到变化。'
                : '未设置背景资源，界面按不透明渲染（与客户端一致）。';
        }
    }

    function updateAssetStatus() {
        var node = $('teAssetStatus');
        if (state.pendingFile) {
            node.textContent = '待上传：' + state.pendingFile.name + '（' + Math.round(state.pendingFile.size / 1024) + ' KB），点「保存主题」后上传';
            node.dataset.tone = 'pending';
            return;
        }
        if (state.backgroundKey) {
            node.textContent = '当前资源：' + state.backgroundKey +
                (state.assetBytes ? '（' + Math.round(state.assetBytes / 1024) + ' KB · 版本 v' + state.assetVersion + '）' : '');
            node.dataset.tone = 'ok';
            return;
        }
        node.textContent = '尚未上传背景资源（没有资源客户端无法应用）';
        node.dataset.tone = 'warn';
    }

    /* 未自定义某项时，色板该显示什么——用该项在当前基底下的真实回落值。 */
    function baseValueFor(key) {
        var def = BY_KEY.get(key);
        if (!def) return '#888888';
        var table = BASE[state.baseView] || {};
        var direct = def.vars.filter(function (name) { return table[name]; })[0];
        if (direct) return table[direct];
        var via = COLOR_FALLBACK[key];
        if (via && table[via]) return table[via];
        return COLOR_HARD_FALLBACK[key] || '#888888';
    }

    /* ── 配色行 ─────────────────────────────────────────────── */

    function renderColorGroups() {
        $('teColorGroups').innerHTML = COLOR_GROUPS.map(function (group) {
            var rows = group.keys.map(function (key) {
                var def = BY_KEY.get(key);
                if (!def) return '';
                return '<div class="te-color-row" data-row="' + key + '">' +
                    '<span class="te-color-name" title="' + def.label + '">' + def.label + '</span>' +
                    '<input type="color" class="te-color-swatch" data-swatch="' + key + '" aria-label="' + def.label + '">' +
                    '<input type="text" class="te-color-hex" data-hex="' + key + '" maxlength="7" spellcheck="false" autocomplete="off" placeholder="跟随基底">' +
                    '<button type="button" class="te-color-clear" data-clear="' + key + '" title="清除自定义，跟随明暗基底">跟随基底</button>' +
                    '</div>';
            }).join('');
            return '<div class="te-color-group"><h4 class="te-color-group-title">' + group.title + '</h4>' +
                '<div class="te-color-rows">' + rows + '</div></div>';
        }).join('');
        syncColorRows();
    }

    function syncColorRow(key) {
        var row = document.querySelector('.te-color-row[data-row="' + key + '"]');
        if (!row) return;
        var value = state.colors[key];
        var custom = HEX.test(value || '');
        row.classList.toggle('customized', custom);
        row.querySelector('[data-swatch]').value = custom ? value : baseValueFor(key);
        var hex = row.querySelector('[data-hex]');
        if (document.activeElement !== hex) hex.value = custom ? value : '';
    }

    function syncColorRows() {
        COLOR_DEFS.forEach(function (def) { syncColorRow(def.key); });
    }

    function setColor(key, value, source) {
        if (!BY_KEY.has(key) || !HEX.test(value)) return;
        state.colors[key] = value.toLowerCase();
        renderPreview();
        syncColorRow(key);
        if (source !== 'hex') {
            var hex = document.querySelector('.te-color-hex[data-hex="' + key + '"]');
            if (hex && document.activeElement !== hex) hex.value = state.colors[key];
        }
        markDirty();
    }

    function clearColor(key) {
        if (!BY_KEY.has(key)) return;
        delete state.colors[key];
        renderPreview();
        syncColorRow(key);
        markDirty();
    }

    function applyScheme(which) {
        var scheme = SCHEME[which];
        if (!scheme) return;
        state.colors = {};
        COLOR_DEFS.forEach(function (def) {
            var value = scheme[def.key];
            if (HEX.test(value || '')) state.colors[def.key] = value;
        });
        // 一键套用深色就顺手把预览切到深色基底，省一次手动切换。
        state.baseView = which === 'dark' ? 'dark' : 'light';
        $('tePreview').dataset.base = state.baseView;
        syncBaseButtons();
        renderPreview();
        syncColorRows();
        markDirty();
    }

    function clearAllColors() {
        state.colors = {};
        renderPreview();
        syncColorRows();
        markDirty();
    }

    /* ── 基底切换（只影响预览，不算改动） ─────────────────────── */

    function syncBaseButtons() {
        document.querySelectorAll('[data-base-view]').forEach(function (button) {
            button.classList.toggle('is-active', button.dataset.baseView === state.baseView);
        });
    }

    function setBaseView(view) {
        state.baseView = view === 'dark' ? 'dark' : 'light';
        $('tePreview').dataset.base = state.baseView;
        syncBaseButtons();
        syncColorRows(); // 色板里「跟随基底」的取值随基底变化
    }

    /* ── 表单 ───────────────────────────────────────────────── */

    function fillForm() {
        $('teSlug').value = state.slug;
        $('teSlug').readOnly = state.id != null;
        $('teName').value = state.name;
        $('teSummary').value = state.summary;
        $('teSort').value = state.sortOrder;
        $('teEnabled').checked = state.enabled;
        $('teEnabledText').textContent = state.enabled ? '已上架' : '已下架';
        $('teBlur').value = state.blur;
        $('teBlurValue').textContent = state.blur + 'px';
        $('teOpacity').value = state.shellOpacity;
        $('teOpacityValue').textContent = Number(state.shellOpacity).toFixed(2);
        syncSeg('[data-kind]', 'kind', state.backgroundKind);
        syncSeg('[data-fill]', 'fill', state.backgroundFill);
        $('teFile').accept = state.backgroundKind === 'video' ? 'video/*' : 'image/*';
        validateSlugHint();
    }

    function syncSeg(selector, field, value) {
        document.querySelectorAll(selector + ' .te-seg-btn').forEach(function (button) {
            button.classList.toggle('is-active', button.dataset[field] === value);
        });
    }

    function validateSlugHint() {
        var hint = $('teSlugHint');
        var value = $('teSlug').value.trim();
        if (value === '') {
            hint.className = 'te-field-hint';
            hint.textContent = '小写字母 / 数字 / - / _';
            return;
        }
        if (SLUG.test(value)) {
            hint.className = 'te-field-hint';
            hint.textContent = '可用于客户端缓存目录：.moonya/appearance/themes/' + value + '/';
            return;
        }
        hint.className = 'te-field-hint is-error';
        hint.textContent = '只能用小写字母、数字、- 和 _，且不能以 - 或 _ 开头';
    }

    function deriveSlug(name) {
        var ascii = String(name).toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64);
        // 纯中文名派生出来是空的，别塞一段没意义的 theme-ab12cd 给用户
        return SLUG.test(ascii) && ascii.length >= 2 ? ascii : '';
    }

    function bindForm() {
        $('teSlug').addEventListener('input', function () {
            // 必须回写 state：collect() 读的是 state.slug，只写 DOM 的话
            // 保存时会拿空串去校验，报「主题标识只能是…」而用户明明填了。
            state.slug = this.value.trim();
            state.slugTouched = true;
            validateSlugHint();
            markDirty();
        });

        $('teName').addEventListener('input', function () {
            state.name = this.value.trim();
            if (state.id == null && !state.slugTouched) {
                var derived = deriveSlug(this.value);
                if (derived) {
                    state.slug = derived;
                    $('teSlug').value = derived;
                    validateSlugHint();
                }
            }
            markDirty();
        });

        $('teSummary').addEventListener('input', function () {
            state.summary = this.value.trim();
            markDirty();
        });

        $('teSort').addEventListener('input', function () {
            state.sortOrder = Number(this.value) || 0;
            markDirty();
        });

        $('teEnabled').addEventListener('change', function () {
            state.enabled = this.checked;
            $('teEnabledText').textContent = state.enabled ? '已上架' : '已下架';
            markDirty();
        });

        $('teBlur').addEventListener('input', function () {
            state.blur = Number(this.value) || 0;
            $('teBlurValue').textContent = state.blur + 'px';
            applyMetrics();
            renderMedia();
            markDirty();
        });

        $('teOpacity').addEventListener('input', function () {
            state.shellOpacity = Number(this.value) || DEFAULT_OPACITY;
            $('teOpacityValue').textContent = state.shellOpacity.toFixed(2);
            applyMetrics();
            renderMedia();
            markDirty();
        });

        // 事件委托到容器：行是动态渲染的
        $('teColorGroups').addEventListener('input', function (event) {
            var swatch = event.target.closest('[data-swatch]');
            if (swatch) { setColor(swatch.dataset.swatch, swatch.value); return; }
            var hex = event.target.closest('[data-hex]');
            if (hex && HEX.test(hex.value.trim())) {
                setColor(hex.dataset.hex, hex.value.trim().toLowerCase(), 'hex');
            }
        });

        $('teColorGroups').addEventListener('change', function (event) {
            var hex = event.target.closest('[data-hex]');
            if (!hex) return;
            var key = hex.dataset.hex;
            var raw = hex.value.trim();
            if (raw === '') { clearColor(key); return; }
            var value = raw.charAt(0) === '#' ? raw : '#' + raw;
            if (HEX.test(value)) {
                setColor(key, value.toLowerCase());
            } else {
                toast('颜色要写成 #RRGGBB 的形式', 'error');
                syncColorRow(key);
            }
        });

        $('teColorGroups').addEventListener('click', function (event) {
            var clear = event.target.closest('[data-clear]');
            if (clear) clearColor(clear.dataset.clear);
        });

        document.querySelectorAll('.te-seg[data-field="kind"] .te-seg-btn').forEach(function (button) {
            button.addEventListener('click', function () { setKind(button.dataset.kind); });
        });

        document.querySelectorAll('.te-seg[data-field="fill"] .te-seg-btn').forEach(function (button) {
            button.addEventListener('click', function () {
                state.backgroundFill = button.dataset.fill;
                syncSeg('[data-fill]', 'fill', state.backgroundFill);
                renderMedia();
                markDirty();
            });
        });

        document.querySelectorAll('[data-base-view]').forEach(function (button) {
            button.addEventListener('click', function () { setBaseView(button.dataset.baseView); });
        });

        $('teSchemeLight').addEventListener('click', function () { applyScheme('light'); });
        $('teSchemeDark').addEventListener('click', function () { applyScheme('dark'); });
        $('teSchemeClear').addEventListener('click', clearAllColors);

        $('teSave').addEventListener('click', function () { void save(); });
        $('teBack').addEventListener('click', leave);
        $('teReturn').addEventListener('click', leave);

        bindDrop();

        window.addEventListener('beforeunload', function (event) {
            if (!state.dirty) return;
            event.preventDefault();
            event.returnValue = '';
        });
    }

    function setKind(kind) {
        if (kind !== 'image' && kind !== 'video') return;
        state.backgroundKind = kind;
        syncSeg('[data-kind]', 'kind', kind);
        $('teFile').accept = kind === 'video' ? 'video/*' : 'image/*';
        // 类型换了，待上传文件的格式可能就不合法了——直接丢掉，别让保存时才报错。
        if (state.pendingFile) {
            var ext = (state.pendingFile.name.split('.').pop() || '').toLowerCase();
            var allowed = kind === 'video' ? VIDEO_EXT : IMAGE_EXT;
            if (allowed.indexOf(ext) === -1) {
                dropPendingFile();
                toast('已切换为' + (kind === 'video' ? '视频' : '图片') + '，之前的待上传文件已移除', 'error');
            }
        }
        renderMedia();
        markDirty();
    }

    function dropPendingFile() {
        if (state.pendingUrl) URL.revokeObjectURL(state.pendingUrl);
        state.pendingFile = null;
        state.pendingUrl = null;
        $('teFile').value = '';
        renderMedia();
    }

    function pickFile(file) {
        var ext = (file.name.split('.').pop() || '').toLowerCase();
        var allowed = state.backgroundKind === 'video' ? VIDEO_EXT : IMAGE_EXT;
        if (allowed.indexOf(ext) === -1) {
            toast('背景类型是「' + (state.backgroundKind === 'video' ? '视频' : '图片') + '」，不支持 .' + ext + ' 文件', 'error');
            return;
        }
        if (file.size > MAX_BYTES) {
            toast('资源不能超过 64MB', 'error');
            return;
        }
        if (state.pendingUrl) URL.revokeObjectURL(state.pendingUrl);
        state.pendingFile = file;
        state.pendingUrl = URL.createObjectURL(file);
        renderMedia();
        markDirty();
    }

    function bindDrop() {
        var drop = $('teDrop');
        ['dragenter', 'dragover'].forEach(function (type) {
            drop.addEventListener(type, function (event) {
                event.preventDefault();
                drop.classList.add('is-over');
            });
        });
        ['dragleave', 'dragend', 'drop'].forEach(function (type) {
            drop.addEventListener(type, function (event) {
                event.preventDefault();
                drop.classList.remove('is-over');
            });
        });
        drop.addEventListener('drop', function (event) {
            var file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
            if (file) pickFile(file);
        });
        drop.addEventListener('click', function (event) {
            if (event.target.closest('button, input, a')) return;
            $('teFile').click();
        });
        $('tePick').addEventListener('click', function (event) {
            event.stopPropagation();
            $('teFile').click();
        });
        $('teFile').addEventListener('change', function () {
            var file = this.files ? this.files[0] : null;
            if (file) pickFile(file);
        });
    }

    /* ── 保存 ───────────────────────────────────────────────── */

    function collect() {
        var colors = {};
        COLOR_DEFS.forEach(function (def) {
            var value = state.colors[def.key];
            // 整键省略：服务端 validateColors() 遇到空字符串会直接抛异常。
            if (HEX.test(value || '')) colors[def.key] = value.toLowerCase();
        });
        return {
            slug: state.slug,
            name: state.name,
            summary: state.summary,
            sortOrder: Number(state.sortOrder) || 0,
            enabled: !!state.enabled,
            blur: Math.max(0, Math.min(MAX_BLUR, Math.round(Number(state.blur) || 0))),
            shellOpacity: Math.max(MIN_OPACITY, Math.min(1, Number(state.shellOpacity) || DEFAULT_OPACITY)),
            backgroundKind: state.backgroundKind,
            backgroundFill: state.backgroundFill,
            colors: colors
        };
    }

    /** @returns {null|{message:string,field:string}} */
    function validate(body) {
        if (!SLUG.test(body.slug)) {
            return { message: '主题标识只能是小写字母、数字、- 和 _（1-64 位，且不以 - 或 _ 开头）', field: 'teSlug' };
        }
        if (body.name === '') return { message: '请填写主题名称', field: 'teName' };
        if (body.name.length > 64) return { message: '主题名称最多 64 个字符', field: 'teName' };
        return null;
    }

    function mergeFromRow(row) {
        state.id = row.id;
        state.slug = row.slug;
        state.name = row.name;
        state.summary = row.summary || '';
        state.sortOrder = Number(row.sortOrder) || 0;
        state.enabled = !!row.enabled;
        state.colors = Object.assign({}, row.colors || {});
        state.blur = Number(row.blur) || 0;
        state.shellOpacity = Number(row.shellOpacity) || DEFAULT_OPACITY;
        state.backgroundKind = row.backgroundKind === 'video' ? 'video' : 'image';
        state.backgroundFill = ['cover', 'contain', 'fill'].indexOf(row.backgroundFill) === -1 ? 'cover' : row.backgroundFill;
        state.backgroundKey = row.backgroundKey || '';
        state.thumbKey = row.thumbKey || '';
        state.assetVersion = Number(row.assetVersion) || 1;
        state.assetBytes = Number(row.assetBytes) || 0;
        dropPendingFile();
        state.slugTouched = true;
        state.dirty = false;
        fillForm();
        renderPreview();
        applyMetrics();
        renderMedia();
        syncColorRows();
        syncBaseButtons();
        updateChrome();
    }

    function save() {
        if (state.saving) return Promise.resolve();
        var body = collect();
        var problem = validate(body);
        if (problem) {
            toast(problem.message, 'error');
            var field = $(problem.field);
            if (field) {
                field.focus();
                if (typeof field.select === 'function') field.select();
            }
            return Promise.resolve();
        }
        state.saving = true;
        updateChrome();

        var payload = state.id == null ? body : Object.assign({ id: state.id }, body);
        return api('save', payload).then(function (row) {
            // 上传必须在 save 之后：attachAsset() 需要已有 id，
            // 而且 save() 才会把该 slug 从 config/builtin_themes.json 里摘掉、夺回话语权。
            if (!state.pendingFile) return row;
            var file = state.pendingFile;
            return uploadAsset(row.id, file).then(function (uploaded) { return uploaded; });
        }).then(function (row) {
            mergeFromRow(row);
            if (state.id != null) {
                history.replaceState(null, '', 'theme_editor.php?id=' + encodeURIComponent(state.id));
            }
            markClean();
            try { localStorage.setItem(REV_KEY, String(Date.now())); } catch (error) { /* 隐私模式下忽略 */ }
            toast('已保存');
        }).catch(function (error) {
            toast(error.message || '保存失败', 'error');
        }).then(function () {
            state.saving = false;
            updateChrome();
        });
    }

    function leave() {
        if (state.dirty && !window.confirm('有未保存的改动，确定离开吗？')) return;
        state.dirty = false; // 已确认过就别再让 beforeunload 拦一次
        window.close();
        window.setTimeout(function () {
            window.location.href = LIST_URL;
        }, 120);
    }

    /* ── 启动 ───────────────────────────────────────────────── */

    function applyDefaults(count) {
        state.id = null;
        state.slug = '';
        state.name = '';
        state.summary = '';
        state.sortOrder = (count + 1) * 10;
        state.enabled = true;
        state.colors = {};
        state.blur = 0;
        state.shellOpacity = DEFAULT_OPACITY;
        state.backgroundKind = 'image';
        state.backgroundFill = 'cover';
        state.backgroundKey = '';
        state.thumbKey = '';
        state.assetVersion = 1;
        state.assetBytes = 0;
        state.slugTouched = false;
        state.dirty = false;
        fillForm();
        renderPreview();
        applyMetrics();
        renderMedia();
        syncColorRows();
        syncBaseButtons();
        updateChrome();
    }

    function init() {
        renderBase();
        renderColorGroups();
        bindForm();
        syncBaseButtons();

        var raw = new URLSearchParams(window.location.search).get('id');
        var editing = raw !== null && raw !== '' && raw !== 'new';

        api('list', null).then(function (data) {
            var themes = data.themes || [];
            if (!editing) {
                applyDefaults(themes.length);
                return;
            }
            var row = themes.filter(function (item) { return String(item.id) === String(raw); })[0];
            if (!row) {
                toast('主题不存在或已被删除，已切换为新增模式', 'error');
                applyDefaults(themes.length);
                return;
            }
            mergeFromRow(row);
        }).catch(function (error) {
            toast(error.message || '加载失败', 'error');
            applyDefaults(0);
        });
    }

    // 供测试与手调
    window.themeEditor = {
        state: state,
        collect: collect,
        validate: validate,
        renderPreview: renderPreview,
        applyScheme: applyScheme,
        setBaseView: setBaseView,
        baseValueFor: baseValueFor
    };

    init();
})();
