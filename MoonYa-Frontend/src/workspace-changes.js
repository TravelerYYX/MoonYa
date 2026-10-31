/* Turn-end changed-file cards. Durable coordinates, delegated controls, no inline scripts. */
(() => {
    'use strict';
    const scopeNote = '统计本轮期间工作区的净变化，包含主代理、子代理和命令修改，也可能包含其他聊天或人工编辑。轮次结束后的后台修改不计入。';
    const errors = {
        workspace_is_running: '工作区仍有任务运行，请结束任务后再撤销或迁移。',
        workspace_has_background_commands: '工作区仍有后台命令运行，请停止后台命令后再操作。',
        workspace_operation_in_progress: '工作区正在迁移或撤销，请稍后重试。',
        workspace_migration_target_exists: '目标已存在聊天目录，请选择其他目录。',
        change_record_not_ready: '变更记录正在处理或需要恢复，请刷新后重试。',
        workspace_root_must_be_absolute: '请输入完整的绝对目录路径。'
    };
    const bound = new WeakSet(), states = new WeakMap();
    const interactive = new WeakSet();
    const pendingCards = new WeakMap(), liveSummaries = new WeakMap();
    let activeCard = null, pinned = false, closingPopover = false, closeTimer = 0, popoverId = 0;
    let liveRuntime = null, liveTimer = 0, liveGeneration = 0, liveHost = null, liveCard = null;
    function node(tag, className, text) {
        const element = document.createElement(tag); element.className = className || '';
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function button(className, text, action) {
        const element = node('button', className, text); element.type = 'button';
        if (action) element.dataset.changesAction = action;
        return element;
    }
    function coordinates(card) {
        return { session_id: card.dataset.sessionId, turn: Number(card.dataset.turn),
            client_chat_id: card.dataset.chatId, project_path: card.dataset.projectPath || '' };
    }
    async function request(action, data, write = false) {
        const response = await fetch('/harness_api.php?action=' + action + (write ? '' : '&' + new URLSearchParams(data)),
            write ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
        const result = await response.json();
        if (!response.ok || !result.success) {
            const code = result.error_code || result.error || '请求失败';
            const error = new Error(errors[code] || (String(code).startsWith('workspace_migration_target_exists') ? errors.workspace_migration_target_exists : String(code)));
            error.data = result.data; throw error;
        }
        return result.data;
    }
    function counts(file) {
        const host = node('span', 'changes-counts');
        if (file.binary || file.oversized) host.append(node('span', 'changes-kind', file.binary ? '二进制' : '大文件'));
        else host.append(node('span', 'changes-added', '+' + file.added), node('span', 'changes-deleted', '-' + file.deleted));
        return host;
    }
    function draw(card, summary) {
        if (!card.classList.contains('changes-running')) return drawCompleted(card, summary);
        const reopen = activeCard === card, wasPinned = pinned;
        if (reopen) closePopover();
        card.replaceChildren(); states.set(card, summary);
        if (!summary || !summary.total) { card.hidden = true; return; }
        card.hidden = false; card.dataset.revision = String(summary.revision);
        const header = button('changes-header', undefined, 'toggle');
        header.append(node('span', 'changes-title', summary.total + (summary.state === 'undone' ? ' 个文件已撤销' : ' 个文件已更改')), counts(summary));
        header.setAttribute('aria-expanded', 'false'); header.setAttribute('aria-controls', 'changes-popover-' + ++popoverId);
        header.setAttribute('aria-label', header.textContent + '，查看文件列表');
        const popover = node('div', 'changes-popover'); popover.id = header.getAttribute('aria-controls');
        popover.setAttribute('popover', 'manual'); popover.setAttribute('role', 'region'); popover.setAttribute('aria-label', '本轮变更文件');
        const undo = button('changes-undo', '撤销', 'undo');
        const undoIcon = node('span'); undoIcon.innerHTML = MoonYaIcons.icon('undo'); undo.append(undoIcon);
        undo.disabled = true;
        undo.dataset.tooltip = '任务运行中，请结束任务后再撤销';
        card.append(header);
        const list = node('div', 'changes-files');
        summary.files.forEach(file => {
            const row = button('changes-file', undefined, 'file'); row.dataset.fileId = file.id;
            row.dataset.tooltip = file.display + '\n' + ({ added: '新增文件', deleted: '删除文件', modified: '修改文件' })[file.kind];
            row.append(node('span', 'changes-path', file.display.replace(/\\/g, '/').split('/').at(-1)), counts(file)); list.append(row);
        });
        const actions = node('div', 'changes-popover-actions'), reviewButton = button('changes-review', '查看变更', 'review');
        reviewButton.dataset.tooltip = scopeNote; actions.append(undo, reviewButton);
        popover.append(list, actions, node('div', 'changes-status', summary.state === 'recovery_required' ? '撤销恢复未完成，请保留文件并检查工作区。' : ''));
        card.append(popover); bound.add(card);
        if (!interactive.has(card)) {
            interactive.add(card);
            card.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') openPopover(card); });
            card.addEventListener('pointerleave', () => scheduleClose(card));
            card.addEventListener('focusin', () => { if (!closingPopover) openPopover(card); });
            card.addEventListener('focusout', () => {
                setTimeout(() => { if (activeCard === card && !card.contains(document.activeElement)) closePopover(); }, 0);
            });
        }
        if (reopen) { openPopover(card); pinned = wasPinned; }
    }
    function drawCompleted(card, summary) {
        if (activeCard === card) closePopover();
        const expanded = card.querySelector('[data-changes-action="expand"]')?.getAttribute('aria-expanded') === 'true';
        card.replaceChildren(); states.set(card, summary);
        if (!summary || !summary.total) { card.hidden = true; return; }
        card.hidden = false; card.dataset.revision = String(summary.revision);
        const header = node('div', 'changes-header'), icon = node('span', 'changes-icon');
        icon.innerHTML = MoonYaIcons.icon('file-changes');
        const info = node('div', 'changes-info');
        info.append(node('div', 'changes-title', (summary.state === 'undone' ? '已撤销 ' : '已编辑 ') + summary.total + ' 个文件'), counts(summary));
        const undo = button('changes-undo', '撤销', 'undo'), undoIcon = node('span');
        undoIcon.innerHTML = MoonYaIcons.icon('undo'); undo.append(undoIcon);
        undo.disabled = summary.state !== 'ready';
        undo.dataset.tooltip = summary.state === 'undone' ? '本轮文件修改已撤销' : '恢复本轮修改前的文件；有后续修改时整轮拒绝撤销';
        header.append(icon, info, undo, button('changes-review', '查看变更', 'review')); header.dataset.tooltip = scopeNote;
        const list = node('div', 'changes-files');
        summary.files.forEach((file, index) => {
            const row = button('changes-file', undefined, 'file'); row.dataset.fileId = file.id; row.hidden = index >= 3 && !expanded;
            row.dataset.tooltip = file.display + '\n' + ({ added: '新增文件', deleted: '删除文件', modified: '修改文件' })[file.kind];
            row.append(node('span', 'changes-path', file.display), counts(file)); list.append(row);
        });
        card.append(header, list);
        if (summary.total > 3) {
            const expand = button('changes-expand', expanded ? '收起文件列表' : '再显示 ' + (summary.total - 3) + ' 个文件', 'expand');
            expand.setAttribute('aria-expanded', String(expanded));
            const chevron = node('span'); chevron.innerHTML = MoonYaIcons.icon('chevron'); expand.append(chevron); card.append(expand);
        }
        if (summary.state === 'recovery_required') card.append(node('div', 'changes-status', '撤销恢复未完成，请保留文件并检查工作区。'));
        card.append(node('div', 'changes-status')); bound.add(card);
    }
    function closePopover() {
        clearTimeout(closeTimer);
        if (!activeCard) return;
        const card = activeCard; activeCard = null; pinned = false;
        const popover = card.querySelector('.changes-popover');
        closingPopover = true;
        try { if (popover?.matches(':popover-open')) popover.hidePopover(); }
        finally { closingPopover = false; }
        card.querySelector('.changes-header')?.setAttribute('aria-expanded', 'false');
    }
    function positionPopover() {
        if (!activeCard) return;
        const anchor = activeCard.querySelector('.changes-header'), popover = activeCard.querySelector('.changes-popover');
        const rect = anchor.getBoundingClientRect(), container = activeCard.closest('.messages-container');
        const bounds = container?.getBoundingClientRect();
        if (!anchor.checkVisibility() || container?.hidden || (bounds && (rect.bottom < bounds.top || rect.top > bounds.bottom))) { closePopover(); return; }
        const above = Math.max(0, rect.top - 16), below = Math.max(0, innerHeight - rect.bottom - 16);
        const placeAbove = above >= 120 || above >= below;
        popover.style.maxHeight = Math.min(360, placeAbove ? above : below) + 'px';
        const box = popover.getBoundingClientRect();
        popover.style.left = Math.max(8, Math.min(rect.left, innerWidth - box.width - 8)) + 'px';
        popover.style.top = (placeAbove ? rect.top - box.height - 6 : rect.bottom + 6) + 'px';
    }
    function openPopover(card) {
        clearTimeout(closeTimer);
        if (activeCard === card) return;
        const popover = card.querySelector('.changes-popover');
        if (!popover || !card.isConnected || card.hidden) return;
        closePopover(); activeCard = card;
        popover.showPopover(); card.querySelector('.changes-header').setAttribute('aria-expanded', 'true');
        positionPopover();
    }
    function scheduleClose(card) {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            if (activeCard === card && !pinned && !card.matches(':hover') && !card.contains(document.activeElement)) closePopover();
        }, 160);
    }
    document.addEventListener('pointerdown', event => { if (activeCard && !activeCard.contains(event.target)) closePopover(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && activeCard) {
            activeCard.querySelector('.changes-header').focus({ preventScroll: true }); closePopover(); event.preventDefault();
        }
    });
    document.addEventListener('scroll', positionPopover, true);
    window.addEventListener('resize', positionPopover);
    async function refresh(card) {
        try { draw(card, await request('changes_summary', coordinates(card))); }
        catch (error) { const status = card.querySelector('.changes-status') || node('div', 'changes-status'); status.textContent = '变更记录暂不可用：' + error.message; card.append(status); }
    }
    function create(summary, content, runtime) {
        let card = [...content.querySelectorAll(':scope > .workspace-changes-card')].find(item => item.dataset.sessionId === summary.session_id && Number(item.dataset.turn) === summary.turn);
        if (!card) {
            card = node('section', 'workspace-changes-card'); card.setAttribute('aria-label', '本轮文件变更');
            Object.assign(card.dataset, { sessionId: summary.session_id, turn: String(summary.turn), chatId: String(runtime.chatId),
                projectPath: runtime.workspaceIdentity === '__default__' ? '' : runtime.workspaceIdentity || '' });
        }
        draw(card, summary); content.append(card);
        if (runtime.running) {
            card.hidden = true;
            const pending = pendingCards.get(runtime) || new Set(); pending.add(card); pendingCards.set(runtime, pending);
            liveSummaries.set(runtime, summary); sync(runtime);
        }
        return card;
    }
    function begin(runtime, turn) {
        if (!Number.isSafeInteger(turn) || turn < 1) return;
        if (runtime.changeTurn === turn) { sync(runtime); return; }
        runtime.changeTurn = turn; liveSummaries.delete(runtime); sync(runtime);
    }
    function renderLive(runtime, summary) {
        if (runtime !== liveRuntime || !runtime.running || runtime.container.dataset.runtimeActive !== '1') return;
        if (!liveHost && !summary?.total) return;
        if (!liveHost) {
            liveHost = node('div', 'running-changes-host'); liveHost.hidden = true;
            liveCard = node('section', 'workspace-changes-card changes-running'); liveCard.setAttribute('aria-label', '运行中的文件变更');
            liveHost.append(liveCard); document.querySelector('.input-container-wrapper').append(liveHost);
        }
        const same = liveCard.dataset.chatId === String(runtime.chatId) && JSON.stringify(states.get(liveCard)) === JSON.stringify(summary);
        Object.assign(liveCard.dataset, { sessionId: runtime.harnessSessionId || summary?.session_id || '', turn: String(runtime.changeTurn || summary?.turn || 0),
            chatId: String(runtime.chatId), projectPath: runtime.workspaceIdentity === '__default__' ? '' : runtime.workspaceIdentity || '' });
        if (!same) draw(liveCard, summary); liveHost.hidden = !summary?.total;
    }
    function sync(runtime) {
        if (!runtime) return;
        if (!runtime.running) {
            pendingCards.get(runtime)?.forEach(card => { if (card.isConnected) card.hidden = !states.get(card)?.total; });
            pendingCards.delete(runtime);
        }
        const active = runtime.container.dataset.runtimeActive === '1' && !runtime.container.hidden;
        if (!active && liveRuntime !== runtime) return;
        const next = active && runtime.running && runtime.mode === 'work' ? runtime : null;
        if (next === liveRuntime) { if (next) renderLive(next, liveSummaries.get(next)); return; }
        clearTimeout(liveTimer); const generation = ++liveGeneration; liveRuntime = next;
        if (liveHost) { if (activeCard === liveCard) closePopover(); liveHost.hidden = true; }
        if (!next) return;
        renderLive(next, liveSummaries.get(next));
        async function poll() {
            if (generation !== liveGeneration || !next.running || next.container.dataset.runtimeActive !== '1') return;
            try {
                if (next.harnessSessionId && next.changeTurn) {
                    const summary = await request('changes_summary', { session_id: next.harnessSessionId, turn: next.changeTurn,
                        client_chat_id: next.chatId, project_path: next.workspaceIdentity === '__default__' ? '' : next.workspaceIdentity || '' });
                    if (generation !== liveGeneration || !next.running) return;
                    liveSummaries.set(next, summary); renderLive(next, summary);
                }
            } catch { /* Files can change during a snapshot; retry without blocking output. */ }
            if (generation === liveGeneration) liveTimer = setTimeout(poll, 1500);
        }
        void poll();
    }
    async function review(card, fileId) {
        const summary = states.get(card); if (!summary?.files?.length) return;
        const dialog = node('dialog', 'changes-dialog');
        const heading = node('div', 'changes-dialog-heading'); heading.append(node('strong', '', '本轮文件变更'));
        const close = button('changes-dialog-close', '关闭'); close.addEventListener('click', () => dialog.close()); heading.append(close);
        const body = node('div', 'changes-dialog-body'), list = node('nav', 'changes-dialog-files'), pane = node('div', 'changes-diff');
        list.setAttribute('aria-label', '变更文件'); pane.setAttribute('aria-live', 'polite');
        let version = 0;
        async function select(file) {
            const current = ++version;
            list.querySelectorAll('button').forEach(row => row.classList.toggle('selected', row.dataset.fileId === file.id));
            pane.replaceChildren(node('p', '', '正在加载差异…'));
            try {
                const diff = await request('changes_diff', { ...coordinates(card), file_id: file.id });
                if (version !== current || !dialog.isConnected) return;
                pane.replaceChildren(node('div', 'changes-diff-name', file.display));
                if (diff.kind !== 'text') { pane.append(node('p', '', diff.kind === 'binary' ? '二进制文件不提供文本差异，原始文件已保存，可撤销。' : '文件超过 2 MiB，不渲染全文差异，原始文件已保存，可撤销。')); return; }
                if (diff.coarse) pane.append(node('p', '', '差异计算超时，以下显示整文件替换。'));
                if (!diff.hunks.length) pane.append(node('p', '', '文本行内容相同，变化仅涉及换行、编码或文件属性。'));
                for (const hunk of diff.hunks) {
                    pane.append(node('div', 'changes-hunk', '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'));
                    let oldLine = hunk.oldStart, newLine = hunk.newStart;
                    for (const text of hunk.lines) {
                        const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'delete' : text.startsWith('\\') ? 'note' : 'context';
                        const line = node('div', 'changes-diff-line changes-line-' + kind);
                        line.append(node('span', 'changes-line-number', kind === 'add' || kind === 'note' ? '' : String(oldLine++)),
                            node('span', 'changes-line-number', kind === 'delete' || kind === 'note' ? '' : String(newLine++)), node('code', '', text));
                        pane.append(line);
                    }
                }
            } catch (error) { if (current === version) pane.replaceChildren(node('p', '', error.message)); }
        }
        for (const file of summary.files) {
            const row = button('changes-dialog-file', file.display); row.dataset.fileId = file.id; row.dataset.tooltip = file.display;
            row.addEventListener('click', () => void select(file)); list.append(row);
        }
        body.append(list, pane); dialog.append(heading, body); document.body.append(dialog);
        dialog.addEventListener('close', () => { version++; dialog.remove(); card.querySelector(card.classList.contains('changes-running') ? '.changes-header' : '[data-changes-action="review"]')?.focus({ preventScroll: true }); closePopover(); }, { once: true });
        dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
        dialog.showModal(); void select(summary.files.find(file => file.id === fileId) || summary.files[0]);
    }
    function confirmUndo(count) {
        return new Promise(resolve => {
            const dialog = node('dialog', 'changes-confirm');
            dialog.append(node('strong', '', '撤销本轮文件修改？'), node('p', '', '将恢复 ' + count + ' 个文件的修改前状态，并移除本轮新增文件。如有后续修改，将拒绝整轮撤销。'));
            const actions = node('div', 'changes-confirm-actions');
            const cancel = button('changes-review', '取消'), accept = button('changes-review', '确认撤销');
            cancel.addEventListener('click', () => dialog.close('cancel')); accept.addEventListener('click', () => dialog.close('confirm'));
            actions.append(cancel, accept); dialog.append(actions); document.body.append(dialog);
            dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); resolve(accepted); }, { once: true });
            dialog.showModal(); cancel.focus();
        });
    }
    document.addEventListener('click', async event => {
        const control = event.target.closest('[data-changes-action]'), card = control?.closest('.workspace-changes-card');
        if (!card) return;
        const summary = states.get(card); if (!summary) return;
        if (control.dataset.changesAction === 'expand') {
            const expanded = control.getAttribute('aria-expanded') !== 'true'; control.setAttribute('aria-expanded', String(expanded));
            card.querySelectorAll('.changes-file').forEach((row, index) => { row.hidden = index >= 3 && !expanded; });
            control.firstChild.textContent = expanded ? '收起文件列表' : '再显示 ' + (summary.total - 3) + ' 个文件';
        } else if (control.dataset.changesAction === 'toggle') {
            if (activeCard === card && pinned) closePopover();
            else { openPopover(card); pinned = true; }
        } else if (['review', 'file'].includes(control.dataset.changesAction)) { closePopover(); void review(card, control.dataset.fileId); }
        else if (control.dataset.changesAction === 'undo') {
            if (card.dataset.busy === '1') return;
            card.dataset.busy = '1'; control.disabled = true;
            try {
                closePopover();
                if (!await confirmUndo(summary.total)) return;
                const updated = await request('changes_undo', { ...coordinates(card), revision: summary.revision, request_id: crypto.randomUUID() }, true);
                draw(card, updated); window.dispatchEvent(new CustomEvent('moonya:changes-updated', { detail: coordinates(card) }));
            } catch (error) {
                card.querySelector('.changes-status').textContent = error.data?.conflicts?.length ? '以下文件已有后续修改，整轮未撤销：\n' + error.data.conflicts.join('\n') : '撤销失败：' + error.message;
                if (card.classList.contains('changes-running')) { openPopover(card); pinned = true; }
            } finally { delete card.dataset.busy; card.querySelector('[data-changes-action="undo"]').disabled = states.get(card)?.state !== 'ready'; }
        }
    });
    function hydrate(root = document) {
        const cards = [...root.querySelectorAll('.workspace-changes-card:not(.changes-running)')];
        if (root.matches?.('.workspace-changes-card:not(.changes-running)')) cards.push(root);
        for (const card of cards) if (!bound.has(card)) { bound.add(card); void refresh(card); }
    }
    const observer = new MutationObserver(records => {
        for (const record of records) for (const child of record.addedNodes) if (child.nodeType === 1) hydrate(child);
        if (activeCard && (!activeCard.isConnected || activeCard.closest('[hidden]'))) closePopover();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    window.MoonYaChanges = { create, hydrate, request, refresh, begin, sync };
})();
