import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));

async function motionFixture(page, style) {
    await page.evaluate(style => {
        MoonYaProcessUI.setAnimationStyle(style);
        document.getElementById('motion-fixture')?.remove();
        const message = document.createElement('div'); message.id = 'motion-fixture'; message.className = 'message ai';
        Object.assign(message.style, { position: 'fixed', left: '340px', top: '120px', width: 'min(600px, calc(100vw - 360px))', background: '#fff', padding: '20px', zIndex: '100' });
        const content = document.createElement('div'); content.className = 'message-content'; message.append(content); document.body.append(message);
        const sequence = MoonYaProcessUI.sequence(content, 'motion:turn:1'); MoonYaProcessUI.ensure(sequence);
        window.motionFixture = { message, content, sequence };
    }, style);
}

async function settleMotion(page) {
    await page.waitForFunction(() => !document.querySelector('.process-motion-ghost') && document.getAnimations().every(animation => animation instanceof CSSAnimation || animation instanceof CSSTransition));
}

async function fixture(mode) {
    let response, seq = 0;
    let changesSummary = null, changeConflict = false;
    let workspaceSettings = { root: 'D:\\MoonYaDefault', workspaces: [], retained_paths: [] };
    const requests = [];
    const streams = new Set();
    const server = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
        const url = new URL(req.url, 'http://fixture');
        const action = url.searchParams.get('action');
        requests.push({ path: url.pathname, action, method: req.method, body, query: Object.fromEntries(url.searchParams) });
        if ((url.pathname.endsWith('/harness_api.php') && req.method === 'POST' && !action) || url.pathname.endsWith('/api.php')) {
            res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); response = res; streams.add(res); return;
        }
        if (action === 'office_events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); return; }
        res.setHeader('content-type', 'application/json');
        if (url.pathname.endsWith('/updates.php')) { res.end(JSON.stringify({ success: false })); return; }
        let data = {};
        if (action === 'workspace_settings') {
            if (req.method === 'POST') workspaceSettings = { ...workspaceSettings, root: body.root };
            data = workspaceSettings;
        }
        if (action === 'changes_summary') data = changesSummary;
        if (action === 'changes_diff') data = { kind: 'text', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-old value', '+new value', ' context'] }] };
        if (action === 'changes_undo') {
            if (changeConflict) { res.statusCode = 409; res.end(JSON.stringify({ success: false, error: 'undo_conflict', data: { conflicts: [changesSummary.files[0].path] } })); return; }
            changesSummary = { ...changesSummary, state: 'undone', revision: changesSummary.revision + 1 }; data = changesSummary;
        }
        if (url.pathname.endsWith('/model_api.php')) data = { providers: [], presets: [] };
        if (action === 'check_session' || action === 'login') data = { logged_in: true, token: 'fixture-token', expires_in: 1296000, user: { id: 41, username: 'fixture' } };
        if (action === 'office_state') data = { session_id: 'process-fixture', seq: 0, employees: [], concurrency: 8 };
        res.end(JSON.stringify({ success: true, data }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const data = await mkdtemp(join(tmpdir(), 'moonya-process-'));
    const child = spawn('dotnet', [join(root, 'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),
        join(root, 'MoonYa-Frontend/dist'), 'http://127.0.0.1:' + server.address().port + '/', 'http://127.0.0.1:' + server.address().port + '/'],
    { env: { ...process.env, MOONYA_SMOKE_DATA: data }, windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
    const host = await new Promise((resolve, reject) => {
        createInterface({ input: child.stdout }).once('line', line => resolve(JSON.parse(line)));
        child.once('exit', code => reject(new Error('Native host ' + code + ': ' + stderr)));
    });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ userAgent: 'MoonYaDesktop/1.0', viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = [], warnings = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.text().includes('SSE JSON parse error')) warnings.push(message.text()); });
    await page.goto(host.url); await page.waitForFunction(() => !!window.MoonYaWorkspace && !!window.MoonYaProcessUI);
    await page.evaluate(async mode => {
        localStorage.setItem('api_token', 'fixture-token'); renderAuthState({ id: 41, username: 'fixture' });
        await initializeChatHistory(); await switchMoonYaConversationMode(mode);
    }, mode);
    const emit = object => response.write('data: ' + JSON.stringify(object) + '\n\n');
    const event = (name, payload = {}, extra = {}) => {
        const object = { type: 'runtime_event', source: 'harness', run_id: 'process-fixture', root_run_id: 'process-fixture',
            turn: 1, step: 1, seq: ++seq, timestamp: new Date().toISOString(), event: name, payload, ...extra };
        emit(object); return object;
    };
    return { page, errors, warnings, requests, emit, event,
        setChangesSummary(value) { changesSummary = value; },
        setChangeConflict(value) { changeConflict = value; },
        async send() {
            response = null;
            await page.locator('.message-input').fill('检查过程折叠'); await page.locator('#sendBtn').click();
            await new Promise((resolve, reject) => { const timer = setInterval(() => { if (response) { clearInterval(timer); clearTimeout(limit); resolve(); } }, 20); const limit = setTimeout(() => { clearInterval(timer); reject(new Error('No stream request')); }, 5000); });
        },
        content(text, step = 1) { emit({ type: 'content', content: text }); if (mode === 'work') event('agent.content.delta', { delta: text }, { step }); },
        end(status) { emit({ type: 'done', ...(status?{status}:{}) }); response.end(); },
        async stop() { streams.forEach(res => res.end()); await browser.close(); await new Promise(resolve => { child.once('exit', resolve); child.stdin.end('\n'); }); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    };
}

for(const mode of ['chat','work'])for(const empty of [false,true]) {
    test(`${mode}: quota notice ${empty?'before any output':'preserves final code'}, persists once, and opens the package page after history replay`,async()=>{
        const f=await fixture(mode),{page}=f;
        try {
            await f.send();if(!empty)f.content('保留回答\n\n```js\nconst kept = true;\n```');
            f.emit({type:'credits_update',data:{exhausted:true,account:{balance:'0'}}});
            f.emit({type:'credits_exhausted'});f.emit({type:'credits_exhausted'});f.end('quota_stopped');
            await page.waitForFunction(()=>!window.isSendingMessage);
            const container=page.locator('.messages-container[data-runtime-active="1"]');
            assert.equal(await container.locator('.credits-exhausted-notice').count(),1);
            if(!empty)assert.match(await container.textContent(),/const kept = true/);
            const chatId=await page.evaluate(async()=>{await saveCurrentChat();return currentChatId;});
            await page.reload();await page.waitForFunction(()=>!!window.MoonYaMembership);
            await page.evaluate(async({id,mode})=>{await initializeChatHistory();await switchMoonYaConversationMode(mode);await loadChat(id);},{id:chatId,mode});
            const replay=page.locator('.messages-container[data-runtime-active="1"]');
            assert.equal(await replay.locator('.credits-exhausted-notice').count(),1);
            if(!empty)assert.match(await replay.textContent(),/const kept = true/);
            await replay.locator('.credits-exhausted-notice button').click();
            assert.equal(await page.locator('.membership-overlay').isVisible(),true);
            assert.deepEqual(f.errors,[]);
        }finally{await f.stop();}
    });
}

for (const terminal of ['completed', 'cancelled', 'failed']) {
    test(`conversation follow SVG dots stop on ${terminal}, follow the active chat and track the composer`, { timeout: 45000 }, async () => {
        const f = await fixture('work'), { page } = f;
        const artifacts = join(root, 'artifacts/composer-follow'); await mkdir(artifacts, { recursive: true });
        try {
            await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' }); f.event('agent.turn.started');
            f.content(Array.from({ length: 65 }, (_, i) => '回底验证第 ' + i + ' 段。').join('\n\n'));
            const container = page.locator('.messages-container[data-runtime-active="1"]');
            await container.getByText('回底验证第 64 段。', { exact: true }).waitFor();
            const button = page.locator('.conversation-follow-button:visible');
            await page.waitForFunction(() => !document.querySelector('.conversation-follow-button:not([hidden])'));
            await container.evaluate(node => { node.scrollTop = 0; });
            await button.waitFor(); await page.mouse.move(1100, 30);
            assert.equal(await button.textContent(), '');
            assert.equal(await button.locator('.follow-dots svg circle').count(), 3);
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.conversation-follow-button:not([hidden]) circle')).animationName === 'conversation-follow-bounce');
            await button.hover();
            assert.equal(await button.locator('.follow-arrow').evaluate(node => getComputedStyle(node).opacity), '1');
            assert.equal(await button.locator('.follow-dots').evaluate(node => getComputedStyle(node).opacity), '0');
            if (terminal === 'completed') await page.screenshot({ path: join(artifacts, 'hover-arrow.png') });
            await button.focus(); await page.keyboard.press('Enter');
            await button.waitFor({ state: 'hidden' });
            await container.evaluate(node => { node.scrollTop = 0; }); await button.waitFor();
            await page.locator('.message-input').fill('输入框增高\n'.repeat(10)); await page.mouse.move(1100, 30);
            const position = await button.evaluate(node => {
                const rect = node.getBoundingClientRect(), composer = document.querySelector('.input-container-wrapper').getBoundingClientRect();
                return { width: rect.width, above: composer.top - rect.bottom, centered: Math.abs(rect.left + rect.width / 2 - composer.left - composer.width / 2) };
            });
            assert.equal(position.width, 32); assert.ok(position.above >= 11 && position.above <= 13, JSON.stringify(position)); assert.ok(position.centered < 1);
            if (terminal === 'completed') {
                const chatId = await page.evaluate(() => currentChatId);
                await page.evaluate(async () => { await switchMoonYaConversationMode('chat'); });
                assert.equal(await page.locator('.conversation-follow-button:visible').count(), 0);
                f.content('\n\n后台继续输出。');
                await page.waitForFunction(() => [...document.querySelectorAll('.messages-container[hidden]')].some(node => node.textContent.includes('后台继续输出')));
                assert.equal(await page.locator('.conversation-follow-button:visible').count(), 0);
                await page.evaluate(async id => { await loadChat(id); }, chatId);
                await container.evaluate(node => { node.scrollTop = 0; });
                await button.waitFor(); await page.mouse.move(1100, 30);
                await page.screenshot({ path: join(artifacts, 'streaming.png') });
                await page.emulateMedia({ reducedMotion: 'reduce' });
                assert.equal(await button.locator('circle').first().evaluate(node => getComputedStyle(node).animationName), 'none');
                await page.emulateMedia({ reducedMotion: 'no-preference' });
                f.event('agent.turn.completed'); f.end();
            } else if (terminal === 'cancelled') { await page.waitForTimeout(350); await page.locator('#sendBtn').click(); }
            else { f.emit({ type: 'error', content: '测试输出失败' }); f.end(); }
            await page.waitForFunction(() => !window.isSendingMessage);
            await container.evaluate(node => { node.scrollTop = 0; }); await button.waitFor(); await page.mouse.move(1100, 30);
            assert.equal(await button.locator('circle').first().evaluate(node => getComputedStyle(node).animationName), 'none');
            assert.equal(await button.evaluate(node => node.classList.contains('is-streaming')), false);
            await page.screenshot({ path: join(artifacts, terminal + '.png') });
            await page.setViewportSize({ width: 480, height: 820 }); await button.waitFor();
            const narrow = await button.boundingBox(); assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 480);
            await page.screenshot({ path: join(artifacts, terminal + '-narrow.png') });
            await container.evaluate(node => { node.scrollTop = node.scrollHeight; }); await button.waitFor({ state: 'hidden' });
            assert.deepEqual(f.errors, []);
        } finally { await f.stop(); }
    });
}

test('default workspace settings load the current path and distinguish path changes from confirmed migration', { timeout: 15000 }, async () => {
    const f = await fixture('work'), { page } = f;
    try {
        await page.evaluate(() => window.openSettingsModal('datasync'));
        await page.waitForFunction(() => document.getElementById('settingsWorkspaceRoot').value === 'D:\\MoonYaDefault');
        await page.locator('#settingsWorkspaceRoot').fill('E:\\NewDefault');
        await page.locator('#settingsWorkspaceSave').click();
        await page.waitForFunction(() => document.querySelector('[data-notification-id="workspace-settings"] .toast-text')?.textContent.includes('仅新聊天'));
        assert.ok(!(await page.locator('#settingsWorkspaceStatus').textContent()).includes('仅新聊天'), 'Operation feedback appears only in the shared notification');
        assert.equal(f.requests.findLast(request => request.action === 'workspace_settings').body.migrate, false);
        page.once('dialog', dialog => dialog.dismiss()); await page.locator('#settingsWorkspaceMigrate').click();
        assert.equal(f.requests.filter(request => request.action === 'workspace_settings' && request.method === 'POST').length, 1);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#settingsWorkspaceMigrate').click();
        await page.waitForFunction(() => document.querySelector('[data-notification-id="workspace-settings"] .toast-text')?.textContent.includes('迁移完成'));
        assert.equal(f.requests.findLast(request => request.action === 'workspace_settings').body.migrate, true);
        const artifacts = join(root, 'artifacts/workspace-changes'); await mkdir(artifacts, { recursive: true });
        await page.locator('#settingsOverlay').screenshot({ path: join(artifacts, 'settings.png') });
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('running changes stay centered above the composer, update, isolate chats and become the original card on completion', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const artifacts = join(root, 'artifacts/running-changes'); await mkdir(artifacts, { recursive: true });
    const summary = { session_id: 'process-fixture', turn: 1, revision: 1, state: 'recording', total: 8, added: 72, deleted: 107,
        files: Array.from({ length: 8 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), path: 'src/file-' + index + '.js', display: 'src/file-' + index + '.js', kind: 'modified', added: 9, deleted: 13 })) };
    f.setChangesSummary({ ...summary, total: 0, files: [] });
    try {
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' }); f.event('agent.turn.started'); f.content('正在修改文件。');
        const host = page.locator('.running-changes-host'), pill = host.locator('.changes-running');
        await page.waitForFunction(() => MoonYaConversationRuntime.current().changeTurn === 1);
        assert.equal(await host.isVisible(), false);
        f.setChangesSummary(summary); await pill.waitFor();
        assert.equal(await pill.locator('.changes-title').textContent(), '8 个文件已更改');
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] .workspace-changes-card').count(), 0);
        const center = await host.evaluate(node => {
            const box = node.getBoundingClientRect(), composer = document.querySelector('.input-container-wrapper').getBoundingClientRect();
            return { centered: Math.abs(box.left + box.width / 2 - composer.left - composer.width / 2), above: composer.top - box.bottom };
        });
        assert.ok(center.centered < 1); assert.ok(center.above >= 7 && center.above <= 9);
        await page.screenshot({ path: join(artifacts, 'running.png') });
        await pill.locator('.changes-header').hover(); await pill.locator('.changes-popover:popover-open').waitFor();
        assert.equal(await pill.locator('.changes-file:visible').count(), 8);
        assert.equal(await pill.locator('[data-changes-action="undo"]').isDisabled(), true);
        await page.keyboard.press('Escape');
        f.setChangesSummary({ ...summary, added: 93 });
        await page.waitForFunction(() => document.querySelector('.changes-running .changes-added')?.textContent === '+93');
        const chatId = await page.evaluate(() => currentChatId);
        await page.evaluate(async () => { await switchMoonYaConversationMode('chat'); });
        assert.equal(await host.isVisible(), false);
        await page.evaluate(async id => { await loadChat(id); }, chatId); await pill.waitFor();
        await page.setViewportSize({ width: 480, height: 820 });
        await page.screenshot({ path: join(artifacts, 'running-narrow.png') });
        const narrow = await host.boundingBox(); assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 480);
        await page.setViewportSize({ width: 1200, height: 900 });
        const final = { ...summary, state: 'ready', added: 93 }; f.setChangesSummary(final); f.event('workspace/changes', final);
        const card = page.locator('.messages-container[data-runtime-active="1"] .workspace-changes-card');
        await page.waitForFunction(() => !!document.querySelector('.messages-container[data-runtime-active="1"] .workspace-changes-card'));
        assert.equal(await card.isVisible(), false);
        f.event('agent.turn.completed'); f.end(); await page.waitForFunction(() => !window.isSendingMessage);
        await card.waitFor(); assert.equal(await host.isVisible(), false);
        assert.equal(await card.locator('.changes-title').textContent(), '已编辑 8 个文件');
        assert.equal(await card.locator('.changes-file:visible').count(), 3);
        await page.screenshot({ path: join(artifacts, 'completed.png') });
        const history = await page.evaluate(async () => { await saveCurrentChat(); return JSON.stringify(getChatHistory().find(chat => chat.id === currentChatId)); });
        assert.ok(!history.includes('changes-running') && !history.includes('running-changes-host'));
        assert.ok(f.requests.some(request => request.action === 'changes_summary' && request.query.turn === '1'));
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('turn-end changes card keeps the original file list, reviews, confirms undo and rebinds after history replay', { timeout: 45000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const artifacts = join(root, 'artifacts/workspace-changes'); await mkdir(artifacts, { recursive: true });
    const summary = { session_id: 'process-fixture', turn: 1, revision: 1, state: 'ready', total: 29, added: 683, deleted: 130,
        files: Array.from({ length: 29 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'),
            path: ['MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserPreferences.cs', 'MoonYa-Harness/src/server.mjs', 'MoonYa-Harness/src/tools.mjs'][index] || 'src/file-' + index + '.js',
            display: ['MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserPreferences.cs', 'MoonYa-Harness/src/server.mjs', 'MoonYa-Harness/src/tools.mjs'][index] || 'src/file-' + index + '.js',
            kind: 'modified', added: [50, 9, 5][index] ?? 2, deleted: [0, 6, 3][index] ?? 1 })) };
    f.setChangesSummary(summary);
    try {
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' });
        f.event('agent.turn.started'); f.content('文件修改已经完成，这是本轮的最终回复。');
        const announced = f.event('workspace/changes', summary); f.event('agent.turn.completed'); f.end();
        const card = page.locator('.messages-container[data-runtime-active="1"] .workspace-changes-card');
        await card.waitFor();
        await page.waitForFunction(() => document.querySelector('.workspace-changes-card')?.closest('.message-content')?.lastElementChild?.classList.contains('workspace-changes-card'));
        const duration = page.locator('.messages-container[data-runtime-active="1"] .message.ai > .turn-duration');
        await duration.click(); await settleMotion(page);
        assert.equal(await card.isVisible(), true);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('文件修改已经完成，这是本轮的最终回复。', { exact: true }).isVisible(), true);
        await duration.click(); await settleMotion(page);
        assert.equal(await card.locator('.changes-file:visible').count(), 3);
        assert.equal(await card.locator('.changes-title').textContent(), '已编辑 29 个文件');
        assert.equal(await card.locator('.changes-header .changes-added').textContent(), '+683');
        await card.scrollIntoViewIfNeeded(); await card.screenshot({ path: join(artifacts, 'card.png') });
        await page.screenshot({ path: join(artifacts, 'conversation.png') });
        await card.locator('[data-changes-action="expand"]').click(); assert.equal(await card.locator('.changes-file:visible').count(), 29);
        await card.locator('[data-changes-action="expand"]').click(); assert.equal(await card.locator('.changes-file:visible').count(), 3);
        await card.locator('[data-changes-action="review"]').click(); await page.locator('.changes-line-add').waitFor();
        assert.match(await page.locator('.changes-line-add').textContent(), /new value/);
        await page.locator('.changes-dialog').screenshot({ path: join(artifacts, 'diff.png') });
        await page.keyboard.press('Escape');
        await card.locator('.changes-file').nth(1).click(); await page.locator('.changes-diff-name').waitFor();
        assert.equal(await page.locator('.changes-diff-name').textContent(), summary.files[1].display);
        assert.equal(f.requests.findLast(request => request.action === 'changes_diff').query.file_id, summary.files[1].id);
        await page.keyboard.press('Escape');
        f.setChangeConflict(true);
        await card.locator('[data-changes-action="undo"]').click();
        assert.equal(f.requests.filter(request => request.action === 'changes_undo').length, 0);
        await page.locator('.changes-confirm button', { hasText: '确认撤销' }).click();
        await page.waitForFunction(() => document.querySelector('.workspace-changes-card .changes-status').textContent.includes('整轮未撤销'));
        assert.equal(await card.locator('.changes-title').textContent(), '已编辑 29 个文件');
        // Round replay restores HTML coordinates, then fetches authoritative state and delegated actions.
        const chatId = await page.evaluate(async () => { await saveCurrentChat(); return currentChatId; });
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaConversationRuntime);
        await page.evaluate(async id => { renderAuthState({ id: 41, username: 'fixture' }); await initializeChatHistory(); await switchMoonYaConversationMode('work'); await loadChat(id); }, chatId);
        await page.waitForFunction(() => document.querySelector('.workspace-changes-card .changes-title').textContent === '已编辑 29 个文件');
        f.setChangeConflict(false);
        await card.locator('[data-changes-action="undo"]').click(); await page.locator('.changes-confirm button', { hasText: '确认撤销' }).click();
        await page.waitForFunction(() => document.querySelector('.workspace-changes-card .changes-title').textContent === '已撤销 29 个文件');
        assert.equal(await card.locator('[data-changes-action="undo"]').isDisabled(), true);
        await page.setViewportSize({ width: 480, height: 820 }); await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: join(artifacts, 'narrow.png') });
        assert.equal(await card.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

test('Work output keeps one visible conversation viewport and follows text below the initial height', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const artifacts = join(root, 'artifacts/chat-viewport'); await mkdir(artifacts, { recursive: true });
    try {
        await page.setViewportSize({ width: 1400, height: 820 });
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' });
        f.event('agent.turn.started'); f.event('agent.reasoning.delta', { delta: '准备输出长正文。' });
        f.content('第一段正文。\n\n');
        await page.locator('.messages-container[data-runtime-active="1"] .turn-duration').waitFor();
        await page.screenshot({ path: join(artifacts, 'streaming-viewport.png') });
        const layout = await page.evaluate(() => {
            const main = document.querySelector('.main-content');
            return { mainHeight: main.clientHeight, containers: [...main.querySelectorAll('.messages-container')].map(node => ({
                key: node.dataset.conversationRuntime, active: node.dataset.runtimeActive, hidden: node.hidden,
                display: getComputedStyle(node).display, height: node.clientHeight
            })) };
        });
        assert.equal(layout.containers.filter(node => node.display !== 'none').length, 1, JSON.stringify(layout));
        const lookup = await page.evaluate(() => {
            const current = MoonYaConversationRuntime.current();
            const implicit = getConversationRuntime();
            const background = getConversationRuntime('background-viewport-fixture');
            return { same: implicit === current, hidden: background.container.hidden,
                inactive: background.container.dataset.runtimeActive, height: background.container.clientHeight };
        });
        assert.deepEqual(lookup, { same: true, hidden: true, inactive: '0', height: 0 });
        for (let i = 0; i < 30; i++) {
            f.content('持续输出第 ' + i + ' 行。\n\n');
            await page.waitForFunction(i => document.querySelector('.messages-container[data-runtime-active="1"]').textContent.includes('持续输出第 ' + i + ' 行。'), i);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const gap = await page.locator('.messages-container[data-runtime-active="1"]').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
            assert.ok(gap <= 2, 'stream must follow the newest text: ' + gap);
        }
        f.event('agent.turn.completed'); f.end();
        await page.waitForFunction(() => !window.isSendingMessage);
        const bounds = await page.evaluate(() => {
            const container = document.querySelector('.messages-container[data-runtime-active="1"]');
            const last = [...container.querySelectorAll('.ai-text-segment p')].at(-1);
            return { height: container.clientHeight, lastBottom: last.getBoundingClientRect().bottom,
                composerTop: document.querySelector('.input-container-wrapper').getBoundingClientRect().top };
        });
        assert.ok(bounds.height > layout.mainHeight * .8, JSON.stringify(bounds));
        assert.ok(bounds.lastBottom <= bounds.composerTop, JSON.stringify(bounds));
        await page.screenshot({ path: join(artifacts, 'completed-viewport.png') });
        const chatId = await page.evaluate(async () => { await saveCurrentChat(); return currentChatId; });
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaConversationRuntime);
        await page.evaluate(async id => {
            renderAuthState({ id: 41, username: 'fixture' }); await initializeChatHistory();
            await switchMoonYaConversationMode('work'); await loadChat(id);
        }, chatId);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const restored = await page.evaluate(() => ({
            visible: [...document.querySelectorAll('.messages-container')].filter(node => getComputedStyle(node).display !== 'none').length,
            height: document.querySelector('.messages-container[data-runtime-active="1"]').clientHeight
        }));
        assert.equal(restored.visible, 1);
        assert.ok(Math.abs(restored.height - bounds.height) <= 1, 'refresh must not be needed to recover the viewport: ' + JSON.stringify({ bounds, restored }));
        assert.match(await page.locator('.messages-container[data-runtime-active="1"]').textContent(), /持续输出第 29 行/);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('duration collapse includes commentary when more activity arrives and retains all final reply blocks', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    try {
        await motionFixture(page, 'soft');
        await page.evaluate(() => {
            const { message, content, sequence } = motionFixture;
            MoonYaProcessUI.boundary(sequence);
            content.insertAdjacentHTML('beforeend', '<div class="ai-text-segment">过程说明</div><div class="plaintext-card">过程代码</div>');
            MoonYaProcessUI.duration(message, 1000);
        });
        const duration = page.locator('#motion-fixture > .turn-duration');
        await duration.click(); await settleMotion(page);
        await page.evaluate(() => {
            const { content, sequence } = motionFixture;
            MoonYaProcessUI.activity(sequence);
            MoonYaProcessUI.boundary(sequence);
            content.insertAdjacentHTML('beforeend', '<div class="ai-text-segment">最终说明</div><div class="plaintext-card">最终代码</div><div class="ai-text-segment">最终补充<img src="/icon.png" alt="最终图片" width="24"></div>');
            MoonYaProcessUI.finish(sequence);
        });
        const message = page.locator('#motion-fixture');
        assert.equal(await message.getByText('过程说明', { exact: true }).isVisible(), false);
        assert.equal(await message.getByText('过程代码', { exact: true }).isVisible(), false);
        assert.equal(await message.locator('.process-segment:visible').count(), 0);
        for (const text of ['最终说明', '最终代码', '最终补充'])
            assert.equal(await message.getByText(text, { exact: true }).isVisible(), true, text);
        assert.equal(await message.locator('img[alt="最终图片"]').isVisible(), true);
        await duration.focus(); await page.keyboard.press('Enter'); await settleMotion(page);
        assert.equal(await message.getByText('过程说明', { exact: true }).isVisible(), true);
        assert.equal(await message.getByText('过程代码', { exact: true }).isVisible(), true);
        assert.equal(await message.locator('.process-segment:visible').count(), 2);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('Harness preserves chronological segments, parallel state, original owners and ordered history', { timeout: 60000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const artifacts = join(root, 'artifacts/process-disclosures'); await mkdir(artifacts, { recursive: true });
    try {
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' });
        f.event('agent.turn.started'); f.event('agent.reasoning.delta', { delta: '先检查文件。' });
        const segments = page.locator('.messages-container[data-runtime-active="1"] .process-segment');
        await segments.first().waitFor();
        assert.equal(await segments.first().locator('.turn-process-label').textContent(), '正在思考');
        assert.equal(await segments.first().locator('.turn-process-body').isVisible(), false);
        f.content('准备修改文件。'); f.event('assistant.message', { content: '准备修改文件。', tool_calls: [{ id: 'edit1' }] });
        f.event('model.activity', { phase: 'tool_arguments' });
        await page.waitForFunction(() => document.querySelectorAll('.process-segment').length === 2);
        f.event('tool.started', { name: 'edit_file', tool_key: 'edit_file', arguments: { command: 'str_replace', path: 'D:\\Fixture\\a.js' } }, { tool_call_id: 'edit1' });
        f.event('tool.started', { name: 'execute_command', tool_key: 'execute_command', arguments: { command: 'node --check a.js' } }, { tool_call_id: 'cmd1' });
        await page.waitForFunction(() => [...document.querySelectorAll('.turn-process-label')].some(node => node.textContent === '编辑文件，运行命令'));
        const second = segments.nth(1), header = second.locator(':scope > .turn-process-header');
        await header.click(); await second.locator('.tool-row').first().waitFor();
        f.event('agent.reasoning.delta', { delta: '检查仍在运行。' }, { step: 2 });
        await page.waitForFunction(() => document.querySelectorAll('.reasoning-row').length === 2);
        assert.equal(await header.getAttribute('aria-expanded'), 'true');
        assert.equal(await second.locator('.turn-process-label').textContent(), '编辑文件，运行命令');
        await page.waitForFunction(() => document.getAnimations().every(animation => !animation.effect?.target?.classList?.contains('process-disclosure-body')));
        await settleMotion(page);
        const alignment = await second.evaluate(segment => {
            const left = node => node.getBoundingClientRect().left;
            const prose = segment.parentElement.querySelector('.ai-text-segment');
            return {
                prose: left(prose),
                arrow: left(segment.querySelector(':scope > .turn-process-header > .process-arrow')),
                labelRight: segment.querySelector('.turn-process-label').getBoundingClientRect().right,
                icons: [...segment.querySelectorAll('.turn-process-leading, .tool-row-leading, .reasoning-row-leading')].map(left),
                labels: [...segment.querySelectorAll('.turn-process-label, .tool-row-title, .reasoning-row-title')].map(left)
            };
        });
        assert.ok(alignment.icons.every(left => Math.abs(left - alignment.prose) < 1), 'activity icons share the prose left edge');
        assert.ok(alignment.labels.every(left => Math.abs(left - alignment.prose - 22) < 1), 'process and activity labels share one column');
        assert.ok(Math.abs(alignment.arrow - alignment.labelRight - 6) < 1, 'header arrow follows the text on the right');
        assert.equal(await second.locator('.turn-process-leading').evaluate(node => getComputedStyle(node).opacity), '1');
        await second.locator('.turn-process-leading').screenshot({ path: join(artifacts, 'edit-pencil.png') });
        await page.screenshot({ path: join(artifacts, 'expanded.png') });
        f.content('文件已提交，继续验证。', 2);
        const failed = f.event('tool.failed', { name: 'execute_command', tool_key: 'execute_command', ok: false,
            result: { success: false, stderr: 'SyntaxError: fixture', exit_code: 1 } }, { tool_call_id: 'cmd1' });
        f.emit(failed);
        f.event('tool.completed', { name: 'edit_file', tool_key: 'edit_file', result: { success: true, path: 'D:/Fixture/a.js', added_lines: 2, removed_lines: 1 } }, { tool_call_id: 'edit1' });
        f.event('tool.started', { name: 'edit_file', tool_key: 'edit_file', arguments: { command: 'insert', path: 'd:/fixture/./a.js' } }, { tool_call_id: 'edit2' });
        // A new activity after commentary belongs to a new segment.
        f.event('tool.completed', { name: 'edit_file', tool_key: 'edit_file', result: { success: true } }, { tool_call_id: 'edit2' });
        f.event('tool.started', { name: 'get_command_status', tool_key: 'get_command_status', arguments: { command_id: 'background-1' } }, { tool_call_id: 'poll' });
        f.event('tool.completed', { name: 'get_command_status', tool_key: 'get_command_status', result: { success: true } }, { tool_call_id: 'poll' });
        const finalContent = '最终结果。\n```js\nconst retained = 1;\n```\n代码已保留。';
        f.content(finalContent, 3); f.event('assistant.message', { content: finalContent, tool_calls: [] }, { step: 3 });
        f.event('agent.turn.completed'); f.end();
        await page.waitForFunction(() => !isSendingMessage);
        assert.equal(await segments.count(), 3);
        assert.equal(await second.locator('.turn-process-label').textContent(), '编辑了 1 个文件，运行了 1 个命令');
        assert.equal(await header.getAttribute('aria-expanded'), 'true');
        assert.equal(await second.locator('[data-tool="execute_command"]').count(), 1);
        const duration = page.locator('.messages-container[data-runtime-active="1"] .message.ai > .turn-duration');
        assert.equal(await duration.count(), 1);
        assert.match(await duration.textContent(), /^用时 /);
        await duration.click();
        await page.waitForFunction(() => [...document.querySelectorAll('.process-segment')].every(node => node.hidden));
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] .message.ai').getByText('准备修改文件。', { exact: true }).isVisible(), false);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] .message.ai').getByText('文件已提交，继续验证。', { exact: true }).isVisible(), false);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] .message.ai').getByText('最终结果。', { exact: true }).isVisible(), true);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] code').filter({hasText:'const retained'}).isVisible(), true);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('代码已保留。', { exact: true }).isVisible(), true);
        await page.screenshot({ path: join(artifacts, 'duration-collapsed.png') });
        await duration.click();
        await second.waitFor({ state: 'visible' });
        await settleMotion(page);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('准备修改文件。', { exact: true }).isVisible(), true);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('文件已提交，继续验证。', { exact: true }).isVisible(), true);
        assert.equal(await header.getAttribute('aria-expanded'), 'true');
        const command = second.locator('[data-tool="execute_command"]');
        await command.locator('.codex-tool-main').click(); await command.locator('.codex-tool-detail').waitFor();
        assert.match(await command.locator('.codex-tool-detail').textContent(), /失败.*exit 1/);
        assert.match(await command.locator('.codex-tool-detail').textContent(), /SyntaxError/);
        await header.click();
        await page.waitForFunction(() => document.querySelectorAll('.process-segment')[1].querySelector('.turn-process-body').hidden);
        await page.mouse.move(1100, 50); await page.waitForFunction(() => document.getAnimations().every(animation => !animation.effect?.target?.classList?.contains('process-disclosure-body')));
        await page.screenshot({ path: join(artifacts, 'collapsed.png') });
        await header.hover({position:{x:30,y:12}});
        await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('.process-segment')[1].querySelector('.process-arrow')).opacity === '1');
        await page.waitForFunction(() => document.getAnimations().every(animation => !animation.effect?.target?.classList?.contains('process-disclosure-body')));
        await page.screenshot({ path: join(artifacts, 'hover.png') });
        await duration.click(); await settleMotion(page);
        const history = await page.evaluate(async () => {
            const message = document.querySelector('.messages-container[data-runtime-active="1"] .message.ai');
            MoonYaProcessUI.endDuration(message, 230000);
            const image = document.createElement('img'); image.src = '/icon.png'; image.alt = '保留图片'; image.style.width = '40px';
            message.querySelector('.ai-text-segment:last-child').appendChild(image);
            await saveCurrentChat(); const chat = getChatHistory().find(item => item.id === currentChatId);
            return { id: currentChatId, presentations: chat.messages.filter(item => item.type === 'ai').map(item => item.presentation) };
        });
        assert.deepEqual(history.presentations[0].blocks.slice(0,6).map(block => block.kind), ['process', 'content', 'process', 'content', 'process', 'content']);
        assert.ok(history.presentations[0].blocks.some(block => block.html.includes('retained')));
        assert.ok(history.presentations[0].blocks.some(block => block.html.includes('alt="保留图片"')));
        assert.ok(history.presentations[0].blocks.filter(block => block.kind === 'content').every(block => !/\bhidden(?:\s|=|>)/.test(block.html)), 'saving a collapsed turn preserves visible replayable prose');
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaConversationRuntime);
        await page.evaluate(async id => {
            renderAuthState({ id: 41, username: 'fixture' }); await initializeChatHistory();
            await switchMoonYaConversationMode('work'); await loadChat(id);
        }, history.id);
        await page.waitForFunction(() => document.querySelectorAll('.messages-container[data-runtime-active="1"] .process-segment').length === 3);
        assert.equal(await segments.locator('.turn-process-body:visible').count(), 0);
        assert.equal(await duration.textContent(), '用时 3分50秒');
        await page.screenshot({ path: join(artifacts, 'duration.png') });
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('准备修改文件。', { exact: true }).count(), 1);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('最终结果。', { exact: true }).count(), 1);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] img[alt="保留图片"]').count(), 1);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] code').filter({hasText:'const retained'}).count(), 1);
        await duration.click(); await settleMotion(page);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('准备修改文件。', { exact: true }).isVisible(), false);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('文件已提交，继续验证。', { exact: true }).isVisible(), false);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"]').getByText('最终结果。', { exact: true }).isVisible(), true);
        assert.equal(await page.locator('.messages-container[data-runtime-active="1"] img[alt="保留图片"]').isVisible(), true);
        await duration.click(); await settleMotion(page);
        await page.setViewportSize({ width: 460, height: 740 });
        await segments.nth(1).locator('.turn-process-header').focus(); await page.keyboard.press('Enter');
        await segments.nth(1).locator('.tool-row').first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.waitForFunction(() => document.getAnimations().every(animation => !animation.effect?.target?.classList?.contains('process-disclosure-body')));
        await page.screenshot({ path: join(artifacts, 'narrow.png') });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

test('stopping a Work reply preserves chronological output, code and cancellation across history reload', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const container = page.locator('.messages-container[data-runtime-active="1"]');
    try {
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' });
        f.event('agent.turn.started'); f.event('agent.reasoning.delta', { delta: '保留思考内容。' });
        f.content('第一段正文。'); f.event('assistant.message', { content: '第一段正文。' });
        f.event('tool.started', { name: 'execute_command', arguments: { command: 'echo retained' } }, { tool_call_id: 'retained-command' });
        f.content('第二段正文。\n```js\nconst partial = 1;\n');
        await container.locator('code').filter({ hasText: 'const partial = 1;' }).waitFor();
        await page.waitForTimeout(350); // The button deliberately debounces clicks for 300ms.
        await page.locator('#sendBtn').click();
        await page.waitForFunction(() => !window.isSendingMessage);
        const message = container.locator('.message.ai');
        assert.equal(await message.count(), 1);
        assert.match(await message.textContent(), /第一段正文/);
        assert.match(await message.textContent(), /第二段正文/);
        assert.match(await message.textContent(), /保留思考内容/);
        assert.equal(await message.locator('.turn-status').textContent(), '已停止');
        assert.equal(await message.locator('.loading-indicator').count(), 0);
        assert.equal(await message.locator('.process-segment.is-running').count(), 0);
        assert.equal(await container.getByText('说停就停~等待新的工作安排。').count(), 0);
        await page.evaluate(() => { stopCurrentMoonYaResponse(); stopCurrentMoonYaResponse(); });
        assert.equal(await message.locator('.turn-status').count(), 1);
        assert.ok(f.requests.some(req => req.action === 'cancel'));
        const history = await page.evaluate(async () => {
            await saveCurrentChat();
            const chat = getChatHistory().find(item => item.id === currentChatId);
            return { id: chat.id, message: chat.messages.find(item => item.type === 'ai') };
        });
        assert.equal(history.message.presentation.status, 'cancelled');
        assert.match(history.message.content, /const partial = 1/);
        const artifacts = join(root, 'artifacts/process-disclosures'); await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, 'stopped.png') });
        await page.evaluate(id => loadChat(id), history.id);
        assert.equal(await message.locator('.turn-status').textContent(), '已停止');
        assert.match(await message.textContent(), /第一段正文/);
        assert.equal(await message.locator('code').filter({ hasText: 'const partial = 1;' }).count(), 1);
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaConversationRuntime);
        await page.evaluate(async id => {
            renderAuthState({ id: 41, username: 'fixture' }); await initializeChatHistory();
            await switchMoonYaConversationMode('work'); await loadChat(id);
        }, history.id);
        assert.equal(await message.locator('.turn-status').textContent(), '已停止');
        assert.match(await message.textContent(), /第二段正文/);
        await f.send(); f.content('中断之后的新回复。'); f.end();
        await page.waitForFunction(() => !window.isSendingMessage);
        assert.equal(await container.locator('.message.ai').count(), 2);
        assert.match(await container.locator('.message.ai').last().textContent(), /中断之后的新回复/);
        assert.equal(await container.locator('.message.ai').last().locator('.turn-status').count(), 0);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

for (const mode of ['chat', 'work']) {
    test(`${mode}: stop flushes buffered output and old abort cannot reset the next send`, { timeout: 30000 }, async () => {
        const f = await fixture(mode), { page } = f;
        const container = page.locator('.messages-container[data-runtime-active="1"]');
        try {
            await f.send();
            if (mode === 'work') { f.emit({ type: 'harness_session', session_id: 'process-fixture' }); f.event('agent.turn.started'); }
            await page.evaluate(() => {
                window.__savedRaf = window.requestAnimationFrame;
                window.__pendingFrames = [];
                window.requestAnimationFrame = callback => window.__pendingFrames.push(callback);
            });
            f.content('尚未执行动画帧的正文。');
            await page.waitForFunction(() => document.querySelector('.ai-text-segment'));
            assert.equal(await container.locator('.ai-text-segment').textContent(), '');
            await page.evaluate(() => {
                stopCurrentMoonYaResponse();
                window.requestAnimationFrame = window.__savedRaf;
                for (const callback of window.__pendingFrames) callback(performance.now());
                // Start the next send before the aborted request's catch callback runs.
                document.querySelector('.message-input').value = '下一条消息';
                void sendMessage();
            });
            await page.waitForFunction(() => window.isSendingMessage && !!MoonYaConversationRuntime.current().abortController);
            assert.match(await container.locator('.message.ai').first().textContent(), /尚未执行动画帧的正文/);
            assert.equal(await container.locator('.turn-status').count(), 1);
            await page.waitForTimeout(350);
            assert.equal(await page.evaluate(() => window.isSendingMessage), true);
            assert.equal(await page.locator('#sendBtn').getAttribute('data-state'), 'stop');
            f.content('新的请求仍正常输出。'); f.end();
            await page.waitForFunction(() => !window.isSendingMessage);
            assert.match(await container.locator('.message.ai').last().textContent(), /新的请求仍正常输出/);
            assert.equal(await container.locator('.message.ai').last().locator('.turn-status').count(), 0);
            assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
        } finally { await f.stop(); }
    });
}

test('Enter stops reasoning-only output, and runtime cancellation preserves partial replies', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    const container = page.locator('.messages-container[data-runtime-active="1"]');
    try {
        await f.send(); f.emit({ type: 'harness_session', session_id: 'process-fixture' });
        f.event('agent.turn.started'); f.event('agent.reasoning.delta', { delta: '仅有思考也要保留。' });
        await container.locator('.reasoning-row').waitFor({ state: 'attached' });
        await page.locator('.message-input').press('Enter');
        await page.waitForFunction(() => !window.isSendingMessage);
        assert.match(await container.locator('.message.ai').textContent(), /仅有思考也要保留/);
        assert.equal(await container.locator('.turn-status').textContent(), '已停止');
        await page.waitForTimeout(350); await f.send();
        f.event('agent.turn.started', {}, { turn: 2 }); f.content('运行时取消前的内容。');
        f.event('turn.cancelled', { reason: 'user' }, { turn: 2 });
        f.emit({ type: 'error', error_code: 'turn.cancelled', content: '任务已停止' });
        f.content('不应出现的迟到内容。');
        await page.waitForFunction(() => !window.isSendingMessage);
        assert.match(await container.locator('.message.ai').last().textContent(), /运行时取消前的内容/);
        assert.doesNotMatch(await container.textContent(), /不应出现|任务已停止/);
        assert.equal(await container.locator('.turn-status').count(), 2);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

test('stopping before output keeps one stopped placeholder; direct abort preserves Chat thinking', { timeout: 30000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    const container = page.locator('.messages-container[data-runtime-active="1"]');
    try {
        await f.send(); await page.evaluate(() => stopCurrentMoonYaResponse());
        await page.waitForFunction(() => !window.isSendingMessage);
        assert.equal(await container.locator('.message.ai').count(), 1);
        assert.equal(await container.locator('.turn-status').textContent(), '已停止');
        assert.equal(await container.locator('.loading-indicator').count(), 0);
        await page.waitForTimeout(350); await f.send();
        f.emit({ type: 'thinking', content: '普通聊天的思考内容。' });
        await page.waitForFunction(() => [...document.querySelectorAll('.reasoning-row-body')].some(node => node.textContent.includes('普通聊天')));
        await page.evaluate(() => MoonYaConversationRuntime.current().abortController.abort());
        await page.waitForFunction(() => !window.isSendingMessage);
        assert.match(await container.locator('.message.ai').last().textContent(), /普通聊天的思考内容/);
        assert.equal(await container.locator('.turn-status').count(), 2);
        assert.equal(await container.locator('.loading-indicator').count(), 0);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

test('Chat legacy reasoning and commands use compact animated segments with real failure detail', { timeout: 45000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    try {
        await f.send(); f.content('先检查脚本。');
        f.emit({ type: 'thinking', content: '生成检查命令。' });
        const segments = page.locator('.messages-container[data-runtime-active="1"] .process-segment');
        await segments.first().waitFor();
        assert.equal(await segments.first().locator('.turn-process-label').textContent(), '正在思考');
        f.emit({ type: 'execution_code', code: 'node --check a.js', exec_type: 'command' });
        await page.waitForFunction(() => document.querySelector('.process-segment .turn-process-label')?.textContent === '运行命令');
        f.emit({ type: 'execution_result', result: { status: 'failure', error: 'SyntaxError', exit_code: 1, output: 'fixture output' } });
        f.emit({ type: 'command_started', command_id: 'legacy-bg', command: 'echo background' });
        f.emit({ type: 'command_output', command_id: 'legacy-bg', chunk: 'background output', done: true, exit_code: 0 });
        f.content('检查完成。'); f.end(); await page.waitForFunction(() => !isSendingMessage);
        assert.equal(await segments.first().locator('.turn-process-label').textContent(), '运行了 2 个命令');
        await segments.first().locator('.turn-process-header').click();
        await segments.first().locator('.codex-tool-main').first().click();
        await segments.first().locator('.codex-tool-detail').first().waitFor();
        assert.match(await segments.first().locator('.codex-tool-detail').first().textContent(), /SyntaxError/);
        assert.equal(await segments.first().locator('.my-bgcmd-card[data-cid="legacy-bg"] .btn-stop').count(), 1);
        assert.match(await segments.first().locator('.my-bgcmd-body').textContent(), /background output/);
        // Mid-animation reversal settles at the user's last choice.
        await page.evaluate(() => { const header = document.querySelector('.process-segment .turn-process-header'); header.click(); header.click(); header.click(); });
        await page.waitForFunction(() => document.querySelector('.process-segment .turn-process-body').hidden);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await segments.first().locator('.turn-process-header').click();
        assert.equal(await segments.first().locator('.turn-process-body').isVisible(), true);
        assert.deepEqual(f.errors, []); assert.deepEqual(f.warnings, []);
    } finally { await f.stop(); }
});

test('shared summary deduplicates file paths, excludes command polling and preserves detail focus', { timeout: 30000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    try {
        const result = await page.evaluate(() => {
            const host = document.createElement('div'); document.body.append(host);
            const sequence = MoonYaProcessUI.sequence(host, 'count-fixture');
            for (const [id, path] of [['one', 'D:\\Fixture\\a.js'], ['two', 'd:/fixture/./a.js']]) MoonYaProcessUI.tool(sequence, id, { tool: 'edit_file', args: { command: 'insert', path }, state: 'success' });
            MoonYaProcessUI.tool(sequence, 'view', { tool: 'edit_file', args: { command: 'view', path: 'a.js' }, state: 'success' });
            MoonYaProcessUI.tool(sequence, 'command', { tool: 'execute_command', args: { command: 'echo fixture' }, state: 'failure' });
            for (const tool of ['get_command_status', 'stop_command']) MoonYaProcessUI.tool(sequence, tool, { tool, args: { command_id: 'one' }, state: 'success' });
            MoonYaProcessUI.finish(sequence);
            return { label: sequence.segments[0].label.textContent, files: sequence.tools.size, read: sequence.tools.get('view').row.dataset.activityKind };
        });
        assert.equal(result.label, '编辑了 1 个文件，运行了 1 个命令，读取了 1 项内容');
        assert.equal(result.read, 'read'); assert.equal(result.files, 6);
        const background = await page.evaluate(() => {
            const host = document.createElement('div'); document.body.append(host);
            const sequence = MoonYaProcessUI.sequence(host, 'background-fixture');
            MoonYaProcessUI.tool(sequence, 'start', { tool: 'execute_command', args: { command: 'sleep 2' }, state: 'success', result: { success: true, status: 'running', command_id: 'bg' } });
            MoonYaProcessUI.activity(sequence);
            const live = sequence.segments[0].label.textContent;
            MoonYaProcessUI.tool(sequence, 'poll', { tool: 'get_command_status', args: { command_id: 'bg' }, state: 'success', result: { success: true, status: 'done', command_id: 'bg', command_ok: false, exit_code: 1 } });
            MoonYaProcessUI.finish(sequence);
            return { live, summary: sequence.segments[0].label.textContent, state: sequence.tools.get('start').row.dataset.state };
        });
        assert.deepEqual(background, { live: '运行命令', summary: '运行了 1 个命令', state: 'failure' });
        const legacy = await page.evaluate(() => {
            const msg = { presentation: { version: 2, turnKey: 'old:turn:1', elapsedMs: 1234, trace: [{ kind: 'html', html: '<div class="tool-row" data-tool="execute_command" data-activity-kind="command" data-state="success"><div class="codex-tool-main">旧命令</div></div>' }], finalContent: '<p>旧正文</p>' } };
            hydrateCodexPresentation(msg);
            const shell = document.createElement('div'); shell.innerHTML = msg.statuses[0].html; MoonYaProcessUI.normalize(shell);
            return { content: msg.content, label: shell.querySelector('.turn-process-label').textContent, hidden: shell.querySelector('.turn-process-body').hidden };
        });
        assert.deepEqual(legacy, { content: '<p>旧正文</p>', label: '运行了 1 个命令', hidden: true });
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('process animation settings are keyboard accessible, immediate and persistent with safe defaults', { timeout: 30000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    try {
        assert.equal(await page.evaluate(() => MoonYaProcessUI.getAnimationStyle()), 'soft');
        await page.evaluate(() => openSettingsModal('appearance'));
        const glass = page.locator('[data-process-animation-choice="glass"]');
        await glass.focus(); await page.keyboard.press('Enter');
        assert.equal(await glass.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('[data-process-animation-choice="soft"]').getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.processAnimationStyle), 'glass');
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaProcessUI);
        assert.equal(await page.evaluate(() => MoonYaProcessUI.getAnimationStyle()), 'glass');
        await page.evaluate(() => localStorage.setItem('moonya.processAnimationStyle', 'invalid'));
        await page.reload(); await page.waitForFunction(() => !!window.MoonYaProcessUI);
        assert.equal(await page.evaluate(() => MoonYaProcessUI.getAnimationStyle()), 'soft');
        await page.evaluate(() => {
            dispatchEvent(new StorageEvent('storage', { key: 'moonya.processAnimationStyle', newValue: 'glass' }));
            openSettingsModal('appearance');
        });
        assert.equal(await glass.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('both process styles animate real state changes, cancel interruptions and serialize clean history', { timeout: 45000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    const artifacts = join(root, 'artifacts/process-motion'); await mkdir(artifacts, { recursive: true });
    try {
        for (const style of ['soft', 'glass']) {
            await motionFixture(page, style);
            const timing = await page.evaluate(() => {
                const { sequence } = motionFixture;
                MoonYaProcessUI.tool(sequence, 'edit', { tool: 'edit_file', args: { path: 'D:/Fixture/a.js' }, state: 'executing' });
                MoonYaProcessUI.flush(); // Header transitions are coalesced once per frame.
                return document.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && animation.effect?.target === sequence.segments[0].label).map(animation => animation.effect.getTiming().duration);
            });
            assert.deepEqual(timing, [style === 'soft' ? 240 : 360]);
            const activeSnapshot = await page.evaluate(() => JSON.stringify(buildCodexPresentation(motionFixture.message, motionFixture.content, [])));
            assert.doesNotMatch(activeSnapshot, /process-motion-ghost|data-process-active/);
            await page.screenshot({ path: join(artifacts, style + '-start.png') });
            await page.waitForTimeout(100);
            await page.screenshot({ path: join(artifacts, style + '-middle.png') });
            await settleMotion(page);
            const appearance = await page.evaluate(() => {
                const segment = motionFixture.sequence.segments[0], label = getComputedStyle(segment.label), header = getComputedStyle(segment.header);
                return { background: header.backgroundImage, shadow: header.boxShadow, blur: header.backdropFilter,
                    sweep: label.animationName, gradient: label.backgroundImage, clip: label.backgroundClip,
                    overlay: getComputedStyle(segment.header, '::before').content };
            });
            assert.equal(appearance.background, 'none'); assert.equal(appearance.shadow, 'none'); assert.equal(appearance.blur, 'none');
            assert.equal(appearance.overlay, 'none'); assert.equal(appearance.sweep, 'process-white-sweep');
            assert.equal(appearance.clip, 'text'); assert.match(appearance.gradient, /rgb\(255, 255, 255\)/);
            await page.screenshot({ path: join(artifacts, style + '-settled.png') });
            const repeated = await page.evaluate(() => {
                const { sequence } = motionFixture;
                MoonYaProcessUI.refresh(sequence.segments[0]);
                MoonYaProcessUI.tool(sequence, 'edit', { result: { progress: '更多输出' } });
                MoonYaProcessUI.reason(sequence, 'think', '第一段思考', true);
                MoonYaProcessUI.reason(sequence, 'think', '第一段思考\n持续输出', true);
                return document.querySelectorAll('.process-motion-ghost').length;
            });
            assert.equal(repeated, 0, 'unchanged labels/icons and streaming text do not restart transitions');
            await page.locator('#motion-fixture .turn-process-header').click(); await settleMotion(page);
            const reasoningSweep = await page.evaluate(() => {
                const row = motionFixture.sequence.reasons.get('think');
                MoonYaProcessUI.reason(motionFixture.sequence, 'think', '检查整行扫光，包括思考标题和持续更新的内容摘要。Checking interpolation, quotes and command syntax across the entire reasoning row.', true);
                const sweep = row.getAnimations({ subtree: true }).find(animation => animation.animationName === 'process-white-sweep');
                sweep.pause(); sweep.currentTime = 350;
                return { duration: sweep.effect.getTiming().duration, blend: getComputedStyle(row, '::after').mixBlendMode,
                    background: getComputedStyle(row).backgroundImage,
                    titleAnimation: getComputedStyle(row.querySelector('.reasoning-row-title')).animationName,
                    summaryFill: getComputedStyle(row.querySelector('.reasoning-row-summary-text')).webkitTextFillColor };
            });
            assert.equal(reasoningSweep.duration, 1000); assert.equal(reasoningSweep.blend, 'screen');
            assert.equal(reasoningSweep.background, 'none');
            assert.equal(reasoningSweep.titleAnimation, 'none');
            assert.notEqual(reasoningSweep.summaryFill, 'rgba(0, 0, 0, 0)', 'the single row-wide highlight preserves the summary glyphs and their overflow clipping');
            await page.locator('#motion-fixture .reasoning-row').screenshot({ path: join(artifacts, style + '-reasoning-row.png') });
            const interrupted = await page.evaluate(() => {
                const { sequence, message, content } = motionFixture;
                MoonYaProcessUI.tool(sequence, 'edit', { state: 'failure', result: { success: false } });
                MoonYaProcessUI.tool(sequence, 'command', { tool: 'execute_command', args: { command: 'echo ok' }, state: 'executing' });
                MoonYaProcessUI.tool(sequence, 'command', { state: 'stopped' });
                MoonYaProcessUI.finish(sequence);
                const snapshot = buildCodexPresentation(message, content, []);
                return { label: sequence.segments[0].label.textContent, active: content.querySelectorAll('[data-process-active]').length,
                    ghosts: document.querySelectorAll('.process-motion-ghost').length,
                    snapshot: JSON.stringify(snapshot), failed: sequence.tools.get('edit').row.querySelector('.tool-row-title').textContent,
                    sweeps: content.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'process-white-sweep').map(animation => ({
                        target: animation.effect.target.outerHTML, state: animation.playState })) };
            });
            assert.equal(interrupted.label, '编辑了 1 个文件，运行了 1 个命令');
            assert.equal(interrupted.failed, '编辑失败'); assert.equal(interrupted.active, 0);
            assert.deepEqual(interrupted.sweeps, [], 'terminal rows and finished turns stop the white sweep immediately: ' + JSON.stringify(interrupted.sweeps));
            assert.ok(interrupted.ghosts <= 8, 'rapid changes keep only one outgoing layer per target');
            assert.doesNotMatch(interrupted.snapshot, /process-motion-ghost|data-process-active/);
            await settleMotion(page);
            const restored = await page.evaluate(() => {
                const { content } = motionFixture;
                MoonYaProcessUI.normalize(content);
                return { ghosts: document.querySelectorAll('.process-motion-ghost').length, hidden: content.querySelector('.turn-process-body').hidden };
            });
            assert.deepEqual(restored, { ghosts: 0, hidden: true });
            await page.setViewportSize({ width: 460, height: 740 });
            await page.evaluate(() => {
                Object.assign(motionFixture.message.style, { left: '10px', width: '440px' });
                const sequence = MoonYaProcessUI.sequence(motionFixture.content, 'long:turn');
                for (const [id, tool] of Object.entries({ edit: 'edit_file', command: 'execute_command', read: 'read_file', search: 'grep', image: 'view_image', browser: 'browser_automation_control' }))
                    MoonYaProcessUI.tool(sequence, id, { tool, state: 'executing', args: { path: 'D:/very/long/project/directory/file.js' } });
            });
            await settleMotion(page);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            assert.equal(await page.locator('#motion-fixture .turn-process-header').last().evaluate(node => node.getBoundingClientRect().right <= innerWidth), true);
            await page.screenshot({ path: join(artifacts, style + '-narrow.png') });
            await page.setViewportSize({ width: 1200, height: 900 });
        }
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('reduced motion settles transitions and disclosures without backgrounds or white sweep', { timeout: 30000 }, async () => {
    const f = await fixture('chat'), { page } = f;
    try {
        await motionFixture(page, 'glass');
        await page.evaluate(() => {
            const { sequence } = motionFixture;
            MoonYaProcessUI.tool(sequence, 'edit', { tool: 'edit_file', args: { path: 'a.js' }, state: 'executing' });
            const segment = sequence.segments[0]; MoonYaProcessUI.disclose(segment.header, segment.body, true);
        });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForFunction(() => !document.querySelector('.process-motion-ghost'));
        const state = await page.evaluate(() => {
            const { sequence } = motionFixture, segment = sequence.segments[0];
            MoonYaProcessUI.tool(sequence, 'edit', { state: 'success' });
            MoonYaProcessUI.disclose(segment.header, segment.body, false);
            MoonYaProcessUI.disclose(segment.header, segment.body, true);
            return { ghost: document.querySelectorAll('.process-motion-ghost').length,
                hidden: segment.body.hidden, height: segment.body.style.height,
                motion: document.getAnimations().filter(animation => !(animation instanceof CSSTransition)).length,
                background: getComputedStyle(segment.header).backgroundImage };
        });
        assert.equal(state.ghost, 0); assert.equal(state.hidden, false); assert.equal(state.height, '');
        assert.equal(state.motion, 0); assert.equal(state.background, 'none');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('child-agent replay stays static, subsequent activity animates and terminal status stops the shared material', { timeout: 30000 }, async () => {
    const f = await fixture('work'), { page } = f;
    try {
        await motionFixture(page, 'soft');
        await page.evaluate(() => {
            const { content } = motionFixture;
            content.dataset.processTurn = 'child-motion:turn:1';
            window.childMotionRow = { child_id: 'child-motion-1', parent_id: 'child-motion', created_turn: 1, created_seq: 1, label: '验证动画', status: 'running' };
            MoonYaSubagentStore.watch = (id, path, listener) => {
                window.childMotionSnapshot = () => listener({ employees: [{ ...childMotionRow }], hydrated: true });
                childMotionSnapshot(); return () => {};
            };
            MoonYaSubagentStore.request = async () => ({ ...childMotionRow, events: [{ seq: 3 }], children: [] });
            MoonYaSubagentStore.readStream = async (url, signal, onEvent) => {
                window.childMotionEvent = (seq, event, payload = {}, tool_call_id) => onEvent({ root_run_id: 'child-motion', run_id: 'child-motion-1', seq, event, payload, tool_call_id, turn: 1, step: 1 });
                await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
            };
            MoonYaSubagentChat.bind({ mode: 'work', harnessSessionId: 'child-motion', workspaceIdentity: '__default__', container: motionFixture.message });
        });
        const child = page.locator('#motion-fixture .subagent-disclosure');
        await child.locator('.subagent-header').click();
        await page.waitForFunction(() => typeof childMotionEvent === 'function');
        await settleMotion(page);
        const replay = await page.evaluate(() => {
            childMotionEvent(1, 'turn.started');
            childMotionEvent(2, 'tool.started', { name: 'edit_file', arguments: { path: 'a.js' } }, 'one');
            childMotionEvent(3, 'tool.completed', { name: 'edit_file', result: { success: true } }, 'one');
            return { ghosts: document.querySelectorAll('.process-motion-ghost').length,
                label: document.querySelector('.subagent-log .turn-process-label').textContent };
        });
        assert.deepEqual(replay, { ghosts: 0, label: '编辑了 1 个文件' });
        const runningSnapshot = await page.evaluate(() => MoonYaSubagentChat.serializeHost(document.querySelector('.subagent-turn-list')).html);
        assert.doesNotMatch(runningSnapshot, /process-motion-ghost|data-process-active/);
        const live = await page.evaluate(() => {
            childMotionEvent(4, 'model.activity');
            return document.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && animation.effect?.target?.matches('.subagent-log .turn-process-label')).map(animation => animation.effect.getTiming().duration);
        });
        assert.deepEqual(live, [240]);
        await page.evaluate(() => MoonYaProcessUI.setAnimationStyle('glass')); await settleMotion(page);
        const next = await page.evaluate(() => {
            childMotionEvent(5, 'tool.started', { name: 'execute_command', arguments: { command: 'echo check' } }, 'two');
            MoonYaProcessUI.flush();
            return document.getAnimations().filter(animation => !(animation instanceof CSSAnimation) && animation.effect?.target?.matches('.subagent-log .turn-process-label')).map(animation => animation.effect.getTiming().duration);
        });
        assert.deepEqual(next, [360]);
        await settleMotion(page);
        await page.evaluate(() => {
            childMotionEvent(6, 'turn.completed');
            childMotionRow.status = 'completed'; childMotionSnapshot();
        });
        await page.waitForFunction(() => document.querySelector('.subagent-disclosure').dataset.state === 'completed');
        assert.equal(await child.locator('[data-process-active]').count(), 0);
        await settleMotion(page);
        assert.equal(await child.locator('.subagent-status').textContent(), '· 完成');
        const saved = await page.evaluate(() => MoonYaSubagentChat.serializeHost(document.querySelector('.subagent-turn-list')).html);
        assert.doesNotMatch(saved, /process-motion-ghost|data-process-active/);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});
