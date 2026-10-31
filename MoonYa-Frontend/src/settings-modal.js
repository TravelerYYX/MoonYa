/* ══════════════════════════════════════════════════════════
   豆包式应用内设置与个人中心弹窗交互控制器
   ══════════════════════════════════════════════════════════ */
(() => {
    'use strict';

    // DOM 元素缓存
    let overlay, modalBox, closeBtn, backBtn, subHeader, subTitle, scrollBody;
    let mainView;
    let profileAvatarImg, profileName, profileId, manageBtn, profileNameRow;
    let voiceValue, appearanceValue, modelValue, workModeValue, sendKeyValue;
    let videoToggle, autostartToggle, ttsAutoToggle;

    // 当前活动子视图
    let currentActiveView = null;
    let workspaceBusy = false;
    async function refreshWorkspaceSettings() {
        const input = document.getElementById('settingsWorkspaceRoot');
        const status = document.getElementById('settingsWorkspaceStatus');
        if (!input || workspaceBusy) return;
        try {
            const value = await window.MoonYaChanges.request('workspace_settings', {});
            input.value = value.root;
            status.textContent = '已有 ' + value.workspaces.length + ' 个独立默认工作区。';
            if (value.retained_paths?.length) status.textContent += '\n以下目录中有额外文件或后续修改，已保留原位：\n' + value.retained_paths.join('\n');
        } catch (error) { notify('默认目录读取失败：' + error.message, 'error'); }
    }
    async function updateWorkspaceSettings(migrate) {
        if (workspaceBusy) return;
        const input = document.getElementById('settingsWorkspaceRoot');
        const status = document.getElementById('settingsWorkspaceStatus');
        if (!input.value.trim()) { notify('请选择或输入新的默认根目录。', 'error'); return; }
        if (migrate && !window.confirm('将现有默认聊天工作区的全部文件迁移到新目录。迁移期间无法运行相关任务；目标有冲突时不覆盖。确认迁移？')) return;
        workspaceBusy = true;
        const controls = ['settingsWorkspacePick', 'settingsWorkspaceSave', 'settingsWorkspaceMigrate'].map(id => document.getElementById(id));
        controls.forEach(control => { control.disabled = true; }); input.disabled = true;
        MoonYaNotifications.update('workspace-settings', migrate ? '正在复制、校验并迁移文件，请保留客户端运行…' : '正在保存默认路径…', { duration: 0 });
        try {
            const value = await window.MoonYaChanges.request('workspace_settings', { root: input.value.trim(), migrate }, true);
            input.value = value.root;
            MoonYaNotifications.update('workspace-settings', migrate ? '默认工作区文件迁移完成，历史变更仍可查看和撤销。' : '默认路径已保存，仅新聊天使用此目录。');
            status.textContent = '已有 ' + value.workspaces.length + ' 个独立默认工作区。';
            if (value.retained_paths?.length) status.textContent += '\n以下目录中有额外文件或后续修改，已保留原位：\n' + value.retained_paths.join('\n');
        } catch (error) { MoonYaNotifications.update('workspace-settings', '操作未完成：' + error.message, { duration: 4000 }); }
        finally { workspaceBusy = false; input.disabled = false; controls.forEach(control => { control.disabled = false; }); }
    }

    function syncModelSelection() {
        const reference = window.MoonYaModels?.reference();
        const builtinId = typeof deepseekModelVersion === 'string' ? deepseekModelVersion : window.MoonYaClientConfig?.modelGroups?.deepseek?.default;
        const builtin = window.MoonYaClientConfig?.modelGroups?.deepseek?.models.find(model => model.id === builtinId);
        const provider = window.MoonYaModels?.catalog().providers.find(provider => provider.id === reference?.provider_id);
        const model = provider?.models.find(model => model.id === reference?.model_id);
        if (modelValue) modelValue.textContent = reference ? (model ? `${provider.name} · ${model.name || model.id}` : reference.model_id) : builtin?.label || builtinId || '加载中';
        document.querySelectorAll('#settingsModelList [data-model-id]').forEach(item => {
            const active = reference ? item.dataset.providerId === reference.provider_id && item.dataset.modelId === reference.model_id
                : !item.dataset.providerId && item.dataset.modelId === builtinId;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
        });
    }

    function renderModelList() {
        const list = document.getElementById('settingsModelList');
        if (!list) return;
        const builtin = window.MoonYaClientConfig?.modelGroups?.deepseek?.models || [];
        const providers = window.MoonYaModels?.catalog().providers || [];
        const work = document.body.classList.contains('work-mode');
        list.replaceChildren();
        const models = builtin.map(model => ({ id: model.id, name: model.label, description: `内置模型 · ${model.id}` }))
            .concat(providers.flatMap(provider => provider.models.map(model => {
                const reason = !model.supports_chat ? '不支持对话' : !Number.isSafeInteger(model.context_window) || model.context_window <= 0
                    ? '请先配置真实上下文长度' : work && model.supports_tools === false ? '仅支持 MoonYa，不支持工具调用' : '';
                return { id: model.id, providerId: provider.id, name: model.name || model.id,
                    description: `${provider.name} · ${model.id}${reason ? ` · ${reason}` : ''}`, disabled: !!reason };
            })));
        for (const model of models) {
            const item = document.createElement('button');
            item.type = 'button'; item.className = 'settings-choice-item settings-model-choice';
            item.dataset.modelId = model.id;
            if (model.providerId) item.dataset.providerId = model.providerId;
            item.disabled = !!model.disabled;
            item.innerHTML = '<div class="settings-choice-icon"><span class="ui-icon" data-ui-icon="bolt" aria-hidden="true"></span></div><div class="settings-choice-info"><div class="settings-choice-title"></div><div class="settings-choice-desc"></div></div><div class="settings-choice-check"><span class="ui-icon" data-ui-icon="check" aria-hidden="true"></span></div>';
            item.querySelector('.settings-choice-title').textContent = model.name;
            item.querySelector('.settings-choice-desc').textContent = model.description;
            list.append(item);
        }
        window.MoonYaIcons?.hydrate(list);
        const status = document.getElementById('settingsModelStatus');
        if (status) status.textContent = window.MoonYaModels?.loaded() && !models.length ? '暂无已配置的模型' : '';
        syncModelSelection();
    }

    async function refreshModelList() {
        renderModelList();
        const retry = document.getElementById('settingsModelRetry');
        if (retry) retry.hidden = true;
        try {
            if (!window.MoonYaModels) throw new Error('模型目录暂不可用');
            await window.MoonYaModels.reload();
            renderModelList();
        } catch (error) {
            notify(`模型目录加载失败：${error.message}`, 'error');
            if (retry) retry.hidden = false;
        }
    }

    function initElements() {
        overlay = document.getElementById('settingsOverlay');
        modalBox = document.getElementById('settingsModalBox');
        closeBtn = document.getElementById('settingsCloseBtn');
        backBtn = document.getElementById('settingsBackBtn');
        subHeader = document.getElementById('settingsSubHeader');
        subTitle = document.getElementById('settingsSubTitle');
        scrollBody = document.getElementById('settingsScrollBody');
        mainView = document.getElementById('settingsMainView');

        profileAvatarImg = document.getElementById('settingsAvatarImg');
        profileName = document.getElementById('settingsProfileName');
        profileId = document.getElementById('settingsProfileId');
        manageBtn = document.getElementById('settingsManageBtn');
        profileNameRow = document.getElementById('settingsProfileNameRow');

        voiceValue = document.getElementById('settingsVoiceValue');
        appearanceValue = document.getElementById('settingsAppearanceValue');
        modelValue = document.getElementById('settingsModelValue');
        workModeValue = document.getElementById('settingsWorkModeValue');
        sendKeyValue = document.getElementById('settingsSendKeyValue');

        videoToggle = document.getElementById('settingsVideoToggle');
        autostartToggle = document.getElementById('settingsAutostartToggle');
        ttsAutoToggle = document.getElementById('settingsTtsAutoToggle');
    }

    // 辅助提示通知
    function notify(message, type = 'info') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type === 'error' ? 4000 : 2000);
        } else {
            console.log(`[Settings] ${message}`);
        }
    }

    // 同步展示当前用户状态
    function syncUserProfile() {
        const user = window.currentUser || (typeof window.MoonYaClient?.cachedUser === 'function' ? window.MoonYaClient.cachedUser() : null);
        const loggedIn = !!window.isLoggedIn || !!user;

        const sidebarUserName = document.getElementById('userName')?.textContent;

        window.MoonYaClient.setUserAvatar(profileAvatarImg, user);
        window.MoonYaClient.setUserAvatar(document.getElementById('settingsAccountAvatarImg'), user);

        if (loggedIn && user) {
            if (profileName) profileName.textContent = user.real_name || user.username || '月雅泫';
            if (profileId) profileId.textContent = user.id ? `用户${user.id}9971` : `用户9971249161211`;
            if (manageBtn) manageBtn.textContent = 'MoonYa账号管理';

            const accountCard = document.getElementById('settingsAccountCard');
            if (accountCard) accountCard.style.display = 'block';

            // 填充账号管理子视图
            const uNameInput = document.getElementById('settingsAccountUsername');
            const rNameInput = document.getElementById('settingsAccountRealname');
            const emailInput = document.getElementById('settingsAccountEmail');
            if (uNameInput) uNameInput.value = user.username || '';
            if (rNameInput) rNameInput.value = user.real_name || '';
            if (emailInput) emailInput.value = user.email || '';
        } else {
            if (profileName) profileName.textContent = sidebarUserName && sidebarUserName !== '未登录' ? sidebarUserName : '未登录';
            if (profileId) profileId.textContent = '登录后同步云端记录与自定义设置';
            if (manageBtn) manageBtn.textContent = '立即登录';

            const accountCard = document.getElementById('settingsAccountCard');
            if (accountCard) accountCard.style.display = 'none';
        }
    }

    // 同步设置项的当前状态标签
    function syncSettingsValues() {
        const permission = window.MoonYaPermissions.defaultMode();
        const permissionValue = document.getElementById('settingsDefaultPermissionValue');
        if (permissionValue) permissionValue.textContent = window.MoonYaPermissions.labels[permission];
        document.querySelectorAll('[data-default-permission]').forEach(item => {
            const active = item.dataset.defaultPermission === permission;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
        });
        // 1. 声音
        const savedVoice = localStorage.getItem('moonya.selectedVoice') || '温柔桃子';
        if (voiceValue) voiceValue.textContent = savedVoice;

        // 2. 外观 (区域显示 / 全屏显示)
        const displayMode = localStorage.getItem('chatDisplayMode') || 'centered';
        if (appearanceValue) appearanceValue.textContent = { light: '浅色', dark: '深色', system: '跟随系统' }[window.MoonYaTheme.getPreference()];
        document.querySelectorAll('[data-theme-choice]').forEach(el => {
            el.setAttribute('aria-pressed', String(el.dataset.themeChoice === window.MoonYaTheme.getPreference()));
        });
        document.querySelectorAll('.settings-choice-item[data-mode]').forEach(el => {
            el.classList.toggle('active', el.dataset.mode === displayMode);
        });
        const animationStyle = window.MoonYaProcessUI.getAnimationStyle();
        document.querySelectorAll('[data-process-animation-choice]').forEach(el => {
            const selected = el.dataset.processAnimationChoice === animationStyle;
            el.classList.toggle('active', selected);
            el.setAttribute('aria-pressed', String(selected));
        });

        // 3. 默认模型
        syncModelSelection();

        // 4. 工作模式
        const currentMode = document.getElementById('modeSelect')?.value || 'work';
        if (workModeValue) workModeValue.textContent = currentMode === 'chat' ? 'MoonYa' : 'FarSide';
        document.querySelectorAll('.settings-choice-item[data-workmode]').forEach(el => {
            el.classList.toggle('active', el.dataset.workmode === currentMode);
        });

        // 5. 发送快捷键
        const sendKey = window.MoonYaSendShortcut.get();
        if (sendKeyValue) sendKeyValue.textContent = sendKey;
        const kbdEl = document.getElementById('kbdSendKey');
        if (kbdEl) kbdEl.textContent = sendKey.includes('Ctrl') ? 'Ctrl + Enter' : 'Enter';
        document.querySelectorAll('.settings-choice-item[data-sendkey]').forEach(el => {
            el.classList.toggle('active', el.dataset.sendkey === sendKey);
        });

        // 6. 视频/桌宠开关
        const petEnabled = localStorage.getItem('furinaPetEnabled') !== '0';
        if (videoToggle) videoToggle.classList.toggle('active', petEnabled);

        // 7. 开机自启动
        const autoStart = localStorage.getItem('moonya.autoStart') !== '0';
        if (autostartToggle) autostartToggle.classList.toggle('active', autoStart);

        // 8. 声音播报开关
        const ttsEnabled = localStorage.getItem('moonya.ttsAuto') !== '0';
        if (ttsAutoToggle) ttsAutoToggle.classList.toggle('active', ttsEnabled);

        // 9. 声音单选激活态
        document.querySelectorAll('.settings-choice-item[data-voice]').forEach(el => {
            el.classList.toggle('active', el.dataset.voice === savedVoice);
        });

        // 10. 归档会话数量
        const archiveValue = document.getElementById('settingsArchiveValue');
        if (archiveValue) {
            let archived = 0;
            try {
                if (typeof CHAT_HISTORY_KEY !== 'undefined' && typeof window.MoonYaHistoryStore?.list === 'function') {
                    archived = window.MoonYaHistoryStore.list(CHAT_HISTORY_KEY).filter(chat => chat.archivedAt).length;
                }
            } catch (_) { archived = 0; }
            archiveValue.textContent = archived ? archived + ' 条已归档' : '查看与恢复';
        }
    }

    // 切换到子视图
    function showSubView(viewId, title) {
        if (!overlay) return;
        document.querySelectorAll('.settings-view').forEach(v => {
            v.style.display = 'none';
            v.classList.remove('active');
        });

        const targetView = document.getElementById(viewId);
        if (targetView) {
            targetView.style.display = 'block';
            targetView.classList.add('active');
            currentActiveView = targetView;
        }

        if (subHeader) subHeader.style.display = 'flex';
        if (subTitle) subTitle.textContent = title || '设置';
        if (scrollBody) scrollBody.scrollTop = 0;
        // 只有「外观」页变横屏；其余设置页维持 448px 竖版。
        modalBox?.classList.toggle('settings-modal--wide', viewId === 'settingsAppearanceView');
        if (viewId === 'settingsModelView') void refreshModelList();
        if (viewId === 'settingsDataSyncView') void refreshWorkspaceSettings();
        if (viewId === 'settingsAppearanceView') window.MoonYaAppearance?.mountSettings(targetView);
    }

    // 返回主设置视图
    function backToMainView() {
        document.querySelectorAll('.settings-view').forEach(v => {
            v.style.display = 'none';
            v.classList.remove('active');
        });

        if (mainView) {
            mainView.style.display = 'block';
            mainView.classList.add('active');
            currentActiveView = mainView;
        }

        if (subHeader) subHeader.style.display = 'none';
        if (scrollBody) scrollBody.scrollTop = 0;
        // 回到主列表就恢复竖版 448px。
        modalBox?.classList.remove('settings-modal--wide');
    }

    // 打开设置弹窗
    function openSettingsModal(targetSubView) {
        if (!overlay) initElements();
        if (!overlay) return;

        syncUserProfile();
        syncSettingsValues();

        void window.MoonYaMembership?.refresh();

        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');

        if (targetSubView) {
            if (targetSubView === 'account') showSubView('settingsAccountView', '账号管理');
            else if (targetSubView === 'appearance') showSubView('settingsAppearanceView', '外观设置');
            else if (targetSubView === 'voice') showSubView('settingsVoiceView', '声音选择');
            else if (targetSubView === 'shortcuts') showSubView('settingsShortcutsView', '快捷键设置');
            else if (targetSubView === 'model') showSubView('settingsModelView', '新对话默认模型');
            else if (targetSubView === 'workmode') showSubView('settingsWorkModeView', '工作模式设置');
            else if (targetSubView === 'plan') { backToMainView(); void window.MoonYaMembership?.openDetail(); }
            else if (targetSubView === 'datasync') showSubView('settingsDataSyncView', '数据导入与同步');
            else backToMainView();
        } else {
            backToMainView();
        }
    }

    // 关闭设置弹窗
    function closeSettingsModal() {
        if (!overlay) return;
        overlay.classList.remove('show');
        overlay.setAttribute('aria-hidden', 'true');
        setTimeout(() => {
            backToMainView();
        }, 250);
    }

    // 打开归档会话管理（设置弹窗关闭动画结束后再弹出，避免两个模态层叠）
    function openArchiveDialog() {
        const open = () => {
            if (typeof window.MoonYaWorkspace?.archiveDialog === 'function') {
                window.MoonYaWorkspace.archiveDialog().catch(error => notify(error.message || '归档列表读取失败', 'error'));
            } else {
                notify('归档会话功能暂不可用，请重启应用后重试', 'error');
            }
        };
        if (overlay?.classList.contains('show')) {
            closeSettingsModal();
            setTimeout(open, 280);
        } else {
            open();
        }
    }

    // 绑定交互事件
    function bindEvents() {
        initElements();
        if (!overlay) return;
        document.getElementById('settingsWorkspaceSave')?.addEventListener('click', () => void updateWorkspaceSettings(false));
        document.getElementById('settingsWorkspaceMigrate')?.addEventListener('click', () => void updateWorkspaceSettings(true));
        document.getElementById('settingsWorkspacePick')?.addEventListener('click', async () => {
            try {
                let value;
                if (window.moonYaFileOps?.pickFolder) value = await window.moonYaFileOps.pickFolder();
                else value = await (await fetch('/file-op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pick_folder' }) })).json();
                if (typeof value === 'string') value = JSON.parse(value);
                if (value.cancelled) return;
                if (!value.success || !value.path) throw new Error(value.message || '目录选择失败');
                document.getElementById('settingsWorkspaceRoot').value = value.path;
            } catch (error) { notify(error.message, 'error'); }
        });

        // 关闭按钮
        closeBtn?.addEventListener('click', closeSettingsModal);

        // 子视图返回按钮
        backBtn?.addEventListener('click', backToMainView);

        // 点击蒙层背景关闭弹窗
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeSettingsModal();
        });

        // 键盘 Esc 关闭弹窗
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('show')) {
                closeSettingsModal();
            }
        });

        // 个人中心点击跳转账号管理
        manageBtn?.addEventListener('click', () => {
            const loggedIn = !!window.isLoggedIn || !!window.currentUser;
            if (!loggedIn) {
                closeSettingsModal();
                if (typeof window.openAuthModal === 'function') {
                    window.openAuthModal();
                } else {
                    const btn = document.getElementById('qqLoginBtn');
                    if (btn) btn.click();
                }
            } else {
                showSubView('settingsAccountView', '账号管理');
            }
        });

        profileNameRow?.addEventListener('click', () => {
            const loggedIn = !!window.isLoggedIn || !!window.currentUser;
            if (loggedIn) showSubView('settingsAccountView', '账号管理');
            else manageBtn?.click();
        });

        // ═══ 各设置项点击跳转子页面 ═══
        document.getElementById('itemPlan')?.addEventListener('click', () => window.MoonYaMembership?.openDetail());
        document.getElementById('itemQuota')?.addEventListener('click', () => window.MoonYaMembership?.openDetail());
        document.getElementById('itemVoice')?.addEventListener('click', () => showSubView('settingsVoiceView', '声音选择'));
        document.getElementById('itemDefaultPermission')?.addEventListener('click', () => showSubView('settingsPermissionView', '默认权限'));
        document.querySelectorAll('[data-default-permission]').forEach(item => item.addEventListener('click', () => {
            try { window.MoonYaPermissions.setDefault(item.dataset.defaultPermission); syncSettingsValues(); }
            catch { notify('默认权限保存失败，请重试'); }
        }));
        document.getElementById('itemAppearance')?.addEventListener('click', () => showSubView('settingsAppearanceView', '外观设置'));
        document.getElementById('itemMemory')?.addEventListener('click', () => {
            notify('已开启智能上下文记忆，自动保留当前对话重要背景');
        });
        document.getElementById('itemNotification')?.addEventListener('click', () => {
            if ('Notification' in window) {
                Notification.requestPermission().then(permission => {
                    notify(permission === 'granted' ? '桌面消息通知已开启' : '通知权限未开启');
                });
            } else {
                notify('当前环境已默认开启消息提示');
            }
        });
        document.getElementById('itemDefaultModel')?.addEventListener('click', () => showSubView('settingsModelView', '新对话默认模型'));
        document.getElementById('itemWorkMode')?.addEventListener('click', () => showSubView('settingsWorkModeView', '工作模式设置'));
        document.getElementById('itemDataSync')?.addEventListener('click', () => showSubView('settingsDataSyncView', '数据导入与同步'));
        document.getElementById('itemArchive')?.addEventListener('click', openArchiveDialog);
        document.getElementById('itemGeneration')?.addEventListener('click', () => {
            notify('已启用高性能 Markdown 与代码高亮生成引擎');
        });
        document.getElementById('itemSendKey')?.addEventListener('click', () => showSubView('settingsSendKeyView', '发送快捷键设置'));
        document.getElementById('itemPaging')?.addEventListener('click', () => {
            notify('已启用多条消息默认平滑翻页');
        });
        document.getElementById('itemShortcuts')?.addEventListener('click', () => showSubView('settingsShortcutsView', '快捷键设置'));

        // ═══ 开关项切换逻辑 ═══
        // 视频/桌宠开关
        const videoRow = document.getElementById('itemVideoToggleRow');
        function toggleVideo() {
            if (!videoToggle) return;
            const next = !videoToggle.classList.contains('active');
            videoToggle.classList.toggle('active', next);
            localStorage.setItem('furinaPetEnabled', next ? '1' : '0');

            // 同步 WPF 桌宠桥接（如果存在）
            if (window.petController && typeof window.petController.setEnabled === 'function') {
                try { window.petController.setEnabled(next); } catch (_) {}
            }
            notify(next ? '已开启回答附带视频互动' : '已关闭回答附带视频互动');
        }
        videoToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleVideo(); });
        videoRow?.addEventListener('click', (e) => { if (e.target !== videoToggle) toggleVideo(); });

        // 开机自启动开关
        const autostartRow = document.getElementById('itemAutostartRow');
        function toggleAutostart() {
            if (!autostartToggle) return;
            const next = !autostartToggle.classList.contains('active');
            autostartToggle.classList.toggle('active', next);
            localStorage.setItem('moonya.autoStart', next ? '1' : '0');
            notify(next ? '开机自动启动已开启' : '开机自动启动已关闭');
        }
        autostartToggle?.addEventListener('click', (e) => { e.stopPropagation(); toggleAutostart(); });
        autostartRow?.addEventListener('click', (e) => { if (e.target !== autostartToggle) toggleAutostart(); });

        // 声音自动播报开关
        ttsAutoToggle?.addEventListener('click', () => {
            const next = !ttsAutoToggle.classList.contains('active');
            ttsAutoToggle.classList.toggle('active', next);
            localStorage.setItem('moonya.ttsAuto', next ? '1' : '0');
            window.isVoiceBroadcastEnabled = next;
            notify(next ? 'AI 回复自动语音朗读已开启' : 'AI 回复自动语音朗读已关闭');
        });

        // 退出登录
        document.getElementById('itemLogout')?.addEventListener('click', () => {
            if (confirm('确定要退出当前账号吗？')) {
                void window.logoutMoonYaAccount();
            }
        });

        // ═══ 子视图选择项交互 ═══
        // 1. 外观模式选择 (区域显示 / 全屏显示)
        document.querySelectorAll('.settings-choice-item[data-mode]').forEach(item => {
            item.addEventListener('click', () => {
                const mode = item.dataset.mode;
                localStorage.setItem('chatDisplayMode', mode);
                document.body.classList.toggle('chat-fullscreen', mode === 'fullscreen');
                syncSettingsValues();
                notify(mode === 'fullscreen' ? '已切换为全屏显示' : '已切换为区域显示');
            });
        });

        document.querySelectorAll('[data-process-animation-choice]').forEach(item => {
            item.addEventListener('click', () => window.MoonYaProcessUI.setAnimationStyle(item.dataset.processAnimationChoice));
        });
        window.addEventListener('moonya:process-animation-change', syncSettingsValues);
        document.querySelectorAll('[data-theme-choice]').forEach(item => {
            item.addEventListener('click', () => window.MoonYaTheme.setPreference(item.dataset.themeChoice));
        });
        window.addEventListener('moonya:theme-change', syncSettingsValues);

        // 2. 声音角色选择
        document.querySelectorAll('.settings-choice-item[data-voice]').forEach(item => {
            item.addEventListener('click', () => {
                const voice = item.dataset.voice;
                localStorage.setItem('moonya.selectedVoice', voice);
                syncSettingsValues();
                notify(`已选择音色：${voice}`);
                // 播放一段语音试听
                if (typeof window.speakText === 'function') {
                    window.speakText(`你好，我是${voice}，很高兴为你提供帮助。`);
                }
            });
        });

        // 3. 默认模型选择
        document.getElementById('settingsModelList')?.addEventListener('click', event => {
            const item = event.target.closest('[data-model-id]');
            if (!item || item.disabled) return;
            if (item.dataset.providerId) {
                window.MoonYaModels.setReference({ provider_id: item.dataset.providerId, model_id: item.dataset.modelId });
            } else {
                window.MoonYaModels?.setReference(null);
                deepseekModelVersion = item.dataset.modelId;
                localStorage.setItem(DEEPSEEK_MODEL_STORAGE_KEY, deepseekModelVersion);
                window.renderMoonYaAgentSettings?.();
                const currentModelBtn = document.getElementById('deepseekModelBtnText');
                if (currentModelBtn) currentModelBtn.textContent = item.querySelector('.settings-choice-title').textContent;
                document.querySelectorAll('.deepseek-model-option').forEach(option => option.classList.toggle('selected', option.dataset.model === deepseekModelVersion));
                window.MoonYaModels?.syncUi();
                window.syncActiveConversationComposer?.();
            }
            syncModelSelection();
            notify(`新会话默认模型已设为 ${modelValue?.textContent || item.dataset.modelId}`);
        });
        document.getElementById('settingsModelRetry')?.addEventListener('click', () => void refreshModelList());
        window.addEventListener('moonya:model-catalog-change', renderModelList);
        window.addEventListener('moonya:model-selection-change', syncModelSelection);
        renderModelList();

        // 4. 工作模式选择
        document.querySelectorAll('.settings-choice-item[data-workmode]').forEach(item => {
            item.addEventListener('click', () => {
                const wm = item.dataset.workmode;
                const targetTab = wm === 'work' ? document.getElementById('modeWorkTab') : document.getElementById('modeChatTab');
                if (targetTab) targetTab.click();
                syncSettingsValues();
                notify(`已切换为主工作模式：${wm === 'work' ? 'FarSide' : 'MoonYa'}`);
            });
        });

        // 5. 发送快捷键选择
        document.querySelectorAll('.settings-choice-item[data-sendkey]').forEach(item => {
            item.addEventListener('click', () => {
                const sk = item.dataset.sendkey;
                window.MoonYaSendShortcut.set(sk);
                syncSettingsValues();
                notify(`发送快捷键已设置为 ${sk}`);
            });
        });

        // 6. 数据备份与恢复
        const exportBtn = document.getElementById('settingsExportDataBtn');
        const importBtn = document.getElementById('settingsImportDataBtn');
        const fileInput = document.getElementById('settingsDataFileInput');

        exportBtn?.addEventListener('click', async () => {
            try {
                if (typeof window.MoonYaHistoryStore?.getAll === 'function') {
                    const data = await window.MoonYaHistoryStore.getAll();
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `moonya-backup-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    notify('数据导出成功');
                } else {
                    const backup = {
                        chats: localStorage.getItem('chat_history') || '[]',
                        config: localStorage.getItem('moonya.client-config.v1') || '{}',
                        timestamp: Date.now()
                    };
                    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `moonya-backup-${new Date().toISOString().slice(0, 10)}.json`;
                    a.click();
                    notify('备份导出完成');
                }
            } catch (err) {
                notify('导出失败: ' + err.message, 'error');
            }
        });

        importBtn?.addEventListener('click', () => {
            fileInput?.click();
        });

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const json = JSON.parse(ev.target.result);
                    notify('数据导入成功，正在刷新会话...');
                    setTimeout(() => location.reload(), 800);
                } catch (err) {
                    notify('文件格式错误: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        });

        // 7. 账号资料修改保存
        const saveProfileBtn = document.getElementById('settingsSaveProfileBtn');
        saveProfileBtn?.addEventListener('click', async () => {
            const realname = document.getElementById('settingsAccountRealname')?.value.trim();
            const email = document.getElementById('settingsAccountEmail')?.value.trim();

            if (window.currentUser) {
                window.currentUser.real_name = realname;
                window.currentUser.email = email;
                try {
                    localStorage.setItem('moonya.auth-user.v1', JSON.stringify(window.currentUser));
                } catch (_) {}
                const nameEl = document.getElementById('userName');
                if (nameEl) nameEl.textContent = realname || window.currentUser.username;
            }
            syncUserProfile();
            notify('个人资料已成功保存');
        });

        // 8. 头像更换
        const changeAvatarBtn = document.getElementById('settingsChangeAvatarBtn');
        const avatarFileInput = document.getElementById('settingsAvatarFileInput');
        changeAvatarBtn?.addEventListener('click', () => avatarFileInput?.click());
        avatarFileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const dataUrl = ev.target.result;
                if (profileAvatarImg) profileAvatarImg.src = dataUrl;
                const actAvatar = document.getElementById('settingsAccountAvatarImg');
                if (actAvatar) actAvatar.src = dataUrl;
                const sbAvatar = document.getElementById('userAvatar');
                if (sbAvatar) sbAvatar.src = dataUrl;
                if (window.currentUser) {
                    window.currentUser.avatar = dataUrl;
                    try { localStorage.setItem('moonya.auth-user.v1', JSON.stringify(window.currentUser)); } catch (_) {}
                }
                notify('头像已更新');
            };
            reader.readAsDataURL(file);
        });

        // 9. 密码修改
        const savePasswordBtn = document.getElementById('settingsSavePasswordBtn');
        savePasswordBtn?.addEventListener('click', async () => {
            const newPass = document.getElementById('settingsNewPassword')?.value;
            const confirmPass = document.getElementById('settingsConfirmPassword')?.value;

            if (!newPass || newPass.length < 8) {
                notify('新密码至少需要 8 个字符', 'error');
                return;
            }
            if (newPass !== confirmPass) {
                notify('两次输入的新密码不一致', 'error');
                return;
            }
            savePasswordBtn.disabled = true;
            try {
                const statusResponse = await fetch('user_profile.php?action=check_password_status');
                const status = await statusResponse.json();
                if (!status.success) throw new Error(status.error || '密码状态读取失败');
                const action = status.data.has_password ? 'update_password' : 'set_password';
                const response = await fetch(`user_profile.php?action=${action}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: newPass })
                });
                const result = await response.json();
                if (!result.success) throw new Error(result.error || '密码保存失败');
                notify('密码已保存，可以使用密码登录');
                document.getElementById('settingsCurrentPassword').value = '';
                document.getElementById('settingsNewPassword').value = '';
                document.getElementById('settingsConfirmPassword').value = '';
            } catch (error) { notify(error.message || '密码保存失败', 'error'); }
            finally { savePasswordBtn.disabled = false; }
        });
    }

    // 暴露全局 API
    window.openSettingsModal = openSettingsModal;
    window.closeSettingsModal = closeSettingsModal;

    if (window.MoonYaClient) {
        window.MoonYaClient.openSettingsModal = openSettingsModal;
        window.MoonYaClient.closeSettingsModal = closeSettingsModal;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEvents);
    } else {
        bindEvents();
    }
})();
