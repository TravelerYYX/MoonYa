/* One independent disclosure per cataloged child, outside the turn trace. */
(function (root) {
    'use strict';
    const store = root.MoonYaSubagentStore, cache = new Map();
    const labels = { queued: '排队中', running: '运行中', waiting: '等待中', completed: '完成', failed: '失败', cancelled: '已取消' };
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="3"/><path d="M12 3v3M8 21v-3m8 3v-3M2 10h3m14 0h3M9 14h6"/><circle cx="9" cy="10" r=".7"/><circle cx="15" cy="10" r=".7"/></svg>';
    let options = {}, id = '', path = '', container = null, release = null, observer = null, scheduled = false, generation = 0, employees = [], hydrated = false;
    function element(tag, cls, text) { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; }
    function metadata(row) { const { child_id, parent_id, created_turn, created_seq, order, label, status } = row; return { child_id, parent_id, created_turn, created_seq, order, label, status }; }
    function createRow(row) {
        const node = element('section', 'subagent-disclosure'); node.dataset.childId = row.child_id;
        const header = element('button', 'subagent-header'); header.type = 'button'; header.setAttribute('aria-expanded', 'false');
        const leading = element('span', 'subagent-icon'); leading.innerHTML = icon;
        const title = element('span', 'subagent-title');
        const status = element('span', 'subagent-status');
        const arrow = element('span', 'subagent-chevron'); arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
        const detail = element('div', 'subagent-detail'); detail.hidden = true;
        header.append(leading, title, status, arrow); node.append(header, detail); updateRow(node, row); return node;
    }
    function updateRow(node, row) {
        node.dataset.state = row.status;
        node.querySelector('.subagent-title').textContent = '子代理：' + (row.label || '子代理 ' + (Number(row.order || 0) + 1));
        node.querySelector('.subagent-title').title = row.label || '';
        node.querySelector('.subagent-status').textContent = '· ' + (labels[row.status] || row.status || '排队中');
    }
    function createHost(turnKey, rows) {
        const host = element('div', 'subagent-turn-list'); host.dataset.subagentTurn = turnKey;
        host.dataset.subagentRows = JSON.stringify(rows.map(metadata)); rows.forEach(row => host.appendChild(createRow(row))); return host;
    }
    function serializeHost(host) {
        const rows = JSON.parse(host.dataset.subagentRows || '[]'), copy = createHost(host.dataset.subagentTurn, rows);
        return { kind: 'subagents', turnKey: host.dataset.subagentTurn, rows, html: copy.outerHTML };
    }
    function entry(childId) {
        const key = id + ':' + childId; let value = cache.get(key);
        if (!value) { value = { childId, events: new Map(), cursor: 0, toolNodes: new Map() }; cache.set(key, value); }
        return value;
    }
    let detailController = null, detailRetry = null, detailSchedule = null;
    function close(value) { clearTimeout(value.retry); value.retry = null; value.open = false; scheduleStream(); }
    function scheduleStream() { clearTimeout(detailSchedule); detailSchedule = setTimeout(subscribe, 30); }
    function rowFor(childId) { return employees.find(row => row.child_id === childId); }
    function nodeFor(childId) { return container && [...container.querySelectorAll('.subagent-disclosure')].find(node => node.dataset.childId === childId); }
    function markdown(node, content) {
        if (options.renderMarkdown) options.renderMarkdown(node, String(content || ''), { final: true });
        else node.textContent = content || '';
    }
    function detailShell(node, value, row) {
        const detail = node.querySelector('.subagent-detail');
        if (!detail.childNodes.length) {
            detail.append(element('div', 'subagent-relations'), element('h4', '', '任务'), element('div', 'subagent-task'),
                element('h4', '', '执行记录'), element('div', 'subagent-log'), element('h4', '', '结果'), element('div', 'subagent-result'), element('div', 'subagent-error'));
        }
        const parent = rowFor(row.parent_id);
        detail.querySelector('.subagent-relations').textContent = '父代理：' + (parent ? parent.label : 'MoonYa') + ' · 直接下级：' + employees.filter(item => item.parent_id === row.child_id).length;
        detail.querySelector('.subagent-task').textContent = value.detail?.task || row.task || '';
        const result = row.result || value.detail?.result || '';
        const resultNode = detail.querySelector('.subagent-result');
        if (resultNode.dataset.content !== result) { resultNode.dataset.content = result; markdown(resultNode, result); }
        detail.querySelector('.subagent-error').textContent = value.error || '';
        return detail;
    }
    function renderRecords(node, value) {
        const log = node.querySelector('.subagent-log'); if (!log) return;
        const previousScroll = log.scrollTop, following = log.scrollHeight - log.clientHeight - previousScroll < 48;
        value.toolNodes.clear(); log.replaceChildren();
        [...value.events.values()].sort((a, b) => a.seq - b.seq).forEach(event => {
            const payload = event.payload || {};
            if (event.event.startsWith('tool.')) {
                const key = String(event.turn) + ':' + String(event.tool_call_id || event.seq);
                let tool = value.toolNodes.get(key);
                if (!tool) { tool = { node: element('div', 'tool-row subagent-tool-record'), args: {}, result: {} }; value.toolNodes.set(key, tool); log.appendChild(tool.node); }
                if (payload.arguments) tool.args = payload.arguments;
                if (payload.result) tool.result = payload.result;
                if (event.event === 'tool.progress') tool.result = Object.assign({}, tool.result, payload);
                tool.name = payload.name || payload.tool_key || tool.name || 'tool';
                const spec = { tool: tool.name, args: tool.args, result: tool.result,
                    state: event.event === 'tool.failed' || tool.result.success === false ? 'failure' : event.event === 'tool.completed' ? 'success' : 'executing' };
                tool.node.dataset.state = spec.state;
                tool.node.replaceChildren(element('div', 'subagent-tool-name', options.toolLabel ? options.toolLabel(spec.tool) : spec.tool));
                if (options.renderTool) options.renderTool(tool.node, spec);
                else tool.node.appendChild(element('pre', '', JSON.stringify({ arguments: tool.args, result: tool.result }, null, 2)));
            } else if (event.event === 'assistant.message' && payload.content) {
                const content = element('div', 'subagent-output'); markdown(content, payload.content); log.appendChild(content);
            } else if (['approval.required', 'approval.decided', 'user_action.required', 'user_action.decided', 'session.error', 'turn.cancelled', 'turn.interrupted'].includes(event.event)) {
                const label = { 'approval.required': '等待审批', 'approval.decided': '审批已处理', 'user_action.required': '等待用户操作', 'user_action.decided': '用户操作已处理', 'session.error': '执行失败', 'turn.cancelled': '已取消', 'turn.interrupted': '执行中断' }[event.event];
                log.appendChild(element('div', 'subagent-record', label + (payload.message || payload.reason ? '：' + (payload.message || payload.reason) : '')));
            }
        });
        if (!log.childNodes.length) log.textContent = '暂无执行记录';
        log.scrollTop = following ? log.scrollHeight : previousScroll;
    }
    async function openDetail(childId) {
        const value = entry(childId), row = rowFor(childId), node = nodeFor(childId); if (!row || !node) return;
        value.open = true; const expected = generation, roomId = id, roomPath = path;
        node.querySelector('.subagent-header').setAttribute('aria-expanded', 'true'); node.querySelector('.subagent-detail').hidden = false;
        detailShell(node, value, row); renderRecords(node, value);
        try {
            value.detail = await store.request('office_detail', roomId, roomPath, { child_id: childId });
            if (!value.open || expected !== generation) return;
            value.error = ''; detailShell(node, value, rowFor(childId) || row);
            scheduleStream();
        } catch (error) {
            if (value.open && expected === generation) { value.error = error.message; detailShell(node, value, row); value.retry = setTimeout(() => openDetail(childId), 1500); }
        }
    }
    async function subscribe() {
        clearTimeout(detailRetry); detailRetry = null;
        detailController?.abort(); detailController = null;
        if (!id || !container) return;
        const cursors = {};
        employees.forEach(row => { const value = entry(row.child_id); if (value.open) cursors[row.child_id] = value.cursor; });
        if (!Object.keys(cursors).length) return;
        const expected = generation, roomId = id, controller = new AbortController(); detailController = controller;
        try {
            await store.readStream('harness_api.php?' + new URLSearchParams({ action: 'office_employee_events', session_id: roomId, project_path: path, children: JSON.stringify(cursors) }), controller.signal, event => {
                if (expected !== generation || event.root_run_id !== roomId || !(event.run_id in cursors)) return;
                const value = entry(event.run_id); if (!value.open || value.events.has(event.seq)) return;
                value.events.set(event.seq, event); value.cursor = Math.max(value.cursor, Number(event.seq)); value.error = '';
                const node = nodeFor(value.childId);
                if (node) { detailShell(node, value, rowFor(value.childId)); renderRecords(node, value); }
            });
        } catch (error) {
            if (error.name !== 'AbortError' && expected === generation) Object.keys(cursors).forEach(child => {
                const value = entry(child), node = nodeFor(child); value.error = error.message;
                if (value.open && node) detailShell(node, value, rowFor(child));
            });
        } finally {
            if (detailController === controller) detailController = null;
            if (!controller.signal.aborted && expected === generation) detailRetry = setTimeout(subscribe, 1500);
        }
    }
    function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); }); } }
    function render() {
        if (!container || !id) return;
        const wanted = new Set(employees.map(row => row.child_id));
        container.querySelectorAll('.subagent-turn-list').forEach(host => {
            if (!host.dataset.subagentTurn.startsWith(id + ':turn:')) return;
            host.querySelectorAll('.subagent-disclosure').forEach(node => { if (hydrated && !wanted.has(node.dataset.childId)) { close(entry(node.dataset.childId)); node.remove(); } });
            if (!host.children.length) host.remove();
        });
        const turns = new Map(); employees.forEach(row => { const key = id + ':turn:' + (row.created_turn || 1); if (!turns.has(key)) turns.set(key, []); turns.get(key).push(row); });
        turns.forEach((rows, key) => {
            const trace = [...container.querySelectorAll('[data-turn-process]')].find(node => node.dataset.turnProcess === key);
            let host = [...container.querySelectorAll('.subagent-turn-list')].find(node => node.dataset.subagentTurn === key);
            if (!host && !trace) return;
            if (!host) { host = createHost(key, []); trace.after(host); }
            if (trace && trace.nextElementSibling !== host) trace.after(host);
            host.dataset.subagentRows = JSON.stringify(rows.map(metadata));
            rows.forEach((row, index) => {
                let node = [...host.children].find(node => node.dataset.childId === row.child_id);
                if (!node) { node = createRow(row); host.appendChild(node); }
                if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
                updateRow(node, row);
                const value = entry(row.child_id); if (value.open) { detailShell(node, value, row); }
            });
        });
    }
    function bind(runtime) {
        const nextId = runtime?.mode === 'work' ? runtime.harnessSessionId || '' : '', nextContainer = runtime?.container || null;
        if (id === nextId && container === nextContainer) { schedule(); return; }
        if (release) release(); release = null; observer?.disconnect(); cache.forEach(close); detailController?.abort(); detailController = null; clearTimeout(detailRetry); generation++;
        id = nextId; path = runtime?.workspaceIdentity === '__default__' ? '' : runtime?.workspaceIdentity || ''; container = nextContainer; employees = []; hydrated = false;
        container?.querySelectorAll('.subagent-turn-list').forEach(host => { host.hidden = !id || !host.dataset.subagentTurn.startsWith(id + ':turn:'); });
        if (!id || !container) return;
        container.querySelectorAll('.subagent-header').forEach(header => { header.setAttribute('aria-expanded', 'false'); header.nextElementSibling.hidden = true; });
        observer = new MutationObserver(schedule); observer.observe(container, { childList: true });
        release = store.watch(id, path, snapshot => { employees = snapshot.employees; hydrated = snapshot.hydrated; schedule(); });
    }
    document.addEventListener('click', event => {
        const header = event.target.closest('.subagent-header'); if (!header || !container?.contains(header)) return;
        const node = header.closest('.subagent-disclosure'), value = entry(node.dataset.childId);
        if (header.getAttribute('aria-expanded') === 'true') { close(value); header.setAttribute('aria-expanded', 'false'); node.querySelector('.subagent-detail').hidden = true; }
        else openDetail(node.dataset.childId);
    });
    root.addEventListener('pagehide', () => { cache.forEach(close); clearTimeout(detailSchedule); clearTimeout(detailRetry); detailController?.abort(); if (release) release(); });
    root.addEventListener('moonya:subagent-cleared', event => {
        const prefix = String(event.detail) + ':';
        cache.forEach((value, key) => { if (key.startsWith(prefix)) { close(value); cache.delete(key); } });
    });
    root.MoonYaSubagentChat = { bind, createHost, serializeHost, refresh: schedule, configure: value => { options = value; } };
}(window));
