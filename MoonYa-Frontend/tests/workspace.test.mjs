import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url), { chromium } = require('playwright-core');
const root = fileURLToPath(new URL('../../', import.meta.url));

test('application shell matches reference layout, keeps modes coherent and preserves user emoji', async () => {
    const f = await fixture();
    const artifacts = join(root, 'artifacts/ui-redesign');
    await mkdir(artifacts, { recursive: true });
    try {
        await f.page.waitForFunction(() => !!window.MoonYaShell);
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await f.page.locator('#modeMenuLabel').textContent(), 'FarSide');
        assert.equal(await f.page.locator('#officeView').isVisible(), false);
        assert.equal(await f.page.locator('#newChatTopBtn').isVisible(), true);
        await f.page.locator('#conversationMoreBtn').click();
        assert.equal(await f.page.locator('#voiceToggleContainer').isVisible(), true);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#conversationMoreMenu').isVisible(), false);
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'conversationMoreBtn');
        const ids = await f.page.evaluate(async () => {
            const project = (await MoonYaHistoryStore.projectRequest(CHAT_HISTORY_KEY, 'create', { name: 'MoonYa', path: 'D:\\Fixture\\MoonYa' })).data;
            await MoonYaWorkspace.render();
            return project.id;
        });
        await f.page.locator('.workspace-project[data-id="' + ids + '"] .workspace-row-label').click();
        await f.page.locator('#sidebarNewChatBtn').click();
        await f.page.waitForFunction(() => document.querySelector('.main-title').textContent === '你想让我们在 MoonYa 中构建什么？');
        for (const [width, height] of [[1277, 818], [1440, 820], [900, 600], [460, 680]]) {
            await f.page.setViewportSize({ width, height });
            await f.page.waitForFunction(() => !moonyaSplitLayout.isSidebarCollapsed() || document.getElementById('sidebar').getBoundingClientRect().width === 0);
            await f.page.screenshot({ path: join(artifacts, `harness-${width}x${height}.png`) });
            const geometry = await f.page.evaluate(() => {
                const input = document.querySelector('.input-container-wrapper').getBoundingClientRect();
                const send = document.getElementById('sendBtn').getBoundingClientRect();
                return { rail: document.querySelector('.app-rail').getBoundingClientRect().width, x: input.x, right: input.right, bottom: input.bottom, sendRight: send.right, overflow: document.documentElement.scrollWidth > innerWidth };
            });
            assert.equal(geometry.rail, 50);
            assert.ok(geometry.x >= 50 && geometry.right <= width && geometry.bottom <= height);
            assert.ok(geometry.sendRight <= width);
            assert.equal(geometry.overflow, false);
        }
        await f.page.evaluate(() => { if (moonyaSplitLayout.isSidebarCollapsed()) moonyaSplitLayout.toggleSidebar(); });
        await f.page.locator('#modeMenuTrigger').click();
        await f.page.keyboard.press('ArrowDown');
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'modeChatTab');
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#modeMenu').isVisible(), false);
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'modeMenuTrigger');
        await f.page.setViewportSize({ width: 1277, height: 818 });
        await f.page.locator('#modeMenuTrigger').click();
        await f.page.screenshot({ path: join(artifacts, 'mode-menu.png') });
        await f.page.locator('#modeChatTab').click();
        await f.page.waitForFunction(() => document.getElementById('modeMenuLabel').textContent === 'MoonYa');
        assert.equal(await f.page.locator('.main-title').textContent(), '今天想聊些什么？');
        assert.equal(await f.page.locator('#workProjectBar').isVisible(), false);
        await f.page.locator('#fileCard').click();
        assert.equal(await f.page.locator('#weatherBtn').isVisible(), true);
        assert.equal(await f.page.locator('#programmingBtn').isVisible(), true);
        await f.page.screenshot({ path: join(artifacts, 'chat-add-menu.png') });
        await f.page.locator('#programmingBtn').click();
        assert.equal(await f.page.locator('#programmingBtn').getAttribute('class').then(c => c.includes('active')), true);
        assert.equal(await f.page.locator('#addMenuSelector').getAttribute('class').then(c => c.includes('open')), false);
        await f.page.locator('#settingsBtn').click();
        await f.page.screenshot({ path: join(artifacts, 'settings.png') });
        await f.page.locator('#settingsCloseBtn').click();
        await f.page.evaluate(() => openAuthModal());
        assert.equal(await f.page.locator('#authModalBox').isVisible(), true);
        assert.equal(await f.page.locator('#authModalBox').evaluate(el => getComputedStyle(el).opacity), '1');
        await f.page.screenshot({ path: join(artifacts, 'login.png') });
        await f.page.locator('#authCloseBtn').click();
        await f.page.evaluate(async () => {
            const content = '保留用户内容 😀';
            await MoonYaHistoryStore.save(CHAT_HISTORY_KEY, [...getChatHistory(), { id: 'shell-emoji', mode: 'chat', storage: 'local', title: '用户标题 😀', messagesLoaded: true, messages: [{ type: 'user', content }, { type: 'ai', content: '保留 AI 回复 😀' }] }]);
            await loadChat('shell-emoji');
        });
        await f.page.waitForFunction(() => document.querySelector('.main-header').hidden);
        await f.page.waitForFunction(() => document.getElementById('conversationTitle').textContent === '用户标题 😀');
        assert.ok((await f.page.locator('.messages-container[data-runtime-active="1"]').textContent()).includes('😀'));
        assert.equal(await f.page.locator('#modeMenuLabel').textContent(), 'MoonYa');
        await f.page.locator('#recentChatBtn').click();
        await f.page.locator('#recentChatBtn').click();
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.locator('#workspaceSearch').fill('用户标题');
        await f.page.locator('.workspace-search-item[data-kind="chat"]').waitFor();
        assert.match(await f.page.locator('#workspaceSearchResults').textContent(), /用户标题/);
        await f.page.keyboard.press('Escape');
        await f.page.screenshot({ path: join(artifacts, 'messages.png') });
        // 新建对话已从顶栏加号迁到「更多」菜单
        await f.page.locator('#conversationMoreBtn').click();
        await f.page.locator('#moreMenuNewChat').click();
        await f.page.waitForFunction(() => document.getElementById('conversationTitle').textContent === '新对话' || document.getElementById('conversationTitle').textContent === '新聊天');
        await f.page.evaluate(() => switchMoonYaConversationMode('work'));
        await f.page.waitForFunction(() => document.getElementById('modeMenuLabel').textContent === 'FarSide');
        await f.page.locator('#fileCard').click();
        assert.equal(await f.page.locator('.chat-menu-section').isVisible(), false);
        await f.page.locator('#fileCard').click();
        await f.page.locator('#officeBtn').click();
        assert.equal(await f.page.locator('#officeView').isVisible(), true);
        await f.page.screenshot({ path: join(artifacts, 'office.png') });
        await f.page.locator('#conversationBtn').click();
        await f.page.locator('#workPanelToggle').click();
        await f.page.evaluate(() => document.getElementById('teamTabLog').click());
        assert.equal(await f.page.locator('#detailPanel').isVisible(), true);
        assert.equal(await f.page.locator('#detailPanel').getAttribute('aria-hidden'), 'false');
        await f.page.screenshot({ path: join(artifacts, 'work-panel.png') });
        // 顶栏加号只负责「弹出」工作面板：收起后点它应重新打开，且不得新建会话
        await f.page.evaluate(() => window.moonyaSetDetailPanelOpen(false));
        assert.equal(await f.page.locator('#detailPanel').getAttribute('aria-hidden'), 'true');
        const titleBefore = await f.page.locator('#conversationTitle').textContent();
        await f.page.locator('#newChatTopBtn').click();
        assert.equal(await f.page.locator('#detailPanel').getAttribute('aria-hidden'), 'false');
        assert.equal(await f.page.locator('#conversationTitle').textContent(), titleBefore);
        await f.page.evaluate(() => window.moonyaSetDetailPanelOpen(false));
        const ownText = await f.page.locator('.app-rail, .sidebar-header, #settingsModal, .user-action-heading').allTextContents();
        assert.equal(/[\p{Extended_Pictographic}]/u.test(ownText.join('')), false);
        assert.ok(!(await f.page.evaluate(() => buildHoroscopeCardHtml())).match(/[\p{Extended_Pictographic}]/u));
        await f.page.goto(f.host.url + '?office_popout=1&office_session=popout-fixture');
        await f.page.waitForFunction(() => window.MoonYaOffice?.isOpen());
        assert.equal(await f.page.locator('#officeView').isVisible(), true);
        assert.equal(await f.page.locator('.app-rail').isVisible(), false);
        assert.equal(await f.page.locator('.input-container-wrapper').isVisible(), false);
        await f.page.screenshot({ path: join(artifacts, 'office-popout.png') });
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('browser rail opens the existing native browser panel and keeps conversation navigation coherent', async () => {
    const f = await fixture({ browserBridge: true });
    try {
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        await f.page.waitForFunction(() => !document.getElementById('railBrowserBtn').disabled);
        await f.page.locator('#railBrowserBtn').click();
        await f.page.waitForFunction(() => document.getElementById('railBrowserBtn').getAttribute('aria-current') === 'page');
        assert.equal(await f.page.locator('#detailPanel').getAttribute('aria-hidden'), 'false');
        assert.equal(await f.page.locator('#teamPaneBrowser').isVisible(), true);
        const artifacts = join(root, 'artifacts/ui-redesign');
        await mkdir(artifacts, { recursive: true });
        await f.page.screenshot({ path: join(artifacts, 'browser-panel.png') });
        await f.page.locator('#conversationBtn').click();
        await f.page.waitForFunction(() => document.getElementById('conversationBtn').getAttribute('aria-current') === 'page');
        assert.equal(await f.page.locator('#detailPanel').getAttribute('aria-hidden'), 'true');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('top notifications cover settings and search and suspend only overlapping native browser content', async () => {
    const f = await fixture({ browserBridge: true });
    const artifacts = join(root, 'artifacts/notifications'); await mkdir(artifacts, { recursive: true });
    try {
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        await f.page.locator('#settingsBtn').click();
        await f.page.evaluate(() => {
            MoonYaNotifications.show('刷新成功', { id: 'app-one', duration: 0 });
            MoonYaNotifications.show('设置已保存', { id: 'app-two', duration: 0 });
            MoonYaNotifications.show('已关闭自动朗读', { id: 'app-three', duration: 0 });
        });
        await f.page.waitForTimeout(150);
        await f.page.screenshot({ path: join(artifacts, 'app-settings.png') });
        assert.ok(await f.page.locator('#toast').evaluate(el => el.matches(':popover-open')));
        const card = await f.page.locator('[data-notification-id="app-three"]').boundingBox();
        assert.equal(card.y, 24); assert.ok(Math.abs(card.x + card.width / 2 - 700) < 1);
        await f.page.locator('#settingsCloseBtn').click();
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.waitForFunction(() => document.getElementById('toast').closest('dialog:modal'));
        assert.equal(await f.page.evaluate(() => document.activeElement.id === 'toast'), false);
        await f.page.screenshot({ path: join(artifacts, 'app-search.png') });
        await f.page.keyboard.press('Escape');
        await f.page.waitForFunction(() => !document.querySelector('dialog:modal'));
        await f.page.evaluate(() => ['app-one', 'app-two', 'app-three'].forEach(MoonYaNotifications.remove));
        await f.page.waitForTimeout(150);
        await f.page.waitForFunction(() => !document.getElementById('railBrowserBtn').disabled);
        await f.page.locator('#railBrowserBtn').click();
        await f.page.waitForFunction(() => browserCalls.some(call => call[0] === 'bounds' && call[1].visible));
        await f.page.evaluate(() => { browserCalls.length = 0; MoonYaNotifications.show('顶部短提示', { id: 'browser-short', duration: 0 }); });
        await f.page.waitForTimeout(180);
        const overlap = await f.page.evaluate(() => MoonYaNotifications.overlaps(document.getElementById('teamBrowserViewport').getBoundingClientRect()));
        assert.equal(overlap, false, 'A short top toast must leave the native browser visible');
        assert.equal(await f.page.evaluate(() => browserCalls.some(call => call[0] === 'visible' && call[1] === false)), false);
        await f.page.locator('#teamBrowserExpand').click();
        await f.page.evaluate(() => MoonYaNotifications.update('browser-short', '很长的顶部通知\n'.repeat(8), { duration: 0 }));
        await f.page.waitForFunction(() => browserCalls.some(call => call[0] === 'visible' && call[1] === false));
        await f.page.screenshot({ path: join(artifacts, 'app-browser.png') });
        await f.page.evaluate(() => { browserCalls.length = 0; MoonYaNotifications.remove('browser-short'); });
        await f.page.waitForFunction(() => browserCalls.some(call => call[0] === 'bounds' && call[1].visible));
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('project and application hints use the shared dark tooltip and retain complete project paths', async () => {
    const f = await fixture({ browserBridge: true });
    try {
        const name = '动画 <项目> & 中文', path = 'D:\\Fixture\\' + '很长的完整目录\\'.repeat(12);
        const id = await f.page.evaluate(async ({ name, path }) => {
            const project = await MoonYaWorkspace.request('project_create', { name, path });
            await MoonYaWorkspace.render(); return project.id;
        }, { name, path });
        const row = f.page.locator('.workspace-project[data-id="' + id + '"]');
        const tip = f.page.locator('#moonyaTooltip');
        await row.locator('.workspace-row-label').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), name + '\n' + path);
        assert.equal(await row.getAttribute('title'), null);
        const artifacts = join(root, 'artifacts/tooltips'); await mkdir(artifacts, { recursive: true });
        await f.page.screenshot({ path: join(artifacts, 'project-tooltip.png') });
        await f.page.locator('#sidebarSearchBtn').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '搜索项目和会话');
        await f.page.locator('#settingsBtn').click(); await tip.waitFor({ state: 'hidden' });
        await f.page.locator('#settingsAvatarWrap').hover(); await tip.waitFor({ state: 'visible' });
        assert.equal(await tip.textContent(), '点击查看或修改资料');
        assert.equal(await f.page.locator('[title]:not(iframe)').count(), 0, 'No application controls keep browser-native title hints');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('search palette matches reference geometry, follows hover, opens chats and searches current-project files', async () => {
    const f = await fixture();
    const artifacts = join(root, 'artifacts/search-dialog'); await mkdir(artifacts, { recursive: true });
    try {
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        await f.page.evaluate(async () => {
            const project = await MoonYaWorkspace.request('project_create', { name: 'MoonYa', path: 'D:\\Fixture\\MoonYa' });
            const titles = ['完善头像菜单及桌宠入口', '调整悬停时UI视觉', '调整字体样式以匹配图片1', '调整项目 UI 仿照图片', '按图片1改造左侧栏办公室图标', '统一鼠标悬停提示样式', '调整项目目录 SVG 样式', '将新聊天左侧 SVG 改为图片1样式', '将 MoonYa UI 改为参考样式'];
            await MoonYaHistoryStore.save(CHAT_HISTORY_KEY, titles.map((title, i) => ({ id: 'search-' + i, title, mode: 'work', storage: 'local',
                projectId: project.id, workingDirectory: project.path, projectName: project.name, messagesLoaded: true, messages: [],
                lastActivityAt: new Date(Date.UTC(2026, 8, 30, 12, 0, 9 - i)).toISOString() })));
            await loadChat('search-0'); await MoonYaWorkspace.render();
        });
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.setViewportSize({ width: 611, height: 529 });
        await f.page.waitForFunction(() => document.querySelectorAll('#workspaceSearchResults [data-kind="chat"]').length === 9);
        const palette = f.page.locator('#workspaceSearchDialog');
        const geometry = await palette.boundingBox();
        assert.equal(geometry.width, 520); assert.ok(Math.abs(geometry.height - 487) <= 2);
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'workspaceSearch');
        assert.equal(await palette.evaluate(el => getComputedStyle(el).borderRadius), '20px');
        await f.page.screenshot({ path: join(artifacts, 'reference.png') });
        const rows = palette.locator('.workspace-search-item');
        for (const index of [1, 5, 9, 10, 11]) {
            await rows.nth(index).hover();
            await f.page.waitForFunction(index => getComputedStyle(document.querySelectorAll('#workspaceSearchDialog .workspace-search-item')[index]).backgroundColor === 'rgb(244, 244, 246)', index);
            const colors = await rows.evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor));
            assert.equal(colors[index], 'rgb(244, 244, 246)');
            assert.equal(colors.filter(color => color === 'rgb(244, 244, 246)').length, 1);
        }
        await f.page.screenshot({ path: join(artifacts, 'hover-action.png') });
        await f.page.setViewportSize({ width: 1400, height: 950 });
        await f.page.locator('#workspaceSearch').fill('悬停');
        await f.page.waitForFunction(() => document.querySelectorAll('#workspaceSearchResults [data-kind="chat"]').length === 2);
        await f.page.keyboard.press('Alt+2');
        await f.page.waitForFunction(() => !document.getElementById('workspaceSearchDialog').open && currentChatId === 'search-5');
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.keyboard.press('Control+p');
        await f.page.locator('#workspaceSearch').fill('SRC\\SEARCH');
        await f.page.waitForFunction(() => document.querySelectorAll('#workspaceSearchResults [data-kind="file"]').length === 1);
        assert.match(await f.page.locator('#workspaceSearchResults').textContent(), /search-dialog.js/);
        assert.ok(f.nativeRequests.some(req => req.action === 'search_files' && req.path === 'D:\\Fixture\\MoonYa' && req.query === 'src/search'));
        await Promise.all([f.page.waitForResponse(response => response.url().endsWith('/gateway/native/file-op')),
            f.page.locator('[data-kind="file"]').click()]);
        await f.page.waitForFunction(() => !document.getElementById('workspaceSearchDialog').open);
        assert.ok(f.nativeRequests.some(req => req.action === 'open_file' && req.path.endsWith('search-dialog.js')));
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.mouse.click(5, 5);
        assert.equal(await palette.isVisible(), false);
        assert.equal(await f.page.locator('#sidebarSearchBtn').getAttribute('aria-expanded'), 'false');
        await f.page.setViewportSize({ width: 360, height: 480 });
        await f.page.evaluate(() => MoonYaSearch.open());
        const small = await palette.boundingBox(); assert.ok(small.x >= 16 && small.x + small.width <= 344 && small.height <= 448);
        await f.page.screenshot({ path: join(artifacts, 'small-screen.png') });
        await f.page.keyboard.press('Escape');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('plugin page manages composer entries, preserves drafts/panels and remembers choices offline', async () => {
    const f = await fixture({ browserBridge: true });
    const artifacts = join(root, 'artifacts/plugins'); await mkdir(artifacts, { recursive: true });
    try {
        await f.page.waitForFunction(() => !!window.MoonYaShell);
        await f.page.evaluate(() => document.querySelector('[data-skill-name="browser-use-automation"]').click());
        await f.page.locator('.message-input').fill('插件页面切换后保留草稿');
        await f.page.locator('#workPanelToggle').click();
        const panelBefore = await f.page.locator('#detailPanel').getAttribute('class');
        await f.page.locator('#pluginsBtn').focus(); await f.page.keyboard.press('Enter');
        assert.equal(await f.page.locator('#pluginsBtn').getAttribute('aria-current'), 'page');
        assert.equal(await f.page.locator('#conversationBtn').getAttribute('aria-current'), null);
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'pluginsTitle');
        assert.equal(await f.page.locator('#pluginsList [role=switch]').count(), 5);
        assert.equal(await f.page.locator('#pluginsBtn svg').getAttribute('viewBox'), '0 0 20 14');
        const firstRow = await f.page.locator('.plugin-row').nth(0).boundingBox();
        const secondRow = await f.page.locator('.plugin-row').nth(1).boundingBox();
        assert.equal(secondRow.y - firstRow.y, 68);
        await f.page.screenshot({ path: join(artifacts, 'enabled-1400.png') });
        const description = f.page.locator('.plugin-description').first();
        await description.hover();
        await f.page.waitForFunction(() => document.getElementById('moonyaTooltip').matches(':popover-open'));
        assert.equal(await f.page.locator('#moonyaTooltip').textContent(), await description.textContent());
        assert.equal(await f.page.locator('.input-container-wrapper').isVisible(), false);
        assert.equal(await f.page.locator('#detailPanel').isVisible(), false);
        assert.equal(await f.page.locator('#detailPanel').getAttribute('class'), panelBefore);
        await f.page.locator('[data-plugin-id="browser-use-automation"] [role=switch]').focus();
        await f.page.keyboard.press('Space');
        assert.equal(await f.page.locator('[data-skill-name="browser-use-automation"]').count(), 0);
        assert.equal(await f.page.locator('.selected-skill-inline').count(), 0);
        assert.deepEqual(await f.page.evaluate(() => selectedSkills), []);
        for (const id of ['computer-use-automation', 'realtime-voice-chat']) await f.page.locator('[data-plugin-id="' + id + '"] [role=switch]').click();
        assert.equal(await f.page.locator('[data-skill-group]:not([hidden])').count(), 0);
        assert.equal(await f.page.locator('#voiceChatToggle').isVisible(), false);
        for (const width of [1400, 900, 460]) {
            await f.page.setViewportSize({ width, height: 900 });
            await f.page.screenshot({ path: join(artifacts, 'disabled-' + width + '.png') });
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            assert.equal(await f.page.locator('.plugin-switch').first().evaluate(el => el.getBoundingClientRect().width), 32);
        }
        await f.page.setViewportSize({ width: 1400, height: 950 });
        await f.page.locator('#conversationBtn').click();
        assert.equal(await f.page.locator('#pluginsView').isVisible(), false);
        assert.equal(await f.page.locator('.message-input').inputValue(), '插件页面切换后保留草稿');
        assert.equal(await f.page.locator('#detailPanel').isVisible(), true);
        await f.page.route('**/gateway/remote/**', route => route.abort());
        await f.page.reload(); await f.page.waitForFunction(() => !!window.MoonYaShell);
        await f.page.locator('#pluginsBtn').click();
        assert.equal(await f.page.locator('#pluginsList [aria-checked=false]').count(), 5);
        await f.page.locator('[data-plugin-id="browser-use-automation"] [role=switch]').click();
        await f.page.locator('#conversationBtn').click();
        await f.page.evaluate(() => document.querySelector('[data-skill-name="browser-use-automation"]').click());
        assert.deepEqual(await f.page.evaluate(() => selectedSkills), ['browser-use-automation']);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('plugin preferences sync windows, survive remote configuration and handle failed/corrupt storage', async () => {
    const f = await fixture();
    try {
        const other = await f.context.newPage(); await other.goto(f.host.url);
        await other.waitForFunction(() => !!window.MoonYaPluginView);
        await f.page.evaluate(() => MoonYaPlugins.setEnabled('browser-use-automation', false));
        await other.waitForFunction(() => !MoonYaPlugins.isEnabled('browser-use-automation'));
        assert.equal(await other.locator('[data-skill-name="browser-use-automation"]').count(), 0);
        await other.evaluate(() => MoonYaPlugins.setEnabled('browser-use-automation', true));
        await f.page.waitForFunction(() => MoonYaPlugins.isEnabled('browser-use-automation'));
        await f.page.evaluate(() => MoonYaPlugins.setEnabled('browser-use-automation', false));
        await f.page.route('**/gateway/remote/api/client_config.php', async route => {
            const config = await f.page.evaluate(() => structuredClone(MoonYaDefaults));
            config.skills[1].enabled = false;
            await route.fulfill({ json: { success: true, data: config } });
        });
        await f.page.evaluate(() => MoonYaClient.refreshConfig());
        await f.page.locator('#pluginsBtn').click();
        assert.equal(await f.page.locator('[data-plugin-id="browser-use-automation"] [role=switch]').getAttribute('aria-checked'), 'false');
        assert.equal(await f.page.locator('[data-plugin-id="computer-use-automation"] [role=switch]').isDisabled(), true);
        const failure = await f.page.evaluate(() => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, value) { if (key === 'moonya.plugins.v1') throw new Error('quota'); return original.call(this, key, value); };
            try { return { saved: MoonYaPlugins.setEnabled('browser-use-automation', true), enabled: MoonYaPlugins.isEnabled('browser-use-automation') }; }
            finally { Storage.prototype.setItem = original; }
        });
        assert.deepEqual(failure, { saved: false, enabled: false });
        assert.match(await f.page.locator('#toast').textContent(), /插件设置保存失败/);
        await f.page.unroute('**/gateway/remote/api/client_config.php');
        await f.page.evaluate(() => {
            localStorage.setItem('moonya.plugins.v1', '{invalid');
            localStorage.removeItem('moonya.client-config.v1');
        });
        await f.page.reload(); await f.page.waitForFunction(() => !!window.MoonYaPluginView);
        await f.page.locator('#pluginsBtn').click();
        assert.equal(await f.page.locator('#pluginsList [aria-checked=true]').count(), 3);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('external browser plugins default off, persist natively, require authentication and roll back failed saves', async () => {
    const f = await fixture();
    try {
        await f.page.waitForFunction(() => MoonYaPlugins.isAvailable('external-browser-chrome'));
        await f.page.locator('#pluginsBtn').click();
        const chrome = f.page.locator('[data-plugin-id="external-browser-chrome"] [role=switch]');
        const edge = f.page.locator('[data-plugin-id="external-browser-edge"] [role=switch]');
        assert.equal(await chrome.getAttribute('aria-checked'), 'false');
        assert.equal(await edge.getAttribute('aria-checked'), 'false');
        const unauthorized = await f.context.request.get(f.host.url + 'gateway/local/api/browser_settings.php', { headers: { 'X-MoonYa-Gateway': f.host.token } });
        assert.equal(unauthorized.status(), 401);
        const invalid = await f.page.evaluate(async () => (await fetch('/api/browser_settings.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chrome: 'true', edge: false }) })).status);
        assert.equal(invalid, 400);
        await chrome.click();
        await f.page.waitForFunction(() => MoonYaPlugins.isAvailable('external-browser-chrome') && MoonYaPlugins.isEnabled('external-browser-chrome'));
        assert.equal(await edge.getAttribute('aria-checked'), 'false');
        await f.page.reload();
        await f.page.waitForFunction(() => MoonYaPlugins.isEnabled('external-browser-chrome'));
        await f.page.locator('#pluginsBtn').click();
        await edge.click();
        await f.page.waitForFunction(() => MoonYaPlugins.isAvailable('external-browser-edge') && MoonYaPlugins.isEnabled('external-browser-edge'));
        await f.page.route('**/gateway/local/api/browser_settings.php', route => route.request().method() === 'POST'
            ? route.fulfill({ status: 503, json: { success: false, error: '浏览器设置保存失败测试' } }) : route.continue());
        await chrome.click();
        await f.page.waitForFunction(() => MoonYaPlugins.isAvailable('external-browser-chrome') && MoonYaPlugins.isEnabled('external-browser-chrome'));
        assert.equal(await chrome.getAttribute('aria-checked'), 'true');
        assert.match(await f.page.locator('#toast').textContent(), /浏览器设置保存失败/);
        await f.page.unroute('**/gateway/local/api/browser_settings.php');
        await f.page.route('**/gateway/remote/**', route => route.abort());
        await f.page.reload();
        await f.page.waitForFunction(() => MoonYaPlugins.isEnabled('external-browser-chrome') && MoonYaPlugins.isEnabled('external-browser-edge'));
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('disabling voice cancels pending permission, stops active audio and blocks automatic restart', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(() => {
            MoonYaPlugins.setEnabled('realtime-voice-chat', false);
            localStorage.setItem('moonya_voice_chat_enabled', '1');
        });
        await f.context.addInitScript(() => {
            window.voiceRequests = []; window.voiceStopped = 0; window.audioClosed = 0;
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: () => new Promise((resolve, reject) => window.voiceRequests.push({ resolve, reject })) });
            window.voiceStream = () => ({ getTracks: () => [{ enabled: true, stop: () => { window.voiceStopped++; } }] });
            const node = () => ({ connect() {}, disconnect() {}, getFloatTimeDomainData(buffer) { buffer.fill(0); } });
            window.AudioContext = class {
                constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
                createMediaStreamSource() { return node(); } createAnalyser() { return node(); } createScriptProcessor() { return node(); }
                close() { this.state = 'closed'; window.audioClosed++; return Promise.resolve(); }
            };
        });
        await f.page.reload(); await f.page.waitForFunction(() => !!window.VoiceChat);
        // Wait past the module's 300ms initialization and 500ms restoration timer.
        await f.page.waitForTimeout(1000);
        assert.equal(await f.page.evaluate(() => voiceRequests.length), 0);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('moonya_voice_chat_enabled')), '0');
        await f.page.evaluate(() => VoiceChat.start());
        assert.equal(await f.page.evaluate(() => voiceRequests.length), 0);
        await f.page.locator('#pluginsBtn').click();
        await f.page.locator('[data-plugin-id="realtime-voice-chat"] [role=switch]').click();
        assert.equal(await f.page.evaluate(() => voiceRequests.length), 0);
        await f.page.evaluate(() => VoiceChat.start());
        assert.equal(await f.page.evaluate(() => voiceRequests.length), 1);
        await f.page.locator('[data-plugin-id="realtime-voice-chat"] [role=switch]').click();
        await f.page.evaluate(() => voiceRequests[0].resolve(voiceStream()));
        await f.page.waitForFunction(() => voiceStopped === 1);
        assert.equal(await f.page.evaluate(() => VoiceChat.isActive()), false);
        await f.page.evaluate(() => {
            MoonYaPlugins.setEnabled('realtime-voice-chat', true); VoiceChat.start();
            voiceRequests[1].resolve(voiceStream());
        });
        await f.page.waitForFunction(() => VoiceChat.isActive());
        await f.page.locator('[data-plugin-id="realtime-voice-chat"] [role=switch]').click();
        assert.equal(await f.page.evaluate(() => VoiceChat.isActive()), false);
        assert.equal(await f.page.evaluate(() => voiceStopped), 2);
        assert.equal(await f.page.evaluate(() => audioClosed), 1);
        await f.page.evaluate(() => {
            MoonYaPlugins.setEnabled('realtime-voice-chat', true); VoiceChat.start();
            MoonYaPlugins.setEnabled('realtime-voice-chat', false);
            voiceRequests[2].reject(new Error('permission cancelled'));
        });
        await f.page.waitForTimeout(50);
        assert.equal(await f.page.evaluate(() => voiceRequests.length), 3, 'cancelled permission must not request fallback audio');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('moonya_voice_chat_enabled')), '0');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('plugin navigation hides and restores the native browser overlay without losing tabs', async () => {
    const f = await fixture({ browserBridge: true });
    try {
        await f.page.waitForFunction(() => !document.getElementById('railBrowserBtn').disabled);
        await f.page.locator('#railBrowserBtn').click();
        await f.page.waitForFunction(() => browserCalls.some(([method]) => method === 'bounds'));
        const tabs = await f.page.locator('.bp-tab').count();
        await f.page.locator('#pluginsBtn').click();
        await f.page.waitForFunction(() => browserCalls.at(-1)?.[0] === 'visible' && browserCalls.at(-1)?.[1] === false);
        assert.equal(await f.page.locator('#pluginsView').isVisible(), true);
        await f.page.locator('#railBrowserBtn').click();
        await f.page.waitForFunction(() => browserCalls.at(-1)?.[0] === 'bounds');
        assert.equal(await f.page.locator('.bp-tab').count(), tabs);
        assert.equal(await f.page.locator('#pluginsView').isVisible(), false);
        await f.page.locator('#pluginsBtn').click(); await f.page.locator('#officeBtn').click();
        assert.equal(await f.page.locator('#officeView').isVisible(), true);
        assert.equal(await f.page.locator('#pluginsView').isVisible(), false);
        await f.page.locator('#pluginsBtn').click(); await f.page.locator('#conversationBtn').click();
        assert.equal(await f.page.locator('#officeView').isVisible(), false);
        assert.equal(await f.page.locator('.input-container-wrapper').isVisible(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

async function fixture({ browserBridge = false } = {}) {
    const nativeRequests = [], sends = [], authRequests = [];
    let loggedIn = true;
    const backend = createServer(async (req, res) => {
        for await (const chunk of req) {}
        res.setHeader('content-type', 'application/json');
        if (req.url.includes('check_session')) return res.end(JSON.stringify({ success: true, data: { logged_in: loggedIn, user: loggedIn ? { id: 41, username: '项目测试' } : null } }));
        if (req.url.includes('logout')) { authRequests.push({ authorization: req.headers.authorization }); loggedIn = false; }
        if (req.url.includes('login')) { loggedIn = true; return res.end(JSON.stringify({ success: true, data: { token: 'workspace-token', expires_in: 1296000, user: { id: 41, username: '项目测试' } } })); }
        if (req.url.includes('updates.php')) return res.end(JSON.stringify({ success: false }));
        res.end(JSON.stringify({ success: true, data: {} }));
    });
    const runtime = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (req.url.includes('harness_api.php') && req.method === 'POST') sends.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.statusCode = 503; res.end(JSON.stringify({ success: false, error: 'fixture runtime unavailable' }));
    });
    const native = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); nativeRequests.push(body);
        res.setHeader('content-type', 'application/json');
        if (body.action === 'pick_folder') return res.end(JSON.stringify({ success: true, path: 'D:\\Fixture\\Picked' }));
        if (body.action === 'search_files') {
            const files = [{ name: 'search-dialog.js', path: body.path + '\\src\\search-dialog.js', relative_path: 'src/search-dialog.js' },
                { name: 'README.md', path: body.path + '\\README.md', relative_path: 'README.md' }];
            return res.end(JSON.stringify({ success: true, files: files.filter(file => file.relative_path.toLowerCase().includes(body.query.toLowerCase().replaceAll('\\', '/'))), truncated: false }));
        }
        res.end(JSON.stringify({ success: !body.path?.includes('Missing'), path: body.path, message: 'fixture path unavailable' }));
    });
    for (const server of [backend, runtime, native]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = server => 'http://127.0.0.1:' + server.address().port + '/';
    const data = await mkdtemp(join(tmpdir(), 'moonya-workspace-'));
    const process = spawn('dotnet', [join(root, 'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),
        join(root, 'MoonYa-Frontend/dist'), url(backend), url(runtime)],
    { env: { ...globalThis.process.env, MOONYA_SMOKE_DATA: data, MOONYA_SMOKE_FILE_SERVICE: url(native) }, windowsHide: true });
    let stderr = ''; process.stderr.on('data', chunk => stderr += chunk);
    const host = await new Promise((resolve, reject) => {
        createInterface({ input: process.stdout }).once('line', line => resolve(JSON.parse(line)));
        process.once('exit', code => reject(new Error('Smoke host exited ' + code + ': ' + stderr)));
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ userAgent: 'MoonYaDesktop/1.0', viewport: { width: 1400, height: 950 } });
    if (browserBridge) await context.addInitScript(() => {
        window.browserCalls = [];
        window.moonYaBrowserPanel = {
            info: async () => JSON.stringify({ available: true }),
            state: async () => JSON.stringify({ url: '', title: '新标签页', can_go_back: false, can_go_forward: false }),
            setBounds: async bounds => { window.browserCalls.push(['bounds', JSON.parse(bounds)]); return '{}'; },
            setVisible: async visible => { window.browserCalls.push(['visible', visible]); return '{}'; },
            navigate: async url => { window.browserCalls.push(['navigate', url]); return '{}'; },
            action: async action => { window.browserCalls.push(['action', action]); return '{}'; }
        };
        window.CefSharp = { BindObjectAsync: async name => { if (name !== 'moonYaBrowserPanel') throw new Error('Fixture only supports the browser bridge'); } };
    });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(host.url);
    await page.waitForFunction(() => !!window.MoonYaWorkspace);
    await page.evaluate(async () => {
        const result = await (await fetch('user_auth.php?action=login', { method: 'POST', body: '{}' })).json();
        localStorage.setItem('api_token', result.data.token); renderAuthState(result.data.user);
        await initializeChatHistory(); isAgentMode = true; document.body.classList.add('work-mode');
        await MoonYaWorkspace.render();
    });
    return { page, browser, context, host, data, nativeRequests, sends, authRequests, errors, async stop() {
        await browser.close();
        await new Promise(resolve => { process.once('exit', resolve); process.stdin.end('\n'); });
        for (const server of [backend, runtime, native]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}

test('default model settings show the real catalog, select provider references and refresh after changes', async () => {
    const f = await fixture();
    const artifacts = join(root, 'artifacts/default-model-settings');
    await mkdir(artifacts, { recursive: true });
    try {
        let providers = [
            { id: 'gateway', name: '我的接入服务', models: [
                { id: 'shared-model', name: '自接入模型', context_window: 65536, supports_chat: true, supports_tools: true },
                { id: 'chat-only', name: '仅对话模型', context_window: 32768, supports_chat: true, supports_tools: false },
                { id: 'pending', name: '待配置模型', context_window: null, supports_chat: true },
                { id: 'embedding', name: '嵌入模型', context_window: 8192, supports_chat: false }
            ] },
            { id: 'other', name: '另一个服务', models: [{ id: 'shared-model', name: '<img src=x onerror=alert(1)>', context_window: 65536, supports_chat: true, supports_tools: true }] }
        ];
        let failed = false;
        await f.page.route('**/model_api.php', route => route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json',
            body: JSON.stringify(failed ? { success: false, error: '目录暂时离线' } : { success: true, data: { providers, presets: [] } }) }));
        await f.page.evaluate(() => openSettingsModal('model'));
        await f.page.waitForFunction(() => document.querySelectorAll('#settingsModelList button').length === 6);
        const list = f.page.locator('#settingsModelList');
        assert.equal(await list.locator('[data-model-id="deepseek-flash"]').count(), 1);
        assert.doesNotMatch(await list.textContent(), /DeepSeek-R1/);
        assert.equal(await list.locator('img').count(), 0, 'provider names render as text');
        assert.equal(await list.locator('.settings-choice-icon svg').count(), 6);
        for (const id of ['chat-only', 'pending', 'embedding']) assert.equal(await list.locator(`[data-model-id="${id}"]`).isDisabled(), true);
        await list.locator('[data-provider-id="gateway"][data-model-id="shared-model"]').click();
        assert.deepEqual(await f.page.evaluate(() => MoonYaModels.reference()), { provider_id: 'gateway', model_id: 'shared-model' });
        assert.equal(await list.locator('.active').count(), 1, 'matching IDs at different providers do not both select');
        assert.equal(await f.page.locator('#settingsModelValue').textContent(), '我的接入服务 · 自接入模型');
        await f.page.setViewportSize({ width: 460, height: 680 });
        await f.page.locator('#settingsModalBox').screenshot({ path: join(artifacts, 'all-models.png') });
        assert.equal(await list.evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
        await f.page.reload();
        await f.page.waitForFunction(() => MoonYaModels?.reference()?.provider_id === 'gateway' && MoonYaModels.loaded());
        await f.page.evaluate(() => openSettingsModal('model'));
        await f.page.waitForFunction(() => document.querySelector('#settingsModelList .active')?.dataset.providerId === 'gateway');
        await f.page.evaluate(() => { isAgentMode = false; document.body.classList.remove('work-mode'); });
        await f.page.waitForFunction(() => !document.querySelector('#settingsModelList [data-model-id="chat-only"]').disabled);
        await list.locator('[data-model-id="chat-only"]').click();
        assert.equal(await f.page.evaluate(() => MoonYaModels.reference().model_id), 'chat-only');
        await list.locator('[data-model-id="deepseek-flash"]').click();
        assert.equal(await f.page.evaluate(() => MoonYaModels.reference()), null);
        assert.equal(await f.page.evaluate(() => deepseekModelVersion), 'deepseek-flash');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('moonya.deepseek.model.v1')), 'deepseek-flash');
        assert.equal(await f.page.locator('#deepseekModelBtnText').textContent(), 'deepseek-flash');
        providers = providers.slice(1);
        await f.page.evaluate(() => MoonYaModels.reload());
        assert.equal(await list.locator('[data-provider-id="gateway"]').count(), 0);
        failed = true;
        await f.page.evaluate(() => openSettingsModal('model'));
        await f.page.locator('#settingsModelRetry').waitFor({ state: 'visible' });
        assert.match(await f.page.locator('#toast').textContent(), /目录暂时离线/);
        assert.equal(await f.page.locator('#settingsModelStatus').textContent(), '', 'Errors are shown in the shared notification rather than repeated in the form');
        assert.equal(await list.locator('button').count(), 2, 'last successful catalog remains visible on load failure');
        failed = false;
        await f.page.locator('#settingsModelRetry').click();
        await f.page.locator('#settingsModelRetry').waitFor({ state: 'hidden' });
        await f.page.waitForFunction(() => document.getElementById('settingsModelStatus').textContent === '');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('settings and avatar share the backend subscription and open monthly quota details', async () => {
    const f = await fixture();
    try {
        await f.page.waitForFunction(() => !!window.MoonYaMembership);
        const account = { user_id: 41, plan: { id: 3, name: 'Plus', is_free: false, description: '后台真实套餐说明', features: [] }, balance: '1200.000000', period_allowance: '1500.000000', resets_at: '2026-11-04 12:00:00', expires_at: '2026-12-04 12:00:00' };
        await f.page.route('**/gateway/remote/api/membership.php', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { account, plans: [] } }) }));
        await f.page.evaluate(async () => { renderAuthState({ id: 41, username: 'moonya_account', real_name: '月雅汐' }); await MoonYaMembership.refresh(); });
        await f.page.locator('#userInfoDiv').click();
        assert.equal(await f.page.locator('#accountMenuName').textContent(), '月雅汐');
        assert.equal(await f.page.locator('#userPlan').textContent(), 'Plus');
        assert.equal(await f.page.locator('#accountMenu').isVisible(), true);
        const artifacts = join(root, 'artifacts/membership');await mkdir(artifacts, { recursive: true });
        await f.page.screenshot({ path: join(artifacts, 'app-avatar.png') });
        await f.page.locator('#accountMenuSettings').click();
        assert.equal(await f.page.locator('#settingsPlanName').textContent(), 'Plus');
        assert.equal(await f.page.locator('#settingsPlanStatus').textContent(), '已开通');
        await f.page.screenshot({ path: join(artifacts, 'app-settings.png') });
        for (const selector of ['#itemPlan', '#itemQuota']) {
            await f.page.locator(selector).focus();
            assert.equal(await f.page.evaluate(() => document.activeElement.id), selector.slice(1));
            await f.page.keyboard.press('Enter');
            await f.page.locator('.membership-overlay').waitFor({ state: 'visible' });
            assert.equal(await f.page.locator('#membershipTitle').textContent(), '个人订阅');
            assert.equal(await f.page.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '80');
            assert.match(await f.page.locator('.membership-current-plan').textContent(), /Plus.*2026-12-04/);
            await f.page.screenshot({ path: join(artifacts, 'app-subscription.png') });
            await f.page.locator('.membership-show-plans').click();
            assert.equal(await f.page.locator('#membershipTitle').textContent(), '按你的节奏，开启更多可能');
            await f.page.locator('.membership-back').click();
            assert.equal(await f.page.locator('#membershipTitle').textContent(), '个人订阅');
            await f.page.keyboard.press('Escape');
            assert.equal(await f.page.locator('#settingsOverlay').isVisible(), true);
            assert.equal(await f.page.evaluate(() => document.activeElement.id), selector.slice(1));
        }
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('avatar stays in the rail with account information only in its adjacent menu', async () => {
    const f = await fixture();
    const artifacts = join(root, 'artifacts/account-menu');
    await mkdir(artifacts, { recursive: true });
    try {
        await f.page.waitForFunction(() => !!window.MoonYaShell);
        await f.page.evaluate(() => renderAuthState({ id: 41, username: 'moonya_account', real_name: '月雅汐' }));
        const trigger = f.page.locator('#userInfoDiv');
        await f.page.locator('#railAccount #userInfoDiv').waitFor({ state: 'visible' });
        assert.equal(await f.page.locator('.sidebar-footer').count(), 0);
        assert.equal(await f.page.locator('#userPlan').isVisible(), false);
        const anchor = await trigger.boundingBox();
        await f.page.screenshot({ path: join(artifacts, 'account-expanded.png') });
        await f.page.screenshot({ path: join(artifacts, 'account-expanded-detail.png'), clip: { x: 0, y: 854, width: 310, height: 96 } });
        await trigger.click();
        const menu = await f.page.locator('#accountMenu').boundingBox();
        assert.ok(menu.x >= anchor.x + anchor.width);
        assert.ok(menu.y + menu.height >= anchor.y + anchor.height);
        assert.equal(await f.page.locator('#userPlan').isVisible(), true);
        assert.equal(await f.page.locator('#userPlan').textContent(), '免费版');
        await f.page.evaluate(() => renderAuthState({ id: 41, username: 'moonya_account', real_name: '月雅汐' }));
        assert.equal(await f.page.locator('#accountMenu').isVisible(), true, 'background session refresh keeps the menu open');
        await f.page.screenshot({ path: join(artifacts, 'account-expanded-menu.png') });
        await f.page.screenshot({ path: join(artifacts, 'account-menu-detail.png'), clip: { x: 0, y: menu.y - 8, width: 310, height: 950 - menu.y + 8 } });
        await f.page.keyboard.press('Escape');
        for (let i = 0; i < 2; i++) {
            await trigger.focus();
            await f.page.evaluate(() => moonyaSplitLayout.toggleSidebar());
            await f.page.locator('#railAccount #userInfoDiv').waitFor({ state: 'visible' });
            assert.equal(await f.page.evaluate(() => document.activeElement.id), 'userInfoDiv');
            assert.equal(await f.page.locator('#userInfoDiv').count(), 1);
            assert.deepEqual(await trigger.boundingBox(), anchor);
            await trigger.focus();
            await f.page.keyboard.press('Enter');
            assert.equal(await f.page.locator('#accountMenuName').textContent(), '月雅汐');
            await f.page.screenshot({ path: join(artifacts, 'account-collapsed-menu.png') });
            await f.page.keyboard.press('Escape');
            assert.equal(await f.page.evaluate(() => document.activeElement.id), 'userInfoDiv');
            await trigger.evaluate(el => el.blur());
            await f.page.screenshot({ path: join(artifacts, 'account-collapsed.png') });
            await f.page.screenshot({ path: join(artifacts, 'account-collapsed-detail.png'), clip: { x: 0, y: 854, width: 70, height: 96 } });
            await f.page.evaluate(() => moonyaSplitLayout.toggleSidebar());
            await f.page.locator('#railAccount #userInfoDiv').waitFor({ state: 'visible' });
            assert.deepEqual(await trigger.boundingBox(), anchor);
            assert.equal(await f.page.locator('#userPlan').isVisible(), false);
            assert.equal(await f.page.locator('#userName').textContent(), '月雅汐');
        }
        await f.page.evaluate(() => moonyaSplitLayout.toggleSidebar());
        await trigger.click();
        await f.page.locator('#accountMenuLogout').focus();
        await f.page.evaluate(() => renderAuthState(null));
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'accountMenuUpgrade');
        await f.page.waitForFunction(() => !document.getElementById('accountMenuPet').disabled);
        assert.equal(await f.page.locator('#accountMenu').isVisible(), true, 'auth expiry updates the open menu instead of dismissing it');
        assert.equal(await f.page.locator('#accountMenuName').textContent(), '登录');
        assert.equal(await f.page.locator('#accountMenuLogout').isVisible(), false);
        await f.page.locator('#accountMenuSettings').focus();
        await f.page.keyboard.press('End');
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'accountMenuPet');
        await f.page.locator('#accountMenuProfile').click();
        assert.equal(await f.page.locator('#authModalBox').isVisible(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('avatar menu uses real account data, settings, bound pet state and authenticated logout without losing account history', async () => {
    const f = await fixture();
    try {
        await f.page.waitForFunction(() => !!window.MoonYaShell);
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuPet').click();
        await f.page.waitForFunction(() => document.getElementById('toast').textContent.includes('Windows 客户端'));
        await f.page.keyboard.press('Escape');
        await f.page.evaluate(() => {
            renderAuthState({ id: 41, username: 'moonya_account', real_name: '月雅' });
            window.petCalls = [];
            window.petVisible = false;
            window.CefSharp = { BindObjectAsync: async name => {
                if (name !== 'petController') throw new Error('Unsupported fixture bridge');
                // Input-focus and other native bridges can bind asynchronously;
                // this fixture records only interactions with the pet bridge.
                window.petCalls.push(['bind', name]);
                window.petController = {
                    isEnabled: async () => window.petVisible,
                    setEnabled: async enabled => { window.petCalls.push(['set', enabled]); window.petVisible = enabled; }
                };
            } };
        });
        await f.page.locator('#userInfoDiv').click();
        await f.page.waitForFunction(() => !document.getElementById('accountMenuPet').disabled);
        assert.equal(await f.page.locator('#settingsOverlay').isVisible(), false);
        assert.equal(await f.page.locator('#accountMenuName').textContent(), '月雅');
        assert.equal(await f.page.locator('#userPlan').textContent(), '免费版');
        assert.equal(await f.page.locator('#accountMenuLogout').isVisible(), true);
        assert.equal(await f.page.locator('#accountMenu .ui-icon:not(:has(svg))').count(), 0);
        assert.deepEqual(await f.page.evaluate(() => petCalls), [['bind', 'petController']]);
        const artifacts = join(root, 'artifacts/account-menu');
        await mkdir(artifacts, { recursive: true });
        await f.page.screenshot({ path: join(artifacts, 'account-menu.png') });
        await f.page.keyboard.press('ArrowDown');
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'accountMenuSettings');
        await f.page.keyboard.press('ArrowDown');
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'accountMenuAppearance');
        await f.page.keyboard.press('ArrowDown');
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'accountMenuPet');
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#accountMenu').isVisible(), false);
        assert.equal(await f.page.evaluate(() => document.activeElement.id), 'userInfoDiv');
        await f.page.keyboard.press('Enter');
        await f.page.locator('#accountMenuSettings').click();
        assert.equal(await f.page.locator('#settingsOverlay').isVisible(), true);
        assert.equal(await f.page.locator('#settingsProfileName').textContent(), '月雅');
        await f.page.locator('#settingsCloseBtn').click();
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuAppearance').click();
        assert.equal(await f.page.locator('#settingsAppearanceView').isVisible(), true);
        assert.equal(await f.page.locator('#settingsSubTitle').textContent(), '外观设置');
        assert.equal(await f.page.locator('#accountMenu').isVisible(), false);
        await f.page.locator('#settingsBackBtn').click();
        assert.equal(await f.page.locator('#settingsMainView').isVisible(), true);
        await f.page.locator('#settingsCloseBtn').click();
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuPet').click();
        await f.page.waitForFunction(() => petVisible && document.getElementById('accountMenu').hidden);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('furinaPetEnabled')), '1');
        await f.page.locator('#userInfoDiv').click();
        await f.page.waitForFunction(() => document.getElementById('accountMenuPet').getAttribute('aria-checked') === 'true');
        // The native pet's own close menu can change visibility outside this popover.
        await f.page.evaluate(() => { petVisible = false; });
        await f.page.keyboard.press('Escape');
        await f.page.locator('#userInfoDiv').click();
        await f.page.waitForFunction(() => document.getElementById('accountMenuPet').getAttribute('aria-checked') === 'false');
        await f.page.locator('#accountMenuPet').click();
        await f.page.waitForFunction(() => petVisible);
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuPet').click();
        await f.page.waitForFunction(() => !petVisible);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('furinaPetEnabled')), '0');
        await f.page.evaluate(() => {
            delete window.petController;
            window.CefSharp.BindObjectAsync = async () => { throw new Error('桌面宠物服务未连接'); };
        });
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuPet').click();
        await f.page.waitForFunction(() => document.getElementById('toast').textContent.includes('桌面宠物服务未连接'));
        assert.equal(await f.page.evaluate(() => localStorage.getItem('furinaPetEnabled')), '0');
        for (const [width, height] of [[460, 680], [900, 600]]) {
            await f.page.setViewportSize({ width, height });
            await f.page.waitForFunction(() => {
                const rect = document.getElementById('accountMenu').getBoundingClientRect();
                return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
            });
            const rect = await f.page.locator('#accountMenu').boundingBox();
            assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height);
        }
        await f.page.locator('#conversationBtn').click();
        assert.equal(await f.page.locator('#accountMenu').isVisible(), false);
        await f.page.evaluate(async () => {
            await MoonYaHistoryStore.save(CHAT_HISTORY_KEY, [{ id: 'menu-history', mode: 'work', title: '账号历史', messages: [{ type: 'user', content: '保留内容' }], messagesLoaded: true }]);
            await loadChat('menu-history');
            messageInput.value = '保留草稿';
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await f.page.route('**/gateway/remote/user_auth.php?action=logout', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":"退出失败测试"}' }));
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuLogout').click();
        await f.page.waitForFunction(() => !logoutRequest);
        assert.equal(await f.page.evaluate(() => isLoggedIn), true);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('api_token')), 'workspace-token');
        await f.page.unroute('**/gateway/remote/user_auth.php?action=logout');
        await f.page.locator('#userInfoDiv').click();
        await f.page.locator('#accountMenuLogout').click();
        await f.page.waitForFunction(() => !isLoggedIn && !logoutRequest);
        assert.deepEqual(f.authRequests, [{ authorization: 'Bearer workspace-token' }]);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('api_token')), null);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('moonya.auth-user.v1')), null);
        assert.equal(await f.page.evaluate(() => CHAT_HISTORY_KEY), 'chat_history');
        // 退出登录保留当前会话与草稿，编辑器内容不清空。
        assert.equal(await f.page.locator('.message-input').inputValue(), '保留草稿');
        assert.equal(await f.page.locator('#accountMenuName').textContent(), '登录');
        assert.equal(await f.page.locator('#accountMenuLogout').isDisabled(), true);
        await f.page.locator('#userInfoDiv').click();
        assert.equal(await f.page.locator('#accountMenuLogout').isVisible(), false);
        await f.page.keyboard.press('Escape');
        // 退出登录不再切 scope、不再清空编辑器：本地历史与草稿都留在全局桶。
        assert.equal(await f.page.evaluate(async () => (await MoonYaHistoryStore.hydrate(CHAT_HISTORY_KEY, 'menu-history')).messages[0].content), '保留内容');
        assert.equal(await f.page.evaluate(async () => (await MoonYaHistoryStore.loadDraft(CHAT_HISTORY_KEY, 'menu-history')).draft), '保留草稿');
        await f.page.reload();
        await f.page.waitForFunction(() => !!window.MoonYaShell);
        assert.equal(await f.page.evaluate(() => currentUser), null);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('atomic workspace changes preserve messages/drafts, resist stale streaming snapshots, roll back and isolate accounts', async () => {
    const f = await fixture();
    try {
        const result = await f.page.evaluate(async () => {
            const s = MoonYaHistoryStore, scope = CHAT_HISTORY_KEY;
            const a = (await s.projectRequest(scope, 'create', { name: '同名', path: 'D:\\Fixture\\A' })).data;
            const b = (await s.projectRequest(scope, 'create', { name: '同名', path: 'D:\\Fixture\\B' })).data;
            const duplicate = await s.projectRequest(scope, 'create', { name: '另一个名称', path: 'd:/fixture/a/' });
            const c = { id: 'owned', mode: 'work', storage: 'local', title: '持久会话', messagesLoaded: true,
                projectId: a.id, workingDirectory: a.path, projectName: a.name, activeWorkspaceIdentity: a.path,
                runtimeSessions: { [a.path]: 'session-a' }, messages: [{ type: 'user', content: '历史保留', images: ['data:image/png;base64,YQ=='] }] };
            await s.save(scope, [c]);
            await s.saveDraft(scope, c.id, { draft: '保留草稿', uploadedImages: [{ filename: 'attachment.txt' }], composer: { projectPath: a.path, projectName: a.name, model: 'deepseek' } });
            const stale = structuredClone(s.list(scope));
            const section = (await s.sidebarRequest(scope, 'section_create', { name: '我的分区' })).data;
            await s.sidebarRequest(scope, 'chat_section', { ids: [c.id], sectionId: section.id });
            await s.sidebarRequest(scope, 'chat_pin', { ids: [c.id], pinned: true });
            const move = await s.sidebarRequest(scope, 'chat_move', { ids: [c.id], projectId: b.id });
            stale[0].messages.push({ type: 'ai', content: '晚到的流式结果' });
            await s.save(scope, stale);
            await s.saveDraft(scope, c.id, { draft: '最新草稿', composer: { projectPath: a.path, model: 'deepseek' }, uploadedImages: [{ filename: 'attachment.txt' }] });
            const afterMove = structuredClone(s.list(scope)[0]), draft = await s.loadDraft(scope, c.id);
            await s.sidebarRequest(scope, 'chat_section', { ids: [c.id], sectionId: section.id });
            const archive = await s.sidebarRequest(scope, 'project_archive', { id: b.id });
            const archived = s.list(scope)[0].archivedAt;
            await s.sidebarRequest(scope, 'project_restore', { id: b.id });
            await s.sidebarRequest(scope, 'project_update', { id: b.id, name: '改名', path: 'D:\\Fixture\\B2' });
            const renamed = structuredClone(s.list(scope)[0]);
            const originalPut = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, ...args) {
                if (this.name === 'conversations') throw new Error('injected transaction failure');
                return originalPut.call(this, value, ...args);
            };
            const failed = await s.sidebarRequest(scope, 'project_update', { id: b.id, path: 'D:\\Fixture\\ShouldRollback' });
            IDBObjectStore.prototype.put = originalPut;
            const afterFailure = (await s.sidebarRequest(scope, 'list')).data.projects.find(p => p.id === b.id).path;
            await s.reload(scope);
            const afterReloadFailure = (await s.sidebarRequest(scope, 'list')).data.projects.find(p => p.id === b.id).path;
            await s.sidebarRequest(scope, 'project_delete', { id: b.id });
            const removed = structuredClone(s.list(scope)[0]);
            const open = indexedDB.open('moonya-history', 1);
            const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
            const draftRead = db.transaction('drafts').objectStore('drafts').get([scope, c.id]);
            const rawRemovedDraft = await new Promise(resolve => { draftRead.onsuccess = () => resolve(draftRead.result.value); });
            db.close();
            await s.reload(scope);
            const hydrated = await s.hydrate(scope, c.id);
            const persistedDraft = await s.loadDraft(scope, c.id);
            const isolated = (await s.sidebarRequest('chat_history_999', 'list')).data;
            return { duplicate, move: move.success, afterMove, draft, archive: archive.success, archived, renamed, failed, afterFailure,
                afterReloadFailure, removed, rawRemovedDraft, hydrated, persistedDraft, isolated, a, b };
        });
        assert.equal(result.duplicate.success, false); assert.equal(result.duplicate.data.id, result.a.id);
        assert.equal(result.move, true); assert.equal(result.afterMove.projectId, result.b.id); assert.equal(result.afterMove.workingDirectory, result.b.path);
        assert.equal(result.afterMove.pinned, true); assert.equal(result.afterMove.runtimeSessions[result.a.path], 'session-a');
        assert.equal(result.draft.composer.projectPath, result.b.path); assert.equal(result.draft.draft, '最新草稿');
        assert.equal(result.draft.uploadedImages[0].filename, 'attachment.txt');
        assert.equal(result.archive, true); assert.ok(result.archived); assert.equal(result.renamed.projectName, '改名');
        assert.equal(result.renamed.workingDirectory, 'D:\\Fixture\\B2'); assert.ok(result.renamed.sectionId);
        assert.equal(result.failed.success, false); assert.equal(result.afterFailure, 'D:\\Fixture\\B2'); assert.equal(result.afterReloadFailure, result.afterFailure);
        assert.equal(result.removed.projectId, null); assert.equal(result.removed.pinned, false); assert.equal(result.removed.sectionId, null);
        assert.equal(result.rawRemovedDraft.composer.projectId, null); assert.equal(result.rawRemovedDraft.composer.projectPath, 'D:\\Fixture\\B2');
        assert.equal(result.hydrated.workingDirectory, 'D:\\Fixture\\B2'); assert.equal(result.hydrated.messages.length, 2);
        assert.equal(result.hydrated.messages[0].images[0], 'data:image/png;base64,YQ==');
        assert.equal(result.persistedDraft.draft, '最新草稿'); assert.deepEqual(result.isolated.projects, []); assert.deepEqual(result.isolated.layout.sections, []);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('legacy association uses unique directory evidence and never guesses from names or the global selection', async () => {
    const f = await fixture();
    try {
        const result = await f.page.evaluate(async () => {
            const s = MoonYaHistoryStore, scope = 'chat_history_legacy';
            const a = (await s.projectRequest(scope, 'create', { name: '相同标题', path: 'D:\\Fixture\\A' })).data;
            const b = (await s.projectRequest(scope, 'create', { name: '相同标题', path: 'D:\\Fixture\\B' })).data;
            await s.save(scope, [
                { id: 'unique', mode: 'work', title: '相同标题', messages: [], activeWorkspaceIdentity: 'd:/fixture/a/', runtimeSessions: { [a.path]: 'a' } },
                { id: 'ambiguous', mode: 'work', title: '相同标题', messages: [], runtimeSessions: { [a.path]: 'a', [b.path]: 'b' } },
                { id: 'unknown', mode: 'work', title: '相同标题', messages: [] },
                { id: 'conflicting', mode: 'work', title: '相同标题', messages: [], activeWorkspaceIdentity: a.path }
            ]);
            await s.saveDraft(scope, 'conflicting', { composer: { projectPath: b.path } });
            await s.sidebarRequest(scope, 'associate_legacy');
            await s.sidebarRequest(scope, 'associate_legacy');
            await s.reload(scope);
            return { chats: s.list(scope), a };
        });
        assert.equal(result.chats.find(c => c.id === 'unique').projectId, result.a.id);
        for (const id of ['ambiguous', 'unknown', 'conflicting']) assert.equal(result.chats.find(c => c.id === id).projectId, null);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('sidebar UI matches project hierarchy; menus, search, pinning, sections, drag, archive, edit and native open work', async () => {
    const f = await fixture();
    try {
        const ids = await f.page.evaluate(async () => {
            const a = await MoonYaWorkspace.request('project_create', { name: 'MoonYa', path: 'D:\\Fixture\\A' });
            const b = await MoonYaWorkspace.request('project_create', { name: '第二项目', path: 'D:\\Fixture\\B' });
            const section = await MoonYaWorkspace.request('section_create', { name: '日常工作' });
            const chats = Array.from({ length: 7 }, (_, i) => ({ id: 'ui-' + i, mode: 'work', title: i === 0 ? '统一并美化办公室 UI' : '项目会话 ' + i,
                messages: [{ type: 'user', content: '测试会话' }], projectId: a.id, workingDirectory: a.path, projectName: a.name,
                createdAt: new Date(Date.now() - i * 1000).toISOString(), activeWorkspaceIdentity: a.path }));
            await MoonYaHistoryStore.save(CHAT_HISTORY_KEY, chats);
            await MoonYaWorkspace.render(); await loadChat('ui-0');
            return { a: a.id, b: b.id, section: section.id };
        });
        const project = f.page.locator('.workspace-project[data-id="' + ids.a + '"]');
        await f.page.waitForFunction(() => document.querySelectorAll('.workspace-chat.nested').length === 5);
        await f.page.getByRole('button', { name: '展开显示', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelectorAll('.workspace-chat.nested').length === 7);
        assert.equal(await f.page.locator('.workspace-chat.active').count(), 2);
        await f.page.getByRole('button', { name: '收起', exact: true }).click();
        await project.hover(); await project.getByRole('button', { name: '更多操作' }).click();
        assert.deepEqual(await f.page.locator('.workspace-menu-item').allTextContents(), ['置顶', '编辑', '分区', '在资源管理器中打开', '归档聊天', '移除项目', '上移', '下移']);
        const menu = await f.page.locator('.workspace-menu').boundingBox(); assert.ok(menu.x + menu.width <= 1400);
        const artifacts = join(root, 'artifacts/workspace'); await mkdir(artifacts, { recursive: true });
        await f.page.screenshot({ path: join(artifacts, 'project-menu.png') });
        await f.page.keyboard.press('Escape'); assert.equal(await f.page.locator('.workspace-menu').count(), 0);
        assert.equal(await project.getByRole('button', { name: '更多操作' }).evaluate(el => el === document.activeElement), true);
        await project.getByRole('button', { name: '更多操作' }).click();
        await Promise.all([
            f.page.waitForResponse(response => response.url().endsWith('/gateway/native/file-op')),
            f.page.getByRole('menuitem', { name: '在资源管理器中打开', exact: true }).click()
        ]);
        assert.ok(f.nativeRequests.some(r => r.action === 'open_file' && r.path === 'D:\\Fixture\\A'));
        await project.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '置顶', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('.workspace-heading[data-id="pinned"]'));
        await project.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
        await project.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '分区', exact: true }).click();
        await f.page.getByRole('menuitem', { name: '日常工作', exact: true }).click();
        await f.page.waitForFunction(id => MoonYaHistoryStore.list(CHAT_HISTORY_KEY).length === 7 && document.querySelector('.workspace-heading[data-id="section:' + id + '"]'), ids.section);
        await f.page.locator('#sidebarSearchBtn').click();
        await f.page.locator('#workspaceSearch').fill('办公室');
        await f.page.waitForFunction(() => document.querySelectorAll('#workspaceSearchResults [data-kind="chat"]').length === 1);
        assert.match(await f.page.locator('.workspace-search-project').textContent(), /MoonYa/);
        await f.page.locator('#workspaceSearch').fill('fixture/b');
        await f.page.waitForFunction(() => document.querySelectorAll('#workspaceSearchResults [data-kind="project"]').length === 1);
        assert.match(await f.page.locator('#workspaceSearchResults [data-kind="project"]').textContent(), /第二项目/);
        await f.page.keyboard.press('Escape');
        await f.page.waitForFunction(() => document.querySelectorAll('.workspace-chat.nested').length === 5);
        const source = f.page.locator('.workspace-chat[data-id="ui-0"]').first();
        await source.dragTo(f.page.locator('.workspace-project[data-id="' + ids.b + '"]'));
        await f.page.waitForFunction(id => getChatHistory().find(c => c.id === 'ui-0').projectId === id, ids.b);
        assert.equal(await f.page.evaluate(() => MoonYaActiveProject.path), 'D:\\Fixture\\B');
        const sectionRow = f.page.locator('.workspace-heading[data-id="section:' + ids.section + '"]');
        await f.page.locator('.workspace-chat[data-id="ui-0"]').first().dragTo(sectionRow);
        await f.page.waitForFunction(id => getChatHistory().find(c => c.id === 'ui-0').sectionId === id, ids.section);
        assert.equal(await f.page.evaluate(() => getChatHistory().find(c => c.id === 'ui-0').workingDirectory), 'D:\\Fixture\\B');
        const bRow = f.page.locator('.workspace-project[data-id="' + ids.b + '"]');
        await bRow.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '编辑', exact: true }).click();
        await f.page.locator('dialog input[name="name"]').fill('新的项目名');
        await f.page.locator('dialog input[name="path"]').fill('D:\\Fixture\\B2');
        await f.page.locator('dialog').getByRole('button', { name: '保存', exact: true }).click();
        await f.page.locator('dialog.workspace-confirm').getByRole('button', { name: '确认', exact: true }).click();
        await f.page.waitForFunction(() => getChatHistory().find(c => c.id === 'ui-0').workingDirectory === 'D:\\Fixture\\B2');
        await bRow.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '归档聊天', exact: true }).click();
        await f.page.locator('dialog.workspace-confirm').getByRole('button', { name: '归档', exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector('.workspace-chat[data-id="ui-0"]'));
        await f.page.locator('#settingsBtn').click(); await f.page.locator('#itemArchive').click(); await f.page.locator('dialog select').selectOption(ids.b);
        assert.equal(await f.page.locator('.workspace-archive-list .workspace-chat').count(), 1);
        await f.page.locator('dialog').getByRole('button', { name: '恢复该项目全部会话' }).click();
        await f.page.waitForFunction(() => !getChatHistory().find(c => c.id === 'ui-0').archivedAt);
        await f.page.keyboard.press('Escape');
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace && getChatHistory().some(c => c.id === 'ui-0'));
        await f.page.evaluate(() => loadChat('ui-0'));
        assert.equal(await f.page.evaluate(() => MoonYaActiveProject.path), 'D:\\Fixture\\B2');
        await f.page.locator('#sidebar').screenshot({ path: join(artifacts, 'sidebar.png') });
        await f.page.setViewportSize({ width: 460, height: 480 });
        await f.page.waitForFunction(() => moonyaSplitLayout.isSidebarCollapsed());
        await f.page.evaluate(() => { if (moonyaSplitLayout.isSidebarCollapsed()) moonyaSplitLayout.toggleSidebar(); });
        await f.page.waitForFunction(() => !document.getElementById('sidebar').classList.contains('collapsed'));
        const last = f.page.locator('.workspace-chat').last(); await last.scrollIntoViewIfNeeded();
        await last.getByRole('button', { name: '更多操作' }).click();
        const bounded = await f.page.locator('.workspace-menu').boundingBox();
        assert.ok(bounded.y >= 0 && bounded.y + bounded.height <= 480);
        await f.page.keyboard.press('Escape');
        await f.page.setViewportSize({ width: 1400, height: 950 });
        await f.page.evaluate(() => switchMoonYaConversationMode('chat'));
        assert.equal(await f.page.locator('#workSidebar').isVisible(), false);
        assert.equal(await f.page.locator('#recentChatBtn').isVisible(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('project-bound empty reuse, directory restore and next send respect ownership; busy and archived chats cannot mutate or execute', async () => {
    const f = await fixture();
    try {
        const result = await f.page.evaluate(async () => {
            const a = await MoonYaWorkspace.request('project_create', { name: 'A', path: 'D:\\Fixture\\A' });
            const b = await MoonYaWorkspace.request('project_create', { name: 'B', path: 'D:\\Fixture\\B' });
            const c = await createNewChat({ projectId: a.id, projectPath: a.path });
            const reused = await createNewChat({ projectId: a.id, projectPath: a.path });
            const other = await createNewChat({ projectId: b.id, projectPath: b.path });
            await loadChat(c.id);
            const before = MoonYaActiveProject.path;
            await MoonYaWorkspace.request('chat_move', { ids: [c.id], projectId: b.id });
            const moved = MoonYaActiveProject.path;
            const runtime = MoonYaConversationRuntime.current(); runtime.preparing = true;
            const rejected = [];
            for (const [action, body] of [
                ['chat_move', { ids: [c.id], projectId: a.id }], ['chat_archive', { ids: [c.id] }],
                ['project_update', { id: b.id, path: 'D:\\Fixture\\C' }], ['project_archive', { id: b.id }], ['project_delete', { id: b.id }]
            ]) rejected.push((await MoonYaHistoryStore.sidebarRequest(CHAT_HISTORY_KEY, action, body)).success);
            deleteChat(c.id); const stillExists = getChatHistory().some(item => item.id === c.id);
            await MoonYaWorkspace.request('chat_pin', { ids: [c.id], pinned: true });
            runtime.preparing = false;
            await MoonYaWorkspace.request('chat_archive', { ids: [c.id] });
            messageInput.value = '归档不可发送'; await sendMessage();
            const archivedToast = document.getElementById('toast').textContent;
            await MoonYaWorkspace.request('chat_restore', { ids: [c.id] });
            messageInput.value = '在新目录执行'; messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            MoonYaClient.state.online = null; void sendMessage();
            return { c: c.id, reused: reused.id, other: other.id, before, moved, rejected, stillExists, archivedToast };
        });
        assert.equal(result.c, result.reused); assert.notEqual(result.c, result.other);
        assert.equal(result.before, 'D:\\Fixture\\A'); assert.equal(result.moved, 'D:\\Fixture\\B');
        assert.deepEqual(result.rejected, [false, false, false, false, false]); assert.equal(result.stillExists, true);
        assert.match(result.archivedToast, /归档/);
        await f.page.waitForFunction(() => !MoonYaConversationRuntime.current().preparing && !MoonYaConversationRuntime.current().running);
        assert.equal(f.sends.length, 1); assert.equal(f.sends[0].project_path, 'D:\\Fixture\\B');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('project creation and default selection keep existing drafts isolated; section ordering/deletion and bulk deletion persist', async () => {
    const f = await fixture();
    try {
        await f.page.getByRole('button', { name: '添加项目', exact: true }).click();
        await f.page.locator('#wpCreateNameInput').fill('创建项目');
        await f.page.locator('#wpCreatePathInput').fill('D:\\Fixture\\Created');
        await f.page.locator('#wpCreateConfirmBtn').click();
        await f.page.waitForFunction(() => document.querySelectorAll('.workspace-project').length === 1);
        const ids = await f.page.evaluate(async () => {
            const data = await MoonYaWorkspace.request('list'), a = data.projects[0];
            const b = await MoonYaWorkspace.request('project_create', { name: '新建目标', path: 'D:\\Fixture\\Target' });
            const chat = await createNewChat({ projectId: a.id, projectPath: a.path });
            messageInput.value = '属于原会话的草稿'; messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            captureConversationComposer(MoonYaConversationRuntime.current());
            await MoonYaWorkspace.request('layout', { selectedProjectId: b.id });
            return { a: a.id, b: b.id, chat: chat.id };
        });
        assert.equal(await f.page.evaluate(() => MoonYaActiveProject.path), 'D:\\Fixture\\Created');
        await f.page.locator('#sidebarNewChatBtn').click();
        await f.page.waitForFunction(id => getChatHistory().find(c => c.id === currentChatId)?.projectId === id, ids.b);
        assert.equal(await f.page.locator('.message-input').inputValue(), '');
        assert.equal(await f.page.evaluate(() => uploadedImages.length), 0);
        await f.page.evaluate(id => loadChat(id), ids.chat);
        assert.equal(await f.page.locator('.message-input').inputValue(), '属于原会话的草稿');
        const sections = await f.page.evaluate(async () => {
            const first = await MoonYaWorkspace.request('section_create', { name: '第一分区' });
            const second = await MoonYaWorkspace.request('section_create', { name: '第二分区' });
            return { first: first.id, second: second.id };
        });
        const second = f.page.locator('.workspace-heading[data-id="section:' + sections.second + '"]');
        await second.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '上移', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('.workspace-heading[data-id^="section:"] .workspace-heading-label')?.textContent === '第二分区');
        await f.page.evaluate(async ({ ids, sections }) => {
            await MoonYaWorkspace.request('project_section', { id: ids.a, sectionId: sections.first });
            await MoonYaWorkspace.request('chat_section', { ids: [ids.chat], sectionId: sections.first });
            await MoonYaWorkspace.request('chat_pin', { ids: [ids.chat], pinned: true });
        }, { ids, sections });
        const first = f.page.locator('.workspace-heading[data-id="section:' + sections.first + '"]');
        await first.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '删除分区', exact: true }).click();
        await f.page.locator('dialog.workspace-confirm').getByRole('button', { name: '确认', exact: true }).click();
        await f.page.waitForFunction(id => !document.querySelector('.workspace-heading[data-id="section:' + id + '"]'), sections.first);
        const state = await f.page.evaluate(async id => ({ chat: getChatHistory().find(c => c.id === id), data: await MoonYaWorkspace.request('list') }), ids.chat);
        assert.equal(state.chat.sectionId, null); assert.equal(state.chat.projectId, ids.a); assert.equal(state.chat.pinned, true);
        assert.equal(state.data.projects.find(p => p.id === ids.a).sectionId, null);
        const row = f.page.locator('.workspace-chat[data-id="' + ids.chat + '"]').first();
        await row.getByRole('button', { name: '更多操作' }).click(); await f.page.getByRole('menuitem', { name: '批量删除', exact: true }).click();
        const batchDialog = f.page.locator('dialog.workspace-dialog:not(.workspace-confirm)');
        await batchDialog.getByRole('button', { name: '全选', exact: true }).click();
        await batchDialog.getByRole('button', { name: '删除', exact: true }).click();
        await f.page.locator('dialog.workspace-confirm').getByRole('button', { name: '确认', exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector('dialog.workspace-dialog'));
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace);
        assert.equal(await f.page.evaluate(async () => { await initializeChatHistory(); return getChatHistory().length; }), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});
