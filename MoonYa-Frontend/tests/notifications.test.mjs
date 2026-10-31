import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const script = await readFile(new URL('../src/notifications.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles/css-05-toast.css', import.meta.url), 'utf8');
const artifacts = fileURLToPath(new URL('../../artifacts/notifications/', import.meta.url));
async function fixture(t, options = {}) {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 900, height: 600 }, ...options });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.setContent(`<style>${css}</style><button id="focus">原控件</button><div id="toast" class="toast" popover="manual"></div>`);
    await page.addScriptTag({ content: script });
    return page;
}
const cards = page => page.locator('#toast .toast-card:not([hidden]):not(.toast-leaving)');

test('notifications have independent timers, a real three-card stack and live overflow promotion', async t => {
    const page = await fixture(t, { reducedMotion: 'reduce' });
    await page.evaluate(() => showToast('较早消息', 180));
    await page.waitForTimeout(60);
    await page.evaluate(() => showToast('较新消息', 900));
    await page.waitForTimeout(260);
    assert.equal(await cards(page).count(), 1);
    assert.equal(await cards(page).textContent(), '较新消息', 'An older timer must never dismiss a newer notice');
    await page.evaluate(() => {
        MoonYaNotifications.remove(document.querySelector('.toast-card:not(.toast-leaving)').dataset.notificationId);
        for (let n = 1; n <= 4; n++) MoonYaNotifications.show('消息' + n, { id: 'n' + n, duration: 0 });
    });
    assert.deepEqual(await cards(page).allTextContents(), ['消息4', '消息3', '消息2']);
    assert.equal(await page.locator('#toast .toast-card[hidden]').textContent(), '消息1');
    await page.evaluate(() => MoonYaNotifications.remove('n4'));
    assert.deepEqual(await cards(page).allTextContents(), ['消息3', '消息2', '消息1']);
    await page.evaluate(() => ['n1', 'n2', 'n3'].forEach(MoonYaNotifications.remove));
    await page.waitForFunction(() => !document.getElementById('toast').matches(':popover-open'));
    assert.equal(await page.locator('#toast').evaluate(el => el.classList.contains('show')), false);
});

test('persistent state updates reuse a card, safely render text and reset their own lifetime', async t => {
    const page = await fixture(t, { reducedMotion: 'reduce' });
    await page.evaluate(() => MoonYaNotifications.update('migration', '正在迁移…', { duration: 0 }));
    await page.waitForTimeout(200);
    await page.evaluate(() => MoonYaNotifications.update('migration', '正在迁移 50%…', { duration: 0 }));
    assert.equal(await cards(page).count(), 1);
    assert.equal(await cards(page).textContent(), '正在迁移 50%…');
    const message = '<img src=x onerror="window.injection=true"> & 中文\n路径';
    await page.evaluate(message => MoonYaNotifications.update('migration', message, { duration: 200 }), message);
    assert.equal(await cards(page).textContent(), message);
    assert.equal(await page.locator('#toast img').count(), 0);
    await page.waitForTimeout(360);
    assert.equal(await cards(page).count(), 0);
    await page.evaluate(() => { showToast('类型兼容', 'error'); });
    await page.waitForTimeout(200);
    assert.equal(await cards(page).textContent(), '类型兼容');
});

test('notifications stay above later dialogs and popovers without focus or pointer capture', async t => {
    const page = await fixture(t, { reducedMotion: 'reduce' });
    await page.locator('#focus').focus();
    await page.evaluate(() => MoonYaNotifications.show('置顶提示', { id: 'top', duration: 0 }));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'focus');
    await page.evaluate(() => {
        const dialog = document.createElement('dialog'); dialog.id = 'modal';
        dialog.style.cssText = 'position:fixed;inset:0;margin:0;width:100vw;height:100vh;max-width:none;max-height:none;padding:0;border:0;background:#ddd';
        dialog.innerHTML = '<button id="modalControl">弹窗按钮</button><div id="other" popover="manual" style="position:fixed;inset:0;margin:0;width:100vw;height:120px;background:purple"></div>';
        document.body.append(dialog); dialog.showModal();
    });
    await page.waitForFunction(() => document.getElementById('toast').parentElement.id === 'modal' && document.getElementById('toast').matches(':popover-open'));
    await page.evaluate(() => document.getElementById('other').showPopover());
    await page.waitForTimeout(70);
    const layer = await page.evaluate(() => {
        const root = document.getElementById('toast'); root.style.pointerEvents = 'auto';
        root.querySelector('.toast-card').style.pointerEvents = 'auto';
        const rect = root.querySelector('.toast-card').getBoundingClientRect();
        const result = root.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + 10));
        root.style.pointerEvents = ''; root.querySelector('.toast-card').style.pointerEvents = '';
        return result;
    });
    assert.equal(layer, true, 'The toast must be above a popover opened after it');
    assert.equal(await page.locator('.toast-announcer').evaluate(el => el.parentElement.id), 'modal');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'modalControl');
    await page.evaluate(() => { document.getElementById('other').hidePopover(); document.getElementById('modal').close(); });
    await page.waitForFunction(() => document.getElementById('toast').parentElement === document.body && document.getElementById('toast').matches(':popover-open'));
    assert.equal(await cards(page).textContent(), '置顶提示');
    const rect = await cards(page).boundingBox();
    assert.equal(await page.evaluate(({ x, y }) => document.getElementById('toast').contains(document.elementFromPoint(x, y)), { x: rect.x + rect.width / 2, y: rect.y + 10 }), false);
    await page.evaluate(() => {
        const dialog = document.createElement('dialog'); dialog.id = 'removedModal'; document.body.append(dialog); dialog.showModal();
    });
    await page.waitForFunction(() => document.getElementById('toast').parentElement.id === 'removedModal');
    await page.evaluate(() => document.getElementById('removedModal').remove());
    await page.waitForFunction(() => document.getElementById('toast')?.parentElement === document.body);
});

test('stack geometry, long text, corner deformation and reduced motion match the design', async t => {
    await mkdir(artifacts, { recursive: true });
    const page = await fixture(t);
    await page.evaluate(() => MoonYaNotifications.show('已关闭自动朗读', { id: 'visual', duration: 0 }));
    const background = page.locator('[data-notification-id="visual"] path');
    const initial = await background.getAttribute('d');
    await page.waitForTimeout(80);
    const during = await background.getAttribute('d');
    assert.notEqual(during, initial, 'The background contour should deform during entry');
    assert.equal(await page.locator('.toast-text').evaluate(el => getComputedStyle(el).transform), 'none');
    await page.screenshot({ path: artifacts + 'entry.png' });
    await page.waitForTimeout(600);
    const rect = await cards(page).boundingBox();
    assert.ok(Math.abs(rect.y - 24) < .1);
    assert.ok(Math.abs(rect.x + rect.width / 2 - 450) < .1);
    await page.screenshot({ path: artifacts + 'single.png' });
    await page.evaluate(() => {
        MoonYaNotifications.show('设置已保存', { duration: 0 });
        MoonYaNotifications.show('刷新成功', { duration: 0 });
    });
    await page.waitForTimeout(600);
    const boxes = await cards(page).evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { y: r.y, width: r.width };
    }));
    assert.deepEqual(boxes.map(box => box.y), [24, 36, 48]);
    assert.ok(boxes[0].width > boxes[1].width && boxes[1].width > boxes[2].width);
    await page.screenshot({ path: artifacts + 'stack.png' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 180, height: 300 });
    await page.evaluate(() => showToast('很长的完整提示\nD:\\很长的目录\\' + '路径'.repeat(22), 5000));
    await page.waitForTimeout(160);
    const narrow = await cards(page).first().boundingBox();
    assert.ok(narrow.x >= 16 && narrow.x + narrow.width <= 164);
    assert.ok(narrow.height > 56);
    assert.equal(await page.locator('.toast-text').first().evaluate(el => getComputedStyle(el).transform), 'none');
    const steady = await page.locator('.toast-card:not([hidden]) path').first().getAttribute('d');
    await page.waitForTimeout(90);
    assert.equal(await page.locator('.toast-card:not([hidden]) path').first().getAttribute('d'), steady);
    await page.screenshot({ path: artifacts + 'narrow.png' });
});

test('bootstrap initializes notifications before client requests and remaining alerts are migrated', async () => {
    const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
    assert.ok(html.indexOf('/notifications.js') < html.indexOf('/client.js'));
    for (const name of ['script-1b-features.js', 'script-1c-save.js', 'script-1e-rest.js']) {
        assert.doesNotMatch(await readFile(new URL('../src/modules/' + name, import.meta.url), 'utf8'), /\balert\(/);
    }
});

test('head-start notifications queue until the body exists without duplicate containers', async t => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><style>${css}</style><script>${script}</script><script>showToast('启动早期通知', 5000);</script></head><body><div id="toast" class="toast" popover="manual"></div></body></html>`);
    await page.waitForFunction(() => document.getElementById('toast').matches(':popover-open'));
    assert.equal(await page.locator('#toast').count(), 1);
    assert.equal(await cards(page).textContent(), '启动早期通知');
    assert.deepEqual(errors, []);
});

test('connection transitions and migration progress use keyed notices while retry controls remain usable', async t => {
    const page = await fixture(t, { reducedMotion: 'reduce' });
    let online = false;
    await page.route('http://moonya.test/**', route => {
        if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="toast" class="toast" popover="manual"></div>` });
        return route.fulfill({ status: online ? 200 : 503, contentType: 'application/json', body: '{}' });
    });
    await page.goto('http://moonya.test/');
    await page.addScriptTag({ content: script });
    const defaults = JSON.parse(await readFile(new URL('../src/defaults.json', import.meta.url), 'utf8'));
    await page.evaluate(defaults => { window.MoonYaDefaults = defaults; }, defaults);
    await page.addScriptTag({ content: await readFile(new URL('../src/client.js', import.meta.url), 'utf8') });
    await page.evaluate(() => fetch('/api/client_config.php').catch(error => error.message));
    assert.equal(await page.locator('[data-notification-id="backend-connection"]').count(), 1);
    await page.evaluate(() => fetch('/api/client_config.php').catch(error => error.message));
    assert.equal(await cards(page).count(), 1, 'Repeated connection failures reuse the same persistent state');
    assert.equal(await page.locator('#backendConnectionStatus').count(), 0);
    online = true;
    await page.evaluate(() => fetch('/api/client_config.php'));
    await page.waitForFunction(() => !document.querySelector('[data-notification-id="backend-connection"]'));
    await page.addScriptTag({ content: await readFile(new URL('../src/migration-import.js', import.meta.url), 'utf8') });
    await page.evaluate(() => { MoonYaMigration.showProgress('正在迁移 1/3'); MoonYaMigration.showProgress('正在迁移 2/3'); });
    assert.equal(await cards(page).count(), 1);
    assert.equal(await cards(page).textContent(), '正在迁移 2/3');
    assert.equal(await page.locator('#migrationProgress').count(), 0);
    await page.evaluate(() => MoonYaMigration.showFailure('本地历史迁移未完成'));
    assert.equal(await page.locator('#migrationRetry').textContent(), '本地历史迁移未完成，点击重试');
    await page.waitForFunction(() => !document.querySelector('[data-notification-id="migration-progress"]'));
    await page.evaluate(() => MoonYaMigration.showProgress('继续迁移…'));
    assert.equal(await page.locator('#migrationRetry').count(), 0);
    assert.equal(await cards(page).textContent(), '继续迁移…');
});
