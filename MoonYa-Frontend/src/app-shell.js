/* Application shell state. Conversation data and backend mode identifiers stay unchanged. */
(function () {
    'use strict';
    const trigger = document.getElementById('modeMenuTrigger');
    const menu = document.getElementById('modeMenu');
    const tabs = [...menu.querySelectorAll('.mode-toggle-tab')];
    const sidebar = document.getElementById('sidebar');
    const main = document.querySelector('.main-content');
    const header = main.querySelector('.main-header');
    const title = header.querySelector('.main-title');
    const conversationTitle = document.getElementById('conversationTitle');
    const moreButton = document.getElementById('conversationMoreBtn');
    const moreMenu = document.getElementById('conversationMoreMenu');
    let pending = false, previousMode;

    function closeMore(focus = false) {
        moreMenu.hidden = true;
        moreButton.setAttribute('aria-expanded', 'false');
        if (focus) moreButton.focus();
    }
    moreButton.addEventListener('click', () => {
        if (!moreMenu.hidden) return closeMore();
        moreMenu.hidden = false;
        moreButton.setAttribute('aria-expanded', 'true');
        moreMenu.querySelector('[role=menuitem]').focus();
    });
    moreMenu.addEventListener('click', () => closeMore(true));
    document.addEventListener('click', event => {
        if (!moreMenu.contains(event.target) && !moreButton.contains(event.target)) closeMore();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !moreMenu.hidden) { event.preventDefault(); closeMore(true); }
    });

    function closeMenu(focus = false) {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (focus) trigger.focus();
    }
    function openMenu() {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        (tabs.find(tab => tab.getAttribute('aria-checked') === 'true') || tabs[0]).focus();
    }
    trigger.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
    trigger.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(); }
    });
    menu.addEventListener('keydown', event => {
        const index = tabs.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            tabs[(index + (event.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length].focus();
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault(); tabs[event.key === 'Home' ? 0 : tabs.length - 1].focus();
        }
    });
    tabs.forEach(tab => tab.addEventListener('click', () => closeMenu(true)));
    document.addEventListener('click', event => {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(true); }
    });
    const browserButton = document.getElementById('railBrowserBtn');
    browserButton.addEventListener('click', () => {
        window.MoonYaOffice?.close();
        if (!window.moonyaOpenBrowserPanel?.()) showToast('内置浏览器需要桌面客户端');
        sync();
    });
    document.getElementById('workPanelToggle').addEventListener('click', () => {
        window.moonyaSetDetailPanelOpen(!document.getElementById('detailPanel').classList.contains('open'));
    });
    // 顶栏加号（#newChatTopBtn）：只负责「弹出」工作面板，不做开关切换
    // （与原「新建对话」的迁移见 script-1c-save.js 的 #moreMenuNewChat）
    document.getElementById('newChatTopBtn')?.addEventListener('click', () => {
        window.moonyaSetDetailPanelOpen(true);
    });
    document.getElementById('conversationBtn').addEventListener('click', () => {
        if (document.getElementById('teamTabBrowser').classList.contains('selected')) window.moonyaSetDetailPanelOpen(false);
    });
    document.getElementById('recentChatBtn').addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
    });
    document.querySelector('.chat-menu-features').addEventListener('click', () => {
        document.getElementById('addMenuSelector').classList.remove('open');
        document.getElementById('fileCard').setAttribute('aria-expanded', 'false');
    });

    function sync() {
        const work = typeof isAgentMode === 'undefined' || isAgentMode;
        const mode = work ? 'work' : 'chat';
        const label = work ? 'FarSide' : 'MoonYa';
        if (previousMode && previousMode !== mode) {
            window.MoonYaSearch?.close();
            document.getElementById('addMenuSelector').classList.remove('open');
            document.getElementById('fileCard').setAttribute('aria-expanded', 'false');
        }
        previousMode = mode;
        const labelNode = document.getElementById('modeMenuLabel');
        if (labelNode.textContent !== label) labelNode.textContent = label;
        tabs.forEach(tab => { tab.classList.toggle('active', tab.dataset.value === mode); tab.setAttribute('aria-checked', String(tab.dataset.value === mode)); });
        document.getElementById('modeSelect').value = mode;
        const projectName = work ? document.querySelector('#workProjectBtn > span')?.textContent.trim() : '';
        const hasProject = work && !!localStorage.getItem('moonya_work_project_path');
        const welcome = work ? (hasProject ? '你想让我们在 ' + projectName + ' 中构建什么？' : '你想让我们构建什么？') : '今天想聊些什么？';
        if (title.textContent !== welcome) title.textContent = welcome;
        const hasMessages = !!main.querySelector('.messages-container:not([hidden]) .message');
        const chat = typeof getChatHistory === 'function' ? getChatHistory().find(item => String(item.id) === String(currentChatId)) : null;
        const activeTitle = chat?.title || (work ? '新对话' : '新聊天');
        if (conversationTitle.textContent !== activeTitle) conversationTitle.textContent = activeTitle;
        conversationTitle.dataset.tooltip = activeTitle;
        header.hidden = hasMessages;
        if (!hasMessages) title.style.display = '';
        updateWorkProjectBarVisibility();
        const office = document.body.classList.contains('office-active');
        const plugins = document.body.classList.contains('plugins-active');
        const browser = !office && !plugins && document.getElementById('detailPanel')?.classList.contains('open') && document.getElementById('teamTabBrowser')?.classList.contains('selected');
        browserButton.disabled = document.getElementById('teamTabBrowser').hidden;
        browserButton.dataset.tooltip = browserButton.disabled ? '内置浏览器需要桌面客户端' : '内置浏览器';
        [['conversationBtn', !office && !browser && !plugins], ['pluginsBtn', plugins], ['officeBtn', office], ['railBrowserBtn', browser]].forEach(([id, active]) => {
            const button = document.getElementById(id);
            button.classList.toggle('active', !!active);
            if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
        const panelOpen = document.getElementById('detailPanel').classList.contains('open');
        document.getElementById('workPanelToggle').setAttribute('aria-expanded', String(panelOpen));
        document.getElementById('newChatTopBtn')?.setAttribute('aria-expanded', String(panelOpen));
        if (sidebar.classList.contains('collapsed')) closeMenu();
        const composer = main.querySelector('.input-container-wrapper');
        main.style.setProperty('--composer-height', composer.offsetHeight + 'px');
    }
    function schedule() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; sync(); });
    }
    const observer = new MutationObserver(records => {
        if (records.some(record => record.type === 'childList' || record.attributeName === 'class'
            || record.target.matches('.messages-container'))) schedule();
    });
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-runtime-active'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    observer.observe(sidebar, { childList: true, subtree: true });
    window.addEventListener('moonya:workspace-change', schedule);
    observer.observe(document.getElementById('detailPanel'), { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.getElementById('teamTabBrowser'), { attributes: true, attributeFilter: ['class', 'hidden'] });
    new ResizeObserver(schedule).observe(main.querySelector('.input-container-wrapper'));
    window.MoonYaShell = Object.freeze({ sync });
    sync();
}());
