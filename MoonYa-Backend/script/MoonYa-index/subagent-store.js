/* Durable office facts shared by the office and the conversation view. */
(function (root) {
    'use strict';
    const rooms = new Map();
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    const avatars = ['search', 'code', 'file', 'browser', 'computer', 'app', 'image', 'voice'];
    async function request(action, id, path, values, post, signal) {
        const input = Object.assign({ session_id: id, project_path: path || '' }, values || {});
        let url = 'harness_api.php?action=' + action;
        const options = { credentials: 'same-origin', headers: typeof getAuthHeaders === 'function' ? getAuthHeaders() : {}, signal };
        if (post) { options.method = 'POST'; options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers); options.body = JSON.stringify(input); }
        else url += '&' + new URLSearchParams(input);
        const response = await fetch(url, options);
        const result = await response.json();
        if (!result.success) throw new Error(result.error || result.content || '子代理状态暂时无法读取');
        return result.data;
    }
    async function readStream(url, signal, onEvent) {
        const response = await fetch(url, { credentials: 'same-origin', headers: typeof getAuthHeaders === 'function' ? getAuthHeaders() : {}, signal });
        if (!response.ok || !(response.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('子代理记录连接失败');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (data) onEvent(JSON.parse(data));
            }
        }
    }
    function room(id, path) {
        let state = rooms.get(id);
        if (!state) { state = { id, path: path || '', rows: new Map(), listeners: new Set(), cursor: 0, floor: 0, clearSeq: 0, loading: false, buffered: [], generation: 0 }; rooms.set(id, state); }
        return state;
    }
    function snapshot(state) {
        return { session_id: state.id, seq: state.cursor, concurrency: state.concurrency, hydrated: !!state.hydrated,
            employees: [...state.rows.values()].filter(row => row.established).sort((a, b) => (a.created_seq || a.order) - (b.created_seq || b.order)).map((row, order) => ({ ...row, order })), error: state.error || '' };
    }
    function publish(state) { const value = snapshot(state); state.listeners.forEach(listener => listener(value)); }
    function apply(state, event) {
        if (state.loading) { state.buffered.push(event); return; }
        const name = event.event, payload = event.payload || {}, seq = Number(event.seq || 0);
        state.cursor = Math.max(state.cursor, seq);
        if (seq <= state.floor || seq <= state.clearSeq) return;
        if (name === 'office/cleared') { state.clearSeq = seq; state.rows.clear(); state.hydrated = true; publish(state); root.dispatchEvent(new CustomEvent('moonya:subagent-cleared', { detail: state.id })); return; }
        const id = name === 'subagent/catalog' ? payload.childId : payload.child_id || payload.id;
        if (!id || !['subagent/catalog', 'subagent/start', 'subagent/end', 'office/agent-state', 'office/appearance'].includes(name)) return;
        let row = state.rows.get(id);
        if (!row) { row = { child_id: id, order: state.rows.size, label: '', status: 'queued', avatar: avatars[state.rows.size % avatars.length], seq: 0 }; state.rows.set(id, row); }
        row.seq = Math.max(row.seq, seq);
        if (name === 'subagent/catalog') {
            if (seq <= (row.catalogSeq || 0)) return;
            if (!row.established) {
                row.order = [...state.rows.values()].filter(item => item.established).length;
                row.created_seq = seq; row.created_turn = event.turn || state.rows.get(event.origin_session_id)?.created_turn || 1;
            }
            row.established = true; row.catalogSeq = seq; row.label = String(payload.label || '').trim(); row.parent_id = event.origin_session_id || state.id;
        }
        if (name === 'office/appearance') {
            if (seq <= (row.appearanceSeq || 0)) return;
            row.appearanceSeq = seq; row.avatar = payload.avatar; row.task = payload.task;
        }
        if (['subagent/start', 'subagent/end', 'office/agent-state'].includes(name)) {
            if (seq <= (row.stateSeq || 0)) return;
            row.stateSeq = seq;
        }
        if (name === 'subagent/start' && row.status !== 'cancelled') { row.status = 'running'; row.run_id = payload.runId; }
        if (name === 'office/agent-state' && !terminal.has(row.status)) row.status = payload.state;
        if (name === 'subagent/end' && row.status !== 'cancelled') {
            row.status = payload.stopReason === 'completed' ? 'completed' : payload.stopReason === 'aborted' ? 'cancelled' : 'failed';
            row.result = (payload.lastAssistantMessage || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        }
        if (payload.cancelled) row.status = 'cancelled';
        publish(state);
    }
    function disconnect(state) { clearTimeout(state.retry); state.retry = null; state.controller?.abort(); state.controller = null; }
    async function subscribe(state, generation) {
        if (!state.listeners.size || state.controller || state.loading || generation !== state.generation) return;
        const controller = new AbortController(); state.controller = controller;
        try {
            await readStream('harness_api.php?' + new URLSearchParams({ action: 'office_events', session_id: state.id, project_path: state.path, after_seq: state.cursor }), controller.signal, event => apply(state, event));
        } catch (error) { if (error.name !== 'AbortError' && generation === state.generation) { state.error = error.message; publish(state); } }
        finally {
            if (state.controller === controller) state.controller = null;
            if (!controller.signal.aborted && state.listeners.size && generation === state.generation) state.retry = setTimeout(() => refresh(state), 1500);
        }
    }
    async function refresh(state) {
        if (state.loading || !state.listeners.size) return;
        const generation = state.generation; state.loading = true; state.buffered = [];
        try {
            const value = await request('office_state', state.id, state.path);
            if (generation !== state.generation) return;
            if (value.seq >= state.clearSeq) {
                const present = new Set(value.employees.map(row => row.child_id));
                state.rows.forEach((row, id) => { if (!present.has(id) && row.seq <= value.seq) state.rows.delete(id); });
                value.employees.forEach(row => {
                    const current = state.rows.get(row.child_id);
                    if (current && current.seq > value.seq) { current.established = true; return; }
                    state.rows.set(row.child_id, Object.assign({}, row, { established: true, stateSeq: value.seq, catalogSeq: value.seq, appearanceSeq: value.seq }));
                });
            }
            state.floor = Math.max(state.floor, value.seq); state.cursor = Math.max(state.cursor, value.seq); state.concurrency = value.concurrency; state.error = ''; state.hydrated = true;
        } catch (error) { if (generation === state.generation) state.error = error.message; }
        finally {
            if (generation === state.generation) {
                state.loading = false; const events = state.buffered; state.buffered = [];
                events.sort((a, b) => a.seq - b.seq).forEach(event => apply(state, event)); publish(state); subscribe(state, generation);
            }
        }
    }
    function watch(id, path, listener) {
        const state = room(id, path); state.listeners.add(listener); listener(snapshot(state));
        const ready = state.ready || (state.ready = refresh(state).finally(() => { state.ready = null; }));
        const release = () => {
            state.listeners.delete(listener);
            if (!state.listeners.size) { disconnect(state); state.generation++; state.loading = false; state.buffered = []; state.ready = null; }
        };
        release.ready = ready; return release;
    }
    function applyEvent(event) {
        const id = String(event.session_id || event.root_run_id || event.run_id || '');
        if (!id) return;
        apply(room(id), event);
    }
    root.addEventListener('moonya:runtime-event', event => applyEvent(event.detail || {}));
    root.addEventListener('pagehide', () => rooms.forEach(disconnect));
    root.MoonYaSubagentStore = { watch, applyEvent, request, readStream, refresh: id => { const state = rooms.get(id); if (state) return refresh(state); },
        snapshot: id => rooms.has(id) ? snapshot(rooms.get(id)) : null,
        forget: id => { const state = rooms.get(id); root.dispatchEvent(new CustomEvent('moonya:subagent-cleared', { detail: id })); if (state) { state.rows.clear(); state.hydrated = true; publish(state); disconnect(state); state.generation++; state.loading = false; state.buffered = []; state.ready = null; if (state.listeners.size) refresh(state); } } };
}(window));
