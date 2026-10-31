import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('QQ registration and code login submit the verified challenge and QQ avatar falls back', async () => {
    const html = await readFile(new URL('../src/layouts/auth-modal.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../src/modules/script-1d-dom.js', import.meta.url), 'utf8');
    const tabSource = await readFile(new URL('../src/modules/script-1c-save.js', import.meta.url), 'utf8');
    const tabs = tabSource.slice(tabSource.indexOf('        const authTabs ='), tabSource.indexOf('        // 打开/关闭弹窗'));
    const css = await readFile(new URL('../src/styles/css-02-auth.css', import.meta.url), 'utf8');
    const binding = source.slice(source.indexOf('        function bindCodeAuthentication('), source.indexOf('        // 深度思考标签点击事件'));
    const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
    const avatar = client.slice(client.indexOf('    function userAvatar('), client.indexOf('    function remotePage('));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        const page = await browser.newPage();
        const requests = [];
        await page.route('**/*', async route => {
            const request = route.request();
            if (request.isNavigationRequest()) { await route.fulfill({ contentType: 'text/html', body: '<html></html>' }); return; }
            if (!request.url().includes('user_auth.php')) { await route.fulfill({ status: 404, body: '' }); return; }
            const body = request.postDataJSON(); requests.push({ url: request.url(), body });
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: request.url().includes('send_code') ? { challenge_id: 'test-challenge', retry_after: 0 } : { user: { username: body.qq } } }) });
        });
        await page.goto('http://moonya.test/');
        await page.setContent(html.replace('class="auth-overlay"', 'class="auth-overlay show"') + '<img id="testAvatar">');
        await page.addStyleTag({content: ':root{--theme-surface-rgb:255,255,255;--theme-primary:#242424;font-family:Arial}' + css});
        await page.addScriptTag({ content: `window.notifications=[];window.auth=[];function showToast(message){notifications.push(message)}function finishAuthentication(data,message,reset){auth.push(data);reset()}const registerUsername=document.getElementById('registerUsername'),registerBtn=document.getElementById('registerBtn');${tabs}${binding}${avatar}` });
        assert.equal(await page.locator('#register-form input').count(), 2);
        assert.equal(await page.locator('#registerPassword, #registerEmail').count(), 0);
        await page.locator('[data-tab=register]').click();
        await page.waitForFunction(() => !document.querySelector('.enter-from-left,.enter-from-right,.leave-to-left,.leave-to-right'));
        await page.locator('#registerUsername').fill('123456789');
        await page.locator('#registerSendCodeBtn').click();
        await page.waitForFunction(() => notifications.length === 1);
        await page.locator('#registerCode').fill('654321');
        await page.locator('#registerBtn').click();
        await page.waitForFunction(() => auth.length === 1);
        assert.deepEqual(requests[1].body, { qq: '123456789', code: '654321', challenge_id: 'test-challenge' });
        assert.ok(requests[1].url.endsWith('action=register'));
        await page.locator('[data-tab=code]').click();
        await page.waitForFunction(() => !document.querySelector('.enter-from-left,.enter-from-right,.leave-to-left,.leave-to-right'));
        await page.locator('#codeLoginQQ').fill('223456789');
        await page.locator('#loginSendCodeBtn').click();
        await page.waitForFunction(() => notifications.length === 2);
        await page.locator('#codeLoginCode').fill('123456');
        await page.locator('#codeLoginBtn').click();
        await page.waitForFunction(() => auth.length === 2);
        assert.ok(requests[3].url.endsWith('action=login_code'));
        assert.deepEqual(requests[3].body, { qq: '223456789', code: '123456', challenge_id: 'test-challenge' });
        await page.evaluate(() => setUserAvatar(document.getElementById('testAvatar'), { username: '123456789', avatar: 'uploads/old.png' }));
        await page.waitForFunction(() => document.getElementById('testAvatar').getAttribute('src') === '/image/user.png');
        assert.equal(await page.evaluate(() => userAvatar({ username: '123456789' })), 'https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100');
        const webLogin = await readFile(new URL('../../MoonYa-Backend/login.php', import.meta.url), 'utf8');
        await page.setContent(webLogin.replace(/^<\?php[\s\S]*?\?>/, ''));
        await page.locator('#codeLogin [name=qq]').fill('423456789');
        await page.locator('#sendCode').click();
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('已发送'));
        await page.locator('#codeLogin [name=code]').fill('123456');
        await page.locator('#codeSubmit').click();
        await page.waitForURL('**/user/user_xinxi.php');
        assert.ok(requests.at(-1).url.endsWith('action=login_code'));
        const settings = await readFile(new URL('../src/layouts/settings-modal.html', import.meta.url), 'utf8');
        await page.setContent(settings);
        assert.equal(await page.locator('#settingsChangeAvatarBtn').isVisible(), false);
        assert.equal(await page.locator('#settingsAvatarFileInput').isDisabled(), true);
    } finally { await browser.close(); }
});
