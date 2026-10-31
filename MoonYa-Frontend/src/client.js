/* Native-hosted static frontend. Only explicit business requests leave the computer. */
(function () {
    'use strict';
    const host = window.MoonYaHost || { backendUrl: '', gatewayToken: '' };
    if (host.titleBarHeight > 0) {
        document.documentElement.dataset.nativeTitleBar = 'true';
        document.documentElement.style.setProperty('--moonya-titlebar-height', `${host.titleBarHeight}px`);
    }
    const originalFetch = window.fetch.bind(window);
    function validConfiguration(value) {
        return value?.version === 1 && typeof value.modelGroups?.deepseek?.default === 'string' &&
            Array.isArray(value.modelGroups.deepseek.models) &&
            value.modelGroups.deepseek.models.every(m => typeof m.id === 'string' && typeof m.label === 'string') &&
            Array.isArray(value.skills) && value.skills.every(s => typeof s.name === 'string' && typeof s.description === 'string') &&
            value.voice && value.ptt && value.runtime && value.features && value.modelCapabilities;
    }
    let cached;
    try { cached = JSON.parse(localStorage.getItem('moonya.client-config.v1')); } catch (_) {}
    const config = window.MoonYaClientConfig = Object.assign(structuredClone(window.MoonYaDefaults), validConfiguration(cached) ? cached : {});
    const pluginStorageKey = 'moonya.plugins.v1';
    const pluginIds = ['browser-use-automation', 'computer-use-automation', 'realtime-voice-chat', 'external-browser-chrome', 'external-browser-edge'];
    const externalBrowsers = { 'external-browser-chrome': 'chrome', 'external-browser-edge': 'edge' };
    let externalPreferences = { chrome: false, edge: false };
    let externalSettingsReady = false;
    let externalSettingsBusy = false;
    let settingsGeneration = 0;
    function readPluginPreferences() {
        try {
            const saved = JSON.parse(localStorage.getItem(pluginStorageKey));
            if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
            return Object.fromEntries(Object.entries(saved).filter(([id, value]) => !externalBrowsers[id] && /^[a-z0-9-]{1,63}$/.test(id) && typeof value === 'boolean'));
        } catch (_) { return {}; }
    }
    let pluginPreferences = readPluginPreferences();
    function pluginAvailable(id) {
        if (externalBrowsers[id]) return externalSettingsReady && !externalSettingsBusy;
        if (id === 'realtime-voice-chat') return true;
        return config.skills.some(skill => skill.name === id && skill.enabled !== false);
    }
    function pluginEnabled(id) {
        if (externalBrowsers[id]) return externalSettingsReady && externalPreferences[externalBrowsers[id]] === true;
        return pluginAvailable(id) && pluginPreferences[id] !== false;
    }
    function validBrowserPreferences(value) {
        return value && typeof value.chrome === 'boolean' && typeof value.edge === 'boolean';
    }
    async function refreshExternalPreferences() {
        if (externalSettingsBusy) return;
        const generation = ++settingsGeneration;
        try {
            const response = await fetch('/api/browser_settings.php');
            const result = await response.json();
            if (!response.ok || !result.success || !validBrowserPreferences(result.preferences)) throw new Error('浏览器设置暂不可用');
            if (generation !== settingsGeneration) return;
            externalPreferences = result.preferences;
            externalSettingsReady = true;
        } catch (_) {
            if (generation !== settingsGeneration) return;
            externalSettingsReady = false;
            externalPreferences = { chrome: false, edge: false };
        }
        syncPluginPreferences();
    }
    async function saveExternalPreference(id, enabled) {
        if (!pluginAvailable(id)) return false;
        ++settingsGeneration;
        externalSettingsBusy = true;
        const previous = externalPreferences;
        externalPreferences = { ...previous, [externalBrowsers[id]]: enabled };
        syncPluginPreferences();
        try {
            const response = await fetch('/api/browser_settings.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(externalPreferences)
            });
            const result = await response.json();
            if (!response.ok || !result.success || !validBrowserPreferences(result.preferences)) throw new Error(result.error || '浏览器设置保存失败，请重试');
            externalPreferences = result.preferences;
            return true;
        } catch (error) {
            externalPreferences = previous;
            if (typeof showToast === 'function') showToast(error.message || '浏览器设置保存失败，请重试');
            return false;
        } finally {
            externalSettingsBusy = false;
            syncPluginPreferences();
        }
    }
    function syncPluginPreferences() {
        renderSkills();
        window.bindMoonYaSkillOptions?.();
        window.pruneMoonYaSelectedSkills?.();
        if (!pluginEnabled('realtime-voice-chat')) window.VoiceChat?.stop();
        window.dispatchEvent(new Event('moonya:plugins-change'));
    }
    window.MoonYaPlugins = Object.freeze({
        isEnabled: pluginEnabled,
        isAvailable: pluginAvailable,
        refreshExternalPreferences,
        setEnabled(id, enabled) {
            if ((!pluginIds.includes(id) && !config.skills.some(skill => skill.name === id)) || typeof enabled !== 'boolean') throw new TypeError('Invalid plugin preference');
            if (externalBrowsers[id]) return saveExternalPreference(id, enabled);
            const next = { ...pluginPreferences, [id]: enabled };
            try { localStorage.setItem(pluginStorageKey, JSON.stringify(next)); }
            catch (_) {
                if (typeof showToast === 'function') showToast('插件设置保存失败，请重试');
                return false;
            }
            pluginPreferences = next;
            syncPluginPreferences();
            return true;
        }
    });
    window.addEventListener('storage', event => {
        if (event.key !== pluginStorageKey && event.key !== null) return;
        pluginPreferences = readPluginPreferences();
        syncPluginPreferences();
    });
    window.VOICE_CONFIG = config.voice;
    window.PTT_CONFIG = config.ptt;
    window.WEB_RUNTIME_CONFIG = config.runtime;
    window.MOONYA_CONFIG = Object.assign(window.MOONYA_CONFIG || {}, host.services || {});
    if (new URLSearchParams(location.search).get('office_popout') === '1') {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.dataset.officePopout = '1'; document.body.classList.add('office-popout-mode');
        });
    }
    const local = new Set(['harness_api.php', 'model_api.php', 'statistics.php', 'context_usage.php', 'prepare.php', 'api/browser_permissions.php', 'api/browser_settings.php', 'api/skills.php']);
    const state = { online: null };
    function status(online) {
        if (state.online === online) return;
        state.online = online;
        document.body?.classList.toggle('backend-offline', !online);
        if (online) window.MoonYaNotifications.remove('backend-connection');
        else window.MoonYaNotifications.update('backend-connection', '连接不可用，可继续查看本地历史和编辑草稿', { duration: 0 });
        window.dispatchEvent(new CustomEvent('moonya:connection', { detail: { online } }));
    }
    // Compatibility boundary for the existing global scripts. No arbitrary URL proxy.
    window.fetch = async function(input, init) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin === location.origin && (/^\/(file-op|cu-op|execute|mcp-op|browser\/)/.test(url.pathname) || url.pathname.startsWith('/gateway/native/'))) {
            const headers = new Headers(init?.headers); headers.set('X-MoonYa-Gateway', host.gatewayToken);
            const token = localStorage.getItem('api_token'); if (token) headers.set('Authorization', 'Bearer ' + token);
            const path = url.pathname.startsWith('/gateway/native/') ? url.pathname : '/gateway/native' + url.pathname;
            return originalFetch(path + url.search, Object.assign({}, init, {headers}));
        }
        if (url.origin !== location.origin || !url.pathname.endsWith('.php')) return originalFetch(input, init);
        const route = url.pathname.replace(/^\//, '');
        let isLocal = local.has(route);
        let body = init?.body;
        if (route === 'api.php' && typeof body === 'string') {
            let data;
            try { data = JSON.parse(body); } catch (_) {}
            if (data) {
                isLocal = !!data.model_ref;
                if (isLocal && !data.resume) {
                    const chat = typeof getChatHistory === 'function' ? getChatHistory().find(c => String(c.id) === String(data.client_chat_id)) : null;
                    const messages = (chat?.messages || []).filter(m => ['user','ai'].includes(m.type)).map(m => {
                        const text = document.createElement('div'); text.innerHTML = m.content || '';
                        return { role: m.type === 'ai' ? 'assistant' : 'user', content: text.textContent || '' };
                    });
                    // The adapter supplies this turn's attachments to the final user message.
                    if (messages.at(-1)?.role !== 'user' || messages.at(-1)?.content !== data.message) messages.push({role:'user',content:data.message});
                    data.messages = messages;
                    body = JSON.stringify(data);
                }
                if (!isLocal && data.resume) {
                    // A continuation needs its cursor, not the original files.
                    for (const key of ['local_paths','local_attachments','file_ids','attachment_ids','image_input_order','deepseek_ocr_texts']) delete data[key];
                    body = JSON.stringify(data);
                }
                if (!isLocal && !data.resume && (data.local_paths?.length || /[A-Za-z]:[\\/][^\r\n]+?\.(?:png|jpe?g|gif|webp)\b/i.test(data.message || ''))) {
                    const prepared = await (await window.fetch('/prepare.php', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:init?.signal})).json();
                    if (!prepared.success) throw new Error(prepared.error || '本地附件读取失败');
                    data.message = prepared.data.message;
                    data.local_attachments = prepared.data.local_attachments;
                    delete data.local_paths;
                    body = JSON.stringify(data);
                }
            }
        }
        if (route === 'api/work_projects.php' && url.searchParams.get('action') !== 'texts') isLocal = true;
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        headers.set('X-MoonYa-Gateway', host.gatewayToken);
        const token = localStorage.getItem('api_token');
        if (token) headers.set('Authorization', 'Bearer ' + token);
        // Legacy query tokens are kept inside the local origin, never sent in server URLs.
        url.searchParams.delete('token'); url.searchParams.delete('api_token');
        const options = Object.assign({}, input instanceof Request ? { method: input.method, body: ['GET','HEAD'].includes(input.method) ? undefined : await input.clone().arrayBuffer() } : {}, init, { headers });
        if (body !== undefined) options.body = body;
        if (!options.signal && !isLocal && route !== 'api.php') options.signal = AbortSignal.timeout(['api/asr.php','api/tts.php','attachment_upload.php'].includes(route) ? 120000 : route==='api/membership.php' && options.method==='POST'?40000:10000);
        try {
            const response = await originalFetch('/gateway/' + (isLocal ? 'local/' : 'remote/') + route + url.search, options);
            if (!isLocal) status(response.status !== 502 && response.status !== 503 && response.status !== 504);
            if ((!isLocal || route === 'api/skills.php') && response.status === 401 && token === localStorage.getItem('api_token') &&
                !(route === 'user_auth.php' && ['login','register'].includes(url.searchParams.get('action')))) window.dispatchEvent(new Event('moonya:auth-expired'));
            if ([502,503,504].includes(response.status) && !isLocal) throw new Error('连接不可用，请恢复网络后重试');
            return response;
        } catch (error) { if (!isLocal && error.name !== 'AbortError') status(false); throw error; }
    };
    function renderSkills() {
        document.querySelectorAll('[data-skill-group]').forEach(group => {
            const common = group.dataset.skillGroup === 'common';
            const custom = group.dataset.skillGroup === 'custom';
            const skills = config.skills.filter(s => (custom ? !['browser-use-automation','computer-use-automation'].includes(s.name)
                : common ? s.name === 'browser-use-automation' : s.name === 'computer-use-automation') && s.enabled !== false && pluginPreferences[s.name] !== false);
            group.replaceChildren();
            group.hidden = skills.length === 0;
            if (!skills.length) return;
            const heading = document.createElement('div'); heading.className = 'add-menu-heading';
            heading.textContent = (custom ? '自定义技能' : common ? '常用' : '研发运维') + ' (' + skills.length + ')'; group.append(heading);
            for (const skill of skills) {
                const button = document.createElement('button'); button.type = 'button';
                button.className = 'add-menu-option skill-menu-option'; button.setAttribute('role', 'menuitem'); button.dataset.skillName = skill.name;
                const copy = document.createElement('span'); copy.className = 'add-menu-option-copy';
                const title = document.createElement('span'); title.className = 'add-menu-option-title'; title.textContent = skill.display_name || skill.name;
                const desc = document.createElement('span'); desc.className = 'add-menu-option-desc'; desc.textContent = skill.description;
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.setAttribute('class', 'add-menu-option-icon skill-accent-' + (common ? 'red' : 'green'));
                icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', 'm12 3 8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5'); icon.append(path);
                copy.append(title, desc); button.append(icon, copy); group.append(button);
            }
        });
        const voiceToggle = document.getElementById('voiceChatToggle');
        if (voiceToggle) voiceToggle.hidden = !pluginEnabled('realtime-voice-chat');
    }
    function renderConfiguration() {
        renderSkills();
        window.pruneMoonYaSelectedSkills?.();
        const group = config.modelGroups.deepseek;
        const label = document.getElementById('deepseekModelBtnText');
        const selected = window.MoonYaModelContext?.builtin()?.id || group.default;
        if (label) label.textContent = group.models.find(m => m.id === selected)?.label || '暂无可用内置模型';
        document.querySelectorAll('[data-builtin-model-options]').forEach(models => {
            const work = models.dataset.builtinModelOptions === 'work';
            models.replaceChildren();
            if(!group.models.length) { const empty=document.createElement('div');empty.className='builtin-unavailable';empty.textContent='暂无可用内置模型';models.append(empty); }
            for (const model of group.models) {
                const row = document.createElement(work ? 'button' : 'div');
                row.className = (work ? 'agent-model-option' : 'deepseek-model-option') + (model.id === selected ? ' selected' : '');
                if (work) {
                    row.type = 'button'; row.dataset.agentModel = model.id;
                    row.setAttribute('role', 'menuitemradio'); row.setAttribute('aria-checked', String(model.id === selected));
                    const text = document.createElement('span'); text.textContent = model.label;
                    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    check.setAttribute('class', 'agent-model-check'); check.setAttribute('viewBox', '0 0 24 24'); check.setAttribute('aria-hidden', 'true');
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm5 12 4 4L19 6'); check.append(path);
                    row.append(text);
                    if(model.multiplier !== undefined) { const rate=document.createElement('span'); rate.className='model-credit-multiplier'; rate.textContent=Number(model.multiplier)+'x'; row.append(rate); }
                    row.append(check);
                } else { row.dataset.model = model.id; const text=document.createElement('span');text.textContent=model.label;row.append(text); if(model.multiplier !== undefined) { const rate=document.createElement('span');rate.className='model-credit-multiplier';rate.textContent=Number(model.multiplier)+'x';row.append(rate); } }
                models.append(row);
            }
        });
        // 重建后要让「未登录时内置模型置灰」重新生效（本函数会清空并重造所有选项）。
        // 首次渲染时 script-1d-dom.js 可能还没加载，因此用可选调用。
        if (typeof window.applyGuestCapabilityState === 'function') window.applyGuestCapabilityState();
    }
    function userAvatar(user) {
        const username = String(user?.username || '').trim();
        const emailQQ = String(user?.email || '').trim().match(/^([1-9][0-9]{4,10})@qq\.com$/i)?.[1];
        const qq = /^[1-9][0-9]{4,10}$/.test(username) ? username : emailQQ;
        return qq ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100` : '/image/user.png';
    }
    function setUserAvatar(image, user) {
        if (!image) return;
        image.onerror = () => { image.onerror = null; image.src = '/image/user.png'; };
        image.src = userAvatar(user);
    }
    function remotePage(path) { return new URL(path.replace(/^\//, ''), host.backendUrl).href; }
    async function openAccountPage(path) {
        if (typeof path === 'string') {
            if (path.includes('user_xinxi.php')) {
                if (typeof window.openSettingsModal === 'function') {
                    window.openSettingsModal();
                    return;
                }
            } else if (path.includes('edit_profile.php') || path.includes('account_settings.php')) {
                if (typeof window.openSettingsModal === 'function') {
                    window.openSettingsModal('account');
                    return;
                }
            }
        }
        try {
            const response=await fetch('/api/client_link.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
            const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'个人中心暂不可用');
            window.open(remotePage(result.data.path),'_blank');
        } catch(error) {if(typeof showToast==='function')showToast(error.message);}
    }
    let configRefresh, skillRefresh;
    function applySkillCatalog(next) {
        if (!Array.isArray(next) || next.some(skill => !skill || typeof skill.name !== 'string' || typeof skill.description !== 'string')) return;
        config.skills.splice(0, config.skills.length, ...next);
        syncPluginPreferences();
        window.dispatchEvent(new CustomEvent('moonya:client-config', { detail: config }));
    }
    function showSkillSync(snapshot) {
        applySkillCatalog(snapshot.skills);
        if (snapshot.source === 'cache' || snapshot.source === 'packaged') {
            const message = snapshot.source === 'cache' ? '技能同步失败，正在使用最近同步的技能版本' : '技能同步失败，正在使用安装包内置技能';
            window.MoonYaNotifications?.update('skill-sync', message, {duration:6000});
        } else window.MoonYaNotifications?.remove('skill-sync');
    }
    function refreshSkills() {
        if (!localStorage.getItem('api_token')) return Promise.resolve();
        if (skillRefresh) return skillRefresh;
        skillRefresh = (async () => {
            try {
                const response = await fetch('/api/skills.php'), result = await response.json();
                if (response.ok && result.success) showSkillSync(result.data);
            } catch (_) {}
        })().finally(() => { skillRefresh = null; });
        return skillRefresh;
    }
    function refreshConfig() {
        if (configRefresh) return configRefresh;
        configRefresh = refreshPublicConfig().finally(() => { configRefresh = null; });
        return configRefresh;
    }
    async function refreshPublicConfig() {
        try {
            const response = await fetch('/api/client_config.php'); const result = await response.json();
            if (!result.success || !validConfiguration(result.data)) return;
            try { localStorage.setItem('moonya.client-config.v1', JSON.stringify(result.data)); } catch (_) {}
            Object.assign(config.voice, result.data.voice); Object.assign(config.ptt, result.data.ptt); Object.assign(config.runtime, result.data.runtime);
            Object.assign(config.features, result.data.features);
            for(const key of Object.keys(config.modelCapabilities))delete config.modelCapabilities[key];
            Object.assign(config.modelCapabilities, result.data.modelCapabilities);
            if (typeof window.applyMoonYaPublicConfiguration === 'function') window.applyMoonYaPublicConfiguration(result.data);
            window.dispatchEvent(new CustomEvent('moonya:client-config', { detail: result.data }));
        } catch (_) {} finally { await refreshSkills(); }
    }
    function cachedUser() {
        try { return JSON.parse(localStorage.getItem('moonya.auth-user.v1') || 'null'); } catch (_) { return null; }
    }
    window.MoonYaClient = { renderConfiguration, remotePage, userAvatar, setUserAvatar, openAccountPage, openSettingsModal: (v) => typeof window.openSettingsModal === 'function' && window.openSettingsModal(v), closeSettingsModal: () => typeof window.closeSettingsModal === 'function' && window.closeSettingsModal(), refreshConfig, refreshSkills, showSkillSync, cachedUser, state, originalFetch };
    window.addEventListener('online', () => { void refreshConfig(); if (typeof checkUserSession === 'function') void checkUserSession(); });
    let lastFocusCheck = 0;
    window.addEventListener('focus', () => {
        if (Date.now() - lastFocusCheck < 30000 || state.online === false || typeof checkUserSession !== 'function') return;
        lastFocusCheck = Date.now(); void checkUserSession();
    });
    window.addEventListener('moonya:auth-expired', () => {
        localStorage.setItem('moonya.auth-expired.v1','1');
        if (typeof renderAuthState === 'function') renderAuthState(cachedUser(), false);
    });
    window.addEventListener('moonya:auth-state', () => { void refreshExternalPreferences(); void refreshSkills(); });
    window.addEventListener('focus', () => { void refreshExternalPreferences(); void refreshConfig(); });
    document.addEventListener('DOMContentLoaded', () => { void refreshConfig(); void refreshExternalPreferences(); });
})();
