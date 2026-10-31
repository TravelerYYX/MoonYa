/* One independent disclosure per cataloged child, outside the turn trace. */
(function (root) {
    'use strict';
    const store = root.MoonYaSubagentStore, cache = new Map();
    const labels = { queued: '排队中', running: '运行中', waiting: '等待中', completed: '完成', failed: '失败', cancelled: '已取消', quota_stopped: '积分已耗尽' };
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
        const arrow = root.MoonYaProcessUI.arrow('subagent-chevron');
        const detail = element('div', 'subagent-detail process-disclosure-body'); detail.hidden = true; detail.inert = true;
        header.append(leading, title, status, arrow); node.append(header, detail); updateRow(node, row); return node;
    }
    function updateRow(node, row) {
        node.dataset.state = row.status;
        node.querySelector('.subagent-title').textContent = '子代理：' + (row.label || '子代理 ' + (Number(row.order || 0) + 1));
        node.querySelector('.subagent-title').dataset.tooltip = row.label || '';
        root.MoonYaProcessUI.setVisual(node.querySelector('.subagent-status'), '· ' + (labels[row.status] || row.status || '排队中'));
        root.MoonYaProcessUI.setActive(node.querySelector('.subagent-header'), row.status === 'running');
    }
    function createHost(turnKey, rows) {
        const host = element('div', 'subagent-turn-list'); host.dataset.subagentTurn = turnKey;
        host.dataset.subagentRows = JSON.stringify(rows.map(metadata)); rows.forEach(row => host.appendChild(createRow(row))); return host;
    }
    function serializeHost(host) {
        const rows = JSON.parse(host.dataset.subagentRows || '[]'), copy = createHost(host.dataset.subagentTurn, rows);
        copy.querySelectorAll('[data-process-active]').forEach(node => node.removeAttribute('data-process-active'));
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
        // Opening a detail replays cached events without presenting every historical state.
        if (!value.sequence || value.sequence.host !== node.querySelector('.subagent-log')) {
            return root.MoonYaProcessUI.withoutAnimation(() => renderRecordBatch(node, value));
        }
        return renderRecordBatch(node, value);
    }
    function renderRecordBatch(node, value) {
        const log = node.querySelector('.subagent-log'); if (!log) return;
        const previousScroll = log.scrollTop, following = log.scrollHeight - log.clientHeight - previousScroll < 48;
        if (!value.sequence || value.sequence.host !== log) {
            log.replaceChildren(); value.renderedSeq = 0; value.outputNodes = new Map();
            value.sequence = root.MoonYaProcessUI.sequence(log, value.childId, options);
        }
        const sequence = value.sequence;
        [...value.events.values()].sort((a, b) => a.seq - b.seq).forEach(event => {
            if (Number(event.seq) <= value.renderedSeq) return;
            const payload = event.payload || {}, name = event.event;
            const step = String(event.turn || 1) + ':' + String(event.step || 1);
            if (name.startsWith('tool.')) {
                const key = String(event.turn) + ':' + String(event.tool_call_id || event.seq);
                const previous = sequence.tools.get(key)?.spec || {};
                const result = name === 'tool.progress' ? { ...(previous.result || {}), ...payload } : payload.result || previous.result || {};
                const args = payload.arguments || previous.args || {};
                const toolRow = root.MoonYaProcessUI.tool(sequence, key, { tool: payload.name || payload.tool_key || previous.tool || 'tool', args, result,
                    detail: payload.display_name || args.path || args.command || '',
                    state: name === 'tool.failed' || result.success === false ? 'failure' : name === 'tool.completed' ? 'success' : 'executing' });
                toolRow.classList.add('subagent-tool-record'); toolRow.querySelector('.tool-row-title').classList.add('subagent-tool-name');
            } else if (['turn.started', 'agent.turn.started', 'step.started', 'model.activity'].includes(name)) {
                root.MoonYaProcessUI.activity(sequence);
            } else if (['reasoning.delta', 'agent.reasoning.delta'].includes(name)) {
                const text = (sequence.texts.get(step) || '') + String(payload.delta || ''); sequence.texts.set(step, text);
                root.MoonYaProcessUI.reason(sequence, step, text, true);
            } else if (['content.delta', 'agent.content.delta', 'assistant.message'].includes(name)) {
                if (name === 'assistant.message' && payload.reasoning && !sequence.reasons.has(step)) root.MoonYaProcessUI.reason(sequence, step, payload.reasoning, false);
                if (sequence.reasons.has(step)) root.MoonYaProcessUI.reason(sequence, step, sequence.reasons.get(step).__text, false);
                if (payload.content || payload.delta) {
                    root.MoonYaProcessUI.boundary(sequence);
                    let output = value.outputNodes.get(step);
                    if (!output) { output = element('div', 'subagent-output'); output.__text = ''; value.outputNodes.set(step, output); log.appendChild(output); }
                    output.__text = name === 'assistant.message' ? payload.content : output.__text + String(payload.delta || '');
                    markdown(output, output.__text);
                }
            } else if (['turn.completed', 'agent.turn.completed', 'session.error', 'turn.cancelled', 'turn.interrupted', 'turn.quota_stopped'].includes(name)) {
                root.MoonYaProcessUI.finish(sequence);
                if(name==='turn.quota_stopped')root.MoonYaMembership?.quotaNotice(log);
                else if (name !== 'turn.completed' && name !== 'agent.turn.completed') {
                    const segment = sequence.segments.at(-1) || root.MoonYaProcessUI.ensure(sequence);
                    segment.body.appendChild(element('div', 'subagent-record', payload.message || payload.reason || '执行已停止'));
                }
            } else if (['approval.required', 'approval.decided', 'user_action.required', 'user_action.decided'].includes(name)) {
                const label = { 'approval.required': '等待审批', 'approval.decided': '审批已处理', 'user_action.required': '等待用户操作', 'user_action.decided': '用户操作已处理' }[name];
                root.MoonYaProcessUI.ensure(sequence).body.appendChild(element('div', 'subagent-record', label));
            }
            value.renderedSeq = Number(event.seq);
        });
        if (['completed', 'failed', 'cancelled','quota_stopped'].includes(rowFor(value.childId)?.status)) root.MoonYaProcessUI.finish(sequence);
        log.scrollTop = following ? log.scrollHeight : previousScroll;
    }
    async function openDetail(childId) {
        const value = entry(childId), row = rowFor(childId), node = nodeFor(childId); if (!row || !node) return;
        value.openedAt = Date.now();
        value.open = true; const expected = generation, roomId = id, roomPath = path;
        detailShell(node, value, row); renderRecords(node, value);
        root.MoonYaProcessUI.disclose(node.querySelector('.subagent-header'), node.querySelector('.subagent-detail'), true);
        try {
            value.detail = await store.request('office_detail', roomId, roomPath, { child_id: childId });
            if (!value.open || expected !== generation) return;
            value.replayThrough = Math.max(value.cursor, ...(value.detail.events || []).map(event => Number(event.seq) || 0));
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
                if (node) {
                    detailShell(node, value, rowFor(value.childId));
                    const replay = Number(event.seq) <= value.replayThrough || Date.parse(event.timestamp) <= value.openedAt;
                    if (replay) root.MoonYaProcessUI.withoutAnimation(() => renderRecords(node, value));
                    else renderRecords(node, value);
                }
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
            const trace = [...container.querySelectorAll('[data-process-turn]')].find(node => node.dataset.processTurn === key) || [...container.querySelectorAll('[data-turn-process]')].find(node => node.dataset.turnProcess === key);
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
                const value = entry(row.child_id); if (value.open) { detailShell(node, value, row); renderRecords(node, value); }
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
        container.querySelectorAll('.subagent-header').forEach(header => { root.MoonYaProcessUI.disclose(header, header.nextElementSibling, false, false); });
        observer = new MutationObserver(schedule); observer.observe(container, { childList: true });
        release = store.watch(id, path, snapshot => { employees = snapshot.employees; hydrated = snapshot.hydrated; schedule(); });
    }
    document.addEventListener('click', event => {
        const header = event.target.closest('.subagent-header'); if (!header || !container?.contains(header)) return;
        const node = header.closest('.subagent-disclosure'), value = entry(node.dataset.childId);
        if (header.getAttribute('aria-expanded') === 'true') { close(value); root.MoonYaProcessUI.disclose(header, node.querySelector('.subagent-detail'), false); }
        else openDetail(node.dataset.childId);
    });
    root.addEventListener('pagehide', () => { cache.forEach(close); clearTimeout(detailSchedule); clearTimeout(detailRetry); detailController?.abort(); if (release) release(); });
    root.addEventListener('moonya:subagent-cleared', event => {
        const prefix = String(event.detail) + ':';
        cache.forEach((value, key) => { if (key.startsWith(prefix)) { close(value); cache.delete(key); } });
    });
    root.MoonYaSubagentChat = { bind, createHost, serializeHost, refresh: schedule, configure: value => { options = value; } };
}(window));
