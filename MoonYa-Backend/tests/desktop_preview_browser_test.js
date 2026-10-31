'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('live chat preview renders frames and cursor, opens takeover window, and reconnects per session', { timeout: 30000 }, async () => {
    const server = http.createServer((req, res) => res.end('<!doctype html><div class="messages-container"></div>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate(() => {
            window.sockets = []; window.opened = [];
            window.CefSharp = { BindObjectAsync: async () => {} };
            window.moonYaDesktop = {
                preview: async id => JSON.stringify({ success: true, width: 1920, height: 1080, url: 'ws://fixture/' + id }),
                open: async id => window.opened.push(id),
            };
            window.WebSocket = class {
                constructor(url) { this.url = url; window.sockets.push(this); }
                close() { this.onclose?.(); }
            };
        });
        await page.addScriptTag({ path: path.join(__dirname, '../../MoonYa-Frontend/src/desktop-preview.js') });
        await page.evaluate(async () => {
            await moonyaDesktopPreview.show({ session_id: 'chat-1' });
            const socket = sockets[0];
            socket.onmessage({ data: JSON.stringify({ state: 'ai', x: 500, y: 500, action: 'click', timestamp: Date.now() }) });
            const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
            canvas.getContext('2d').fillRect(0, 0, 1920, 1080);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
            socket.onmessage({ data: blob });
        });
        await page.waitForFunction(() => document.querySelector('.moonya-desktop-preview img').naturalWidth === 1920);
        const pixel = await page.evaluate(() => Array.from(document.querySelector('.moonya-desktop-preview canvas').getContext('2d').getImageData(968, 550, 1, 1).data));
        assert.ok(pixel[2] > pixel[0], 'blue AI pointer must be drawn over the video');
        assert.equal(await page.locator('.messages-container .moonya-desktop-preview').count(), 1);
        await page.locator('.moonya-desktop-preview button').click();
        assert.deepEqual(await page.evaluate(() => opened), ['chat-1']);
        await page.evaluate(() => {
            window.bubbledPreviewClicks = 0;
            document.addEventListener('click', event => { if (event.target.closest('.moonya-desktop-preview')) window.bubbledPreviewClicks++; });
        });
        await page.locator('.moonya-desktop-preview img').click();
        assert.deepEqual(await page.evaluate(() => opened), ['chat-1', 'chat-1']);
        assert.equal(await page.evaluate(() => bubbledPreviewClicks), 0, 'preview clicks must not also open an image lightbox');
        await page.evaluate(() => { moonYaDesktop.open = async () => { throw new Error('screen session is unavailable'); }; });
        await page.locator('.moonya-desktop-preview button').click();
        await assert.match(await page.locator('.moonya-desktop-preview').textContent(), /screen session is unavailable/);
        await page.evaluate(() => sockets[0].onmessage({ data: JSON.stringify({ state: 'human', x: 500, y: 500 }) }));
        assert.match(await page.locator('.moonya-desktop-preview').textContent(), /用户正在接管/);
        assert.deepEqual(await page.evaluate(() => Array.from(document.querySelector('canvas').getContext('2d').getImageData(968, 550, 1, 1).data)), [0, 0, 0, 0]);
        await page.evaluate(async () => {
            sockets[0].onclose(); await moonyaDesktopPreview.show({ session_id: 'chat-1' });
        });
        assert.equal(await page.evaluate(() => sockets.length), 2, 'a later screen session must reconnect');
        await page.evaluate(() => moonyaDesktopPreview.disconnect('chat-1'));
    } finally {
        await browser.close(); await new Promise(resolve => server.close(resolve));
    }
});
