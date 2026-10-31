/* Work project navigation. Project ownership and display placement are independent. */
(function () {
    'use strict';
    const store = window.MoonYaHistoryStore;
    const tree = document.getElementById('workspaceTree');
    let snapshot = { projects: [], layout: { sections: [], expanded: {} } }, renderToken = 0, visibleScope;
    const associated = new Set();
    let menu, menuTrigger, dragging;
    const icons = {
        folder: '<path d="M1.875 6.375h12M3.875 1.875h2.1c.53 0 1.04.21 1.41.59l.79.79h3.7a2 2 0 0 1 2 2v4.875a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V3.875a2 2 0 0 1 2-2Z"/>',
        folderOpen: '<path d="M1.875 11.875 1 5.125V4.75a2 2 0 0 1 2-2h2.1c.53 0 1.04.21 1.41.59l.79.79H11a2 2 0 0 1 2 2v.625M3.4 7.75a1.5 1.5 0 0 1 1.42-1h8.56a1.25 1.25 0 0 1 1.19 1.64l-1.31 4a1 1 0 0 1-.95.69H2.93a1.25 1.25 0 0 1-1.19-1.64Z"/>',
        pin: '<path d="m8 3 8 8-4 1-3 5-2-2-4 4m6-16-2 4-4 2 6 6"/>',
        edit: '<path d="m15 3 6 6-12 12H3v-6zM13 5l6 6"/>',
        section: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
        archive: '<path d="M3 3h18v5H3zM5 8v13h14V8M10 12h4"/>',
        close: '<path d="m6 6 12 12M6 18 18 6"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        chat: '<path d="M4 4h16v13H9l-5 4z"/>',
        chevron: '<path d="m8 5 7 7-7 7"/>',
        more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>'
    };
    function icon(name) {
        const span = document.createElement('span'); span.className = 'workspace-icon';
        const folder = name === 'folder' || name === 'folderOpen';
        if (folder) span.classList.add('workspace-folder-icon');
        span.innerHTML = '<svg viewBox="' + (folder ? '0 0 16 16' : '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="' + (folder ? '1' : '1.5') + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.chat) + '</svg>';
        return span;
    }
    function button(label, onClick, className = '') {
        const el = document.createElement('button'); el.type = 'button'; el.className = className;
        el.textContent = label;
        el.addEventListener('click', event => { event.stopPropagation(); void run(() => onClick(event)); });
        return el;
    }
    async function run(operation) {
        try { return await operation(); } catch (error) { showToast(error.message || '操作失败，请重试', 4000); return false; }
    }
    const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
    const byActivity = (a, b) => String(b.lastActivityAt || b.createdAt || '').localeCompare(String(a.lastActivityAt || a.createdAt || ''));
    function isBusy(scope, id) {
        const runtime = typeof conversationRuntimeContexts !== 'undefined' ? conversationRuntimeContexts.get(String(id)) : null;
        const chat = store.list(scope).find(item => String(item.id) === String(id));
        return !!((runtime?.historyScope === scope && (runtime.running || runtime.preparing)) ||
            ['starting', 'running', 'waiting_approval', 'recovering', 'stopping'].includes(chat?.taskState?.phase));
    }
    function syncRuntime(runtime) {
        const chat = store.list(runtime.historyScope).find(item => String(item.id) === String(runtime.chatId));
        if (!chat || !Object.hasOwn(chat, 'workingDirectory') || runtime.mode !== 'work') return;
        if (!runtime.composer) runtime.composer = snapshotConversationComposer(runtime);
        runtime.composer = Object.assign({}, runtime.composer, { projectPath: chat.workingDirectory,
            projectName: chat.projectName || '', projectId: chat.projectId || null, agentMode: true });
        runtime.workspaceIdentity = chat.activeWorkspaceIdentity || chat.workingDirectory || '__default__';
        runtime.harnessSessionId = chat.runtimeSessions?.[runtime.workspaceIdentity] || '';
    }
    function restoreComposer(runtime, composer) {
        const chat = store.list(runtime.historyScope).find(item => String(item.id) === String(runtime.chatId));
        if (chat && Object.hasOwn(chat, 'workingDirectory')) Object.assign(composer, {
            projectPath: chat.workingDirectory, projectName: chat.projectName || '', projectId: chat.projectId || null, agentMode: true });
    }
    function syncChanged(scope, ids) {
        if (typeof conversationRuntimeContexts === 'undefined') return;
        for (const id of ids) {
            const runtime = conversationRuntimeContexts.get(String(id));
            if (runtime?.historyScope !== scope) continue;
            syncRuntime(runtime);
            if (scope === CHAT_HISTORY_KEY && String(currentChatId) === String(id)) {
                renderConversationRuntimeComposer(runtime);
                if (window.MoonYaOffice) window.MoonYaOffice.bind(runtime.harnessSessionId, runtime.composer?.projectPath || '');
                window.MoonYaContextRing?.refresh();
            }
        }
    }
    async function request(action, body = {}, scope = CHAT_HISTORY_KEY) {
        const result = await store.sidebarRequest(scope, action, body);
        if (!result.success) throw new Error(result.message || '本地保存失败，请重试');
        return result.data;
    }
    async function newChatBinding(scope, options) {
        const data = await request('list', {}, scope);
        const explicitPath = Object.hasOwn(options, 'projectPath');
        const projectId = Object.hasOwn(options, 'projectId') && options.projectId !== undefined
            ? options.projectId : explicitPath ? null : data.layout.selectedProjectId;
        let project = data.projects.find(item => item.id === projectId);
        if (!project && explicitPath) project = data.projects.find(item => store.normalizePath(item.path) === store.normalizePath(options.projectPath));
        return { projectId: project?.id || null, workingDirectory: project?.path || (explicitPath ? options.projectPath || '' : ''),
            projectName: project?.name || '' };
    }
    async function newChat(project) {
        await saveCurrentChat();
        await request('layout', { selectedProjectId: project?.id || null });
        const chat = await createNewChat({ mode: 'work', projectId: project?.id || null, projectPath: project?.path || '' });
        await loadChat(chat.id);
        messageInput?.focus();
    }
    async function newSelectedChat() {
        const workspace = await request('list');
        await newChat(workspace.projects.find(project => project.id === workspace.layout.selectedProjectId));
    }
    async function selectComposerProject(path, name) {
        const scope = CHAT_HISTORY_KEY;
        const data = await request('list');
        const project = data.projects.find(item => store.normalizePath(item.path) === store.normalizePath(path));
        const chat = store.list(scope).find(item => String(item.id) === String(currentChatId));
        if (chat?.mode === 'work') {
            await request('chat_move', { ids: [chat.id], projectId: project?.id || null, clearDirectory: !path });
        } else {
            const runtime = getConversationRuntime(currentChatId, messagesContainer);
            if (!runtime.composer) runtime.composer = snapshotConversationComposer(runtime);
            runtime.composer = Object.assign({}, runtime.composer, { projectPath: path || '', projectName: name || '', projectId: project?.id || null, agentMode: true });
            renderConversationRuntimeComposer(runtime); persistConversationDraft(runtime);
        }
        await request('layout', { selectedProjectId: project?.id || null });
    }
    function closeMenu(restoreFocus = false) {
        menu?.remove(); menu = null;
        menuTrigger?.setAttribute('aria-expanded', 'false');
        if (restoreFocus) menuTrigger?.focus();
        menuTrigger = null;
    }
    function openMenu(trigger, entries) {
        closeMenu(); menuTrigger = trigger; trigger.setAttribute('aria-expanded', 'true');
        menu = document.createElement('div'); menu.className = 'workspace-menu'; menu.setAttribute('role', 'menu');
        for (const entry of entries) {
            if (entry.separator) { const line = document.createElement('hr'); menu.append(line); continue; }
            const item = button(entry.label, async () => {
                closeMenu();
                if (entry.children) openMenu(trigger, entry.children()); else await entry.action();
            }, 'workspace-menu-item');
            item.prepend(icon(entry.icon || 'chat')); item.setAttribute('role', 'menuitem');
            item.disabled = !!entry.disabled;
            if (entry.children) { item.append(icon('chevron')); item.setAttribute('aria-haspopup', 'menu'); }
            menu.append(item);
        }
        document.body.append(menu);
        const rect = trigger.getBoundingClientRect();
        menu.style.left = Math.max(8, Math.min(rect.right, innerWidth - menu.offsetWidth - 8)) + 'px';
        menu.style.top = Math.max(8, Math.min(rect.top, innerHeight - menu.offsetHeight - 8)) + 'px';
        menu.querySelector('button:not(:disabled)')?.focus();
    }
    function more(row, entries) {
        const btn = button('', () => openMenu(btn, entries()), 'workspace-row-action');
        btn.append(icon('more')); btn.setAttribute('aria-label', '更多操作'); btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
        row.append(btn); return btn;
    }
    function sectionChoices(kind, item) {
        return [{ label: '默认位置', icon: 'section', action: () => request(kind + '_section', { id: item.id, ids: [item.id], sectionId: null }) },
            ...snapshot.layout.sections.slice().sort(byOrder).map(section => ({ label: section.name, icon: 'section',
                action: () => request(kind + '_section', { id: item.id, ids: [item.id], sectionId: section.id }) })),
            { label: '新建分区…', icon: 'plus', action: async () => {
                const values = await form('新建分区', [{ key: 'name', label: '分区名称' }]);
                if (!values) return;
                const section = await request('section_create', values);
                await request(kind + '_section', { id: item.id, ids: [item.id], sectionId: section.id });
            } }];
    }
    async function reorder(kind, id, direction, beforeId) {
        const items = (kind === 'section' ? snapshot.layout.sections : snapshot.projects).slice().sort(byOrder);
        const order = items.map(item => item.id), from = order.indexOf(id);
        let to = beforeId ? order.indexOf(beforeId) : from + direction;
        if (from < 0 || to < 0 || to >= order.length || from === to) return;
        const [moved] = order.splice(from, 1);
        if (beforeId && from < to) to--;
        order.splice(to, 0, moved);
        await request('reorder', { kind, order });
    }
    function projectEntries(project) {
        const busy = store.list(CHAT_HISTORY_KEY).some(chat => chat.projectId === project.id && isBusy(CHAT_HISTORY_KEY, chat.id));
        return [
            { label: project.pinned ? '取消置顶' : '置顶', icon: 'pin', action: () => request('project_pin', { id: project.id, pinned: !project.pinned }) },
            { label: '编辑', icon: 'edit', action: () => editProject(project) }, { separator: true },
            { label: '分区', icon: 'section', children: () => sectionChoices('project', project) },
            { label: '在资源管理器中打开', icon: 'folder', action: async () => {
                const result = await callLauncher('open_file', { path: project.path });
                if (!result.success) throw new Error(result.message || '无法打开项目目录');
            } }, { separator: true },
            { label: '归档聊天', icon: 'archive', disabled: busy, action: async () => {
                const accepted = await confirmDialog({ title: '归档项目会话?', message: '归档后项目会保留，会话可在归档列表中恢复。', confirmText: '归档', danger: false });
                if (accepted) await request('project_archive', { id: project.id });
            } }, { separator: true },
            { label: '移除项目', icon: 'close', disabled: busy, action: async () => {
                const accepted = await confirmDialog({ title: '移除项目?', message: '移除后，会话将保留在最近列表，本地文件不会被删除。', confirmText: '移除' });
                if (accepted) await request('project_delete', { id: project.id });
            } }, { separator: true },
            { label: '上移', icon: 'up', action: () => reorder('project', project.id, -1) },
            { label: '下移', icon: 'down', action: () => reorder('project', project.id, 1) }
        ];
    }
    function chatEntries(chat) {
        const busy = isBusy(CHAT_HISTORY_KEY, chat.id);
        return [
            { label: chat.pinned ? '取消置顶' : '置顶', icon: 'pin', action: () => request('chat_pin', { ids: [chat.id], pinned: !chat.pinned }) },
            { label: '重命名', icon: 'edit', action: () => renameChat(chat.id) },
            { label: '移动到项目', icon: 'folder', disabled: busy || chat.readOnly, children: () => [
                { label: '无项目（保留工作目录）', icon: 'chat', action: () => request('chat_move', { ids: [chat.id], projectId: null }) },
                ...snapshot.projects.map(project => ({ label: project.name + ' · ' + project.path, icon: 'folder',
                    action: async () => {
                        const validation = await validatePath(project.path);
                        if (!validation.success) throw new Error('项目目录不存在或不可写：' + project.path);
                        await request('chat_move', { ids: [chat.id], projectId: project.id });
                    } }))] },
            { label: '分区', icon: 'section', children: () => sectionChoices('chat', chat) },
            { label: '移回默认位置', icon: 'section', action: () => request('chat_section', { ids: [chat.id], sectionId: null }) },
            { separator: true },
            { label: chat.archivedAt ? '恢复会话' : '归档会话', icon: 'archive', disabled: busy,
                action: () => request(chat.archivedAt ? 'chat_restore' : 'chat_archive', { ids: [chat.id] }) },
            { label: '删除', icon: 'close', disabled: busy, action: async () => {
                const accepted = await confirmDialog({ title: '删除会话?', message: '删除后，这条会话将从你的所有设备中移除，且无法恢复。', confirmText: '确认' });
                if (accepted) await deleteChat(chat.id);
            } },
            ...(!chat.archivedAt ? [{ label: '批量删除', icon: 'section', action: batchDeleteDialog }] : [])
        ];
    }
    function rowBase(kind, id, label, title) {
        const row = document.createElement('div'); row.className = 'workspace-row workspace-' + kind;
        row.dataset.kind = kind; row.dataset.id = id; row.dataset.tooltip = title || label;
        return row;
    }
    function dragSource(row, kind, id) {
        row.draggable = true;
        row.addEventListener('dragstart', event => {
            dragging = { kind, id }; event.dataTransfer.setData('application/x-moonya-workspace', JSON.stringify(dragging)); event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => { dragging = null; document.querySelectorAll('.workspace-drop').forEach(el => el.classList.remove('workspace-drop')); });
    }
    function dropTarget(row, kind, id) {
        row.addEventListener('dragover', event => {
            if (!dragging || (kind === 'project' && dragging.kind === 'section')) return;
            event.preventDefault(); event.stopPropagation(); row.classList.add('workspace-drop');
        });
        row.addEventListener('dragleave', () => row.classList.remove('workspace-drop'));
        row.addEventListener('drop', event => {
            event.preventDefault(); event.stopPropagation(); row.classList.remove('workspace-drop');
            const source = dragging; dragging = null;
            if (!source) return;
            void run(async () => {
                if (source.kind === 'chat') {
                    if (kind === 'project') {
                        const target = snapshot.projects.find(item => item.id === id);
                        const validation = await validatePath(target.path);
                        if (!validation.success) throw new Error('项目目录不存在或不可写：' + target.path);
                        await request('chat_move', { ids: [source.id], projectId: id });
                    } else await request('chat_section', { ids: [source.id], sectionId: id });
                } else if (source.kind === kind) await reorder(kind, source.id, 0, id);
                else if (source.kind === 'project' && kind === 'section') await request('project_section', { id: source.id, sectionId: id });
            });
        });
    }
    function chatRow(chat, nested = false, location = '') {
        const row = rowBase('chat', chat.id, chat.title, chat.title + (chat.workingDirectory ? '\n' + chat.workingDirectory : ''));
        row.classList.toggle('active', String(chat.id) === String(currentChatId)); row.classList.toggle('nested', nested);
        const open = button(chat.title + (chat.readOnly ? '（本地旧历史）' : ''), () => loadChat(chat.id), 'workspace-row-label');
        if (location) { const hint = document.createElement('small'); hint.className = 'workspace-location'; hint.textContent = location; open.append(hint); }
        row.append(open);
        if (isBusy(CHAT_HISTORY_KEY, chat.id)) { const status = icon('chat'); status.classList.add('workspace-running'); status.dataset.tooltip = '任务执行中或等待审批'; row.append(status); }
        more(row, () => chatEntries(chat)); if (!chat.archivedAt) dragSource(row, 'chat', chat.id);
        return row;
    }
    function heading(label, key, actions = []) {
        const row = rowBase('heading', key, label);
        const expanded = snapshot.layout.expanded[key] !== false;
        const toggle = button(label, () => request('layout', { expanded: { [key]: !expanded } }), 'workspace-heading-label');
        const arrow = icon('chevron'); arrow.classList.toggle('expanded', expanded); toggle.append(arrow);
        toggle.setAttribute('aria-expanded', String(expanded)); row.append(toggle);
        actions.forEach(action => {
            const btn = button('', action.action, 'workspace-row-action'); btn.setAttribute('aria-label', action.label); btn.dataset.tooltip = action.label; btn.append(icon(action.icon)); row.append(btn);
        });
        return row;
    }
    function projectRow(project, chats) {
        const fragment = document.createDocumentFragment();
        const key = 'project:' + project.id, expanded = snapshot.layout.expanded[key] !== false;
        const row = rowBase('project', project.id, project.name, project.name + '\n' + project.path);
        row.classList.toggle('selected', snapshot.layout.selectedProjectId === project.id);
        const toggle = button(project.name, async () => {
            await request('layout', { selectedProjectId: project.id, expanded: { [key]: !expanded } });
        }, 'workspace-row-label'); toggle.prepend(icon(expanded ? 'folderOpen' : 'folder')); toggle.setAttribute('aria-expanded', String(expanded));
        row.append(toggle); more(row, () => projectEntries(project));
        const add = button('', () => newChat(project), 'workspace-row-action'); add.append(icon('edit')); add.setAttribute('aria-label', '在“' + project.name + '”中新建会话'); row.append(add);
        dragSource(row, 'project', project.id); dropTarget(row, 'project', project.id); fragment.append(row);
        if (expanded) {
            const children = chats.filter(chat => chat.projectId === project.id && !chat.sectionId && !chat.pinned).sort(byActivity);
            const all = snapshot.layout.expanded['all:' + project.id] === true;
            children.slice(0, all ? undefined : 5).forEach(chat => fragment.append(chatRow(chat, true)));
            if (children.length > 5) fragment.append(button(all ? '收起' : '展开显示', () => request('layout', { expanded: { ['all:' + project.id]: !all } }), 'workspace-show-more'));
        }
        return fragment;
    }
    async function render() {
        const work = currentConversationMode() === 'work';
        document.body.classList.toggle('workspace-sidebar-active', work);
        document.getElementById('workSidebar').hidden = !work;
        const token = ++renderToken, scope = CHAT_HISTORY_KEY;
        if (!work || visibleScope !== scope) {
            closeMenu(); document.querySelectorAll('dialog.workspace-dialog').forEach(el => el.close());
        }
        if (visibleScope !== scope) {
            tree.replaceChildren();
            snapshot = { projects: [], layout: { sections: [], expanded: {} } };
            visibleScope = scope;
        }
        if (!work) return;
        try {
            await store.initialize(scope);
            if (!associated.has(scope)) {
                associated.add(scope);
                const migrated = await store.sidebarRequest(scope, 'associate_legacy');
                if (!migrated.success) { associated.delete(scope); throw new Error(migrated.message); }
            }
            const result = await store.sidebarRequest(scope, 'list');
            if (!result.success) throw new Error(result.message);
            if (token !== renderToken || scope !== CHAT_HISTORY_KEY || currentConversationMode() !== 'work') return;
            snapshot = result.data;
            const chats = store.list(scope).filter(chat => ['work', 'legacy'].includes(chat.mode) && !chat.archivedAt).sort(byActivity);
            const projects = snapshot.projects.slice().sort(byOrder), sections = snapshot.layout.sections.slice().sort(byOrder);
            tree.replaceChildren();
            if (projects.some(project => project.pinned) || chats.some(chat => chat.pinned)) {
                tree.append(heading('置顶', 'pinned'));
                if (snapshot.layout.expanded.pinned !== false) {
                    projects.filter(project => project.pinned).forEach(project => tree.append(projectRow(project, chats)));
                    chats.filter(chat => chat.pinned).forEach(chat => tree.append(chatRow(chat)));
                }
            }
            for (const section of sections) {
                const key = 'section:' + section.id, row = heading(section.name, key);
                more(row, () => [
                    { label: '重命名分区', icon: 'edit', action: async () => {
                        const values = await form('重命名分区', [{ key: 'name', label: '分区名称', value: section.name }]);
                        if (values) await request('section_update', { id: section.id, ...values });
                    } },
                    { label: '上移', icon: 'up', action: () => reorder('section', section.id, -1) },
                    { label: '下移', icon: 'down', action: () => reorder('section', section.id, 1) },
                    { label: '删除分区', icon: 'close', action: async () => {
                        const accepted = await confirmDialog({ title: '删除分区?', message: '删除“' + section.name + '”后，其中的项目与会话会回到默认位置。', confirmText: '确认' });
                        if (accepted) await request('section_delete', { id: section.id });
                    } }
                ]);
                dragSource(row, 'section', section.id); dropTarget(row, 'section', section.id); tree.append(row);
                if (snapshot.layout.expanded[key] !== false) {
                    projects.filter(project => !project.pinned && project.sectionId === section.id).forEach(project => tree.append(projectRow(project, chats)));
                    chats.filter(chat => !chat.pinned && chat.sectionId === section.id).forEach(chat => tree.append(chatRow(chat)));
                }
            }
            tree.append(heading('项目', 'projects', [
                { label: '添加项目', icon: 'plus', action: () => openCreateModal() },
                { label: '添加现有文件夹', icon: 'folder', action: () => pickExistingFolder() },
                { label: '新建分区', icon: 'section', action: async () => {
                    const values = await form('新建分区', [{ key: 'name', label: '分区名称' }]);
                    if (values) await request('section_create', values);
                } }
            ]));
            if (snapshot.layout.expanded.projects !== false) {
                projects.filter(project => !project.pinned && !project.sectionId).forEach(project => tree.append(projectRow(project, chats)));
                if (!projects.length) tree.append(empty('添加项目，开始整理工作会话'));
            }
            tree.append(heading('最近', 'recent'));
            if (snapshot.layout.expanded.recent !== false) {
                chats.forEach(chat => tree.append(chatRow(chat)));
                if (!chats.length) tree.append(empty('暂无会话'));
            }
        } catch (error) {
            if (token === renderToken) {
                tree.replaceChildren(empty('项目列表读取失败'));
                tree.append(button('点击重试', () => render(), 'workspace-show-more'));
                console.warn('Workspace loading failed:', error);
            }
        }
    }
    function empty(text) { const el = document.createElement('div'); el.className = 'workspace-empty'; el.textContent = text; return el; }
    function dialog(title) {
        const el = document.createElement('dialog'); el.className = 'workspace-dialog';
        const head = document.createElement('div'); head.className = 'workspace-dialog-head';
        const heading = document.createElement('h2'); heading.textContent = title;
        const close = button('×', () => el.close(), 'workspace-dialog-close'); close.setAttribute('aria-label', '关闭');
        head.append(heading, close); el.append(head); document.body.append(el);
        el.addEventListener('close', () => el.remove());
        el.addEventListener('click', event => {
            const rect = el.getBoundingClientRect();
            if (event.target === el && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) el.close();
        });
        return el;
    }
    /* 图一规格的居中确认弹窗：标题 + 灰字说明 + 取消/确认（危险操作红色）。替代原生 confirm。 */
    function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = true } = {}) {
        return new Promise(resolve => {
            const el = document.createElement('dialog'); el.className = 'workspace-dialog workspace-confirm';
            const heading = document.createElement('h2'); heading.textContent = title;
            const footer = document.createElement('div'); footer.className = 'workspace-dialog-footer';
            let confirmed = false;
            const cancel = button(cancelText, () => el.close(), 'workspace-secondary');
            const accept = button(confirmText, () => { confirmed = true; el.close(); }, danger ? 'workspace-primary workspace-danger' : 'workspace-primary');
            footer.append(cancel, accept); el.append(heading);
            if (message) { const text = document.createElement('p'); text.className = 'workspace-dialog-hint'; text.textContent = message; el.append(text); }
            el.append(footer); document.body.append(el);
            el.addEventListener('close', () => { el.remove(); resolve(confirmed); });
            el.addEventListener('click', event => {
                const rect = el.getBoundingClientRect();
                if (event.target === el && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) el.close();
            });
            el.showModal(); cancel.focus();
        });
    }
    function form(title, fields, onSubmit) {
        return new Promise(resolve => {
            const el = dialog(title), formEl = document.createElement('form'); formEl.className = 'workspace-form';
            for (const field of fields) {
                const label = document.createElement('label'); label.textContent = field.label;
                const input = document.createElement('input'); input.name = field.key; input.value = field.value || ''; input.required = true;
                label.append(input); formEl.append(label);
                if (field.key === 'path') formEl.append(button('选择文件夹', async () => {
                    const result = await pickFolderDialog();
                    if (result.success) input.value = result.path;
                    else if (!result.cancelled) throw new Error(result.message || '无法选择文件夹');
                }, 'workspace-secondary'));
            }
            const error = document.createElement('p'); error.className = 'workspace-form-error'; error.setAttribute('role', 'alert'); formEl.append(error);
            const footer = document.createElement('div'); footer.className = 'workspace-dialog-footer';
            const cancel = button('取消', () => el.close(), 'workspace-secondary');
            const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '保存'; submit.className = 'workspace-primary';
            footer.append(cancel, submit); formEl.append(footer); el.append(formEl);
            formEl.addEventListener('submit', async event => {
                event.preventDefault(); submit.disabled = true; error.textContent = '';
                const values = Object.fromEntries(new FormData(formEl));
                for (const key of Object.keys(values)) values[key] = values[key].trim();
                try {
                    if (Object.values(values).some(value => !value)) throw new Error('请填写完整');
                    if (onSubmit && await onSubmit(values) === false) return;
                    resolve(values); el.close();
                } catch (failure) { error.textContent = failure.message; }
                finally { submit.disabled = false; }
            });
            el.addEventListener('close', () => resolve(null)); el.showModal();
        });
    }
    async function editProject(project) {
        await form('编辑项目', [{ key: 'name', label: '项目名称', value: project.name }, { key: 'path', label: '项目目录', value: project.path }], async values => {
            if (values.path !== project.path) {
                const validation = await validatePath(values.path);
                if (!validation.success) throw new Error('目录不存在或不可写：' + values.path);
                const accepted = await confirmDialog({ title: '更换项目目录?', message: '更换后，该项目全部会话的后续工作将使用新目录；已有历史和运行时记录会保留。', confirmText: '确认', danger: false });
                if (!accepted) return false;
            }
            await request('project_update', { id: project.id, ...values });
        });
    }
    async function archiveDialog() {
        const scope = CHAT_HISTORY_KEY, el = dialog('归档会话'); el.classList.add('workspace-archive-dialog');
        const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索归档会话'; input.setAttribute('aria-label', '搜索归档会话'); input.className = 'workspace-search';
        const filter = document.createElement('select'); filter.setAttribute('aria-label', '按项目筛选归档会话');
        const all = document.createElement('option'); all.value = ''; all.textContent = '全部项目'; filter.append(all);
        const data = await request('list', {}, scope);
        data.projects.forEach(project => { const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; filter.append(option); });
        const list = document.createElement('div'); list.className = 'workspace-archive-list';
        const restore = button('恢复该项目全部会话', async () => {
            if (filter.value) await request('project_restore', { id: filter.value }, scope);
            populate();
        }, 'workspace-secondary'); restore.hidden = true;
        function populate() {
            if (scope !== CHAT_HISTORY_KEY) { el.close(); return; }
            restore.hidden = !filter.value; list.replaceChildren();
            const chats = store.list(scope).filter(chat => chat.archivedAt && (!filter.value || chat.projectId === filter.value) &&
                String(chat.title || '').toLowerCase().includes(input.value.trim().toLowerCase())).sort(byActivity);
            chats.forEach(chat => {
                const row = rowBase('chat', chat.id, chat.title);
                const open = button(chat.title, async () => { el.close(); await loadChat(chat.id); }, 'workspace-row-label');
                const recover = button('恢复', async () => { await request('chat_restore', { ids: [chat.id] }, scope); populate(); }, 'workspace-secondary');
                row.append(open, recover); list.append(row);
            });
            if (!chats.length) list.append(empty('没有归档会话'));
        }
        input.addEventListener('input', populate); filter.addEventListener('change', populate);
        el.append(input, filter, restore, list); populate(); el.showModal();
    }
    function batchDeleteDialog() {
        const scope = CHAT_HISTORY_KEY, el = dialog('删除会话?');
        const hint = document.createElement('p'); hint.className = 'workspace-dialog-hint';
        hint.textContent = '勾选要删除的会话，删除后将从你的所有设备中移除，且无法恢复。';
        const list = document.createElement('div'); list.className = 'workspace-archive-list';
        const selected = new Set();
        const chats = store.list(scope).filter(chat => ['work', 'legacy'].includes(chat.mode) && !chat.archivedAt).sort(byActivity);
        for (const chat of chats) {
            const label = document.createElement('label'); label.className = 'workspace-batch-choice';
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = isBusy(scope, chat.id);
            checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(chat.id); else selected.delete(chat.id); });
            const text = document.createElement('span'); text.textContent = chat.title; text.dataset.tooltip = chat.title;
            label.append(checkbox, text); list.append(label);
        }
        if (!chats.length) list.append(empty('暂无可删除的会话'));
        const selectAll = button('全选', () => {
            list.querySelectorAll('input:not(:disabled)').forEach(input => { input.checked = true; input.dispatchEvent(new Event('change')); });
        }, 'workspace-secondary');
        const remove = button('删除', async () => {
            if (scope !== CHAT_HISTORY_KEY) { el.close(); return; }
            if (!selected.size) throw new Error('请先选择会话');
            if ([...selected].some(id => isBusy(scope, id))) throw new Error('任务正在执行或等待审批，请等待结束或先停止');
            const accepted = await confirmDialog({ title: '确认删除?', message: '删除后，选中的 ' + selected.size + ' 条会话将从你的所有设备中移除，且无法恢复。', confirmText: '确认' });
            if (!accepted) return;
            const saved = await Promise.all([...selected].map(id => deleteChat(id)));
            if (saved.some(result => result === false)) throw new Error('部分会话尚未保存删除操作，请使用历史保存重试入口');
            el.close();
        }, 'workspace-primary workspace-danger');
        const footer = document.createElement('div'); footer.className = 'workspace-dialog-footer'; footer.append(selectAll, remove);
        el.append(hint, list, footer); el.showModal();
    }
    window.MoonYaWorkspace = { render, request, isBusy, syncRuntime, restoreComposer, newChatBinding, selectComposerProject, newChat, newSelectedChat, archiveDialog, confirmDialog };
    window.addEventListener('moonya:workspace-change', event => {
        syncChanged(event.detail.scope, event.detail.ids);
        if (event.detail.scope === CHAT_HISTORY_KEY) void render();
    });
    document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target) && event.target !== menuTrigger && !menuTrigger?.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => {
        if (!menu) return;
        if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const items = [...menu.querySelectorAll('button:not(:disabled)')]; const index = items.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        } else if (event.key === 'Tab') closeMenu();
    });
    window.addEventListener('resize', () => closeMenu());
    tree.addEventListener('scroll', () => closeMenu());
    void render();
})();
