'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

test('conversation disclosures restore original turns, share office facts, multiplex records and isolate parent output', { timeout: 45000 }, async () => {
    const backend = process.env.MOONYA_FRONTEND_ROOT || path.join(__dirname, '..'), ui = path.join(backend, '../MoonYa-Frontend/src');
    const source = fs.readFileSync(path.join(ui, 'modules/script-1e-rest.js'), 'utf8');
    const markdown = source.slice(source.indexOf('        const TEAM_STATUS_TOKEN_START'), source.indexOf('        function cleanTeamCompactSummary'));
    const toolRenderer = source.slice(source.indexOf('        function renderCodexToolDetail('), source.indexOf('        // 工具行：Codex'));
    const saveSource = fs.readFileSync(path.join(ui, 'modules/script-1c-save.js'), 'utf8');
    const save = saveSource.slice(saveSource.indexOf('        function isDshChromeStatus('), saveSource.indexOf('        function saveCurrentChat('));
    const office = fs.readFileSync(path.join(ui, 'modules/script-5-office.js'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '../../MoonYa-Frontend/src/layouts/office-panel.html'), 'utf8');
    const scripts = ['ui-icons.js', 'process-ui.js', 'subagent-store.js', 'subagent-chat.js'].map(file => fs.readFileSync(path.join(ui, file), 'utf8')).join('\n');
    const css = ['css-06-main.css', 'css-17-office.css', 'css-19-subagents.css', 'css-28-process.css'].map(file => fs.readFileSync(path.join(ui, 'styles', file), 'utf8')).join('\n');
    const employees = Array.from({ length: 12 }, (_, i) => ({ child_id: 'child-' + i, parent_id: i === 1 ? 'child-0' : 'room-A', order: i,
        created_turn: i < 6 ? 1 : 2, created_seq: i + 1, label: i === 0 ? '搜索很长的任务描述'.repeat(30) : '任务 ' + i,
        task: '完整任务：' + '资料'.repeat(3000), result: '## 搜索结果\n**核对完成**', status: ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'][i % 6], seq: 100 }));
    const rooms = new Map([['room-A', { session_id: 'room-A', seq: 100, concurrency: 8, employees }], ['room-B', { session_id: 'room-B', seq: 200, concurrency: 8, employees: [] }]]);
    const logs = new Map(employees.map(row => [row.child_id, [
        { seq: 1, turn: 1, event: 'tool.started', tool_call_id: 'read', payload: { name: 'execute_command', arguments: { command: 'Get-Content fixture.txt' } } },
        { seq: 2, turn: 1, event: 'tool.completed', tool_call_id: 'read', payload: { name: 'execute_command', result: { success: true, stdout: '核对完成' } } },
        { seq: 3, turn: 1, event: 'turn.completed', payload: { content: 'child-only-final' } },
    ]]));
    const rootStreams = new Map(), detailStreams = new Set(), calls = [], errors = [];
    function sendChild(stream, child, event) { stream.res.write('data: ' + JSON.stringify({ ...event, type: 'subagent_event', root_run_id: stream.room, run_id: child }) + '\n\n'); }
    function emitRoot(room, event, payload, turn = 1) {
        const fact = { session_id: room, seq: ++rooms.get(room).seq, turn, event, payload };
        for (const res of rootStreams.get(room) || []) res.write('data: ' + JSON.stringify(fact) + '\n\n'); return fact;
    }
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/harness_api.php') {
            const query = Object.fromEntries(url.searchParams), room = query.session_id, action = query.action; calls.push(query);
            if (action === 'office_events') {
                res.setHeader('content-type', 'text/event-stream'); res.write(': connected\n\n');
                const set = rootStreams.get(room) || new Set(); rootStreams.set(room, set); set.add(res); req.on('close', () => set.delete(res)); return;
            }
            if (action === 'office_employee_events') {
                res.setHeader('content-type', 'text/event-stream'); res.write(': connected\n\n');
                const cursors = JSON.parse(query.children), stream = { res, cursors, room }; detailStreams.add(stream); req.on('close', () => detailStreams.delete(stream));
                for (const [child, after] of Object.entries(cursors)) for (const event of logs.get(child) || []) if (event.seq > after) sendChild(stream, child, event);
                return;
            }
            let data = { success: true };
            if (action === 'office_state') data = rooms.get(room);
            if (action === 'office_detail') data = { ...rooms.get(room).employees.find(row => row.child_id === query.child_id), event_session_ready: true, children: [], events: [] };
            if (action === 'office_settings') data = { concurrency: 8 };
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data })); return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const turns = [1, 2].map(turn => '<div class="message user">用户任务 ' + turn + '</div><div class="turn-process" data-turn-process="room-A:turn:' + turn + '"><button class="turn-process-header">用时 1 秒</button><div class="turn-process-body">主执行记录</div></div><div class="message ai"><div class="message-content">MoonYa 主回复 ' + turn + '</div></div>').join('');
        res.end('<!doctype html><meta charset="utf-8"><style>body{font-family:Microsoft YaHei;margin:24px}.messages-container{max-width:700px}.message{padding:12px}#officeView{display:none}body.office-active #officeView{display:flex}' + css + '</style>' +
            '<body data-authenticated="1"><div class="messages-container">' + turns + '</div>' + panel + '<script>function getAuthHeaders(){return {}} function currentConversationMode(){return "work"} var currentChatId="chat-A"; var testRuntime={mode:"work",harnessSessionId:"room-A",workspaceIdentity:"__default__",container:document.querySelector(".messages-container")}; function getConversationRuntime(){return testRuntime} function formatTurnDuration(value){return value+"ms"}</script><script>' + scripts + '</script><script>' + markdown + toolRenderer + save +
            '\nMoonYaSubagentChat.configure({renderMarkdown:renderTeamMarkdown,renderTool:function(node,spec){renderCodexToolDetail(node,spec);}});' +
            'const saved=JSON.parse(localStorage.getItem("presentations")||"null"); if(saved){testRuntime.container.replaceChildren();for(const p of saved){let msg={presentation:p};hydrateCodexPresentation(msg);const user=document.createElement("div");user.className="message user";user.textContent="用户任务";testRuntime.container.appendChild(user);for(const status of msg.statuses||[]){const shell=document.createElement("div");shell.innerHTML=status.html;while(shell.firstChild)testRuntime.container.appendChild(shell.firstChild)}const ai=document.createElement("div");ai.className="message ai";ai.innerHTML="<div class=message-content>MoonYa 主回复</div>";testRuntime.container.appendChild(ai)}}MoonYaSubagentChat.bind(testRuntime);</script><script>' + office + '</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } }); page.on('pageerror', error => { errors.push(error.message); console.error('Browser:', error.message); });
        await page.goto('http://127.0.0.1:' + server.address().port); await page.waitForSelector('.subagent-disclosure');
        assert.equal(await page.locator('.subagent-disclosure').count(), 12); assert.equal(await page.locator('.subagent-turn-list img').count(), 0);
        assert.deepEqual(await page.locator('.subagent-turn-list').evaluateAll(hosts => hosts.map(host => ({ key: host.dataset.subagentTurn, count: host.children.length,
            before: host.previousElementSibling.className, after: host.nextElementSibling.className, insideTrace: !!host.closest('.turn-process') }))), [
            { key: 'room-A:turn:1', count: 6, before: 'turn-process', after: 'message ai', insideTrace: false },
            { key: 'room-A:turn:2', count: 6, before: 'turn-process', after: 'message ai', insideTrace: false },
        ]);
        const first = page.locator('.subagent-disclosure[data-child-id="child-0"]');
        assert.ok(await first.locator('.subagent-title').evaluate(node => node.scrollWidth > node.clientWidth));
        const previews = path.resolve(__dirname, '../../artifacts/subagent-runtime-package'); fs.mkdirSync(previews, { recursive: true });
        await page.screenshot({ path: path.join(previews, 'subagent-chat-collapsed.png'), fullPage: true });
        await first.locator('.subagent-header').focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(() => {
            const row = document.querySelector('[data-child-id="child-0"]');
            return row.querySelector('.subagent-log')?.textContent.includes('核对完成') || row.querySelector('.subagent-error')?.textContent;
        }, null, { timeout: 5000 }).catch(async error => { error.message += '\n' + JSON.stringify({ calls, row: await first.textContent() }); throw error; });
        assert.equal(await first.locator('.subagent-error').textContent(), '');
        assert.ok((await first.locator('.subagent-task').textContent()).length > 5000);
        assert.equal(await first.locator('.subagent-result strong').textContent(), '核对完成');
        await page.screenshot({ path: path.join(previews, 'subagent-chat-expanded.png'), fullPage: true });
        await page.locator('.subagent-disclosure[data-child-id="child-1"] .subagent-header').click();
        assert.match(await page.locator('[data-child-id="child-1"] .subagent-relations').textContent(), /搜索很长/);
        await page.evaluate(() => document.querySelectorAll('.subagent-header[aria-expanded="false"]').forEach(header => header.click()));
        await page.waitForFunction(() => document.querySelectorAll('.subagent-log .subagent-tool-record').length === 12);
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(detailStreams.size, 1, 'all expanded employees must share a connection');
        const result = await page.evaluate(() => fetch('harness_api.php?action=ping').then(response => response.json())); assert.equal(result.success, true);
        assert.equal(await page.locator('.message.ai').count(), 2); assert.equal(await page.locator('.message.ai').first().textContent(), 'MoonYa 主回复 1');
        const processHeader = first.locator('.process-segment .turn-process-header');
        await processHeader.click();
        await first.locator('.codex-tool-main').click();
        await first.locator('.codex-tool-detail').waitFor();
        await page.evaluate(() => { window.originalChildTool = document.querySelector('[data-child-id="child-0"] .tool-row'); });
        const event = { seq: 4, turn: 1, event: 'tool.progress', tool_call_id: 'read', payload: { stdout: '实时校验日志' } };
        logs.get('child-0').push(event); for (const stream of detailStreams) { sendChild(stream, 'child-0', event); sendChild(stream, 'child-0', event); }
        await first.getByText('实时校验日志', { exact: false }).first().waitFor({state:'attached'}); assert.equal(await first.locator('.subagent-tool-record').count(), 1);
        assert.equal(await first.locator('.subagent-tool-name').textContent(), '运行命令');
        assert.equal(await processHeader.getAttribute('aria-expanded'), 'true');
        assert.equal(await first.locator('.codex-tool-main').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => originalChildTool === document.querySelector('[data-child-id="child-0"] .tool-row')), true);
        assert.equal(await first.locator('.codex-tool-detail').isVisible(), true);
        for (const stream of detailStreams) stream.res.end(); await page.waitForFunction(() => document.querySelector('[data-child-id="child-0"] .subagent-header').getAttribute('aria-expanded') === 'true');
        await new Promise(resolve => setTimeout(resolve, 1800)); assert.ok(calls.some(call => call.children && JSON.parse(call.children)['child-0'] === 4));
        rooms.get('room-A').employees[0].status = 'completed'; rooms.get('room-A').employees[0].result = '**最新结果**'; emitRoot('room-A', 'subagent/end', { id: 'child-0', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '**最新结果**' }] });
        await page.waitForFunction(() => document.querySelector('[data-child-id="child-0"]').dataset.state === 'completed');
        await page.evaluate(() => MoonYaOffice.open()); await page.waitForSelector('.workstation[data-child-id="child-0"]');
        assert.equal(await page.locator('.workstation[data-child-id="child-0"]').getAttribute('data-state'), 'completed');
        await page.evaluate(() => MoonYaOffice.close()); assert.equal(await page.locator('.subagent-disclosure').count(), 12);
        await page.evaluate(() => {
            const presentations = [...testRuntime.container.querySelectorAll(':scope > .turn-process')].map(trace => buildCodexPresentation(trace.nextElementSibling.nextElementSibling,
                trace.nextElementSibling.nextElementSibling.querySelector('.message-content'), [{ html: trace.outerHTML }, MoonYaSubagentChat.serializeHost(trace.nextElementSibling)]));
            localStorage.setItem('presentations', JSON.stringify(presentations));
        });
        await page.reload(); await page.waitForSelector('.subagent-disclosure'); assert.equal(await page.locator('.subagent-disclosure').count(), 12);
        assert.equal(await page.locator('.subagent-header[aria-expanded="true"]').count(), 0);
        assert.equal(await page.locator('[data-subagent-turn="room-A:turn:1"] > .subagent-disclosure').count(), 6);
        const base = rooms.get('room-A').seq + 10;
        await page.evaluate(base => {
            MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 1, event: 'subagent/start', payload: { id: 'unpublished' } });
            MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 2, event: 'subagent/end', payload: { id: 'unpublished', stopReason: 'error' } });
            MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 5, event: 'subagent/end', payload: { id: 'late', stopReason: 'completed' } });
            MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 3, turn: 2, event: 'subagent/catalog', payload: { childId: 'late', label: '<img src=x onerror=alert(1)>真实任务' } });
            MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 4, event: 'subagent/start', payload: { id: 'late' } });
        }, base);
        await page.waitForSelector('.subagent-disclosure[data-child-id="late"]');
        assert.equal(await page.locator('.subagent-disclosure').count(), 13);
        assert.equal(await page.locator('.subagent-disclosure[data-child-id="unpublished"]').count(), 0);
        assert.equal(await page.locator('.subagent-disclosure[data-child-id="late"]').getAttribute('data-state'), 'completed');
        assert.equal(await page.locator('.subagent-turn-list img').count(), 0);
        rooms.get('room-A').seq = base + 5; rooms.get('room-A').employees = [];
        emitRoot('room-A', 'office/cleared', {}); await page.waitForFunction(() => !document.querySelector('.subagent-disclosure'));
        await page.evaluate(base => MoonYaSubagentStore.applyEvent({ session_id: 'room-A', seq: base + 3, event: 'subagent/catalog', payload: { childId: 'late', label: '迟到旧目录' } }), base);
        assert.equal(await page.locator('.subagent-disclosure').count(), 0);
        await page.evaluate(() => { MoonYaSubagentChat.bind({ ...testRuntime, mode: 'chat' }); }); await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(detailStreams.size, 0);
        await page.evaluate(() => { testRuntime.harnessSessionId = 'room-B'; testRuntime.container.replaceChildren(); MoonYaSubagentChat.bind(testRuntime); });
        emitRoot('room-A', 'subagent/start', { id: 'child-0' }); await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(await page.locator('.subagent-disclosure').count(), 0);
        assert.deepEqual(errors, []);
    } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
