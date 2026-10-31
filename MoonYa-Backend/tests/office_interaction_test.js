'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');

test('dynamic office wraps beyond nine employees, restores, isolates rooms, replays events and controls real branch endpoints', { timeout: 30000 }, async () => {
    const backend = path.join(__dirname, '..');
    const panel = fs.readFileSync(path.join(__dirname, '../../MoonYa-Frontend/src/layouts/office-panel.html'), 'utf8');
    const css = fs.readFileSync(path.join(backend, '../MoonYa-Frontend/src/styles/css-17-office.css'), 'utf8');
    const script = fs.readFileSync(path.join(backend, '../MoonYa-Frontend/src/subagent-store.js'), 'utf8') + '\n' + fs.readFileSync(path.join(backend, '../MoonYa-Frontend/src/modules/script-5-office.js'), 'utf8');
    const employees = Array.from({ length: 12 }, (_, i) => ({ child_id: 'child-' + i, parent_id: i === 1 ? 'child-0' : 'room-A',
        order: i, label: '任务 ' + (i + 1), avatar: 'search', status: i < 8 ? 'running' : 'queued', task: '搜索并核对资料 ' + i, result: '', seq: 100 }));
    const rooms = new Map([['room-A', { session_id: 'room-A', seq: 100, employees }], ['room-B', { session_id: 'room-B', seq: 200, employees: [] }], ['race', { session_id: 'race', seq: 400, employees: [] }]]);
    const streams = new Map(), calls = [], errors = []; let concurrency = 8;
    const emit = (room, event, payload) => {
        const snapshot = rooms.get(room); const fact = { session_id: room, seq: ++snapshot.seq, event, payload };
        for (const stream of streams.get(room) || []) stream.write('data: ' + JSON.stringify(fact) + '\n\n');
        return fact;
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if (url.pathname === '/harness_api.php') {
            const chunks = []; for await (const chunk of req) chunks.push(chunk);
            const values = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks)) : Object.fromEntries(url.searchParams);
            const action = url.searchParams.get('action'), room = values.session_id; calls.push({ action, values });
            if (action === 'office_events') {
                res.setHeader('content-type', 'text/event-stream'); res.write(': connected\n\n');
                const set = streams.get(room) || new Set(); streams.set(room, set); set.add(res); req.on('close', () => set.delete(res)); return;
            }
            let data;
            if (action === 'office_settings') { if (req.method === 'POST') concurrency = values.concurrency; data = { concurrency }; }
            if (action === 'office_state') { data = { ...rooms.get(room), concurrency }; if (room === 'race') await new Promise(resolve => setTimeout(resolve, 100)); }
            if (action === 'office_detail') data = { ...rooms.get(room).employees.find(row => row.child_id === values.child_id), children: ['child-1'], events: [{ event: 'tool.completed', payload: '核对完成' }] };
            if (action === 'office_cancel') {
                for (const row of rooms.get(room).employees.filter(row => row.child_id === values.child_id || row.parent_id === values.child_id)) {
                    row.status = 'cancelled'; row.seq = emit(room, 'subagent/end', { id: row.child_id, stopReason: 'aborted', cancelled: true }).seq;
                }
                data = { success: true };
            }
            res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, data })); return;
        }
        if (url.pathname.startsWith('/assets/office/')) { res.setHeader('content-type', 'image/png'); res.end(fs.readFileSync(path.join(backend, url.pathname))); return; }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;font-family:Microsoft YaHei,sans-serif}body{display:flex;flex-direction:column}*{box-sizing:border-box}' + css + '</style>' +
            '<body class="office-active" data-authenticated="1" data-office-popout="' + (url.searchParams.get('office_popout') || '0') + '">' + panel +
            '<script>function getAuthHeaders(){return {Authorization:"Bearer fixture"}}function currentConversationMode(){return "work"}var currentChatId="chat";function getConversationRuntime(){return {harnessSessionId:localStorage.getItem("room")||"",workspaceIdentity:"__default__"}}</script><script>' + script + '</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port);
        assert.equal(await page.locator('.workstation').count(), 1);
        const [earlyPopout] = await Promise.all([context.waitForEvent('page'), page.locator('#officePopoutBtn').click()]);
        await earlyPopout.waitForSelector('.workstation'); assert.equal(await earlyPopout.locator('.workstation').count(), 1);
        await page.evaluate(async () => { localStorage.setItem('room', 'room-A'); await MoonYaOffice.bind('room-A', ''); });
        await earlyPopout.waitForSelector('[data-child-id="child-11"]');
        assert.equal(await page.locator('.workstation').count(), 13);
        const geometry = await page.evaluate(() => {
            const stage = document.getElementById('officeStage'), rect = stage.getBoundingClientRect();
            return { scrolls: stage.scrollHeight > stage.clientHeight, fits: [...stage.querySelectorAll('.workstation')].every(node => { const box = node.getBoundingClientRect(); return box.left >= rect.left && box.right <= rect.right; }) };
        });
        assert.deepEqual(geometry, { scrolls: true, fits: true });
        for (const viewport of [{ width: 1080, height: 745 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(viewport);
            await page.waitForFunction(() => {
                const stage = document.getElementById('officeStage'), bounds = stage.getBoundingClientRect();
                return [...stage.querySelectorAll('.workstation')].every(node => {
                    const box = node.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right;
                });
            });
            const layout = await page.evaluate(() => {
                const stage = document.getElementById('officeStage'), header = document.querySelector('.office-header');
                const title = document.querySelector('.office-title').getBoundingClientRect();
                const actions = document.querySelector('.office-header-actions').getBoundingClientRect();
                return {
                    noHorizontalScroll: stage.scrollWidth === stage.clientWidth,
                    controlsFit: actions.right <= header.getBoundingClientRect().right && (title.right <= actions.left || title.bottom <= actions.top),
                    emptyNoticeHeight: document.getElementById('officeNotice').offsetHeight
                };
            });
            assert.deepEqual(layout, { noHorizontalScroll: true, controlsFit: true, emptyNoticeHeight: 0 }, JSON.stringify(viewport));
        }
        await page.setViewportSize({ width: 1000, height: 720 });
        await page.locator('[data-child-id="child-0"]').click();
        await page.waitForFunction(() => document.getElementById('officeEmployeeTask').textContent.includes('搜索并核对'));
        assert.match(await page.locator('#officeEmployeeLog').textContent(), /核对完成/);
        await page.locator('#officeEmployeeStop').click();
        await page.waitForFunction(() => document.querySelector('[data-child-id="child-1"]').dataset.state === 'cancelled');
        await page.locator('#officeCardClose').click();
        await page.locator('#officeConcurrency').fill('3'); await page.locator('#officeConcurrency').dispatchEvent('change');
        await page.waitForFunction(() => document.getElementById('officeNotice').textContent === '并发设置已保存'); assert.equal(concurrency, 3);
        const [popout] = await Promise.all([context.waitForEvent('page'), page.locator('#officePopoutBtn').click()]);
        await popout.waitForSelector('[data-child-id="child-11"]'); assert.match(popout.url(), /office_session=room-A/);
        await popout.evaluate(async () => { await MoonYaOffice.bind('room-B', ''); });
        assert.equal(await popout.locator('.workstation').count(), 13, 'conversation restore cannot replace the explicitly bound popout room');
        const fact = emit('room-A', 'office/agent-state', { child_id: 'child-11', state: 'running' });
        await page.evaluate(fact => { MoonYaOffice.applyEvent(fact); MoonYaOffice.applyEvent(fact); }, fact);
        await popout.waitForFunction(() => document.querySelector('[data-child-id="child-11"]').dataset.state === 'running');
        assert.equal(await page.locator('.workstation').count(), 13);
        await page.reload(); await page.waitForSelector('[data-child-id="child-11"]'); assert.equal(await page.locator('.workstation').count(), 13);
        await page.evaluate(async () => { localStorage.setItem('room', 'room-B'); await MoonYaOffice.bind('room-B', ''); });
        emit('room-A', 'office/agent-state', { child_id: 'child-10', state: 'running' }); assert.equal(await page.locator('.workstation').count(), 1);
        assert.equal(await earlyPopout.locator('.workstation').count(), 13);
        await page.evaluate(async () => {
            const pending = MoonYaOffice.bind('race', '');
            MoonYaOffice.applyEvent({ session_id: 'race', seq: 503, event: 'subagent/end', payload: { id: 'late', stopReason: 'completed' } });
            MoonYaOffice.applyEvent({ session_id: 'race', seq: 501, event: 'subagent/catalog', payload: { childId: 'late', label: '乱序补齐' } });
            await pending;
            MoonYaOffice.applyEvent({ session_id: 'race', seq: 502, event: 'subagent/start', payload: { id: 'late' } });
        });
        assert.equal(await page.locator('[data-child-id="late"] .ws-name').textContent(), '乱序补齐');
        assert.equal(await page.locator('[data-child-id="late"]').getAttribute('data-state'), 'completed');
        await page.evaluate(() => {
            MoonYaOffice.applyEvent({ session_id: 'race', seq: 510, event: 'office/cleared', payload: {} });
            MoonYaOffice.applyEvent({ session_id: 'race', seq: 505, event: 'subagent/catalog', payload: { childId: 'late', label: '旧事件' } });
        });
        assert.equal(await page.locator('.workstation').count(), 1);
        await page.evaluate(async () => { await MoonYaOffice.bind('room-A', ''); });
        const room = rooms.get('room-A');
        room.employees.push({ child_id: 'gap', parent_id: 'room-A', order: 12, label: '重连补齐', avatar: 'code', status: 'completed', seq: ++room.seq });
        for (const stream of streams.get('room-A') || []) stream.end();
        await page.waitForSelector('[data-child-id="gap"]', { timeout: 5000 });
        assert.equal(await page.locator('.workstation').count(), 14, 'reconnect snapshot must repair an event omitted by a different stream');
        await page.evaluate(seq => {
            MoonYaOffice.applyEvent({ session_id: 'room-A', seq, event: 'subagent/start', payload: { id: 'unpublished' } });
            MoonYaOffice.applyEvent({ session_id: 'room-A', seq: seq + 1, event: 'subagent/end', payload: { id: 'unpublished', stopReason: 'error' } });
        }, room.seq + 1);
        assert.equal(await page.locator('.workstation').count(), 14, 'failed publication cannot render a ghost employee');
        if (process.env.MOONYA_OFFICE_SCREENSHOT) await page.screenshot({ path: process.env.MOONYA_OFFICE_SCREENSHOT });
        assert.deepEqual(errors, []); assert.ok(calls.some(call => call.action === 'office_cancel' && call.values.child_id === 'child-0'));
    } finally { await browser.close(); for (const set of streams.values()) for (const stream of set) stream.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
