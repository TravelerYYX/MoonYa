<?php /** Authenticated Work office backed by the DeepSeek subagent catalog. */ ?>
<script>
(function () {
    'use strict';
    var officeView = document.getElementById('officeView'), stage = document.getElementById('officeStage');
    if (!officeView || !stage) return;
    var prototype = stage.querySelector('.workstation').cloneNode(true);
    var concurrency = document.getElementById('officeConcurrency'), notice = document.getElementById('officeNotice'), card = document.getElementById('officeEmployeeCard');
    var rows = new Map(), sessionId = '', projectPath = '';
    var generation = 0, selectedId = '', detailGeneration = 0;
    var popoutRoom = new URLSearchParams(window.location.search).get('office_session') || '', popoutPath = new URLSearchParams(window.location.search).get('office_project') || '', popoutWindows = new Set();
    var stateLabels = { queued: '排队中', running: '运行中', waiting: '等待中', completed: '完成 / 空闲', failed: '失败', cancelled: '已取消' };
    var avatars = ['search', 'code', 'file', 'browser', 'computer', 'app', 'image', 'voice'];
    function showError(error) { notice.textContent = error.message || String(error); }
    function api(action, values, post, signal) {
        values = Object.assign({ session_id: sessionId, project_path: projectPath }, values || {});
        var url = 'harness_api.php?action=' + action, options = { credentials: 'same-origin', headers: typeof getAuthHeaders === 'function' ? getAuthHeaders() : {}, signal: signal };
        if (post) { options.method = 'POST'; options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers); options.body = JSON.stringify(values); }
        else url += '&' + new URLSearchParams(values);
        return fetch(url, options).then(function (response) { return response.json(); }).then(function (result) {
            if (!result.success) throw new Error(result.error || result.content || '办公室暂时无法连接运行时');
            return result.data;
        });
    }
    function layoutOffice() {
        var stations = Array.from(stage.querySelectorAll('.workstation')), width = stage.clientWidth;
        if (!width) return;
        var columns = Math.max(1, Math.floor((width - 48) / 245));
        var gap = Math.min(285, Math.max(220, (width - 48) / columns));
        var height = Math.max(stage.clientHeight, Math.ceil(stations.length / columns) * 245 + 100);
        stage.querySelector('.office-floor').style.height = (height - 54) + 'px';
        stations.forEach(function (station, index) {
            var row = Math.floor(index / columns), col = index % columns;
            station.dataset.row = row; station.dataset.col = col;
            station.style.transform = 'translate(' + Math.round(24 + (gap - 220) / 2 + col * gap) + 'px,' + (72 + row * 245) + 'px)';
        });
    }
    function render() {
        var existing = new Map(); stage.querySelectorAll('[data-child-id]').forEach(function (node) { existing.set(node.dataset.childId, node); });
        Array.from(rows.values()).filter(function (row) { return row.established; }).sort(function (a, b) { return a.order - b.order; }).forEach(function (row) {
            var node = existing.get(row.child_id);
            if (!node) {
                node = prototype.cloneNode(true); node.dataset.childId = row.child_id; node.setAttribute('role', 'button'); node.tabIndex = 0;
                node.addEventListener('click', function () { openDetail(row.child_id); });
                node.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(row.child_id); } });
                stage.appendChild(node);
            }
            existing.delete(row.child_id); node.dataset.state = row.status; node.dataset.character = row.avatar;
            node.classList.toggle('ws-active', row.status === 'running');
            node.querySelector('.ws-name').textContent = row.label || '子代理 ' + (row.order + 1);
            node.querySelector('.ws-status').textContent = stateLabels[row.status] || row.status;
            node.querySelector('.ws-character').src = '/assets/office/seated-back/' + (avatars.indexOf(row.avatar) >= 0 ? row.avatar : 'search') + '.png';
            node.setAttribute('aria-label', (row.label || '子代理') + '：' + (stateLabels[row.status] || row.status));
        });
        existing.forEach(function (node) { node.remove(); }); layoutOffice();
    }
    var store = window.MoonYaSubagentStore, release = null;
    function applyEvent(event) { store.applyEvent(event); }
    function disconnect() { if (release) release(); release = null; }
    function observe() {
        if (release || !sessionId || !isOpen()) return release?.ready;
        var expected = generation;
        release = store.watch(sessionId, projectPath, function (snapshot) {
            if (expected !== generation) return;
            rows = new Map(snapshot.employees.map(function (row) { row.established = true; return [row.child_id, row]; }));
            render(); if (snapshot.concurrency) concurrency.value = snapshot.concurrency;
            if (snapshot.error) notice.textContent = snapshot.error;
            if (selectedId && !rows.has(selectedId)) closeCard();
            else if (selectedId) openDetail(selectedId);
        });
        return release.ready;
    }
    async function bind(id, path, forceUnbind) {
        if (popoutRoom && !forceUnbind) { id = popoutRoom; path = popoutPath; }
        id = String(id || ''); path = String(path || '');
        if (id === sessionId && path === projectPath) { await observe(); return; }
        disconnect(); generation++; sessionId = id; projectPath = path; rows.clear(); closeCard(); notice.textContent = ''; render();
        popoutWindows.forEach(function (child) { if (child.closed) popoutWindows.delete(child); else child.postMessage({ type: 'moonya-office-context', session_id: id, project_path: path }, window.location.origin); });
        await observe();
    }
    function syncContext() {
        var fixed = new URLSearchParams(window.location.search);
        if (fixed.get('office_session')) { bind(fixed.get('office_session'), fixed.get('office_project') || ''); return; }
        if (typeof currentConversationMode === 'function' && currentConversationMode() !== 'work') { bind('', ''); return; }
        var runtime = typeof getConversationRuntime === 'function' && typeof currentChatId !== 'undefined' ? getConversationRuntime(currentChatId) : null;
        bind(runtime && runtime.harnessSessionId || '', runtime && runtime.workspaceIdentity && runtime.workspaceIdentity !== '__default__' ? runtime.workspaceIdentity : '');
    }
    function closeCard() { selectedId = ''; detailGeneration++; card.hidden = true; }
    async function openDetail(id) {
        selectedId = id; var expected = ++detailGeneration, room = generation; card.hidden = false;
        try {
            var detail = await api('office_detail', { child_id: id }); if (expected !== detailGeneration || room !== generation) return;
            document.getElementById('officeEmployeeTitle').textContent = detail.label;
            document.getElementById('officeEmployeeStatus').textContent = stateLabels[detail.status] || detail.status;
            document.getElementById('officeEmployeeTask').textContent = detail.task || '';
            var parent = rows.get(detail.parent_id);
            document.getElementById('officeEmployeeRelations').textContent = '父代理：' + (parent ? parent.label : 'MoonYa') + ' · 直接下级：' + detail.children.length;
            document.getElementById('officeEmployeeResult').textContent = detail.result || '';
            document.getElementById('officeEmployeeLog').textContent = detail.events.map(function (event) { return event.event + '\n' + event.payload; }).join('\n\n');
            document.getElementById('officeEmployeeStop').disabled = ['completed', 'failed', 'cancelled'].indexOf(detail.status) >= 0;
        } catch (error) { if (room === generation) showError(error); }
    }
    function open() { document.body.classList.add('office-active'); officeView.setAttribute('aria-hidden', 'false'); syncContext(); requestAnimationFrame(layoutOffice); api('office_settings').then(function (settings) { concurrency.value = settings.concurrency; }).catch(showError); }
    function close() { document.body.classList.remove('office-active'); officeView.setAttribute('aria-hidden', 'true'); disconnect(); closeCard(); }
    function isOpen() { return document.body.classList.contains('office-active'); }
    function setAuthenticated(authenticated) { document.body.dataset.authenticated = authenticated ? '1' : '0'; if (!authenticated) { disconnect(); bind('', '', true); } else if (isOpen()) open(); }
    document.getElementById('officeCardClose').addEventListener('click', closeCard);
    document.getElementById('officeEmployeeStop').addEventListener('click', async function () {
        var id = selectedId; this.disabled = true;
        try { await api('office_cancel', { child_id: id }, true); await openDetail(id); } catch (error) { showError(error); this.disabled = false; }
    });
    concurrency.addEventListener('change', function () {
        var value = Number(concurrency.value); if (!Number.isSafeInteger(value) || value < 1) { notice.textContent = '并发数必须是正整数'; return; }
        api('office_settings', { concurrency: value }, true).then(function () { notice.textContent = '并发设置已保存'; }).catch(showError);
    });
    document.getElementById('officePopoutBtn').addEventListener('click', function () { var child = window.open('/index.php?' + new URLSearchParams({ office_popout: '1', office_session: sessionId, office_project: projectPath }), '_blank'); if (child) popoutWindows.add(child); });
    window.addEventListener('message', function (event) {
        if (event.origin !== window.location.origin || !event.data) return;
        if (event.data.type === 'moonya-office-context-request' && popoutWindows.has(event.source))
            event.source.postMessage({ type: 'moonya-office-context', session_id: sessionId, project_path: projectPath }, window.location.origin);
        if (event.data.type === 'moonya-office-context' && event.source === window.opener && !popoutRoom && event.data.session_id) {
            popoutRoom = String(event.data.session_id); popoutPath = String(event.data.project_path || ''); bind(popoutRoom, popoutPath);
        }
    });
    window.addEventListener('resize', function () { if (isOpen()) layoutOffice(); });
    window.MoonYaOffice = { open: open, close: close, isOpen: isOpen, layout: layoutOffice, setAuthenticated: setAuthenticated, bind: bind, syncContext: syncContext, applyEvent: applyEvent,
        clearConversation: function (chat) { return Promise.all(Object.entries(chat && chat.runtimeSessions || {}).map(function (entry) { return api('office_clear', { session_id: entry[1], project_path: entry[0] === '__default__' ? '' : entry[0] }, true).then(function () { store.forget(entry[1]); }); })).catch(showError); } };
    window.closeOfficeMode = close;
    if (document.body.dataset.officePopout === '1' || (isOpen() && document.body.dataset.authenticated === '1')) open();
    if (document.body.dataset.officePopout === '1' && window.opener) window.opener.postMessage({ type: 'moonya-office-context-request' }, window.location.origin);
}());
</script>
