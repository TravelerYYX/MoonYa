/* Skill preferences manage composer entries; external browser permissions are native settings. */
(function () {
    'use strict';
    const view = document.getElementById('pluginsView');
    const list = document.getElementById('pluginsList');
    const main = document.querySelector('.main-content');
    const ids = ['browser-use-automation', 'computer-use-automation', 'realtime-voice-chat', 'external-browser-chrome', 'external-browser-edge'];
    const externalNames = { 'external-browser-chrome': '允许操控 Google Chrome', 'external-browser-edge': '允许操控 Microsoft Edge' };
    const rows = new Map();
    const inertBeforeOpen = new Map();
    const layers = 'm12 3 8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5';
    const microphone = '<rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"/>';
    function ensureRows() {
    const currentIds = [...new Set([...ids, ...window.MoonYaClientConfig.skills.map(skill => skill.name)])];
    for (const [id, row] of rows) {
        if (!currentIds.includes(id)) { row.element.remove(); rows.delete(id); }
    }
    for (const id of currentIds) {
        if (rows.has(id)) continue;
        const row = document.createElement('div');
        row.className = 'plugin-row'; row.dataset.pluginId = id;
        const icon = document.createElement('span');
        icon.className = 'plugin-icon';
        icon.classList.add(id === ids[0] ? 'plugin-red' : id === ids[1] ? 'plugin-green' : 'plugin-voice');
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (id === ids[2] ? microphone : '<path d="' + layers + '"/>') + '</svg>';
        const copy = document.createElement('div'); copy.className = 'plugin-copy';
        const name = document.createElement('div'); name.className = 'plugin-name';
        const description = document.createElement('div'); description.className = 'plugin-description';
        description.id = 'plugin-description-' + id;
        copy.append(name, description);
        const toggle = document.createElement('button');
        toggle.type = 'button'; toggle.className = 'plugin-switch';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-describedby', description.id);
        toggle.innerHTML = '<span aria-hidden="true"></span>';
        toggle.addEventListener('click', () => window.MoonYaPlugins.setEnabled(id, !window.MoonYaPlugins.isEnabled(id)));
        row.append(icon, copy, toggle); list.append(row);
        rows.set(id, { element:row, name, description, toggle });
    }
    }
    function sync() {
        ensureRows();
        for (const [id, row] of rows) {
            const skill = window.MoonYaClientConfig.skills.find(item => item.name === id)
                || window.MoonYaDefaults.skills.find(item => item.name === id);
            const name = externalNames[id] || (id === ids[2] ? '实时语音对话' : skill?.display_name || id);
            const description = externalNames[id] ? '仅在明确指定时使用独立自动化窗口，默认关闭' : (id === ids[2] ? '实时语音任务' : skill?.description || '');
            row.name.textContent = name; row.name.dataset.tooltip = name;
            row.description.textContent = description; row.description.dataset.tooltip = description;
            row.toggle.setAttribute('aria-label', name);
            row.toggle.setAttribute('aria-checked', String(window.MoonYaPlugins.isEnabled(id)));
            row.toggle.disabled = !window.MoonYaPlugins.isAvailable(id);
            row.toggle.dataset.tooltip = row.toggle.disabled ? '此插件当前不可用' : (window.MoonYaPlugins.isEnabled(id) ? '关闭' : '启用') + name;
        }
    }
    function isOpen() { return !view.hidden; }
    function open() {
        if (isOpen()) return;
        void window.MoonYaClient.refreshSkills();
        void window.MoonYaPlugins.refreshExternalPreferences();
        window.MoonYaOffice?.close();
        window.MoonYaSearch?.close();
        document.getElementById('addMenuSelector').classList.remove('open');
        document.getElementById('fileCard').setAttribute('aria-expanded', 'false');
        document.getElementById('conversationMoreMenu').hidden = true;
        document.getElementById('conversationMoreBtn').setAttribute('aria-expanded', 'false');
        for (const node of [...main.children, document.getElementById('detailPanel'), document.getElementById('detailPanelResizer')]) {
            if (node && node !== view) { inertBeforeOpen.set(node, node.inert); node.inert = true; }
        }
        sync(); view.hidden = false;
        document.body.classList.add('plugins-active');
        window.MoonYaShell?.sync();
        document.getElementById('pluginsTitle').focus();
    }
    function close() {
        if (!isOpen()) return;
        const hadFocus = view.contains(document.activeElement);
        view.hidden = true; document.body.classList.remove('plugins-active');
        for (const [node, inert] of inertBeforeOpen) node.inert = inert;
        inertBeforeOpen.clear();
        if (hadFocus) document.getElementById('pluginsBtn').focus();
        window.MoonYaShell?.sync();
    }
    document.getElementById('pluginsBtn').addEventListener('click', open);
    for (const id of ['conversationBtn', 'officeBtn', 'railBrowserBtn']) {
        document.getElementById(id).addEventListener('click', close, true);
    }
    // Sidebar conversation navigation should also return to the composer.
    document.getElementById('sidebar').addEventListener('click', event => {
        if (event.target.closest('.workspace-chat .workspace-row-label, #sidebarNewChatBtn')) close();
    }, true);
    window.addEventListener('moonya:plugins-change', sync);
    window.addEventListener('moonya:client-config', sync);
    window.MoonYaPluginView = Object.freeze({ open, close, isOpen });
    sync();
}());
