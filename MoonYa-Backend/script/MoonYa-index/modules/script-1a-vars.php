    <script>






        // 对话历史管理
        let currentChatId = null;
        let currentDbConversationId = null; // 数据库中的对话ID（用于多轮对话）
        let isBatchDeleteMode = false;
        let isLoggedIn = false;
        let currentUser = null;
        let CHAT_HISTORY_KEY = 'chat_history';

        const FEATURE_CONFIG = <?php echo json_encode([
            'horoscope' => [
                'enabled' => $config['horoscope']['enabled'] ?? true,
                'apiUrl' => $config['horoscope']['api_url'] ?? '',
                'apiToken' => $config['horoscope']['api_token'] ?? '',
            ],
            'weather' => [
                'enabled' => $config['weather']['enabled'] ?? true,
                'apiUrl' => $config['weather']['api_url'] ?? '',
                'apiToken' => $config['weather']['api_token'] ?? '',
                'ipLocationApis' => $config['weather']['ip_location_apis'] ?? [],
                'defaultTimezone' => $config['weather']['default_timezone'] ?? 'UTC+8',
            ],
        ]); ?>;
        const BG_WEBP_DATA = '<?php
            $bgPath = __DIR__ . '/image/bg.webp';
            if (file_exists($bgPath)) {
                echo base64_encode(file_get_contents($bgPath));
            }
        ?>';
        
        // 主对话只提供 deepseek-flash；Work/Chat 各自保存一套思考档位。
        const DEEPSEEK_MODEL_STORAGE_KEY = 'moonya.deepseek.model.v1';
        const WORK_EFFORT_STORAGE_KEY = 'moonya.deepseek.reasoning.work.v2';
        const CHAT_EFFORT_STORAGE_KEY = 'moonya.deepseek.reasoning.chat.v2';
        const LEGACY_EFFORT_STORAGE_KEY = 'moonya.deepseek.reasoning.v1';
        const MODEL_UI_CONFIG = <?php echo json_encode($config['ui_model_groups'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); ?>;
        function configuredModelGroup(name) {
            const group = MODEL_UI_CONFIG[name];
            if (!group || !group.default || !Array.isArray(group.models) || group.models.length === 0) {
                throw new Error('Missing required configuration: ui_model_groups.' + name);
            }
            return group;
        }
        function configuredModelMeta(groupName, modelId) {
            return configuredModelGroup(groupName).models.find(function(model) { return model.id === modelId; }) || null;
        }
        function configuredModelLabel(groupName, modelId) {
            const model = configuredModelMeta(groupName, modelId);
            return model ? model.label : modelId;
        }
        const DEEPSEEK_MODEL_GROUP = configuredModelGroup('deepseek');
        const DEEPSEEK_MODEL_ALLOWLIST = DEEPSEEK_MODEL_GROUP.models.map(function(model) { return model.id; });
        const REASONING_PROFILES = {
            none: { label: '不思考', effort: 'none', detail: 'high' },
            light: { label: '轻度', effort: 'low', detail: 'low' },
            medium: { label: '中', effort: 'low', detail: 'high' },
            high: { label: '高', effort: 'high', detail: 'high' },
            max: { label: 'Max', effort: 'max', detail: 'high' },
            ultra: { label: 'Ultra', effort: 'ultra', detail: 'high' }
        };
        const WORK_REASONING_LEVELS = ['light', 'medium', 'high', 'max', 'ultra'];
        const CHAT_REASONING_LEVELS = ['none', 'light', 'medium', 'high', 'max', 'ultra'];
        let persistedDeepseekModel = DEEPSEEK_MODEL_GROUP.default;
        let workReasoningProfile = 'high';
        let chatReasoningProfile = 'high';
        try {
            const storedModel = localStorage.getItem(DEEPSEEK_MODEL_STORAGE_KEY);
            const legacyEffort = localStorage.getItem(LEGACY_EFFORT_STORAGE_KEY);
            const migrated = ({ none: 'none', low: 'light', medium: 'medium', high: 'high', xhigh: 'ultra', max: 'max', ultra: 'ultra' })[legacyEffort] || 'high';
            const storedWork = localStorage.getItem(WORK_EFFORT_STORAGE_KEY);
            const storedChat = localStorage.getItem(CHAT_EFFORT_STORAGE_KEY);
            if (DEEPSEEK_MODEL_ALLOWLIST.includes(storedModel)) persistedDeepseekModel = storedModel;
            if (WORK_REASONING_LEVELS.includes(storedWork)) workReasoningProfile = storedWork;
            else if (WORK_REASONING_LEVELS.includes(migrated)) workReasoningProfile = migrated;
            if (CHAT_REASONING_LEVELS.includes(storedChat)) chatReasoningProfile = storedChat;
            else if (CHAT_REASONING_LEVELS.includes(migrated)) chatReasoningProfile = migrated;
        } catch (storageError) {}
        let currentModel = 'deepseek';
        let deepseekModelVersion = persistedDeepseekModel;
        let reasoningProfile = workReasoningProfile;
        let reasoningEffort = REASONING_PROFILES[reasoningProfile].effort;
        let imageDetail = REASONING_PROFILES[reasoningProfile].detail;
        function setReasoningProfile(profile) {
            const levels = isAgentMode ? WORK_REASONING_LEVELS : CHAT_REASONING_LEVELS;
            reasoningProfile = levels.includes(profile) ? profile : 'high';
            if (isAgentMode) workReasoningProfile = reasoningProfile;
            else chatReasoningProfile = reasoningProfile;
            reasoningEffort = REASONING_PROFILES[reasoningProfile].effort;
            imageDetail = REASONING_PROFILES[reasoningProfile].detail;
        }
        function activateReasoningMode() {
            setReasoningProfile(isAgentMode ? workReasoningProfile : chatReasoningProfile);
        }
        let isProgrammingMode = false; // 编程模式标志
        let isTranslationMode = false; // 翻译模式标志
        let isWritingMode = false; // 写作模式标志
        let isResearchMode = false; // 深入研究模式标志
        let isClassicalMode = false; // 文言文翻译模式标志
        let isMusicMode = false; // 音乐模式标志
        let isHoroscopeMode = false; // 星座运势模式标志
        let isWeatherMode = false; // 天气模式标志
        let isAgentMode = true;
        const SKILL_CATALOG = <?php echo json_encode($composerSkills, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); ?>;
        let selectedSkills = [];
        function updateActiveFeatureBadges() {
            const container = document.getElementById('activeFeatureBadges');
            const voiceBadge = document.getElementById('voiceFeatureBadge');
            const voiceActive = voiceBadge ? !voiceBadge.hidden : false;
            if (container) container.classList.toggle('has-active', voiceActive);
        }
        window.setMoonYaFeatureBadge = function(feature, active) {
            const badge = feature === 'voice' ? document.getElementById('voiceFeatureBadge') : null;
            if (!badge) return;
            badge.hidden = !active;
            updateActiveFeatureBadges();
        };
        updateActiveFeatureBadges();
        // 当前输出消息的 Agent 名称（用于在 AI 消息气泡上方显示来源）
        // work 模式默认为 "MoonYa Agent"；后端 agent_switch 事件会切换为 "Code-Agent" / "MoonYa-T-Agent"
        let currentAgentName = null;
        // Work 为默认模式，初始化 body 类名以应用对应 CSS
        if (document.body) document.body.classList.add('work-mode');
        
        // 模型选择下拉菜单
        const modelSelectValue = document.getElementById('modelSelectValue');
        const modelSelectDropdown = document.querySelector('.model-select-dropdown');
        const modelOptions = document.querySelectorAll('.model-option');
        
        // 切换模型选择下拉菜单
        modelSelectValue.addEventListener('click', function(e) {
            e.stopPropagation();
            modelSelectDropdown.style.display = modelSelectDropdown.style.display === 'block' ? 'none' : 'block';
            // 切换箭头方向
            const arrow = document.querySelector('.model-select-arrow');
            if (modelSelectDropdown.style.display === 'block') {
                arrow.style.transform = 'translateY(-50%) rotate(180deg)';
            } else {
                arrow.style.transform = 'translateY(-50%)';
            }
        });
        
        // 选择模型
        modelOptions.forEach(option => {
            option.addEventListener('click', function(e) {
                e.stopPropagation();
                const value = this.dataset.value;
                const name = this.querySelector('.model-option-name').textContent;
                
                // 显示切换模型的提示
                showToast('正在切换模型...');
                
                setTimeout(() => {
                    currentModel = value;
                    document.getElementById('modelSelect').value = value;
                    modelSelectValue.textContent = name;
                    modelSelectDropdown.style.display = 'none';
                    // 重置箭头方向
                    const arrow = document.querySelector('.model-select-arrow');
                    arrow.style.transform = 'translateY(-50%)';
                    // 更新选中状态
                    modelOptions.forEach(opt => opt.classList.remove('selected'));
                    this.classList.add('selected');
                    
                    if (typeof updateSpecialistLabelsVisibility === 'function') {
                        updateSpecialistLabelsVisibility();
                    }
                    
                    if (typeof updateDeepSeekSelectorsVisibility === 'function') {
                        updateDeepSeekSelectorsVisibility();
                    }
                    
                    showToast(`已切换为: ${name}`);
                }, 500);
            });
        });
        
        // 模式切换 Tab
        const modeTabs = document.querySelectorAll('.mode-toggle-tab');
        const modeSelect = document.getElementById('modeSelect');
        modeTabs.forEach(tab => {
            tab.addEventListener('click', async function(e) {
                e.stopPropagation();
                const value = this.dataset.value;
                await window.switchMoonYaConversationMode(value);
                modeTabs.forEach(t => t.classList.remove('active'));
                this.classList.add('active');
                if (modeSelect) modeSelect.value = value;
                if (value === 'work') {
                    isAgentMode = true;
                    document.body.classList.add('work-mode');
                    showToast('已切换到Work模式');
                } else {
                    isAgentMode = false;
                    currentAgentName = null;
                    document.body.classList.remove('work-mode');
                    showToast('已切换到Chat模式');
                }
                activateReasoningMode();
                if (typeof window.renderMoonYaAgentSettings === 'function') window.renderMoonYaAgentSettings();
                if (typeof updateModelSelectVisibility === 'function') {
                    updateModelSelectVisibility();
                }
                if (typeof updateWorkProjectBarVisibility === 'function') {
                    updateWorkProjectBarVisibility();
                }
                if (typeof updateOfficeBtnVisibility === 'function') {
                    updateOfficeBtnVisibility();
                }
                if (typeof window.syncActiveConversationComposer === 'function') window.syncActiveConversationComposer();
                if (window.MoonYaContextRing) window.MoonYaContextRing.refresh();
                // 桌面端原生标题栏跟随模式：Work 隐藏「语音播报」开关
                if (typeof window.moonYaPushWorkMode === 'function') window.moonYaPushWorkMode(value === 'work');
            });
        });

        // DeepSeek子模型选择器
        const deepseekModelSelector = document.getElementById('deepseekModelSelector');
        const deepseekModelBtn = document.getElementById('deepseekModelBtn');
        const deepseekModelBtnText = document.getElementById('deepseekModelBtnText');
        const deepseekModelDropdown = document.getElementById('deepseekModelDropdown');
        const deepseekModelOptions = document.querySelectorAll('.deepseek-model-option');
        
        if (deepseekModelBtn) {
            deepseekModelBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (deepseekModelDropdown) deepseekModelDropdown.classList.toggle('show');
                deepseekModelBtn.classList.toggle('open');
            });
        }
        
        deepseekModelOptions.forEach(option => {
            option.addEventListener('click', function(e) {
                e.stopPropagation();
                const model = this.dataset.model;
                deepseekModelVersion = model;
                const displayName = configuredModelLabel('deepseek', model);
                if (deepseekModelBtnText) deepseekModelBtnText.textContent = displayName;
                if (deepseekModelDropdown) deepseekModelDropdown.classList.remove('show');
                if (deepseekModelBtn) deepseekModelBtn.classList.remove('open');
                deepseekModelOptions.forEach(opt => opt.classList.remove('selected'));
                this.classList.add('selected');
                window.MoonYaModels?.syncUi();
                showToast(`已切换为: ${model}`);
            });
        });
        
        // 推理档位选择器
        const reasoningEffortSelector = document.getElementById('reasoningEffortSelector');
        const reasoningEffortBtn = document.getElementById('reasoningEffortBtn');
        const reasoningEffortBtnText = document.getElementById('reasoningEffortBtnText');
        const reasoningEffortDropdown = document.getElementById('reasoningEffortDropdown');
        const reasoningEffortOptions = document.querySelectorAll('.reasoning-effort-option');
        
        if (reasoningEffortBtn) {
            reasoningEffortBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (reasoningEffortDropdown) reasoningEffortDropdown.classList.toggle('show');
                reasoningEffortBtn.classList.toggle('open');
            });
        }
        
        reasoningEffortOptions.forEach(option => {
            option.addEventListener('click', function(e) {
                e.stopPropagation();
                const effort = this.dataset.effort;
                setReasoningProfile(effort === 'max' ? 'max' : 'high');
                const effortNames = { high: '高推理', max: '极致推理' };
                if (reasoningEffortBtnText) reasoningEffortBtnText.textContent = effortNames[effort] || '高推理';
                if (reasoningEffortDropdown) reasoningEffortDropdown.classList.remove('show');
                if (reasoningEffortBtn) reasoningEffortBtn.classList.remove('open');
                reasoningEffortOptions.forEach(opt => opt.classList.remove('selected'));
                this.classList.add('selected');
                showToast(`推理档位: ${effortNames[effort]}`);
            });
        });

        // 参考桌面端的紧凑模型/推理浮层。滑条只生成 DeepSeek 参数。
        (function initAgentSettings() {
            const selector = document.getElementById('agentSettingsSelector');
            const status = document.getElementById('agentSettingsStatus');
            const popover = document.getElementById('agentSettingsPopover');
            const advancedToggle = document.getElementById('agentAdvancedToggle');
            const advancedPanel = document.getElementById('agentAdvancedPanel');
            const modelMenuToggle = document.getElementById('agentModelMenuToggle');
            const modelMenu = document.getElementById('agentModelMenu');
            const modelCaptionToggle = document.getElementById('agentModelCaptionToggle');
            const resetButton = document.getElementById('agentEffortReset');
            const controls = window.MoonYaComposerSettings;
            const slider = document.getElementById('reasoningEffortSlider');
            const uploadButton = document.getElementById('fileCard');
            if (!selector || !status || !popover || !slider) return;
            if (uploadButton) {
                uploadButton.addEventListener('keydown', function(event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        uploadButton.click();
                    }
                });
            }

            const modelLabels = Object.fromEntries(DEEPSEEK_MODEL_GROUP.models.map(function(model) {
                return [model.id, model.label];
            }));

            function persistSettings() {
                try {
                    localStorage.setItem(DEEPSEEK_MODEL_STORAGE_KEY, deepseekModelVersion);
                    localStorage.setItem(WORK_EFFORT_STORAGE_KEY, workReasoningProfile);
                    localStorage.setItem(CHAT_EFFORT_STORAGE_KEY, chatReasoningProfile);
                } catch (storageError) {}
            }

            function syncLegacyControls() {
                deepseekModelOptions.forEach(function(option) {
                    option.classList.toggle('selected', option.dataset.model === deepseekModelVersion);
                });
                if (deepseekModelBtnText) {
                    deepseekModelBtnText.textContent = configuredModelLabel('deepseek', deepseekModelVersion);
                }
                reasoningEffortOptions.forEach(function(option) {
                    const legacyEffort = option.dataset.effort === 'max' ? 'max' : option.dataset.effort;
                    option.classList.toggle('selected', legacyEffort === reasoningEffort);
                });
                if (reasoningEffortBtnText) {
                    reasoningEffortBtnText.textContent = REASONING_PROFILES[reasoningProfile].label + '推理';
                }
                const legacyThinkingLabel = document.getElementById('deepThinkingLabel');
                if (legacyThinkingLabel) {
                    legacyThinkingLabel.classList.toggle('active', reasoningEffort !== 'none');
                }
            }

            function renderSettings() {
                currentModel = 'deepseek';
                if (!DEEPSEEK_MODEL_ALLOWLIST.includes(deepseekModelVersion)) {
                    deepseekModelVersion = DEEPSEEK_MODEL_GROUP.default;
                }
                const levels = isAgentMode ? WORK_REASONING_LEVELS : CHAT_REASONING_LEVELS;
                if (!levels.includes(reasoningProfile)) setReasoningProfile('high');
                const effortLabel = REASONING_PROFILES[reasoningProfile].label;
                controls.setHeader(effortLabel, reasoningProfile, reasoningProfile === levels[levels.length - 1], reasoningProfile === levels[levels.length - 2]);
                const modelLabel = modelLabels[deepseekModelVersion];
                slider.max = String(levels.length - 1);
                slider.value = String(levels.indexOf(reasoningProfile));
                slider.setAttribute('aria-label', '推理强度：' + effortLabel);
                slider.setAttribute('aria-valuetext', effortLabel);
                controls.mountSlider(slider);
                slider.style.setProperty('--effort-progress', (Number(slider.value) / Math.max(1, levels.length - 1) * 100) + '%');
                const dots = selector.querySelectorAll('.agent-effort-dots i');
                dots.forEach(function(dot, index) { dot.hidden = index >= levels.length; });
                ['agentModelStatusText', 'agentSettingsCaptionModel', 'agentAdvancedModelValue'].forEach(function(id) {
                    const node = document.getElementById(id);
                    if (node) node.textContent = modelLabel;
                });
                ['agentEffortStatusText', 'agentSettingsCaptionEffort', 'agentAdvancedEffortValue'].forEach(function(id) {
                    const node = document.getElementById(id);
                    if (node) node.textContent = effortLabel;
                });
                modelMenu.querySelectorAll('[data-agent-model]').forEach(function(button) {
                    const selected = button.dataset.agentModel === deepseekModelVersion;
                    button.classList.toggle('selected', selected);
                    button.setAttribute('aria-checked', selected ? 'true' : 'false');
                });
                syncLegacyControls();
                if (window.MoonYaModels) window.MoonYaModels.syncUi();
                persistSettings();
            }

            function closeSettings() {
                selector.classList.remove('open');
                popover.inert = true;
                popover.setAttribute('aria-hidden', 'true');
                status.setAttribute('aria-expanded', 'false');
                closeModelMenu();
                popover.querySelectorAll('.context-picker-menu').forEach(menu => controls.expand(menu, false, menu.parentElement.querySelector('button')));
            }

            function closeModelMenu() {
                controls.expand(modelMenu, false, modelMenuToggle);
                modelCaptionToggle?.setAttribute('aria-expanded', 'false');
            }

            status.addEventListener('click', function(event) {
                event.stopPropagation();
                const open = selector.classList.toggle('open');
                popover.inert = !open;
                popover.setAttribute('aria-hidden', String(!open));
                status.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (!open) closeSettings();
            });
            slider.addEventListener('input', function() {
                const levels = isAgentMode ? WORK_REASONING_LEVELS : CHAT_REASONING_LEVELS;
                setReasoningProfile(levels[Number(slider.value)] || 'high');
                renderSettings();
                if (typeof window.syncActiveConversationComposer === 'function') window.syncActiveConversationComposer();
            });
            if (advancedToggle && advancedPanel) {
                advancedToggle.addEventListener('click', function(event) {
                    event.stopPropagation();
                    const willOpen = advancedPanel.hidden;
                    controls.expand(advancedPanel, willOpen, advancedToggle);
                    if (!willOpen) {
                        advancedPanel.querySelectorAll('.context-picker-menu').forEach(menu => controls.expand(menu, false, menu.parentElement.querySelector('button')));
                        closeModelMenu();
                    }
                });
            }
            if (modelMenuToggle && modelMenu) {
                function toggleModelMenu(event) {
                    event.stopPropagation();
                    controls.expand(modelMenu, modelMenu.hidden, modelMenuToggle);
                    modelCaptionToggle?.setAttribute('aria-expanded', String(!modelMenu.hidden));
                }
                modelMenuToggle.addEventListener('click', toggleModelMenu);
                modelCaptionToggle?.addEventListener('click', toggleModelMenu);
                modelMenu.querySelectorAll('[data-agent-model]').forEach(function(button) {
                    button.addEventListener('click', function(event) {
                        event.stopPropagation();
                        deepseekModelVersion = button.dataset.agentModel;
                        closeModelMenu();
                        renderSettings();
                        if (typeof window.syncActiveConversationComposer === 'function') window.syncActiveConversationComposer();
                    });
                });
            }
            document.addEventListener('click', function(event) {
                if (!selector.contains(event.target)) closeSettings();
            });
            selector.addEventListener('keydown', function(event) {
                if (event.key === 'Escape') {
                    event.preventDefault(); event.stopPropagation();
                    if (!modelMenu.hidden) { closeModelMenu(); modelCaptionToggle.focus(); return; }
                    if (!advancedPanel.hidden) { controls.expand(advancedPanel, false, advancedToggle); advancedToggle.focus(); return; }
                    closeSettings();
                    status.focus();
                }
            });
            resetButton?.addEventListener('click', function(event) {
                event.stopPropagation();
                if (window.MoonYaModels?.reference()) window.MoonYaModels.resetEffort();
                else { setReasoningProfile('high'); renderSettings(); window.syncActiveConversationComposer?.(); }
            });
            window.renderMoonYaAgentSettings = renderSettings;
            renderSettings();
        })();
        
        function updateDeepSeekSelectorsVisibility() {
            const dtLabel = document.getElementById('deepThinkingLabel');
            const isDeepThinking = dtLabel ? dtLabel.classList.contains('active') : false;
            if (deepseekModelSelector) {
                deepseekModelSelector.classList.add('visible');
            }
            if (reasoningEffortSelector) {
                if (isDeepThinking) {
                    reasoningEffortSelector.classList.add('visible');
                } else {
                    reasoningEffortSelector.classList.remove('visible');
                }
            }
            if (dtLabel) {
                dtLabel.style.display = '';
                dtLabel.classList.remove('think-locked');
                dtLabel.title = '';
            }
            const expertLabel = document.getElementById('expertLabel');
            const specialistLabel = document.getElementById('specialistLabel');
            if (expertLabel) {
                expertLabel.style.display = '';
            }
            if (specialistLabel) {
                specialistLabel.style.display = '';
            }
        }
        updateDeepSeekSelectorsVisibility();

        // Work模式下隐藏侧边栏模型选择
        function updateModelSelectVisibility() {
            const c = document.getElementById('modelSelectContainer');
            if (c) c.classList.toggle('sidebar-model-hidden', isAgentMode);
        }
        updateModelSelectVisibility();

        // Work 模式下显示/隐藏“进入项目工作区”
        function updateWorkProjectBarVisibility() {
            const bar = document.getElementById('workProjectBar');
            if (!bar) return;
            bar.style.display = isAgentMode ? 'block' : 'none';
            if (!isAgentMode) {
                const dd = document.getElementById('workProjectDropdown');
                const btn = document.getElementById('workProjectBtn');
                if (dd) dd.classList.remove('show');
                if (btn) btn.classList.remove('open');
            }
        }
        updateWorkProjectBarVisibility();

        // Chat 模式下隐藏“办公室”入口，并关闭可能已打开的办公室视图
        function updateOfficeBtnVisibility() {
            const btn = document.getElementById('officeBtn');
            if (btn) btn.style.display = isAgentMode ? '' : 'none';
            if (!isAgentMode && document.body.classList.contains('office-active') && window.MoonYaOffice) {
                window.MoonYaOffice.close();
            }
        }
        updateOfficeBtnVisibility();

        // Work 模式：进入项目工作区下拉菜单
        const workProjectBtn = document.getElementById('workProjectBtn');
        const workProjectDropdown = document.getElementById('workProjectDropdown');
        
        // ═══ 更多功能按钮：下拉菜单 ═══
        const moreFeaturesBtn = document.getElementById('moreFeaturesBtn');
        const moreFeaturesDropdown = document.getElementById('moreFeaturesDropdown');
        const moreFeaturesOptions = document.querySelectorAll('.more-features-option');
        
        // 功能名 → 对应的模式变量/按钮ID映射
        // Harness 化重构：写作/翻译（工具设置删除）与音乐/雅泫视频（娱乐站删除）已移除
        const FEATURE_MAP = {
            programming: { flag: 'isProgrammingMode',  btnId: 'programmingBtn' },
            research:    { flag: 'isResearchMode',     btnId: 'researchBtn' },
            classical:   { flag: 'isClassicalMode',    btnId: 'classicalBtn' },
            horoscope:   { flag: 'isHoroscopeMode',    btnId: 'horoscopeBtn' },
            weather:     { flag: 'isWeatherMode',      btnId: 'weatherBtn' },
        };

        function updateMoreFeaturesActiveState() {
            const hasActiveFeature = isProgrammingMode ||
                                     isResearchMode || isClassicalMode ||
                                     isHoroscopeMode || isWeatherMode;
            if (moreFeaturesBtn) {
                moreFeaturesBtn.classList.toggle('active', hasActiveFeature);
            }
            // 同步下拉菜单选项的激活状态
            moreFeaturesOptions.forEach(function(opt) {
                var feature = opt.getAttribute('data-feature');
                var map = FEATURE_MAP[feature];
                var isActive = map && window[map.flag];
                opt.classList.toggle('active', !!isActive);
            });
        }
        
        // 打开/关闭下拉菜单
        if (moreFeaturesBtn && moreFeaturesDropdown) {
            moreFeaturesBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                moreFeaturesDropdown.classList.toggle('show');
                moreFeaturesBtn.classList.toggle('open');
            });
        }
        
        // 下拉菜单选项点击
        moreFeaturesOptions.forEach(function(opt) {
            opt.addEventListener('click', function(e) {
                e.stopPropagation();
                var feature = this.getAttribute('data-feature');
                var map = FEATURE_MAP[feature];
                if (map) {
                    // 模拟点击对应的功能按钮
                    var btn = document.getElementById(map.btnId);
                    if (btn) btn.click();
                }
                // 关闭下拉菜单
                if (moreFeaturesDropdown) moreFeaturesDropdown.classList.remove('show');
                if (moreFeaturesBtn) moreFeaturesBtn.classList.remove('open');
            });
        });
        
        // 点击页面其他地方关闭更多功能下拉菜单
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.more-features-selector')) {
                if (moreFeaturesDropdown) moreFeaturesDropdown.classList.remove('show');
                if (moreFeaturesBtn) moreFeaturesBtn.classList.remove('open');
            }
            if (!e.target.closest('.custom-model-select')) {
                modelSelectDropdown.style.display = 'none';
                const arrow = document.querySelector('.model-select-arrow');
                arrow.style.transform = 'translateY(-50%)';
            }
            if (!e.target.closest('.deepseek-model-selector')) {
                const dd = document.getElementById('deepseekModelDropdown');
                const btn = document.getElementById('deepseekModelBtn');
                if (dd) dd.classList.remove('show');
                if (btn) btn.classList.remove('open');
            }
            if (!e.target.closest('.reasoning-effort-selector')) {
                const dd = document.getElementById('reasoningEffortDropdown');
                const btn = document.getElementById('reasoningEffortBtn');
                if (dd) dd.classList.remove('show');
                if (btn) btn.classList.remove('open');
            }
            if (!e.target.closest('.work-project-selector')) {
                const dd = document.getElementById('workProjectDropdown');
                const btn = document.getElementById('workProjectBtn');
                if (dd) dd.classList.remove('show');
                if (btn) btn.classList.remove('open');
            }
        });
        
        // 窗口容量来自模型元数据；压缩预算另行预留输出空间。
        const BUILTIN_MODEL_METADATA = <?php echo json_encode($config['model_capabilities'] ?? []); ?>;
        let contextLimitTokens = Number(BUILTIN_MODEL_METADATA[deepseekModelVersion]?.context_window) || null;
        let contextModelKey = 'builtin:' + deepseekModelVersion;
        let contextSelections = {};
        let contextChoices = [];
        function formatContextLimitShort(tokens) {
            if (!Number.isSafeInteger(tokens) || tokens < 1) return '待配置';
            if (tokens % 1048576 === 0) return (tokens / 1048576) + 'M';
            if (tokens % 1024 === 0) return (tokens / 1024) + 'K';
            if (tokens >= 1000000) return Number((tokens / 1000000).toFixed(2)) + 'M';
            if (tokens >= 1000) return Number((tokens / 1000).toFixed(1)) + 'K';
            return String(tokens);
        }
        window.MoonYaModelContext = {
            builtin: () => ({ ...BUILTIN_MODEL_METADATA[deepseekModelVersion], id: deepseekModelVersion }),
            key: () => contextModelKey,
            snapshot: () => ({ ...contextSelections }),
            restore(values) { contextSelections = values && typeof values === 'object' ? { ...values } : {}; },
            choices: () => contextChoices.slice(),
            value: () => contextLimitTokens,
            select(tokens) {
                if (!contextChoices.includes(tokens)) return;
                contextSelections[contextModelKey] = tokens;
                this.update(window.MoonYaModels?.selected() || this.builtin(), window.MoonYaModels?.reference());
                window.syncActiveConversationComposer?.();
            },
            update(model, reference) {
                const tokens = model?.context_window;
                const key = reference ? JSON.stringify([reference.provider_id, reference.model_id]) : 'builtin:' + deepseekModelVersion;
                const maximum = Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
                contextChoices = maximum ? [...new Set([...(model.context_window_options || []), maximum])].filter(value => Number.isSafeInteger(value) && value > 0 && value <= maximum).sort((a,b) => a-b) : [];
                const saved = contextSelections[key];
                const next = contextChoices.includes(saved) ? saved : maximum;
                if (maximum && saved !== undefined && saved !== next) window.showToast?.('已保存的上下文档位不可用，已切换至最大档位');
                if (maximum) contextSelections[key] = next;
                const changed = next !== contextLimitTokens || key !== contextModelKey;
                contextLimitTokens = next; contextModelKey = key;
                document.querySelectorAll('.context-model-length').forEach(el => {
                    window.MoonYaComposerSettings.contextPicker(el, contextChoices, next, formatContextLimitShort, value => this.select(value));
                    el.title = next ? next.toLocaleString('en-US') + ' tokens' : '请配置模型已确认的真实上下文长度';
                });
                if (changed) window.MoonYaContextRing?.refresh();
            },
            format: formatContextLimitShort
        };

        // ── 上下文圆环管理器 ──
        window.MoonYaContextRing = (function() {
            const RING_RADIUS = 7.5;
            const RING_CIRC = 2 * Math.PI * RING_RADIUS; // ≈47.12
            let baseUsedTokens = 0;   // 后端最近一次上报的占用（system + 历史，不含草稿）
            let baseLimit = contextLimitTokens;
            let refreshSeq = 0;
            let usageScope = null;
            let usageUnavailable = false;
            let lastBreakdown = null; // { system, tools, messages } 最近一次构成上报
            const runtimeUsageSeq = new Map();
            let statisticsPanel = null;

            function activeRuntimeSession() {
                const identity = localStorage.getItem('moonya_work_project_path') || '__default__';
                const chatId = activeChatId();
                const dbId = (typeof currentDbConversationId !== 'undefined') ? currentDbConversationId : null;
                const chat = getChatHistory().find(item => String(item.id) === String(chatId));
                return chat?.runtimeSessions?.[identity]
                    || localStorage.getItem('moonya.harness.session.' + String(chatId || dbId || 'draft') + '.' + encodeURIComponent(identity))
                    || localStorage.getItem('moonya.harness.session.' + String(dbId || chatId || 'draft') + '.' + encodeURIComponent(identity)) || '';
            }

            // 与 Services/ContextUsage.php 完全一致的启发式估算（前端镜像）
            function estimateTextTokens(text) {
                if (!text) return 0;
                let cjk = 0;
                for (const ch of String(text)) {
                    const c = ch.codePointAt(0);
                    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x4e00 && c <= 0x9fff)) cjk++;
                }
                const words = (String(text).match(/[a-zA-Z0-9_]+/g) || []).length;
                const remaining = Math.max(0, String(text).length - cjk - words * 3);
                return Math.max(1, Math.round(cjk + words * 1.3 + remaining * 0.25));
            }

            function activeChatId() {
                return (typeof currentChatId !== 'undefined') ? currentChatId : null;
            }

            function currentDraftText() {
                const input = document.querySelector('.message-input');
                return input && input.value ? input.value : '';
            }

            function draftTokens() {
                return estimateTextTokens(currentDraftText());
            }

            // 数据库不可用时（如部署库缺少 messages 表）的兜底：
            // 用 localStorage 里当前对话的消息估算占用，保证圆环有真实依据地动起来。
            function localConversationTokens() {
                try {
                    if (typeof getChatHistory !== 'function') return -1;
                    const history = getChatHistory();
                    const chat = (history || []).find(c => String(c.id) === String(activeChatId()));
                    if (!chat || !Array.isArray(chat.messages)) return 0;
                    let total = 0;
                    chat.messages.forEach(function(m) {
                        total += estimateTextTokens(m && m.content ? m.content : '');
                        if (m && m.thinking) total += estimateTextTokens(m.thinking);
                    });
                    return total;
                } catch (error) {
                    return -1;
                }
            }

            function formatK(tokens) {
                tokens = Math.max(0, Math.round(Number(tokens) || 0));
                if (tokens >= 1000) return Math.round(tokens / 1000) + 'k';
                return String(tokens);
            }

            // 面板数字格式：284.4K / 1000.0K（与截图一致，一位小数）
            function formatDecimalK(tokens) {
                tokens = Math.max(0, Number(tokens) || 0);
                if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'K';
                return String(Math.round(tokens));
            }

            function currentScope() {
                const projectPath = localStorage.getItem('moonya_work_project_path') || '';
                return (isAgentMode ? 'work:' : 'chat:') + String(activeChatId() || '') + ':' + projectPath + ':' + (window.MoonYaModelContext?.key() || '');
            }

            function clearForScope() {
                const scope = currentScope();
                if (usageScope === scope) return;
                usageScope = scope;
                statisticsPanel?.scopeChanged();
                usageUnavailable = false;
                baseUsedTokens = 0;
                lastBreakdown = null;
                showUnavailable('读取中', false);
            }

            function showUnavailable(message, unavailable) {
                usageUnavailable = unavailable !== false;
                const pct = document.getElementById('crtPercent');
                const nums = document.getElementById('crtNums');
                const wrap = document.getElementById('contextRingWrap');
                const fill = document.getElementById('contextRingFill');
                if (pct) pct.textContent = '—';
                if (nums) { nums.textContent = (message || '暂不可用') + ' / ' + (contextLimitTokens ? formatCompactTokens(contextLimitTokens) : '待配置'); nums.title = contextLimitTokens ? contextLimitTokens.toLocaleString('en-US') + ' tokens' : '请配置真实上下文长度'; }
                if (wrap) wrap.setAttribute('aria-label', '上下文用量' + (message || '暂不可用'));
                if (wrap) wrap.classList.remove('warn', 'full');
                if (fill) fill.style.strokeDashoffset = String(RING_CIRC);
                ['crtSystemPct', 'crtToolsPct', 'crtMessagesPct'].forEach(function(id) {
                    const el = document.getElementById(id);
                    if (el) el.textContent = '—';
                });
                ['crtSegSystem', 'crtSegTools', 'crtSegMessages'].forEach(function(id) {
                    const el = document.getElementById(id);
                    if (el) el.style.width = '0%';
                });
            }

            function render(used, limit, breakdown) {
                const fill = document.getElementById('contextRingFill');
                const wrap = document.getElementById('contextRingWrap');
                if (!fill || !wrap) return;
                const title = document.querySelector('.crt-title');
                if (title) title.textContent = '上下文已用';
                limit = Number(limit) || baseLimit;
                if (!limit) { showUnavailable('待配置'); return; }
                const actualPct = limit > 0 ? used / limit * 100 : 0;
                const pct = Math.min(100, actualPct);
                fill.style.strokeDashoffset = String(RING_CIRC * (1 - pct / 100));
                wrap.classList.toggle('warn', pct >= 70 && pct < 90);
                wrap.classList.toggle('full', pct >= 90);

                // ── 用量面板 ──
                const pctBig = document.getElementById('crtPercent');
                const nums = document.getElementById('crtNums');
                const pctLabel = used > 0 && actualPct < 1 ? '<1%' : Math.round(actualPct) + '%';
                if (pctBig) pctBig.textContent = pctLabel;
                if (nums) { nums.textContent = '~' + formatCompactTokens(used) + ' / ' + formatCompactTokens(limit); nums.title = Math.round(used).toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') + ' tokens'; }

                // 构成：系统提示词 / 工具及子智能体 / 对话消息；未分解部分（如草稿）并入对话消息
                const bd = (breakdown && typeof breakdown === 'object')
                    ? breakdown
                    : (lastBreakdown || { system: 0, tools: 0, messages: Math.max(0, used) });
                const bdSystem = Math.max(0, Number(bd.system) || 0);
                const bdTools = Math.max(0, Number(bd.tools) || 0);
                const bdMessages = Math.max(0, Number(bd.messages) || 0);
                const extra = Math.max(0, used - (bdSystem + bdTools + bdMessages));
                const segMessages = bdMessages + extra;
                document.querySelector('.crt-bar')?.classList?.toggle('crt-unknown', bd.messages == null);

                [['crtSegSystem', bdSystem], ['crtSegTools', bdTools], ['crtSegMessages', segMessages]]
                    .forEach(function(pair) {
                        const el = document.getElementById(pair[0]);
                        if (el) el.style.width = (limit > 0 ? Math.min(100, (pair[1] / limit) * 100) : 0) + '%';
                    });
                const contextNote = document.getElementById('crtContextNote');
                if (contextNote) contextNote.textContent = bd.partial ? (bd.messages == null ? '上下文构成暂不可用' : '部分上下文估算；缺失构成暂不可用') : '根据实际上下文估算';
                [['crtSystemPct', bd.system == null ? null : bdSystem], ['crtToolsPct', bd.tools == null ? null : bdTools], ['crtMessagesPct', bd.messages == null ? null : segMessages]]
                    .forEach(function(pair) {
                        const el = document.getElementById(pair[0]);
                        if (el) {
                            el.textContent = pair[1] === null ? '暂不可用' : '~' + formatCompactTokens(pair[1]);
                        }
                    });

                wrap.setAttribute('aria-label', '上下文使用情况 ' + pctLabel);
                document.getElementById('contextRingTrigger')?.setAttribute('aria-label', '查看会话详情，上下文已用 ' + pctLabel);
                statisticsPanel?.position();
            }

            function applyLocalEstimate() {
                const est = localConversationTokens();
                if (est < 0) return false; // localStorage 也不可用
                baseUsedTokens = est;
                usageUnavailable = false;
                lastBreakdown = { system: null, tools: null, messages: est, partial: true };
                render(baseUsedTokens + draftTokens(), baseLimit, lastBreakdown);
                return true;
            }

            async function refresh() {
                void statisticsPanel?.refresh();
                const seq = ++refreshSeq;
                baseLimit = contextLimitTokens;
                clearForScope();
                if (!baseLimit) { showUnavailable('待配置'); return; }
                const chatId = activeChatId();
                if (isAgentMode) {
                    const projectPath = localStorage.getItem('moonya_work_project_path') || '';
                    const identity = projectPath || '__default__';
                    const dbId = (typeof currentDbConversationId !== 'undefined') ? currentDbConversationId : null;
                    const sessionKey = 'moonya.harness.session.' + String(chatId || dbId || 'draft')
                        + '.' + encodeURIComponent(identity);
                    const legacySessionKey = 'moonya.harness.session.' + String(dbId || chatId || 'draft')
                        + '.' + encodeURIComponent(identity);
                    const chat = getChatHistory().find(item => String(item.id) === String(chatId));
                    const sessionId = chat?.runtimeSessions?.[identity] || localStorage.getItem(sessionKey) || localStorage.getItem(legacySessionKey) || '';
                    if (!sessionId) {
                        baseUsedTokens = 0;
                        lastBreakdown = null;
                        render(draftTokens(), baseLimit, { system: 0, tools: 0, messages: 0 });
                        return;
                    }
                    try {
                        let url = 'harness_api.php?action=context_usage&session_id=' + encodeURIComponent(sessionId)
                            + '&project_path=' + encodeURIComponent(projectPath);
                        const headers = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
                        const resp = await fetch(url, { headers: headers });
                        const result = await resp.json().catch(function() { return null; });
                        if (seq !== refreshSeq) return;
                        if (!resp.ok || !result || !result.success) {
                            showUnavailable();
                            return;
                        }
                        if (!result.data) {
                            baseUsedTokens = 0;
                            lastBreakdown = null;
                            render(draftTokens(), baseLimit, { system: 0, tools: 0, messages: 0 });
                            return;
                        }
                        if (!applyServerUsage(Object.assign({}, result.data, { _harness: true }))) applyLocalEstimate();
                        render(baseUsedTokens + draftTokens(), baseLimit, lastBreakdown);
                    } catch (error) {
                        if (seq === refreshSeq) showUnavailable();
                    }
                    return;
                }
                const dbId = (typeof currentDbConversationId !== 'undefined') ? currentDbConversationId : null;
                if (!dbId) {
                    if (!applyLocalEstimate()) {
                        baseUsedTokens = 0;
                        render(baseUsedTokens + draftTokens(), baseLimit);
                    }
                    return;
                }
                try {
                    let url = 'context_usage.php?conversation_id=' + encodeURIComponent(dbId)
                        + '&client_chat_id=' + encodeURIComponent(chatId)
                        + '&model_id=' + encodeURIComponent(window.MoonYaModelContext?.builtin().id || '')
                        + '&context_limit=' + encodeURIComponent(contextLimitTokens)
                        + (window.MoonYaModels?.reference() ? '&model_ref=' + encodeURIComponent(JSON.stringify(window.MoonYaModels.reference())) : '')
                        + '&draft=' + encodeURIComponent(currentDraftText().slice(0, 200000));
                    if (typeof addTokenToUrl === 'function') url = addTokenToUrl(url);
                    const headers = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
                    const resp = await fetch(url, { headers: headers });
                    const result = await resp.json().catch(function() { return null; });
                    if (!result || !result.success || !result.data) {
                        // 端点不可用或部署库缺少 messages 表 → localStorage 兜底
                        if (seq === refreshSeq && (!applyLocalEstimate() || baseUsedTokens === 0)) showUnavailable();
                        return;
                    }
                    if (seq !== refreshSeq || !matchesModel(result.data)) return; // 期间模型或会话已变化
                    baseUsedTokens = Math.max(0, Number(result.data.used_tokens || 0) - Number(result.data.draft_tokens || 0));
                    baseLimit = Number(result.data.limit) || contextLimitTokens;
                    lastBreakdown = {
                        system: Math.max(0, Number(result.data.system_tokens) || 0),
                        tools: Math.max(0, Number(result.data.tools_tokens) || 0),
                        messages: Math.max(0, Number(result.data.history_tokens) || 0),
                    };
                    render(baseUsedTokens + draftTokens(), baseLimit, lastBreakdown);
                } catch (error) {
                    if (seq === refreshSeq) showUnavailable();
                }
            }

            function matchesModel(data) {
                const active = window.MoonYaModels?.reference();
                const incoming = data.model_ref;
                if (active) {
                    if (!incoming || active.provider_id !== incoming.provider_id || active.model_id !== incoming.model_id) return false;
                } else if (incoming || (data.model_id && data.model_id !== window.MoonYaModelContext?.builtin().id)) return false;
                const limit = Number(data.limit ?? data.limit_tokens);
                return contextLimitTokens != null && limit === contextLimitTokens;
            }

            // api.php 在 done 前 / Harness 每步推送当前有效上下文的估算占用。
            function applyServerUsage(data) {
                if (!data || !matchesModel(data)) return false;
                if (data._chat_id != null && String(activeChatId()) !== String(data._chat_id)) return false;
                if (data._harness && data.session_id) {
                    if (!isAgentMode || String(activeRuntimeSession()) !== String(data.session_id)) return false;
                    const key = currentScope() + ':' + data.session_id;
                    const seq = Number(data.seq) || 0;
                    if (seq && seq < (runtimeUsageSeq.get(key) || 0)) return false;
                    if (seq) runtimeUsageSeq.set(key, seq);
                }
                ++refreshSeq;
                clearForScope();
                usageUnavailable = false;
                baseUsedTokens = Math.max(0, Number(data.used_tokens) || 0);
                baseLimit = Number(data.limit ?? data.limit_tokens);
                lastBreakdown = {
                    system: typeof data.system_tokens === 'number' ? Math.max(0, data.system_tokens) : null,
                    tools: typeof data.tools_tokens === 'number' ? Math.max(0, data.tools_tokens) : null,
                    messages: typeof data.messages_tokens === 'number' ? Math.max(0, data.messages_tokens) : null,
                    partial: [data.system_tokens, data.tools_tokens, data.messages_tokens].some(value => typeof value !== 'number'),
                };
                render(baseUsedTokens + draftTokens(), baseLimit, lastBreakdown);
                if (data.history_trimmed && typeof showToast === 'function') {
                    showToast('上下文接近上限，早期内容已自动压缩');
                }
                return true;
            }

            function formatCompactTokens(value) {
                value = Math.max(0, Math.round(Number(value) || 0));
                if (value >= 1000000) return String(Math.round(value / 100000) / 10) + 'M';
                if (value >= 1000) return String(Math.round(value / 100) / 10) + 'K';
                return String(value);
            }
            statisticsPanel = window.MoonYaStatisticsPanel?.create({
                chatId: activeChatId,
                chat: () => typeof getChatHistory === 'function' ? getChatHistory().find(chat => String(chat.id) === String(activeChatId())) : null,
                headers: () => typeof getAuthHeaders === 'function' ? getAuthHeaders() : {},
                sessionId: () => isAgentMode ? activeRuntimeSession() : '',
                mode: () => isAgentMode ? 'work' : 'chat',
                model: () => ({ id: window.MoonYaModels?.reference()?.model_id || window.MoonYaModelContext?.builtin().id,
                    reference: window.MoonYaModels?.reference(), limit: contextLimitTokens }),
                context: data => applyServerUsage(Object.assign({}, data, { _chat_id: activeChatId(), _harness: isAgentMode })),
                refreshContext: refresh,
                saveExpanded: values => {
                    if (typeof getChatHistory !== 'function' || typeof saveChatHistory !== 'function') return;
                    const history = getChatHistory(), chat = history.find(chat => String(chat.id) === String(activeChatId()));
                    if (chat) { chat.statisticsExpanded = values; void saveChatHistory(history); }
                }
            });

            // 打字时实时把草稿估算叠加到圆环（防抖）
            let draftTimer = null;
            document.addEventListener('input', function(e) {
                if (!e.target || !e.target.classList || !e.target.classList.contains('message-input')) return;
                clearTimeout(draftTimer);
                draftTimer = setTimeout(function() {
                    if (!usageUnavailable) render(baseUsedTokens + draftTokens(), baseLimit);
                }, 250);
            });

            render(0, contextLimitTokens);
            return { refresh: refresh, render: render, applyServerUsage: applyServerUsage,
                applyStatistics: (data, chatId) => statisticsPanel?.apply(data, chatId) };
        })();

        window.MoonYaModelContext.update(window.MoonYaModelContext.builtin());

        // 图片上传管理
<?php require __DIR__ . '/script-1f-work-project.php'; ?>
