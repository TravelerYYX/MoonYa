import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../src/modules/script-1d-dom.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('        let messageInputComposing = false;'),
    source.indexOf('        // 输入框自动调整高度和字数限制'));
const shortcut = await readFile(new URL('../src/send-shortcut.js', import.meta.url), 'utf8');

test('composer shortcuts switch immediately, persist, preserve newlines and protect IME', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        await page.route('http://shortcut.test/**', route => route.fulfill({ contentType: 'text/html', body: `
            <meta charset="UTF-8"><textarea id="messageInput"></textarea><script>${shortcut}</script><script>
            const messageInput = document.getElementById('messageInput');
            const selectedSkills = [], uploadedImages = [], localPathSelections = [];
            let currentAbortController = null;
            window.sends = 0; window.stops = 0;
            const MoonYaAttachments = { canSend: message => !!message };
            function sendMessage() { window.sends++; }
            window.stopCurrentMoonYaResponse = () => window.stops++;
            ${handler}</script>` }));
        await page.goto('http://shortcut.test/');
        const input = page.locator('textarea');
        await input.fill('第一行');
        await input.press('Shift+Enter');
        assert.equal(await input.inputValue(), '第一行\n');
        await input.press('Enter');
        assert.equal(await page.evaluate(() => sends), 1);
        await page.evaluate(() => MoonYaSendShortcut.set('Ctrl + Enter 发送'));
        await input.fill('第二行');
        await input.press('Enter');
        assert.equal(await input.inputValue(), '第二行\n');
        assert.equal(await page.evaluate(() => sends), 1);
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => sends), 2);
        await page.reload();
        assert.equal(await page.evaluate(() => MoonYaSendShortcut.get()), 'Ctrl + Enter 发送');
        await input.fill('确认中文');
        await input.dispatchEvent('compositionstart');
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => sends), 0);
        await input.dispatchEvent('compositionend');
        await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229 });
        assert.equal(await page.evaluate(() => sends), 0);
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => sends), 1);
        await input.fill('');
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => sends), 1);
        await page.evaluate(() => { window.isSendingMessage = true; });
        await input.press('Enter');
        assert.equal(await page.evaluate(() => stops), 0);
        await input.press('Control+Enter');
        assert.equal(await page.evaluate(() => stops), 1);
        await page.evaluate(() => { window.isSendingMessage = false; MoonYaSendShortcut.set('Enter 发送'); });
        await input.fill('切回');
        await input.press('Enter');
        assert.equal(await page.evaluate(() => sends), 2);
    } finally { await browser.close(); }
});
