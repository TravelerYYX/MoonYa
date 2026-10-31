/**
 * 「添加」菜单 → 选择项目：真实浏览器回归。
 *
 * 为什么必须有这个测试：这是典型的「静默失效」——页面与资源全部 200，
 * 控制台也不报错，只有真的点一下才会暴露。曾经的 bug 是：
 *   菜单项 click → setAddMenuOpen(false) → workProjectBtn.click() 展开下拉，
 *   但这一下点击的 target 不在 .work-project-selector 内，继续冒泡到 document，
 *   被全局「点到别处就收起项目下拉」的逻辑命中，刚展开的下拉立刻被收掉。
 * 用户看到的就是「点选择项目没反应」。静态断言抓不到这种时序竞态。
 *
 * 因此这里用真 Chrome 点击，断言 #workProjectDropdown 最终带 show 且真的可见。
 * 页面用 Node 静态服务 dist（与桌面壳 DesktopFrontendService 的职责一致），
 * 不需要 dotnet 或 php；所有 API 由 page.route 拦掉，不碰任何后端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json'
};

/** 宿主注入的运行时配置，形状对齐 DesktopFrontendService 的 /runtime-config.js。 */
const RUNTIME_CONFIG = 'window.MoonYaHost=' + JSON.stringify({
    backendUrl: 'http://127.0.0.1:1/', gatewayToken: 'fixture-gateway', mediaToken: 'fixture-media',
    mediaThumbnails: true, nativeVideo: false, nativeVideoExtensions: [],
    services: {
        launcher_api_url: 'http://127.0.0.1:1/gateway/native',
        execution_api_url: 'http://127.0.0.1:1/gateway/native',
        browser_api_url: 'http://127.0.0.1:1/gateway/native'
    }
}) + ';';

test('添加菜单的选择项目：Agent 新对话下真实点击可展开项目下拉，Chat 模式下该项隐藏', { timeout: 180000 }, async () => {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://placeholder');
        if (url.pathname === '/runtime-config.js') {
            res.setHeader('content-type', 'text/javascript; charset=utf-8');
            return res.end(RUNTIME_CONFIG);
        }
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        try {
            const body = await readFile(join(dist, decodeURIComponent(path)));
            res.setHeader('content-type', MIME[extname(path)] || 'application/octet-stream');
            res.end(body);
        } catch {
            res.statusCode = 404;
            res.end('not found');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
        const context = await browser.newContext({ userAgent: 'Mozilla/5.0 MoonYaDesktop/1.0', viewport: { width: 1400, height: 950 } });
        const page = await context.newPage();
        await page.route('**/*', route => {
            const target = route.request().url();
            if (!target.startsWith(origin)) return route.continue();
            if (/\.php|\.mjs|\/api\/|\/gateway\//.test(target)) {
                return route.fulfill({
                    status: 200, contentType: 'application/json',
                    body: JSON.stringify({ success: true, data: { logged_in: true, user: { id: 41, username: 'picker-fixture' } } })
                });
            }
            return route.continue();
        });

        await page.goto(origin + '/index.html');
        await page.waitForFunction(() => !!window.MoonYaWorkspace && !!window.MoonYaClient, null, { timeout: 30000 });
        await page.evaluate(async () => {
            localStorage.setItem('api_token', 'fixture-token');
            if (typeof renderAuthState === 'function') renderAuthState({ id: 41, username: 'picker-fixture' });
            await initializeChatHistory();
            isAgentMode = true;
            document.body.classList.add('work-mode');
        });

        // ── 1. Agent 模式 + 新对话：项目栏可见，菜单项可用 ──
        await page.waitForFunction(() => document.getElementById('workProjectBar')?.style.display === 'block');
        await page.locator('#fileCard').click();
        await page.waitForFunction(() => document.getElementById('addMenuSelector')?.classList.contains('open'));
        assert.equal(await page.locator('#addMenuProjectPicker').isVisible(), true, 'Agent 新对话下「选择项目」应可见');

        // 真实鼠标点击，走完整的事件冒泡链路（这正是 bug 的触发条件）
        await page.locator('#addMenuProjectPicker').click();
        await page.waitForFunction(() => document.getElementById('workProjectDropdown')?.classList.contains('show'));
        const opened = await page.evaluate(() => {
            const dd = document.getElementById('workProjectDropdown');
            const rect = dd.getBoundingClientRect();
            return { classes: dd.className, visible: dd.offsetParent !== null && rect.height > 0, options: dd.querySelectorAll('.work-project-option').length };
        });
        assert.match(opened.classes, /\bshow\b/, '点击后项目下拉必须保持展开，不能被全局收起逻辑吃掉');
        assert.equal(opened.visible, true, '项目下拉必须真的渲染出来，而不是只在 DOM 上加了 class');
        assert.equal(opened.options, 3, '下拉应包含三个项目操作项');
        assert.equal(await page.evaluate(() => document.getElementById('addMenuSelector').classList.contains('open')), false, '「添加」菜单应随之关闭');

        // ── 2. 收起行为仍然有效：点菜单外区域应关闭下拉 ──
        await page.evaluate(() => document.getElementById('workProjectDropdown').classList.remove('show'));
        await page.locator('#addMenuSelector').evaluate(el => el.classList.remove('open'));
        await page.locator('#fileCard').click();
        await page.waitForFunction(() => document.getElementById('addMenuSelector')?.classList.contains('open'));
        await page.locator('#addMenuProjectPicker').click();
        await page.waitForFunction(() => document.getElementById('workProjectDropdown')?.classList.contains('show'));
        await page.locator('.messages-container').click({ position: { x: 8, y: 8 } });
        await page.waitForFunction(() => !document.getElementById('workProjectDropdown')?.classList.contains('show'));

        // ── 3. Chat 模式：项目栏本就 display:none，菜单项必须同口径隐藏 ──
        await page.evaluate(() => {
            isAgentMode = false;
            document.body.classList.remove('work-mode');
            if (typeof updateWorkProjectBarVisibility === 'function') updateWorkProjectBarVisibility();
        });
        await page.waitForFunction(() => document.getElementById('workProjectBar')?.style.display === 'none');
        await page.locator('#fileCard').click();
        await page.waitForFunction(() => document.getElementById('addMenuSelector')?.classList.contains('open'));
        assert.equal(
            await page.locator('#addMenuProjectPicker').isVisible(), false,
            'Chat 模式下「选择项目」必须隐藏，否则点击只会去展开一个看不见的下拉'
        );
    } finally {
        await browser.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
});
