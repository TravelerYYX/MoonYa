/**
 * 主题编辑器页面：真实浏览器端到端回归。
 *
 * 为什么必须有这个测试：`theme-editor-base.test.mjs` 只能校验常量与静态接线，
 * 抓不到「输入框只更新了 DOM、没写回 state」这类 bug —— 曾经就因此出现
 * 「明明填了 slug，点保存却报『主题标识只能是…』」（collect() 读的是 state）。
 * 所以这里用真 Chrome 打字、点保存，断言实际发出的请求体。
 *
 * 服务端用 `php -S` 起真实站点目录（页面与静态资源都是真的），
 * 但所有 API 用 page.route 拦掉，所以不依赖数据库、不写任何真实数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const PHP = process.env.PHP_BIN || 'php';

async function freePort() {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

/** 后台列表行（adminRow 形状），字段与 BuiltinThemeService::adminRow() 对齐。 */
function adminRow(over = {}) {
    return Object.assign({
        id: 1,
        slug: 'ysmuou',
        name: '原神木偶',
        summary: '',
        sortOrder: 10,
        enabled: true,
        colors: {},
        blur: 0,
        shellOpacity: 0.85,
        backgroundKind: 'image',
        backgroundFill: 'cover',
        backgroundKey: '',
        thumbKey: '',
        assetVersion: 1,
        assetBytes: 0,
        updatedAt: ''
    }, over);
}

test('主题编辑器：填 slug 可保存、留空配色整键省略、上传发生在 save 之后', { timeout: 180000 }, async () => {
    let server;
    let browser;
    try {
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        server = spawn(PHP, ['-S', `127.0.0.1:${port}`, '-t', 'MoonYa-Backend'], { cwd: repo, windowsHide: true });
        let bootLog = '';
        server.stderr.on('data', chunk => bootLog += chunk);
        for (let attempt = 0; ; attempt++) {
            try {
                if ((await fetch(`${origin}/admin/theme_editor.php`)).ok) break;
            } catch { /* 还没起来 */ }
            if (attempt > 80) throw new Error(`php -S 未能启动：${bootLog}`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        browser = await chromium.launch({ channel: 'chrome', headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        // 页面级门禁读 localStorage.adminToken，缺了会跳 login.php
        await context.addInitScript(() => {
            try { localStorage.setItem('adminToken', 'fixture-token'); } catch (_) { /* 忽略 */ }
        });
        const page = await context.newPage();

        const failures = [];
        page.on('pageerror', error => failures.push(String(error)));

        const calls = [];
        let savedBody = null;
        await page.route('**/api/builtin_themes.php*', async route => {
            const action = new URL(route.request().url()).searchParams.get('action');
            calls.push(action);
            const json = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
            if (action === 'list') return json({ success: true, data: { themes: [adminRow()] } });
            if (action === 'save') {
                savedBody = route.request().postDataJSON();
                return json({ success: true, data: adminRow(savedBody) });
            }
            if (action === 'upload') {
                return json({ success: true, data: adminRow({ assetVersion: 2, backgroundKey: 'ysmuou/bg-deadbeef.png', assetBytes: 8 }) });
            }
            return json({ success: true, data: {} });
        });

        await page.goto(`${origin}/admin/theme_editor.php?id=new`);
        await page.waitForSelector('#teSlug');

        const previewVar = name => page.$eval('#tePreview', (el, key) => getComputedStyle(el).getPropertyValue(key).trim(), name);

        /* ── 预览基底由 JS 注入，且未填充项跟随基底 ─────────────── */
        assert.equal(await previewVar('--theme-shell'), '#f1eff4', '浅色基底未被注入预览');
        assert.equal(await previewVar('--theme-sidebar'), '#fbfafd');

        /* ── 真打字：名称 + slug ──────────────────────────────── */
        await page.fill('#teName', '原神木偶');
        await page.fill('#teSlug', 'ysmuou');

        /* ── 一键深色：11 项全填 + 预览切深色 ─────────────────── */
        await page.click('#teSchemeDark');
        assert.equal(await page.getAttribute('#tePreview', 'data-base'), 'dark');
        assert.equal(await page.locator('.te-color-row.customized').count(), 11, '一键深色应填满 11 项配色');
        assert.equal(await previewVar('--theme-shell'), '#18191d');

        // 已填充的项必须"钉死"：切回浅色基底也不跟着变（客户端就是这个语义）
        await page.click('[data-base-view="light"]');
        assert.equal(await page.getAttribute('#tePreview', 'data-base'), 'light');
        assert.equal(await previewVar('--theme-shell'), '#18191d', '已填充的配色不应跟随基底变化');

        /* ── 全部跟随基底 → 回落 ─────────────────────────────── */
        await page.click('#teSchemeClear');
        assert.equal(await page.locator('.te-color-row.customized').count(), 0);
        assert.equal(await previewVar('--theme-shell'), '#f1eff4');

        /* ── 只填一项：该项生效、其余仍跟随 ───────────────────── */
        await page.fill('.te-color-hex[data-hex="sidebar"]', '#0a0b0c');
        assert.equal(await previewVar('--theme-sidebar'), '#0a0b0c');
        assert.equal(await previewVar('--theme-text'), '#26272b', '未填充项应继续跟随基底');

        /* ── 滑条写入预览变量 ────────────────────────────────── */
        await page.$eval('#teBlur', el => {
            el.value = '24';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(await previewVar('--moonya-bg-blur'), '24px');

        /* ── 选待上传文件 → 保存 ─────────────────────────────── */
        await page.setInputFiles('#teFile', { name: 'bg.png', mimeType: 'image/png', buffer: Buffer.from('pngstub') });
        await page.click('#teSave');
        await page.waitForFunction(() => document.querySelector('#teAlert').classList.contains('show'), null, { timeout: 15000 });

        assert.equal(await page.locator('#teAlert.alert-error').count(), 0, `保存不应报错：${await page.locator('#teAlert').textContent()}`);
        assert.ok(savedBody, '点保存必须真的发出 save 请求');
        assert.equal(savedBody.slug, 'ysmuou', 'slug 必须来自输入框（不是被漏掉赋值导致的空串）');
        assert.equal(savedBody.name, '原神木偶');
        assert.equal(savedBody.blur, 24);
        assert.deepEqual(Object.keys(savedBody.colors), ['sidebar'], '未填充的配色必须整键省略（服务端遇空串会抛异常）');
        assert.equal(savedBody.colors.sidebar, '#0a0b0c');

        // 上传必须在 save 之后：attachAsset 需要已有 id
        assert.deepEqual(calls, ['list', 'save', 'upload']);
        assert.match(page.url(), /theme_editor\.php\?id=1$/);
        assert.deepEqual(failures, [], '页面不应有未捕获的脚本错误');
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
    }
});
