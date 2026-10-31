import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright-core';

const script = await readFile(new URL('../src/appearance.js', import.meta.url), 'utf8');

function element(tag = 'div') {
    const classes = new Set();
    const el = { tagName: tag, style: {}, dataset: {}, isConnected: true, children: [], value: '', type: '', textContent: '', hidden: false };
    el.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: c => (classes.has(c) ? classes.delete(c) : classes.add(c)) };
    el.classes = classes;
    el.setAttribute = () => {};
    el.removeAttribute = () => {};
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    el.appendChild = child => { el.children.push(child); return child; };
    el.insertBefore = child => { el.children.unshift(child); return child; };
    el.append = (...nodes) => { el.children.push(...nodes); };
    el.replaceChildren = () => { el.children.length = 0; };
    el.remove = () => {};
    el.click = () => {};
    el.querySelector = () => null;
    el.querySelectorAll = () => [];
    el.closest = () => null;
    el.play = () => ({ catch: () => {} });
    return el;
}

function harness({ saved = null, native = null, mediaToken = null, nativeVideo = false, fileOps = null, cefSharp = false } = {}) {
    const window = new EventTarget();
    const document = new EventTarget();
    document.readyState = 'complete';
    const inline = new Map();
    document.documentElement = { style: { setProperty: (name, value) => inline.set(name, String(value)), removeProperty: name => inline.delete(name) } };
    document.body = element('body');
    document.getElementById = () => null;
    document.createElement = tag => element(tag);
    let cached = saved;
    const storage = { getItem: () => (cached === null ? null : cached), setItem: (_, next) => { cached = next; } };
    class CustomEvent extends Event { constructor(name, options = {}) { super(name); this.detail = options.detail; } }
    if (mediaToken || nativeVideo) window.MoonYaHost = { mediaToken, nativeVideo };
    // CefSharp 只暴露 BindObjectAsync；对象必须显式绑定后才会挂到 window 上。
    const bindable = {};
    if (native) bindable.moonYaAppearance = native;
    if (fileOps) bindable.moonYaFileOps = fileOps;
    if (native || fileOps || cefSharp) {
        window.CefSharp = { BindObjectAsync: async name => { if (bindable[name]) window[name] = bindable[name]; } };
    }
    vm.runInNewContext(script, {
        window, document, localStorage: storage, CustomEvent, console, setTimeout, clearTimeout,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        Element: class {}, HTMLInputElement: class {}
    });
    return { window, document, inline, api: window.MoonYaAppearance, cached: () => cached, bodyClasses: document.body.classes };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function document_(overrides = {}) {
    return JSON.stringify(Object.assign({
        version: 1,
        activeThemeId: 'default',
        working: { background: { type: 'none', path: null, fill: 'cover', video: { muted: true, loop: true } }, blur: 0, shellOpacity: 0.85, colors: {} },
        themes: []
    }, overrides));
}

test('defaults, clamping of a damaged cache and storage degradation without a bridge', () => {
    const f = harness();
    const initial = f.api.get();
    assert.equal(initial.working.blur, 0);
    assert.equal(initial.working.shellOpacity, 0.85);
    assert.equal(initial.working.background.type, 'none');
    assert.equal(Object.keys(initial.working.colors).length, 0);
    assert.equal(f.api.listThemes().length, 0);
    assert.equal(f.api.hasBridge(), false);
    assert.equal(f.inline.get('--moonya-bg-blur'), '0px');
    assert.equal(f.inline.get('--moonya-shell-opacity'), '0.85');
    assert.equal(f.bodyClasses.has('moonya-has-background'), false);

    const damaged = harness({
        saved: JSON.stringify({
            version: 1,
            working: { blur: 999, shellOpacity: 0.01, background: { type: 'nope', path: 'x', fill: 'weird' }, colors: { accent: 'red', bogus: '#123456' } },
            themes: [{ id: 'a', name: 'A', blur: -5, colors: { inputText: '#ABCDEF' } }, { name: 'no id' }]
        })
    });
    assert.equal(damaged.api.getBlur(), 60, 'blur is clamped to the supported range');
    assert.equal(damaged.api.getShellOpacity(), 0.2);
    assert.equal(damaged.api.getBackground().type, 'none');
    assert.equal(Object.keys(damaged.api.get().working.colors).length, 0, 'invalid colors are dropped');
    assert.equal(damaged.api.listThemes().length, 1);
    assert.equal(damaged.api.listThemes()[0].colors.inputText, '#abcdef');

    // 损坏缓存不抛错，降级为可用默认值并仍然写入。
    const broken = harness({ saved: '{ not json' });
    assert.equal(broken.api.getBlur(), 0);
    broken.api.setBlur(9);
    assert.equal(JSON.parse(broken.cached()).working.blur, 9);
});

test('a video splash is only accepted when the host can play video natively', () => {
    const capable = harness({ mediaToken: 'tok', nativeVideo: true });
    capable.api.setSplash({ type: 'video', path: 'C:\\clips\\rain.mp4', fill: 'cover' });
    assert.equal(capable.api.getSplash().type, 'video');
    assert.equal(capable.api.getSplash().path, 'C:\\clips\\rain.mp4');
    // webm 也走原生：启动画面只有 WPF 层，没有页面内 <video> 兜底
    capable.api.setSplash({ type: 'video', path: 'C:\\clips\\loop.webm', fill: 'cover' });
    assert.equal(capable.api.getSplash().type, 'video');
    // .mkv 明确不收：MF 没有 Matroska demuxer
    capable.api.setSplash({ type: 'video', path: 'C:\\clips\\movie.mkv', fill: 'cover' });
    assert.equal(capable.api.getSplash().type, 'none');

    // 旧客户端（没有能力位）不接受新的视频设置……
    const legacy = harness({ mediaToken: 'tok' });
    legacy.api.setSplash({ type: 'video', path: 'C:\\clips\\rain.mp4', fill: 'cover' });
    assert.equal(legacy.api.getSplash().type, 'none');

    // ……但读到别人设好的视频时不能把数据抹掉，否则一次保存就把设置弄丢了。
    const reader = harness({
        mediaToken: 'tok',
        saved: JSON.stringify({
            version: 1,
            splash: { type: 'video', path: 'C:\\clips\\rain.mp4', fill: 'cover' },
            working: { background: { type: 'none', path: null, fill: 'cover' }, blur: 0, shellOpacity: 0.85, colors: {} },
            themes: []
        })
    });
    assert.equal(reader.api.getSplash().type, 'video');
    assert.equal(reader.api.getSplash().path, 'C:\\clips\\rain.mp4');
});

test('splash background and builtin marker survive a save/reload round trip', () => {
    const f = harness();
    // 启动画面背景默认未设置，且与主背景互不影响
    assert.equal(f.api.getSplash().type, 'none');
    assert.equal(f.api.getSplash().path, null);
    assert.equal(f.api.getActiveBuiltin(), null);
    assert.equal(f.api.listBuiltin().length, 0, '没有宿主时不注入任何内置主题');

    f.api.setBackground({ type: 'image', path: 'C:\\bg.png' });
    assert.equal(f.api.setSplash({ type: 'image', path: 'C:\\splash.png', fill: 'contain' }), true);
    assert.equal(f.api.getSplash().path, 'C:\\splash.png');
    assert.equal(f.api.getSplash().fill, 'contain');
    assert.equal(f.api.getBackground().path, 'C:\\bg.png', '启动画面设置不能动到主背景');
    // 缺少路径的启动画面设置会被拒绝成 none
    assert.equal(f.api.getSplash().type, 'image');
    f.api.setSplash({ type: 'image', path: '' });
    assert.equal(f.api.getSplash().type, 'none');

    // 重载：splash 与 activeBuiltin 都必须被 normalize 保留（而不是被丢掉）
    const reloaded = harness({ saved: f.cached() });
    assert.equal(reloaded.api.getSplash().type, 'none');
    const carried = harness({ saved: JSON.stringify({
        version: 1, activeThemeId: 'default', activeBuiltin: 'forest',
        splash: { type: 'image', path: 'C:\\splash.png', fill: 'fill' },
        working: { background: { type: 'none', path: null, fill: 'cover' }, blur: 0, shellOpacity: 0.85, colors: {} },
        themes: []
    }) });
    assert.equal(carried.api.getActiveBuiltin(), 'forest');
    assert.equal(carried.api.getSplash().path, 'C:\\splash.png');
    assert.equal(carried.api.getSplash().fill, 'fill');
    // 用户自己换背景 / 重置后，内置标记必须清掉
    carried.api.setBackground({ type: 'image', path: 'C:\\mine.png' });
    assert.equal(carried.api.getActiveBuiltin(), null);
});

test('colors write inline CSS variables, surface keeps the rgb triplet in sync, reset restores the base', () => {
    const f = harness();
    assert.equal(f.api.setColor('appBackground', '#112233'), true);
    assert.equal(f.inline.get('--theme-shell'), '#112233');
    assert.equal(f.inline.get('--ui-shell'), '#112233');

    assert.equal(f.api.setColor('surface', '#aabbcc'), true);
    assert.equal(f.inline.get('--theme-surface'), '#aabbcc');
    assert.equal(f.inline.get('--ui-bg'), '#aabbcc');
    assert.equal(f.inline.get('--theme-surface-rgb'), '170, 187, 204', 'rgba() panels must keep working');

    assert.equal(f.api.setColor('inputBackground', '#000000'), true);
    assert.equal(f.inline.get('--moonya-input-bg'), '#000000');
    assert.equal(f.api.isColorCustomized('inputBackground'), true);

    assert.equal(f.api.setColor('accent', 'not-a-color'), false);
    assert.equal(f.api.setColor('unknownKey', '#ffffff'), false);

    assert.equal(f.api.clearColor('appBackground'), true);
    assert.equal(f.inline.has('--theme-shell'), false, 'clearing restores the theme base');
    assert.equal(f.api.clearColor('appBackground'), false);
    assert.equal(f.api.isColorCustomized('appBackground'), false);
});

test('blur and shell opacity clamp, step and persist', () => {
    const f = harness();
    assert.equal(f.api.setBlur(200), 60);
    assert.equal(f.api.setBlur(-10), 0);
    assert.equal(f.api.setBlur(12.6), 13);
    assert.equal(f.inline.get('--moonya-bg-blur'), '13px');

    assert.equal(f.api.setShellOpacity(5), 1);
    assert.equal(f.api.setShellOpacity(0), 0.2);
    assert.equal(f.api.setShellOpacity(0.66), 0.66);
    assert.equal(f.inline.get('--moonya-shell-opacity'), '0.66');

    const savedDoc = JSON.parse(f.cached());
    assert.equal(savedDoc.working.blur, 13);
    assert.equal(savedDoc.working.shellOpacity, 0.66);
});

test('theme library saves, switches, renames and removes without touching the background file', () => {
    const f = harness();
    f.api.setBackground({ type: 'image', path: 'C:\\Users\\Administrator\\Pictures\\forest.png' });
    f.api.setBlur(14);
    f.api.setColor('accent', '#7fd1a0');
    assert.equal(f.api.getBackground().path, 'C:\\Users\\Administrator\\Pictures\\forest.png', 'only the path is stored');

    const id = f.api.saveAsTheme('深林');
    assert.equal(f.api.getActiveThemeId(), id);
    assert.equal(f.api.listThemes().length, 1);
    assert.equal(f.api.listThemes()[0].name, '深林');

    f.api.reset();
    assert.equal(f.api.getBlur(), 0);
    assert.equal(f.api.getBackground().type, 'none');
    assert.equal(f.api.getActiveThemeId(), 'default');

    assert.equal(f.api.applyTheme(id), true);
    assert.equal(f.api.getBlur(), 14);
    assert.equal(f.api.get().working.colors.accent, '#7fd1a0');
    assert.equal(f.api.getBackground().path, 'C:\\Users\\Administrator\\Pictures\\forest.png');

    assert.equal(f.api.renameTheme(id, '  林间  '), true);
    assert.equal(f.api.listThemes()[0].name, '林间');
    assert.equal(f.api.renameTheme(id, '   '), false);

    assert.equal(f.api.applyTheme('missing'), false);
    assert.equal(f.api.removeTheme(id), true);
    assert.equal(f.api.getActiveThemeId(), 'default', 'removing the active theme falls back to the base');
    assert.equal(f.api.listThemes().length, 0);
});

test('media url needs both a path and the injected media token', () => {
    const bare = harness();
    assert.equal(bare.api.mediaUrl('C:\\bg.png'), null);
    const hosted = harness({ mediaToken: 'deadbeef' });
    const url = hosted.api.mediaUrl('C:\\My Pictures\\bg one.png');
    assert.ok(url.startsWith('/local-media?t=deadbeef&path='));
    assert.ok(url.includes(encodeURIComponent('C:\\My Pictures\\bg one.png')));
    assert.equal(hosted.api.mediaUrl(null), null);
});

test('the native document is authoritative on boot and local edits issued first win', async () => {
    const writes = [];
    const remote = document_({
        activeThemeId: 't1',
        working: {
            background: { type: 'image', path: 'C:\\bg.png', fill: 'contain', video: { muted: true, loop: true } },
            blur: 12, shellOpacity: 0.5, colors: { accent: '#ff0000' }
        },
        themes: [{
            id: 't1', name: '深林', updatedAt: '2026-10-05T00:00:00Z',
            background: { type: 'image', path: 'C:\\bg.png', fill: 'contain', video: { muted: true, loop: true } },
            blur: 12, shellOpacity: 0.5, colors: { accent: '#ff0000' }
        }]
    });
    const native = { getAppearance: async () => remote, setAppearance: async doc => { writes.push(doc); return doc; } };
    const f = harness({ saved: '{"version":1,"working":{"blur":3}}', native, mediaToken: 'tok' });
    await settle(); await settle();

    assert.equal(f.api.hasBridge(), true);
    assert.equal(f.api.getBlur(), 12, 'the native file overrides the stale first-paint cache');
    assert.equal(f.api.getShellOpacity(), 0.5);
    assert.equal(f.api.getActiveThemeId(), 't1');
    assert.equal(f.api.listThemes()[0].name, '深林');
    assert.equal(f.inline.get('--moonya-bg-blur'), '12px');
    assert.equal(f.bodyClasses.has('moonya-has-background'), true, 'a background with a resolvable url turns the shell translucent');
    assert.equal(JSON.parse(f.cached()).working.blur, 12);

    // 用户先动手、原生随后才连上 —— 以用户刚做的修改为准并推回原生。
    const late = harness({ native: {
        getAppearance: () => new Promise(resolve => setTimeout(() => resolve(document_()), 120)),
        setAppearance: async doc => { writes.push(doc); return doc; }
    } });
    await settle();
    late.api.setBlur(31);
    await new Promise(resolve => setTimeout(resolve, 300));
    await settle();
    assert.ok(writes.length > 0, 'an edit made before the bridge lands is still pushed to the native file');
    assert.equal(JSON.parse(writes[writes.length - 1]).working.blur, 31);
    assert.equal(late.api.getBlur(), 31, 'the late native snapshot must not clobber the user edit');
});

test('the native file bridge is bound on demand, and it alone gates local background picking', async () => {
    const calls = [];
    const fileOps = { pickLocalFiles: async () => { calls.push('pick'); return { success: true, items: [{ path: 'C:\\pics\\beach.jpg', kind: 'file', name: 'beach.jpg' }] }; } };
    const f = harness({ fileOps });
    // 关键回归：可用性必须按「宿主是否存在」判断。moonYaFileOps 按需绑定，
    // 早先按「对象已存在」判断会让按钮在桌面端永远是禁用的。
    assert.equal(f.api.canUseLocalMedia(), true);
    await settle(); await settle();
    assert.equal(f.window.moonYaFileOps, fileOps, 'boot binds the file bridge so the picker becomes usable');
    assert.equal(calls.length, 0, 'binding must not open a dialog by itself');

    const offline = harness();
    assert.equal(offline.api.canUseLocalMedia(), false, 'a plain browser has no host and no local media');
    assert.equal(offline.window.moonYaFileOps, undefined);
});

test('a background turns the shell translucent only when a media url can be built', () => {
    const f = harness({ mediaToken: 'tok' });
    f.api.setBackground({ type: 'video', path: 'C:\\clips\\rain.mp4' });
    assert.equal(f.api.getBackground().type, 'video');
    assert.equal(f.bodyClasses.has('moonya-has-background'), true);
    assert.equal(f.inline.get('--moonya-bg-blur') !== undefined, true);

    f.api.clearBackground();
    assert.equal(f.api.getBackground().type, 'none');
    assert.equal(f.api.getBackground().path, null);
    assert.equal(f.bodyClasses.has('moonya-has-background'), false);

    const noToken = harness();
    noToken.api.setBackground({ type: 'image', path: 'C:\\bg.png' });
    assert.equal(noToken.bodyClasses.has('moonya-has-background'), false, 'without a media token nothing can be loaded');
    assert.equal(noToken.api.setBackground({ type: 'image', path: '' }), false);
});

const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#a8dcc6"/><stop offset="0.55" stop-color="#5fa8d3"/><stop offset="1" stop-color="#2c4a63"/>' +
    '</linearGradient></defs><rect width="900" height="700" fill="url(#g)"/></svg>'
);

const SKELETON = `<!doctype html><html><head></head><body class="app-shell work-mode">
    <div class="container">
        <nav class="app-rail"></nav>
        <aside class="sidebar"></aside>
        <div class="main-content">
            <div class="input-container-wrapper"><div class="input-wrapper"><textarea class="message-input" placeholder="说点什么"></textarea></div></div>
            <button id="sendBtn" class="send-btn2"></button>
        </div>
    </div></body></html>`;

/** 从布局源里抠出外观分区的真实标记（不依赖 dist，避免必须先构建）。 */
function extractPanel(source) {
    const marker = source.indexOf('id="settingsAppearanceView"');
    if (marker < 0) throw new Error('settingsAppearanceView markup not found');
    const start = source.lastIndexOf('<div', marker);
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
        if (source.startsWith('<div', i)) { depth += 1; i += 3; }
        else if (source.startsWith('</div>', i)) { depth -= 1; i += 5; if (depth === 0) return source.slice(start, i); }
    }
    throw new Error('unbalanced settingsAppearanceView markup');
}

test('builtin themes: catalogue, centre ring progress, re-render survival and download-then-apply', async t => {
    const manifest = JSON.parse(await readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'));
    const artifacts = fileURLToPath(new URL('../artifacts/appearance/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const catalog = {
        success: true,
        data: {
            version: 'v1', base: 'https://example.test', themes: [{
                slug: 'forest', name: '深林', summary: '林间', sort: 10, assetVersion: 2, blur: 12, shellOpacity: 0.8,
                colors: { accent: '#7fd1a0' },
                background: { type: 'image', fill: 'cover', key: 'forest/bg.webp', ext: 'webp', sha256: 'a'.repeat(64), bytes: 2048, url: 'https://example.test/uploads/themes/forest/bg.webp' },
                thumbUrl: 'https://example.test/uploads/themes/forest/thumb.webp'
            }]
        }
    };
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // 需要真实 http origin：相对路径 fetch('/api/...') 在 about:blank 下无法解析。
    await page.route('http://moonya.test/**', route => {
        if (route.request().url().includes('builtin_themes.php')) {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(catalog) });
        }
        return route.fulfill({ contentType: 'text/html', body: SKELETON });
    });
    await page.goto('http://moonya.test/');

    for (const name of manifest.styles) {
        let css;
        try { css = await readFile(new URL('../src/styles/' + name, import.meta.url), 'utf8'); }
        catch { css = await readFile(new URL('../../MoonYa-Backend/admin/assets/' + name, import.meta.url), 'utf8'); }
        await page.addStyleTag({ content: css });
    }
    // 桌面宿主注入的桥（含新的主题资源下载方法），必须在 appearance.js 之前就位。
    await page.addScriptTag({ content: `
        window.__fetched = [];
        window.CefSharp = { BindObjectAsync: async name => {
            if (name !== 'moonYaAppearance') return;
            window.moonYaAppearance = {
                getAppearance: async () => JSON.stringify({ version: 1, activeThemeId: 'default', activeBuiltin: null,
                    splash: { type: 'none', path: null, fill: 'cover' },
                    working: { background: { type: 'none', path: null, fill: 'cover', video: { muted: true, loop: true } }, blur: 0, shellOpacity: 0.85, colors: {} },
                    themes: [] }),
                setAppearance: async document => document,
                themeAssetStatus: async () => ({ success: true, cached: false, path: '' }),
                fetchThemeAsset: async (url, slug) => {
                    window.__fetched.push(slug);
                    return { success: true, path: 'C:\\\\Users\\\\Administrator\\\\.moonya\\\\appearance\\\\themes\\\\' + slug + '\\\\bg.webp', bytes: 2048 };
                }
            };
        } };
    ` });
    await page.addScriptTag({ content: await readFile(new URL('../src/ui-ring.js', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: await readFile(new URL('../src/appearance.js', import.meta.url), 'utf8') });

    const panel = extractPanel(await readFile(new URL('../src/layouts/settings-modal.html', import.meta.url), 'utf8'));
    await page.evaluate(markup => {
        const overlay = document.createElement('div');
        overlay.className = 'settings-overlay show';
        overlay.innerHTML = '<div class="settings-modal settings-modal--wide" id="moonyaPreviewModal" '
            + 'style="max-height:none;height:auto;overflow:visible;opacity:1;transform:none">' + markup + '</div>';
        document.body.appendChild(overlay);
        document.getElementById('settingsAppearanceView').style.display = 'block';
        window.MoonYaAppearance.mountSettings(document.getElementById('settingsAppearanceView'));
    }, panel);

    // 目录加载完 → 内置卡排在网格最前
    await page.waitForSelector('.appearance-theme-card[data-builtin="forest"]');
    assert.equal(await page.locator('#moonyaThemeGrid .appearance-theme-card').count(), 2, '内置 + 默认外观');
    assert.equal(await page.locator('#moonyaThemeGrid .appearance-theme-card').first().getAttribute('data-theme-id'), 'builtin:forest');
    assert.equal(await page.locator('#moonyaBuiltinNote').isVisible(), false, '目录可用时不该提示不可用');
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.listBuiltin().length), 1);

    // 点卡片：没有缓存 → 走下载桥 → 自动应用，背景路径指向 .moonya 本地缓存
    await page.locator('.appearance-theme-card[data-builtin="forest"] .appearance-theme-preview').click();
    await page.waitForFunction(() => window.MoonYaAppearance.getActiveBuiltin() === 'forest');
    assert.equal(await page.evaluate(() => window.__fetched.join(',')), 'forest');
    const applied = await page.evaluate(() => window.MoonYaAppearance.get());
    assert.ok(applied.working.background.path.includes('.moonya'), '背景必须指向本地缓存文件');
    assert.equal(applied.working.blur, 12);
    assert.equal(applied.working.colors.accent, '#7fd1a0');
    assert.equal(await page.locator('.appearance-theme-card[data-builtin="forest"]').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await page.locator('.appearance-theme-card.active').getAttribute('data-theme-id'), 'builtin:forest');

    // 下载进度：卡片中心圆环 + 环内百分比
    await page.evaluate(() => window.MoonYaAppearance.acceptAssetProgress('forest', 42, 420, 1000));
    const card = page.locator('.appearance-theme-card[data-builtin="forest"]');
    assert.equal(await card.getAttribute('data-state'), 'downloading');
    assert.equal(await card.locator('.appearance-theme-percent').textContent(), '42%');
    const circumference = 2 * Math.PI * 22;
    const offset = await card.locator('.appearance-ring-arc').evaluate(el => Number(el.style.strokeDashoffset));
    assert.ok(Math.abs(offset - circumference * (1 - 0.42)) < 0.5, `圆环角度应对应 42%，实际 ${offset}`);
    await page.locator('#moonyaPreviewModal').screenshot({ path: join(artifacts, 'panel-wide-builtin.png') });

    // refreshPanel 会 replaceChildren 重建卡片 —— 进度必须从 Map 里恢复，不能归零
    await page.evaluate(() => window.MoonYaAppearance.applyTheme('default'));
    assert.equal(await page.locator('.appearance-theme-card[data-builtin="forest"] .appearance-theme-percent').textContent(), '42%');
    assert.equal(await page.locator('.appearance-theme-card[data-builtin="forest"]').getAttribute('data-state'), 'downloading');

    assert.deepEqual(errors, []);
});

test('the appearance stylesheet really makes the shell translucent and honours the colour overrides', async t => {
    const manifest = JSON.parse(await readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'));
    const artifacts = fileURLToPath(new URL('../artifacts/appearance/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(SKELETON);
    for (const name of manifest.styles) {
        // 多数样式在 src/styles/，但 system-dialog.css 是 build.mjs 从后端 assets 拷进 dist 的（build.mjs:33）。
        let css;
        try {
            css = await readFile(new URL('../src/styles/' + name, import.meta.url), 'utf8');
        } catch {
            css = await readFile(new URL('../../MoonYa-Backend/admin/assets/' + name, import.meta.url), 'utf8');
        }
        await page.addStyleTag({ content: css });
    }
    await page.addScriptTag({ content: await readFile(new URL('../src/ui-ring.js', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: await readFile(new URL('../src/appearance.js', import.meta.url), 'utf8') });

    const background = selector => page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
    // Chrome 会把 color-mix() 的结果序列化成 color(srgb r g b / a)，不是 rgba()。
    const alphaOf = value => {
        if (value.startsWith('rgba')) return Number(value.match(/[\d.]+/g)[3]);
        const slash = value.match(/\/\s*([\d.]+)\s*\)/);
        return slash ? Number(slash[1]) : 1;
    };

    assert.equal(alphaOf(await background('.sidebar')), 1, 'the shell is opaque until a background is set');
    assert.equal(alphaOf(await background('.main-content')), 1);

    // 走真实 API 设置模糊与不透明度，再挂上背景媒体层。
    await page.evaluate(image => {
        window.MoonYaAppearance.setShellOpacity(0.55);
        window.MoonYaAppearance.setBlur(18);
        const layer = document.getElementById('moonyaAppearanceBackground');
        layer.innerHTML = '<img class="moonya-bg-media" src="' + image + '">';
        document.body.classList.add('moonya-has-background');
    }, DEMO_IMAGE);
    await page.waitForFunction(() => {
        const image = document.querySelector('.moonya-bg-media');
        return image && image.complete && image.naturalWidth > 0;
    });

    for (const selector of ['.sidebar', '.main-content', '.app-rail']) {
        const value = await background(selector);
        assert.ok(value !== 'rgba(0, 0, 0, 0)', `${selector} must keep a colour, got ${value}`);
        assert.ok(Math.abs(alphaOf(value) - 0.55) < 0.02, `${selector} must honour --moonya-shell-opacity, got ${value}`);
    }
    assert.equal(await page.locator('.moonya-bg-media').evaluate(el => getComputedStyle(el).filter), 'blur(18px)');
    // 原生标题栏与媒体共享全窗口视口，内容仍从标题栏下方开始。
    await page.evaluate(() => {
        document.documentElement.dataset.nativeTitleBar = 'true';
        document.documentElement.style.setProperty('--moonya-titlebar-height', '32px');
    });
    const titleLayout = await page.evaluate(() => ({
        content: document.querySelector('.container').getBoundingClientRect().toJSON(),
        media: document.getElementById('moonyaAppearanceBackground').getBoundingClientRect().toJSON(),
        viewportHeight: innerHeight,
        tint: getComputedStyle(document.body, '::before').backgroundColor,
        titleHeight: getComputedStyle(document.body, '::before').height
    }));
    assert.equal(titleLayout.content.top, 32);
    assert.equal(titleLayout.content.bottom, titleLayout.viewportHeight);
    assert.equal(titleLayout.media.top, 0);
    assert.equal(titleLayout.media.height, titleLayout.viewportHeight);
    assert.equal(titleLayout.titleHeight, '32px');
    assert.ok(Math.abs(alphaOf(titleLayout.tint) - 0.55) < 0.02);
    await page.screenshot({ path: join(artifacts, 'shell-native-titlebar.png') });
    await page.evaluate(() => { delete document.documentElement.dataset.nativeTitleBar; });
    await page.screenshot({ path: join(artifacts, 'shell-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: join(artifacts, 'shell-dark.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

    await page.evaluate(() => {
        const root = document.documentElement.style;
        root.setProperty('--moonya-input-bg', '#123456');
        root.setProperty('--moonya-input-text', '#00ff00');
        root.setProperty('--moonya-btn-bg', '#ff0000');
    });
    assert.equal(await background('.input-wrapper'), 'rgb(18, 52, 86)');
    assert.equal(await page.locator('.message-input').evaluate(el => getComputedStyle(el).color), 'rgb(0, 255, 0)');
    assert.equal(await background('#sendBtn'), 'rgb(255, 0, 0)');

    // 背景层必须排在界面内容之下，且不吃点击。
    const stacking = await page.evaluate(() => {
        const layer = document.getElementById('moonyaAppearanceBackground');
        return {
            pointer: getComputedStyle(layer).pointerEvents,
            position: getComputedStyle(layer).position,
            layerZ: getComputedStyle(layer).zIndex,
            containerZ: getComputedStyle(document.querySelector('.container')).zIndex
        };
    });
    assert.equal(stacking.pointer, 'none');
    assert.equal(stacking.position, 'fixed');
    assert.ok(Number(stacking.containerZ) > Number(stacking.layerZ), 'the container must sit above the background layer');

    // 渲染真实外观分区（真实标记 + 真实样式 + 真实模块），产出可查看的截图。
    const panel = extractPanel(await readFile(new URL('../src/layouts/settings-modal.html', import.meta.url), 'utf8'));
    await page.setViewportSize({ width: 1100, height: 1500 });
    await page.evaluate(markup => {
        // .settings-modal 默认 opacity:0，只有 .settings-overlay.show 里才可见 —— 必须带上这层。
        // 带上 --wide 以真实走一遍横屏两列布局（宽度由该类给出：min(920px, 100vw-32px)）。
        const overlay = document.createElement('div');
        overlay.className = 'settings-overlay show';
        overlay.innerHTML = '<div class="settings-modal settings-modal--wide" id="moonyaPreviewModal" '
            + 'style="max-height:none;height:auto;overflow:visible;opacity:1;transform:none">' + markup + '</div>';
        document.body.appendChild(overlay);
        // 子视图在真实弹窗里默认 display:none，这里要让它显示出来。
        document.getElementById('settingsAppearanceView').style.display = 'block';
        window.MoonYaAppearance.setBlur(12);
        window.MoonYaAppearance.saveAsTheme('林间');
        window.MoonYaAppearance.saveAsTheme('晨雾');
        window.MoonYaAppearance.applyTheme('default');
        window.MoonYaAppearance.setBlur(12);
        window.MoonYaAppearance.mountSettings(document.getElementById('settingsAppearanceView'));
    }, panel);
    await page.waitForSelector('#moonyaThemeGrid .appearance-theme-card', { state: 'visible' });
    assert.equal(await page.locator('#moonyaColorList .appearance-color-row').count(), 11, 'every colour row is rendered');
    assert.equal(await page.locator('#moonyaThemeGrid .appearance-theme-card').count(), 3, '默认外观 plus two saved themes');
    assert.equal(await page.locator('#moonyaBgUnavailable').isVisible(), true, 'browser-only runs explain why picking a background is unavailable');
    assert.ok(await page.locator('#moonyaBgPickImage').isDisabled());
    assert.equal(await page.locator('#moonyaBlurValue').textContent(), '12');
    assert.equal(await page.locator('.appearance-theme-card.active').getAttribute('data-theme-id'), 'default');

    // 横屏：宽屏下外观分区是两列栅格，弹窗明显宽于 448px
    const wide = await page.locator('#moonyaPreviewModal').evaluate(el => el.getBoundingClientRect().width);
    assert.ok(wide > 700 && wide <= 920, `wide modal should span the landscape width, got ${wide}`);
    assert.equal(await page.locator('.appearance-layout').evaluate(el => getComputedStyle(el).display), 'grid');
    assert.equal(await page.locator('.appearance-layout').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
    // 需要整行宽度的卡确实横跨两列
    const spanned = await page.locator('.appearance-layout > [data-span="2"]').first().evaluate(el => el.getBoundingClientRect().width);
    const column = await page.locator('.appearance-layout').evaluate(el => el.getBoundingClientRect().width);
    assert.ok(spanned > column * 0.9, 'the full-width cards must span both columns');
    await page.locator('#moonyaPreviewModal').screenshot({ path: join(artifacts, 'panel-wide-light.png') });

    // 窄屏必须回退成单列，且不横向溢出（theme.test.mjs 的 360px 断言依赖这一点）
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.locator('.appearance-layout').evaluate(el => getComputedStyle(el).display), 'block');
    const overflow = await page.locator('.appearance-layout').evaluate(el => {
        const box = el.getBoundingClientRect();
        return { width: el.clientWidth, scroll: el.scrollWidth, left: box.left, right: box.right };
    });
    assert.equal(overflow.scroll, overflow.width, 'narrow layout must not scroll horizontally');
    assert.ok(overflow.left >= 0 && overflow.right <= 360, `narrow layout must fit the viewport, got ${JSON.stringify(overflow)}`);
    await page.setViewportSize({ width: 1100, height: 1500 });
    await page.locator('#moonyaPreviewModal').screenshot({ path: join(artifacts, 'panel-light.png') });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('moonya:theme-change')); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.appearance-color-row')).backgroundColor !== 'rgb(255, 255, 255)');
    for (const selector of ['.appearance-color-row', '.settings-sub-card']) {
        const value = await page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
        const channels = value.match(/\d+/g).slice(0, 3).map(Number);
        assert.ok(Math.max(...channels) < 80, `${selector} must follow the dark base: ${value}`);
    }
    await page.locator('#moonyaPreviewModal').screenshot({ path: join(artifacts, 'panel-dark.png') });

    // 「按钮点了没用」的回归点：事件委托 + 按需绑定之后，真实点击必须生效。
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.dispatchEvent(new Event('moonya:theme-change')); });
    await page.evaluate(() => window.MoonYaAppearance.setBackground({ type: 'image', path: 'C:\\demo\\bg.png' }));
    await page.locator('[data-bg-fill="contain"]').click();
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBackground().fill), 'contain');
    assert.equal(await page.locator('[data-bg-fill="contain"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-bg-fill="cover"]').click();
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBackground().fill), 'cover');

    await page.locator('#moonyaColorList input[type="color"]').first().fill('#123456');
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.isColorCustomized('appBackground')), true);
    assert.equal(await page.locator('.appearance-color-row').first().evaluate(el => el.classList.contains('customized')), true);

    await page.locator('#moonyaBlurRange').fill('20');
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBlur()), 20);
    assert.equal(await page.locator('#moonyaBlurValue').textContent(), '20');
    await page.locator('[data-step-target="blur"][data-step-delta="-1"]').click();
    assert.equal(await page.locator('#moonyaBlurValue').textContent(), '19');
    await page.locator('#moonyaOpacityRange').fill('40');
    assert.equal(await page.locator('#moonyaOpacityValue').textContent(), '40%');

    await page.fill('#moonyaThemeName', '夜航');
    await page.locator('#moonyaThemeSave').click();
    assert.equal(await page.locator('#moonyaThemeGrid .appearance-theme-card').count(), 4, '默认外观 plus three saved themes');
    assert.equal(await page.locator('#moonyaThemeName').inputValue(), '', 'the name field is cleared after saving');
    await page.locator('.appearance-theme-card[data-theme-id="default"] [data-theme-action="apply"]').click();
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBlur()), 0);

    assert.deepEqual(errors, []);
});

test('an undecodable video is refused with the real reason, never committed as "file missing"', async t => {
    const manifest = JSON.parse(await readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    // 由测试控制 /local-media 的行为：
    //   'missing' → 404（路由取不到文件）
    //   'mp4'     → 200 + video/mp4 但内容不是合法视频 —— 真实 Chromium 会报
    //               MEDIA_ELEMENT_ERROR: Format error，这正是 H.264 解不出来时的表现。
    const media = { mode: 'missing' };
    await page.route('http://moonya.test/**', route => {
        if (new URL(route.request().url()).pathname === '/local-media') {
            return media.mode === 'missing'
                ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' })
                : route.fulfill({ status: 200, contentType: 'video/mp4', body: 'not a real mp4 payload' });
        }
        return route.fulfill({ contentType: 'text/html', body: SKELETON });
    });
    // 相对路径的 fetch('/local-media') 需要真实 origin，about:blank 下无法解析。
    await page.goto('http://moonya.test/');

    for (const name of manifest.styles) {
        let css;
        try { css = await readFile(new URL('../src/styles/' + name, import.meta.url), 'utf8'); }
        catch { css = await readFile(new URL('../../MoonYa-Backend/admin/assets/' + name, import.meta.url), 'utf8'); }
        await page.addStyleTag({ content: css });
    }
    await page.addScriptTag({ content: `
        window.MoonYaHost = { mediaToken: 'probe-token', nativeVideo: false };
        window.__toasts = [];
        window.showToast = message => window.__toasts.push(message);
        window.CefSharp = { BindObjectAsync: async name => {
            if (name === 'moonYaFileOps') {
                window.moonYaFileOps = { pickLocalFiles: async () => ({ success: true, items: [
                    { path: 'C:\\\\clips\\\\rain.mp4', kind: 'file', name: 'rain.mp4' }
                ] }) };
            }
            if (name === 'moonYaAppearance') {
                window.moonYaAppearance = {
                    getAppearance: async () => JSON.stringify({ version: 1, activeThemeId: 'default', activeBuiltin: null,
                        working: { background: { type: 'none', path: null, fill: 'cover', video: { muted: true, loop: true } }, blur: 0, shellOpacity: 0.85, colors: {} },
                        themes: [] }),
                    setAppearance: async document => document
                };
            }
        } };
    ` });

    // 面板必须先于 appearance.js 就位：boot() 会立刻挂载并同步按钮可用性。
    const panel = extractPanel(await readFile(new URL('../src/layouts/settings-modal.html', import.meta.url), 'utf8'));
    await page.evaluate(markup => {
        const host = document.createElement('div');
        host.innerHTML = markup;
        document.body.appendChild(host);
        // 子视图在真实弹窗里默认 display:none，这里要让它显示出来。
        document.getElementById('settingsAppearanceView').style.display = 'block';
    }, panel);
    await page.addScriptTag({ content: await readFile(new URL('../src/ui-ring.js', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: await readFile(new URL('../src/appearance.js', import.meta.url), 'utf8') });

    assert.equal(await page.locator('#moonyaBgPickVideo').isDisabled(), false, '宿主在场时选视频必须可点');

    // ① 路由取不到文件 → 说「文件没了」，且不落盘
    await page.locator('#moonyaBgPickVideo').click();
    await page.waitForFunction(() => window.__toasts.length === 1);
    assert.match(await page.evaluate(() => window.__toasts[0]), /无法读取/);
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBackground().type), 'none');
    assert.equal(await page.evaluate(() => document.body.classList.contains('moonya-has-background')), false);

    // ② 文件在、但解不出来 → 必须点明编码问题并给出可行动建议，且不落盘
    //    （旧行为：把这一种也报成「可能已被移动或删除」，用户会去翻文件）
    media.mode = 'mp4';
    await page.locator('#moonyaBgPickVideo').click();
    await page.waitForFunction(() => window.__toasts.length === 2);
    const refusal = await page.evaluate(() => window.__toasts[1]);
    assert.match(refusal, /WebM/, `必须建议改用 WebM，实际：${refusal}`);
    assert.doesNotMatch(refusal, /已被移动或删除/, `编码问题不能报成文件丢失，实际：${refusal}`);
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBackground().type), 'none', '不能把必然失败的背景写进配置');
    assert.match(await page.locator('#moonyaBgStatus').textContent(), /WebM/, '面板状态行要留下原因，不能一闪而过');

    // ③ 探测通过时必须照常落盘（用替身模拟可解码，真实解码无法在无 fixture 时构造）
    await page.evaluate(() => {
        window.__realCreateElement = document.createElement.bind(document);
        document.createElement = tag => {
            const node = window.__realCreateElement(tag);
            if (tag !== 'video') return node;
            Object.defineProperty(node, 'src', {
                get: () => '',
                set: () => setTimeout(() => node.dispatchEvent(new Event('loadedmetadata')), 0)
            });
            return node;
        };
    });
    await page.locator('#moonyaBgPickVideo').click();
    await page.waitForFunction(() => window.MoonYaAppearance.getBackground().path === 'C:\\clips\\rain.mp4');
    assert.equal(await page.evaluate(() => window.__toasts.length), 2, '可解码的视频不该再弹提示');

    // ④ 已经存进配置的坏视频（用户之前踩的坑）：启动时那次失败也要说清原因
    await page.evaluate(() => {
        document.createElement = window.__realCreateElement;
        window.MoonYaAppearance.clearBackground();
        window.MoonYaAppearance.setBackground({ type: 'video', path: 'C:\\clips\\legacy.mp4' });
    });
    await page.waitForFunction(() => window.__toasts.length === 3);
    const restored = await page.evaluate(() => window.__toasts[2]);
    assert.match(restored, /WebM/, `回放失败也要指出编码问题，实际：${restored}`);
    assert.doesNotMatch(restored, /已被移动或删除/);
    assert.equal(await page.evaluate(() => document.body.classList.contains('moonya-has-background')), false, '坏背景不能把外壳留在半透明态');

    // ⑤ 启动画面背景走宿主原生播放：mp4 直接被接受，不再做页面内探测（页面内必然解不出来）
    await page.evaluate(() => {
        window.MoonYaHost.nativeVideo = true;
        window.MoonYaAppearance.setBlur(1);
    });
    await page.locator('#moonyaSplashPickVideo').click();
    await page.waitForFunction(() => window.MoonYaAppearance.getSplash().type === 'video');
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getSplash().path), 'C:\\clips\\rain.mp4');
    assert.equal(await page.locator('#moonyaSplashPreview').getAttribute('data-kind'), 'video-native');
    assert.match(await page.locator('#moonyaSplashStatus').textContent(), /原生播放/);
    assert.equal(await page.locator('#moonyaSplashPickVideo').isDisabled(), false, '有原生能力时选视频必须可点');
    // 原生视频没有页面内画面可画，预览槽不能假装能预览
    assert.equal(await page.locator('#moonyaSplashPreview').getAttribute('data-loadable'), 'true');
    assert.equal(await page.evaluate(() => window.__toasts.length), 3, '接受原生视频不该弹提示');

    // 主界面 MP4 同样必须绕过无 H.264 解码器的浏览器，保留配置并露出原生层。
    await page.locator('#moonyaBgPickVideo').click();
    await page.waitForFunction(() => document.body.classList.contains('moonya-native-video'));
    assert.equal(await page.evaluate(() => window.MoonYaAppearance.getBackground().path), 'C:\\clips\\rain.mp4');
    assert.equal(await page.locator('#moonyaAppearanceBackground video').count(), 0);
    assert.equal(await page.evaluate(() => window.__toasts.length), 3);
    // New hosts expose native thumbnails so MP4 previews have an actual image.
    const thumbnailRequests = [];
    await page.route('**/local-media?**', route => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('thumbnail') !== '1') return route.fulfill({ status: 404 });
        thumbnailRequests.push(url.searchParams.get('path'));
        if (url.searchParams.get('path').includes('broken')) return route.fulfill({ status: 422 });
        return route.fulfill({ contentType: 'image/png', body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64') });
    });
    await page.evaluate(() => {
        window.MoonYaHost.mediaThumbnails = true;
        window.MoonYaAppearance.setBlur(2);
    });
    await page.waitForFunction(() => ['moonyaBgPreview', 'moonyaSplashPreview'].every(
        id => document.getElementById(id).dataset.previewState === 'ready'));
    assert.equal(await page.locator('#moonyaBgPreview img').evaluate(img => img.naturalWidth), 1);
    assert.equal(await page.locator('#moonyaSplashPreview img').evaluate(img => img.naturalWidth), 1);
    assert.ok(thumbnailRequests.length >= 1 && thumbnailRequests.length <= 2,
        'both previews use the thumbnail route (Chromium may combine identical requests)');
    await page.evaluate(() => {
        window.__previewImage = document.querySelector('#moonyaBgPreview img');
        window.MoonYaAppearance.setBlur(3);
    });
    assert.equal(await page.evaluate(() => window.__previewImage === document.querySelector('#moonyaBgPreview img')), true,
        'slider changes retain the loaded preview');
    await page.evaluate(() => window.MoonYaAppearance.setBackground({ type: 'video', path: 'C:\\clips\\broken.mp4' }));
    await page.waitForFunction(() => document.getElementById('moonyaBgPreview').dataset.previewState === 'error');
    assert.match(await page.locator('#moonyaBgPreview').evaluate(el => getComputedStyle(el, '::before').content), /无法生成预览/);
    for (const selector of ['html', 'body', '#moonyaAppearanceBackground']) {
        assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor),
            'rgba(0, 0, 0, 0)', `${selector} must not cover the native video behind the WebView`);
    }
    await page.evaluate(() => { window.MoonYaAppearance.clearBackground(); });
    assert.equal(await page.locator('#moonyaBgPreview img').count(), 0);
    assert.equal(await page.evaluate(() => document.body.classList.contains('moonya-native-video')), false);
    assert.notEqual(await page.locator('html').evaluate(el => getComputedStyle(el).backgroundColor),
        'rgba(0, 0, 0, 0)', 'removing the native background restores the theme base');

    assert.deepEqual(errors, []);
});
