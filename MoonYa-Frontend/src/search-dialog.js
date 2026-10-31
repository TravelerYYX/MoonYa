/* Search palette: real local conversations, projects and current-project files. */
(function () {
    'use strict';
    const dialog = document.getElementById('workspaceSearchDialog');
    const input = document.getElementById('workspaceSearch');
    const results = document.getElementById('workspaceSearchResults');
    const trigger = document.getElementById('sidebarSearchBtn');
    const store = window.MoonYaHistoryStore;
    let scope, mode, fileMode = false, generation = 0, timer, activeIndex = -1, projectPath = '';
    const normalize = text => String(text || '').replace(/\\/g, '/').toLocaleLowerCase();
    const currentProjectPath = () => localStorage.getItem('moonya_work_project_path') || '';
    const items = () => [...dialog.querySelectorAll('.workspace-search-item')];
    function activate(index) {
        activeIndex = index;
        items().forEach((item, i) => item.classList.toggle('keyboard-active', i === index));
        items()[index]?.scrollIntoView({ block: 'nearest' });
    }
    function notice(text) {
        const el = document.createElement('div'); el.className = 'workspace-search-notice'; el.textContent = text; results.append(el);
    }
    function heading(text) {
        const el = document.createElement('div'); el.className = 'workspace-search-heading'; el.textContent = text; results.append(el);
    }
    function valid(token) {
        return dialog.open && token === generation && scope === CHAT_HISTORY_KEY && mode === currentConversationMode();
    }
    function close() { if (dialog.open) dialog.close(); }
    async function run(operation) {
        try { await operation(); } catch (error) { showToast(error.message || '操作失败，请重试', 4000); }
    }
    async function fileOperation(action, body) {
        if (window.CefSharp?.BindObjectAsync) await CefSharp.BindObjectAsync('moonYaFileOps');
        const response = window.moonYaFileOps?.fileOp
            ? await window.moonYaFileOps.fileOp(JSON.stringify({ action, ...body }))
            : await callLauncher(action, body);
        const result = typeof response === 'string' ? JSON.parse(response) : response;
        if (!result?.success) throw new Error(result?.message || '无法读取本地项目文件');
        return result;
    }
    function row({ title, project = '', shortcut = '', current = false, icon = '', action, kind, id }) {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'workspace-search-item';
        el.dataset.kind = kind; if (id) el.dataset.id = id;
        const marker = document.createElement('span'); marker.className = 'workspace-search-marker'; marker.setAttribute('aria-hidden', 'true');
        if (icon) marker.innerHTML = MoonYaIcons.icon(icon);
        else if (current) { const circle = document.createElement('span'); circle.className = 'workspace-search-current'; marker.append(circle); }
        const label = document.createElement('span'); label.className = 'workspace-search-title'; label.textContent = title;
        el.append(marker, label);
        if (project) {
            const location = document.createElement('span'); location.className = 'workspace-search-project'; location.textContent = project;
            if (kind === 'file') location.classList.add('workspace-search-file-path');
            el.append(location);
        }
        if (shortcut) { const key = document.createElement('kbd'); key.textContent = shortcut; el.append(key); }
        el.addEventListener('click', () => {
            if (!valid(generation)) return close();
            close(); void run(action);
        });
        results.append(el);
    }
    async function populate() {
        const token = ++generation;
        results.replaceChildren(); activeIndex = -1;
        const query = normalize(input.value.trim());
        if (fileMode) {
            heading('文件');
            if (!projectPath) return notice('请先选择项目文件夹');
            if (projectPath !== currentProjectPath()) { close(); return; }
            notice('正在搜索项目文件…');
            try {
                const data = await fileOperation('search_files', { path: projectPath, query });
                if (!valid(token) || projectPath !== currentProjectPath()) return;
                results.replaceChildren(); heading('文件');
                for (const file of data.files || []) {
                    row({ title: file.name, project: file.relative_path, icon: 'search', kind: 'file',
                        action: () => fileOperation('open_file', { path: file.path }) });
                }
                if (!data.files?.length) notice('没有匹配的文件');
                if (data.truncated) notice('仅显示部分结果，请输入更完整的文件名或路径');
                activate(0);
            } catch (error) { if (valid(token)) { results.replaceChildren(); heading('文件'); notice(error.message); } }
            return;
        }
        heading('聊天');
        try {
            await store.initialize(scope);
            const workspace = mode === 'work' ? await MoonYaWorkspace.request('list', {}, scope) : { projects: [] };
            if (!valid(token)) return;
            const chats = store.list(scope).filter(chat => !chat.archivedAt &&
                (mode === 'work' ? ['work', 'legacy'].includes(chat.mode) : chat.mode === 'chat'))
                .filter(chat => normalize(chat.title).includes(query))
                .sort((a, b) => String(b.lastActivityAt || b.createdAt || '').localeCompare(String(a.lastActivityAt || a.createdAt || '')))
                .slice(0, query ? 50 : 9);
            chats.forEach((chat, i) => {
                const project = workspace.projects.find(item => item.id === chat.projectId);
                row({ title: chat.title || '新聊天', project: project?.name || chat.projectName || '', shortcut: i < 9 ? 'Alt+' + (i + 1) : '',
                    current: String(chat.id) === String(currentChatId) || MoonYaWorkspace.isBusy(scope, chat.id),
                    kind: 'chat', id: chat.id, action: () => loadChat(chat.id) });
            });
            if (!chats.length) notice(query ? '没有匹配的聊天' : '暂无聊天');
            const projects = query ? workspace.projects.filter(project => normalize(project.name).includes(query) || normalize(project.path).includes(query)) : [];
            if (projects.length) {
                heading('项目');
                projects.forEach(project => row({ title: project.name, project: project.path, icon: 'folder', kind: 'project', id: project.id,
                    action: () => MoonYaWorkspace.newChat(project) }));
            }
            activate(0);
        } catch (error) { if (valid(token)) { notice('聊天读取失败，请重新打开搜索'); console.warn('Search loading failed:', error); } }
    }
    function open() {
        if (dialog.open) return close();
        scope = CHAT_HISTORY_KEY; mode = currentConversationMode(); fileMode = false; projectPath = '';
        input.value = ''; input.placeholder = '搜索聊天'; input.setAttribute('aria-label', '搜索聊天'); dialog.setAttribute('aria-label', '搜索聊天');
        dialog.showModal(); trigger.setAttribute('aria-expanded', 'true'); input.focus(); void populate();
    }
    function searchFiles() {
        fileMode = true; projectPath = currentProjectPath();
        input.value = ''; input.placeholder = '搜索文件'; input.setAttribute('aria-label', '搜索当前项目文件'); dialog.setAttribute('aria-label', '搜索当前项目文件');
        input.focus(); void populate();
    }
    const newChat = document.getElementById('searchNewChat');
    const openFolder = document.getElementById('searchOpenFolder');
    const files = document.getElementById('searchFiles');
    newChat.addEventListener('click', () => { close(); document.getElementById('sidebarNewChatBtn').click(); });
    openFolder.addEventListener('click', () => { close(); void run(pickExistingFolder); });
    files.addEventListener('click', searchFiles);
    trigger.addEventListener('click', open);
    input.addEventListener('input', () => {
        clearTimeout(timer); ++generation;
        if (fileMode) { results.replaceChildren(); heading('文件'); notice('正在搜索项目文件…'); timer = setTimeout(() => void populate(), 180); }
        else void populate();
    });
    dialog.addEventListener('pointermove', () => activate(-1));
    dialog.addEventListener('click', event => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
    });
    dialog.addEventListener('close', () => { ++generation; clearTimeout(timer); input.value = ''; results.replaceChildren(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); });
    dialog.addEventListener('keydown', event => {
        if (!valid(generation)) { close(); return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        else if ((event.ctrlKey || event.metaKey) && ['n', 'o', 'p'].includes(event.key.toLowerCase())) {
            event.preventDefault(); ({ n: newChat, o: openFolder, p: files })[event.key.toLowerCase()].click();
        } else if (event.altKey && /^[1-9]$/.test(event.key)) {
            const chat = results.querySelectorAll('[data-kind="chat"]')[Number(event.key) - 1];
            if (chat) { event.preventDefault(); chat.click(); }
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); const count = items().length;
            activate((activeIndex + (event.key === 'ArrowDown' ? 1 : count - 1) + count) % count); input.focus();
        } else if (event.key === 'Enter' && event.target === input) {
            event.preventDefault(); items()[activeIndex]?.click();
        }
    });
    window.addEventListener('moonya:workspace-change', event => {
        if (!dialog.open) return;
        if (scope !== CHAT_HISTORY_KEY || mode !== currentConversationMode()) return close();
        if (event.detail.scope === scope) void populate();
    });
    window.MoonYaSearch = Object.freeze({ open, close });
}());
