import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import { chromium } from 'playwright-core';

const script = await readFile(new URL('../src/theme.js', import.meta.url), 'utf8');
function model({ saved, dark = false, brokenStorage = false, native } = {}) {
    const window = new EventTarget(), media = new EventTarget(); media.matches = dark;
    const document = new EventTarget(); document.readyState = 'loading';
    document.documentElement = { dataset: {}, style: {} };
    let value = saved;
    const storage = {
        getItem() { if (brokenStorage) throw Error('disabled'); return value; },
        setItem(_, next) { if (brokenStorage) throw Error('disabled'); value = next; }
    };
    class CustomEvent extends Event { constructor(name, options) { super(name); this.detail = options.detail; } }
    window.matchMedia = () => media;
    if (native) { window.CefSharp = { BindObjectAsync: async () => { window.moonYaTheme = native; } }; }
    vm.runInNewContext(script, { window, document, localStorage: storage, CustomEvent, console });
    return { window, document, api: window.MoonYaTheme, media, cached: () => value };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('theme defaults, invalid cache, disabled storage and system changes', () => {
    const f = model({ saved: 'invalid', dark: true, brokenStorage: true });
    assert.equal(f.api.getPreference(), 'system');
    assert.equal(f.api.getResolvedTheme(), 'dark');
    f.media.matches = false; f.media.dispatchEvent(new Event('change'));
    assert.equal(f.api.getResolvedTheme(), 'light');
    f.api.setPreference('dark');
    f.media.dispatchEvent(new Event('change'));
    assert.equal(f.api.getResolvedTheme(), 'dark');
    assert.equal(f.api.setPreference('invalid'), false);
    assert.equal(f.document.documentElement.style.colorScheme, 'dark');
    f.api.setPreference('system');
    assert.equal(f.api.getResolvedTheme(), 'light');
    const cached = model({ saved: 'dark' });
    assert.equal(cached.api.getResolvedTheme(), 'dark', 'cached preference is applied before DOMContentLoaded');
    cached.api.setPreference('light');
    assert.equal(cached.cached(), 'light');
});

test('late native binding preserves clicks and serializes saves', async () => {
    let release; const writes = [];
    const native = { getState: () => new Promise(resolve => { release = resolve; }), setPreference: async value => { writes.push(value); } };
    const f = model({ native });
    f.document.dispatchEvent(new Event('DOMContentLoaded')); await settle();
    f.api.setPreference('dark');
    release(JSON.stringify({ preference: 'light', resolved: 'light' })); await settle();
    assert.equal(f.api.getPreference(), 'dark');
    f.api.setPreference('light'); f.api.setPreference('system'); await settle();
    assert.deepEqual(writes, ['dark', 'light', 'system']);
    f.api.acceptNativeSystemTheme('dark');
    assert.equal(f.api.getResolvedTheme(), 'dark');
    f.api.setPreference('light'); f.api.acceptNativeSystemTheme('dark');
    assert.equal(f.api.getResolvedTheme(), 'light');
});

test('native preference overrides stale frontend cache on restart', async () => {
    const f = model({ saved: 'dark', native: { getState: async () => JSON.stringify({ preference: 'system', resolved: 'light' }) } });
    f.document.dispatchEvent(new Event('DOMContentLoaded')); await settle();
    assert.equal(f.api.getPreference(), 'system');
    assert.equal(f.api.getResolvedTheme(), 'light');
    assert.equal(f.cached(), 'system');
});

test('switching a native manual preference to system uses the actual Windows appearance immediately', async () => {
    const f = model({ dark: true, native: { getState: async () => JSON.stringify({ preference: 'dark', resolved: 'dark', systemTheme: 'light' }), setPreference: async () => {} } });
    f.document.dispatchEvent(new Event('DOMContentLoaded')); await settle();
    assert.equal(f.api.getResolvedTheme(), 'dark');
    f.api.setPreference('system');
    assert.equal(f.api.getResolvedTheme(), 'light');
});

test('full UI theme selection, reload, contrast, responsive cards and system following', async t => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const data = await mkdtemp(join(tmpdir(), 'moonya-theme-'));
    const child = spawn('dotnet', [join(root, 'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),
        join(root, 'MoonYa-Frontend/dist'), 'http://127.0.0.1:1/', 'http://127.0.0.1:2/'],
    { env: { ...process.env, MOONYA_SMOKE_DATA: data }, windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
    const host = await new Promise((resolve, reject) => {
        createInterface({ input: child.stdout }).once('line', line => resolve(JSON.parse(line)));
        child.once('exit', code => reject(Error('Native host ' + code + ': ' + stderr)));
    });
    t.after(() => new Promise(resolve => { child.once('exit', resolve); child.stdin.end('\n'); }));
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1200, height: 850 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url);
    await page.waitForFunction(() => !!window.openSettingsModal);
    await page.waitForSelector('#moonyaAppearanceBackground', { state: 'attached' });
    assert.equal(await page.locator('#moonyaAppearanceBackground').evaluate(el => getComputedStyle(el).display), 'none',
        'an inactive background layer must not paint over the application navigation');
    for (const id of ['conversationBtn', 'pluginsBtn', 'officeBtn', 'railBrowserBtn', 'settingsBtn', 'userInfoDiv']) {
        await page.locator(`#${id}`).waitFor({ state: 'visible' });
    }
    await page.evaluate(() => openSettingsModal('appearance'));
    assert.equal(await page.getAttribute('html', 'data-theme-preference'), 'system');
    const artifacts = join(root, 'MoonYa-Frontend/artifacts/theme'); await mkdir(artifacts, { recursive: true });
    for (const theme of ['dark', 'light']) {
        await page.locator(`[data-theme-choice="${theme}"]`).click();
        await page.waitForFunction(() => document.getAnimations().every(animation => !(animation instanceof CSSTransition)));
        assert.equal(await page.getAttribute('html', 'data-theme'), theme);
        assert.equal(await page.locator(`[data-theme-choice="${theme}"]`).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#settingsAppearanceValue').textContent(), theme === 'dark' ? '深色' : '浅色');
        const colors = await page.locator('.settings-theme-option').first().evaluate(el => {
            const s = getComputedStyle(el); return { background: s.backgroundColor, foreground: s.color };
        });
        assert.notEqual(colors.background, colors.foreground);
        assert.equal(colors.background, theme === 'dark' ? 'rgb(30, 31, 35)' : 'rgb(244, 244, 246)');
        await page.screenshot({ path: join(artifacts, `settings-${theme}.png`) });
        if (theme === 'dark') {
            for (const selector of ['.app-rail', '.sidebar', '.settings-choice-item']) {
                const background = await page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
                const channels = background.match(/\d+/g).slice(0, 3).map(Number);
                assert.ok(Math.max(...channels) < 80, `${selector} must have a dark surface: ${background}`);
            }
        }
        await page.evaluate(() => { closeSettingsModal(); showToast('主题通知检查'); });
        await page.waitForFunction(() => document.querySelector('.toast-card') && document.getAnimations().every(animation => !(animation instanceof Animation) || !animation.effect?.target?.closest('.toast-card')));
        await page.screenshot({ path: join(artifacts, `chat-${theme}.png`) });
        await page.locator('#agentSettingsStatus').click();
        await page.locator('#agentModelCaptionToggle').click();
        await page.locator('#agentModelMenu').waitFor({ state: 'visible' });
        await page.waitForFunction(() => getComputedStyle(document.getElementById('agentModelMenu')).opacity === '1');
        assert.equal(await page.locator('#agentModelMenu').evaluate(el => getComputedStyle(el).backgroundColor),
            theme === 'dark' ? 'rgba(30, 31, 35, 0.98)' : 'rgba(255, 255, 255, 0.98)');
        await page.screenshot({ path: join(artifacts, `model-menu-${theme}.png`) });
        await page.keyboard.press('Escape');
        await page.evaluate(() => openSettingsModal('appearance'));
    }
    await page.locator('[data-theme-choice="dark"]').click();
    await page.reload(); await page.waitForFunction(() => !!window.openSettingsModal);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.evaluate(() => openSettingsModal('appearance'));
    await page.setViewportSize({ width: 360, height: 740 });
    await page.locator('[data-theme-choice="system"]').click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const boxes = await page.locator('.settings-theme-option').evaluateAll(elements => elements.map(el => ({ width: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
    assert.ok(boxes.every(box => box.width === box.scroll && box.left >= 0 && box.right <= 360));
    await page.screenshot({ path: join(artifacts, 'settings-dark-narrow.png') });
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.evaluate(() => { closeSettingsModal(); renderAuthState({ id: 41, username: 'theme-fixture' }); });
    for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => MoonYaTheme.setPreference(theme), theme);
        await page.evaluate(() => MoonYaPluginView.open());
        await page.screenshot({ path: join(artifacts, `plugins-${theme}.png`) });
        await page.evaluate(() => { MoonYaPluginView.close(); MoonYaOffice.open(); });
        await page.screenshot({ path: join(artifacts, `office-${theme}.png`) });
        const officeColors = await page.locator('#officeView').evaluate(el => {
            const style = getComputedStyle(el); return { foreground: style.color, background: style.backgroundColor };
        });
        assert.equal(officeColors.foreground, theme === 'dark' ? 'rgb(238, 238, 242)' : 'rgb(38, 39, 43)');
        await page.evaluate(() => { MoonYaOffice.close(); void MoonYaModels.open(); });
        await page.locator('.custom-model-dialog').waitFor({ state: 'visible' });
        await page.screenshot({ path: join(artifacts, `models-${theme}.png`) });
        await page.locator('#cmClose').click();
    }
    await page.evaluate(() => MoonYaTheme.setPreference('dark'));
    await page.locator('#userInfoDiv').click();
    await page.locator('#accountMenu').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#accountMenu').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(30, 31, 35, 0.94)');
    await page.screenshot({ path: join(artifacts, 'account-menu-dark.png') });
    await page.keyboard.press('Escape');
    await page.evaluate(() => openSettingsModal('appearance'));
    await page.locator('[data-theme-choice="dark"]').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.getAttribute('html', 'data-theme-preference'), 'dark');
    assert.deepEqual(errors, []);
});

test('owned browser start page supports explicit and system themes without network requests', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ colorScheme: 'light', viewport: { width: 650, height: 820 } });
    const address = new URL('../../MoonYa-Win/MoonYa-Solution/MoonYa/Assets/browser_start.html', import.meta.url).href;
    const external = [], errors = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    const artifacts = fileURLToPath(new URL('../artifacts/theme/', import.meta.url)); await mkdir(artifacts, { recursive: true });
    for (const theme of ['dark', 'light']) {
        await page.goto(address + '#moonya-theme=' + theme);
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
        assert.equal(await page.getAttribute('html', 'data-theme'), theme);
        assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(30, 31, 35)' : 'rgb(255, 255, 255)');
        assert.equal(await page.locator('h1').evaluate(el => getComputedStyle(el).color), theme === 'dark' ? 'rgb(238, 238, 242)' : 'rgb(26, 26, 26)');
        await page.screenshot({ path: join(artifacts, `browser-start-${theme}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light', 'explicit application choice overrides the system');
    await page.goto(address);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
});
