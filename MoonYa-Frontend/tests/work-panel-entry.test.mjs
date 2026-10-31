/**
 * 顶栏「加号」入口：真实浏览器回归。
 *
 * 为什么必须有这个测试：这个按钮原来绑的是「新建对话」，现在改成「弹出工作面板」，
 * 而它身上还挂着两处隐性依赖（script-1d-dom 的 window.moonyaNewChat 兜底、
 * script-1e 的 resetTeamPanel）。静态断言看不出来谁被改坏了，只有真点一下才知道：
 *   · 点加号必须真的把 #detailPanel 打开（不是只加了个 class 却没布局出来）
 *   · 点加号绝不能顺手新建会话（否则「弹出面板」会变成「清空对话」）
 *   · 新建对话必须还能从「更多」菜单走到，不然能力就丢了
 *   · 旁边的滑块按钮仍应是开关语义（点第二次要收起）
 *
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

const RUNTIME_CONFIG = 'window.MoonYaHost=' + JSON.stringify({
    backendUrl: 'http://127.0.0.1:1/', gatewayToken: 'fixture-gateway', mediaToken: 'fixture-media',
    mediaThumbnails: true, nativeVideo: false, nativeVideoExtensions: [],
    services: {
        launcher_api_url: 'http://127.0.0.1:1/gateway/native',
        execution_api_url: 'http://127.0.0.1:1/gateway/native',
        browser_api_url: 'http://127.0.0.1:1/gateway/native'
    }
}) + ';';

function panelState(page) {
    return page.evaluate(() => {
        const panel = document.getElementById('detailPanel');
        const rect = panel.getBoundingClientRect();
        return {
            open: panel.classList.contains('open'),
            ariaHidden: panel.getAttribute('aria-hidden'),
            laidOut: rect.width > 0 && rect.height > 0 && panel.offsetParent !== null,
            title: document.getElementById('conversationTitle').textContent
        };
    });
}

test('顶栏加号弹出工作面板，「新建对话」从「更多」菜单仍可达', { timeout: 180000 }, async () => {
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
                    body: JSON.stringify({ success: true, data: { logged_in: true, user: { id: 41, username: 'panel-fixture' } } })
                });
            }
            return route.continue();
        });

        await page.goto(origin + '/index.html');
        await page.waitForFunction(() => !!window.MoonYaWorkspace && !!window.MoonYaClient, null, { timeout: 30000 });
        await page.evaluate(async () => {
            localStorage.setItem('api_token', 'fixture-token');
            if (typeof renderAuthState === 'function') renderAuthState({ id: 41, username: 'panel-fixture' });
            await initializeChatHistory();
            window.moonyaSetDetailPanelOpen(false);
        });

        // ── 1. 加号的身份与可用性 ──
        assert.equal(await page.locator('#newChatTopBtn').isVisible(), true, '顶栏加号必须可见');
        assert.equal(await page.locator('#newChatTopBtn').getAttribute('data-tooltip'), '工作面板', '加号语义已改为工作面板');
        assert.equal((await panelState(page)).open, false, '初始状态面板应关闭');

        // ── 2. 真实点击：面板必须真的打开，且不吃掉会话 ──
        const before = await panelState(page);
        await page.locator('#newChatTopBtn').click();
        await page.waitForFunction(() => document.getElementById('detailPanel').classList.contains('open'));
        const opened = await panelState(page);
        assert.equal(opened.ariaHidden, 'false', '打开后 aria-hidden 必须为 false');
        assert.equal(opened.laidOut, true, '面板必须真的布局出来，而不是只在 DOM 上加了 class');
        assert.equal(opened.title, before.title, '点加号不得新建会话（会话标题不应变化）');

        // ── 3. 加号是「弹出」而不是开关：已打开时再点仍保持打开 ──
        await page.locator('#newChatTopBtn').click();
        const again = await panelState(page);
        assert.equal(again.open, true, '加号只负责弹出，已打开时不应把它收起来');

        // ── 4. 滑块按钮仍是开关语义（回归护栏）──
        await page.locator('#workPanelToggle').click();
        await page.waitForFunction(() => !document.getElementById('detailPanel').classList.contains('open'));
        await page.locator('#workPanelToggle').click();
        await page.waitForFunction(() => document.getElementById('detailPanel').classList.contains('open'));

        // ── 5. 加号不再是「新建会话」：不得顺手把工作面板日志清掉 ──
        // script-1e 原先给「新会话开始」挂过 resetTeamPanel。加号改语义后若那处绑定没跟着迁移，
        // 点加号就会静默清空工作面板——页面全 200、控制台不报错，只有这条断言能抓到。
        await page.evaluate(() => {
            const content = document.getElementById('detailPanelContent');
            const marker = document.createElement('div');
            marker.id = 'fixturePanelMarker';
            marker.textContent = '夹具产出';
            content.appendChild(marker);
            window.moonyaSetDetailPanelOpen(false);
        });
        await page.locator('#newChatTopBtn').click();
        await page.waitForFunction(() => document.getElementById('detailPanel').classList.contains('open'));
        assert.equal(
            await page.evaluate(() => !!document.getElementById('fixturePanelMarker').isConnected),
            true,
            '点加号不得清空工作面板（resetTeamPanel 必须只挂在「新建对话」上）'
        );

        // ── 6. 新建对话没有丢：落在「更多」菜单里 ──
        await page.evaluate(() => window.moonyaSetDetailPanelOpen(false));
        await page.locator('#conversationMoreBtn').click();
        assert.equal(await page.locator('#moreMenuNewChat').isVisible(), true, '「更多」菜单里必须有新建对话');
        assert.equal(
            await page.locator('#moreMenuNewChat .ui-icon').getAttribute('data-ui-icon'),
            'new-chat',
            '菜单项必须带 ui-icon 图标（hydrate 会注入）'
        );
        await page.locator('#moreMenuNewChat').click();
        await page.waitForFunction(() => document.getElementById('conversationMoreMenu').hidden);
        assert.equal((await panelState(page)).open, false, '「新建对话」不得顺手打开工作面板');

        // 桌面端原生标题栏走的是 window.moonyaNewChat()，它原先会兜底点到加号上——
        // 加号改语义后必须仍然命中侧栏按钮，否则标题栏上的「新建对话」会变成弹出面板。
        assert.equal(await page.evaluate(() => window.moonyaNewChat()), true, '桌面标题栏的新建对话必须仍有可点入口');
        assert.equal((await panelState(page)).open, false, 'moonyaNewChat 的兜底不得落到加号上');
    } finally {
        await browser.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
});
