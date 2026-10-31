/* Credentials live only in the open editor draft and the authenticated request. */
(() => {
    'use strict';
    const storageKey = 'moonya.model-reference.v1';
    let catalog = { providers: [], presets: [] }, ref = null, loaded = false, draft = null;
    let generation = 0, timer, busy = false, opener, lastSource = '', lastError = '';
    let sessionEfforts = {};
    const effortNames = { auto:'自动（使用请求层默认值）', none:'关闭思考', low:'低', medium:'中', high:'高', xhigh:'超高', max:'极致', ultra:'Ultra' };
    const effortLevels = ['low','medium','high','xhigh','max','ultra'];
    const effortKey = () => JSON.stringify([ref?.provider_id, ref?.model_id]);
    const supportsThinking = m => m.supports_thinking ?? !!m.reasoning;
    const allowsOff = m => !m.reasoning_required && (m.allow_thinking_off ?? m.reasoning !== 'always');
    const inferReasoning = m => (m.custom_protocol ? m.protocol : draft.protocol) === 'anthropic-messages' ? 'anthropic'
        : m.id === 'gemini-3.8-flash' ? 'gemini' : ['gpt-6-sol', 'gpt-6.1-sol'].includes(m.id) || (m.custom_protocol ? m.protocol : draft.protocol) === 'openai-responses' ? 'openai'
        : ({deepseek:'deepseek',kimi:'kimi',glm:'glm',minimax:'minimax',openai:'openai'})[draft.provider] || '';
    const protocols = [['openai-completions','OpenAI Chat Completions'],['openai-responses','OpenAI Responses'],['anthropic-messages','Anthropic Messages']];
    const protocolOptions = value => protocols.map(([id,label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('');
    try { ref = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) {}
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const clone = value => JSON.parse(JSON.stringify(value));
    const get = id => document.getElementById(id);
    const effortLabel = value => value === 'auto' ? '自动' : effortNames[value] || '开启思考';
    const effortTickLabel = value => value === 'none' ? '关闭' : effortLabel(value);
    const supportedEfforts = model => effortLevels.filter(level => model?.efforts?.includes(level));
    function updateEffortSlider(input, choices, value) {
        const position = Math.max(0, choices.indexOf(value));
        input.max = String(Math.max(0, choices.length - 1));
        input.value = String(position);
        input.dataset.effortChoices = JSON.stringify(choices);
        input.setAttribute('aria-valuetext', effortNames[choices[position]] || '开启思考');
        input.style.setProperty('--effort-progress', `${position / Math.max(1, choices.length - 1) * 100}%`);
        const control = input.closest('.cm-effort-control');
        control.querySelector('output').textContent = effortLabel(choices[position]);
        control.querySelector('.cm-effort-ticks').innerHTML = choices.map(level => `<span data-tooltip="${esc(effortNames[level] || '开启思考')}">${effortTickLabel(level)}</span>`).join('');
    }
    function effortSlider(id, label, choices, value, disabled = false, field = '') {
        const position = Math.max(0, choices.indexOf(value));
        return `<div class="cm-effort-control"><label class="cm-effort-heading" for="${id}"><span>${label}</span><output for="${id}">${effortLabel(choices[position])}</output></label>
            <input id="${id}" class="cm-effort-slider" type="range" min="0" max="${Math.max(0, choices.length - 1)}" step="1" value="${position}" aria-label="${label}" aria-valuetext="${esc(effortNames[choices[position]])}" data-effort-choices="${esc(JSON.stringify(choices))}" ${field ? `data-field="${field}"` : ''} ${disabled ? 'disabled' : ''} style="--effort-progress:${position / Math.max(1, choices.length - 1) * 100}%">
            <div class="cm-effort-ticks" aria-hidden="true">${choices.map(level => `<span data-tooltip="${esc(effortNames[level])}">${effortTickLabel(level)}</span>`).join('')}</div></div>`;
    }
    const icons = {
        settings: '<path d="m9.7 4.3.6-1.3h3.4l.6 1.3 1.6.9 1.5-.1 1.7 2.9-.9 1.2v1.8l.9 1.2-1.7 2.9-1.5-.1-1.6.9-.6 1.3h-3.4l-.6-1.3-1.6-.9-1.5.1-1.7-2.9.9-1.2V9.3L4.4 8.1l1.7-2.9 1.5.1Z"/><circle cx="12" cy="10.2" r="2.4"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
        server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/>',
        code: '<path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16"/>',
        eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19.6 19.6 0 0 1-3 3.8M6.3 6.3A20.5 20.5 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.7M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
        plug: '<path d="M8 3v5M16 3v5M5 8h14M7 8v4a5 5 0 0 0 10 0V8M12 17v4"/>',
        lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
        chevron: '<path d="m6 9 6 6 6-6"/>',
        models: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/>',
        model: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 15-6-6L3 21"/>',
        tool: '<path d="M14.7 6.3a5 5 0 0 0-6.5 6.5L3 18l3 3 5.2-5.2a5 5 0 0 0 6.5-6.5L14 13l-3-3 3.7-3.7Z"/>',
        check: '<path d="m5 12 4 4L19 6"/>'
    };
    const icon = (name, className = '') => `<svg class="cm-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
    const isWork = () => document.body.classList.contains('work-mode');
    const selected = () => catalog.providers.find(p => p.id === ref?.provider_id)?.models.find(m => m.id === ref?.model_id);
    const hasContext = m => Number.isSafeInteger(m?.context_window) && m.context_window > 0;
    const ready = () => ref ? loaded && hasContext(selected()) : hasContext(window.MoonYaModelContext?.builtin());
    async function api(action, args = {}) {
        const token = localStorage.getItem('api_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const response = await fetch('/model_api.php', { method: action ? 'POST' : 'GET', credentials: 'same-origin', headers,
            ...(action ? { body: JSON.stringify({ action, ...args }) } : {}) });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || '模型配置请求失败');
        return result.data;
    }
    function setReference(value, persist = true) {
        ref = value?.provider_id && value?.model_id ? { provider_id: value.provider_id, model_id: value.model_id } : null;
        if (loaded && ref && !selected()) ref = null;
        if (!ref && window.renderMoonYaAgentSettings) window.renderMoonYaAgentSettings();
        if (persist) {
            try { localStorage.setItem(storageKey, JSON.stringify(ref)); } catch (_) {}
            if (window.syncActiveConversationComposer) window.syncActiveConversationComposer();
        }
        syncUi();
    }
    function syncUi() {
        const model = selected(), provider = catalog.providers.find(p => p.id === ref?.provider_id);
        window.MoonYaModelContext?.update(ref ? model : window.MoonYaModelContext.builtin(), ref);
        if (model) {
            const label = `${provider.name} · ${model.name || model.id}`;
            ['deepseekModelBtnText', 'agentSettingsCaptionModel', 'agentAdvancedModelValue', 'modelSelectValue']
                .forEach(id => { if (get(id)) get(id).textContent = label; });
            if (get('agentModelStatusText')) get('agentModelStatusText').textContent = model.name || model.id;
            document.querySelectorAll('[data-agent-model], .deepseek-model-option, .model-option[data-value]').forEach(el => {
                el.classList.remove('selected'); el.setAttribute('aria-checked', 'false');
            });
        }
        const controlled = model ? supportsThinking(model) : window.MoonYaBuiltinReasoning.thinking(window.MoonYaModelContext.builtin());
        const slider = get('agentEffortSlider') || document.querySelector('.agent-effort-slider');
        if (slider) { if (model) slider.disabled = !controlled; slider.dataset.tooltip = controlled ? '' : '此模型没有可调节的推理参数'; }
        if (!model) window.MoonYaComposerSettings?.mountSlider(slider);
        if (get('reasoningEffortSelector')) get('reasoningEffortSelector').classList.toggle('custom-no-reasoning', !controlled);
        document.querySelector('.agent-effort-slider-wrap')?.classList.toggle('cm-hidden', !!model);
        get('reasoningEffortSelector')?.classList.toggle('cm-hidden', !!model);
        const levels = supportedEfforts(model);
        const offered = model ? ['auto', ...(supportsThinking(model) ? [...(allowsOff(model) ? ['none'] : []), ...levels, ...(!levels.length ? ['enabled'] : [])] : [])] : [];
        let value = sessionEfforts[effortKey()] || 'auto';
        if (model && !offered.includes(value)) { value = 'auto'; delete sessionEfforts[effortKey()]; }
        ['agentSettingsPopover','deepseekModelDropdown'].forEach(id => {
            const parent = get(id); if (!parent) return;
            let control = parent.querySelector('.cm-session-effort');
            if (!control) {
                control = document.createElement('div'); control.className = 'cm-session-effort';
                control.innerHTML = effortSlider(`${id}CustomEffort`, '思考强度', ['auto'], 'auto') + '<div class="cm-thinking-switch"><label><input type="checkbox" role="switch" aria-label="思考模式">思考模式</label><button type="button" class="cm-effort-auto">自动</button></div>';
                (id === 'agentSettingsPopover' ? parent.querySelector('.agent-effort-control') || parent : parent).append(control);
                control.addEventListener('click', event => event.stopPropagation());
                const commit = choice => { sessionEfforts[effortKey()] = choice; syncUi(); window.syncActiveConversationComposer?.(); };
                control.querySelector('input[type=range]').addEventListener('input', event => commit(JSON.parse(event.target.dataset.effortChoices)[Number(event.target.value)]));
                control.querySelector('input[type=checkbox]').addEventListener('change', event => commit(event.target.checked ? 'enabled' : 'none'));
                control.querySelector('button').addEventListener('click', () => commit('auto'));
            }
            control.hidden = !model;
            control.querySelector('.cm-effort-control').hidden = !levels.length;
            control.querySelector('.cm-thinking-switch').hidden = !!levels.length;
            const range = control.querySelector('input[type=range]');
            updateEffortSlider(range, offered.length ? offered : ['auto'], value);
            range.disabled = !model || !supportsThinking(model);
            if (id === 'agentSettingsPopover') window.MoonYaComposerSettings?.mountSlider(range);
            const toggle = control.querySelector('input[type=checkbox]');
            toggle.checked = !!model && supportsThinking(model) && value !== 'none';
            toggle.disabled = !model || !supportsThinking(model) || !allowsOff(model);
            toggle.setAttribute('aria-description', value === 'auto' ? '自动：使用模型或请求默认设置' : effortLabel(value));
            const automatic = control.querySelector('.cm-effort-auto');
            automatic.setAttribute('aria-pressed', String(value === 'auto'));
            automatic.disabled = !model || !supportsThinking(model);
        });
        if (model) ['agentEffortStatusText','agentSettingsCaptionEffort','agentAdvancedEffortValue'].forEach(id => { if (get(id)) get(id).textContent = !supportsThinking(model) ? '无思考' : value === 'auto' ? model.default_effort && model.default_effort !== 'auto' ? effortNames[model.default_effort] : '自动' : effortNames[value] || '开启思考'; });
        if (model) {
            const effectiveEffort = value === 'auto' ? model.default_effort || 'auto' : value;
            window.MoonYaComposerSettings?.setHeader(get('agentSettingsCaptionEffort')?.textContent, effectiveEffort, supportsThinking(model) && levels.length > 0 && effectiveEffort === levels[levels.length - 1], supportsThinking(model) && levels.length > 1 && effectiveEffort === levels[levels.length - 2]);
        }
        document.querySelectorAll('[data-custom-model]').forEach(el => {
            const value = JSON.parse(el.dataset.customModel);
            el.classList.toggle('selected', value.provider_id === ref?.provider_id && value.model_id === ref?.model_id);
            el.setAttribute('aria-checked', el.classList.contains('selected') ? 'true' : 'false');
        });
        window.dispatchEvent(new Event('moonya:model-selection-change'));
    }
    function renderMenus() {
        ['deepseekModelDropdown', 'agentModelMenu'].map(get).concat([...document.querySelectorAll('.model-select-dropdown')]).filter(Boolean).forEach(menu => {
            menu.querySelector('.custom-model-group')?.remove();
            const group = document.createElement('div'); group.className = 'custom-model-group';
            group.innerHTML = '<div class="custom-model-heading">自定义模型</div>' + catalog.providers.flatMap(p => p.models.filter(m => m.supports_chat).map(m => {
                const pending = !hasContext(m);
                const unavailable = pending || (menu.id === 'agentModelMenu' || isWork()) && m.supports_tools === false;
                const label = `${p.name} · ${m.name || m.id}`;
                const hint = pending ? label + '\n请先配置真实上下文长度' : unavailable ? label + '\n不支持工具调用，无法用于 Work' : label;
                return `<button type="button" role="menuitemradio" class="custom-model-option" data-tooltip="${esc(hint)}" ${unavailable ? 'disabled' : ''}
                    data-custom-model="${esc(JSON.stringify({provider_id:p.id,model_id:m.id}))}"><span class="custom-model-label">${esc(label)}${pending ? '（待配置）' : unavailable ? '（仅 Chat）' : ''}</span></button>`;
            })).join('') + `<button type="button" class="custom-model-configure">${icon('settings')}<span>配置自定义模型</span></button>`;
            menu.append(group);
        });
        document.querySelectorAll('[data-agent-model], .deepseek-model-option, .model-option[data-value]').forEach(el => {
            el.dataset.tooltip = el.textContent.trim();
        });
        syncUi();
        window.dispatchEvent(new Event('moonya:model-catalog-change'));
    }
    async function reload() {
        catalog = await api(); loaded = true;
        if (ref && !selected()) {
            setReference(null); if (window.renderMoonYaAgentSettings) window.renderMoonYaAgentSettings();
        }
        renderMenus(); return catalog;
    }
    const overlay = document.createElement('div'); overlay.className = 'custom-model-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<section class="custom-model-dialog" role="dialog" aria-modal="true" aria-labelledby="cmTitle">
        <header class="cm-header"><div class="cm-heading"><span class="cm-heading-icon">${icon('models')}</span><div><h2 id="cmTitle">配置自定义模型</h2><p>接入你常用的模型服务</p></div></div><button type="button" id="cmClose" class="cm-icon-button" aria-label="关闭">${icon('close')}</button></header>
        <div class="cm-body">
        <div class="cm-tabs" role="tablist" aria-label="接入方式"><button type="button" id="cmPresetTab" role="tab">${icon('server')}<span>第三方模型提供商</span></button><button type="button" id="cmCustomTab" role="tab">${icon('code')}<span>自定义模型 API</span></button></div>
        <p id="cmHelp" class="cm-muted"></p>
        <section id="cmSaved" class="cm-saved" hidden><div class="cm-saved-title"><span>已保存的配置</span><button type="button" id="cmNew" class="cm-text-button">${icon('plus')}<span>新建配置</span></button></div><div id="cmSavedList" class="cm-saved-list"></div></section>
        <div id="cmPresetFields"><label>提供商<select id="cmProvider"></select></label></div>
        <div id="cmCustomFields"><div class="cm-grid"><label>Provider ID<input id="cmId" placeholder="例如 acme_gateway" spellcheck="false"></label>
            <label>显示名称<input id="cmName" placeholder="例如 我的模型服务"></label></div>
            <p class="cm-muted cm-field-hint">Provider ID 以小写字母开头，每个配置使用唯一标识。</p>
            <label>API 协议<select id="cmProtocol">${protocolOptions('openai-completions')}</select></label></div>
        <label id="cmBaseField">API 地址<input id="cmBase" placeholder="https://gateway.example/v1" spellcheck="false"></label>
        <label for="cmKey">API 密钥</label><div class="cm-key"><div class="cm-key-input"><input id="cmKey" type="password" autocomplete="new-password" placeholder="输入 API 密钥" spellcheck="false"><button id="cmReveal" class="cm-icon-button" type="button" aria-label="显示密钥" aria-pressed="false" data-tooltip="显示密钥">${icon('eye')}</button></div><button id="cmTest" type="button">${icon('plug')}<span>测试连接</span></button></div>
        <p class="cm-muted cm-key-hint">${icon('lock')}<span>密钥以明文保存在本机，填写后自动获取模型目录。</span></p>
        <label class="cm-check" id="cmClearKeyLabel"><input id="cmClearKey" type="checkbox">清除已保存的密钥</label>
        <details id="cmAdvanced" class="cm-section"><summary><span class="cm-section-name">${icon('settings')}自定义设置</span>${icon('chevron','cm-chevron')}</summary><div class="cm-section-content"><label id="cmPresetBaseField">API 地址<input id="cmPresetBase" placeholder="提供商默认" spellcheck="false"></label><label>测试模型<select id="cmTestModel"></select></label><p class="cm-muted cm-field-hint">测试连接使用此模型；默认选择第一个可用的对话模型。</p></div></details>
        <details id="cmDirectory" class="cm-section cm-directory"><summary><span class="cm-section-name">${icon('models')}模型目录<span id="cmModelCount" class="cm-count">0</span></span>${icon('chevron','cm-chevron')}</summary><div class="cm-section-content">
            <div class="cm-directory-title"><span>管理可用模型</span><button type="button" id="cmDiscover" class="cm-text-button">${icon('refresh')}<span>获取可用模型</span></button></div>
            <p id="cmSource" class="cm-muted"></p><div class="cm-search">${icon('search')}<input id="cmSearch" placeholder="搜索模型 ID 或名称" aria-label="搜索模型"></div>
            <div id="cmModels" class="cm-models"></div><button type="button" id="cmAdd">${icon('plus')}<span>添加模型</span></button>
        </div></details>
        </div><footer><p id="cmStatus" role="status" aria-live="polite"></p><div class="cm-footer-actions"><button type="button" id="cmDelete" class="cm-danger cm-text-button" hidden>${icon('trash')}<span>删除配置</span></button><button id="cmSave" class="cm-primary" type="button">${icon('check')}<span>保存配置</span></button></div></footer>
    </section>`;
    document.body.append(overlay);
    // Native selects keep the form state; every visible picker uses our own listbox.
    const pickers = new Map();
    let activePicker = null;
    function closePicker() {
        if (!activePicker) return;
        activePicker.menu.hidden = true;
        activePicker.button.setAttribute('aria-expanded', 'false');
        activePicker.button.removeAttribute('aria-activedescendant');
        activePicker = null;
    }
    function positionPicker(picker) {
        const rect = picker.button.getBoundingClientRect(), margin = 12, gap = 6;
        const below = innerHeight - rect.bottom - margin, above = rect.top - margin;
        const upward = below < Math.min(picker.menu.scrollHeight, 220) && above > below;
        const available = Math.max(80, (upward ? above : below) - gap);
        picker.menu.style.maxHeight = `${Math.min(300, available)}px`;
        picker.menu.style.width = `${Math.min(rect.width, innerWidth - margin * 2)}px`;
        picker.menu.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - picker.menu.offsetWidth - margin))}px`;
        picker.menu.style.top = `${upward ? rect.top - picker.menu.offsetHeight - gap : rect.bottom + gap}px`;
    }
    function highlightOption(picker, index) {
        const options = [...picker.menu.querySelectorAll('[role="option"]')];
        if (!options.length) return;
        picker.activeIndex = Math.max(0, Math.min(index, options.length - 1));
        options.forEach((option, i) => option.classList.toggle('cm-option-active', i === picker.activeIndex));
        picker.button.setAttribute('aria-activedescendant', options[picker.activeIndex].id);
        options[picker.activeIndex].scrollIntoView({ block:'nearest' });
    }
    function syncPicker(picker) {
        const options = [...picker.select.options], option = options[picker.select.selectedIndex];
        picker.button.innerHTML = `<span>${esc(option?.textContent || '请选择')}</span>${icon('chevron','cm-chevron')}`;
        picker.button.disabled = picker.select.disabled || busy;
        picker.menu.innerHTML = options.map((entry, index) => `<button type="button" role="option" tabindex="-1" id="${picker.select.id}Option${index}" data-option="${index}" aria-selected="${entry.selected}" ${entry.disabled ? 'disabled' : ''}><span>${esc(entry.textContent)}</span>${entry.selected ? icon('check') : '<span class="cm-option-check"></span>'}</button>`).join('');
        if (activePicker === picker) { positionPicker(picker); highlightOption(picker, picker.select.selectedIndex); }
    }
    function syncPickers() { pickers.forEach(syncPicker); }
    function openPicker(picker, index = picker.select.selectedIndex) {
        closePicker(); syncPicker(picker);
        if (picker.button.disabled || !picker.select.options.length) return;
        activePicker = picker; picker.menu.hidden = false;
        picker.button.setAttribute('aria-expanded', 'true');
        positionPicker(picker); highlightOption(picker, index);
    }
    function chooseOption(picker, index) {
        if (picker.select.options[index]?.disabled) return;
        picker.select.selectedIndex = index; closePicker(); syncPicker(picker);
        picker.select.dispatchEvent(new Event('change', { bubbles:true }));
        picker.button.focus();
    }
    function initializePickers(root = overlay) { root.querySelectorAll('select').forEach(select => {
        if (pickers.has(select.id)) return;
        const wrapper = document.createElement('div'); wrapper.className = 'cm-select';
        select.before(wrapper); wrapper.append(select);
        select.classList.add('cm-native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden','true');
        const button = document.createElement('button'); button.type = 'button'; button.id = select.id + 'Trigger'; button.className = 'cm-select-trigger';
        button.setAttribute('role','combobox'); button.setAttribute('aria-haspopup','listbox'); button.setAttribute('aria-expanded','false');
        button.setAttribute('aria-label', select.getAttribute('aria-label') || {cmProvider:'提供商',cmProtocol:'API 协议',cmTestModel:'测试模型'}[select.id] || '配置');
        const menu = document.createElement('div'); menu.id = select.id + 'List'; menu.className = 'cm-select-popover'; menu.setAttribute('role','listbox'); menu.setAttribute('aria-label',button.getAttribute('aria-label')); menu.hidden = true;
        button.setAttribute('aria-controls',menu.id); wrapper.append(button); overlay.querySelector('.custom-model-dialog').append(menu);
        const picker = {select,button,menu,activeIndex:0}; pickers.set(select.id,picker); syncPicker(picker);
        button.onclick = () => activePicker === picker ? closePicker() : openPicker(picker);
        menu.addEventListener('mousedown', e => e.preventDefault());
        menu.addEventListener('click', e => { const option = e.target.closest('[data-option]'); if (option) chooseOption(picker, Number(option.dataset.option)); });
        button.addEventListener('keydown', e => {
            const opened = activePicker === picker;
            if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
                e.preventDefault();
                if (!opened) openPicker(picker);
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? select.options.length - 1 : picker.activeIndex + (e.key === 'ArrowDown' ? 1 : -1);
                highlightOption(picker, next);
            } else if ((e.key === 'Enter' || e.key === ' ') && opened) { e.preventDefault(); chooseOption(picker,picker.activeIndex); }
            else if (e.key === 'Escape' && opened) { e.preventDefault(); e.stopPropagation(); closePicker(); }
            else if (e.key === 'Tab') closePicker();
        });
        picker.observer = new MutationObserver(() => syncPicker(picker)); picker.observer.observe(select,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
    }); }
    initializePickers();
    document.addEventListener('click', e => { if (activePicker && !activePicker.button.contains(e.target) && !activePicker.menu.contains(e.target)) closePicker(); });
    overlay.addEventListener('scroll', () => { if (activePicker) positionPicker(activePicker); }, true);
    window.addEventListener('resize', () => { if (activePicker) positionPicker(activePicker); });
    function status(message, error = false) {
        get('cmStatus').textContent = '';
        if (!message) { MoonYaNotifications.remove('custom-model-status'); return; }
        MoonYaNotifications.update('custom-model-status', message, { duration: message.startsWith('正在') ? 0 : error ? 4000 : 2000 });
    }
    function readFields() {
        if (!draft) return;
        draft.id = get('cmId').value.trim(); draft.name = get('cmName').value.trim();
        draft.protocol = get('cmProtocol').value;
        draft.base_url = get(draft.provider === 'custom' ? 'cmBase' : 'cmPresetBase').value.trim();
        if (get('cmClearKey').checked) draft.api_key = '';
        else if (get('cmKey').value.trim()) draft.api_key = get('cmKey').value.trim();
        else delete draft.api_key;
    }
    function newDraft(custom = false, provider = 'deepseek') {
        generation++; lastSource = ''; lastError = ''; status('');
        const preset = catalog.presets.find(p => p.id === provider);
        const ids = new Set(catalog.providers.map(p => p.id)); let id = provider;
        for (let n = 2; ids.has(id); n++) id = `${provider}_${n}`;
        draft = custom ? { id:'', name:'', provider:'custom', protocol:'openai-completions', base_url:'', models:[] }
            : { id, name:preset.name, provider, protocol:preset.protocol, base_url:preset.base_url, models:[] };
        showDraft();
    }
    function showDraft() {
        const custom = draft.provider === 'custom', existing = catalog.providers.some(p => p.id === draft.id);
        closePicker(); renderSavedConfigurations(); get('cmDelete').hidden = !existing;
        get('cmPresetTab').setAttribute('aria-selected', String(!custom)); get('cmCustomTab').setAttribute('aria-selected', String(custom));
        get('cmPresetFields').hidden = custom; get('cmCustomFields').hidden = !custom;
        get('cmBaseField').hidden = !custom; get('cmPresetBaseField').hidden = custom;
        get('cmHelp').textContent = custom ? '连接中转站、自部署服务或兼容 OpenAI / Anthropic 协议的接口。' : '选择提供商，填写其 API 密钥即可使用。';
        get('cmProvider').innerHTML = catalog.presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
        get('cmProvider').value = draft.provider;
        get('cmId').value = draft.id; get('cmId').disabled = existing; get('cmName').value = draft.name;
        get('cmProtocol').value = draft.protocol; get('cmBase').value = draft.base_url;
        get('cmPresetBase').value = draft.base_url; get('cmKey').value = ''; setKeyVisibility(false);
        get('cmKey').placeholder = draft.has_key ? '已配置密钥，留空保留' : '输入 API 密钥';
        get('cmClearKey').checked = false; get('cmClearKeyLabel').hidden = !draft.has_key;
        get('cmSearch').value = ''; get('cmAdvanced').open = false; get('cmDirectory').open = false; renderModels();
        syncPickers();
    }
    function renderSavedConfigurations() {
        const custom = draft.provider === 'custom';
        const providers = catalog.providers.filter(p => (p.provider === 'custom') === custom);
        get('cmSaved').hidden = !providers.length;
        get('cmSavedList').innerHTML = providers.map(p => `<button type="button" data-edit-provider="${esc(p.id)}" class="cm-saved-option ${p.id === draft.id ? 'cm-saved-selected' : ''}" aria-pressed="${p.id === draft.id}"><span class="cm-saved-icon">${icon(custom ? 'code' : 'server')}</span><span class="cm-saved-identity"><strong>${esc(p.name)}</strong><small>${esc(p.id)} · ${p.models.length} 个模型</small></span>${icon(p.id === draft.id ? 'check' : 'settings')}</button>`).join('');
    }
    function setKeyVisibility(visible) {
        get('cmKey').type = visible ? 'text' : 'password';
        get('cmReveal').innerHTML = icon(visible ? 'eyeOff' : 'eye');
        get('cmReveal').setAttribute('aria-pressed', String(visible));
        get('cmReveal').setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
        get('cmReveal').dataset.tooltip = visible ? '隐藏密钥' : '显示密钥';
    }
    const contextLabel = value => window.MoonYaModelContext?.format(value) || (hasContext({context_window:value}) ? value.toLocaleString('en-US') : '待配置');
    const contextTitle = m => hasContext(m) ? `${m.context_window.toLocaleString('en-US')} tokens` : '请填写已确认的真实上下文长度';
    function renderTestModels() {
        const test = get('cmTestModel').value;
        const models = draft.models.filter(m => m.supports_chat !== false && hasContext(m));
        get('cmTestModel').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('') || '<option value="">请先配置模型真实上下文长度</option>';
        if (models.some(m => m.id === test)) get('cmTestModel').value = test;
        get('cmTest').disabled = !models.length;
        syncPickers();
    }
    function renderModels() {
        const focused = document.activeElement;
        const focusState = focused?.closest?.('[data-index]') ? { index:focused.closest('[data-index]').dataset.index, id:focused.id, field:focused.dataset.field, level:focused.dataset.effortLevel } : null;
        const expanded = new Map([...get('cmModels').querySelectorAll('[data-index]')].map(node => [Number(node.dataset.index), { open:node.open, advanced:node.querySelector('.cm-model-advanced')?.open }]));
        closePicker();
        for (const [id,picker] of pickers) if (id.startsWith('cmModel')) { picker.observer.disconnect(); picker.menu.remove(); pickers.delete(id); }
        const query = get('cmSearch').value.toLowerCase();
        get('cmModelCount').textContent = draft.models.length;
        get('cmSource').textContent = lastError ? `${lastSource === 'preset' ? '官方预置目录' : '保留已有目录'}；${lastError}` : lastSource === 'api' ? '来源：API 模型目录（保存后生效）' : '上下文长度采用接口或官方资料；待配置模型需在高级配置中填写真实长度。';
        get('cmModels').innerHTML = draft.models.map((m, index) => {
            m.defaults ||= { context_window: m.source === 'manual' ? null : m.context_window, context_window_source: m.context_window_source || 'unknown', max_output_tokens:m.max_output_tokens || 4096, context_window_options:m.context_window_options || [m.context_window].filter(Boolean) };
            if (!`${m.id} ${m.name}`.toLowerCase().includes(query)) return '';
            return `<details class="cm-model ${m.supports_chat === false ? 'cm-unavailable' : ''}" data-index="${index}"><summary><span class="cm-model-icon">${icon('model')}</span><span class="cm-model-identity"><span class="cm-model-name">${esc(m.name || m.id || '新模型')}</span>${m.name && m.name !== m.id ? `<small>${esc(m.id)}</small>` : ''}${m.source === 'manual' ? '<small>手动配置</small>' : ''}</span><span class="cm-model-meta">${m.supports_chat === false ? `<span class="cm-unavailable-reason">${esc(m.unavailable_reason || '不支持当前协议')}</span>` : `${m.supports_images ? `<span class="cm-capability" data-tooltip="支持图片">${icon('image')}</span>` : ''}${m.supports_tools ? `<span class="cm-capability" data-tooltip="支持工具调用">${icon('tool')}</span>` : ''}<span class="cm-context" data-tooltip="${esc(contextTitle(m))}">${contextLabel(m.context_window)}</span>`}${icon('chevron','cm-chevron')}</span></summary>
                <div class="cm-model-editor"><div class="cm-grid"><label>模型 ID<input data-field="id" value="${esc(m.id)}" placeholder="模型的 API ID"></label><label>名称<input data-field="name" value="${esc(m.name)}" placeholder="模型显示名称"></label></div>
                <details class="cm-model-advanced"><summary><span>高级配置</span>${icon('chevron','cm-chevron')}</summary>${advancedModel(m,index)}</details>
                <button type="button" data-remove="${index}" class="cm-danger cm-text-button">${icon('trash')}<span>移除模型</span></button></div></details>`;
        }).join('') || `<div class="cm-empty">${icon(query ? 'search' : 'models')}<strong>${query ? '没有匹配的模型' : '还没有添加模型'}</strong><span>${query ? '试试其他模型 ID 或名称' : '填写密钥自动获取，或手动添加模型'}</span></div>`;
        get('cmModels').querySelectorAll('[data-index]').forEach(node => { const state = expanded.get(Number(node.dataset.index)); if (state) { node.open = state.open; node.querySelector('.cm-model-advanced').open = state.advanced; } });
        initializePickers(get('cmModels')); renderTestModels();
        if (focusState) {
            const target = focusState.id ? get(focusState.id) : get('cmModels').querySelector(`[data-index="${focusState.index}"] ${focusState.field ? `[data-field="${focusState.field}"]` : `[data-effort-level="${focusState.level}"]`}`);
            target?.focus();
        }
    }
    function advancedModel(m,index) {
        const thinking = supportsThinking(m), required = !!m.reasoning_required;
        const checks = [['supports_tools','工具调用'],['supports_images','图片输入'],['supports_thinking','思考模式'],['reasoning_required','仅思考模式'],['allow_thinking_off','允许关闭思考'],['custom_protocol','自定义协议']];
        const options = supportedEfforts(m);
        const capacity = (field,label,values) => `<label>${label}<input data-field="${field}" type="number" min="1" placeholder="使用提供商默认值" value="${esc(m.overrides?.[field] ?? '')}"><span class="cm-quick-values">${values.map(value => `<button type="button" data-capacity="${value*1024}" data-capacity-field="${field}">${value}K</button>`).join('')}</span></label>`;
        return `<div class="cm-capability-checks">${checks.map(([field,label]) => `<label class="cm-check"><input type="checkbox" data-field="${field}" ${ (field === 'supports_thinking' ? thinking : field === 'allow_thinking_off' ? allowsOff(m) : m[field]) ? 'checked' : ''} ${(['reasoning_required','allow_thinking_off'].includes(field) && !thinking || field === 'allow_thinking_off' && required) ? 'disabled' : ''}>${label}</label>`).join('')}</div>
            <p class="cm-muted">仅配置思考开关时不会显示强度选择；支持强度调节的模型请勾选可用档位。</p>
            ${options.length ? effortSlider(`cmModel${index}Default`, '默认思考强度', ['auto',...options], m.default_effort || 'auto', !thinking, 'default_effort') : ''}
            <span class="cm-field-label">支持的思考强度</span><div class="cm-effort-checks">${effortLevels.map(level => `<label class="cm-check"><input type="checkbox" data-effort-level="${level}" ${options.includes(level) ? 'checked' : ''} ${thinking ? '' : 'disabled'}>${effortNames[level]}</label>`).join('')}</div>
            <label>思考参数格式<select id="cmModel${index}Reasoning" data-field="reasoning" aria-label="思考参数格式" ${thinking ? '' : 'disabled'}>${[['auto','自动识别'],['openai','OpenAI'],['gemini','Gemini'],['anthropic','Anthropic'],['deepseek','DeepSeek'],['kimi','Kimi'],['glm','GLM'],['minimax','MiniMax'],['always','始终思考（无需参数）']].map(([value,label]) => `<option value="${value}" ${(m.overrides?.reasoning || 'auto') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            ${thinking && !m.reasoning && !inferReasoning(m) ? '<p class="cm-error">无法识别，请选择思考参数格式。</p>' : ''}
            ${m.custom_protocol ? `<label>模型 API 协议<select id="cmModel${index}Protocol" data-field="protocol" aria-label="模型 API 协议">${protocolOptions(m.protocol || draft.protocol)}</select></label>` : ''}
            ${['gpt-6-sol', 'gpt-6.1-sol'].includes(m.id) && (m.custom_protocol ? m.protocol : draft.protocol) !== 'openai-responses' ? '<p class="cm-muted">思考摘要和开启思考后的工具调用需要 Responses 接口。</p><button type="button" data-use-responses="'+index+'">使用 Responses 显示思考摘要</button>' : ''}
            <div class="cm-grid">${capacity('context_window','输入',[32,64,128,256])}${capacity('max_output_tokens','输出',[8,16,32,64])}</div>
            <label>可选上下文档位（tokens，逗号分隔）<input data-field="context_window_options" placeholder="例如 300000, 1048576" value="${esc((m.context_window_options || [m.context_window].filter(Boolean)).join(', '))}"></label>`;
    }
    let pendingDiscovery = false;
    function close() { if (busy) return; closePicker(); generation++; pendingDiscovery = false; clearTimeout(timer); overlay.hidden = true; draft = null; get('cmKey').value = ''; MoonYaNotifications.remove('custom-model-status'); opener?.focus(); }
    async function open() {
        opener = document.activeElement; overlay.hidden = false; get('cmSave').disabled = false; status('正在读取配置…');
        try { await reload(); newDraft(); pickers.get('cmProvider').button.focus(); }
        catch (error) { status(error.message, true); get('cmSave').disabled = true; }
    }
    async function perform(action) {
        if (!draft) return;
        if (busy) { if (action === 'discover') pendingDiscovery = true; return; }
        readFields(); const stamp = ++generation;
        busy = true; closePicker(); overlay.querySelectorAll('button').forEach(b => b.disabled = true); status(action === 'test' ? '正在测试连接…' : action === 'discover' ? '正在获取模型目录…' : '正在保存…');
        try {
            const result = await api(action, { provider: clone(draft), model_id: get('cmTestModel').value });
            if (stamp !== generation) return;
            if (action === 'discover') {
                const previous = new Map(draft.models.map(m => [m.id, m]));
                if (result.source !== 'error') draft.models = result.models.map(m => {
                    const old = previous.get(m.id); previous.delete(m.id);
                    return { ...m, defaults:m.defaults || {context_window:m.context_window,context_window_source:m.context_window_source || 'api',max_output_tokens:m.max_output_tokens}, source:result.source, overrides:old?.overrides || {}, ...(old?.overrides || {}) };
                }).concat([...previous.values()].filter(m => m.source === 'manual' || Object.keys(m.overrides || {}).length));
                lastSource = result.source; lastError = result.error; renderModels(); status(result.error ? '目录获取失败，仍可编辑和保存草稿。' : `已获取 ${draft.models.length} 个模型；点击保存后生效。`, !!result.error);
            } else if (action === 'test') status(`连接成功 · ${result.elapsed_ms} ms · ${result.model_id}`);
            else {
                const id = draft.id; catalog = result; loaded = true;
                if (ref && !selected()) setReference(null); renderMenus();
                draft = clone(catalog.providers.find(p => p.id === id));
                renderSavedConfigurations(); renderModels();
                get('cmDelete').hidden = false; get('cmClearKeyLabel').hidden = !draft.has_key;
                get('cmClearKey').checked = false; get('cmKey').value = ''; setKeyVisibility(false);
                get('cmKey').placeholder = draft.has_key ? '已配置密钥，留空保留' : '输入 API 密钥';
                status('配置已保存，模型选择菜单已更新。');
            }
        } catch (error) { status(error.message, true); }
        finally {
            busy = false; overlay.querySelectorAll('button').forEach(b => b.disabled = false); get('cmId').disabled = catalog.providers.some(p => p.id === draft?.id);
            if (draft) renderTestModels();
            if (pendingDiscovery && draft && !overlay.hidden) { pendingDiscovery = false; perform('discover'); }
        }
    }
    get('cmClose').onclick = close;
    overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
        if (e.key === 'Tab') { const nodes = [...overlay.querySelectorAll('button,input,select,summary')].filter(n => !n.disabled && n.tabIndex !== -1 && n.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    });
    get('cmPresetTab').onclick = () => { if (!busy) newDraft(false); };
    get('cmCustomTab').onclick = () => { if (!busy) newDraft(true); };
    get('cmNew').onclick = () => newDraft(draft?.provider === 'custom', draft?.provider === 'custom' ? 'deepseek' : draft.provider);
    get('cmSavedList').onclick = e => { const entry = e.target.closest('[data-edit-provider]'); if (!entry || busy) return; generation++; lastSource = ''; lastError = ''; status(''); draft = clone(catalog.providers.find(p => p.id === entry.dataset.editProvider)); showDraft(); };
    get('cmProvider').onchange = e => newDraft(false, e.target.value);
    get('cmReveal').onclick = () => setKeyVisibility(get('cmKey').type === 'password');
    get('cmKey').addEventListener('input', () => { clearTimeout(timer); generation++; timer = setTimeout(() => { if (get('cmKey').value.trim() && !overlay.hidden) perform('discover'); }, 800); });
    ['cmBase', 'cmPresetBase', 'cmProtocol'].forEach(id => get(id).addEventListener('change', () => { generation++; readFields(); if (draft.api_key || draft.has_key) perform('discover'); }));
    get('cmSearch').oninput = renderModels;
    get('cmModels').addEventListener('input', e => {
        const field = e.target.dataset.field, index = e.target.closest('[data-index]')?.dataset.index;
        if (index === undefined) return;
        const model = draft.models[index]; model.overrides ||= {};
        if (e.target.dataset.effortLevel) {
            model.efforts = effortLevels.filter(level => get('cmModels').querySelector(`[data-index="${index}"] [data-effort-level="${level}"]`).checked);
            model.overrides.efforts = model.efforts;
            if (!model.efforts.includes(model.default_effort)) model.default_effort = model.overrides.default_effort = 'auto';
            renderModels(); return;
        }
        if (!field) return;
        const value = e.target.type === 'range' ? JSON.parse(e.target.dataset.effortChoices)[Number(e.target.value)] : e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
        model[field] = value; model.overrides[field] = value;
        if (e.target.type === 'range') updateEffortSlider(e.target, JSON.parse(e.target.dataset.effortChoices), value);
        if (field === 'context_window') {
            if (e.target.value === '') { delete model.overrides.context_window; model.context_window = model.defaults?.context_window ?? null; }
            else model.overrides.context_window = value;
            if (!Object.hasOwn(model.overrides, 'context_window_options')) model.context_window_options = [model.context_window].filter(Boolean);
            model.context_window_source = hasContext(model) ? 'manual' : 'unknown';
            if (!Object.hasOwn(model.overrides, 'context_window')) model.context_window_source = model.defaults?.context_window_source || 'unknown';
        } else if (field === 'max_output_tokens' && e.target.value === '') {
            delete model.overrides.max_output_tokens; model.max_output_tokens = model.defaults?.max_output_tokens || 4096;
        } else if (field === 'context_window_options') {
            model.context_window_options = e.target.value.trim() ? e.target.value.split(/[,，\s]+/).filter(Boolean).map(Number) : [model.context_window].filter(Boolean);
            if (e.target.value.trim()) model.overrides.context_window_options = model.context_window_options;
            else { delete model.overrides.context_window_options; model.context_window_options = model.defaults?.context_window_options || [model.context_window].filter(Boolean); }
        } else if (field === 'supports_thinking') {
            if (value) { model.reasoning = model.overrides.reasoning || inferReasoning(model); model.allow_thinking_off = model.overrides.allow_thinking_off = !model.reasoning_required; }
            else { model.reasoning_required = model.overrides.reasoning_required = false; model.default_effort = model.overrides.default_effort = 'auto'; }
        } else if (field === 'reasoning_required' && value) {
            model.allow_thinking_off = model.overrides.allow_thinking_off = false;
        } else if (field === 'custom_protocol' && value) {
            model.protocol ||= draft.protocol; model.overrides.protocol = model.protocol;
        } else if (field === 'id' && !Object.hasOwn(model.overrides, 'context_window')) {
            const known = catalog.presets.find(p => p.id === draft.provider)?.models.find(m => m.id === value);
            model.context_window = known?.context_window ?? null;
            model.context_window_source = known?.context_window_source || 'unknown';
        }
        if (['protocol','custom_protocol'].includes(field) && (!model.overrides.reasoning || model.overrides.reasoning === 'auto')) model.reasoning = inferReasoning(model);
        const badge = e.target.closest('[data-index]').querySelector('.cm-context');
        if (badge) { badge.textContent = contextLabel(model.context_window); badge.dataset.tooltip = contextTitle(model); }
        renderTestModels();
        if (e.target.type === 'checkbox') renderModels();
    });
    get('cmModels').addEventListener('click', e => {
        const responses = e.target.closest('[data-use-responses]');
        if (responses) {
            const model = draft.models[Number(responses.dataset.useResponses)];
            model.overrides ||= {};
            Object.assign(model, { custom_protocol:true, protocol:'openai-responses', reasoning:'openai', supports_thinking:true });
            Object.assign(model.overrides, { custom_protocol:true, protocol:'openai-responses', reasoning:'openai', supports_thinking:true });
            renderModels(); return;
        }
        const quick = e.target.closest('[data-capacity]');
        if (quick) { const input = quick.closest('label').querySelector('input'); input.value = quick.dataset.capacity; input.dispatchEvent(new Event('input',{bubbles:true})); }
        const remove = e.target.closest('[data-remove]'); if (remove) { draft.models.splice(Number(remove.dataset.remove), 1); renderModels(); }
    });
    get('cmModels').addEventListener('change', e => {
        if (e.target.tagName === 'SELECT' && e.target.dataset.field) { e.target.dispatchEvent(new Event('input',{bubbles:true})); renderModels(); }
        if (['id','name'].includes(e.target.dataset.field)) renderTestModels();
    });
    get('cmAdd').onclick = () => { get('cmSearch').value = ''; draft.models.push({ id:'', name:'', context_window:null, context_window_source:'unknown', max_output_tokens:4096, supports_images:false, supports_tools:true, supports_chat:true, source:'manual', overrides:{} }); renderModels(); const details = get('cmModels').lastElementChild; details.open = true; details.querySelector('input').focus(); };
    get('cmDiscover').onclick = () => perform('discover'); get('cmTest').onclick = () => perform('test'); get('cmSave').onclick = () => perform('save');
    get('cmDelete').onclick = async () => {
        if (!draft || busy) return;
        const id = draft.id, custom = draft.provider === 'custom', provider = custom ? 'deepseek' : draft.provider;
        busy = true; closePicker(); overlay.querySelectorAll('button').forEach(b => b.disabled = true);
        try { catalog = await api('delete', { id }); if (ref?.provider_id === id) { setReference(null); window.renderMoonYaAgentSettings?.(); } renderMenus(); newDraft(custom,provider); status('配置已删除。'); }
        catch (error) { status(error.message, true); } finally { busy = false; overlay.querySelectorAll('button').forEach(b => b.disabled = false); syncPickers(); }
    };
    document.addEventListener('click', e => {
        const configure = e.target.closest('.custom-model-configure'), custom = e.target.closest('[data-custom-model]');
        if (configure || custom) {
            e.preventDefault(); e.stopPropagation();
            if (configure) open(); else if (!custom.disabled) { setReference(JSON.parse(custom.dataset.customModel)); ['deepseekModelDropdown', 'agentModelMenu'].forEach(id => { if (get(id)) { get(id).classList.remove('show'); if (id === 'agentModelMenu') {
                if (window.MoonYaComposerSettings) window.MoonYaComposerSettings.expand(get(id), false, get('agentModelMenuToggle'));
                else get(id).hidden = true;
                get('agentModelCaptionToggle')?.setAttribute('aria-expanded', 'false');
            } } }); }
        } else if (e.target.closest('[data-agent-model],.deepseek-model-option,.model-option[data-value]')) { setReference(null); }
    }, true);
    window.MoonYaModels = { ready, reference: () => ref ? { ...ref } : null, setReference, syncUi, reload, open,
        catalog: () => clone(catalog), loaded: () => loaded,
        resetEffort: () => { delete sessionEfforts[effortKey()]; syncUi(); window.syncActiveConversationComposer?.(); },
        selected,
        snapshotEfforts: () => ({ ...sessionEfforts }),
        restoreEfforts: values => { sessionEfforts = values && typeof values === 'object' ? { ...values } : {}; },
        effort: value => { const m = selected(); if (!m) return value; if (!supportsThinking(m)) return 'none'; const choice = sessionEfforts[effortKey()] || 'auto'; return choice === 'enabled' ? 'high' : choice; } };
    renderMenus(); reload().catch(() => {});
    function positionMenus() {
        document.querySelectorAll('#agentModelMenu, #deepseekModelDropdown, .model-select-dropdown').forEach(menu => {
            if (!menu.getClientRects().length) return;
            const agent = menu.id === 'agentModelMenu';
            const anchor = agent ? menu.closest('.agent-settings-popover') : menu.parentElement;
            if (!anchor) return;
            // Keep absolute positioning: the settings popover's backdrop filter
            // and opening animation can create a containing block for fixed children.
            menu.style.position = 'absolute';
            const rect = anchor.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
            const margin = 12, width = bounds.width, height = bounds.height;
            let left = agent ? rect.left - width - 7 : rect.left;
            if (agent && (innerWidth <= 680 || left < margin)) left = rect.right - width;
            left = Math.max(margin, Math.min(left, innerWidth - margin - width));
            const preferredTop = agent ? (innerWidth <= 680 ? rect.top - height - 7 : rect.bottom - height)
                : menu.id === 'deepseekModelDropdown' ? rect.top - height - 6 : rect.bottom + 6;
            const top = Math.max(margin, Math.min(preferredTop, innerHeight - margin - height));
            const parent = menu.offsetParent;
            if (!parent) return;
            const origin = parent.getBoundingClientRect();
            const scaleX = origin.width / parent.offsetWidth || 1, scaleY = origin.height / parent.offsetHeight || 1;
            const style = getComputedStyle(menu);
            Object.assign(menu.style, { right:'auto', bottom:'auto',
                left:((left - origin.left) / scaleX - parent.clientLeft - (parseFloat(style.marginLeft) || 0)) + 'px',
                top:((top - origin.top) / scaleY - parent.clientTop - (parseFloat(style.marginTop) || 0)) + 'px' });
        });
    }
    let menuPositionFrame;
    function scheduleMenuPositions() {
        cancelAnimationFrame(menuPositionFrame);
        menuPositionFrame = requestAnimationFrame(positionMenus);
    }
    document.addEventListener('click', scheduleMenuPositions, true);
    document.addEventListener('animationend', scheduleMenuPositions, true);
    document.addEventListener('transitionend', e => {
        if (e.target.id === 'agentAdvancedPanel') scheduleMenuPositions();
    }, true);
    window.addEventListener('resize', scheduleMenuPositions);
    window.addEventListener('scroll', scheduleMenuPositions, {capture:true,passive:true});
    window.addEventListener('storage', e => { if (e.key === 'api_token') reload().catch(() => {}); });
    new MutationObserver(renderMenus).observe(document.body, { attributes:true, attributeFilter:['class'] });
})();
