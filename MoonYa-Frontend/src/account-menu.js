/* Account popover backed by the existing authentication and native pet APIs. */
(function () {
    'use strict';
    const trigger = document.getElementById('userInfoDiv');
    const menu = document.getElementById('accountMenu');
    const petButton = document.getElementById('accountMenuPet');
    const logoutButton = document.getElementById('accountMenuLogout');
    const items = [...menu.querySelectorAll('button')];
    let binding = null;
    let petBusy = false;

    function close(focus = false) {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        if (focus) trigger.focus();
    }

    function syncProfile() {
        const user = isLoggedIn ? currentUser : null;
        const restoreFocus = !menu.hidden && !user && document.activeElement === logoutButton;
        document.getElementById('accountMenuName').textContent = user?.real_name || user?.username || '登录';
        document.getElementById('accountMenuAvatar').src = document.getElementById('userAvatar').src;
        document.getElementById('accountMenuProfile').dataset.tooltip = user ? '账号管理' : '登录';
        document.getElementById('accountMenuTier').hidden = !user;
        document.getElementById('userPlan').textContent = user ? window.MoonYaMembership?.account()?.plan?.name || '免费版' : '免费版';
        logoutButton.hidden = !user;
        logoutButton.disabled = !user || !!logoutRequest;
        if (restoreFocus) items.find(item => !item.disabled && !item.hidden)?.focus();
    }

    function position() {
        const anchor = trigger.getBoundingClientRect();
        const bounds = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(anchor.right + 4, innerWidth - bounds.width - 8));
        const top = Math.max(8, Math.min(anchor.bottom + 4 - bounds.height, innerHeight - bounds.height - 8));
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    async function petBridge() {
        if (window.petController) return window.petController;
        if (!window.CefSharp?.BindObjectAsync) throw new Error('桌面宠物需要 MoonYa Windows 客户端');
        if (!binding) {
            binding = (async () => {
                let timer;
                try {
                    await Promise.race([
                        window.CefSharp.BindObjectAsync('petController'),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('桌面宠物连接超时，请重试')), 5000); })
                    ]);
                    if (!window.petController) throw new Error('桌面宠物服务未连接，请重试');
                    return window.petController;
                } finally { clearTimeout(timer); binding = null; }
            })();
        }
        return binding;
    }

    function syncPet(enabled) {
        petButton.setAttribute('aria-checked', String(!!enabled));
        localStorage.setItem('furinaPetEnabled', enabled ? '1' : '0');
        document.getElementById('settingsVideoToggle')?.classList.toggle('active', !!enabled);
    }

    async function readPet() {
        petButton.disabled = true;
        try {
            const controller = await petBridge();
            syncPet(await controller.isEnabled());
        } catch (_) {
            petButton.setAttribute('aria-checked', 'false');
        } finally {
            if (!petBusy) petButton.disabled = false;
        }
    }

    function open(last = false) {
        void window.MoonYaMembership?.refresh();
        void MoonYaClient.refreshConfig();
        syncProfile();
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        position();
        const enabled = items.filter(item => !item.disabled && !item.hidden);
        (last ? enabled.at(-1) : enabled[0]).focus();
        void readPet();
    }

    trigger.addEventListener('click', () => menu.hidden ? open() : close());
    trigger.addEventListener('keydown', event => {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'Enter' || event.key === ' ') trigger.click();
            else open(event.key === 'ArrowUp');
        }
    });
    menu.addEventListener('keydown', event => {
        const enabled = items.filter(item => !item.disabled && !item.hidden);
        const index = enabled.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
                (index + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length;
            enabled[next]?.focus();
        } else if (event.key === 'Tab') close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); }
    });
    document.addEventListener('click', event => {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
    });
    window.addEventListener('resize', () => { if (!menu.hidden) position(); });
    window.addEventListener('moonya:auth-state', () => {
        syncProfile();
        if (!menu.hidden) {
            if (document.activeElement === logoutButton && logoutButton.hidden) {
                items.find(item => !item.disabled && !item.hidden)?.focus();
            }
            position();
        }
    });
    window.addEventListener('moonya:membership-open', () => close());
    window.addEventListener('moonya:membership-state', () => { syncProfile(); if (!menu.hidden) position(); });
    new MutationObserver(syncProfile).observe(document.getElementById('userAvatar'), { attributes: true, attributeFilter: ['src'] });
    new MutationObserver(syncProfile).observe(document.getElementById('userName'), { childList: true });
    document.getElementById('accountMenuAvatar').addEventListener('error', event => {
        if (event.target.getAttribute('src') !== '/icon.png') event.target.src = '/icon.png';
    });

    document.getElementById('accountMenuSettings').addEventListener('click', () => {
        close(true);
        window.openSettingsModal();
    });
    document.getElementById('accountMenuAppearance').addEventListener('click', () => {
        close(true);
        window.openSettingsModal('appearance');
    });
    const profileRow = document.getElementById('accountMenuProfile');
    if (profileRow) {
        profileRow.addEventListener('click', () => {
            close(true);
            if (window.isLoggedIn) {
                window.openSettingsModal('account');
            } else {
                if (typeof window.openAuthModal === 'function') window.openAuthModal();
                else document.getElementById('qqLoginBtn')?.click();
            }
        });
    }
    petButton.addEventListener('click', async () => {
        if (petBusy) return;
        petBusy = true;
        petButton.disabled = true;
        try {
            const controller = await petBridge();
            const next = !await controller.isEnabled();
            await controller.setEnabled(next);
            const enabled = await controller.isEnabled();
            syncPet(enabled);
            if (enabled !== next) throw new Error('桌面宠物状态未更新，请重试');
            close(true);
            showToast(enabled ? '已显示桌面宠物' : '已隐藏桌面宠物');
        } catch (error) {
            showToast(error.message || '桌面宠物操作失败，请重试');
        } finally { petBusy = false; petButton.disabled = false; }
    });
    logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;
        close(true);
        await window.logoutMoonYaAccount();
        syncProfile();
    });
    syncProfile();
}());
