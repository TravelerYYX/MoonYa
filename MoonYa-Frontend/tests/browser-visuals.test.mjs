import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('browser visuals follow tab ownership, handoff, pointer positions and reset generations', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(await readFile(new URL('./fixtures/browser-panel.html', import.meta.url), 'utf8'));
    await page.evaluate(() => {
        window.visuals = [];
        window.moonYaBrowserPanel = {
            info: async () => JSON.stringify({ available: true }),
            state: async () => JSON.stringify({ is_start_page: true }),
            setVisuals: async json => window.visuals.push(JSON.parse(json)),
            setBounds: async () => {}, setVisible: async () => {}, action: async () => {}, navigate: async () => {},
        };
        window.CefSharp = { BindObjectAsync: async () => {} };
    });
    await page.addScriptTag({ content: await readFile(new URL('../src/ui-icons.js', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: await readFile(new URL('../src/modules/script-6-browser-panel.js', import.meta.url), 'utf8') });
    await page.waitForFunction(() => window.visuals.length > 0);
    const latest = () => page.evaluate(() => window.visuals.at(-1));
    await page.evaluate(() => moonyaOpenBrowserPanel());
    assert.equal((await latest()).enabled, false);
    await page.evaluate(() => moonyaOpenBrowserPanel({ source: 'automation' }));
    const ai = await latest(); assert.equal(ai.enabled, true);
    await page.evaluate(state => moonyaBrowserPointerState({ ...state, x: 0.23, y: 0.71 }), ai);
    await page.locator('#teamTabBrowser').click();
    assert.equal((await latest()).enabled, false, 'a new manual tab must have no effects');
    await page.locator(`[data-panel-tab="${ai.tab_id}"]`).click();
    assert.equal((await latest()).enabled, true);
    assert.equal((await latest()).x, 0.23);
    assert.equal((await latest()).y, 0.71);
    await page.evaluate(() => { moonyaSetBrowserHandoff({}); moonyaOpenBrowserPanel({ source: 'handoff' }); });
    assert.equal((await latest()).enabled, true);
    await page.evaluate(() => { moonyaSetBrowserHandoff(null); moonyaSetDetailPanelOpen(false); });
    await page.evaluate(() => moonyaOpenBrowserPanel());
    assert.equal((await latest()).enabled, true, 'collapse and a manual reopen preserve AI tab ownership');
    const beforeReset = await latest();
    await page.evaluate(() => moonyaResetBrowserVisuals(1));
    assert.equal((await latest()).enabled, false);
    assert.equal(await page.evaluate(() => moonyaOpenBrowserPanel({ source: 'automation', visual_generation: 0 })), false);
    assert.equal((await latest()).enabled, false, 'a queued old-generation reveal must not reactivate effects');
    await page.evaluate(old => moonyaBrowserPointerState({ ...old, x: 0.99, y: 0.99 }), beforeReset);
    await page.evaluate(() => moonyaOpenBrowserPanel({ source: 'automation' }));
    assert.equal((await latest()).x, 0.5, 'old-generation pointer updates must be discarded');
    await page.locator(`[data-panel-tab-close="${ai.tab_id}"]`).click();
    assert.equal((await latest()).enabled, false, 'closing an AI tab restores the remaining manual tab');
    assert.deepEqual(errors, []);
});
