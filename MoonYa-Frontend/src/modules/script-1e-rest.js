// 中断控制器
        let currentAbortController = null;

        let browserSecurityDialogQueue = Promise.resolve();
        let browserSecurityAuthorizeRoute = '';
        const browserPermissionEndpoint = '/api/browser_permissions.php';

        function isMoonYaDesktopRuntime() {
            return navigator.userAgent.indexOf('MoonYaDesktop') !== -1;
        }

        function launcherRequiredToolResult() {
            return {
                success: false,
                error_code: 'moonya_launcher_required',
                message: '当前为网页访问，无法调用本地工具。请使用 MoonYa 启动器后重试。',
                requires_launcher: true
            };
        }

        function browserPermissionRequest(payload, method) {
            const requestMethod = method || 'POST';
            const options = { method: requestMethod, headers: { 'Content-Type': 'application/json' } };
            let target = browserPermissionEndpoint;
            if (requestMethod === 'GET') {
                target += '?' + new URLSearchParams(payload || {}).toString();
            } else {
                options.body = JSON.stringify(payload || {});
            }
            return fetch(target, options).then(function(response) {
                return response.json().then(function(result) {
                    if (!response.ok || !result || !result.success) {
                        throw new Error(result && result.error ? result.error : '浏览器权限服务请求失败');
                    }
                    return result;
                });
            });
        }

        function postBrowserSecurityDecision(route, payload) {
            return fetch(route, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload || {})
            }).then(function(response) { return response.json(); });
        }

        function renderBrowserPermissionManager() {
            const panel = document.getElementById('browserSecurityPermissions');
            const list = document.getElementById('browserSecurityPermissionList');
            if (!panel || !list) return Promise.resolve();
            panel.hidden = false;
            list.textContent = '正在读取权限…';
            return browserPermissionRequest({ operation: 'list' }, 'GET')
                .then(function(result) {
                    list.textContent = '';
                    const permissions = Array.isArray(result.permissions) ? result.permissions : [];
                    if (!permissions.length) {
                        list.textContent = '没有已保存的站点权限。';
                        return;
                    }
                    permissions.forEach(function(permission) {
                        const row = document.createElement('div');
                        row.className = 'browser-security-permission-row';
                        const domain = document.createElement('span');
                        const permissionDomain = permission.host || permission.domain || '';
                        domain.textContent = (permission.scheme || '') + '://' + permissionDomain
                            + (Number(permission.port || 0) > 0 ? ':' + permission.port : '')
                            + ' · ' + (permission.decision === 'block' ? '已阻止' : '始终允许');
                        const revoke = document.createElement('button');
                        revoke.type = 'button';
                        revoke.textContent = '撤销';
                        revoke.addEventListener('click', function() {
                            browserPermissionRequest({
                                operation: 'revoke',
                                scheme: permission.scheme || '',
                                host: permissionDomain,
                                port: Number(permission.port || 0)
                            }).then(function() {
                                if (!browserSecurityAuthorizeRoute || !currentUser || !currentUser.id) return null;
                                return postBrowserSecurityDecision(browserSecurityAuthorizeRoute, {
                                    operation: 'revoke_permission',
                                    domain: permissionDomain,
                                    user_context: String(currentUser.id)
                                });
                            }).then(renderBrowserPermissionManager);
                        });
                        row.append(domain, revoke);
                        list.appendChild(row);
                    });
                });
        }

        function showBrowserSecurityChallenge(challenge) {
            browserSecurityDialogQueue = browserSecurityDialogQueue.then(function() {
                return new Promise(function(resolve) {
                    const overlay = document.getElementById('browserSecurityOverlay');
                    const title = document.getElementById('browserSecurityTitle');
                    const description = document.getElementById('browserSecurityDescription');
                    const facts = document.getElementById('browserSecurityFacts');
                    const actions = document.getElementById('browserSecurityActions');
                    const permissions = document.getElementById('browserSecurityPermissions');
                    if (!overlay || !title || !description || !facts || !actions) {
                        resolve('deny');
                        return;
                    }

                    browserSecurityAuthorizeRoute = challenge.authorize_route || '';
                    permissions.hidden = true;
                    facts.textContent = '';
                    actions.textContent = '';
                    const kind = challenge.approval_kind || '';
                    title.textContent = kind === 'site' ? '允许访问此站点？'
                        : (kind === 'tls' ? '证书安全确认' : '确认敏感浏览器操作');
                    description.textContent = challenge.reason || '继续前需要你的确认。';
                    [
                        ['站点', challenge.domain],
                        ['地址', challenge.url],
                        ['操作', challenge.action],
                        ['风险类型', challenge.risk_category],
                        ['页面版本', challenge.page_version],
                        ['证书指纹', challenge.certificate_fingerprint]
                    ].forEach(function(entry) {
                        if (entry[1] === undefined || entry[1] === null || entry[1] === '') return;
                        const dt = document.createElement('dt');
                        const dd = document.createElement('dd');
                        dt.textContent = entry[0];
                        dd.textContent = String(entry[1]);
                        facts.append(dt, dd);
                    });

                    const choices = kind === 'site'
                        ? [['block', '阻止'], ['allow_once', '仅本次允许'], ['allow_always', '始终允许']]
                        : (kind === 'tls'
                            ? [['deny', '返回'], ['allow_once', '继续访问']]
                            : [['deny', '取消'], ['allow_once', '确认执行']]);
                    let settled = false;
                    function finish(decision) {
                        if (settled) return;
                        settled = true;
                        overlay.hidden = true;
                        document.removeEventListener('keydown', onKeyDown, true);
                        resolve(decision);
                    }
                    function onKeyDown(event) {
                        if (event.key === 'Escape') finish('deny');
                    }
                    choices.forEach(function(choice) {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.dataset.decision = choice[0];
                        button.textContent = choice[1];
                        button.addEventListener('click', function() { finish(choice[0]); });
                        actions.appendChild(button);
                    });
                    overlay.addEventListener('click', function onBackdrop(event) {
                        if (event.target === overlay) {
                            overlay.removeEventListener('click', onBackdrop);
                            finish('deny');
                        }
                    });
                    document.addEventListener('keydown', onKeyDown, true);
                    overlay.hidden = false;
                    const firstButton = actions.querySelector('button');
                    if (firstButton) firstButton.focus();
                });
            });
            return browserSecurityDialogQueue;
        }

        function executeLauncherRequestWithBrowserApproval(url, body) {
            if (!isMoonYaDesktopRuntime()) {
                return Promise.resolve(launcherRequiredToolResult());
            }

            const seenChallenges = new Set();
            let initialBody;
            try {
                const initialPayload = JSON.parse(body || '{}');
                if (!currentUser || !currentUser.id) {
                    return Promise.resolve({ success: false, error_code: 'missing_user_context', error: '无法确认当前登录用户，浏览器操作已停止。' });
                }
                initialPayload.user_context = String(currentUser.id);
                initialBody = JSON.stringify(initialPayload);
            } catch (error) {
                return Promise.resolve({ success: false, error_code: 'invalid_request', error: '浏览器操作参数不是有效 JSON。' });
            }
            function invoke(requestBody) {
                return fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: requestBody
                }).then(function(response) { return response.json(); }).then(function(result) {
                    if (!result || !result.approval_required) return result;
                    const token = result.approval_token || '';
                    if (!token || seenChallenges.has(token) || !result.authorize_route) {
                        return { success: false, error_code: 'invalid_approval_challenge', error: '浏览器确认请求无效。' };
                    }
                    seenChallenges.add(token);
                    function localDecision(decision) {
                        return postBrowserSecurityDecision(result.authorize_route, {
                            approval_token: token,
                            decision: decision === 'block' ? 'deny' : decision,
                            user_context: String(currentUser.id),
                            session_id: result.browser && result.browser.session_id ? result.browser.session_id : '',
                            page_version: result.page_version,
                            action: result.action || ''
                        });
                    }
                    function recordDecision(decision) {
                        const riskCategory = result.approval_kind === 'site' ? 'site_access'
                            : (result.approval_kind === 'tls' ? 'tls_exception' : (result.risk_category || ''));
                        const tasks = [browserPermissionRequest({
                            operation: 'record_confirmation',
                            url: result.url || '',
                            session_id: result.browser && result.browser.session_id ? result.browser.session_id : '',
                            page_version: Number(result.page_version || 0),
                            action: result.action || '',
                            risk_category: riskCategory,
                            approval_token: token,
                            status: decision === 'deny' || decision === 'block' ? 'denied' : 'approved'
                        })];
                        if (result.approval_kind === 'site' && (decision === 'allow_always' || decision === 'block')) {
                            tasks.push(browserPermissionRequest({
                                operation: 'set',
                                url: result.url || '',
                                decision: decision
                            }));
                        }
                        return Promise.all(tasks).then(function() { return decision; });
                    }
                    function resolveDecision() {
                        if (result.approval_kind !== 'site') return showBrowserSecurityChallenge(result);
                        return browserPermissionRequest({ operation: 'check', url: result.url || '' }, 'GET')
                            .then(function(saved) {
                                if (saved.decision === 'allow_always') return 'allow_once';
                                if (saved.decision === 'block') return 'block';
                                return showBrowserSecurityChallenge(result);
                            });
                    }
                    return resolveDecision().then(recordDecision).then(function(decision) {
                        return localDecision(decision);
                    }).then(function(decisionResult) {
                        if (!decisionResult || !decisionResult.success) return decisionResult;
                        let replayBody = requestBody;
                        if (decisionResult.approval_token) {
                            try {
                                const parsed = JSON.parse(requestBody || '{}');
                                parsed.approval_token = decisionResult.approval_token;
                                replayBody = JSON.stringify(parsed);
                            } catch (error) {
                                return { success: false, error_code: 'invalid_request', error: '浏览器操作参数不是有效 JSON。' };
                            }
                        }
                        return invoke(replayBody);
                    });
                });
            }
            return invoke(initialBody);
        }

        document.addEventListener('click', function(event) {
            if (event.target && event.target.id === 'browserSecurityManage') {
                renderBrowserPermissionManager();
            }
        });

        (function initSharedConversationRuntime() {
            const pending = new Map();
            const clientId = (window.crypto && window.crypto.randomUUID)
                ? window.crypto.randomUUID()
                : String(Date.now()) + Math.random().toString(36).slice(2);
            let port = null;
            try {
                if (typeof SharedWorker !== 'undefined') {
                    const worker = new SharedWorker('/workers/conversation-runtime-worker.js', { name: 'moonya-conversation-runtime-v1' });
                    port = worker.port;
                    port.start();
                    port.onmessage = function(event) {
                        const message = event.data || {};
                        if (message.type === 'response' && pending.has(message.requestId)) {
                            const handlers = pending.get(message.requestId);
                            pending.delete(message.requestId);
                            message.ok ? handlers.resolve(message.data) : handlers.reject(new Error(message.error || 'shared_runtime_error'));
                        }
                        if (message.type === 'taskState' || message.type === 'snapshot') {
                            window.dispatchEvent(new CustomEvent('moonya:shared-task-state', { detail: message }));
                        }
                        if (message.type === 'streamEvent') {
                            window.dispatchEvent(new CustomEvent('moonya:shared-stream-event', { detail: message }));
                        }
                    };
                }
            } catch (error) {
                console.warn('[SharedRuntime] unavailable:', error);
                port = null;
            }
            function request(action, payload) {
                const cloudChat = getChatHistory().find(chat => Number(chat.dbConversationId) === Number(payload && payload.conversationId));
                if (!isCloudChat(cloudChat)) return Promise.resolve({ localFallback: true });
                if (!port) return Promise.resolve({ localFallback: true });
                const requestId = clientId + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
                return new Promise(function(resolve, reject) {
                    pending.set(requestId, { resolve, reject });
                    port.postMessage(Object.assign({ action, requestId, clientId }, payload || {}));
                    setTimeout(function() {
                        if (!pending.has(requestId)) return;
                        pending.delete(requestId);
                        reject(new Error('shared_runtime_timeout'));
                    }, 5000);
                });
            }
            window.MoonYaSharedRuntime = {
                clientId,
                request,
                activate: conversationId => request('activate', { conversationId }),
                patchComposer: (conversationId, patch) => request('patchComposer', { conversationId, patch }),
                start: payload => request('start', payload),
                stop: payload => request('stop', payload),
                recover: payload => request('recover', payload),
                reconnected: payload => request('reconnected', payload),
                finish: payload => request('finish', payload),
                markViewed: conversationId => request('markViewed', { conversationId }),
                streamEvent: payload => request('streamEvent', payload)
            };
        })();

        // A live runtime belongs to a conversation, never to the currently
        // visible page. Hidden message containers continue receiving their SSE.
        const conversationRuntimeContexts = new Map();

        function captureConversationComposer(runtime) {
            if (!runtime) return;
            if (runtime.draft !== (messageInput ? messageInput.value : '') ||
                (runtime.uploadedImages?.length || 0) !== uploadedImages.length ||
                (runtime.localPaths?.length || 0) !== localPathSelections.length) runtime.draftDirty = true;
            runtime.draft = messageInput ? messageInput.value : '';
            runtime.uploadedImages = Array.isArray(uploadedImages) ? uploadedImages.slice() : [];
            runtime.localPaths = Array.isArray(localPathSelections)
                ? localPathSelections.map(item => ({ ...item }))
                : [];
            runtime.composer = snapshotConversationComposer(runtime);
            runtime.scrollTop = runtime.container ? runtime.container.scrollTop : 0;
            persistConversationDraft(runtime);
            if (runtime.dbConversationId && window.MoonYaSharedRuntime) {
                window.MoonYaSharedRuntime.patchComposer(runtime.dbConversationId, {
                    draft: runtime.draft,
                    uploadedImages: runtime.uploadedImages,
                    localPaths: runtime.localPaths,
                    composer: runtime.composer
                }).catch(function() {});
            }
        }

        function snapshotConversationComposer(runtime) {
            return {
                model: 'deepseek',
                deepseekModelVersion: deepseekModelVersion,
                model_ref: window.MoonYaModels ? window.MoonYaModels.reference() : null,
                contextSelections: window.MoonYaModelContext?.snapshot(),
                modelEfforts: window.MoonYaModels?.snapshotEfforts(),
                reasoningEffort: reasoningEffort,
                reasoningProfileVersion: 2,
                workReasoningProfile: workReasoningProfile,
                chatReasoningProfile: chatReasoningProfile,
                agentMode: runtime.mode === 'work',
                selectedSkills: selectedSkills.slice(),
                deepThinking: !!(deepThinkingLabel && deepThinkingLabel.classList.contains('active')),
                expert: typeof isExpertMode !== 'undefined' && isExpertMode,
                specialist: typeof isSpecialistMode !== 'undefined' && isSpecialistMode,
                programming: isProgrammingMode,
                translation: isTranslationMode,
                writing: isWritingMode,
                research: isResearchMode,
                classical: isClassicalMode,
                projectPath: (window.MoonYaActiveProject && window.MoonYaActiveProject.path)
                    || localStorage.getItem('moonya_work_project_path') || '',
                projectName: (window.MoonYaActiveProject && window.MoonYaActiveProject.name)
                    || localStorage.getItem('moonya_work_project_name') || '',
                approvalMode: runtime.approvalMode || 'confirm_writes'
            };
        }

        function renderConversationRuntimeComposer(runtime) {
            if (!runtime || runtime.container.dataset.runtimeActive !== '1') return;
            const composerState = runtime.composer || {
                model: currentModel,
                deepseekModelVersion: deepseekModelVersion,
                reasoningEffort: reasoningEffort,
                reasoningProfileVersion: 2,
                workReasoningProfile: workReasoningProfile,
                chatReasoningProfile: chatReasoningProfile,
                agentMode: runtime.mode === 'work',
                selectedSkills: selectedSkills.slice(),
                programming: isProgrammingMode,
                translation: isTranslationMode,
                writing: isWritingMode,
                research: isResearchMode,
                classical: isClassicalMode,
                projectPath: (window.MoonYaActiveProject && window.MoonYaActiveProject.path)
                    || localStorage.getItem('moonya_work_project_path') || '',
                projectName: (window.MoonYaActiveProject && window.MoonYaActiveProject.name)
                    || localStorage.getItem('moonya_work_project_name') || ''
            };
            if (runtime.mode === 'work' && window.MoonYaWorkspace) window.MoonYaWorkspace.restoreComposer(runtime, composerState);
            window.MoonYaModelContext?.restore(composerState.contextSelections);
            window.MoonYaModels?.restoreEfforts(composerState.modelEfforts);
            if (runtime.composer) {
                if (window.MoonYaModels) window.MoonYaModels.setReference(composerState.model_ref || null, false);
                if (composerState.model) currentModel = composerState.model;
                if (composerState.deepseekModelVersion) deepseekModelVersion = composerState.deepseekModelVersion;
                isAgentMode = !!composerState.agentMode;
                // 推理档位只有「真实会话」才能固定。`__new__:*` 是首页的新对话占位运行时，
                // 它的 composer 快照只是上一次留在首页的临时状态；本地历史改为整机共享后，
                // 这份占位草稿会跨账号、跨启动复现，若照单恢复就会把用户刚改过的全局档位顶回旧值。
                if (!/^__new__:/.test(String(runtime.chatId))) {
                    restoreBuiltinReasoningComposer(composerState);
                }
                activateReasoningMode();
                selectedSkills = Array.isArray(composerState.selectedSkills) ? composerState.selectedSkills.filter(name => window.MoonYaPlugins.isEnabled(name)) : [];
                if (typeof isExpertMode !== 'undefined') isExpertMode = !!composerState.expert;
                if (typeof isSpecialistMode !== 'undefined') isSpecialistMode = !!composerState.specialist;
                isProgrammingMode = !!composerState.programming;
                isTranslationMode = !!composerState.translation;
                isWritingMode = !!composerState.writing;
                isResearchMode = !!composerState.research;
                isClassicalMode = !!composerState.classical;
                if (typeof setTeamApprovalMode === 'function') {
                    runtime.approvalMode = window.MoonYaPermissions.normalize(composerState.approvalMode);
                    setTeamApprovalMode(composerState.approvalMode, false);
                }
            }
            if (messageInput) messageInput.value = runtime.draft || '';
            uploadedImages = Array.isArray(runtime.uploadedImages) ? runtime.uploadedImages.slice() : [];
            localPathSelections = Array.isArray(runtime.localPaths)
                ? runtime.localPaths.map(item => ({ ...item }))
                : [];

            const featureButtons = {
                programming: 'programmingBtn',
                translation: 'translationBtn',
                writing: 'writingBtn',
                research: 'researchBtn',
                classical: 'classicalBtn',
            };
            Object.keys(featureButtons).forEach(function(key) {
                const button = document.getElementById(featureButtons[key]);
                if (button) button.classList.toggle('active', !!composerState[key]);
            });
            document.querySelectorAll('.mode-toggle-tab').forEach(function(tab) {
                tab.classList.toggle('active', tab.dataset.value === (composerState.agentMode ? 'work' : 'chat'));
            });
            const modeSelect = document.getElementById('modeSelect');
            if (modeSelect) modeSelect.value = composerState.agentMode ? 'work' : 'chat';
            window.MoonYaShell?.sync();
            document.body.classList.toggle('work-mode', !!composerState.agentMode);
            // 桌面端原生标题栏跟随模式：Work 隐藏「语音播报」开关
            if (typeof window.moonYaPushWorkMode === 'function') {
                window.moonYaPushWorkMode(!!composerState.agentMode);
            }

            if (typeof renderSelectedSkills === 'function') renderSelectedSkills();
            if (deepThinkingLabel) {
                deepThinkingLabel.classList.toggle('active', !!composerState.deepThinking);
            }
            if (expertLabel) expertLabel.classList.toggle('expert-active', !!composerState.expert);
            if (specialistLabel) specialistLabel.classList.toggle('specialist-active', !!composerState.specialist);

            const modelSelect = document.getElementById('modelSelect');
            if (modelSelect && composerState.model) modelSelect.value = composerState.model;
            const modelSelectValue = document.getElementById('modelSelectValue');
            if (modelSelectValue && composerState.model) {
                const selectedModel = document.querySelector('.model-option[data-value="' + composerState.model + '"] .model-option-name');
                modelSelectValue.textContent = selectedModel ? selectedModel.textContent : composerState.model;
            }
            document.querySelectorAll('.deepseek-model-option').forEach(function(option) {
                option.classList.toggle('selected', option.dataset.model === composerState.deepseekModelVersion);
            });
            const deepseekText = document.getElementById('deepseekModelBtnText');
            if (deepseekText && composerState.deepseekModelVersion) {
                deepseekText.textContent = configuredModelLabel('deepseek', composerState.deepseekModelVersion);
            }
            document.querySelectorAll('.reasoning-effort-option').forEach(function(option) {
                const effort = option.dataset.effort === 'max' ? 'max' : option.dataset.effort;
                option.classList.toggle('selected', effort === composerState.reasoningEffort);
            });
            const effortText = document.getElementById('reasoningEffortBtnText');
            if (effortText) {
                effortText.textContent = reasoningLabel();
            }
            if (typeof window.renderMoonYaAgentSettings === 'function') window.renderMoonYaAgentSettings();

            if (fileCard) fileCard.style.display = '';

            if (Object.prototype.hasOwnProperty.call(composerState, 'projectPath')) {
                window.MoonYaActiveProject = {
                    path: composerState.projectPath || '',
                    name: composerState.projectName || ''
                };
                if (composerState.projectPath) localStorage.setItem('moonya_work_project_path', composerState.projectPath);
                else localStorage.removeItem('moonya_work_project_path');
            }
            if (Object.prototype.hasOwnProperty.call(composerState, 'projectName')) {
                if (composerState.projectName) localStorage.setItem('moonya_work_project_name', composerState.projectName);
                else localStorage.removeItem('moonya_work_project_name');
                if (typeof setButtonLabel === 'function') {
                    setButtonLabel(composerState.projectName ||
                        ((typeof WORK_PROJECT_TEXTS !== 'undefined' && WORK_PROJECT_TEXTS.btn_enter_project_default) || '进入项目工作'));
                }
            }

            const uploadContainer = document.getElementById('uploadContainer');
            if (uploadContainer && typeof createImageItem === 'function') {
                uploadContainer.innerHTML = '';
                uploadedImages.forEach(function(attachment) {
                    const id = attachment.file_id || attachment.attachment_id;
                    const preview = attachment.video_thumbnail || attachment.preview_url || attachment.base64_url || '';
                    const isVisual = attachment.is_image || attachment.category === 'image';
                    if (id) createImageItem(id, preview, isVisual ? null : (attachment.filename || '附件'));
                });
                if (typeof renderLocalPathSelections === 'function') renderLocalPathSelections();
            }
            if (typeof updateMoreFeaturesActiveState === 'function') updateMoreFeaturesActiveState();
            if (typeof updateDeepSeekSelectorsVisibility === 'function') updateDeepSeekSelectorsVisibility();
            if (typeof updateModelSelectVisibility === 'function') updateModelSelectVisibility();
            if (typeof updateWorkProjectBarVisibility === 'function') updateWorkProjectBarVisibility();
            if (typeof updateOfficeBtnVisibility === 'function') updateOfficeBtnVisibility();
        }

        function applySharedComposerState(runtime, sharedState) {
            if (!runtime || !sharedState || !sharedState.composer) return;
            const snapshot = sharedState.composer;
            if (Object.prototype.hasOwnProperty.call(snapshot, 'draft')) runtime.draft = snapshot.draft || '';
            if (Array.isArray(snapshot.uploadedImages)) runtime.uploadedImages = snapshot.uploadedImages.slice();
            if (Array.isArray(snapshot.localPaths)) runtime.localPaths = snapshot.localPaths.map(item => ({ ...item }));
            if (snapshot.composer && typeof snapshot.composer === 'object') {
                runtime.composer = Object.assign({}, runtime.composer || {}, snapshot.composer);
            }
            renderConversationRuntimeComposer(runtime);
        }

        function persistConversationDraft(runtime) {
            if (!runtime || runtime.mode === 'legacy') return;
            void window.MoonYaHistoryStore.saveDraft(runtime.historyScope, runtime.chatId, {
                draft: runtime.draft, uploadedImages: runtime.uploadedImages, localPaths: runtime.localPaths,
                composer: runtime.composer, scrollTop: runtime.scrollTop, mode: runtime.mode
            });
        }

        function restoreConversationDraft(runtime) {
            if (runtime.draftRestorePromise) return runtime.draftRestorePromise;
            runtime.draftRestorePromise = (async function() {
            try {
                const saved = await window.MoonYaHistoryStore.loadDraft(runtime.historyScope, runtime.chatId);
                if (!saved || runtime.draftDirty || runtime.running || runtime.preparing) return;
                runtime.draft = saved.draft || '';
                runtime.uploadedImages = saved.uploadedImages || [];
                runtime.localPaths = saved.localPaths || [];
                runtime.composer = saved.composer || null;
                runtime.approvalMode = window.MoonYaPermissions.normalize(saved.composer?.approvalMode);
                if (runtime.composer) runtime.composer.agentMode = runtime.mode !== 'chat';
                runtime.scrollTop = saved.scrollTop || 0;
                renderConversationRuntimeComposer(runtime);
            } catch (error) { console.error('恢复本地草稿失败:', error); }
            })();
            return runtime.draftRestorePromise;
        }

        const lastConversationByMode = new Map();
        window.switchMoonYaConversationMode = async function(mode) {
            await initializeChatHistory();
            const active = getConversationRuntime(currentChatId, messagesContainer);
            captureConversationComposer(active);
            if (currentChatId) lastConversationByMode.set(CHAT_HISTORY_KEY + ':' + active.mode, currentChatId);
            isAgentMode = mode === 'work';
            const target = lastConversationByMode.get(CHAT_HISTORY_KEY + ':' + mode);
            if (target && getChatHistory().some(chat => chat.id === target)) {
                await loadChat(target);
            } else {
                currentChatId = null;
                currentDbConversationId = null;
                const runtime = activateConversationRuntime(null);
                await restoreConversationDraft(runtime);
                if (!runtime.composer) captureConversationComposer(runtime);
                document.querySelector('.main-title').style.display = 'block';
                const topics = document.querySelector('.hot-topics-container');
                if (topics) topics.style.display = 'flex';
            }
            renderChatList();
        };

        window.syncActiveConversationComposer = function() {
            const runtime = getConversationRuntime(currentChatId, messagesContainer);
            captureConversationComposer(runtime);
        };

        function getConversationRuntime(chatId = currentChatId, preferredContainer) {
            const key = String(chatId || '__new__:' + currentConversationMode());
            let runtime = conversationRuntimeContexts.get(key);
            if (runtime && runtime.historyScope === CHAT_HISTORY_KEY) return runtime;
            if (runtime) {
                conversationRuntimeContexts.set(runtime.historyScope + ':' + key, runtime);
                conversationRuntimeContexts.delete(key);
                preferredContainer = null;
            }

            let container = preferredContainer || document.querySelector('.messages-container:not([data-conversation-runtime])');
            if (!container) {
                container = document.createElement('div');
                container.className = 'messages-container';
                const composer = document.querySelector('.input-container-wrapper');
                if (composer && composer.parentNode) composer.parentNode.insertBefore(container, composer);
            }
            container.dataset.conversationRuntime = key;
            // Looking up a runtime must not add another visible flex item to the
            // chat column. Only activation (or the initial bootstrap) reveals it.
            const active = container.dataset.runtimeActive === '1';
            container.dataset.runtimeActive = active ? '1' : '0';
            container.hidden = !active;
            runtime = {
                chatId: key,
                historyScope: CHAT_HISTORY_KEY,
                mode: getChatHistory().find(chat => String(chat.id) === key)?.mode || currentConversationMode(),
                container: container,
                abortController: null,
                running: false,
                clientMessageId: null,
                activeRunId: null,
                lastRemoteEventSeq: 0,
                lastViewedEventSeq: 0,
                draft: '',
                uploadedImages: [],
                localPaths: [],
                approvalMode: window.MoonYaPermissions.normalize(getChatHistory().find(chat => String(chat.id) === key)?.initialApprovalMode
                    || (!chatId ? window.MoonYaPermissions.defaultMode() : 'confirm_writes')),
                composer: null,
                scrollTop: 0
            };
            conversationRuntimeContexts.set(key, runtime);
            return runtime;
        }

        function activateConversationRuntime(chatId) {
            const activeContainer = document.querySelector('.messages-container[data-runtime-active="1"]');
            if (activeContainer && activeContainer.dataset.conversationRuntime) {
                const previousRuntime = conversationRuntimeContexts.get(activeContainer.dataset.conversationRuntime);
                if (previousRuntime && previousRuntime.historyScope === CHAT_HISTORY_KEY && previousRuntime.mode === currentConversationMode()) captureConversationComposer(previousRuntime);
            }
            // Sending already promotes its draft explicitly. Opening a saved chat
            // must get its own runtime so its IndexedDB draft is restored.
            const runtime = getConversationRuntime(chatId, activeContainer && !activeContainer.dataset.conversationRuntime ? activeContainer : null);
            const historyChat = getChatHistory().find(chat => String(chat.id) === String(chatId));
            runtime.dbConversationId = isCloudChat(historyChat) ? historyChat.dbConversationId || null : null;
            runtime.mode = historyChat ? historyChat.mode : currentConversationMode();
            runtime.workspaceIdentity = historyChat?.activeWorkspaceIdentity || runtime.workspaceIdentity || '__default__';
            runtime.harnessSessionId = historyChat?.runtimeSessions?.[runtime.workspaceIdentity] || runtime.harnessSessionId || '';
            if (runtime.mode === 'work' && window.MoonYaWorkspace) window.MoonYaWorkspace.syncRuntime(runtime);
            if (window.MoonYaOffice) window.MoonYaOffice.bind(runtime.harnessSessionId, runtime.workspaceIdentity === '__default__' ? '' : runtime.workspaceIdentity);
            runtime.historyScope = CHAT_HISTORY_KEY;
            isAgentMode = runtime.mode !== 'chat';
            if (runtime.composer) runtime.composer.agentMode = isAgentMode;
            setTeamApprovalMode(runtime.composer?.approvalMode || runtime.approvalMode, false);
            document.querySelectorAll('.messages-container').forEach(container => {
                const active = container === runtime.container;
                container.dataset.runtimeActive = active ? '1' : '0';
                container.hidden = !active;
            });
            messagesContainer = runtime.container;
            if (window.MoonYaSubagentChat) window.MoonYaSubagentChat.bind(runtime);
            if (messageInput) messageInput.value = runtime.draft || '';
            uploadedImages = runtime.uploadedImages.slice();
            localPathSelections = runtime.localPaths.map(item => ({ ...item }));
            if (runtime.composer) {
                currentModel = runtime.composer.model;
                deepseekModelVersion = runtime.composer.deepseekModelVersion;
                isAgentMode = runtime.composer.agentMode;
                if (!/^__new__:/.test(String(runtime.chatId))) restoreBuiltinReasoningComposer(runtime.composer);
                activateReasoningMode();
                selectedSkills = Array.isArray(runtime.composer.selectedSkills) ? runtime.composer.selectedSkills.filter(name => window.MoonYaPlugins.isEnabled(name)) : [];
                if (typeof isExpertMode !== 'undefined') isExpertMode = !!runtime.composer.expert;
                if (typeof isSpecialistMode !== 'undefined') isSpecialistMode = !!runtime.composer.specialist;
                isProgrammingMode = runtime.composer.programming;
                isTranslationMode = runtime.composer.translation;
                isWritingMode = runtime.composer.writing;
                isResearchMode = runtime.composer.research;
                isClassicalMode = runtime.composer.classical;
                if (typeof setTeamApprovalMode === 'function') {
                    setTeamApprovalMode(runtime.composer.approvalMode, false);
                }
            }
            renderConversationRuntimeComposer(runtime);
            currentAbortController = runtime.abortController;
            window.isSendingMessage = runtime.running;
            syncConversationFollow(runtime);
            requestAnimationFrame(() => {
                runtime.container.scrollTop = runtime.scrollTop || runtime.container.scrollHeight;
                syncConversationFollow(runtime);
            });
            if (runtime.dbConversationId && window.MoonYaSharedRuntime) {
                window.MoonYaSharedRuntime.activate(runtime.dbConversationId).then(function(sharedState) {
                    window.dispatchEvent(new CustomEvent('moonya:shared-task-state', {
                        detail: { type: 'snapshot', conversationId: runtime.dbConversationId, state: sharedState }
                    }));
                }).catch(function() {});
            }
            activateComposerApprovals();
            void restoreConversationDraft(runtime);
            return runtime;
        }

        window.MoonYaConversationRuntime = {
            contexts: conversationRuntimeContexts,
            current: () => getConversationRuntime(currentChatId),
            activate: activateConversationRuntime,
            capture: () => captureConversationComposer(getConversationRuntime(currentChatId))
        };
        const initialConversationRuntime = getConversationRuntime(currentChatId, messagesContainer);
        initialConversationRuntime.container.dataset.runtimeActive = '1';
        initialConversationRuntime.container.hidden = false;
        if (messageInput) {
            messageInput.addEventListener('input', function() {
                const runtime = getConversationRuntime(currentChatId, messagesContainer);
                runtime.draft = messageInput.value;
                persistConversationDraft(runtime);
                if (runtime.dbConversationId && window.MoonYaSharedRuntime) {
                    window.MoonYaSharedRuntime.patchComposer(runtime.dbConversationId, { draft: runtime.draft }).catch(function() {});
                }
            });
        }
        const composerControlSelector = [
            '.mode-toggle-tab', '.model-option', '.deepseek-model-option',
            '.reasoning-effort-option', '.feature-btn', '.more-features-option',
            '.work-project-option'
        ].join(',');
        document.addEventListener('click', function(event) {
            if (!event.target.closest || !event.target.closest(composerControlSelector)) return;
            setTimeout(function() {
                window.syncActiveConversationComposer();
            }, 0);
        }, true);
        document.addEventListener('change', function(event) {
            if (!event.target.matches || !event.target.matches('#agentReasoningSlider, #modelSelect')) return;
            setTimeout(function() {
                window.syncActiveConversationComposer();
            }, 0);
        }, true);
        window.addEventListener('moonya:shared-task-state', function(event) {
            const detail = event.detail || {};
            if (!detail.conversationId) return;
            const history = getChatHistory();
            const chat = history.find(item => Number(item.dbConversationId) === Number(detail.conversationId));
            if (!isCloudChat(chat)) return;
            const sharedState = detail.state || {};
            const runtime = Array.from(conversationRuntimeContexts.values()).find(function(item) {
                return Number(item.dbConversationId) === Number(detail.conversationId);
            });
            if (runtime) applySharedComposerState(runtime, sharedState);
            if (sharedState.lastTerminalStatus && sharedState.phase === 'idle') {
                teamUiState.approvals.forEach(function(record) {
                    if (Number(record.conversationId) === Number(detail.conversationId) && record.status === 'pending') {
                        updateTeamApprovalCard(record.id, sharedState.lastTerminalStatus === 'cancelled' ? 'cancelled' : 'expired');
                    }
                });
            }
            (sharedState.pendingApprovals || []).forEach(function(event) { handleTeamApproval(event); });
            const sharedRunning = ['starting', 'running', 'waiting_approval', 'recovering', 'stopping']
                .includes(sharedState.phase);
            if (runtime) {
                runtime.running = sharedRunning;
                syncConversationFollow(runtime);
                runtime.clientMessageId = sharedState.clientMessageId || runtime.clientMessageId || null;
                runtime.activeRunId = sharedState.runId || null;
                if (!sharedRunning && sharedState.lastTerminalStatus === 'cancelled' && runtime.abortController) {
                    runtime.abortController.abort();
                    if (runtime.finalizeCancelledResponse) runtime.finalizeCancelledResponse();
                    runtime.abortController = null;
                }
                if (String(currentChatId || '') === String(runtime.chatId)) {
                    window.isSendingMessage = sharedRunning;
                    currentAbortController = runtime.abortController;
                    const sendButton = document.getElementById('sendBtn');
                    if (sendButton) {
                        if (sharedRunning) {
                            sendButton.setAttribute('data-state', 'stop');
                            sendButton.innerHTML = STOP_ICON_SVG;
                        } else {
                            sendButton.removeAttribute('data-state');
                            sendButton.innerHTML = SEND_ICON_HTML;
                        }
                    }
                }
            }
            chat.taskState = Object.assign({}, chat.taskState || {}, {
                phase: sharedState.phase || 'idle',
                activeTaskId: sharedState.clientMessageId || null,
                activeRunId: sharedState.runId || null,
                lastTerminalStatus: sharedState.lastTerminalStatus || null,
                unreadTerminal: !!sharedState.unreadTerminal
            });
            const visibleTerminal = runtime && !sharedRunning && sharedState.unreadTerminal
                && runtime.container.dataset.runtimeActive === '1'
                && !runtime.container.hidden
                && !document.body.classList.contains('office-active');
            if (visibleTerminal && Number(sharedState.eventSeq || 0) > Number(runtime.lastViewedEventSeq || 0)) {
                runtime.lastViewedEventSeq = Number(sharedState.eventSeq || 0);
                chat.taskState.unreadTerminal = false;
                fetch(addTokenToUrl('conversation_api.php?action=mark_viewed'), {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ conversation_id: detail.conversationId })
                }).catch(function() {});
                if (window.MoonYaSharedRuntime) {
                    window.MoonYaSharedRuntime.markViewed(detail.conversationId).catch(function() {});
                }
            }
            saveChatHistory(history);
            renderChatList();
        });
        window.addEventListener('moonya:shared-stream-event', function(event) {
            const detail = event.detail || {};
            if (!detail.conversationId || !detail.event) return;
            if (window.MoonYaSharedRuntime
                && detail.originClientId === window.MoonYaSharedRuntime.clientId) return;
            const snapshot = detail.event;
            if (snapshot.event === 'approval.required' || snapshot.event === 'approval.decided') {
                handleTeamApproval(snapshot);
                return;
            }
            if (snapshot.kind !== 'conversation_dom_snapshot' || typeof snapshot.html !== 'string') return;
            const history = getChatHistory();
            const chat = history.find(function(item) {
                return Number(item.dbConversationId) === Number(detail.conversationId);
            });
            if (!isCloudChat(chat)) return;
            const runtime = getConversationRuntime(chat.id);
            runtime.dbConversationId = detail.conversationId;
            if (Number(detail.eventSeq || 0) <= Number(runtime.lastRemoteEventSeq || 0)) return;
            runtime.lastRemoteEventSeq = Number(detail.eventSeq || 0);
            runtime.container.innerHTML = snapshot.html;
            runtime.scrollTop = Number(snapshot.scrollTop || runtime.container.scrollHeight || 0);
            if (runtime.container.dataset.runtimeActive === '1') {
                requestAnimationFrame(function() {
                    runtime.container.scrollTop = runtime.scrollTop || runtime.container.scrollHeight;
                });
            }
        });

        // ★ v4.12-fix-empty-wrappers：验证浏览器是否加载了最新代码
        //   如果控制台没有此日志或有旧版本号，说明 CefSharp 缓存了旧代码
        console.log('[MoonYa v4.12-fix-empty-wrappers] Script loaded at ' + new Date().toISOString());

        // 实时语音对话是否激活（用于强制语音播报）
        function isVoiceChatActive() {
            return typeof window.VoiceChat !== 'undefined' &&
                   typeof window.VoiceChat.isActive === 'function' &&
                   window.VoiceChat.isActive();
        }

        // 爬虫实时计时器
        let crawlerStartTime = null;
        let crawlerTimerId = null;

        // ========== 模型卡顿检测器 ==========
        // 问题：模型卡顿时，停止图标可能会因为各种原因（DOM重排、CSS样式、SVG渲染等）被替换或隐藏
        // 解决：使用定时器持续检测并强制确保停止图标可见
        let lastSSEEventTime = 0;
        let stallCheckInterval = null;
        const STOP_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 10 10" fill="#fff" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" rx=".5"/></svg>';
        const SEND_ICON_HTML = '<img id="sendBtnImg" src="/image/composer-send.svg" alt="发送">';

        // ========== 任务规划 SVG 图标工厂（禁止硬编码） ==========
        function createWorkflowSpinnerIcon(size, strokeWidth) {
            size = size || 16;
            strokeWidth = strokeWidth || 2;
            const svgId = 'wfspin' + Date.now() + Math.random().toString(36).slice(2, 8);
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 36 36"><defs><linearGradient x1="0%" y1="100%" x2="100%" y2="100%" id="' + svgId + '"><stop stop-color="currentColor" stop-opacity="0" offset="0%"></stop><stop stop-color="currentColor" offset="100%"></stop></linearGradient></defs><g fill="none"><path d="M34,18 C34,9.163444 26.836556,2 18,2 C11.6597233,2 6.18078805,5.68784135 3.59122325,11.0354951" stroke="url(#' + svgId + ')" stroke-width="' + strokeWidth + '" stroke-linecap="round"></path></g></svg>';
        }
        // 静态图片图标：用于真正产生/查看了图像的活动，不参与运行中旋转。
        function createWorkflowImageIcon(size) {
            size = size || 16;
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="15" height="15" rx="2"></rect><path d="M6 16l4-4 3.2 3.2 2-2L21 18"></path><circle cx="16.5" cy="8.5" r="1.3"></circle><path d="M4 7H3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"></path></svg>';
        }
        // 中性灰实心圈 + 白勾
        function createWorkflowCheckIcon(size, color) {
            size = size || 18;
            color = color || '#888888';
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="' + color + '"></circle><path d="M7 12l3 3 7-7" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
        }
        // 中性灰实心圈 + 白叉
        function createWorkflowCrossIcon(size, color) {
            size = size || 18;
            color = color || '#888888';
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="' + color + '"></circle><path d="M8 8l8 8M16 8l-8 8" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
        }
        // 未执行 / 正在执行：空心灰圈
        function createWorkflowEmptyIcon(size, color) {
            size = size || 18;
            color = color || '#b0b0b0';
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9.5" stroke="' + color + '" stroke-width="1.5" fill="none"></circle></svg>';
        }
        function createWorkflowChevronIcon(size, direction) {
            size = size || 12;
            direction = direction || 'right';
            const rotate = direction === 'down' ? '90' : '0';
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(' + rotate + 'deg); transition: transform 0.2s ease;"><polyline points="9 18 15 12 9 6"></polyline></svg>';
        }

        // ========== CU 执行卡片（Codex 风格：摘要 + 可折叠操作记录）==========
        // CU 过程中的模型思考、截图和工具回执都写入同一个执行卡片；最终结论仍使用
        // 正常助手消息区域显示，避免用户只能在时间线或 Toast 中寻找结果。
        function ensureCuTimeline(aiMessageDiv) {
            let timeline = aiMessageDiv.querySelector('.cu-timeline');
            if (timeline) return timeline;

            const card = document.createElement('section');
            card.className = 'cu-codex-card is-working';
            card.setAttribute('aria-label', 'Computer Use 执行过程');

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'cu-codex-header';
            header.setAttribute('aria-expanded', 'true');
            header.innerHTML =
                '<span class="cu-codex-marker" aria-hidden="true">⌁</span>' +
                '<span class="cu-codex-title">正在操作电脑</span>' +
                '<span class="cu-codex-state">准备中</span>' +
                '<span class="cu-codex-chevron" aria-hidden="true">' +
                    createWorkflowChevronIcon(14, 'down') +
                '</span>';

            const body = document.createElement('div');
            body.className = 'cu-codex-body';
            timeline = document.createElement('div');
            timeline.className = 'cu-timeline';
            body.appendChild(timeline);

            header.addEventListener('click', function() {
                const collapsed = card.classList.toggle('is-collapsed');
                header.setAttribute('aria-expanded', String(!collapsed));
            });

            card.appendChild(header);
            card.appendChild(body);
            aiMessageDiv.appendChild(card);
            return timeline;
        }

        function setCuCardState(aiMessageDiv, state, detail) {
            const card = aiMessageDiv && aiMessageDiv.querySelector('.cu-codex-card');
            if (!card) return;

            const title = card.querySelector('.cu-codex-title');
            const stateEl = card.querySelector('.cu-codex-state');
            card.classList.remove('is-working', 'is-waiting', 'is-done', 'is-limited', 'is-error');
            card.classList.add('is-' + state);

            if (title) {
                title.textContent = state === 'done' ? '已完成电脑操作'
                    : state === 'waiting' ? '等待你操作'
                    : state === 'limited' ? '电脑操作已停止'
                    : state === 'error' ? '电脑操作未完成'
                    : '正在操作电脑';
            }
            if (stateEl) stateEl.textContent = detail || (state === 'working' ? '执行中' : '');

            if (state === 'done' || state === 'limited' || state === 'error') {
                card.classList.add('is-collapsed');
                const header = card.querySelector('.cu-codex-header');
                if (header) header.setAttribute('aria-expanded', 'false');
            } else {
                card.classList.remove('is-collapsed');
                const header = card.querySelector('.cu-codex-header');
                if (header) header.setAttribute('aria-expanded', 'true');
            }
        }

        // ========== MoonYa Task Panel（Task 15-17）==========
        // 提供 todo_update / diagnostics / command_started / command_output 四类 SSE 事件的
        // 内联 UI 渲染。所有 CSS 通过 <style> 一次性注入，避免污染全局样式表。
        //   - renderTodoUpdate：任务列表卡片（复选框 + 状态标签 + 优先级颜色 + 状态排序 + 动画）
        //   - renderDiagnostics：诊断信息（错误红 / 警告黄 / 提示蓝，点击跳转 edit_file view）
        //   - renderCommandStarted：后台命令启动状态条 + 查询/停止按钮
        //   - renderCommandOutput：后台命令实时流式输出
        (function setupMoonYaTaskPanel() {
            const STYLE_ID = 'moonya-task-panel-styles';
            function injectStyles() {
                if (document.getElementById(STYLE_ID)) return;
                const style = document.createElement('style');
                style.id = STYLE_ID;
                style.textContent = [
                    '/* ===== TodoWrite 任务列表（Task 15）===== */',
                    '.my-todo-card { margin: 8px 0; padding: 10px 12px; background: var(--theme-accent-soft, #f8f9fa); border-left: 3px solid #4a90e2; border-radius: 6px; font-size: 13px; animation: myTodoCardIn 0.25s ease-out; }',
                    '@keyframes myTodoCardIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
                    '.my-todo-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 13px; font-weight: 600; color: var(--theme-text, #333); }',
                    '.my-todo-header svg { color: var(--theme-accent-text, #4a90e2); }',
                    '.my-todo-count { color: var(--theme-secondary, #888); font-weight: normal; font-size: 12px; margin-left: auto; }',
                    '.my-todo-list { display: flex; flex-direction: column; gap: 6px; }',
                    '.my-todo-item { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 6px 8px; background: var(--theme-surface, #ffffff); border: 1px solid #ececec; border-radius: 4px; transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease; }',
                    '.my-todo-item:hover { border-color: var(--theme-border, #d0d7de); }',
                    '.my-todo-checkbox { width: 18px; height: 18px; border: 1.5px solid #c0c0c0; border-radius: 4px; display: flex; align-items: center; justify-content: center; background: var(--theme-surface, #fff); transition: all 0.25s ease; position: relative; }',
                    '.my-todo-item.status-completed .my-todo-checkbox { background: #43a047; border-color: #43a047; }',
                    '.my-todo-item.status-completed .my-todo-checkbox::after { content: ""; position: absolute; width: 5px; height: 9px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg) translate(-1px, -1px); animation: myTodoCheck 0.3s ease-out; }',
                    '@keyframes myTodoCheck { 0% { opacity: 0; transform: rotate(45deg) translate(-1px, -1px) scale(0.4); } 100% { opacity: 1; transform: rotate(45deg) translate(-1px, -1px) scale(1); } }',
                    '.my-todo-content { font-size: 13px; color: var(--theme-text, #333); word-break: break-word; line-height: 1.45; }',
                    '.my-todo-item.status-completed .my-todo-content { color: var(--theme-secondary, #888); text-decoration: line-through; }',
                    '.my-todo-item.status-in_progress { background: var(--theme-warning-soft, #fffbea); border-color: #ffe082; animation: myTodoPulse 1.6s ease-in-out infinite; }',
                    '@keyframes myTodoPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 193, 7, 0); } 50% { box-shadow: 0 0 0 3px rgba(255, 193, 7, 0.22); } }',
                    '.my-todo-item.priority-high { border-left: 3px solid #e53935; }',
                    '.my-todo-item.priority-medium { border-left: 3px solid #fbc02d; }',
                    '.my-todo-item.priority-low { border-left: 3px solid #bdbdbd; }',
                    '.my-todo-status-tag { font-size: 11px; padding: 2px 6px; border-radius: 10px; color: #fff; line-height: 1.4; white-space: nowrap; }',
                    '.my-todo-status-tag.status-pending { background: #9e9e9e; }',
                    '.my-todo-status-tag.status-in_progress { background: #f59e0b; }',
                    '.my-todo-status-tag.status-completed { background: #43a047; }',
                    '',
                    '/* ===== 诊断信息（Task 16）===== */',
                    '.my-diag-card { margin: 8px 0; padding: 10px 12px; background: var(--theme-accent-soft, #f8f9fa); border-radius: 6px; border-left: 3px solid #6c757d; font-size: 13px; animation: myDiagIn 0.25s ease-out; }',
                    '@keyframes myDiagIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
                    '.my-diag-header { font-weight: 600; color: var(--theme-text, #333); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }',
                    '.my-diag-list { display: flex; flex-direction: column; gap: 4px; }',
                    '.my-diag-item { display: grid; grid-template-columns: 16px auto 1fr; gap: 6px; align-items: start; padding: 5px 8px; border-radius: 4px; cursor: pointer; transition: background 0.2s ease, transform 0.15s ease; font-size: 12.5px; line-height: 1.5; }',
                    '.my-diag-item:hover { background: var(--theme-surface, #ececec); transform: translateX(2px); }',
                    '.my-diag-item.severity-error { background: var(--theme-danger-soft, #fdecea); border-left: 3px solid #e53935; }',
                    '.my-diag-item.severity-warning { background: var(--theme-warning-soft, #fff8e1); border-left: 3px solid #f59e0b; }',
                    '.my-diag-item.severity-info { background: var(--theme-accent-soft, #e3f2fd); border-left: 3px solid #2196f3; }',
                    '.my-diag-icon { display: flex; align-items: center; justify-content: center; }',
                    '.my-diag-loc { color: var(--theme-accent-text, #1976d2); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: nowrap; }',
                    '.my-diag-msg { color: var(--theme-text, #333); word-break: break-word; }',
                    '',
                    '/* ===== 后台命令输出（Task 17）===== */',
                    '.my-bgcmd-card { margin: 8px 0; background: var(--theme-surface, #fff); border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; animation: myBgCmdIn 0.25s ease-out; }',
                    '@keyframes myBgCmdIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }',
                    '.my-bgcmd-header { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; padding: 8px 12px; background: var(--theme-accent-soft, #f5f7fa); border-bottom: 1px solid #ececec; font-size: 12.5px; }',
                    '.my-bgcmd-spinner { width: 16px; height: 16px; color: var(--theme-secondary, #888); display: flex; align-items: center; justify-content: center; animation: none; }',
                    '.my-bgcmd-title { color: var(--theme-text, #333); word-break: break-all; min-width: 0; }',
                    '.my-bgcmd-title .my-bgcmd-cid { color: var(--theme-accent-text, #1976d2); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }',
                    '.my-bgcmd-title .my-bgcmd-cmd { color: var(--theme-secondary, #666); font-size: 11.5px; }',
                    '.my-bgcmd-actions { display: flex; gap: 4px; }',
                    '.my-bgcmd-btn { font-size: 11.5px; padding: 3px 8px; border-radius: 4px; border: 1px solid #d0d7de; background: var(--theme-surface, #fff); color: var(--theme-text, #333); cursor: pointer; transition: background 0.2s ease, border-color 0.2s ease; line-height: 1.4; }',
                    '.my-bgcmd-btn:hover { background: var(--theme-accent-soft, #f0f3f7); }',
                    '.my-bgcmd-btn.btn-stop { color: var(--theme-danger, #c62828); border-color: #ef9a9a; }',
                    '.my-bgcmd-btn.btn-stop:hover { background: var(--theme-danger-soft, #fdecea); }',
                    '.my-bgcmd-btn:disabled { opacity: 0.5; cursor: not-allowed; }',
                    '.my-bgcmd-body { max-height: 220px; overflow-y: auto; padding: 8px 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; color: var(--theme-text, #333); background: var(--theme-accent-soft, #fafbfc); white-space: pre-wrap; word-break: break-all; }',
                    '.my-bgcmd-body:empty { display: none; }',
                    '.my-bgcmd-card.state-done .my-bgcmd-spinner, .my-bgcmd-card.state-stopped .my-bgcmd-spinner { animation: none; }',
                    '.my-bgcmd-card.state-done .my-bgcmd-header { background: var(--theme-success-soft, #eef7ee); }',
                    '.my-bgcmd-card.state-stopped .my-bgcmd-header { background: var(--theme-danger-soft, #fdecea); }'
                ].join('\n');
                (document.head || document.documentElement).appendChild(style);
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', injectStyles);
            } else {
                injectStyles();
            }

            // 工具函数：在当前 AI 消息气泡内查找/创建 task host 容器
            function ensureTaskPanelContainer(aiMessageDiv, loadingId) {
                let host = null;
                if (aiMessageDiv && aiMessageDiv.querySelector) {
                    host = aiMessageDiv.querySelector('.moonya-task-host');
                }
                if (host) return host;
                const messagesContainer = document.getElementById('messagesContainer');
                host = document.createElement('div');
                host.className = 'moonya-task-host';
                if (aiMessageDiv) {
                    aiMessageDiv.appendChild(host);
                } else if (messagesContainer) {
                    messagesContainer.appendChild(host);
                }
                return host;
            }

            function scrollToBottom() {
                const messagesContainer = document.getElementById('messagesContainer');
                if (messagesContainer) teamScrollIfFollowing(messagesContainer);
            }

            // ===== Task 15: TodoWrite 任务列表渲染 =====
            const TODO_STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 };
            const TODO_PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
            const TODO_STATUS_LABEL = { pending: '待处理', in_progress: '进行中', completed: '已完成' };

            function renderTodoUpdate(data, aiMessageDiv, loadingId) {
                const tasks = Array.isArray(data.todos) ? data.todos
                            : Array.isArray(data.tasks) ? data.tasks
                            : (Array.isArray(data.items) ? data.items : []);
                if (!tasks.length) return;

                const host = ensureTaskPanelContainer(aiMessageDiv, loadingId);
                if (!host) return;

                let card = host.querySelector('.my-todo-card');
                if (!card) {
                    card = document.createElement('div');
                    card.className = 'my-todo-card';
                    host.appendChild(card);
                }

                // 归一化字段（兼容 TodoWrite 多种字段命名）
                const normalized = tasks.map(function (t, idx) {
                    const status = ['pending', 'in_progress', 'completed'].indexOf(t.status) !== -1 ? t.status : 'pending';
                    const priority = ['high', 'medium', 'low'].indexOf(t.priority) !== -1 ? t.priority : 'medium';
                    return {
                        id: t.id || ('todo-' + idx),
                        content: t.content || t.text || t.title || t.task || t.description || '任务',
                        status: status,
                        priority: priority,
                        created_at: t.created_at || t.createdAt || t.created || idx,
                        index: idx
                    };
                });
                // 排序：状态（in_progress > pending > completed） → 优先级 → 创建时间
                normalized.sort(function (a, b) {
                    const so = TODO_STATUS_ORDER[a.status] - TODO_STATUS_ORDER[b.status];
                    if (so !== 0) return so;
                    const po = TODO_PRIORITY_ORDER[a.priority] - TODO_PRIORITY_ORDER[b.priority];
                    if (po !== 0) return po;
                    const aT = typeof a.created_at === 'number' ? a.created_at : String(a.created_at);
                    const bT = typeof b.created_at === 'number' ? b.created_at : String(b.created_at);
                    if (aT < bT) return -1;
                    if (aT > bT) return 1;
                    return a.index - b.index;
                });

                // Header
                const counts = { pending: 0, in_progress: 0, completed: 0 };
                normalized.forEach(function (t) { counts[t.status]++; });
                let header = card.querySelector('.my-todo-header');
                if (!header) {
                    header = document.createElement('div');
                    header.className = 'my-todo-header';
                    card.appendChild(header);
                }
                header.innerHTML =
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>' +
                    '<span>任务列表</span>' +
                    '<span class="my-todo-count">' + counts.completed + '/' + normalized.length + ' 已完成 · ' + counts.in_progress + ' 进行中</span>';

                // List（diff 友好：以 id 为 key 复用旧节点以保留过渡动画）
                let list = card.querySelector('.my-todo-list');
                if (!list) {
                    list = document.createElement('div');
                    list.className = 'my-todo-list';
                    card.appendChild(list);
                }
                const existing = new Map();
                Array.prototype.forEach.call(list.querySelectorAll('.my-todo-item'), function (el) {
                    existing.set(el.dataset.todoId, el);
                });
                const seen = new Set();
                const frag = document.createDocumentFragment();
                normalized.forEach(function (t) {
                    seen.add(t.id);
                    let item = existing.get(t.id);
                    const prevStatus = item ? item.dataset.status : null;
                    if (!item) {
                        item = document.createElement('div');
                        item.dataset.todoId = t.id;
                        item.innerHTML =
                            '<div class="my-todo-checkbox"></div>' +
                            '<div class="my-todo-content"></div>' +
                            '<span class="my-todo-status-tag"></span>';
                    }
                    item.className = 'my-todo-item priority-' + t.priority + ' status-' + t.status;
                    item.dataset.status = t.status;
                    item.dataset.priority = t.priority;
                    item.querySelector('.my-todo-content').textContent = t.content;
                    const tag = item.querySelector('.my-todo-status-tag');
                    tag.className = 'my-todo-status-tag status-' + t.status;
                    tag.textContent = TODO_STATUS_LABEL[t.status];
                    // 状态切换平滑动画：先 reset 动画再 reflow 再恢复，确保 in_progress 脉冲/completed 对勾重播
                    if (prevStatus && prevStatus !== t.status) {
                        const animKey = item.dataset.animKey || '';
                        const newKey = prevStatus + '->' + t.status + '@' + Date.now();
                        item.dataset.animKey = newKey;
                        if (animKey !== newKey) {
                            // 触发 in_progress 脉冲重启（CSS animation 默认会持续，无需手动重启）
                            // 完成 -> completed 时强制重播对勾动画
                            if (t.status === 'completed') {
                                const cb = item.querySelector('.my-todo-checkbox');
                                if (cb) {
                                    const clone = cb.cloneNode(true);
                                    cb.parentNode.replaceChild(clone, cb);
                                }
                            }
                        }
                    }
                    frag.appendChild(item);
                });
                // 删除不再存在的项
                existing.forEach(function (el, id) { if (!seen.has(id)) el.remove(); });
                list.appendChild(frag);

                scrollToBottom();
            }

            // ===== Task 16: 诊断信息渲染 =====
            const DIAG_ICON = {
                error:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e53935" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
                warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
                info:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2196f3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
            };
            const DIAG_LABEL = { error: '错误', warning: '警告', info: '提示' };

            function renderDiagnostics(data, aiMessageDiv, loadingId) {
                const items = Array.isArray(data.diagnostics) ? data.diagnostics
                            : Array.isArray(data.items) ? data.items
                            : (Array.isArray(data.issues) ? data.issues : []);
                if (!items.length) return;

                const host = ensureTaskPanelContainer(aiMessageDiv, loadingId);
                if (!host) return;

                let card = host.querySelector('.my-diag-card');
                if (!card) {
                    card = document.createElement('div');
                    card.className = 'my-diag-card';
                    host.appendChild(card);
                }

                const counts = { error: 0, warning: 0, info: 0 };
                items.forEach(function (it) {
                    const s = (it.severity || it.level || 'info').toLowerCase();
                    if (counts[s] !== undefined) counts[s]++;
                });

                let header = card.querySelector('.my-diag-header');
                if (!header) {
                    header = document.createElement('div');
                    header.className = 'my-diag-header';
                    card.appendChild(header);
                }
                header.innerHTML =
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11H1l8-8 8 8h-8v8"></path><path d="M14 4l6 6"></path></svg>' +
                    '<span>诊断结果：' + counts.error + ' 错误 · ' + counts.warning + ' 警告 · ' + counts.info + ' 提示</span>';

                let list = card.querySelector('.my-diag-list');
                if (!list) {
                    list = document.createElement('div');
                    list.className = 'my-diag-list';
                    card.appendChild(list);
                }
                list.innerHTML = '';
                items.forEach(function (it) {
                    const severityRaw = (it.severity || it.level || 'info').toLowerCase();
                    const severity = ['error', 'warning', 'info'].indexOf(severityRaw) !== -1 ? severityRaw : 'info';
                    const file = it.file || it.path || it.filename || it.filePath || '';
                    const line = it.line || it.lineNumber || '';
                    const col = it.column || it.col || '';
                    const msg = it.message || it.text || it.msg || '';
                    const itemEl = document.createElement('div');
                    itemEl.className = 'my-diag-item severity-' + severity;
                    const locParts = [];
                    if (file) locParts.push(file);
                    if (line) locParts.push(line + (col ? ':' + col : ''));
                    const locText = locParts.join(':');
                    itemEl.innerHTML =
                        '<span class="my-diag-icon">' + (DIAG_ICON[severity] || DIAG_ICON.info) + '</span>' +
                        (locText ? '<span class="my-diag-loc"></span>' : '') +
                        '<span class="my-diag-msg"></span>';
                    if (locText) {
                        const locEl = itemEl.querySelector('.my-diag-loc');
                        if (locEl) locEl.textContent = locText;
                    }
                    const msgEl = itemEl.querySelector('.my-diag-msg');
                    if (msgEl) msgEl.textContent = msg + (DIAG_LABEL[severity] ? '' : '');
                    // 点击跳转：Monaco 未集成时由后端 edit_file view 展示该文件并滚动到行号
                    if (file && line) {
                        itemEl.dataset.tooltip = '点击查看 ' + file + ':' + line;
                        itemEl.addEventListener('click', function () {
                            const msgInput = document.getElementById('messageInput');
                            if (msgInput) {
                                msgInput.value = '请打开文件 ' + file + ' 并跳转到第 ' + line + ' 行';
                                msgInput.focus();
                            }
                        });
                    }
                    list.appendChild(itemEl);
                });

                scrollToBottom();
            }

            // ===== Task 17: 后台命令展示 =====
            // 17.1：命令启动状态条
            function bindBgCmdButtons(card, commandId) {
                const statusBtn = card.querySelector('.btn-status');
                const stopBtn = card.querySelector('.btn-stop');
                if (statusBtn) {
                    statusBtn.addEventListener('click', function () {
                        triggerCommandAction('请查询后台命令 ' + commandId + ' 的执行状态（调用 get_command_status 工具）');
                    });
                }
                if (stopBtn) {
                    stopBtn.addEventListener('click', function () {
                        triggerCommandAction('请停止后台命令 ' + commandId + '（调用 stop_command 工具）');
                        card.classList.add('state-stopped');
                        const sp = card.querySelector('.my-bgcmd-spinner');
                        if (sp) { sp.style.animation = 'none'; sp.innerHTML = createWorkflowCrossIcon(16, '#e53935'); }
                        if (stopBtn) stopBtn.disabled = true;
                    });
                }
            }

            function renderCommandStarted(data, aiMessageDiv, loadingId) {
                const commandId = data.command_id || data.id || '';
                if (!commandId) return;
                const command = data.command || data.cmd || '';
                const host = ensureTaskPanelContainer(aiMessageDiv, loadingId);
                if (!host) return;

                let card = host.querySelector('.my-bgcmd-card[data-cid="' + cssEscape(commandId) + '"]');
                if (!card) {
                    card = document.createElement('div');
                    card.className = 'my-bgcmd-card';
                    card.setAttribute('data-cid', commandId);
                    card.innerHTML =
                        '<div class="my-bgcmd-header">' +
                            '<span class="my-bgcmd-spinner">' + createWorkflowEmptyIcon(16, '#888888') + '</span>' +
                            '<span class="my-bgcmd-title">命令已启动 · <span class="my-bgcmd-cid">command_id=' + escapeHtml(commandId) + '</span>' +
                                (command ? '<br><span class="my-bgcmd-cmd">' + escapeHtml(command) + '</span>' : '') +
                            '</span>' +
                            '<span class="my-bgcmd-actions">' +
                                '<button class="my-bgcmd-btn btn-status" type="button">查询状态</button>' +
                                '<button class="my-bgcmd-btn btn-stop" type="button">停止命令</button>' +
                            '</span>' +
                        '</div>' +
                        '<div class="my-bgcmd-body"></div>';
                    host.appendChild(card);
                    bindBgCmdButtons(card, commandId);
                }
                scrollToBottom();
            }

            // 17.3：命令输出流（实时追加）
            function renderCommandOutput(data, aiMessageDiv) {
                const commandId = data.command_id || data.id || '';
                if (!commandId) return;
                const chunk = (typeof data.chunk === 'string') ? data.chunk
                            : (typeof data.output === 'string' ? data.output
                            : (typeof data.text === 'string' ? data.text : ''));
                const done = data.done || data.completed || false;
                const status = data.status || null;

                const messagesContainer = aiMessageDiv?.closest('.messages-container') || document.querySelector('.messages-container[data-runtime-active="1"]');
                let card = null;
                if (messagesContainer) {
                    const hosts = messagesContainer.querySelectorAll('.moonya-task-host');
                    for (let i = hosts.length - 1; i >= 0; i--) {
                        card = hosts[i].querySelector('.my-bgcmd-card[data-cid="' + cssEscape(commandId) + '"]');
                        if (card) break;
                    }
                }
                // 兜底：未收到 command_started 时直接构建一个最小卡片
                if (!card) {
                    const host = ensureTaskPanelContainer(null);
                    if (!host) return;
                    card = document.createElement('div');
                    card.className = 'my-bgcmd-card';
                    card.setAttribute('data-cid', commandId);
                    card.innerHTML =
                        '<div class="my-bgcmd-header">' +
                            '<span class="my-bgcmd-spinner">' + createWorkflowEmptyIcon(16, '#888888') + '</span>' +
                            '<span class="my-bgcmd-title">后台命令输出 · <span class="my-bgcmd-cid">command_id=' + escapeHtml(commandId) + '</span></span>' +
                            '<span class="my-bgcmd-actions">' +
                                '<button class="my-bgcmd-btn btn-status" type="button">查询状态</button>' +
                                '<button class="my-bgcmd-btn btn-stop" type="button">停止命令</button>' +
                            '</span>' +
                        '</div>' +
                        '<div class="my-bgcmd-body"></div>';
                    host.appendChild(card);
                    bindBgCmdButtons(card, commandId);
                }
                const body = card.querySelector('.my-bgcmd-body');
                if (body && chunk) {
                    body.appendChild(document.createTextNode(chunk));
                    // 自动滚动到底部
                    body.scrollTop = body.scrollHeight;
                }
                if (done) {
                    card.classList.add('state-done');
                    const sp = card.querySelector('.my-bgcmd-spinner');
                    if (sp) { sp.style.animation = 'none'; sp.innerHTML = createWorkflowCheckIcon(16, '#43a047'); }
                } else if (status === 'stopped' || status === 'error') {
                    card.classList.add('state-stopped');
                    const sp = card.querySelector('.my-bgcmd-spinner');
                    if (sp) { sp.style.animation = 'none'; sp.innerHTML = createWorkflowCrossIcon(16, '#e53935'); }
                }
                scrollToBottom();
            }

            // 触发命令动作：填入提示语并提交（与 reExecuteExecBlock 模式一致）
            function triggerCommandAction(prompt) {
                const msgInput = document.getElementById('messageInput');
                if (!msgInput) return;
                msgInput.value = prompt;
                msgInput.focus();
                const sendBtn = document.getElementById('sendBtn');
                if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                }
            }

            // CSS.escape 兜底（旧浏览器 / IE）
            function cssEscape(s) {
                if (typeof window.CSS !== 'undefined' && typeof window.CSS.escape === 'function') {
                    return window.CSS.escape(String(s));
                }
                return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
                    return '\\' + c;
                });
            }

            // 暴露给同脚本作用域内的 SSE 处理器直接调用
            window.MoonYaTaskPanel = {
                renderTodoUpdate: renderTodoUpdate,
                renderDiagnostics: renderDiagnostics,
                renderCommandStarted: renderCommandStarted,
                renderCommandOutput: renderCommandOutput
            };
        })();

        // ========== 步骤标记过滤 ==========
        // AI 输出 <step id="N" /> 等标记声明当前步骤（对用户不可见）。
        // 支持格式：<step id="N" />、<step id='N'/>、<step id=N />、<step id="N">、</step>
        // 流式传输时标记可能被切分到多个 chunk，需用 hold buffer 拼接后判断。
        let _stepTagHold = '';
        function filterStepTag(content) {
            if (typeof content !== 'string' || content === '') return content;
            let raw = _stepTagHold + content;
            _stepTagHold = '';
            let clean = '';
            let cursor = 0;
            while (true) {
                // 同时查找开标签 <step 和闭标签 </step
                const openIdx = raw.indexOf('<step', cursor);
                const closeIdx = raw.indexOf('</step', cursor);

                if (openIdx === -1 && closeIdx === -1) {
                    // 没有完整标记，但末尾可能是被切分的前缀（<, <s, <st, <ste, <step, </, </s ...）
                    const remaining = raw.substring(cursor);
                    let holdLen = 0;
                    for (let len = Math.min(6, remaining.length); len >= 1; len--) {
                        const tail = remaining.substring(remaining.length - len);
                        if (tail.charAt(0) === '<' && ('<step'.startsWith(tail) || '</step'.startsWith(tail))) {
                            holdLen = len;
                            break;
                        }
                    }
                    if (holdLen > 0) {
                        clean += remaining.substring(0, remaining.length - holdLen);
                        _stepTagHold = remaining.substring(remaining.length - holdLen);
                    } else {
                        clean += remaining;
                    }
                    break;
                }

                // 取最先出现的标记
                let tagIdx, isCloseTag = false;
                if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
                    tagIdx = openIdx;
                } else {
                    tagIdx = closeIdx;
                    isCloseTag = true;
                }

                if (!isCloseTag) {
                    // 开标签：检查 <step 后面是否是空白/斜杠/尖括号（排除 <steps> 等）
                    const charAfter = raw.charAt(tagIdx + 5);
                    if (charAfter !== '' && charAfter !== ' ' && charAfter !== '\t' &&
                        charAfter !== '\n' && charAfter !== '\r' && charAfter !== '/' &&
                        charAfter !== '>') {
                        clean += raw.substring(cursor, tagIdx + 5);
                        cursor = tagIdx + 5;
                        continue;
                    }
                }

                // 确认是 step 标签，输出之前的内容
                clean += raw.substring(cursor, tagIdx);
                // 查找标记结束 >（兼容 /> 和 >）
                const afterTag = raw.substring(tagIdx);
                const gtIdx = afterTag.indexOf('>');
                if (gtIdx === -1) {
                    _stepTagHold = afterTag;
                    break;
                }
                cursor = tagIdx + gtIdx + 1;
            }
            return clean;
        }

        // ========== Computer User (CU) 视觉代理：截图灯箱 ==========
        // 灯箱状态（截图数组 + 当前索引），DOM 单例挂载到 document.body
        let cuLightboxState = { shots: [], index: 0 };
        function ensureCuLightbox() {
            let lb = document.getElementById('cuLightbox');
            if (lb) return lb;
            lb = document.createElement('div');
            lb.className = 'cu-lightbox';
            lb.id = 'cuLightbox';
            lb.setAttribute('aria-hidden', 'true');
            lb.innerHTML =
                '<div class="cu-lightbox-overlay"></div>' +
                '<button class="cu-lightbox-close" id="cuLightboxClose" aria-label="关闭">&times;</button>' +
                '<button class="cu-lightbox-prev" id="cuLightboxPrev" aria-label="上一张">&#8249;</button>' +
                '<img class="cu-lightbox-img" id="cuLightboxImg" src="" alt="截图预览" />' +
                '<button class="cu-lightbox-next" id="cuLightboxNext" aria-label="下一张">&#8250;</button>' +
                '<div class="cu-lightbox-counter" id="cuLightboxCounter">1 / 1</div>';
            document.body.appendChild(lb);
            // 点击遮罩 / 关闭按钮
            lb.querySelector('.cu-lightbox-overlay').addEventListener('click', closeCuLightbox);
            document.getElementById('cuLightboxClose').addEventListener('click', function(e) { e.stopPropagation(); closeCuLightbox(); });
            document.getElementById('cuLightboxPrev').addEventListener('click', function(e) { e.stopPropagation(); cuLightboxNav(-1); });
            document.getElementById('cuLightboxNext').addEventListener('click', function(e) { e.stopPropagation(); cuLightboxNav(1); });
            // 键盘：ESC 关闭 / ← → 翻页
            document.addEventListener('keydown', function(e) {
                const lb2 = document.getElementById('cuLightbox');
                if (!lb2 || lb2.getAttribute('aria-hidden') === 'true') return;
                if (e.key === 'Escape') { closeCuLightbox(); }
                else if (e.key === 'ArrowLeft') { cuLightboxNav(-1); }
                else if (e.key === 'ArrowRight') { cuLightboxNav(1); }
            });
            return lb;
        }
        function openCuLightbox(screenshots, startIndex) {
            const lb = ensureCuLightbox();
            cuLightboxState.shots = Array.isArray(screenshots) ? screenshots : [];
            cuLightboxState.index = cuLightboxState.shots.length
                ? Math.max(0, Math.min(startIndex || 0, cuLightboxState.shots.length - 1))
                : 0;
            lb.classList.add('show');
            lb.setAttribute('aria-hidden', 'false');
            renderCuLightbox();
        }
        function closeCuLightbox() {
            const lb = document.getElementById('cuLightbox');
            if (!lb) return;
            lb.classList.remove('show');
            lb.setAttribute('aria-hidden', 'true');
        }
        // 循环翻页（到末尾后回到开头）
        function cuLightboxNav(delta) {
            const shots = cuLightboxState.shots;
            if (!shots.length) return;
            cuLightboxState.index = (cuLightboxState.index + delta + shots.length) % shots.length;
            renderCuLightbox();
        }
        function renderCuLightbox() {
            const shots = cuLightboxState.shots;
            const idx = cuLightboxState.index;
            const img = document.getElementById('cuLightboxImg');
            const counter = document.getElementById('cuLightboxCounter');
            if (!shots.length) { closeCuLightbox(); return; }
            const shot = shots[idx] || shots[0];
            if (img) img.src = 'data:image/png;base64,' + (shot.image || '');
            if (counter) counter.textContent = (idx + 1) + ' / ' + shots.length;
        }

        // 强制确保停止按钮可见（在模型生成过程中）
        function ensureStopButtonVisible() {
            const btn = document.getElementById('sendBtn');
            if (!btn) return;
            if (btn.getAttribute('data-state') !== 'stop') {
                btn.setAttribute('data-state', 'stop');
                btn.innerHTML = STOP_ICON_SVG;
            } else {
                // 状态属性正确，但检查 innerHTML 是否还是SVG（防止innerHTML被意外清空）
                if (!btn.querySelector('svg')) {
                    btn.innerHTML = STOP_ICON_SVG;
                }
            }
        }

        // 恢复发送按钮状态
        function resetSendButton() {
            const btn = document.getElementById('sendBtn');
            if (!btn) return;
            btn.removeAttribute('data-state');
            btn.innerHTML = SEND_ICON_HTML;
        }

        // 启动卡顿检测器
        function startStallDetector() {
            stopStallDetector();
            lastSSEEventTime = Date.now();
            // 每 1.5 秒检查一次，确保停止图标始终可见
            stallCheckInterval = setInterval(function() {
                // 模型已结束，停止检测
                if (!window.isSendingMessage || !currentAbortController) {
                    stopStallDetector();
                    return;
                }
                // 强制确保停止按钮可见（关键修复：防止卡顿时停止图标消失）
                ensureStopButtonVisible();
                // 检测长时间无事件（仅记录日志，不自动停止）
                if (currentPendingApprovals().length) { window._stallWarned = false; return; }
                const elapsed = Date.now() - lastSSEEventTime;
                if (elapsed > 60000) {
                    // 超过60秒无事件，提示用户但保持停止图标可见
                    if (window._stallWarned !== true) {
                        window._stallWarned = true;
                        console.warn('模型已' + Math.floor(elapsed / 1000) + '秒无响应，可点击停止按钮终止');
                    }
                } else {
                    window._stallWarned = false;
                }
            }, 1500);
        }

        // 停止卡顿检测器
        function stopStallDetector() {
            if (stallCheckInterval) {
                clearInterval(stallCheckInterval);
                stallCheckInterval = null;
            }
            lastSSEEventTime = 0;
            window._stallWarned = false;
        }
        // ========== 模型卡顿检测器结束 ==========
        
        // ── 桌宠气泡：AI 回答同步推送（脚本顶层，sendMessage 外）─────────
        //   SSE content 事件里 350ms 节流把原文推给 C# 桥 petChat，
        //   代码/命令/markdown 清洗与摘要提炼在 C# 侧（PetWindow）统一做。
        let petChatBindPromise = null;
        let petChatLastPushAt = 0;
        let petChatWillSpeak = false;   // 桌宠接管朗读时，应用侧短句播报（trySpeakShortReply）让位
        function ensurePetChatBridge() {
            if (petChatBindPromise) return petChatBindPromise;
            if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync) return Promise.resolve();
            petChatBindPromise = CefSharp.BindObjectAsync('petChat').then(function(result) {
                if (!window.petChat && result && typeof result.updateReply === 'function') {
                    window.petChat = result;
                }
            }).catch(function() { petChatBindPromise = null; });
            return petChatBindPromise;
        }
        function petChatRefreshSpeakGate() {
            // 每次发消息时刷新：桌宠可见且 TTS 开启 → 朗读交给桌宠
            try {
                if (window.petChat && typeof window.petChat.shouldSpeakForPet === 'function') {
                    window.petChat.shouldSpeakForPet().then(function(v) { petChatWillSpeak = !!v; }).catch(function() {});
                } else {
                    petChatWillSpeak = false;
                }
            } catch (e) {}
        }
        function petChatPushReply(text, force) {
            try {
                if (!text) return;
                if (window.petChat && typeof window.petChat.updateReply === 'function') {
                    const now = Date.now();
                    if (!force && now - petChatLastPushAt < 350) return;
                    petChatLastPushAt = now;
                    window.petChat.updateReply(text);
                } else {
                    ensurePetChatBridge();
                }
            } catch (e) {}
        }
        function petChatSpeakGate() {
            // 朗读闸门：实时语音对话发送的 → 恒 true（无论语音播报开关）；
            //           PTT / 打字发送的 → 跟随「语音播报」开关
            var viaVoiceChat = !!window.__moonyaSendViaVoiceChat;
            var broadcastOn = (typeof isVoiceBroadcastEnabled !== 'undefined') ? !!isVoiceBroadcastEnabled : false;
            return viaVoiceChat || broadcastOn;
        }
        function petChatFinishReply(text) {
            // 回答完成：推最终全文 + 朗读闸门结果（C# 侧据此决定是否朗读摘要）
            try {
                if (!text) return;
                var speak = petChatSpeakGate();
                window.__moonyaSendViaVoiceChat = false;   // 消费后复位，防止泄漏到下一条
                if (window.petChat && typeof window.petChat.finishReply === 'function') {
                    window.petChat.finishReply(text, speak);
                } else {
                    ensurePetChatBridge();
                }
            } catch (e) {}
        }

        const addMessageIntoRuntime = addMessage;
        const addLoadingIndicatorIntoRuntime = addLoadingIndicator;

        // 发送消息函数
        async function sendMessage(overrideText, viaVoiceChat) {
            if (window.MoonYaCanStartTask && !window.MoonYaCanStartTask()) return;
            // Each send owns its completion state; an old abort must not settle a new send.
            let sendSettled = false;
            let streamTurnFinished = false;
            let turnStartedAt = 0;
            let turnBubbleIsLoadingPlaceholder = false;
            let turnLoadingIndicatorEl = null;
            let turnTimelineHostEl = null;
            let pendingRecoverableStreamError = null;
            const messagesContainer = document.querySelector('.messages-container[data-runtime-active="1"]')
                || document.querySelector('.messages-container');
            // addMessage 的第 5 个参数是 prependHtml，第 6 个参数才是目标容器。
            // 这里显式补齐参数，避免把 HTMLDivElement 当作前置 HTML 写进消息。
            const addMessage = (type, content, images = [], imageFileIds = [], prependHtml = '', targetContainer = messagesContainer, skillNames = [], attachmentItems = null) =>
                addMessageIntoRuntime(type, content, images, imageFileIds, prependHtml, targetContainer, skillNames, attachmentItems);
            const addLoadingIndicator = () => addLoadingIndicatorIntoRuntime(messagesContainer);
            let sendRuntime = getConversationRuntime(currentChatId, messagesContainer);
            const sendIsVisible = () => sendRuntime.historyScope === CHAT_HISTORY_KEY && sendRuntime.container.dataset.runtimeActive === '1';
            let runtimeClientMessageId = null;
            let sharedSnapshotTimer = null;
            const publishRuntimeDomSnapshot = function(force) {
                if (!sendRuntime || !sendRuntime.dbConversationId || !window.MoonYaSharedRuntime) return;
                const publish = function() {
                    sharedSnapshotTimer = null;
                    window.MoonYaSharedRuntime.streamEvent({
                        conversationId: sendRuntime.dbConversationId,
                        clientMessageId: runtimeClientMessageId,
                        runId: sendRuntime.activeRunId || null,
                        event: {
                            kind: 'conversation_dom_snapshot',
                            html: sendRuntime.container.innerHTML,
                            scrollTop: sendRuntime.container.scrollTop
                        }
                    }).catch(function() {});
                };
                if (force) {
                    if (sharedSnapshotTimer) clearTimeout(sharedSnapshotTimer);
                    publish();
                } else if (!sharedSnapshotTimer) {
                    sharedSnapshotTimer = setTimeout(publish, 120);
                }
            };
            const finishSendRuntime = function(status) {
                if (!sendRuntime || sendSettled) return;
                sendSettled = true;
                status = status || 'completed';
                publishRuntimeDomSnapshot(true);
                const conversationId = sendRuntime.dbConversationId;
                const isVisibleAiConversation = String(currentChatId || '') === String(sendRuntime.chatId)
                    && !document.body.classList.contains('office-active')
                    && sendRuntime.container
                    && sendRuntime.container.dataset.runtimeActive === '1'
                    && !sendRuntime.container.hidden;
                sendRuntime.running = false;
                sendRuntime.preparing = false;
                syncConversationFollow(sendRuntime);
                sendRuntime.abortController = null;
                sendRuntime.finalizeCancelledResponse = null;
                if (String(currentChatId || '') === String(sendRuntime.chatId)) {
                    currentAbortController = null;
                    window.isSendingMessage = false;
                }
                let sharedFinish = Promise.resolve();
                if (conversationId && window.MoonYaSharedRuntime) {
                    sharedFinish = window.MoonYaSharedRuntime.finish({
                        conversationId: conversationId,
                        clientMessageId: runtimeClientMessageId,
                        status: status
                    }).catch(function() {});
                }
                let viewedRequest = Promise.resolve();
                if (conversationId && isVisibleAiConversation) {
                    viewedRequest = fetch(addTokenToUrl('conversation_api.php?action=mark_viewed'), {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({ conversation_id: conversationId })
                    }).catch(function() {});
                    if (window.MoonYaSharedRuntime) {
                        sharedFinish.then(function() {
                            return window.MoonYaSharedRuntime.markViewed(conversationId);
                        }).catch(function() {});
                    }
                }
                persistConversationDraft(sendRuntime);
                void saveCurrentChat(sendRuntime).catch(error => console.error('会话收尾保存失败:', error));
                if (sendRuntime.mode !== 'chat') return;
                Promise.allSettled([sharedFinish, viewedRequest]).finally(function() {
                    setTimeout(function() { syncChatHistoryFromServer().catch(function() {}); }, 150);
                    setTimeout(function() { syncChatHistoryFromServer().catch(function() {}); }, 1200);
                });
            };

            // 提前绑定桌宠气泡 JS 桥（AI 回答同步显示到桌宠）
            ensurePetChatBridge();
            petChatRefreshSpeakGate();

            // 防止重复发送
            if (sendRuntime && (sendRuntime.running || sendRuntime.preparing)) {

                return;
            }
            if ((typeof pendingWebUploadBatches !== 'undefined' && pendingWebUploadBatches > 0)
                || (typeof uploadingCount !== 'undefined' && uploadingCount > 0)) {
                showToast('附件仍在上传或处理中，请完成后再发送');
                return;
            }
            // Validate everything that can reject the send before entering the
            // running state. Anonymous/empty sends must never flash the stop icon.
            const message = (typeof overrideText === 'string' && overrideText.trim()
                ? overrideText
                : messageInput.value).trim();
            const imagesToSend = [...uploadedImages];
            const selectedSkillsToSend = selectedSkills.filter(name => window.MoonYaPlugins.isEnabled(name));
            const localPathsToSend = localPathSelections.map(function(item) {
                return { ...item };
            });
            let deliveryConfirmed = false;
            function restoreUnconfirmedSubmission() {
                if (deliveryConfirmed || sendRuntime.historyScope !== CHAT_HISTORY_KEY) return;
                // Preserve drafts typed during the request and keep a failed submission editable.
                if (!sendRuntime.draft && (!sendIsVisible() || !messageInput.value)) {
                    sendRuntime.draft = message;
                    sendRuntime.uploadedImages = imagesToSend.slice();
                    sendRuntime.localPaths = localPathsToSend.map(item => ({ ...item }));
                    if (sendRuntime.composer) sendRuntime.composer.selectedSkills = selectedSkillsToSend.slice();
                    if (sendIsVisible()) renderConversationRuntimeComposer(sendRuntime);
                }
                persistConversationDraft(sendRuntime);
            }
            if (!MoonYaAttachments.canSend(message, imagesToSend, localPathsToSend)) {
                return;
            }
            // 未登录只拦「内置模型」：自定义模型走本机 gateway，由用户自备密钥，
            // 本地历史与草稿不受影响。
            if (!isLoggedIn && !window.MoonYaModels?.reference()) {
                showToast('未登录时无法使用内置模型，请登录或配置自定义模型');
                return;
            }
            if (getChatHistory().find(chat => String(chat.id) === String(sendRuntime.chatId))?.archivedAt) {
                showToast('这条会话已归档，请先在归档列表恢复后继续');
                return;
            }
            if (MoonYaClient.state.online === false && !window.MoonYaModels?.reference()) {
                showToast('连接不可用，输入已保留；恢复网络后请手动发送');
                captureConversationComposer(sendRuntime);
                persistConversationDraft(sendRuntime);
                return;
            }
            if (window.MoonYaModels?.ready && !window.MoonYaModels.ready()) {
                showToast('请先配置模型已确认的真实上下文长度');
                return;
            }
            // 语音对话模式发送的（sendMessage(text, true)）：该条回答无论语音播报开关都要朗读
            window.__moonyaSendViaVoiceChat = !!viaVoiceChat;

            // ★ 全局兜底 try/catch：函数体内任何异常都不能让
            //   isSendingMessage / 发送按钮永远卡死（见函数尾部 catch）
            try {
            if (sendRuntime.permissionUpdate) await sendRuntime.permissionUpdate;
            sendRuntime.preparing = true;
            syncConversationFollow(sendRuntime);
            const submissionScope = sendRuntime.historyScope;
            const submissionMode = sendRuntime.mode;
            const ownedChat = getChatHistory().find(chat => String(chat.id) === String(sendRuntime.chatId));
            const submissionProject = ownedChat && Object.hasOwn(ownedChat, 'workingDirectory')
                ? ownedChat.workingDirectory : sendRuntime.composer?.projectPath || '';
            const submissionReasoning = { effort: reasoningEffort, defaultEffort: reasoningEffort, profile: reasoningProfile, imageDetail: imageDetail };
            const submissionModelRef = window.MoonYaModels ? window.MoonYaModels.reference() : null;
            const submissionBuiltinModel = deepseekModelVersion;
            const submissionContextLimit = contextLimitTokens;
            if (window.MoonYaModels) submissionReasoning.effort = window.MoonYaModels.effort(submissionReasoning.effort);
            await window.MoonYaHistoryStore.initialize(submissionScope);
            if (CHAT_HISTORY_KEY !== submissionScope) throw new Error('登录账号已变化，请在当前账号重新发送');
            const selectedHistory = window.MoonYaHistoryStore.list(submissionScope).find(chat => String(chat.id) === String(sendRuntime.chatId));
            if (selectedHistory && selectedHistory.readOnly) {
                showToast('这条旧历史仅供查看，请新建对话后发送');
                sendRuntime.preparing = false;
                return;
            }
            if (selectedHistory?.archivedAt) {
                showToast('这条会话已归档，请先恢复后继续');
                sendRuntime.preparing = false;
                return;
            }
            // Finish preview preparation before entering the running/stop-button state.
            const localDisplayAttachments = await Promise.all(localPathsToSend.map(item => MoonYaAttachments.local(item, sendRuntime)));
            if (CHAT_HISTORY_KEY !== submissionScope) throw new Error('登录账号已变化，请在当前账号重新发送');
            let sendingChat = selectedHistory;
            if (!sendingChat) {
                sendingChat = await createNewChat({ scope: submissionScope, mode: submissionMode, activate: false, reuse: false,
                    projectPath: submissionProject, projectId: sendRuntime.composer?.projectId });
                const oldKey = sendRuntime.chatId;
                conversationRuntimeContexts.delete(oldKey);
                sendRuntime.chatId = sendingChat.id;
                sendRuntime.container.dataset.conversationRuntime = sendingChat.id;
                conversationRuntimeContexts.set(sendingChat.id, sendRuntime);
                lastConversationByMode.set(submissionScope + ':' + submissionMode, sendingChat.id);
                // The retired new-conversation draft must not resurrect a submitted message after restart.
                void window.MoonYaHistoryStore.saveDraft(submissionScope, oldKey, { draft: '', uploadedImages: [], localPaths: [], composer: null });
                if (sendRuntime.container.dataset.runtimeActive === '1' && CHAT_HISTORY_KEY === submissionScope) {
                    currentChatId = sendingChat.id;
                    currentDbConversationId = null;
                }
            }
            if (CHAT_HISTORY_KEY !== submissionScope) throw new Error('登录账号已变化，请在当前账号重新发送');
            sendRuntime.preparing = false;
            sendRuntime.changeTurn = null;
            sendRuntime.running = true;
            syncConversationFollow(sendRuntime);
            sendingChat.lastActivityAt = new Date().toISOString();
            sendRuntime.container = messagesContainer;
            sendRuntime.mode = sendingChat.mode;
            const sendingWork = sendRuntime.mode === 'work';
            sendRuntime.dbConversationId = isCloudChat(sendingChat) ? sendingChat.dbConversationId || null : null;
            if (sendIsVisible()) window.isSendingMessage = true;
            
            const clientMessageId = (window.crypto && typeof window.crypto.randomUUID === 'function')
                ? window.crypto.randomUUID()
                : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
                });
            runtimeClientMessageId = clientMessageId;
            sendRuntime.clientMessageId = clientMessageId;
            
            // 普通模式：使用关键词匹配处理常见请求
            // Agent模式下由AI通过Function Calling自主决策，跳过硬编码匹配
            if (!sendingWork) {
            // 检查是否是音乐请求
            const musicKeywords = ['随便来点音乐吧～', '来点音乐', '推荐音乐', '播放音乐', '音乐推荐', '想听音乐', '给我推荐几首歌', '推荐几首歌', '有什么好听的音乐', '好听的音乐'];
            const isMusicRequest = musicKeywords.some(keyword => message.includes(keyword));
            
            if (isMusicRequest) {
                handleMusicRequest(message);
                finishSendRuntime();
                return;
            }
            
            const horoscopeKeywords = ['星座运势', '查看星座', '星座运程', '今日运势', '本周运势', '本月运势', '运势占卜', '星座占卜'];
            const isHoroscopeRequest = horoscopeKeywords.some(keyword => message.includes(keyword));
            
            if (isHoroscopeRequest) {
                handleHoroscopeRequest();
                finishSendRuntime();
                return;
            }

            const weatherKeywords = ['今天天气', '今天的天气', '明天天气', '明天的天气', '后天天气', '后天的天气', '查看天气', '天气查询', '天气预报', '实时天气', '当前天气', '天气情况', '天气怎么样', '天气如何', '什么天气', '查天气'];
            const isWeatherRequest = weatherKeywords.some(keyword => message.includes(keyword));
            let weatherCity = null;
            if (isWeatherRequest) {
                const cityPatterns = [
                    /([^\s]{2,5}?)(?:的?天气|天气查询|天气预报)/,
                    /(?:查看|查询)([^\s]{2,5}?)(?:的?天气)/
                ];
                for (const pattern of cityPatterns) {
                    const match = message.match(pattern);
                    if (match && match[1]) {
                        const candidate = match[1].replace(/的$/, '');
                        if (!weatherKeywords.includes(candidate) && candidate.length >= 2) {
                            weatherCity = candidate;
                        }
                        break;
                    }
                }
            }
            
            if (isWeatherRequest) {
                handleWeatherRequest(weatherCity);
                finishSendRuntime();
                return;
            }
            } // end !isAgentMode
            
            // 隐藏主标题
            if (sendIsVisible()) document.querySelector('.main-title').style.display = 'none';
            // 隐藏热点按钮
            const hotTopicsContainer = document.querySelector('.hot-topics-container');
            if (hotTopicsContainer && sendIsVisible()) hotTopicsContainer.style.display = 'none';

            // 切换为停止图标（立即执行，不使用 setTimeout）
            const sendButton = sendIsVisible() ? document.getElementById('sendBtn') : null;
            if (sendButton) {

                sendButton.setAttribute('data-state', 'stop');
                sendButton.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#ffffff" xmlns="http://www.w3.org/2000/svg" class="block size-18"><g clip-path="url(#clip0_299_3088)"><path d="M12 0.5C18.3513 0.5 23.5 5.64873 23.5 12C23.5 18.3513 18.3513 23.5 12 23.5C5.64873 23.5 0.5 18.3513 0.5 12C0.5 5.64873 5.64873 0.5 12 0.5ZM12 2.5C6.75329 2.5 2.5 6.75329 2.5 12C2.5 17.2467 6.75329 21.5 12 21.5C17.2467 21.5 21.5 17.2467 21.5 12C21.5 6.75329 17.2467 2.5 12 2.5ZM12.5 7.5C14.3856 7.5 15.3283 7.50015 15.9141 8.08594C16.4998 8.67172 16.5 9.61438 16.5 11.5V12.5C16.5 14.3856 16.4998 15.3283 15.9141 15.9141C15.3283 16.4998 14.3856 16.5 12.5 16.5H11.5C9.61438 16.5 8.67172 16.4998 8.08594 15.9141C7.50015 15.3283 7.5 14.3856 7.5 12.5V11.5C7.5 9.61438 7.50015 8.67172 8.08594 8.08594C8.67172 7.50015 9.61438 7.5 11.5 7.5H12.5Z" fill="#ffffff"></path></g><defs><clipPath id="clip0_299_3088"><rect width="24" height="24" fill="#ffffff"></rect></clipPath></defs></svg>';

                // 启动卡顿检测器，持续确保停止图标可见
                startStallDetector();

            } else {

            }
            
            const displayAttachments = imagesToSend.map(item => MoonYaAttachments.uploaded(item));
            displayAttachments.push(...localDisplayAttachments);
            displayAttachments.sort((left, right) => left.order - right.order);
            const displayImages = MoonYaAttachments.serialize(displayAttachments).images;
            addMessage('user', message, displayImages, [], '', sendRuntime.container, selectedSkillsToSend, displayAttachments);
            const currentUserMessages = messagesContainer.querySelectorAll('.message.user');
            const currentUserMessage = currentUserMessages[currentUserMessages.length - 1];
            if (currentUserMessage) {
                currentUserMessage.dataset.clientMessageId = clientMessageId;
            }
            
            if (sendingWork) {
                sendingChat.attachments = sendingChat.attachments || [];
                for (const attachment of imagesToSend.filter(item => item.local_only)) {
                    const archived = await window.MoonYaHistoryStore.loadAttachment(sendRuntime.historyScope, attachment.cache_chat_id, attachment.file_id)
                        .catch(() => null);
                    await window.MoonYaHistoryStore.saveAttachment(sendRuntime.historyScope, sendRuntime.chatId, attachment.file_id,
                        archived || { dataUrl: attachment.base64_url, text: attachment.file_text, relativePath: attachment.relative_path });
                    if (!sendingChat.attachments.some(item => item.id === attachment.file_id)) {
                        sendingChat.attachments.push({ id: attachment.file_id, name: attachment.filename, relativePath: attachment.relative_path, category: attachment.category });
                    }
                }
            }

            // 清空输入框（语音直发 overrideText 时不碰用户正在输入的内容）
            if ((typeof overrideText !== 'string' || !overrideText.trim()) && sendRuntime.container.dataset.runtimeActive === '1') {
                messageInput.value = '';
            }
            // 清空上传的图片
            sendRuntime.uploadedImages = [];
            sendRuntime.localPaths = [];
            sendRuntime.draft = (typeof overrideText === 'string' && overrideText.trim()) ? sendRuntime.draft : '';
            if (sendRuntime.container.dataset.runtimeActive === '1') {
                uploadedImages = [];
                localPathSelections = [];
                selectedSkills = [];
                renderSelectedSkills();
            }
            persistConversationDraft(sendRuntime);
            // 等待当前用户消息完成幂等保存，确保数据库对话 ID 已建立，
            // 并避免保存请求与 AI 请求并发导致当前消息被重复拼进历史。
            await saveCurrentChat(sendRuntime);
            const savedRuntimeChat = getChatHistory().find(chat => String(chat.id) === String(sendRuntime.chatId));
            if (savedRuntimeChat && savedRuntimeChat.dbConversationId) {
                sendRuntime.dbConversationId = savedRuntimeChat.dbConversationId;
            }
            
            if (typeof window.resetWebAttachmentBatch === 'function') {
                window.resetWebAttachmentBatch();
            }
            if (sendIsVisible()) document.getElementById('uploadContainer').innerHTML = '';
            if (sendIsVisible()) captureConversationComposer(sendRuntime);
            else persistConversationDraft(sendRuntime);
            
            // 恢复输入框高度
            if (sendIsVisible()) messageInput.style.height = '40px';
            
            // 显示加载状态（先显示，避免延迟）
            const loadingId = addLoadingIndicator();
            // ★ 时间线计时的起点：本轮 AI 输出的开始时刻
            turnStartedAt = Date.now();
            turnBubbleIsLoadingPlaceholder = false;
            turnLoadingIndicatorEl = null;
            turnTimelineHostEl = null;
            streamTurnFinished = false;
            pendingRecoverableStreamError = null;
            // 本轮是否由主对话过程区接管，每轮重新判定：上一轮是 Agent 轮次
            //   不代表这一轮也是（用户可能切回非 Agent 模式，那一轮仍要气泡内的旧表头）。
            window.__moonyaDshTurnProcess = false;
            window.__moonyaTurnStartedAt = 0;
            
            // 专精模式：进行路由分析（在显示加载状态后进行）
            let specialistSteps = null;
            
            if (isSpecialistMode) {
                
                const routeInfo = await analyzeAndRoute(message);
                
                if (routeInfo && routeInfo.reason) {
                    // 将路由分析解析为步骤数组
                    specialistSteps = formatSpecialistAnalysis(routeInfo.reason);
                    
                } else {
                    
                }
            }
            
            // 创建中断控制器
            const sendController = new AbortController();
            sendRuntime.abortController = sendController;
            if (sendIsVisible()) currentAbortController = sendController;
            const signal = sendController.signal;
            
            // 项目已统一为 DeepSeek：五档设置是唯一可信来源，“不思考”才关闭思考。
            const deepThinking = reasoningEffort !== 'none';
            // 专家模式也是深度思考，但不使用联网搜索
            const isExpertModeActive = isExpertMode;
            
            // 创建AI消息容器
            let aiMessageDiv = null;
            let aiContentDiv = null;
            let aiThinkingDiv = null;
            // ★ 跨 execution_code / stream_reset / agent_switch 保持单一活跃思考框，
            //   防止多轮工具调用产生大量重复空思考框架。
            let activeThinkingWrapper = null;
            // ★ Computer User 视觉代理：当前任务截图序列（每条消息独立）
            let currentCuScreenshots = [];
            // ★ 流式顺序：命令执行块优先挂在操作记录折叠菜单内，按到达顺序排列
            let lastExecBlock = null;
            let fullReply = '';
            let fullReplyForRender = '';
            let fullThinking = '';
            let inCodeBlock = false;
            let currentCodeBlockWrapper = null;
            let currentCodeContentDiv = null;
            let currentCodeFilename = 'plaintext';
            let codeBuffer = '';
            let currentTextDiv = null;
            let currentTextContent = '';
            let streamRenderDone = false;
            let voiceShortReplySpoken = false;
            // 专精模式流式输出完成标志
            let specialistStreamingComplete = !specialistSteps;

            // ★ 修复：流式渲染节流状态
            //   原代码每收到一个 SSE chunk 就调用 parseMarkdown()/highlightCode() 重新渲染
            //   整段累积内容，复杂度 O(n²)。长内容会冻结主线程 → 无法消费 SSE →
            //   TCP 缓冲区满 → PHP socket 写入阻塞 → default_socket_timeout 触发 → "network error"。
            //   改用 RAF 节流：每帧最多渲染一次，并把流式中的代码高亮降级为纯文本追加。
            let textRenderRafPending = false;
            let thinkingRenderRafPending = false;
            let codeRenderRafPending = false;
            let scrollRafPending = false;

            // ★ 统一判空工具函数：检查思考内容是否实质为空。
            //   trim() 只去除常规空白（\s），无法去除 Unicode 零宽空格（\u200B）、
            //   不间断空格（\u00A0）、零宽连字/非连字（\u200C\u200D）、BOM（\uFEFF）、
            //   行/段分隔符（\u2028\u2029）等"视觉空"字符。
            //   LLM 的 reasoning_content 可能包含这些字符，导致 fullThinking.trim() 为 true
            //   但视觉上无任何内容，从而创建大量"看起来是空的"思考折叠框。
            //   此函数把所有 Unicode 空白字符一并去除后再判空，作为唯一的判据。
            //   ★ 定义已上移到顶层：script-1c-save.php 历史回放要跨 <script> 块调用它。

            // 统一创建/复用思考折叠框，防止同一 loadingId 出现多个重复框或空框
            // ★ dedup 合并思考内容：兼容后端推送"增量 delta"或"累积全文"两种模式，
            //   避免因后端整段重发累积 buffer 导致前端 fullThinking 指数级重复。
            function mergeThinkingUnique(existing, incoming) {
                if (!incoming) return existing || '';
                if (!existing) return incoming;
                if (incoming === existing) return existing;          // 完全相同，跳过
                if (existing.endsWith(incoming)) return existing;     // 已有相同尾部，跳过
                if (incoming.startsWith(existing)) return incoming;   // incoming 是 existing 的累积扩展，替换
                if (incoming.includes(existing)) {
                    // incoming 内部某处包含 existing，保留 incoming 整段（重传/乱序）
                    return incoming;
                }
                // 否则视为 delta 增量，直接追加
                return existing + incoming;
            }

            // 清理指定容器内空的思考框架，避免空框堆积
            //   判据：用 isThinkingEmpty(textContent) 作为唯一标准，
            //   兼容 <br> / &nbsp; / 纯空白字符 / Unicode 零宽空格等"视觉空"内容。
            //   不依赖 loadingId 标记，避免被 stream_reset/agent_switch 移除 id 的旧 wrapper 漏判。
            function removeEmptyThinkingWrappers(container) {
                if (!container) return;
                const wrappers = container.querySelectorAll('.thinking-wrapper');
                var removedCount = 0;
                wrappers.forEach(function(w) {
                    const text = w.querySelector('.thinking-text');
                    if (isThinkingEmpty(text ? text.textContent : '')) {
                        console.log('[removeEmptyThinkingWrappers] removing wrapper id=' + (w.id || '(none)') + ', textContent="' + ((text && text.textContent) || '') + '"');
                        w.remove();
                        removedCount++;
                    }
                });
                if (removedCount > 0) {
                    console.log('[removeEmptyThinkingWrappers] removed ' + removedCount + ' empty wrappers from ' + (container === messagesContainer ? 'messagesContainer' : 'aiMessageDiv'));
                }
            }




            // ========== AI 输出时间线（主对话区域扁平行）==========
            // @timeline-helpers-start
            // 每条 AI 回复渲染成一条连续时间线：头部"本轮过程 / 用时 X"行 + 正文段落与
            //   工具过程行按发生顺序交错排列，全部挂在同一个 .message-content 内。
            //   过程行不再收进默认收起的折叠菜单，也不再挂到气泡外面（避免与正文左边缘错位）。

            // 本轮耗时格式化（与 DSH 的 duration.* 中文格式一致）。
            // ★ 定义已上移到顶层：主对话过程区的 updateTurnProcessLabel（IIFE 顶层）
            //   也用它。留在这里会让那一行抛 "formatTurnDuration is not defined"，
            //   整段 turn.completed 处理（表头用时、思考行定稿、工作日志收尾）全部中断。



            // 头部耗时文案：仅替换 .turn-time 文本，不重建头部（避免丢失展开态）
            function setTimelineElapsed(contentEl, elapsedMs) {
                if (!contentEl) return;
                var timeEl = contentEl.querySelector('.turn-time');
                var titleEl = contentEl.querySelector('.turn-title');
                if (titleEl) titleEl.textContent = '用时 ' + formatTurnDuration(elapsedMs);
                if (timeEl) timeEl.textContent = '';
                codexFinalizeInlineTimeline(contentEl);
                if (contentEl.closest) {
                    var host = contentEl.closest('.message.ai');
                    if (host) {
                        MoonYaProcessUI.endDuration(host, elapsedMs);
                    }
                }
            }

            // Convert the legacy inline stream into the same two-part shape as
            // Codex: a collapsible chronological work log followed by the final
            // answer.  The last activity is the boundary; everything before it
            // is commentary/work, while content after it remains the delivery.
            function codexFinalizeInlineTimeline(contentEl) {
                if (!contentEl) return;
                const sequence = contentEl.closest('.message')?.__processSequence;
                if (sequence) MoonYaProcessUI.finish(sequence);
            }

            function codexGroupInlineActivities(contentEl, header) {
                var children = Array.from(contentEl.children);
                var runs = [];
                var current = [];
                children.forEach(function(child) {
                    var activity = child !== header && child.matches &&
                        child.matches('.process-row, .execution-block-host');
                    if (activity) current.push(child);
                    else if (current.length) { runs.push(current); current = []; }
                });
                if (current.length) runs.push(current);
                runs.forEach(function(nodes) {
                    if (!nodes.length || nodes[0].closest('.codex-activity-group')) return;
                    var group = document.createElement('section');
                    group.className = 'codex-activity-group codex-trace-item';
                    var groupHeader = document.createElement('button');
                    groupHeader.type = 'button';
                    groupHeader.className = 'codex-activity-header';
                    groupHeader.setAttribute('aria-expanded', 'false');
                    groupHeader.innerHTML = (getToolIcon('create_file', 16) || '') +
                        '<span class="codex-activity-label"></span>' +
                        '<span class="codex-activity-chevron">' + createWorkflowChevronIcon(14, 'down') + '</span>';
                    var list = document.createElement('div');
                    list.className = 'codex-activity-list';
                    group.append(groupHeader, list);
                    contentEl.insertBefore(group, nodes[0]);
                    var counts = { edit: 0, read: 0, command: 0, image: 0, browser: 0, other: 0 };
                    nodes.forEach(function(node) {
                        var tool = node.getAttribute('data-tool-category') || node.getAttribute('data-tool-name') || '';
                        var kind = codexActivityKind(tool);
                        counts[kind] = (counts[kind] || 0) + 1;
                        node.classList.add('codex-inline-activity');
                        list.appendChild(node);
                    });
                    var parts = [];
                    if (counts.edit) parts.push('编辑了 ' + counts.edit + ' 文件');
                    if (counts.read) parts.push('读取了 ' + counts.read + ' 项');
                    if (counts.command) parts.push('运行了 ' + counts.command + ' 命令');
                    if (counts.image) parts.push('查看了 ' + counts.image + ' 张图像');
                    if (counts.browser) parts.push('执行了 ' + counts.browser + ' 次浏览器操作');
                    if (counts.other) parts.push('执行了 ' + counts.other + ' 项操作');
                    groupHeader.querySelector('.codex-activity-label').textContent = parts.join(' ') || '执行了操作';
                });
            }

            // done / error / abort 等所有出口统一收尾计时：
            //   从当前可见的 AI 消息按 loadingId 找回时间线，写入"用时 X"并记到 data-turn-elapsed。
            function finalizeTurnElapsed(loadingId, aiMessageDiv) {
                if (!turnStartedAt) return;
                var host = aiMessageDiv && aiMessageDiv.isConnected
                    ? aiMessageDiv
                    : findAiMessageByLoadingId(loadingId);
                if (!host) return;
                var contentEl = host.querySelector('.message-content');
                if (contentEl) setTimelineElapsed(contentEl, Date.now() - turnStartedAt);
            }

            // 构造一条过程行 DOM
            function createProcessRow(spec) {
                spec = spec || {};
                var status = spec.status || 'executing';
                var row = document.createElement('div');
                row.className = 'process-row status-' + status;
                row.setAttribute('data-tool-name', spec.tool || '');
                if (spec.tool) row.setAttribute('data-tool-category', spec.tool);
                row.dataset.activityKind = MoonYaProcessUI.kind(spec.tool);
                row.dataset.filePath = spec.path || spec.detail || '';
                row.dataset.toolId = spec.id || String(Date.now()) + ':' + Math.random();

                var icon = document.createElement('span');
                icon.className = 'process-icon';
                icon.innerHTML = makeProcessRowIcon(spec.tool, status);

                var text = document.createElement('span');
                text.className = 'process-text';
                text.textContent = spec.toolText || getRowActionText(spec.tool, spec.label, spec.detail);

                row.appendChild(icon);
                row.appendChild(text);
                // 详情只在失败/错误/停止时展示，避免成功路径刷屏
                if (spec.detail && ['failure', 'error', 'stopped'].indexOf(status) !== -1) {
                    var detailEl = document.createElement('span');
                    detailEl.className = 'process-detail';
                    detailEl.textContent = spec.detail;
                    row.appendChild(detailEl);
                }
                return row;
            }

            // 时间线宿主：保证当前 AI 消息存在 .message-content 与头部行，返回时间线描述对象。
            //   头部行是该 .message-content 的第一个子节点，正文段与过程行都是它的同级兄弟节点。
            function ensureTimeline(aiMessageDiv, loadingId) {
                if (!aiMessageDiv) {
                    aiMessageDiv = findAiMessageByLoadingId(loadingId);
                }
                if (!aiMessageDiv) {
                    aiMessageDiv = document.createElement('div');
                    aiMessageDiv.className = 'message ai';
                    if (typeof currentAgentName !== 'undefined' && currentAgentName) {
                        aiMessageDiv.dataset.agentName = currentAgentName;
                        var senderLabel = document.createElement('div');
                        senderLabel.className = 'message-sender';
                        senderLabel.textContent = currentAgentName;
                        aiMessageDiv.appendChild(senderLabel);
                    }
                }
                // ★ 复用气泡自带的 .message-content（如 addLoadingIndicator 预建的加载气泡），
                //   避免同一气泡里出现第二个正文容器导致内容分裂。
                var contentEl = null;
                var directContent = aiMessageDiv.querySelector(':scope > .message-content');
                if (directContent) {
                    contentEl = directContent;
                } else {
                    contentEl = document.createElement('div');
                    contentEl.className = 'message-content';
                    aiMessageDiv.appendChild(contentEl);
                }

                // ★ 兼容加载气泡：它自身带有 id="loading-<ts>"，是 removeLoadingIndicator 的删除句柄，
                //   因此额外挂一个 data 属性作为时间线宿主标识，不改写它的 id（否则加载态无法移除）。
                if (loadingId) {
                    if (aiMessageDiv.id === loadingId) {
                        aiMessageDiv.setAttribute('data-timeline-loading-id', loadingId);
                        // ★ 复用加载气泡：不能再按加载 id 删除它（删除会连带删掉整条 AI 回复），
                        //   标记后由 appendTimelineItem 跳过删除，并在有内容时单独移除内部加载动画。
                        turnBubbleIsLoadingPlaceholder = true;
                        turnLoadingIndicatorEl = contentEl.querySelector('.loading-indicator');
                    } else {
                        // 切换到新的时间线宿主气泡时才重置加载占位状态；
                        //   同一气泡被重复识别时保留引用，否则后续拿不到 .loading-indicator 无法移除它。
                        if (turnTimelineHostEl !== aiMessageDiv) {
                            aiMessageDiv.id = 'moonya-ai-msg-' + loadingId;
                            // 当前气泡不是加载占位：清掉上一轮的加载动画引用，避免误删新气泡内容
                            turnBubbleIsLoadingPlaceholder = false;
                            turnLoadingIndicatorEl = null;
                        }
                    }
                    turnTimelineHostEl = aiMessageDiv;
                }

                contentEl.querySelectorAll(':scope > .turn-process-header').forEach(node => node.remove());
                if (!useAgentRuntime && !aiMessageDiv.__processSequence) {
                    aiMessageDiv.__processSequence = MoonYaProcessUI.sequence(contentEl, 'chat:' + loadingId,
                        { icon: makeProcessRowIcon, renderTool: renderCodexToolDetail });
                    aiMessageDiv.dataset.processTurn = 'chat:' + loadingId;
                }
                var header = null;

                // 气泡未挂载时立即挂载，保证过程行与正文落在同一棵可见子树
                if (messagesContainer && aiMessageDiv.parentNode !== messagesContainer) {
                    messagesContainer.appendChild(aiMessageDiv);
                }

                MoonYaProcessUI.beginDuration(aiMessageDiv, turnStartedAt);

                return { message: aiMessageDiv, content: contentEl, header: header, loadingId: loadingId };
            }

            function recordCodexViewedImage(aiMessageDiv, loadingId, imageSource) {
                imageSource = String(imageSource || '').trim();
                // 只有拿到真实图片内容时才创建“已查看图片”；普通浏览器操作
                // （fill/click/inspect 等）绝不能被计入图片数量。
                if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]/i.test(imageSource)) return null;
                var tl = ensureTimeline(aiMessageDiv, loadingId);
                var row = tl.content.querySelector(':scope > .codex-viewed-images');
                if (!row) {
                    row = document.createElement('section');
                    row.className = 'codex-viewed-images';
                    row.setAttribute('data-image-count', '0');
                    row.innerHTML = '<div class="codex-system-activity codex-viewed-images-header">' +
                        '<span class="codex-system-icon" aria-hidden="true">' + createWorkflowImageIcon(16) + '</span>' +
                        '<span class="codex-system-label"></span>' +
                        '<span class="codex-viewed-images-chevron" aria-hidden="true">' + createWorkflowChevronIcon(12, 'down') + '</span>' +
                        '</div><div class="codex-viewed-images-grid"></div>';
                    appendTimelineItem(row, tl.message, loadingId);
                }
                var count = Math.max(0, Number(row.getAttribute('data-image-count')) || 0) + 1;
                row.setAttribute('data-image-count', String(count));
                row.querySelector('.codex-system-label').textContent = '已查看 ' + count + ' 张图像';
                var tile = document.createElement('button');
                tile.type = 'button';
                tile.className = 'codex-viewed-image-tile';
                tile.setAttribute('aria-label', '查看图像 ' + count);
                var image = document.createElement('img');
                image.src = imageSource;
                image.alt = '查看的图像 ' + count;
                image.decoding = 'async';
                tile.appendChild(image);
                row.querySelector('.codex-viewed-images-grid').appendChild(tile);
                return row;
            }

            // 复用加载气泡时：正文开始流式输出即移除气泡内的加载动画
            function clearTurnLoadingIndicator() {
                if (!turnBubbleIsLoadingPlaceholder) return;
                if (turnLoadingIndicatorEl && turnLoadingIndicatorEl.isConnected) {
                    turnLoadingIndicatorEl.remove();
                }
                turnLoadingIndicatorEl = null;
            }

            // 把一条时间线元素追加到当前 AI 消息的过程流（正文段之后、当前流末尾）
            function appendTimelineItem(item, aiMessageDiv, loadingId) {
                if (!item) return null;
                // ★ 先记录当前时间线归属，再进入 ensureTimeline —— 后者在识别到新气泡时会重置这两个标记
                var wasLoadingPlaceholder = turnBubbleIsLoadingPlaceholder;
                var tl = ensureTimeline(aiMessageDiv, loadingId);
                if (tl.message.__processSequence && item.matches('.process-row, .execution-block-host, .thinking-wrapper, .codex-viewed-images')) {
                    const segment = MoonYaProcessUI.ensure(tl.message.__processSequence);
                    segment.body.appendChild(item); MoonYaProcessUI.refresh(segment);
                } else tl.content.appendChild(item);
                if (wasLoadingPlaceholder) {
                    // 复用的加载气泡：只移除内部加载动画，保留气泡承载整条 AI 回复
                    clearTurnLoadingIndicator();
                } else {
                    removeLoadingIndicator(loadingId);
                }
                teamScrollIfFollowing(messagesContainer);
                return item;
            }
            // @timeline-helpers-end

            // ── 时间线折叠：头部行点击收起/展开过程行（正文段不受影响）──
            //   ★ 定义已上移到顶层：script-1c-save.php 历史回放会直接调用它重建旧表头。


            // 按 loadingId 找回已被 status 事件预创建的 AI 消息占位
            //   状态事件可能先于 content/thinking 事件到达，aiMessageDiv 局部变量为 null。
            //   ensureTimeline 会在那时预建一个 .message.ai 占位并打上
            //   id="moonya-ai-msg-<loadingId>"，这里供后续 content 流式代码复用，避免出现
            //   "过程行在消息 A，正文在消息 B"的孤儿分裂。
            function findAiMessageByLoadingId(loadingId) {
                if (!loadingId) return null;
                // 加载气泡保留了 id="loading-<ts>"，因此先按时间线宿主标识查找
                var byTimeline = document.querySelector('.message.ai[data-timeline-loading-id="' + loadingId + '"]');
                if (byTimeline) return byTimeline;
                // ★ 首次进入时 data 标识尚未打上：直接按加载 id 找回预建的加载气泡，
                //   否则会新建第二个气泡，把加载占位留在对话流里变成孤儿。
                var placeholder = document.getElementById(loadingId);
                if (placeholder && placeholder.classList && placeholder.classList.contains('message')) {
                    return placeholder;
                }
                return document.getElementById('moonya-ai-msg-' + loadingId);
            }

            // 结束当前正文段：刷新待渲染内容并释放段落引用，
            //   使接下来的过程行与后续 content 事件按发生顺序成为时间线上的兄弟节点。
            function closeContentSegment() {
                flushPendingRenders();
                currentTextDiv = null;
                currentTextContent = '';
                currentCodeBlockWrapper = null;
                currentCodeContentDiv = null;
                currentCodeFilename = 'plaintext';
                codeBuffer = '';
                inCodeBlock = false;
                fullReplyForRender = '';
            }

            // 清理"正在思考下一步操作..."过渡状态条
            //   thinking 状态是瞬时过渡态（"AI 即将开始下一轮思考"），不应作为持久阶段累积进状态条时间线。
            //   生命周期：status:thinking 创建 → 任意下一个事件（思考内容/回复内容/新 status）立即清理。
            //   根治"多轮工具调用导致多个思考条堆积且直到完全输出才消失"的问题。
            function clearTransientThinkingBars(container) {
                if (!container) return;
                var bars = container.querySelectorAll('.agent-status-bar.status-thinking');
                if (bars.length === 0) return;
                bars.forEach(function(b) { b.remove(); });
                console.log('[clearTransientThinkingBars] removed ' + bars.length + ' transient thinking bars');
            }

            // ★ v4.12 终极防御：MutationObserver 监控 DOM 变化
            //   任何新加入 messagesContainer 的 .thinking-wrapper，如果是空的，延迟 200ms 后移除。
            //   延迟是为了避免在 RAF 还没来得及把 thinking 内容写入 DOM 的瞬间误删正常框。
            //   活跃思考框（activeThinkingWrapper）不会被动删除，避免破坏当前正在流式填充的框。
            var _thinkingGuardObserver = null;
            var _pendingGuardChecks = new Map();
            function startThinkingGuard() {
                if (_thinkingGuardObserver) return;
                if (!window.MutationObserver) return;
                if (!messagesContainer) return;
                _thinkingGuardObserver = new MutationObserver(function(mutations) {
                    mutations.forEach(function(mutation) {
                        mutation.addedNodes.forEach(function(node) {
                            if (node.nodeType !== 1) return;
                            var wrappers = [];
                            if (node.classList && node.classList.contains('thinking-wrapper')) {
                                wrappers.push(node);
                            }
                            if (node.querySelectorAll) {
                                node.querySelectorAll('.thinking-wrapper').forEach(function(w) { wrappers.push(w); });
                            }
                            wrappers.forEach(function(w) {
                                if (_pendingGuardChecks.has(w)) return;
                                var timer = setTimeout(function() {
                                    _pendingGuardChecks.delete(w);
                                    if (!w.isConnected) return;
                                    if (w === activeThinkingWrapper) return;
                                    var textEl = w.querySelector('.thinking-text');
                                    if (isThinkingEmpty(textEl ? textEl.textContent : '')) {
                                        console.warn('[ThinkingGuard] removing empty wrapper after delay, id=' + (w.id || '(none)'));
                                        w.remove();
                                    }
                                }, 200);
                                _pendingGuardChecks.set(w, timer);
                            });
                        });
                    });
                });
                _thinkingGuardObserver.observe(messagesContainer, { childList: true, subtree: true });
                console.log('[ThinkingGuard] MutationObserver started on messagesContainer');
            }
            // DOMContentLoaded 后启动（确保 messagesContainer 已存在）
            document.addEventListener('DOMContentLoaded', startThinkingGuard);
            // 如果已加载，立即启动
            if (document.readyState !== 'loading') startThinkingGuard();

            function ensureThinkingWrapper(loadingId, options) {
                options = options || {};
                // ★ 入口全局清理：每次进入 ensureThinkingWrapper 时先清理 messagesContainer 内
                //   所有 textContent 为空的 wrapper，避免历史残留的"空折叠框"在多轮工具调用间累积。
                //   不依赖 loadingId 标记，对所有空 wrapper 一视同仁。
                removeEmptyThinkingWrappers(messagesContainer);
                // ★ 修复：优先在 aiMessageDiv 子树中查找 wrapper。
                //   thinking 事件先于 content 事件到达时，aiMessageDiv 尚未挂载到 document，
                //   document.getElementById() 找不到 detached 节点里的 wrapper，导致每个
                //   thinking 事件都新建一个空 wrapper 堆在同一个 aiMessageDiv 里。
                //   改用 aiMessageDiv.querySelector() 可兼容 detached 节点，避免重复创建。
                let wrapper = aiMessageDiv ? aiMessageDiv.querySelector('#thinking-wrapper-' + loadingId) : null;
                if (!wrapper) {
                    wrapper = document.getElementById('thinking-wrapper-' + loadingId);
                }
                // 兜底：同一消息气泡内若已存在任何 thinking-wrapper（例如 id 被 stream_reset/agent_switch 移除后），
                // 直接复用，避免同一轮对话出现多个重复框架。
                if (!wrapper && aiMessageDiv) {
                    wrapper = aiMessageDiv.querySelector('.thinking-wrapper');
                }
                // ★ 跨执行块/agent切换复用同一活跃思考框：多轮工具调用之间
                //   会触发 execution_code / stream_reset / agent_switch 重置 aiMessageDiv，
                //   导致每轮都新建一个思考框。这里把活跃思考框提升到请求级别，避免重复堆积。
                if (!wrapper && activeThinkingWrapper && activeThinkingWrapper.isConnected) {
                    wrapper = activeThinkingWrapper;
                }
                if (wrapper) {
                    activeThinkingWrapper = wrapper;
                    // 若活跃框来自历史复用（id/loadingId 可能被 stream_reset/agent_switch 移除），补回标识
                    if (!wrapper.id && loadingId) {
                        wrapper.id = 'thinking-wrapper-' + loadingId;
                    }
                    if (!wrapper.dataset.loadingId && loadingId) {
                        wrapper.dataset.loadingId = loadingId;
                    }
                    // ★ 时间线：复用的思考框直接移入当前时间线末尾，保证思考内容跟随最新输出
                    if (aiMessageDiv || !wrapper.isConnected) {
                        ensureTimeline(aiMessageDiv, loadingId).content.appendChild(wrapper);
                    }
                    // ★ 同步填充：复用路径下若 .thinking-text 实际为空且 fullThinking 已有内容，
                    //   立即同步写入，避免 RAF 延迟造成的瞬时空状态。
                    const reusedTextEl = wrapper.querySelector('.thinking-text');
                    if (reusedTextEl && !isThinkingEmpty(fullThinking) && isThinkingEmpty(reusedTextEl.textContent)) {
                        reusedTextEl.innerHTML = renderThinkingContent(fullThinking);
                    }
                    return wrapper;
                }

                // 创建新框架前，先清理当前消息气泡内以及全局已有的空框架
                if (aiMessageDiv) {
                    removeEmptyThinkingWrappers(aiMessageDiv);
                }
                removeEmptyThinkingWrappers(messagesContainer);

                // ★ 强制兜底：清理同一次请求（同 loadingId）下遗留的旧思考框，
                //   避免 activeThinkingWrapper 失效或脚本缓存旧逻辑时产生多个框架。
                //   只保留仍挂载在 DOM 中的活跃思考框；若活跃框已被移除，同步清空引用。
                if (activeThinkingWrapper && !activeThinkingWrapper.isConnected) {
                    activeThinkingWrapper = null;
                }
                if (messagesContainer && loadingId) {
                    messagesContainer.querySelectorAll('.thinking-wrapper[data-loading-id="' + loadingId + '"]').forEach(function(w) {
                        if (w !== activeThinkingWrapper) {
                            console.log('[ensureThinkingWrapper] removing stale wrapper with same loadingId, id=' + (w.id || '(none)'));
                            w.remove();
                        }
                    });
                    // ★ 额外保险：通过 id 查找（旧 wrapper 若 id 未被 stream_reset 清除则可找到）
                    var byId = document.getElementById('thinking-wrapper-' + loadingId);
                    if (byId && byId !== activeThinkingWrapper) {
                        console.log('[ensureThinkingWrapper] removing stale wrapper found by document.getElementById');
                        byId.remove();
                    }
                }

                // ★ 终极兜底：创建新 wrapper 后，遍历同 loadingId 的全部 wrapper，
                //   只保留最后创建的一个；多余的强制执行删除。
                var createdCount = 0;
                if (messagesContainer && loadingId) {
                    var allSameLid = messagesContainer.querySelectorAll('.thinking-wrapper[data-loading-id="' + loadingId + '"]');
                    if (allSameLid.length > 0) {
                        console.log('[ensureThinkingWrapper] WARNING: found ' + allSameLid.length + ' existing wrappers with same loadingId before creating new one');
                        allSameLid.forEach(function(w) {
                            if (w !== activeThinkingWrapper) {
                                console.log('[ensureThinkingWrapper] force-removing extra wrapper, id=' + (w.id || '(none)'));
                                w.remove();
                            }
                            createdCount++;
                        });
                    }
                }

                // 调试日志：记录新建思考框的触发条件
                console.log('[ensureThinkingWrapper] creating new wrapper, loadingId=' + loadingId +
                            ', activeConnected=' + !!(activeThinkingWrapper && activeThinkingWrapper.isConnected) +
                            ', aiMessageDiv=' + !!aiMessageDiv +
                            ', existingCount=' + createdCount);

                // 确保消息容器存在
                if (!aiMessageDiv) {
                    aiMessageDiv = document.createElement('div');
                    aiMessageDiv.className = 'message ai';
                    if (currentAgentName) {
                        aiMessageDiv.dataset.agentName = currentAgentName;
                        const senderLabel = document.createElement('div');
                        senderLabel.className = 'message-sender';
                        senderLabel.textContent = currentAgentName;
                        aiMessageDiv.appendChild(senderLabel);
                    }
                }

                wrapper = document.createElement('div');
                wrapper.className = 'thinking-wrapper';
                wrapper.id = 'thinking-wrapper-' + loadingId;
                wrapper.dataset.loadingId = loadingId;

                const thinkingHeader = document.createElement('div');
                thinkingHeader.className = 'thinking-header';
                thinkingHeader.onclick = function() {
                    const w = this.parentElement;
                    const toggle = w.querySelector('.thinking-toggle');
                    const text = w.querySelector('.thinking-text');
                    const completed = w.querySelector('.thinking-completed');
                    if (toggle) toggle.classList.toggle('expanded');
                    if (text) text.classList.toggle('expanded');
                    if (completed) completed.classList.toggle('collapsed');
                };

                const thinkingLabel = document.createElement('span');
                thinkingLabel.className = 'thinking-label';
                thinkingLabel.id = 'thinking-label-' + loadingId;
                thinkingLabel.textContent = options.completed ? '已完成思考' : '思考内容';
                if (options.completed) thinkingLabel.classList.add('completed');

                const thinkingToggle = document.createElement('span');
                thinkingToggle.className = 'thinking-toggle';
                thinkingToggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="vertical-align: middle;"><path d="M21.5627 8.86518C21.8751 8.55276 21.8751 8.04674 21.5627 7.73432C21.2502 7.4219 20.7442 7.4219 20.4318 7.73432L12.3117 15.8544C12.1555 16.0106 11.9015 16.0106 11.7453 15.8544L3.62517 7.73432C3.31275 7.4219 2.80673 7.4219 2.49431 7.73432C2.18189 8.04673 2.18189 8.55275 2.49431 8.86517L10.6144 16.9853C11.3955 17.7663 12.6615 17.7663 13.4425 16.9853L21.5627 8.86518Z" fill="#999"></path></svg>';

                const thinkingText = document.createElement('div');
                thinkingText.className = 'thinking-text';
                thinkingText.id = 'thinking-text-' + loadingId;

                const thinkingCompleted = document.createElement('div');
                thinkingCompleted.className = 'thinking-completed collapsed';
                thinkingCompleted.id = 'thinking-completed-' + loadingId;
                thinkingCompleted.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 24 24" style="margin-right: 6px; vertical-align: middle;"><path fill="currentColor" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18m0 2C5.925 23 1 18.075 1 12S5.925 1 12 1s11 4.925 11 11-4.925 11-11 11m-1.16-8.72 4.952-4.952a.996.996 0 0 1 1.409.005 1 1 0 0 1 .007 1.41c-1.888 1.905-3.752 3.842-5.685 5.7a.98.98 0 0 1-1.364-.001c-1.01-.98-1.993-1.992-2.983-2.993a1.003 1.003 0 0 1 .005-1.414 1 1 0 0 1 1.412-.002z"></path></svg><span style="color: var(--theme-muted, #999); font-size: 12px;">已完成</span>';

                thinkingHeader.appendChild(thinkingLabel);
                thinkingHeader.appendChild(thinkingToggle);
                wrapper.appendChild(thinkingHeader);
                wrapper.appendChild(thinkingText);
                wrapper.appendChild(thinkingCompleted);

                // ★ 时间线：思考框插到当前时间线的末尾（即上一段正文/过程行之后），
                //   而不是固定插到正文之前——正文与过程行按发生顺序交错排列。
                wrapper.classList.add('thinking-row');
                var _tlForThinking = ensureTimeline(aiMessageDiv, loadingId);
                _tlForThinking.content.appendChild(wrapper);

                // ★ 同步填充：新创建的 wrapper 默认 .thinking-text 为空，
                //   若 fullThinking 已有内容（如复用前的累积思考），立即同步写入，
                //   避免 RAF 延迟期间 wrapper 视觉上"只有标题的空折叠框"。
                const newTextEl = wrapper.querySelector('.thinking-text');
                if (newTextEl && !isThinkingEmpty(fullThinking)) {
                    newTextEl.innerHTML = renderThinkingContent(fullThinking);
                }

                activeThinkingWrapper = wrapper;
                return wrapper;
            }

            // 节流渲染：累积 currentTextContent，每帧最多调用一次 parseMarkdown
            function scheduleTextRender() {
                if (textRenderRafPending || streamRenderDone) return;
                textRenderRafPending = true;
                requestAnimationFrame(function() {
                    textRenderRafPending = false;
                    if (streamRenderDone || !currentTextDiv) return;
                    currentTextDiv.innerHTML = parseMarkdown(currentTextContent);
                });
            }

            // 节流渲染：流式中的代码块用纯 textContent 展示（不做语法高亮），
            //   代码块结束（```）时才做一次完整 highlightCode，done 事件还会最终重渲染。
            function scheduleCodeRender() {
                if (codeRenderRafPending || streamRenderDone) return;
                codeRenderRafPending = true;
                requestAnimationFrame(function() {
                    codeRenderRafPending = false;
                    if (streamRenderDone || !currentCodeBlockWrapper) return;
                    const existingCodeEl = currentCodeBlockWrapper.querySelector('.plain-content pre code');
                    if (!existingCodeEl) return;
                    let tempCodeToShow = codeBuffer;
                    const firstLineEnd = codeBuffer.indexOf('\n');
                    if (firstLineEnd !== -1) {
                        const firstLine = codeBuffer.substring(0, firstLineEnd).trim();
                        if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                            tempCodeToShow = codeBuffer.substring(firstLineEnd + 1);
                        }
                    }
                    existingCodeEl.textContent = tempCodeToShow;
                    const filenameSpan = currentCodeBlockWrapper.querySelector('.plain-title');
                    if (filenameSpan) {
                        filenameSpan.textContent = detectCodeLanguage(codeBuffer, currentCodeFilename);
                    }
                });
            }

            // 节流滚动：每帧最多一次 scrollTop 赋值，避免每 chunk 强制 reflow
            function scheduleScroll() {
                if (scrollRafPending) return;
                scrollRafPending = true;
                requestAnimationFrame(function() {
                    scrollRafPending = false;
                    teamScrollIfFollowing(messagesContainer);
                });
            }

            // 同步刷新所有待执行的节流渲染：在 done 事件最终重渲染前调用，
            //   确保最后几个 chunk 的内容已写入 DOM（done 不一定走 renderContentWithCodeBlocks）
            function flushPendingRenders() {
                textRenderRafPending = false;
                if (currentTextDiv) {
                    currentTextDiv.innerHTML = parseMarkdown(currentTextContent);
                }
                codeRenderRafPending = false;
                if (currentCodeBlockWrapper) {
                    const existingCodeEl = currentCodeBlockWrapper.querySelector('.plain-content pre code');
                    if (existingCodeEl) {
                        let tempCodeToShow = codeBuffer;
                        const firstLineEnd = codeBuffer.indexOf('\n');
                        if (firstLineEnd !== -1) {
                            const firstLine = codeBuffer.substring(0, firstLineEnd).trim();
                            if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                                tempCodeToShow = codeBuffer.substring(firstLineEnd + 1);
                            }
                        }
                        existingCodeEl.textContent = tempCodeToShow;
                    }
                }
                thinkingRenderRafPending = false;
                // ★ 修复：同步渲染待处理的思考内容，防止 done/stream_reset 前raf未触发导致空框架
                if (aiThinkingDiv && !isThinkingEmpty(fullThinking)) {
                    var _rendered = renderThinkingContent(fullThinking);
                    aiThinkingDiv.innerHTML = _rendered;
                    console.log('[flushPendingRenders] sync-rendered thinking, len=' + fullThinking.length + ', htmlLen=' + _rendered.length);
                }
                // 渲染后若当前思考框仍为空（isThinkingEmpty 判据），直接移除
                if (aiThinkingDiv && isThinkingEmpty(aiThinkingDiv.textContent)) {
                    var _emptyW = aiThinkingDiv.closest('.thinking-wrapper');
                    if (_emptyW) {
                        console.log('[flushPendingRenders] removing empty wrapper after render, id=' + (_emptyW.id || '(none)'));
                        _emptyW.remove();
                    }
                }
                // ★ 防御：同步后全局扫描 messagesContainer，移除所有残留空框（判据：textContent 实质为空）
                removeEmptyThinkingWrappers(messagesContainer);
            }

            // 在 Work 模式下，流式输出过程中一旦形成第一个短句就立即语音播报，
            // 避免等到完整回复结束才开始播报。播报一次后标记 voiceShortReplySpoken，
            // 后续内容不再重复播报。
            function trySpeakShortReply(rawText) {
                if (voiceShortReplySpoken) return;
                if (!document.body.classList.contains('work-mode')) return;
                if (!isVoiceBroadcastEnabled && !isVoiceChatActive()) return;
                if (!rawText || typeof rawText !== 'string') return;
                // 桌宠接管朗读时（可见+TTS开，且本条按规则要读）应用侧不抢话；
                // 本条不读（语音播报关且非语音对话）则这里本来也会按下方开关判断静默
                if (petChatWillSpeak && petChatSpeakGate()) return;

                // 清理文本：去掉发送者标签、markdown 标记、多余空白
                let cleaned = rawText
                    .replace(/^MoonYa Agent\s*/gim, '')
                    .replace(/^MoonYa-T-Agent\s*/gim, '')
                    .replace(/```[\s\S]*?```/g, ' 代码块 ')
                    .replace(/`([^`]+)`/g, '$1')
                    .replace(/\*\*([^*]+)\*\*/g, '$1')
                    .replace(/\*([^*]+)\*/g, '$1')
                    .replace(/#+\s/g, '')
                    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                    .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' 图片 ')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (!cleaned) return;

                // 查找第一个短句结束位置：句号、问号、感叹号、英文句号/问号/感叹号、换行
                const sentenceEndChars = /[。！？.!?\n]/;
                let endIndex = -1;
                const match = cleaned.match(sentenceEndChars);
                if (match && typeof match.index === 'number') {
                    endIndex = match.index;
                }

                // 若迟迟没有句子结束符，则最多 60 字后兜底截取，避免等待过长
                const maxShortLen = 60;
                if (endIndex === -1 && cleaned.length >= maxShortLen) {
                    endIndex = maxShortLen - 1;
                }

                if (endIndex === -1) return; // 还没形成完整短句，继续等待

                const shortText = cleaned.substring(0, endIndex + 1).trim();
                if (!shortText) return;

                if (typeof window.speakText === 'function') {
                    voiceShortReplySpoken = true;
                    window.speakText(shortText);
                }
            }

            // ★ 统一思考框清理工具函数（参数驱动，不依赖外部硬编码常量）
            //   在指定 messageDiv 内查找 .thinking-wrapper，按内容状态三路处理：
            //   1) fullThinking 有内容且 .thinking-text 实际为空 → 同步回填（兼容 RAF 未触发）
            //   2) .thinking-text 实质非空（isThinkingEmpty 判据） → 默认折叠 + 移除 id/data-loading-id
            //   3) 文本仍为空 → 直接 remove()，避免"思考内容"空折叠框残留
            function cleanupThinkingWrapper(messageDiv, thinkingText) {
                if (!messageDiv) return;
                const wrapper = messageDiv.querySelector('.thinking-wrapper');
                if (!wrapper) return;
                const textEl = wrapper.querySelector('.thinking-text');
                const beforeText = textEl ? textEl.textContent : '';
                // RAF 可能尚未触发，innerHTML 为空但 fullThinking 已有内容：同步回填
                if (textEl && !isThinkingEmpty(thinkingText) && isThinkingEmpty(textEl.textContent)) {
                    textEl.innerHTML = renderThinkingContent(thinkingText);
                    console.log('[cleanupThinkingWrapper] sync-filled, thinkingText.len=' + thinkingText.length);
                }
                // 用 isThinkingEmpty 作为唯一判据（兼容 <br> / &nbsp; / 纯空白 / Unicode 零宽空格）
                if (textEl && !isThinkingEmpty(textEl.textContent)) {
                    textEl.classList.remove('expanded');
                    const toggle = wrapper.querySelector('.thinking-toggle');
                    if (toggle) {
                        toggle.classList.remove('expanded');
                        toggle.setAttribute('aria-expanded', 'false');
                    }
                    wrapper.removeAttribute('id');
                    wrapper.removeAttribute('data-loading-id');
                    console.log('[cleanupThinkingWrapper] preserved wrapper (id/data-loading-id removed), textLen=' + textEl.textContent.length);
                } else {
                    console.log('[cleanupThinkingWrapper] removing empty wrapper, beforeText="' + beforeText.substring(0, 50) + '"');
                    wrapper.remove();
                }
            }

            // ★ 段落结束统一处理（stream_reset / agent_switch / execution_code / done / error 五处共用）
            //   调用流程：flushPendingRenders → 挂载未挂载气泡 → 全局空 wrapper 清理 → 当前气泡 wrapper 收尾 → 释放引用
            //   注意：各事件特有的状态重置（fullReply / currentTextContent / currentCodeBlockWrapper 等）仍由事件自身处理
            function finalizeThinkingAtBoundary(loadingId) {
                flushPendingRenders();
                // 若当前气泡未挂载（AI 只思考未输出正文），先挂到 messagesContainer，避免游离 wrapper
                if (aiMessageDiv && !aiMessageDiv.parentNode) {
                    if (!aiContentDiv) {
                        aiContentDiv = document.createElement('div');
                        aiContentDiv.className = 'message-content';
                        aiMessageDiv.appendChild(aiContentDiv);
                    }
                    messagesContainer.appendChild(aiMessageDiv);
                        removeLoadingIndicator(loadingId);
                }
                // 全局清理空 wrapper（不依赖 loadingId 标记，对 textContent.trim() 为空的一律删除）
                removeEmptyThinkingWrappers(messagesContainer);
                // 处理当前气泡的 thinking wrapper
                cleanupThinkingWrapper(aiMessageDiv, fullThinking);
                // 释放引用，让下一段 thinking 创建新 wrapper
                aiMessageDiv = null;
                aiContentDiv = null;
                aiThinkingDiv = null;
                fullThinking = '';
                activeThinkingWrapper = null;
            }

            let networkRecoveryNotice = null;
            function finalizeCancelledResponse() {
                if (sendSettled) return;
                const host = aiMessageDiv || findAiMessageByLoadingId(loadingId);
                // Flush the buffers before freezing RAF callbacks and saving the DOM.
                finalizeThinkingAtBoundary(loadingId);
                streamRenderDone = true;
                streamTurnFinished = true;
                if (host) {
                    if (!host.parentNode) messagesContainer.appendChild(host);
                    MoonYaProcessUI.endDuration(host, Math.max(0, Date.now() - turnStartedAt));
                    if (host.__processSequence) MoonYaProcessUI.finish(host.__processSequence);
                    turnProcessNodes.forEach(function(record, key) {
                        if (record.message === host) markTurnProcessElapsed(key, 'cancelled');
                    });
                    MoonYaProcessUI.setStatus(host, 'cancelled');
                }
                removeLoadingIndicator(loadingId);
                clearNetworkRecoveryNotice();
                const wasVisible = sendIsVisible();
                finishSendRuntime('cancelled');
                if (wasVisible) {
                    stopStallDetector();
                    const button = document.getElementById('sendBtn');
                    if (button) {
                        button.disabled = false;
                        button.removeAttribute('data-state');
                        button.innerHTML = SEND_ICON_HTML;
                    }
                }
            }
            sendRuntime.finalizeCancelledResponse = finalizeCancelledResponse;

            // 确保有数据库对话ID（用于多轮对话）
            if (!sendRuntime.dbConversationId && isLoggedIn) {
                // 尝试从当前对话中获取数据库ID
                const history = getChatHistory();
                const currentChat = history.find(chat => String(chat.id) === String(sendRuntime.chatId));
                if (currentChat && currentChat.dbConversationId) {
                    sendRuntime.dbConversationId = currentChat.dbConversationId;
                }
            }
            if (sendRuntime.dbConversationId && window.MoonYaSharedRuntime) {
                try {
                    await window.MoonYaSharedRuntime.start({
                        conversationId: sendRuntime.dbConversationId,
                        clientMessageId: clientMessageId
                    });
                } catch (sharedRuntimeError) {
                    if (sharedRuntimeError && sharedRuntimeError.message === 'conversation_task_already_running') {
                        finishSendRuntime();
                        showToast('当前对话已有任务正在执行');
                        return;
                    }
                    console.warn('[SharedRuntime] start fallback:', sharedRuntimeError);
                }
            }
            if (sendSettled) return;
            publishRuntimeDomSnapshot(true);
            
            // 准备发送的数据
            // DeepSeek 只是默认模型；尊重用户当前选择，附件能力由 MoonYa 统一调度。
            const sendData = {
                message: message,
                deepThinking: deepThinking,
                model: 'deepseek',
                deepseekModelVersion: submissionBuiltinModel,
                model_ref: submissionModelRef,
                context_limit: submissionContextLimit,
                reasoning_default: submissionReasoning.defaultEffort,
                reasoningEffort: submissionReasoning.effort,
                reasoningProfile: submissionReasoning.profile,
                reasoningProfileVersion: 2,
                image_detail: submissionReasoning.imageDetail,
                isProgramming: isProgrammingMode,
                isTranslation: isTranslationMode,
                isWriting: isWritingMode,
                isResearch: isResearchMode,
                isClassical: isClassicalMode,
                isExpertMode: isExpertModeActive,
                isSpecialistMode: isSpecialistMode,
                specialistRouteInfo: specialistRouteInfo,
                agent_mode: sendingWork ? 'agent' : 'normal',
                selected_skills: selectedSkillsToSend,
                launcher_available: isMoonYaDesktopRuntime(),
                project_path: sendingWork ? submissionProject || null : null,
                approval_mode: sendRuntime.approvalMode || 'confirm_writes'
            };
            sendData.client_message_id = clientMessageId;
            sendData.client_chat_id = String(sendRuntime.chatId);
            if (localPathsToSend.length > 0) {
                sendData.local_paths = localPathsToSend.map(item => ({
                    path: item.path, kind: item.kind, name: item.name, selection_order: item.selection_order
                }));
            }
            sendData.image_input_order = [];

            // 标记当前输出 Agent：work 模式默认 MoonYa Agent；chat 模式不显示标签
            currentAgentName = sendingWork ? 'MoonYa Agent' : null;
            
            // 添加对话ID（用于多轮对话）
            if (sendRuntime.dbConversationId) {
                sendData.conversation_id = sendRuntime.dbConversationId;
                if (window.MoonYaTeam && typeof window.MoonYaTeam.refreshConversation === 'function' &&
                    teamUiState.historyConversationId !== Number(sendRuntime.dbConversationId)) {
                    window.MoonYaTeam.refreshConversation();
                }
            }
            
            // 添加图片ID
            if (imagesToSend.length > 0) {
                const localAttachments = imagesToSend.filter(img => img.local_only);
                if (sendingWork || submissionModelRef) {
                    if (imagesToSend.some(img => !img.local_only)) throw new Error('FarSide 不允许使用云端附件，请重新选择本地文件');
                    sendData.local_attachments = localAttachments.map(img => ({
                        name: img.filename, category: img.category, data_url: img.base64_url, text: img.file_text || '',
                        order: img.selection_order
                    }));
                }
                const managedAttachments = imagesToSend.filter(img => !img.local_only && img.attachment_id);
                const legacyAttachments = imagesToSend.filter(img => !img.local_only && !img.attachment_id);
                if (managedAttachments.length > 0) {
                    sendData.attachment_ids = managedAttachments.map(img => img.attachment_id);
                    managedAttachments.forEach(function(img, index) {
                        if (img.category === 'image' || img.is_image) {
                            sendData.image_input_order.push({
                                type: 'attachment', id: img.attachment_id,
                                order: Number(img.selection_order || index)
                            });
                        }
                    });
                }
                if (legacyAttachments.length > 0) {
                    sendData.images = legacyAttachments.map(img => img.file_id);
                }
                
                if (legacyAttachments.length > 0) {
                    const deepseekFileTexts = legacyAttachments
                        .filter(img => img.file_text)
                        .map(img => ({
                            filename: img.filename || '文件',
                            text: img.file_text,
                            is_pdf: img.is_pdf || false,
                            is_docx: img.is_docx || false,
                            is_txt: img.is_txt || false,
                            is_image: img.is_image || false
                        }));
                    if (deepseekFileTexts.length > 0) {
                        sendData.deepseek_ocr_texts = deepseekFileTexts;
                    }
                }
            }
            localPathsToSend.forEach(function(item, index) {
                sendData.image_input_order.push({
                    type: 'local_path', path: item.path,
                    order: Number(item.selection_order || (imagesToSend.length + index))
                });
            });
            sendData.image_input_order.sort(function(left, right) { return left.order - right.order; });
            
            if (CHAT_HISTORY_KEY !== submissionScope) throw new Error('登录账号已变化，请在当前账号重新发送');
            // 使用Fetch API发送流式请求
            // 获取token
            const apiToken = localStorage.getItem('api_token');
            const headers = {
                'Content-Type': 'application/json'
            };
            if (apiToken) {
                headers['Authorization'] = 'Bearer ' + apiToken;
            }
            
            // 普通 Work 消息统一进入 Harness；无项目时 Runtime 使用默认目录。
            // 图片/附件不再触发旧 PHP 多 Agent 回退。独立的图片/视频生成器仍保持专用端点。
            const useAgentRuntime = sendingWork;
            if (useAgentRuntime) {
                const workspaceIdentity = String(sendData.project_path || '__default__');
                const runtimeSessionKey = 'moonya.harness.session.'
                    + String(sendRuntime.chatId || sendRuntime.dbConversationId || 'draft')
                    + '.' + encodeURIComponent(workspaceIdentity);
                const legacyRuntimeSessionKey = 'moonya.harness.session.'
                    + String(sendRuntime.dbConversationId || sendRuntime.chatId || 'draft')
                    + '.' + encodeURIComponent(workspaceIdentity);
                sendData.harness_session_id = sendingChat.runtimeSessions?.[workspaceIdentity]
                    || localStorage.getItem(runtimeSessionKey) || localStorage.getItem(legacyRuntimeSessionKey) || '';
                sendRuntime.workspaceIdentity = workspaceIdentity;
                sendRuntime.harnessSessionId = sendData.harness_session_id;
                sendData.harness_after_seq = 0;
                sendRuntime.harnessSessionKey = runtimeSessionKey;
                // 本轮是否已见到 Runtime 的 turn.started。断线重连时随 resume 上报：
                // 网关只续订已接受消息的事件流；未确认送达时不自动执行。
                sendRuntime.sawHarnessTurnStart = false;
            }
            sendRuntime.customModelChat = !!submissionModelRef && !useAgentRuntime;
            const fetchUrl = useAgentRuntime ? 'harness_api.php' : 'api.php';
            const fetchHeaders = headers;
            
            const networkRetryMax = 5;
            let networkRetryAttempt = 0;
            function setNetworkRecoveryNotice(text) {
                if (!networkRecoveryNotice) {
                    networkRecoveryNotice = MoonYaNotifications.show(text, { duration: 0 });
                } else MoonYaNotifications.update(networkRecoveryNotice, text, { duration: 0 });
            }
            function clearNetworkRecoveryNotice() {
                if (networkRecoveryNotice) MoonYaNotifications.remove(networkRecoveryNotice);
                networkRecoveryNotice = null;
            }
            function publishNetworkPhase(type, detail) {
                const eventDetail = Object.assign({
                    type: type,
                    attempt: networkRetryAttempt,
                    max_attempts: networkRetryMax
                }, detail || {});
                window.dispatchEvent(new CustomEvent('moonya:network-event', { detail: eventDetail }));
                if (!sendRuntime.dbConversationId || !window.MoonYaSharedRuntime) return;
                const payload = {
                    conversationId: sendRuntime.dbConversationId,
                    clientMessageId: runtimeClientMessageId,
                    runId: sendRuntime.activeRunId || null,
                    attempt: networkRetryAttempt,
                    maxAttempts: networkRetryMax,
                    error: eventDetail.error || null
                };
                const method = type === 'network.reconnected' ? 'reconnected' : 'recover';
                window.MoonYaSharedRuntime[method](payload).catch(function() {});
            }
            function fetchStream(isReconnect, previousError) {
                let wait = Promise.resolve();
                if (isReconnect) {
                    networkRetryAttempt += 1;
                    if (networkRetryAttempt > networkRetryMax) {
                        return Promise.reject(new Error('network_reconnect_failed'));
                    }
                    const delay = Math.min(16000, 1000 * Math.pow(2, networkRetryAttempt - 1));
                    const errorText = previousError && previousError.message
                        ? previousError.message
                        : '连接意外中断';
                    setNetworkRecoveryNotice('正在重连，第 ' + networkRetryAttempt + '/' + networkRetryMax + ' 次…');
                    publishNetworkPhase('network.reconnecting', {
                        next_delay_ms: delay,
                        error: errorText
                    });
                    console.warn('[network-recovery] ' + delay + 'ms 后续接任务 ('
                        + networkRetryAttempt + '/' + networkRetryMax + '): ' + errorText);
                        sendData.resume = {
                            run_id: sendRuntime.activeRunId || null,
                            client_message_id: runtimeClientMessageId,
                            after_seq: Number(sendRuntime.lastRemoteEventSeq || 0),
                            // 续传只查找原 client_message_id，不创建第二次执行。
                            turn_started: sendRuntime.sawHarnessTurnStart ? 1 : 0,
                            attempt: networkRetryAttempt,
                            error: errorText
                        };
                    wait = new Promise(function(resolve) { setTimeout(resolve, delay); });
                }
                return wait.then(function() {
                    return fetch(fetchUrl, {
                        method: 'POST',
                        headers: fetchHeaders,
                        body: JSON.stringify(sendData),
                        signal: signal
                    });
                }).then(function(response) {
                    if (!response.ok || !response.body) {
                        const error = new Error('HTTP ' + response.status);
                        error.retryable = response.status >= 500;
                        throw error;
                    }
                    if (isReconnect) {
                        clearNetworkRecoveryNotice();
                        publishNetworkPhase('network.reconnected');
                    }
                    return response;
                }).catch(function(error) {
                    if (error.name === 'AbortError' || error.retryable === false || !isReconnect) throw error;
                    return fetchStream(true, error);
                });
            }

            fetchStream(false, null)
            .then(response => {
                if (sendSettled) return response.body?.cancel();
                let reader = response.body.getReader();
                let decoder = new TextDecoder();
                let sseBuffer = '';

                function reconnectStream(error) {
                    return fetchStream(true, error).then(function(response) {
                        reader = response.body.getReader();
                        decoder = new TextDecoder();
                        sseBuffer = '';
                        return read();
                    });
                }
                
                function read() {
                    if (sendSettled) return reader.cancel();
                    return reader.read().then(({ done, value }) => {
                        if (sendSettled) return;
                        if (signal.aborted) { finalizeCancelledResponse(); return; }
                        if (done) {
                            // 正常结束判据用 streamTurnFinished（收到后端 done 事件）；
                            //   streamRenderDone 只用于时间线的分段渲染守卫，不能拿来判断流是否正常收尾。
                            if (!streamTurnFinished) {
                                const reconnectCause = pendingRecoverableStreamError || new Error('SSE unexpected EOF');
                                pendingRecoverableStreamError = null;
                                return reconnectStream(reconnectCause);
                            }
                            return;
                        }
                        
                        const chunk = decoder.decode(value, { stream: true });
                        sseBuffer += chunk;
                        const lines = sseBuffer.split('\n');
                        sseBuffer = lines.pop() || '';

                        lines.forEach(line => {
                            if (sendSettled || signal.aborted) return;
                            if (line.startsWith(':')) lastSSEEventTime = Date.now();
                            if (line.startsWith('data: ')) {
                                // 更新最后事件时间（用于卡顿检测）
                                lastSSEEventTime = Date.now();
                                const dataStr = line.slice(6);
                                try {
                                    const data = JSON.parse(dataStr);
                                    if (['content', 'thinking', 'done'].includes(data.type) ||
                                        (data.type === 'runtime_event' && ['agent.turn.started', 'desktop.message.accepted'].includes(data.event)))
                                        deliveryConfirmed = true;
                                    if (data.model_seq) {
                                        if (Number(data.model_seq) <= Number(sendRuntime.lastRemoteEventSeq || 0)) return;
                                        sendRuntime.lastRemoteEventSeq = Number(data.model_seq);
                                    }
                                    if (data.run_id) {
                                        sendRuntime.activeRunId = String(data.run_id);
                                    }
                                    if (data.seq) {
                                        sendRuntime.lastRemoteEventSeq = Math.max(
                                            Number(sendRuntime.lastRemoteEventSeq || 0),
                                            Number(data.seq || 0)
                                        );
                                    }
                                    if (data.type === 'skill_sync') { window.MoonYaClient.showSkillSync(data); }
                                    if (data.type === 'credits_update') { void window.MoonYaMembership?.settlement(data.data); }
                                    if (data.type === 'credits_exhausted') {
                                        flushPendingRenders();
                                        const timeline=ensureTimeline(aiMessageDiv,loadingId);
                                        aiMessageDiv=timeline.message;aiContentDiv=timeline.content;
                                        clearTurnLoadingIndicator();
                                        window.MoonYaMembership?.quotaNotice(aiMessageDiv);
                                        void window.MoonYaMembership?.refresh();
                                    }
                                    if (data.type === 'harness_session') {
                                        if (sendRuntime.harnessSessionKey && data.session_id) {
                                            const runtimeSessionId = String(data.session_id);
                                            sendRuntime.harnessSessionId = runtimeSessionId;
                                            const runtimeHistory = window.MoonYaHistoryStore.list(sendRuntime.historyScope);
                                            const runtimeChat = runtimeHistory.find(chat => String(chat.id) === String(sendRuntime.chatId));
                                            if (runtimeChat) {
                                                runtimeChat.runtimeSessions = Object.assign({}, runtimeChat.runtimeSessions, { [sendRuntime.workspaceIdentity]: runtimeSessionId });
                                                runtimeChat.activeWorkspaceIdentity = sendRuntime.workspaceIdentity;
                                                void window.MoonYaHistoryStore.save(sendRuntime.historyScope, runtimeHistory);
                                            }
                                            // 当前请求体也必须立即接住服务端新建的 id；否则本轮第一次断线
                                            // 仍会拿初始化时的空值去 resume，确定性触发 session_not_found。
                                            sendData.harness_session_id = runtimeSessionId;
                                            if (window.MoonYaOffice && String(currentChatId || '') === String(sendRuntime.chatId)) window.MoonYaOffice.bind(runtimeSessionId, sendData.project_path || '');
                                            if (window.MoonYaSubagentChat && String(currentChatId || '') === String(sendRuntime.chatId)) window.MoonYaSubagentChat.bind(sendRuntime);
                                        }
                                        return;
                                    }
                                    if (data.type === 'network.reconnected') {
                                        clearNetworkRecoveryNotice();
                                        networkRetryAttempt = 0;
                                        delete sendData.resume;
                                        publishNetworkPhase('network.reconnected');
                                        return;
                                    }

                                    // ── Launcher 中继：远程后端无法直接 curl 用户本机 C# API，
                                    //    通过 SSE 发来请求，浏览器按运行时服务清单调用本地服务并回传结果。
                                    if (data.type === 'launcher_request') {
                                        // 每个 Promise 闭包捕获自己的不可变票据；并发请求绝不能
                                        // 复用函数作用域 var，否则慢请求会把结果回传到后一个 request_id。
                                        const _rid = data.request_id;
                                        const _relayToken = data.relay_token || '';
                                        // data.url 必须是协议清单中声明的相对路由。
                                        const _url = data.url || ('' + (data.endpoint || '/file-op'));
                                        const _body = typeof data.body === 'string' ? data.body : JSON.stringify(data.body || {});
                                        // 断线重放会再次收到同一 request_id。复用同一个本地执行
                                        // Promise/结果，只重复提交幂等回执，绝不重复桌面副作用。
                                        const relayExecutions = window.__moonyaLauncherRelayExecutions
                                            || (window.__moonyaLauncherRelayExecutions = new Map());
                                        let relayExecution = relayExecutions.get(_rid);
                                        if (!relayExecution) {
                                            relayExecution = executeLauncherRequestWithBrowserApproval(_url, _body)
                                                .catch(function(err) {
                                                    return { success: false, message: '本地C#API调用失败: ' + err.message };
                                                });
                                            relayExecutions.set(_rid, relayExecution);
                                            if (relayExecutions.size > 256) {
                                                relayExecutions.delete(relayExecutions.keys().next().value);
                                            }
                                        }
                                        relayExecution.then(function(result) {
                                            return fetch(window.location.origin + '/api.php', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ action: 'launcher_relay_result', request_id: _rid, relay_token: _relayToken, result: result })
                                            });
                                        }).catch(function(err) {
                                            console.error('[launcher-relay] 回执提交失败', err);
                                        });
                                    }

                                    if (data.type === 'runtime_event') {
                                        if (sendRuntime.mode === 'work') {
                                            void window.MoonYaHistoryStore.appendEvent(sendRuntime.historyScope, sendRuntime.chatId, data);
                                        }
                                        sendRuntime.activeRunId = String(data.root_run_id || data.run_id || sendRuntime.activeRunId || '');
                                        const scopedTeamEvent = Object.assign({}, data, {
                                            history_scope: sendRuntime.historyScope,
                                            conversation_id: sendRuntime.dbConversationId || data.conversation_id || null,
                                            chat_id: sendRuntime.chatId, project_path: sendData.project_path || ''
                                        });
                                        // 一个 assistant.message 就是当前模型 step 的结束。先关闭旧正文段，
                                        // renderHarnessAssistantMessage 才能把它稳定移入过程区；下一 step 的
                                        // content 会创建新段，避免继续写进已经完成的上一条回复。
                                        if (data.source === 'harness' && ['assistant.message', 'tool.started', 'agent.reasoning.delta', 'step.started', 'model.activity'].includes(data.event)) {
                                            closeContentSegment();
                                        }
                                        // Apply the committed snapshot immediately; fetching here can
                                        // race the following context.usage and resurrect old occupancy.
                                        if (data.source === 'harness' && data.event === 'context.compacted') {
                                            notifyHarnessCompaction(scopedTeamEvent);
                                        }
                                        if (data.source === 'harness' && data.event === 'session_statistics' && sendIsVisible()) {
                                            window.MoonYaContextRing?.applyStatistics(data.payload, sendRuntime.chatId);
                                        }
                                        // Harness 上报当前有效上下文的估算占用与构成。
                                        if (data.source === 'harness' && ['context.usage', 'context.compacted'].includes(data.event)) {
                                            const usagePayload = (data.payload && typeof data.payload === 'object') ? data.payload : data;
                                            if (window.MoonYaContextRing && String(currentChatId || '') === String(sendRuntime.chatId || '')) {
                                                window.MoonYaContextRing.applyServerUsage({
                                                    used_tokens: usagePayload.used_tokens ?? usagePayload.after_tokens,
                                                    limit: usagePayload.limit_tokens,
                                                    model_ref: usagePayload.model_ref,
                                                    model_id: usagePayload.model_id,
                                                    percent: usagePayload.percent,
                                                    system_tokens: usagePayload.system_tokens,
                                                    tools_tokens: usagePayload.tools_tokens,
                                                    messages_tokens: usagePayload.messages_tokens,
                                                    session_id: usagePayload.session_id || data.run_id,
                                                    seq: usagePayload.seq || data.seq,
                                                    estimated: true,
                                                    history_trimmed: false,
                                                    _harness: true
                                                });
                                            }
                                        }
                                        if (data.event === 'approval.required' || data.event === 'approval.decided') {
                                            handleTeamApproval(scopedTeamEvent);
                                        }
                                        if (window.MoonYaSharedRuntime && sendRuntime.dbConversationId &&
                                            (data.event === 'approval.required' || data.event === 'approval.decided')) {
                                            window.MoonYaSharedRuntime.streamEvent({ conversationId: sendRuntime.dbConversationId,
                                                clientMessageId: runtimeClientMessageId, runId: scopedTeamEvent.run_id,
                                                event: scopedTeamEvent }).catch(function() {});
                                        }
                                        if (['turn.cancelled', 'turn.interrupted', 'turn.quota_stopped', 'session.error', 'agent.turn.completed'].includes(data.event)) {
                                            settleComposerApprovals(scopedTeamEvent.run_id, data.event === 'turn.cancelled' ? 'cancelled' : 'expired');
                                        }
                                        if (String(currentChatId || '') === String(sendRuntime.chatId)) {
                                            handleTeamEvent(scopedTeamEvent);
                                        }
                                        // Harness 的结构化过程区已经承担“正在工作”和流式 reasoning。
                                        // turn.started 到达后立即接管最初的加载气泡并移除其动画，避免页面同时
                                        // 出现过程区 spinner 与旧加载气泡两套加载状态。空气泡保留给最终正文复用。
                                        if (data.source === 'harness' && data.event === 'agent.turn.started') {
                                            window.MoonYaChanges.begin(sendRuntime, Number(data.turn));
                                            // 消息已被 Runtime 接受且本轮 turn 已启动；此后断线重连
                                            // 只续订事件流（resume.turn_started=1），不再重发消息。
                                            sendRuntime.sawHarnessTurnStart = true;
                                            const harnessHost = findAiMessageByLoadingId(loadingId);
                                            if (harnessHost) {
                                                ensureTimeline(harnessHost, loadingId);
                                                clearTurnLoadingIndicator();
                                            }
                                        }
                                        window.dispatchEvent(new CustomEvent('moonya:runtime-event', { detail: scopedTeamEvent }));
                                        if (data.source === 'harness' && data.event === 'turn.cancelled') {
                                            finalizeCancelledResponse();
                                        }
                                        return;
                                    }
                                    if (teamUiState.activeRunId && teamLegacyEventTypes.has(data.type)) {
                                        return;
                                    }

                                    if (data.type === 'workflow_plan') {
                                        // 工作流规划：渲染垂直时间线骨架
                                        const existingBars = messagesContainer.querySelectorAll('.agent-status-bar');
                                        existingBars.forEach(b => b.remove());

                                        let workflowTimeline = messagesContainer.querySelector('.workflow-timeline');
                                        if (workflowTimeline) workflowTimeline.remove();

                                        workflowTimeline = document.createElement('div');
                                        workflowTimeline.className = 'workflow-timeline';

                                        const timelineHeader = document.createElement('div');
                                        timelineHeader.className = 'workflow-timeline-header';
                                        timelineHeader.innerHTML = '<span class="workflow-header-text">待办</span>';
                                        workflowTimeline.appendChild(timelineHeader);

                                        const stepsContainer = document.createElement('div');
                                        stepsContainer.className = 'workflow-steps';

                                        (data.steps || []).forEach((step, index) => {
                                            const stepNode = document.createElement('div');
                                            stepNode.className = 'workflow-step status-pending';
                                            stepNode.dataset.stepId = step.id || (index + 1);

                                            // 左侧图标：未执行 = 空心灰圈
                                            const nodeIcon = document.createElement('div');
                                            nodeIcon.className = 'workflow-node-icon';
                                            nodeIcon.innerHTML = createWorkflowEmptyIcon(18);
                                            stepNode.appendChild(nodeIcon);

                                            const stepContent = document.createElement('div');
                                            stepContent.className = 'workflow-step-content';

                                            const stepTitle = document.createElement('span');
                                            stepTitle.className = 'workflow-step-title';
                                            // 兜底多个常见字段名（AI 可能用 title/name/desc 等）
                                            stepTitle.textContent = step.title || step.name || step.step_name || step.description || step.task || ('任务 ' + (index + 1));
                                            stepContent.appendChild(stepTitle);

                                            stepNode.appendChild(stepContent);

                                            stepsContainer.appendChild(stepNode);
                                        });

                                        workflowTimeline.appendChild(stepsContainer);
                                        messagesContainer.appendChild(workflowTimeline);
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'step_progress') {
                                        // 步骤运行中：图标 = 灰色转圈 SVG（按图 2 要求）
                                        const stepNode = messagesContainer.querySelector('.workflow-step[data-step-id="' + data.step_id + '"]');
                                        if (stepNode) {
                                            // 兜底更新标题（后端可能从 AI 返回的 steps 里读取 title/name 等不同字段）
                                            const stepTitleEl = stepNode.querySelector('.workflow-step-title');
                                            if (stepTitleEl && data.title && !stepTitleEl.textContent.trim()) {
                                                stepTitleEl.textContent = data.title;
                                            }
                                            stepNode.classList.remove('status-pending');
                                            stepNode.classList.add('status-running');
                                            const icon = stepNode.querySelector('.workflow-node-icon');
                                            if (icon) {
                                                // 运行中只显示静态空心状态，不旋转。
                                                icon.innerHTML = createWorkflowEmptyIcon(18, '#888888');
                                                icon.style.color = 'var(--theme-muted, #888888)';
                                                icon.style.animation = 'none';
                                            }
                                        }
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'step_done') {
                                        // 步骤完成：成功 = 绿色实心+白勾；失败 = 红色实心+白叉
                                        const stepNode = messagesContainer.querySelector('.workflow-step[data-step-id="' + data.step_id + '"]');
                                        if (stepNode) {
                                            stepNode.classList.remove('status-running', 'status-pending');
                                            stepNode.classList.add(data.status === 'success' ? 'status-success' : 'status-failed');
                                            const icon = stepNode.querySelector('.workflow-node-icon');
                                            if (icon) {
                                                icon.style.animation = '';
                                                if (data.status === 'success') {
                                                    icon.innerHTML = createWorkflowCheckIcon(18, '#4caf50');
                                                } else {
                                                    icon.innerHTML = createWorkflowCrossIcon(18, '#888888');
                                                }
                                            }
                                        }

                                    } else if (data.type === 'error_recovery') {
                                        // 错误恢复：在步骤节点显示警告并展开错误详情
                                        const stepNode = messagesContainer.querySelector('.workflow-step[data-step-id="' + data.step_id + '"]');
                                        if (stepNode) {
                                            stepNode.classList.add('has-error');
                                            const resultDiv = stepNode.querySelector('.workflow-step-result');
                                            if (resultDiv) {
                                                resultDiv.innerHTML = '<div class="workflow-error-detail"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888888" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' + (data.error_message || '未知错误') + '</div><div class="workflow-recovery-action">恢复策略: ' + (data.recovery_action || '自动处理中') + '</div>';
                                                resultDiv.style.display = 'block';
                                                resultDiv.classList.add('error-expanded');
                                                stepNode.classList.add('expanded', 'has-result');
                                            }
                                        }
                                        const errBar = document.createElement('div');
                                        errBar.className = 'agent-status-bar status-failure';
                                        errBar.innerHTML = '<span class="status-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></span><span>错误恢复: ' + (data.error_message || '').substring(0, 50) + '</span>';
                                        messagesContainer.appendChild(errBar);
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'workflow_plan_updated') {
                                        // 计划更新：重新渲染时间线但保留已完成步骤状态
                                        const oldTimeline = messagesContainer.querySelector('.workflow-timeline');
                                        const completedSteps = new Map();
                                        if (oldTimeline) {
                                            oldTimeline.querySelectorAll('.workflow-step.status-success, .workflow-step.status-failed').forEach(node => {
                                                const stepId = node.dataset.stepId;
                                                const resultDiv = node.querySelector('.workflow-step-result');
                                                completedSteps.set(stepId, {
                                                    status: node.classList.contains('status-success') ? 'success' : 'failed',
                                                    result: resultDiv ? resultDiv.textContent : ''
                                                });
                                            });
                                            oldTimeline.remove();
                                        }

                                        const workflowTimeline = document.createElement('div');
                                        workflowTimeline.className = 'workflow-timeline';

                                        const timelineHeader = document.createElement('div');
                                        timelineHeader.className = 'workflow-timeline-header';
                                        timelineHeader.innerHTML = '<span class="workflow-header-text">待办</span>';
                                        workflowTimeline.appendChild(timelineHeader);

                                        const stepsContainer = document.createElement('div');
                                        stepsContainer.className = 'workflow-steps';

                                        (data.steps || []).forEach((step, index) => {
                                            const stepNode = document.createElement('div');
                                            const stepId = step.id || (index + 1);
                                            const completed = completedSteps.get(String(stepId));
                                            stepNode.className = 'workflow-step ' + (completed ? ('status-' + completed.status) : 'status-pending');
                                            stepNode.dataset.stepId = stepId;

                                            // 左侧图标
                                            const nodeIcon = document.createElement('div');
                                            nodeIcon.className = 'workflow-node-icon';
                                            if (completed) {
                                                nodeIcon.innerHTML = completed.status === 'success' ? createWorkflowCheckIcon(18, '#4caf50') : createWorkflowCrossIcon(18, '#888888');
                                            } else {
                                                nodeIcon.innerHTML = createWorkflowEmptyIcon(18);
                                            }
                                            stepNode.appendChild(nodeIcon);

                                            const stepContent = document.createElement('div');
                                            stepContent.className = 'workflow-step-content';

                                            const stepTitle = document.createElement('span');
                                            stepTitle.className = 'workflow-step-title';
                                            stepTitle.textContent = step.title || '';
                                            stepContent.appendChild(stepTitle);

                                            stepNode.appendChild(stepContent);
                                            stepsContainer.appendChild(stepNode);
                                        });

                                        workflowTimeline.appendChild(stepsContainer);

                                        // ★ 流式顺序：更新后的时间线追加到末尾
                                        messagesContainer.appendChild(workflowTimeline);
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'workflow_done') {
                                        // 工作流完成：整体完成态，显示统计信息
                                        const timeline = messagesContainer.querySelector('.workflow-timeline');
                                        if (timeline) {
                                            timeline.classList.add('workflow-completed');
                                            const statsDiv = document.createElement('div');
                                            statsDiv.className = 'workflow-stats';
                                            const totalSec = data.total_duration_ms ? (data.total_duration_ms / 1000).toFixed(1) : '0.0';
                                            const successCount = data.success_count || 0;
                                            const failedCount = data.failed_count || 0;
                                            const totalSteps = data.total_steps || 0;
                                            statsDiv.innerHTML = '<span class="workflow-stats-icon">' + createWorkflowCheckIcon(18, '#4caf50') + '</span> 完成：' +
                                                successCount + ' 成功 / ' + failedCount + ' 失败 / ' +
                                                totalSteps + ' 总计 · ' + totalSec + 's';
                                            timeline.appendChild(statsDiv);
                                        }
                                        const currentBar = messagesContainer.querySelector('.agent-status-bar.workflow-current');
                                        if (currentBar) currentBar.remove();
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'file_content') {
                                        // ★ v4.11: 文件内容流式显示（边生成边显示）
                                        let fileContentWrapper = document.getElementById('file-content-streaming-' + loadingId);
                                        if (!fileContentWrapper) {
                                            // 首次收到，创建显示容器
                                            fileContentWrapper = document.createElement('div');
                                            fileContentWrapper.id = 'file-content-streaming-' + loadingId;
                                            fileContentWrapper.className = 'file-content-streaming';

                                            const header = document.createElement('div');
                                            header.className = 'file-content-header';
                                            header.textContent = '文件内容';
                                            fileContentWrapper.appendChild(header);

                                            const codeBlock = document.createElement('pre');
                                            codeBlock.className = 'file-content-code';
                                            fileContentWrapper.appendChild(codeBlock);

                                            // 插入到消息容器（在 AI 消息之前）
                                            if (aiMessageDiv && aiMessageDiv.parentNode) {
                                                aiMessageDiv.parentNode.insertBefore(fileContentWrapper, aiMessageDiv);
                                            } else {
                                                messagesContainer.appendChild(fileContentWrapper);
                                            }
                                        }
                                        // 追加内容到代码块
                                        const codeBlock = fileContentWrapper.querySelector('.file-content-code');
                                        if (codeBlock) {
                                            // ★ 修复：原 textContent += 每次都重新序列化+重渲染整个 <pre>，是 O(n²)。
                                            //   长文件（数百 KB）会冻结主线程 → 无法消费 SSE → TCP 缓冲满 → "network error"。
                                            //   改用 appendChild(createTextNode) 做 O(1) 增量追加，不触发整体重渲染。
                                            codeBlock.appendChild(document.createTextNode(data.content));
                                            // 节流滚动：每 100ms 最多更新一次，避免每事件强制 reflow
                                            if (!codeBlock._scrollRaf) {
                                                codeBlock._scrollRaf = requestAnimationFrame(function() {
                                                    codeBlock._scrollRaf = null;
                                                    codeBlock.scrollTop = codeBlock.scrollHeight;
                                                });
                                            }
                                        }
                                        if (!messagesContainer._scrollRaf) {
                                            messagesContainer._scrollRaf = requestAnimationFrame(function() {
                                                messagesContainer._scrollRaf = null;
                                                teamScrollIfFollowing(messagesContainer);
                                            });
                                        }

                                    } else if (data.type === 'tool_detail') {
                                        // ★ v4.12: 工具执行详情 → 追加到右侧操作详情面板（不再注入对话区域）
                                        // multi-agent v1 已通过 TeamEventV1 提供同一操作的结构化事件，避免重复展示。
                                        if (!teamUiState.activeRunId) appendToolDetail(data);

                                    } else if (data.type === 'stream_reset') {
                                        console.log('[stream_reset] aiMessageDiv=' + !!aiMessageDiv + ', activeConnected=' + !!(activeThinkingWrapper && activeThinkingWrapper.isConnected));
                                        // ★ 时间线：工具调用循环结束后由后端发送，只结束当前正文段；
                                        //   aiMessageDiv 保留，使后续 thinking/content 继续追加到同一条时间线，
                                        //   过程行因此落在两段正文之间，形成按时间顺序的交错排列。
                                        closeContentSegment();
                                        if (turnTimelineHostEl?.__processSequence) turnTimelineHostEl.__processSequence.reasoningStep = (turnTimelineHostEl.__processSequence.reasoningStep || 0) + 1;
                                        // ★ 统一段落结束处理：flushPendingRenders + 挂载未挂载气泡 + 全局空 wrapper 清理 + 当前 wrapper 收尾 + 释放引用
                                        finalizeThinkingAtBoundary(loadingId);
                                        // 保留 stream_reset 特有的流式渲染状态重置
                                        fullReply = '';
                                        fullReplyForRender = '';
                                        _stepTagHold = '';
                                        streamRenderDone = false;
                                        textRenderRafPending = false;
                                        thinkingRenderRafPending = false;
                                        codeRenderRafPending = false;

                                    } else if (data.type === 'status') {
                                        const tl = ensureTimeline(aiMessageDiv, loadingId);
                                        aiMessageDiv = tl.message; aiContentDiv = tl.content;
                                        const sequence = tl.message.__processSequence;
                                        if (!sequence) return;
                                        const category = getToolCategory(data.tool_name, data.label, data.detail);
                                        const tool = { command_execution: 'execute_command', python_execution: 'execute_python' }[category] || category;
                                        sequence.legacyPending ||= new Map();
                                        if (data.status === 'thinking') { closeContentSegment(); MoonYaProcessUI.activity(sequence); return; }
                                        const explicitId = data.tool_call_id || data.operation_id;
                                        let key = explicitId || sequence.legacyPending.get(tool);
                                        if (!key || (data.status === 'executing' && !MoonYaProcessUI.isRunning(sequence.tools.get(key)?.spec.state))) {
                                            key = explicitId || 'legacy:' + tool + ':' + sequence.tools.size;
                                            closeContentSegment(); sequence.legacyPending.set(tool, key);
                                        }
                                        const previous = sequence.tools.get(key)?.spec || {};
                                        const path = data.path || data.arguments?.path || previous.args?.path || (MoonYaProcessUI.kind(tool) === 'edit' ? (data.label || '').replace(/^[^：:]+[：:]\s*/, '') : '');
                                        MoonYaProcessUI.tool(sequence, key, { tool, args: data.arguments || previous.args || (path ? { path } : {}),
                                            detail: data.detail || path || data.label || '', state: data.status,
                                            result: { ...(previous.result || {}), ...(data.result && typeof data.result === 'object' ? data.result : {}),
                                                ...(['failure', 'error'].includes(data.status) ? { error: data.detail || data.label } : {}) } });
                                        clearTurnLoadingIndicator(); teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'agent_switch') {
                                        console.log('[agent_switch] name=' + (data.name || 'null') + ', aiMessageDiv=' + !!aiMessageDiv + ', activeConnected=' + !!(activeThinkingWrapper && activeThinkingWrapper.isConnected));
                                        // ★ 时间线：切换输出 Agent 时在当前时间线插入一条 Agent 行，
                                        //   后续 thinking/content 继续追加到同一条时间线，不再另起气泡。
                                        closeContentSegment();
                                        var prevAgentName = currentAgentName;
                                        // ★ 统一段落结束处理：flushPendingRenders + 挂载未挂载气泡 + 全局空 wrapper 清理 + 当前 wrapper 收尾 + 释放引用
                                        finalizeThinkingAtBoundary(loadingId);
                                        // 段落收尾之后插入 Agent 行，保证它落在已渲染内容之后；
                                        // aiMessageDiv 由 appendTimelineItem 按 loadingId 找回（与 execution_code 同一约定）
                                        if (data.name && data.name !== prevAgentName) {
                                            appendTimelineItem(createProcessRow({
                                                tool: 'agent_switch',
                                                toolText: '切换至 ' + data.name,
                                                status: 'success'
                                            }), null, loadingId);
                                        }
                                        currentAgentName = data.name || null;
                                        fullReply = '';
                                        fullReplyForRender = '';
                                        streamRenderDone = false;
                                        // ★ 重置节流标志，防止上一段 Agent 的待执行 RAF 用新上下文渲染
                                        textRenderRafPending = false;
                                        thinkingRenderRafPending = false;
                                        codeRenderRafPending = false;

                                    } else if (data.type === 'thinking') {
                                        if (useAgentRuntime) return;
                                        const incoming = String(data.content || '');
                                        if (!isThinkingEmpty(incoming)) {
                                            const tl = ensureTimeline(aiMessageDiv, loadingId);
                                            aiMessageDiv = tl.message; aiContentDiv = tl.content;
                                            const sequence = tl.message.__processSequence;
                                            if (!sequence.active) closeContentSegment();
                                            const segment = MoonYaProcessUI.ensure(sequence);
                                            const key = 'segment:' + segment.container.dataset.processSegment + ':step:' + (sequence.reasoningStep || 0);
                                            const text = mergeThinkingUnique(sequence.texts.get(key) || '', incoming);
                                            sequence.texts.set(key, text);
                                            MoonYaProcessUI.reason(sequence, key, text, true);
                                            clearTurnLoadingIndicator();
                                        }
                                    } else if (data.type === 'statistics_record') {
                                        void fetch('statistics.php', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(data.data) })
                                            .then(response => response.json()).then(result => {
                                                if (result.success && sendIsVisible()) window.MoonYaContextRing?.applyStatistics(result.data, sendRuntime.chatId);
                                            }).catch(() => {});
                                    } else if (data.type === 'session_statistics') {
                                        if (sendIsVisible()) window.MoonYaContextRing?.applyStatistics(data.data, sendRuntime.chatId);
                                    } else if (data.type === 'context_usage') {
                                        // 后台旧对话的收尾统计不能覆盖当前对话的用量。
                                        if (window.MoonYaContextRing && sendIsVisible()) {
                                            window.MoonYaContextRing.applyServerUsage(Object.assign({}, data, { _chat_id: sendRuntime.chatId }));
                                        }
                                    } else if (data.type === 'search_progress') {
                                        // ★ 搜索进度事件：更新现有状态条文字，不删除重建（消除频繁弹出）
                                        let existingBar = messagesContainer.querySelector('.agent-status-bar');

                                        // 若状态条不存在则创建（兼容连续轮次场景中状态条被移除的情况）
                                        if (!existingBar) {
                                            existingBar = document.createElement('div');
                                            existingBar.className = 'agent-status-bar status-executing';

                                            // 运行中静态状态图标
                                            const icon = document.createElement('span');
                                            icon.className = 'status-icon';
                                            icon.innerHTML = createWorkflowEmptyIcon(16, '#888888');
                                            icon.style.animation = 'none';

                                            // 标签
                                            const label = document.createElement('span');
                                            label.textContent = '联网搜索';

                                            existingBar.appendChild(icon);
                                            existingBar.appendChild(label);
                                            messagesContainer.appendChild(existingBar);
                                        }

                                        // 更新或创建 detail span
                                        let detailSpan = existingBar.querySelector('.status-detail');
                                        if (!detailSpan) {
                                            detailSpan = document.createElement('span');
                                            detailSpan.className = 'status-detail';
                                            existingBar.appendChild(detailSpan);
                                        }

                                        if (data.status === 'searching') {
                                            // 优先使用后端推送的 text 字段
                                            if (data.text) {
                                                detailSpan.textContent = data.text;
                                            } else {
                                                const queryDisplay = data.query ? (data.query.length > 30 ? data.query.substring(0, 30) + '...' : data.query) : '';
                                                detailSpan.textContent = queryDisplay ? (queryDisplay + '（' + data.elapsed + '秒）') : ('搜索中（' + data.elapsed + '秒）');
                                            }
                                        } else if (data.status === 'done') {
                                            // 优先使用后端推送的 text 字段
                                            if (data.text) {
                                                detailSpan.textContent = data.text;
                                            } else {
                                                detailSpan.textContent = '完成（' + (data.result_count || 0) + '条结果）';
                                            }
                                            // 停止旋转动画，改为完成图标
                                            const icon = existingBar.querySelector('.status-icon');
                                            if (icon) {
                                                icon.innerHTML = createWorkflowCheckIcon(14, 2.5);
                                                icon.style.animation = '';
                                            }
                                            existingBar.className = 'agent-status-bar status-done';
                                        } else if (data.status === 'error') {
                                            // 优先使用后端推送的 text 字段
                                            if (data.text) {
                                                detailSpan.textContent = data.text;
                                            } else {
                                                detailSpan.textContent = '失败: ' + (data.message || '未知错误');
                                            }
                                            // 停止旋转动画，改为错误图标
                                            const icon = existingBar.querySelector('.status-icon');
                                            if (icon) {
                                                icon.innerHTML = createWorkflowCrossIcon(14, 2.5);
                                                icon.style.animation = '';
                                            }
                                            existingBar.className = 'agent-status-bar status-error';
                                        }
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'search_result') {
                                        // ★ 搜索结果事件：使用折叠菜单组件展示（复用 thinking-wrapper 模式，默认收起）
                                        const results = data.results || [];
                                        const resultCount = results.length;
                                        const queryText = data.query || '';

                                        // 创建折叠菜单容器
                                        const srWrapper = document.createElement('div');
                                        srWrapper.className = 'search-result-wrapper';

                                        // 头部（可点击展开/收起）
                                        const srHeader = document.createElement('div');
                                        srHeader.className = 'search-result-header';
                                        srHeader.onclick = function() {
                                            const wrapper = this.parentElement;
                                            const toggle = wrapper.querySelector('.search-result-toggle');
                                            const text = wrapper.querySelector('.search-result-text');
                                            toggle.classList.toggle('expanded');
                                            text.classList.toggle('expanded');
                                        };

                                        // 头部标签
                                        const srLabel = document.createElement('span');
                                        srLabel.className = 'search-result-label';
                                        srLabel.textContent = '搜索的资料（' + resultCount + '条）';

                                        // 下拉箭头（默认收起：朝右）
                                        const srToggle = document.createElement('span');
                                        srToggle.className = 'search-result-toggle';
                                        srToggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21.5627 8.86518C21.8751 8.55276 21.8751 8.04624 21.5627 7.73382L19.7662 5.93729C19.4538 5.62487 18.9473 5.62487 18.6348 5.93729L12 12.5721L5.36517 5.93729C5.05275 5.62487 4.54622 5.62487 4.2338 5.93729L2.43728 7.73382C2.12486 8.04624 2.12486 8.55276 2.43728 8.86518L11.4348 17.8627C11.7473 18.1751 12.2538 18.1751 12.5662 17.8627L21.5627 8.86518Z" fill="#999"></path></svg>';

                                        srHeader.appendChild(srLabel);
                                        srHeader.appendChild(srToggle);

                                        // 内容区（默认收起）
                                        const srText = document.createElement('div');
                                        srText.className = 'search-result-text';

                                        // 渲染编号列表
                                        let html = '';
                                        results.forEach(function(r, idx) {
                                            const num = idx + 1;
                                            const title = r.title || r.url || '';
                                            const url = r.url || '';
                                            const snippet = r.snippet || '';
                                            const escapedSnippet = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                            if (url) {
                                                html += '<div class="search-result-item">' + num + '. <a href="' + url + '" target="_blank" rel="noopener noreferrer">' + title + '</a>';
                                            } else {
                                                html += '<div class="search-result-item">' + num + '. ' + title;
                                            }
                                            if (escapedSnippet) {
                                                html += '<br><span class="search-result-snippet">' + escapedSnippet + '</span>';
                                            }
                                            html += '</div>';
                                        });
                                        srText.innerHTML = html;

                                        // 阻止链接点击冒泡（避免触发折叠）
                                        srText.querySelectorAll('a').forEach(function(link) {
                                            link.onclick = function(e) { e.stopPropagation(); };
                                        });

                                        srWrapper.appendChild(srHeader);
                                        srWrapper.appendChild(srText);

                                        // ★ 修复：将搜索结果插入到 aiMessageDiv 前面（如果已存在），
                                        //    避免 AI 先输出正文创建 aiMessageDiv 后，search_result 的 div 被追加到正文后面
                                        if (aiMessageDiv && aiMessageDiv.parentNode === messagesContainer) {
                                            messagesContainer.insertBefore(srWrapper, aiMessageDiv);
                                        } else {
                                            messagesContainer.appendChild(srWrapper);
                                        }
                                        teamScrollIfFollowing(messagesContainer);

                                    } else if (data.type === 'content') {
                                        // ★ 清理"正在思考下一步操作..."过渡状态条
                                        //   收到回复内容事件意味着 AI 已开始回复，过渡提示应立即消失
                                        clearTransientThinkingBars(messagesContainer);
                                        // ★ 过滤 <step id="N" /> 标记（AI 用于声明当前步骤，对用户不可见）
                                        data.content = filterStepTag(data.content);
                                        if (data.content && turnTimelineHostEl?.__processSequence) MoonYaProcessUI.boundary(turnTimelineHostEl.__processSequence);
                                        if (data.content && useAgentRuntime) {
                                            const record = Array.from(turnProcessNodes.values()).find(item => item.sequence.host.closest('.message') === (aiMessageDiv || findAiMessageByLoadingId(loadingId)));
                                            if (record) MoonYaProcessUI.boundary(record.sequence);
                                        }
                                        if (!aiMessageDiv) {
                                            // ★ 优先按 loadingId 找回 status 事件预建的占位
                                            //   （ensureTimeline 会打 id="moonya-ai-msg-<loadingId>"），
                                            //   保证过程行和 AI 正文落在同一条时间线内
                                            aiMessageDiv = findAiMessageByLoadingId(loadingId);
                                            if (aiMessageDiv) {
                                                aiContentDiv = aiMessageDiv.querySelector('.message-content');
                                            }
                                        }
                                        if (!aiMessageDiv) {
                                            if (!aiMessageDiv) {
                                                aiMessageDiv = document.createElement('div');
                                                aiMessageDiv.className = 'message ai';
                                                if (currentAgentName) {
                                                    aiMessageDiv.dataset.agentName = currentAgentName;
                                                    const senderLabel = document.createElement('div');
                                                    senderLabel.className = 'message-sender';
                                                    senderLabel.textContent = currentAgentName;
                                                    aiMessageDiv.appendChild(senderLabel);
                                                }
                                            }
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                                aiMessageDiv.appendChild(aiContentDiv);
                                                messagesContainer.appendChild(aiMessageDiv);
                                            }
                                            removeLoadingIndicator(loadingId);
                                        } else if (!aiMessageDiv.parentNode) {
                                            // ★ thinking handler 已创建 aiMessageDiv 但尚未挂载到容器
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                                aiMessageDiv.appendChild(aiContentDiv);
                                            }
                                            messagesContainer.appendChild(aiMessageDiv);
                                            removeLoadingIndicator(loadingId);
                                            // 如果有思考过程，统一创建/复用思考折叠框并填充内容
                                            if (!isThinkingEmpty(fullThinking)) {
                                                const thinkWrap = ensureThinkingWrapper(loadingId);
                                                const thinkingText = thinkWrap ? thinkWrap.querySelector('.thinking-text') : null;
                                                if (thinkingText) {
                                                    thinkingText.innerHTML = renderThinkingContent(fullThinking);
                                                }
                                                // 同步更新 aiThinkingDiv 引用，供后续 thinking 事件复用
                                                if (thinkingText) aiThinkingDiv = thinkingText;
                                            }
                                            
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                            }
                                            
                                            // 如果有专精模式路由分析，创建一个容器用于流式输出
                                            let analysisContainer = null;
                                            if (specialistSteps) {
                                                analysisContainer = document.createElement('div');
                                                analysisContainer.className = 'specialist-analysis';
                                                analysisContainer.style.cssText = 'background: var(--theme-accent-soft, #f8f9fa); padding: 16px 20px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; line-height: 1.8; color: var(--theme-text, #333);';
                                                aiContentDiv.appendChild(analysisContainer);
                                                
                                                // 开始流式输出专精分析，并等待完成
                                                (async () => {
                                                    await streamSpecialistAnalysis(analysisContainer, specialistSteps);
                                                    specialistStreamingComplete = true;
                                                    
                                                    if (aiMessageDiv) {
                                                        const htmlToSave = analysisContainer.outerHTML;
                                                        aiMessageDiv.dataset.specialistAnalysis = htmlToSave;
                                                        
                                                    }
                                                    if (fullReply) {
                                                        processCachedContent(fullReply, aiContentDiv);
                                                        fullReply = '';
                                                    }
                                                })();
                                            }
                                            
                                            aiMessageDiv.appendChild(aiContentDiv);
                                            messagesContainer.appendChild(aiMessageDiv);
                                            removeLoadingIndicator(loadingId);
                                        }
                                        
                                        // 等待专精模式流式输出完成后再处理AI回复内容
                                        if (!specialistStreamingComplete) {
                                            // 如果专精模式还在输出，缓存当前内容
                                            fullReply += data.content;
                                            fullReplyForRender += data.content;
                                            trySpeakShortReply(fullReply);
                                            petChatPushReply(fullReply, false);
                                            return;
                                        }

                                        // 添加内容到 fullReply
                                        fullReply += data.content;
                                        fullReplyForRender += data.content;
                                        trySpeakShortReply(fullReply);
                                        petChatPushReply(fullReply, false);
                                        let newContent = data.content;

                                        // ★ 时间线：正文段落是过程行的同级节点，段落间距由 CSS 控制。
                                        //   仅在段落容器缺失时接管，避免覆盖上面刚建好的 .message-content。
                                        var _tlForContent = ensureTimeline(aiMessageDiv, loadingId);
                                        if (!aiMessageDiv) aiMessageDiv = _tlForContent.message;
                                        if (!aiContentDiv) aiContentDiv = _tlForContent.content;

                                        // 实时处理新内容，检测代码块
                                        while (newContent.length > 0) {
                                            if (!inCodeBlock) {
                                                const codeStartIndex = newContent.indexOf('```');
                                                if (codeStartIndex !== -1) {
                                                    const textBeforeCode = newContent.substring(0, codeStartIndex);
                                                    if (textBeforeCode) {
                                                        if (!currentTextDiv) {
                                                            currentTextDiv = document.createElement('div');
                                                            currentTextDiv.className = 'ai-text-segment';
                                                            aiContentDiv.appendChild(currentTextDiv);
                                                            clearTurnLoadingIndicator();
                                                        }
                                                        currentTextContent += textBeforeCode;
                                                        // ★ 节流：每帧最多 parseMarkdown 一次
                                                        scheduleTextRender();
                                                    }
                                                    
                                                    // Commit preceding prose before releasing its segment at the code boundary.
                                                    flushPendingRenders();
                                                    newContent = newContent.substring(codeStartIndex + 3);
                                                    inCodeBlock = true;
                                                    codeBuffer = '';
                                                    currentCodeFilename = 'plaintext';
                                                } else {
                                                    if (!currentTextDiv) {
                                                        currentTextDiv = document.createElement('div');
                                                        currentTextDiv.className = 'ai-text-segment';
                                                        aiContentDiv.appendChild(currentTextDiv);
                                                        clearTurnLoadingIndicator();
                                                    }
                                                    currentTextContent += newContent;
                                                    // ★ 节流：每帧最多 parseMarkdown 一次
                                                    scheduleTextRender();
                                                    newContent = '';
                                                }
                                            } else {
                                                // 在代码块中，寻找代码块结束标记
                                                const codeEndIndex = newContent.indexOf('```');
                                                if (codeEndIndex !== -1) {
                                                    // 找到代码块结束
                                                    codeBuffer += newContent.substring(0, codeEndIndex);
                                                    
                                                    // 提取文件名/语言标识
                                                    let codeToShow = codeBuffer;
                                                    const firstLineEnd = codeBuffer.indexOf('\n');
                                                    if (firstLineEnd !== -1) {
                                                        const firstLine = codeBuffer.substring(0, firstLineEnd).trim();
                                                        if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                                                            currentCodeFilename = firstLine;
                                                            codeToShow = codeBuffer.substring(firstLineEnd + 1);
                                                        }
                                                    }
                                                    
                                                    // 创建代码块
                                                    if (!currentCodeBlockWrapper) {
                                                        currentCodeBlockWrapper = createCodeBlock(codeToShow.trim(), currentCodeFilename, Date.now(), true);
                                                        aiContentDiv.appendChild(currentCodeBlockWrapper);
                                                    } else {
                                                        const existingCodeEl = currentCodeBlockWrapper.querySelector('.plain-content pre code');
                                                        if (existingCodeEl) {
                                                            // 从 className 中提取语言类
                                                            const langMatch = existingCodeEl.className.match(/language-(\w+)/);
                                                            const lang = langMatch ? langMatch[1] : 'plaintext';
                                                            existingCodeEl.innerHTML = highlightCode(codeToShow.trim(), lang);
                                                        }
                                                    }
                                                    
                                                    newContent = newContent.substring(codeEndIndex + 3);
                                                    inCodeBlock = false;
                                                    currentCodeBlockWrapper = null;
                                                    currentCodeContentDiv = null;
                                                    codeBuffer = '';
                                                    currentTextDiv = null;
                                                    currentTextContent = '';
                                                } else {
                                                    // 没有找到结束，继续缓冲
                                                    codeBuffer += newContent;
                                                    
                                                    // 实时更新代码块内容
                                                    let tempCodeToShow = codeBuffer;
                                                    const firstLineEnd = codeBuffer.indexOf('\n');
                                                    if (firstLineEnd !== -1) {
                                                        const firstLine = codeBuffer.substring(0, firstLineEnd).trim();
                                                        if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                                                            if (firstLine.includes('.')) {
                                                                currentCodeFilename = firstLine;
                                                                tempCodeToShow = codeBuffer.substring(firstLineEnd + 1);
                                                            } else {
                                                                tempCodeToShow = codeBuffer.substring(firstLineEnd + 1);
                                                            }
                                                        }
                                                    }
                                                    
                                                    if (!currentCodeBlockWrapper) {
                                                        currentCodeBlockWrapper = createCodeBlock(tempCodeToShow, currentCodeFilename, Date.now(), true);
                                                        aiContentDiv.appendChild(currentCodeBlockWrapper);
                                                    } else {
                                                        // ★ 节流：原 highlightCode 每帧重新高亮整段累积代码，O(n²)。
                                                        //   流式中改用纯文本展示，最终高亮在代码块结束（```）时做一次。
                                                        scheduleCodeRender();
                                                    }

                                                    newContent = '';
                                                }
                                            }
                                        }

                                        // ★ 节流滚动：每帧最多一次，避免每 chunk 强制 reflow
                                        scheduleScroll();
                                    } else if (data.type === 'crawler_progress') {
                                        // 爬虫实时进度：更新 Agent 状态条
                                        const allExistingBars = messagesContainer.querySelectorAll('.agent-status-bar');
                                        allExistingBars.forEach(b => b.remove());

                                        // 首次收到进度时启动客户端计时器
                                        if (!crawlerStartTime) {
                                            crawlerStartTime = Date.now();
                                        }
                                        if (!crawlerTimerId) {
                                            crawlerTimerId = setInterval(function() {
                                                const bar = messagesContainer.querySelector('.agent-status-bar .status-detail');
                                                if (bar && crawlerStartTime) {
                                                    var t = (Date.now() - crawlerStartTime) / 1000;
                                                    var timeStr = t >= 60 ? Math.floor(t / 60) + '分' + Math.round(t % 60) + '秒' : t.toFixed(1) + '秒';
                                                    // 更新耗时部分（保留阶段和进度文字）
                                                    var txt = bar.getAttribute('data-base') || '';
                                                    if (txt) {
                                                        bar.textContent = txt + ' · ' + timeStr;
                                                    }
                                                }
                                            }, 200);
                                        }

                                        const statusBar = document.createElement('div');
                                        statusBar.className = 'agent-status-bar status-executing';
                                        
                                        const icon = document.createElement('span');
                                        icon.className = 'status-icon';
                                        icon.innerHTML = createWorkflowEmptyIcon(16, '#888888');
                                        icon.style.animation = 'none';
                                        
                                        const label = document.createElement('span');
                                        label.textContent = '网页爬虫';
                                        
                                        statusBar.appendChild(icon);
                                        statusBar.appendChild(label);

                                        // 构建进度详情（基础部分，不含耗时）
                                        let baseText = data.stage || '';
                                        if (data.total > 0 && data.current > 0) {
                                            baseText += ' (' + data.current + '/' + data.total + ')';
                                        }
                                        if (data.detail) {
                                            baseText += ' ' + data.detail;
                                        }

                                        // 实时耗时（客户端计时）
                                        var clientElapsed = (Date.now() - crawlerStartTime) / 1000;
                                        var timeStr = clientElapsed >= 60 ? Math.floor(clientElapsed / 60) + '分' + Math.round(clientElapsed % 60) + '秒' : clientElapsed.toFixed(1) + '秒';
                                        var progressText = baseText + ' · ' + timeStr;
                                        
                                        const detail = document.createElement('span');
                                        detail.className = 'status-detail';
                                        detail.textContent = progressText;
                                        detail.setAttribute('data-base', baseText);
                                        statusBar.appendChild(detail);
                                        
                                        messagesContainer.appendChild(statusBar);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'crawler_complete') {
                                        // 清理爬虫计时器
                                        if (crawlerTimerId) {
                                            clearInterval(crawlerTimerId);
                                            crawlerTimerId = null;
                                        }
                                        crawlerStartTime = null;

                                        // 爬取完成：更新状态条并显示摘要
                                        const allExistingBars = messagesContainer.querySelectorAll('.agent-status-bar');
                                        allExistingBars.forEach(b => b.remove());

                                        const cd = data.data || {};
                                        const total = cd.total || 0;
                                        const byType = cd.by_type || {};
                                        const localDir = cd.local_dir || '';
                                        const pageUrl = cd.page_url || '';
                                        const downloadUrl = cd.download_url || '';
                                        const failedCount = cd.failed_count || 0;
                                        const failedUrls = cd.failed_urls || [];
                                        const cdElapsed = cd.elapsed || 0;
                                        
                                        // 构建摘要内容（简洁纯文本）
                                        let summary = '网页爬取完成\n';
                                        summary += '目标: ' + pageUrl + '\n';
                                        summary += '共爬取 ' + total + ' 个资源';
                                        if (cdElapsed > 0) {
                                            var et = cdElapsed;
                                            summary += ' · 耗时' + (et >= 60 ? Math.floor(et / 60) + '分' + Math.round(et % 60) + '秒' : et.toFixed(1) + '秒');
                                        }
                                        summary += '\n  JS: ' + (byType.js || 0) + ' | CSS: ' + (byType.css || 0) + ' | 图片: ' + (byType.img || 0) + '\n';
                                        summary += '  字体: ' + (byType.font || 0) + ' | 媒体: ' + (byType.media || 0) + ' | 其他: ' + (byType.other || 0) + '\n';
                                        summary += '保存位置: ' + localDir;
                                        if (failedCount > 0) {
                                            summary += '\n\n' + failedCount + ' 个资源下载失败';
                                        }

                                        // 打开产物链接
                                        let actionHtml = '';
                                        if (localDir) {
                                            const openId = 'crawler-open-' + Date.now();
                                            actionHtml = '<div style="margin-top:8px;">' +
                                                '<a id="' + openId + '" href="#" style="text-decoration:none; color: var(--theme-accent-text, #2563eb);">打开产物</a></div>';
                                            setTimeout(function() {
                                                var openBtn = document.getElementById(openId);
                                                if (openBtn) {
                                                    openBtn.addEventListener('click', function(e) {
                                                        e.preventDefault();
                                                        if (window.moonYaFileOps && window.moonYaFileOps.openFolder) {
                                                            window.moonYaFileOps.openFolder(localDir)
                                                                .then(function(res) {
                                                                    if (!res || !res.success) {
                                                                        showToast('打开失败: ' + (res && res.message ? res.message : '未知错误'), 4000);
                                                                    }
                                                                })
                                                                .catch(function(err) {
                                                                    console.error('打开失败:', err);
                                                                    showToast('打开失败: ' + (err && err.message ? err.message : err), 4000);
                                                                });
                                                        } else {
                                                            showToast('Native bridge 不可用，无法打开文件夹', 4000);
                                                        }
                                                    });
                                                }
                                            }, 50);
                                        }

                                        // 作为 AI 消息添加
                                        if (!aiMessageDiv) {
                                            // ★ 优先按 loadingId 找回 status 事件预建的占位
                                            aiMessageDiv = findAiMessageByLoadingId(loadingId);
                                        }
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                        }
                                        if (!aiContentDiv) {
                                            aiContentDiv = document.createElement('div');
                                            aiContentDiv.className = 'message-content';
                                            aiMessageDiv.appendChild(aiContentDiv);
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }

                                        const summaryDiv = document.createElement('div');
                                        summaryDiv.style.cssText = 'white-space:pre-wrap;font-size:14px;color: var(--theme-text, #333);margin-top:8px;';
                                        summaryDiv.innerHTML = summary + actionHtml;
                                        aiContentDiv.appendChild(summaryDiv);
                                        
                                        fullReplyForRender = (fullReplyForRender || '') + '\n' + summary;
                                        
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'agent_tool_call') {
                                        const tool = data.tool;
                                        const args = data.args || {};
                                        removeLoadingIndicator(loadingId);
                                        // 工具调用时 AI 仍在工作，不切换按钮状态
                                        // currentAbortController 和 isSendingMessage 由 agent resend 的 sendMessage() 重新设置
                                        
                                        if (tool === 'get_weather') {
                                            handleWeatherRequest(null);
                                        } else if (tool === 'get_horoscope') {
                                            handleHoroscopeRequest();
                                        } else if (tool === 'translate_classical') {
                                            const classicalBtn = document.getElementById('classicalBtn');
                                            if (classicalBtn && !isClassicalMode) {
                                                classicalBtn.click();
                                            }
                                            const text = args.text || '';
                                            if (text) {
                                                showToast('Agent已自动匹配到【文言文翻译】，正在翻译...');
                                                window._agentPendingResend = { prompt: text, tool: 'classical' };
                                            }
                                        } else if (tool === 'open_video_site') {
                                            if (!window.WEB_RUNTIME_CONFIG?.videoPortalUrl) throw new Error('Missing required configuration: video_portal.url');
                                            window.open(window.WEB_RUNTIME_CONFIG.videoPortalUrl, '_blank');
                                        } else if (tool === 'web_search') {
                                            // web_search 由后端 PHP 直接处理，前端只需显示状态
                                            // 后端会在 SSE 中发送 status 事件
                                            showToast('Agent 正在联网搜索...');
                                        } else if (tool === 'web_fetch') {
                                            // web_fetch 由后端 PHP 直接处理，前端只需显示状态
                                            showToast('Agent 正在抓取网页...');
                                        } else if (tool === 'download_file') {
                                            const url = args.url || '';
                                            const searchQuery = args.search_query || '';
                                            const filename = args.filename || '';
                                            const method = args.method || 'direct';
                                            const path = args.path || '';

                                            if (url) {
                                                // 有URL：直接下载
                                                showToast('Agent已自动匹配到【文件下载】，正在下载...');
                                                executeDownload(url, path, filename, method);
                                            } else if (searchQuery) {
                                                // 无URL但有搜索词：先搜索再下载
                                                showToast('正在搜索下载链接...');
                                                fetch('/api/download_search.php', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ query: searchQuery })
                                                })
                                                .then(r => r.json())
                                                .then(result => {
                                                    if (result.success && result.best_url) {
                                                        showToast('找到下载链接，正在下载...');
                                                        executeDownload(result.best_url, path, filename || result.suggested_filename || '', method);
                                                    } else {
                                                        showToast('未找到下载链接，请提供具体URL');
                                                        addChatMessage('assistant', '未能自动找到下载链接，请提供您要下载的文件的URL地址。');
                                                    }
                                                })
                                                .catch(err => {
                                                    showToast('搜索下载链接失败');
                                                    addChatMessage('assistant', '搜索下载链接时出错：' + (err.message || '未知错误'));
                                                });
                                            } else if (filename) {
                                                // 无URL无搜索词但有文件名：用文件名构建搜索
                                                showToast('正在搜索下载链接...');
                                                fetch('/api/download_search.php', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ query: filename + ' 官方下载 直接下载链接' })
                                                })
                                                .then(r => r.json())
                                                .then(result => {
                                                    if (result.success && result.best_url) {
                                                        showToast('找到下载链接，正在下载...');
                                                        executeDownload(result.best_url, path, filename, method);
                                                    } else {
                                                        showToast('未找到下载链接，请提供具体URL');
                                                        addChatMessage('assistant', '未能自动找到下载链接，请提供您要下载的文件的URL地址。');
                                                    }
                                                })
                                                .catch(err => {
                                                    showToast('搜索下载链接失败');
                                                    addChatMessage('assistant', '搜索下载链接时出错：' + (err.message || '未知错误'));
                                                });
                                            } else {
                                                showToast('请提供文件下载链接或描述要下载的软件名称');
                                            }
                                        }
                                    } else if (data.type === 'cu_status') {
                                        // 模型请求开始即到达：只更新标题，不额外制造日志节点。
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', data.content || '正在处理');
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_thinking') {
                                        // 模型 SSE 增量复用一个节点，避免按 token 堆积后在末尾一次性显示。
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '分析当前状态');
                                        const cuThinkText = data.content || '';
                                        const cuStreamId = data.stream_id || '';
                                        if (data.delta && cuStreamId) {
                                            let streamedNode = cuTimeline.querySelector('.cu-step-thinking[data-cu-stream-id="' + cuStreamId + '"]');
                                            if (!streamedNode) {
                                                streamedNode = document.createElement('div');
                                                streamedNode.className = 'cu-step-node cu-step-thinking cu-step-running';
                                                streamedNode.setAttribute('data-cu-stream-id', cuStreamId);
                                                const streamedIcon = document.createElement('div');
                                                streamedIcon.className = 'cu-step-icon';
                                                streamedIcon.textContent = '·';
                                                const streamedText = document.createElement('div');
                                                streamedText.className = 'cu-step-text cu-thinking-text';
                                                streamedNode.appendChild(streamedIcon);
                                                streamedNode.appendChild(streamedText);
                                                cuTimeline.appendChild(streamedNode);
                                            }
                                            const streamedText = streamedNode.querySelector('.cu-thinking-text');
                                            if (streamedText) streamedText.textContent += cuThinkText;
                                            teamScrollIfFollowing(messagesContainer);
                                            return;
                                        }
                                        const cuThinkNode = document.createElement('div');
                                        cuThinkNode.className = 'cu-step-node cu-step-thinking cu-step-running';
                                        const cuThinkIcon = document.createElement('div');
                                        cuThinkIcon.className = 'cu-step-icon';
                                        cuThinkIcon.textContent = '·';
                                        const cuThinkContent = document.createElement('div');
                                        cuThinkContent.className = 'cu-step-text cu-thinking-text';
                                        cuThinkContent.textContent = cuThinkText;
                                        cuThinkNode.appendChild(cuThinkIcon);
                                        cuThinkNode.appendChild(cuThinkContent);
                                        cuTimeline.appendChild(cuThinkNode);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_screenshot') {
                                        // ★ CU 截图事件：按顺序作为时间线节点追加（不再独立堆叠）
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        // 新任务（index 1）重置截图序列
                                        if (data.index === 1) {
                                            currentCuScreenshots = [];
                                        }
                                        const cuShot = { image: data.image, index: data.index, timestamp: data.timestamp || '' };
                                        currentCuScreenshots.push(cuShot);
                                        aiMessageDiv._cuScreenshots = currentCuScreenshots;
                                        recordCodexViewedImage(aiMessageDiv, loadingId,
                                            'data:image/png;base64,' + String(cuShot.image || ''));
                                        // 复用统一的 .cu-timeline 时间线容器
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '读取屏幕');
                                        // 时间标签取 HH:MM:SS
                                        let cuTimeLabel = cuShot.timestamp;
                                        if (cuShot.timestamp && cuShot.timestamp.indexOf(' ') >= 0) {
                                            cuTimeLabel = cuShot.timestamp.split(' ').pop();
                                        }
                                        // 截图节点（带图标 + 缩略图卡片 + 文本）
                                        const cuShotNode = document.createElement('div');
                                        cuShotNode.className = 'cu-step-node cu-step-screenshot cu-step-done cu-step-with-screenshot';
                                        const cuShotIcon = document.createElement('div');
                                        cuShotIcon.className = 'cu-step-icon';
                                        cuShotIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
                                        const cuShotContent = document.createElement('div');
                                        cuShotContent.className = 'cu-step-content cu-screenshot-content';
                                        const cuShotTitle = document.createElement('div');
                                        cuShotTitle.className = 'cu-step-title';
                                        cuShotTitle.textContent = '截图 #' + cuShot.index + (cuTimeLabel ? ' · ' + cuTimeLabel : '');
                                        const cuCard = document.createElement('div');
                                        cuCard.className = 'cu-screenshot-card';
                                        cuCard.setAttribute('data-cu-index', String(cuShot.index));
                                        const cuThumb = document.createElement('img');
                                        cuThumb.className = 'cu-screenshot-thumb';
                                        cuThumb.src = 'data:image/png;base64,' + cuShot.image;
                                        cuThumb.alt = '截图 ' + cuShot.index;
                                        cuCard.appendChild(cuThumb);
                                        // 绑定当前数组引用与索引，点击打开灯箱
                                        const cuShotsRef = currentCuScreenshots;
                                        const cuClickIdx = cuShotsRef.length - 1;
                                        cuCard.addEventListener('click', function() {
                                            openCuLightbox(aiMessageDiv._cuScreenshots || cuShotsRef, cuClickIdx);
                                        });
                                        cuShotContent.appendChild(cuShotTitle);
                                        cuShotContent.appendChild(cuCard);
                                        cuShotNode.appendChild(cuShotIcon);
                                        cuShotNode.appendChild(cuShotContent);
                                        cuTimeline.appendChild(cuShotNode);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_action') {
                                        // ★ CU 动作事件：追加动作节点到时间线
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '执行操作');
                                        const cuAction = data.action || 'action';
                                        const cuParams = data.params || {};
                                        const cuIsKeyboard = /key|type|press|input/i.test(cuAction);
                                        let cuActionDesc = cuAction;
                                        if (data.target) {
                                            cuActionDesc = cuAction + '：' + data.target;
                                        } else if (cuParams.x !== undefined && cuParams.y !== undefined) {
                                            cuActionDesc = cuAction + ' (' + cuParams.x + ', ' + cuParams.y + ')';
                                            if (cuParams.button) cuActionDesc += ' [' + cuParams.button + (cuParams.click ? '/' + cuParams.click : '') + ']';
                                        } else if (cuParams.text) {
                                            cuActionDesc = cuAction + ': ' + cuParams.text;
                                        } else if (cuParams.key) {
                                            cuActionDesc = cuAction + ': ' + cuParams.key;
                                        }
                                        const cuActionNode = document.createElement('div');
                                        cuActionNode.className = 'cu-step-node cu-step-' + (cuIsKeyboard ? 'keyboard' : 'mouse') + ' cu-step-done cu-action-node';
                                        const cuActionIcon = document.createElement('div');
                                        cuActionIcon.className = 'cu-step-icon';
                                        const svgKeyboardSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"></path></svg>';
                                        const svgMouseSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="6"></rect><line x1="12" y1="7" x2="12" y2="11"></line></svg>';
                                        cuActionIcon.innerHTML = cuIsKeyboard ? svgKeyboardSmall : svgMouseSmall;
                                        const cuActionText = document.createElement('div');
                                        cuActionText.className = 'cu-step-text';
                                        cuActionText.textContent = cuActionDesc;
                                        cuActionNode.appendChild(cuActionIcon);
                                        cuActionNode.appendChild(cuActionText);
                                        cuTimeline.appendChild(cuActionNode);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_step') {
                                        // ★ CU 步骤事件：追加步骤节点到时间线
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '执行步骤');
                                        const cuStepType = data.step_type || 'screenshot';
                                        const cuStepStatus = data.status || 'running';
                                        const cuStepText = data.text || '';
                                        const svgCamera = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
                                        const svgMouse = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="6"></rect><line x1="12" y1="7" x2="12" y2="11"></line></svg>';
                                        const svgKeyboard = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"></path></svg>';
                                        const svgCheckSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                                        const svgDot = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle></svg>';
                                        const cuStepSym = cuStepType === 'screenshot' ? svgCamera
                                            : cuStepType === 'mouse' ? svgMouse
                                            : cuStepType === 'keyboard' ? svgKeyboard
                                            : cuStepType === 'complete' ? svgCheckSmall : svgDot;
                                        const cuStepNode = document.createElement('div');
                                        cuStepNode.className = 'cu-step-node cu-step-' + cuStepType + ' cu-step-' + cuStepStatus;
                                        const cuStepIconEl = document.createElement('div');
                                        cuStepIconEl.className = 'cu-step-icon';
                                        cuStepIconEl.innerHTML = cuStepSym;
                                        const cuStepTextEl = document.createElement('div');
                                        cuStepTextEl.className = 'cu-step-text';
                                        cuStepTextEl.textContent = cuStepText;
                                        cuStepNode.appendChild(cuStepIconEl);
                                        cuStepNode.appendChild(cuStepTextEl);
                                        cuTimeline.appendChild(cuStepNode);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_waiting_user') {
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        const waitPrompt = data.prompt || '请在应用窗口中完成登录操作';
                                        const waitNode = document.createElement('div');
                                        waitNode.className = 'cu-step-node cu-step-warning cu-step-running cu-waiting-user';
                                        const waitIcon = document.createElement('div');
                                        waitIcon.className = 'cu-step-icon';
                                        waitIcon.textContent = '!';
                                        const waitText = document.createElement('div');
                                        waitText.className = 'cu-step-text';
                                        waitText.textContent = waitPrompt;
                                        waitNode.appendChild(waitIcon);
                                        waitNode.appendChild(waitText);
                                        cuTimeline.appendChild(waitNode);
                                        setCuCardState(aiMessageDiv, 'waiting', '等待你扫码/验证');
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_complete') {
                                        // ★ CU 完成事件：标记所有运行中节点为完成，追加完成节点
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        const cuRunningNodes = cuTimeline.querySelectorAll('.cu-step-running');
                                        cuRunningNodes.forEach(function(n) {
                                            n.classList.remove('cu-step-running');
                                            n.classList.add('cu-step-done');
                                        });
                                        const cuSummary = data.summary || '任务已完成';
                                        teamScrollIfFollowing(messagesContainer);
                                        // 最终结论只在正常消息区出现一次，避免标题、时间线、Toast 三重重复。
                                        let cuMsgContent = aiMessageDiv.querySelector('.message-content');
                                        if (!cuMsgContent) {
                                            cuMsgContent = document.createElement('div');
                                            cuMsgContent.className = 'message-content';
                                            aiMessageDiv.appendChild(cuMsgContent);
                                        }
                                        cuMsgContent.classList.add('cu-final-answer');
                                        cuMsgContent.style.display = '';
                                        cuMsgContent.textContent = cuSummary;
                                        const cuFinalState = data.status === 'success' ? 'done'
                                            : data.status === 'needs_user' ? 'waiting'
                                            : data.status === 'error' ? 'error' : 'limited';
                                        const cuFinalLabel = cuFinalState === 'done' ? '完成'
                                            : cuFinalState === 'waiting' ? '等待你操作'
                                            : cuFinalState === 'error' ? '需要处理' : '已停止';
                                        setCuCardState(aiMessageDiv, cuFinalState, cuFinalLabel);
                                    } else if (data.type === 'cu_plan') {
                                        // ★ CU Plan-Act-Verify: 渲染任务计划卡片
                                        if (!aiMessageDiv) {
                                            aiMessageDiv = document.createElement('div');
                                            aiMessageDiv.className = 'message ai';
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '制定操作计划');
                                        // 计划卡片容器
                                        const planCard = document.createElement('div');
                                        planCard.className = 'cu-plan-card';
                                        const planHeader = document.createElement('div');
                                        planHeader.className = 'cu-plan-header';
                                        planHeader.innerHTML = '<span class="cu-plan-icon">·</span> 任务计划';
                                        planCard.appendChild(planHeader);
                                        // 步骤列表
                                        const planSteps = document.createElement('div');
                                        planSteps.className = 'cu-plan-steps';
                                        const steps = data.steps || [];
                                        steps.forEach(function(step, idx) {
                                            const stepDiv = document.createElement('div');
                                            stepDiv.className = 'cu-plan-step';
                                            stepDiv.setAttribute('data-step-id', step.id || (idx + 1));
                                            stepDiv.setAttribute('data-task-type', step.task_type || 'click');
                                            const stepNum = document.createElement('span');
                                            stepNum.className = 'cu-plan-step-num';
                                            stepNum.textContent = step.id || (idx + 1);
                                            const stepTitle = document.createElement('span');
                                            stepTitle.className = 'cu-plan-step-title';
                                            stepTitle.textContent = step.title || '';
                                            const stepType = document.createElement('span');
                                            stepType.className = 'cu-plan-step-type cu-task-type-' + (step.task_type || 'click');
                                            const typeLabels = {drag:'拖拽',click:'点击',type:'输入',key:'快捷键',observe:'观察',scroll:'滚动'};
                                            stepType.textContent = typeLabels[step.task_type] || step.task_type || '';
                                            stepDiv.appendChild(stepNum);
                                            stepDiv.appendChild(stepTitle);
                                            stepDiv.appendChild(stepType);
                                            planSteps.appendChild(stepDiv);
                                        });
                                        planCard.appendChild(planSteps);
                                        cuTimeline.appendChild(planCard);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_step_progress') {
                                        // ★ CU Plan-Act-Verify: 更新步骤进度
                                        if (!aiMessageDiv) return;
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        const stepId = data.step_index;
                                        const totalSteps = data.total_steps;
                                        const stepTitle = data.step_title || '';
                                        const taskType = data.task_type || '';
                                        const status = data.status || 'started';
                                        setCuCardState(aiMessageDiv, 'working', status === 'verifying' ? '验证结果'
                                            : status === 'completed' ? '完成步骤'
                                            : status === 'retrying' ? '重试步骤' : '执行步骤');
                                        // 更新计划步骤状态
                                        const planSteps = cuTimeline.querySelectorAll('.cu-plan-step');
                                        planSteps.forEach(function(s) {
                                            if (parseInt(s.getAttribute('data-step-id')) === stepId) {
                                                s.classList.remove('cu-step-pending','cu-step-active','cu-step-verifying','cu-step-completed','cu-step-failed','cu-step-retrying');
                                                s.classList.add('cu-step-' + status);
                                            }
                                        });
                                        // 添加/更新进度节点
                                        let progressNode = cuTimeline.querySelector('.cu-progress-node[data-step="' + stepId + '"]');
                                        if (!progressNode) {
                                            progressNode = document.createElement('div');
                                            progressNode.className = 'cu-step-node cu-step-running cu-progress-node';
                                            progressNode.setAttribute('data-step', stepId);
                                            const pIcon = document.createElement('div');
                                            pIcon.className = 'cu-step-icon';
                                            const pText = document.createElement('div');
                                            pText.className = 'cu-step-text';
                                            progressNode.appendChild(pIcon);
                                            progressNode.appendChild(pText);
                                            cuTimeline.appendChild(progressNode);
                                        }
                                        const iconEl = progressNode.querySelector('.cu-step-icon');
                                        const textEl = progressNode.querySelector('.cu-step-text');
                                        const svgPlay = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                                        const svgGear = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
                                        const svgSearch = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
                                        const svgRetry = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
                                        const svgCheckSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                                        const svgCrossSmall = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
                                        const statusMap = {
                                            started: {icon:svgPlay, text:'开始：' + stepTitle, cls:'cu-step-running'},
                                            acting: {icon:svgGear, text:'执行中：' + stepTitle, cls:'cu-step-running'},
                                            verifying: {icon:svgSearch, text:'验证中：' + stepTitle, cls:'cu-step-running'},
                                            completed: {icon:svgCheckSmall, text:'完成：' + stepTitle, cls:'cu-step-done'},
                                            failed: {icon:svgCrossSmall, text:'失败：' + stepTitle, cls:'cu-step-error'},
                                            retrying: {icon:svgRetry, text:'重试(' + stepTitle + ')', cls:'cu-step-running'}
                                        };
                                        const sMap = statusMap[status] || statusMap.started;
                                        iconEl.innerHTML = sMap.icon;
                                        textEl.textContent = sMap.text;
                                        progressNode.classList.remove('cu-step-running','cu-step-done','cu-step-error');
                                        progressNode.classList.add(sMap.cls);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'cu_verify') {
                                        // ★ CU Plan-Act-Verify: 渲染验证结果
                                        if (!aiMessageDiv) return;
                                        const cuTimeline = ensureCuTimeline(aiMessageDiv);
                                        setCuCardState(aiMessageDiv, 'working', '验证结果');
                                        const stepId = data.step_index;
                                        const completed = data.completed;
                                        const reason = data.reason || '';
                                        const missing = data.missing || '';
                                        const round = data.verify_round || 0;
                                        const verifyNode = document.createElement('div');
                                        verifyNode.className = 'cu-step-node cu-step-done cu-verify-result';
                                        const vIcon = document.createElement('div');
                                        vIcon.className = 'cu-step-icon';
                                        vIcon.innerHTML = completed ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
                                        const vText = document.createElement('div');
                                        vText.className = 'cu-step-text';
                                        let vContent = '验证' + (round > 0 ? '(第' + (round + 1) + '轮)' : '') + '：';
                                        vContent += completed ? '通过' : '未通过';
                                        if (reason) vContent += ' — ' + reason;
                                        if (missing) vContent += '（缺失：' + missing + '）';
                                        vText.textContent = vContent;
                                        verifyNode.appendChild(vIcon);
                                        verifyNode.appendChild(vText);
                                        cuTimeline.appendChild(verifyNode);
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'ba_screenshot') {
                                        // ★ Browser Automation 截图事件：追加缩略图到 BA 面板
                                        //   - 不覆盖现有截图列表（累加）
                                        //   - 点击缩略图弹出全屏灯箱查看
                                        //   - 面板在 BA 可用模式（agent / computer_user）下显示，否则隐藏
                                        if (window.BaPanel && typeof window.BaPanel.appendScreenshot === 'function') {
                                            window.BaPanel.appendScreenshot(data);
                                        }
                                        if (aiMessageDiv) recordCodexViewedImage(aiMessageDiv, loadingId,
                                            'data:image/png;base64,' + String(data.image || ''));
                                    } else if (data.type === 'ba_status') {
                                        // ★ Browser Automation 状态事件：累加到状态时间线（不覆盖）
                                        //   每条状态显示为一行：[时间] action: status
                                        //   status="error" 时用红色文字
                                        if (window.BaPanel && typeof window.BaPanel.appendStatus === 'function') {
                                            window.BaPanel.appendStatus(data);
                                        }
                                    } else if (data.type === 'vls_analysis') {
                                        // ★ VLS 视觉布局分析事件：渲染为可交互的 VLS 分析报告卡片
                                        //   卡片含：页面摘要、元素清单（type/css_selector/position/state）、推荐操作
                                        if (window.BaPanel && typeof window.BaPanel.renderVlsAnalysis === 'function') {
                                            window.BaPanel.renderVlsAnalysis(data);
                                        }
                                        // 同时在主对话区域追加一份可读的 VLS 摘要（保留对话上下文）
                                        // ★ 挂载到 aiMessageDiv 末尾（.message-content 的兄弟节点），
                                        //   避免 done 事件重渲染 .message-content 时被覆盖（参考 specialistAnalysis 处理）
                                        if (aiMessageDiv) {
                                            const vlsCard = document.createElement('div');
                                            vlsCard.className = 'vls-summary-card';
                                            vlsCard.innerHTML = window.BaPanel && typeof window.BaPanel.buildVlsCardHtml === 'function'
                                                ? window.BaPanel.buildVlsCardHtml(data)
                                                : ('[VLS 分析] ' + (data.summary || ''));
                                            aiMessageDiv.appendChild(vlsCard);
                                            teamScrollIfFollowing(messagesContainer);
                                        }
                                    } else if (data.type === 'trigger_music_request') {
                                        // 直接搜索音乐并渲染卡片（不发送用户消息，复用「来点音乐」流程）
                                        // 防重复：同一 Agent 请求 5 秒内不重复触发
                                        if (window._lastMusicTriggerTime && (Date.now() - window._lastMusicTriggerTime < 5000)) {
                                            return;
                                        }
                                        window._lastMusicTriggerTime = Date.now();
                                        (async function() {
                                            try {
                                                const userQuery = (data.query || '').trim();
                                                const keyword = userQuery || MUSIC_RANDOM_KEYWORDS[Math.floor(Math.random() * MUSIC_RANDOM_KEYWORDS.length)];
                                                const replyText = userQuery ? '搜索到以下音乐：' : '为您推荐以下音乐：';
                                                const result = await window.fetchMusicSearchResult(keyword);
                                                if (result && result.music.length > 0) {
                                                    window.renderMusicResult(result.music, replyText);
                                                }
                                            } catch (e) {
                                                console.error('Agent 音乐搜索失败:', e);
                                            }
                                        })();
                                    } else if (data.type === 'execution_code') {
                                        closeContentSegment();
                                        const tl = ensureTimeline(aiMessageDiv, loadingId); aiMessageDiv = tl.message; aiContentDiv = tl.content;
                                        const sequence = tl.message.__processSequence;
                                        sequence.legacyPending ||= new Map();
                                        const tool = data.exec_type === 'python' ? 'execute_python' : 'execute_command';
                                        const existing = sequence.legacyPending.get(tool);
                                        const key = data.tool_call_id || (existing && MoonYaProcessUI.isRunning(sequence.tools.get(existing)?.spec.state) ? existing : 'exec:' + sequence.tools.size);
                                        sequence.legacyPending.set(tool, key); sequence.lastCommand = key;
                                        MoonYaProcessUI.tool(sequence, key, { tool, args: { command: data.code || '' }, state: 'executing' });
                                        clearTurnLoadingIndicator(); teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'execution_result') {
                                        const sequence = aiMessageDiv?.__processSequence;
                                        const key = data.tool_call_id || sequence?.lastCommand;
                                        if (sequence && key) MoonYaProcessUI.tool(sequence, key, { result: data.result || {},
                                            state: data.result?.status === 'success' ? 'success' : data.result?.status === 'rejected' ? 'stopped' : 'failure' });
                                        teamScrollIfFollowing(messagesContainer);
                                    } else if (data.type === 'done') {
                                        // CU 光效由桌面端真实输入生命周期维护。
                                        // ★ 同步刷新待渲染内容：确保最后几个 chunk 已写入 DOM，
                                        //   再标记 streamRenderDone 阻止后续 RAF
                                        flushPendingRenders();
                                        streamRenderDone = true;
                                        clearNetworkRecoveryNotice();
                                        delete sendData.resume;
                                        // ★ 桌宠气泡：推送最终完整回答（C# 侧此时朗读摘要）
                                        petChatFinishReply(fullReply);
                                        // ★ 修复：如果气泡未挂载（AI 只思考未输出正文），先挂载到 DOM
                                        if (aiMessageDiv && !aiMessageDiv.parentNode) {
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                                aiMessageDiv.appendChild(aiContentDiv);
                                            }
                                            messagesContainer.appendChild(aiMessageDiv);
                                        }
                                        // ★ 全局清理空 wrapper（不依赖 loadingId 标记）
                                        removeEmptyThinkingWrappers(messagesContainer);
                                        // ★ 统一处理当前气泡的思考框：回填/展开/删除（保留 fullThinking 供收尾使用，不在此处清空）
                                        cleanupThinkingWrapper(aiMessageDiv, fullThinking);
                                        if (aiMessageDiv) {
                                            // ★ 时间线：只对当前活动正文段做收尾重渲染。
                                            //   旧实现用 renderContentWithCodeBlocks(messageContent, ...) 整体重建，
                                            //   会把已经按顺序排好的过程行全部清空（renderContentWithCodeBlocks 首行即 innerHTML=''）。
                                            const messageContent = aiMessageDiv.querySelector('.message-content');
                                            if (messageContent && currentTextDiv && currentTextContent) {
                                                const hasCodeBlocks = currentTextContent.includes('```');
                                                const hasTable = /^\|.+\|[\s\S]*^\|[-:| ]+\|/m.test(currentTextContent);
                                                if (hasCodeBlocks || hasTable) {
                                                    currentTextDiv.innerHTML = '';
                                                    renderContentWithCodeBlocks(currentTextDiv, currentTextContent);
                                                }
                                            }
                                        }
                                        // 记录本轮耗时并刷新头部"用时 X"文案
                                        if (turnStartedAt) {
                                            const _elapsedMs = Date.now() - turnStartedAt;
                                            const _tl = aiMessageDiv ? aiMessageDiv.querySelector('.message-content') : null;
                                            if (_tl) setTimelineElapsed(_tl, _elapsedMs);
                                        }
                                        if (aiMessageDiv) aiMessageDiv.classList.add('codex-final-answer');
                                        closeContentSegment();
                                        // ★ 时间线：本段收束后允许后续 content 事件继续渲染新段落
                                        //   （同一请求可能有多轮 done，后续内容仍落在同一条时间线上）
                                        streamRenderDone = false;
                                        // ★ 但"本轮已正常结束"必须单独记一个标志：
                                        //   streamRenderDone 同时被 read() 用来判断 EOF 是否为异常断流，
                                        //   复用会让正常结束被当成断流 → 触发重连 → 后端重新 POST 同一条消息
                                        //   → 工作日志出现重复的"思考与回复"块。
                                        streamTurnFinished = true;
                                        // ★ 本轮结束：刷新上下文圆环（Work 模式无 context_usage 事件，
                                        //   靠这里从新落库的历史重算占用；Chat 模式则与 SSE 上报互相印证）
                                        if (window.MoonYaContextRing) window.MoonYaContextRing.refresh();
                                        textRenderRafPending = false;
                                        codeRenderRafPending = false;
                                        if (!turnBubbleIsLoadingPlaceholder) {
                                            removeLoadingIndicator(loadingId);
                                        } else {
                                            clearTurnLoadingIndicator();
                                        }
                                        finishSendRuntime(data.status === 'quota_stopped' ? 'quota_stopped' : undefined);
                                        activeThinkingWrapper = null;
                                        // 停止卡顿检测器
                                        if (sendIsVisible()) stopStallDetector();
                                        setTimeout(() => {
                                            const btn = sendIsVisible() ? document.getElementById('sendBtn') : null;
                                            if (btn) {
                                                btn.removeAttribute('data-state');
                                                btn.innerHTML = '<img id="sendBtnImg" src="/image/composer-send.svg" alt="发送">';
                                            }
                                        }, 10);

                                        // ★ 防重复播报（实时语音对话核心修复）：
                                        //   petChatWillSpeak 来自 C# shouldSpeakForPet = _isPetVisible && _ttsEnabled，
                                        //   恰好是 C# 桌宠实际朗读（SpeakBubble 受 _ttsEnabled 约束，ShowAiReplyCore 受 _isPetVisible 约束）的充要条件。
                                        //   需求矩阵：
                                        //     桌宠可见+TTS开           → 桌宠朗读，JS 不响（避免重复两遍）
                                        //     桌宠不可见/TTS关+语音回复开 → JS speakText 朗读
                                        //     桌宠不可见/TTS关+语音回复关+实时语音对话开 → JS speakText 强制朗读（实时语音对话场景）
                                        //     桌宠不可见/TTS关+语音回复关+实时语音对话关 → 都不响
                                        if (!voiceShortReplySpoken && fullReply && (isVoiceBroadcastEnabled || isVoiceChatActive()) && !petChatWillSpeak) {
                                            window.speakText(fullReply);
                                        }
                                        if (aiMessageDiv && fullReply) {
                                            saveCurrentChat(sendRuntime);
                                        }
                                        isProgrammingMode = false;
                                        isResearchMode = false;
                                        isClassicalMode = false;
                                        const programmingBtn = document.querySelector('.feature-btn.programming');
                                        if (programmingBtn) {
                                            programmingBtn.classList.remove('active');
                                        }
                                    } else if (data.type === 'todo_update') {
                                        // ★ Task 15: TodoWrite 任务列表（内联展示在当前 streaming 消息气泡内）
                                        //   字段兼容：todos / tasks / items；每项支持 id / content / status / priority / created_at
                                        if (window.MoonYaTaskPanel) {
                                            window.MoonYaTaskPanel.renderTodoUpdate(data, aiMessageDiv, loadingId);
                                        }
                                        // 任务列表到达即意味着 AI 有规划输出，先把气泡挂到 DOM 避免游离
                                        if (aiMessageDiv && !aiMessageDiv.parentNode) {
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                                aiMessageDiv.appendChild(aiContentDiv);
                                            }
                                            messagesContainer.appendChild(aiMessageDiv);
                                            removeLoadingIndicator(loadingId);
                                        }

                                    } else if (data.type === 'diagnostics') {
                                        // ★ Task 16: 诊断信息（编辑文件后展示错误/警告/提示，点击跳转 edit_file view）
                                        if (window.MoonYaTaskPanel) {
                                            window.MoonYaTaskPanel.renderDiagnostics(data, aiMessageDiv, loadingId);
                                        }
                                        if (aiMessageDiv && !aiMessageDiv.parentNode) {
                                            if (!aiContentDiv) {
                                                aiContentDiv = document.createElement('div');
                                                aiContentDiv.className = 'message-content';
                                                aiMessageDiv.appendChild(aiContentDiv);
                                            }
                                            messagesContainer.appendChild(aiMessageDiv);
                                            removeLoadingIndicator(loadingId);
                                        }

                                    } else if (data.type === 'command_started') {
                                        closeContentSegment();
                                        const tl = ensureTimeline(aiMessageDiv, loadingId); aiMessageDiv = tl.message; aiContentDiv = tl.content;
                                        const sequence = tl.message.__processSequence, commandId = data.command_id || data.id;
                                        if (sequence && commandId) {
                                            const previous = sequence.commands.get(commandId);
                                            const pending = sequence.legacyPending?.get('execute_command');
                                            const key = previous?.row.dataset.toolId || (pending && MoonYaProcessUI.isRunning(sequence.tools.get(pending)?.spec.state) ? pending : 'background:' + commandId);
                                            const row = MoonYaProcessUI.tool(sequence, key, { tool: 'execute_command', args: { command: data.command || data.cmd || sequence.tools.get(key)?.spec.args.command || '' },
                                                result: { command_id: commandId, status: 'running' }, state: 'executing' });
                                            window.MoonYaTaskPanel?.renderCommandStarted(data, tl.message, loadingId);
                                            const card = tl.message.querySelector('.my-bgcmd-card[data-cid="' + CSS.escape(commandId) + '"]');
                                            const detail = row.querySelector('.codex-tool-detail');
                                            if (card && detail) {
                                                const controls = document.createElement('div'); controls.className = 'moonya-task-host'; const oldHost = card.parentElement; controls.appendChild(card); detail.appendChild(controls);
                                                if (!oldHost.childNodes.length) oldHost.remove();
                                            }
                                            clearTurnLoadingIndicator();
                                        }
                                    } else if (data.type === 'command_output') {
                                        window.MoonYaTaskPanel?.renderCommandOutput(data, aiMessageDiv);
                                        const sequence = aiMessageDiv?.__processSequence, commandId = data.command_id || data.id;
                                        const entry = sequence?.commands.get(commandId);
                                        if (entry) {
                                            const chunk = data.chunk || data.output || data.text || '';
                                            const complete = data.done || data.completed || data.status === 'done';
                                            const failed = data.status === 'error' || (complete && Number(data.exit_code || 0) !== 0);
                                            MoonYaProcessUI.tool(sequence, entry.row.dataset.toolId, { result: { ...entry.spec.result,
                                                status: complete ? 'done' : data.status === 'stopped' ? 'killed' : 'running',
                                                stdout: (entry.spec.result.stdout || '') + chunk, ...(data.exit_code !== undefined ? { exit_code: data.exit_code } : {}) },
                                                state: failed ? 'failure' : complete ? 'success' : data.status === 'stopped' ? 'stopped' : 'executing' });
                                        }
                                    } else if (data.type === 'error') {
                                        if (data.error_code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('moonya:auth-expired'));
                                        // CU 光效由桌面端真实输入生命周期维护。
                                        if (data.recoverable === true) {
                                            pendingRecoverableStreamError = new Error(data.content || data.error_code || '可恢复的事件流错误');
                                        } else {
                                            // 业务错误是终态，不允许在 EOF 后按网络故障重复 POST。
                                            streamTurnFinished = true;
                                            restoreUnconfirmedSubmission();
                                            removeLoadingIndicator(loadingId);
                                            finalizeTurnElapsed(loadingId, aiMessageDiv);
                                            finishSendRuntime('failed');
                                            if (sendIsVisible()) stopStallDetector();
                                            const sendBtn = sendIsVisible() ? document.getElementById('sendBtn') : null;
                                            if (sendBtn) {
                                                sendBtn.disabled = false;
                                                sendBtn.removeAttribute('data-state');
                                                sendBtn.innerHTML = '<img id="sendBtnImg" src="/image/composer-send.svg" alt="发送">';
                                            }
                                            const messageInput = document.querySelector('.message-input');
                                            if (messageInput) messageInput.disabled = false;
                                            delete sendData.resume;
                                            if (data.error_code === 'session_not_found' && sendRuntime.harnessSessionKey) {
                                                const storedSessionId = localStorage.getItem(sendRuntime.harnessSessionKey) || '';
                                                const failedSessionId = String(data.session_id || sendData.harness_session_id || '');
                                                if (storedSessionId && storedSessionId === failedSessionId) {
                                                    localStorage.removeItem(sendRuntime.harnessSessionKey);
                                                }
                                                sendData.harness_session_id = '';
                                            }
                                            // 直接显示一次错误消息，不使用逐字输出。
                                            addMessage('ai', data.content);
                                        }
                                    }
                                    // ★ 终极防御：每个 SSE 事件处理后，全局扫描清理所有空思考框
                                    // 确保无论任何类型的事件（thinking/content/status/等）是否意外
                                    // 创建了空 wrapper，都在下一轮事件前被移除
                                    removeEmptyThinkingWrappers(messagesContainer);
                                    publishRuntimeDomSnapshot(false);
                                } catch (e) {
                                    console.warn('SSE JSON parse error:', e, dataStr.substring(0, 200));
                                }
                            }
                        });
                        
                        return read();
                    }).catch(error => {
                            if (error.name === 'AbortError') {
                                throw error;
                            }
                            // 其他错误也需要抛出，确保外部catch块能处理
                            throw error;
                        });
                }
                
                return read();
            })
            .catch(error => {
                if (sendSettled) return;
                if (error.name === 'AbortError') {
                    finalizeCancelledResponse();
                    return;
                } else {
                    clearNetworkRecoveryNotice();
                    window.dispatchEvent(new CustomEvent('moonya:network-event', { detail: {
                        type: 'network.reconnect_failed',
                        attempt: networkRetryMax,
                        max_attempts: networkRetryMax,
                        error: error.message
                    }}));
                    restoreUnconfirmedSubmission();
                    addMessage('ai', deliveryConfirmed
                        ? '连接中断，续传失败。恢复连接后请检查任务状态。'
                        : '连接不可用，输入已保留。尚未确认消息是否送达，请检查对话后手动发送。');
                }
                // CU 光效由桌面端真实输入生命周期维护。
                // ★ 统一段落结束处理：异常/中断时也要刷新并清理思考框，避免留下空框架
                //   flushPendingRenders + 挂载未挂载气泡 + 全局空 wrapper 清理 + 当前 wrapper 收尾 + 释放引用
                finalizeThinkingAtBoundary(loadingId);
                // 移除加载状态（finalizeThinkingAtBoundary 内部仅在 aiMessageDiv 未挂载时移除，此处兜底）
                removeLoadingIndicator(loadingId);
                finalizeTurnElapsed(loadingId, null);
                publishRuntimeDomSnapshot(true);
                // 切换回发送图片
                finishSendRuntime(error.name === 'AbortError' ? 'cancelled' : 'failed');
                // 停止卡顿检测器
                if (sendIsVisible()) stopStallDetector();
                setTimeout(() => {
                    const btn = sendIsVisible() ? document.getElementById('sendBtn') : null;
                    if (btn) {
                        btn.removeAttribute('data-state');
                        btn.innerHTML = '<img id="sendBtnImg" src="/image/composer-send.svg" alt="发送">';
                    }
                }, 10);
            });
            } catch (sendErr) {
                // ★ 全局兜底：sendMessage 体内任何异常都必须复位发送状态与按钮，
                //   否则 isSendingMessage 永远 true、按钮永远停在「终止」、之后无法再发送
                console.error('[sendMessage] 未捕获异常:', sendErr);
                restoreUnconfirmedSubmission();
                // CU 光效由桌面端真实输入生命周期维护。
                finishSendRuntime('failed');
                try { if (sendIsVisible()) stopStallDetector(); } catch (e) {}
                setTimeout(() => {
                    const btn = sendIsVisible() ? document.getElementById('sendBtn') : null;
                    if (btn) {
                        btn.removeAttribute('data-state');
                        btn.innerHTML = '<img id="sendBtnImg" src="/image/composer-send.svg" alt="发送">';
                    }
                }, 10);
                try {
                    if (typeof showToast === 'function') {
                        showToast('发送失败：' + (sendErr && sendErr.message ? sendErr.message : '未知错误'));
                    }
                } catch (e) {}
            }
        }

        function addMessage(type, content, images = [], imageFileIds = [], prependHtml = '', targetContainer = null, skillNames = [], attachmentItems = null) {
            const destinationContainer = targetContainer || messagesContainer;
            content = typeof cleanAccidentalDomString === 'function'
                ? cleanAccidentalDomString(content)
                : (content == null ? '' : String(content));
            // prependHtml 只能接收调用方明确提供的 HTML 字符串，DOM 节点不能隐式转字符串。
            if (typeof prependHtml !== 'string') prependHtml = '';
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${type}`;

            if (type === 'ai' && currentAgentName) {
                messageDiv.dataset.agentName = currentAgentName;
                const senderLabel = document.createElement('div');
                senderLabel.className = 'message-sender';
                senderLabel.textContent = currentAgentName;
                messageDiv.appendChild(senderLabel);
            }

            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';

            let skillsDiv = null;
            if (type === 'user' && Array.isArray(skillNames) && skillNames.length > 0) {
                skillsDiv = document.createElement('span');
                skillsDiv.className = 'sent-selected-skills';
                skillNames.forEach(function(name) {
                    const skill = SKILL_CATALOG.find(function(item) { return item.name === name; });
                    if (!skill) return;
                    const chip = document.createElement('span');
                    chip.className = 'sent-selected-skill';
                    chip.dataset.skillName = name;
                    chip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5"></path></svg>';
                    const label = document.createElement('span');
                    label.textContent = skill.display_name || name;
                    chip.appendChild(label);
                    skillsDiv.appendChild(chip);
                });
            }
            
            // 如果有前置HTML内容（如专精模式路由分析），先添加
            if (prependHtml) {
                const prependDiv = document.createElement('div');
                prependDiv.innerHTML = prependHtml;
                contentDiv.appendChild(prependDiv);
            }
            
            const userAttachments = type === 'user' ? attachmentItems || MoonYaAttachments.legacy(images) : [];
            if (type === 'user') MoonYaAttachments.gallery(contentDiv, userAttachments);
            // 如果有图片，先添加图片
            if (type !== 'user' && images && images.length > 0) {
                const imagesContainer = document.createElement('div');
                imagesContainer.style.display = 'flex';
                imagesContainer.style.gap = '8px';
                imagesContainer.style.flexWrap = 'wrap';
                imagesContainer.style.marginBottom = '8px';
                
                images.forEach((imgUrl, index) => {
                    if (imgUrl && (imgUrl.startsWith('pdf://') || imgUrl.startsWith('doc://') || imgUrl.startsWith('txt://'))) {
                        const fileDiv = document.createElement('div');
                        fileDiv.style.display = 'inline-flex';
                        fileDiv.style.alignItems = 'center';
                        fileDiv.style.gap = '6px';
                        fileDiv.style.padding = '6px 12px';
                        fileDiv.style.borderRadius = '8px';
                        fileDiv.style.fontSize = '12px';
                        let iconColor = 'var(--theme-danger, #ff4d4f)';
                        let bgColor = 'var(--theme-danger-soft, #fff2f0)';
                        let borderColor = 'var(--theme-border, #ffccc7)';
                        let displayName = imgUrl.replace(/^(pdf|doc|txt):\/\//, '');
                        if (imgUrl.startsWith('doc://')) {
                            iconColor = 'var(--theme-accent-text, #1677ff)';
                            bgColor = 'var(--theme-accent-soft, #e6f4ff)';
                            borderColor = 'var(--theme-border, #91caff)';
                        } else if (imgUrl.startsWith('txt://')) {
                            iconColor = 'var(--theme-success, #52c41a)';
                            bgColor = 'var(--theme-success-soft, #f6ffed)';
                            borderColor = 'var(--theme-border, #b7eb8f)';
                        }
                        fileDiv.style.backgroundColor = bgColor;
                        fileDiv.style.border = `1px solid ${borderColor}`;
                        fileDiv.style.color = iconColor;
                        fileDiv.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span>${displayName}</span>`;
                        if (imageFileIds && imageFileIds[index]) {
                            fileDiv.setAttribute('data-file-id', imageFileIds[index]);
                        }
                        imagesContainer.appendChild(fileDiv);
                    } else if (imgUrl && imgUrl.startsWith('videothumb://')) {
                        const thumbSrc = imgUrl.replace(/^videothumb:\/\//, '');
                        const wrapper = document.createElement('div');
                        wrapper.style.position = 'relative';
                        wrapper.style.display = 'inline-block';
                        wrapper.style.borderRadius = '8px';
                        wrapper.style.overflow = 'hidden';
                        if (imageFileIds && imageFileIds[index]) {
                            wrapper.setAttribute('data-file-id', imageFileIds[index]);
                        }
                        const img = document.createElement('img');
                        img.src = thumbSrc;
                        img.style.maxWidth = '200px';
                        img.style.maxHeight = '200px';
                        img.style.borderRadius = '8px';
                        img.style.objectFit = 'cover';
                        img.style.display = 'block';
                        const overlay = document.createElement('div');
                        overlay.style.position = 'absolute';
                        overlay.style.top = '50%';
                        overlay.style.left = '50%';
                        overlay.style.transform = 'translate(-50%, -50%)';
                        overlay.style.width = '40px';
                        overlay.style.height = '40px';
                        overlay.style.borderRadius = '50%';
                        overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
                        overlay.style.display = 'flex';
                        overlay.style.alignItems = 'center';
                        overlay.style.justifyContent = 'center';
                        overlay.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
                        wrapper.appendChild(img);
                        wrapper.appendChild(overlay);
                        imagesContainer.appendChild(wrapper);
                    } else if (imgUrl && imgUrl.startsWith('video://')) {
                        const displayName = imgUrl.replace(/^video:\/\//, '');
                        const fileDiv = document.createElement('div');
                        fileDiv.style.display = 'inline-flex';
                        fileDiv.style.alignItems = 'center';
                        fileDiv.style.gap = '6px';
                        fileDiv.style.padding = '6px 12px';
                        fileDiv.style.borderRadius = '8px';
                        fileDiv.style.fontSize = '12px';
                        fileDiv.style.backgroundColor = 'var(--theme-accent-soft, #e6f7ff)';
                        fileDiv.style.border = '1px solid #91d5ff';
                        fileDiv.style.color = 'var(--theme-accent-text, #1890ff)';
                        if (imageFileIds && imageFileIds[index]) {
                            fileDiv.setAttribute('data-file-id', imageFileIds[index]);
                        }
                        fileDiv.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1890ff" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg><span>${displayName}</span>`;
                        imagesContainer.appendChild(fileDiv);
                    } else if (imgUrl) {
                        const img = document.createElement('img');
                        img.src = imgUrl;
                        if (imageFileIds && imageFileIds[index]) {
                            img.setAttribute('data-file-id', imageFileIds[index]);
                        }
                        img.style.maxWidth = '200px';
                        img.style.maxHeight = '200px';
                        img.style.borderRadius = '8px';
                        img.style.objectFit = 'cover';
                        imagesContainer.appendChild(img);
                    }
                });
                
                contentDiv.appendChild(imagesContainer);
            }
            
            // 技能与正文处于同一行内排版，放在附件之后以便文字紧接技能。
            if (skillsDiv && skillsDiv.childElementCount > 0) contentDiv.appendChild(skillsDiv);

            // 添加文字内容
            if (content) {
                if (type === 'ai') {
                    renderContentWithCodeBlocks(contentDiv, content);
                } else {
                    const textDiv = document.createElement('div');
                    textDiv.style.whiteSpace = 'pre-wrap';
                    textDiv.style.wordWrap = 'break-word';
                    textDiv.textContent = content;
                    contentDiv.appendChild(textDiv);
                }
            }

            if (type === 'ai') {
                const staticHeader = document.createElement('div');
                staticHeader.className = 'turn-process-header codex-turn-header';
                staticHeader.setAttribute('role', 'button');
                staticHeader.setAttribute('tabindex', '0');
                staticHeader.setAttribute('aria-expanded', 'false');
                staticHeader.innerHTML = '<span class="turn-chevron">' + createWorkflowChevronIcon(16, 'down') + '</span>' +
                    '<span class="turn-title">用时 0秒</span><span class="turn-time"></span>';
                contentDiv.classList.add('process-collapsed', 'codex-inline-complete');
                contentDiv.insertBefore(staticHeader, contentDiv.firstChild);
                messageDiv.classList.add('codex-final-answer');
            }
            
            if (type === 'user') MoonYaAttachments.finishUser(messageDiv, contentDiv, userAttachments);
            messageDiv.appendChild(contentDiv);
            
            // 将消息添加到消息容器中
            destinationContainer.appendChild(messageDiv);
            
            // 滚动到底部
            teamScrollIfFollowing(destinationContainer);
            
            // 如果是AI消息，使用逐字输出（只对文字部分）
            if (type === 'ai' && content) {
                const textDiv = contentDiv.querySelector('div:last-child');
                if (textDiv) {
                    typeWriter(textDiv, content, 30, destinationContainer);
                }
            }
        }
        
        // 打字机效果函数
        function typeWriter(element, text, speed = 30, targetContainer = null) {
            const destinationContainer = targetContainer || messagesContainer;
            let i = 0;
            element.textContent = '';

            function type() {
                if (i < text.length) {
                    element.textContent += text.charAt(i);
                    i++;
                    // 滚动到底部
                    teamScrollIfFollowing(destinationContainer);
                    setTimeout(type, speed);
                } else {
                    if (isVoiceBroadcastEnabled || isVoiceChatActive()) {
                        window.speakText(text);
                    }
                }
            }

            type();
        }
        
        // 添加AI消息（带HTML内容，跳过打字机效果）
        function addAIMessageWithHTML(text, htmlContent, targetContainer = null) {
            const destinationContainer = targetContainer || messagesContainer;
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message ai';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content process-collapsed codex-inline-complete';
            contentDiv.innerHTML = '<div class="turn-process-header codex-turn-header" role="button" tabindex="0" aria-expanded="false">' +
                '<span class="turn-chevron">' + createWorkflowChevronIcon(16, 'down') + '</span>' +
                '<span class="turn-title">用时 0秒</span><span class="turn-time"></span></div>';
            messageDiv.classList.add('codex-final-answer');
            
            // 添加文字内容
            if (text) {
                const textDiv = document.createElement('div');
                textDiv.style.whiteSpace = 'pre-wrap';
                textDiv.style.wordWrap = 'break-word';
                textDiv.textContent = text;
                contentDiv.appendChild(textDiv);
            }
            
            // 添加HTML内容
            if (htmlContent) {
                const htmlDiv = document.createElement('div');
                htmlDiv.innerHTML = htmlContent;
                contentDiv.appendChild(htmlDiv);
            }
            
            messageDiv.appendChild(contentDiv);
            destinationContainer.appendChild(messageDiv);
            
            // 滚动到底部
            teamScrollIfFollowing(destinationContainer);
            
            // 保存对话历史
            saveCurrentChat();
            
            // 语音播报（只播报文本部分）。实时语音对话模式下强制播报。
            if ((isVoiceBroadcastEnabled || isVoiceChatActive()) && text) {
                window.speakText(text);
            }
        }
        
        // 添加加载指示器
        function addLoadingIndicator(targetContainer = null) {
            const destinationContainer = targetContainer || messagesContainer;
            const loadingDiv = document.createElement('div');
            const loadingId = 'loading-' + Date.now();
            loadingDiv.id = loadingId;
            loadingDiv.className = 'message ai';

            if (currentAgentName) {
                loadingDiv.dataset.agentName = currentAgentName;
                const senderLabel = document.createElement('div');
                senderLabel.className = 'message-sender';
                senderLabel.textContent = currentAgentName;
                loadingDiv.appendChild(senderLabel);
            }

            const loadingContent = document.createElement('div');
            loadingContent.className = 'message-content';
            
            const loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.id = 'loading-indicator-' + loadingId;
                loadingIndicator.innerHTML = '<span class="thinking-loading" style="display: inline-flex; margin-left: 8px; vertical-align: middle;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 64 64"><circle cx="44" cy="32" r="12" fill="#e0e0e0"><animate attributeName="cx" values="44;20;44" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" dur="1.2s" repeatCount="indefinite"/></circle><circle cx="20" cy="32" r="12" fill="#999999"><animate attributeName="cx" values="20;44;20" keyTimes="0;0.5;1" calcMode="spline" keySplines="0.4 0 0.2 1; 0.4 0 0.2 1" dur="1.2s" repeatCount="indefinite"/></circle></svg></span>';
            
            loadingContent.appendChild(loadingIndicator);
            
            // 思考折叠框由 ensureThinkingWrapper 在收到 thinking/content 事件时按需创建，
            // 避免加载指示器里预先创建空框导致重复或空内容。
            loadingDiv.appendChild(loadingContent);
            
            // 将加载指示器添加到消息容器中
            destinationContainer.appendChild(loadingDiv);
            
            // 滚动到底部
            teamScrollIfFollowing(destinationContainer);
            
            return loadingId;
        }
        
        // 快速添加聊天消息（addMessage 简化别名）
        function addChatMessage(role, text) {
            addMessage(role, text);
        }
        
        // 移除加载指示器
        function removeLoadingIndicator(loadingId) {
            const loadingDiv = document.getElementById(loadingId);
            if (loadingDiv) {
                // A loading placeholder can become the actual reply container.
                if (loadingDiv.matches('[data-timeline-loading-id], [data-process-turn], [data-turn-status]') ||
                    loadingDiv.querySelector('.ai-text-segment, .thinking-wrapper, .process-segment, .plaintext-card')) {
                    loadingDiv.querySelectorAll('.loading-indicator').forEach(node => node.remove());
                } else loadingDiv.remove();
            }
        }
        
        // 检测代码语言
        function detectCodeLanguage(code, filename) {
            // 语言映射表
            const langMap = {
                'python': 'Python', 'py': 'Python',
                'java': 'Java',
                'javascript': 'JavaScript', 'js': 'JavaScript',
                'typescript': 'TypeScript', 'ts': 'TypeScript',
                'html': 'HTML', 'htm': 'HTML',
                'css': 'CSS',
                'php': 'PHP',
                'cpp': 'C++', 'c++': 'C++', 'cc': 'C++', 'cxx': 'C++',
                'c': 'C',
                'csharp': 'C#', 'cs': 'C#',
                'go': 'Go', 'golang': 'Go',
                'rust': 'Rust', 'rs': 'Rust',
                'ruby': 'Ruby', 'rb': 'Ruby',
                'swift': 'Swift',
                'kotlin': 'Kotlin', 'kt': 'Kotlin', 'kts': 'Kotlin Script',
                'scala': 'Scala',
                'r': 'R',
                'matlab': 'MATLAB',
                'sql': 'SQL',
                'bash': 'Bash', 'sh': 'Bash', 'shell': 'Bash', 'zsh': 'Bash',
                'powershell': 'PowerShell', 'ps1': 'PowerShell',
                'yaml': 'YAML', 'yml': 'YAML',
                'json': 'JSON',
                'xml': 'XML',
                'dockerfile': 'Dockerfile',
                'vue': 'Vue',
                'react': 'React', 'jsx': 'React', 'tsx': 'TypeScript React',
                'angular': 'Angular',
                'sass': 'Sass', 'scss': 'SCSS',
                'less': 'Less',
                'lua': 'Lua',
                'perl': 'Perl', 'pl': 'Perl',
                'haskell': 'Haskell', 'hs': 'Haskell',
                'clojure': 'Clojure', 'clj': 'Clojure',
                'erlang': 'Erlang', 'erl': 'Erlang',
                'elixir': 'Elixir', 'ex': 'Elixir', 'exs': 'Elixir',
                'dart': 'Dart',
                'flutter': 'Flutter',
                'objective-c': 'Objective-C', 'objc': 'Objective-C',
                'assembly': 'Assembly', 'asm': 'Assembly',
                'verilog': 'Verilog', 'v': 'Verilog',
                'vhdl': 'VHDL', 'vhd': 'VHDL',
                'toml': 'TOML',
                'ini': 'INI', 'cfg': 'Config', 'conf': 'Config',
                'properties': 'Properties',
                'env': 'Environment',
                'gitignore': 'Gitignore',
                'markdown': 'Markdown', 'md': 'Markdown', 'mdx': 'MDX',
                'tex': 'LaTeX', 'latex': 'LaTeX',
                'bib': 'BibTeX',
                'csv': 'CSV', 'tsv': 'TSV',
                'vim': 'Vim',
                'makefile': 'Makefile', 'make': 'Makefile', 'mk': 'Makefile',
                'cmake': 'CMake',
                'gradle': 'Gradle',
                'proto': 'Protocol Buffers',
                'graphql': 'GraphQL', 'gql': 'GraphQL',
                'svelte': 'Svelte',
                'solidity': 'Solidity', 'sol': 'Solidity',
                'julia': 'Julia', 'jl': 'Julia',
                'fsharp': 'F#', 'fs': 'F#', 'fsx': 'F#',
                'ocaml': 'OCaml', 'ml': 'OCaml',
                'elm': 'Elm',
                'coffeescript': 'CoffeeScript', 'coffee': 'CoffeeScript',
                'nginx': 'Nginx',
                'apache': 'Apache'
            };
            
            const lowerFilename = filename.toLowerCase().trim();
            
            // 如果文件名是语言标识符，直接返回
            if (langMap[lowerFilename]) {
                return langMap[lowerFilename];
            }
            
            // 检测文件扩展名
            const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
            if (extMatch) {
                const ext = extMatch[1].toLowerCase();
                if (langMap[ext]) {
                    return langMap[ext];
                }
            }
            
            // 根据代码内容特征检测
            const codeLower = code.toLowerCase();
            
            // HTML特征检测（优先于其他检测）
            if (/^\s*<(!DOCTYPE|doctype)\s+html/i.test(code) || 
                /^\s*<html/i.test(code) ||
                /<(!DOCTYPE|doctype)\s+html/i.test(code) ||
                /<html[\s>]/i.test(code)) {
                return 'HTML';
            }
            
            // 命令行特征检测（排除明显的HTML代码）
            if (!/<[a-zA-Z][^>]*>/.test(code) && 
                /\b(netstat|ping|traceroute|nslookup|ipconfig|ifconfig|route|arp|hostname|whoami|ps|top|htop|kill|pkill|pgrep|sudo|su|passwd|chown|chmod|chgrp|ls|cd|pwd|mkdir|rm|cp|mv|cat|head|tail|grep|find|ssh|scp|curl|wget|git|docker|kubectl|npm|yarn|pip)\b/.test(codeLower)) {
                return 'Bash';
            }
            
            // Python特征
            if (/\b(def |class |import |from |print\(|lambda |yield |async def|await |with open|try:|except:|finally:|raise |assert |pass|self|cls|super\()\b/.test(codeLower)) {
                return 'Python';
            }
            
            // JavaScript/TypeScript特征
            if (/\b(const |let |var |function |=> |async |await |import |export |require\(|console\.log|document\.|window\.|localStorage|fetch\(|\.then\(|new Promise|setTimeout|addEventListener|querySelector|getElementById|appendChild|innerHTML|JSON\.)\b/.test(codeLower)) {
                if (/\b(interface |type |:\s*(string|number|boolean|any|unknown)|namespace |declare |abstract |implements |private |protected |readonly)\b/.test(codeLower)) {
                    return 'TypeScript';
                }
                return 'JavaScript';
            }
            
            // Java特征
            if (/\b(public |private |protected |static |final |abstract |class |interface |enum |extends |implements |import |package |void |int |long |double |float |boolean |char |byte |short |new |this|super|return |if|else|while|for|switch|case|try|catch|finally|throw|null|true|false)\b/.test(codeLower)) {
                return 'Java';
            }
            
            // C/C++特征
            if (/\b(#include|#define|int |char |float |double |void |struct |enum |typedef |const |static |if|else|while|for|return |goto |sizeof |malloc|free|printf|scanf|cout|cin|endl|namespace|class |template|typename|new |delete |std::)\b/.test(codeLower)) {
                if (/\b(class |namespace |template|typename|cout|cin|endl|std::|new |delete )\b/.test(codeLower)) {
                    return 'C++';
                }
                if (/\b(#include|printf|scanf|malloc|free|struct |typedef)\b/.test(codeLower)) {
                    return 'C';
                }
            }
            
            // C#特征
            if (/\b(using |namespace |class |struct |interface |enum |public |private |protected |static |readonly |const |virtual |abstract |override |async |await |var |string |int |double |float |bool |if|else|while|for|foreach|in |return |try|catch|finally|throw|null|true|false|this|base)\b/.test(codeLower)) {
                return 'C#';
            }
            
            // Go特征
            if (/\b(package |import |func |var |const |type |struct |interface |map |chan |go |defer |return |if|else|for |range |break|continue|make|new |append|len|cap|panic|recover|print|println|bool|string|int |error|nil|true|false)\b/.test(codeLower)) {
                return 'Go';
            }
            
            // Rust特征
            if (/\b(fn |let |mut |const |static |type |struct |enum |trait |impl |pub |use |mod |crate |self|super|as |if|else|match |while|loop|for |in |return |async |await |move |ref |box |unsafe |where |dyn |println!|vec!|format!|Option|Result|String|str|i32|i64|u32|u64|f32|f64|bool|char|Vec|Box|Some|None|Ok|Err)\b/.test(codeLower)) {
                return 'Rust';
            }
            
            // PHP特征
            if (/\b(<\?php|<\?=|echo |print |var_dump|print_r|function |class |interface |trait |namespace |use |public |private |protected |static |final |abstract |const |define |global |array |isset|unset|empty |count|strlen|strpos|substr|str_replace|preg_match|explode|implode|trim|date|time|fopen|file_get_contents|json_encode|json_decode|mysql|mysqli|pdo|curl|header|session_start|include |require |die|exit|return |if|else|elseif|while|for|foreach|switch|case|try|catch|finally|throw|new |extends|implements|instanceof|null|true|false)\b/.test(codeLower)) {
                return 'PHP';
            }
            
            // Ruby特征
            if (/\b(def |class |module |require |include |extend |attr_reader|attr_writer|attr_accessor|initialize|self|super|yield|lambda|proc|->|=>|if|unless|else|elsif|case|when|while|until|for |in |do |end|begin|rescue|ensure|retry|break|next|return |raise|throw|catch|and|or|not|nil|true|false|puts|print|p |gets|chomp|split|join|map|select|reject|reduce|inject|each|times|open|file|dir|time|date)\b/.test(codeLower)) {
                return 'Ruby';
            }
            
            // Swift特征
            if (/\b(import |class |struct |enum |protocol |extension |func |var |let |init|deinit|subscript|operator|typealias|public |internal |private |fileprivate |open |final |static |lazy |dynamic |optional |required |convenience |override |throws|rethrows|async |await |if|else|switch|case|default|where|guard|while|repeat|for |in |break|continue|fallthrough|return |throw|defer|do|catch|try|as |is |self|Self|super|nil|true|false|print|debugPrint|dump|assert|Int|UInt|Float|Double|Bool|String|Character|Array|Dictionary|Set|Optional|Result|Never|Void|Any|AnyObject)\b/.test(codeLower)) {
                return 'Swift';
            }
            
            // Kotlin特征
            if (/\b(package |import |fun |val |var |class |interface |object |data |sealed |abstract |open |final |override |lateinit |const |inline |suspend |operator |infix |companion |init|constructor|by |delegate|if|else|when|while|for |do|try|catch|finally|throw|return |break|continue|this|super|is |in |as |as\?|true|false|null|typealias|Boolean|Byte|Short|Int|Long|Float|Double|Char|String|Array|List|Map|Set|Any|Nothing|Unit)\b/.test(codeLower)) {
                return 'Kotlin';
            }
            
            // 通用HTML标签特征（如果前面没有匹配到DOCTYPE html）
            if (/<(head|body|div|span|p|a|img|br|hr|table|tr|td|th|ul|ol|li|h[1-6]|form|input|button|select|option|textarea|label|iframe|script|style|link|meta|title|base|header|footer|nav|section|article|aside|main|figure|figcaption|details|summary|dialog|template|slot|canvas|svg|video|audio|source|track|embed|object|param|map|area)/i.test(code)) {
                return 'HTML';
            }
            
            // CSS特征
            if (/[.#@]?[a-zA-Z_-][a-zA-Z0-9_-]*\s*\{[^}]*\}/.test(code) || /@media|color:|background:|font:|margin:|padding:|border:|display:|position:|width:|height:|float:|clear:|overflow:|z-index:|opacity:|transform:|transition:|animation:|box-shadow:|text-shadow:|border-radius:|flex:|grid:|align-items:|justify-content:/.test(codeLower)) {
                return 'CSS';
            }
            
            // SQL特征
            if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|DATABASE|INDEX|VIEW|TRIGGER|PROCEDURE|FUNCTION|GRANT|REVOKE|COMMIT|ROLLBACK|TRANSACTION|FROM|WHERE|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|USING|AS|DISTINCT|UNION|CASE|WHEN|THEN|ELSE|END|IF|WHILE|FOR|CURSOR|FETCH|DECLARE|SET|CALL|EXEC|EXECUTE|RETURN|GO|USE|WITH)\b/i.test(code)) {
                return 'SQL';
            }
            
            // 如果包含shebang，检测解释器
            const shebangMatch = code.match(/^#!\s*\/usr\/bin\/env\s+(\w+)|^#!\s*\/bin\/\w+|^#!\s*\/usr\/bin\/\w+/);
            if (shebangMatch) {
                const interpreter = shebangMatch[1] || shebangMatch[0].split('/').pop();
                if (langMap[interpreter]) {
                    return langMap[interpreter];
                }
            }
            
            // 检测是否为纯中文文本
            // 如果内容主要是中文字符（超过30%），则认为是文本
            const chineseChars = code.match(/[\u4e00-\u9fa5]/g);
            const totalChars = code.replace(/\s/g, '').length;
            if (chineseChars && totalChars > 0) {
                const chineseRatio = chineseChars.length / totalChars;
                if (chineseRatio > 0.3) {
                    return 'Text';
                }
            }
            
            // 默认返回"plaintext"
            return 'plaintext';
        }
        
        // 全局：展开/收起代码块（一字不差复刻 样式.html 的 togglePlain）
        function togglePlain(id) {
            const card = document.getElementById(id);
            card.classList.toggle('collapsed');
        }

        // 全局：复制代码块内容（按代码块 ID）
        function copyCodeBlockById(blockId, btn) {
            const content = document.getElementById('plain-content-' + blockId);
            const codeToCopy = content ? content.textContent : '';
            const checkSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            const copySvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            const doCopy = function() {
                if (btn) {
                    btn.innerHTML = checkSvg;
                    setTimeout(function() { btn.innerHTML = copySvg; }, 2000);
                }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(codeToCopy).then(doCopy).catch(function() {
                    fallbackCopy(codeToCopy, btn, copySvg, checkSvg);
                });
            } else {
                fallbackCopy(codeToCopy, btn, copySvg, checkSvg);
            }
        }

        // 创建代码块（一字不差复刻 样式.html 的 plaintext-card UI，仅增加 blockId 与 copy 调用以支持多块/复制）
        function createCodeBlock(code, filename, blockId, isStreaming = false) {
            const wrapper = document.createElement('div');
            wrapper.className = 'plaintext-card collapsed';
            wrapper.id = 'plain-' + blockId;

            let codeStr = String(code || '');
            codeStr = decodeHtmlEntities(codeStr);

            const displayName = detectCodeLanguage(codeStr, filename);
            const hljsLang = mapLanguageToHljs(displayName);

            const headerHtml = '<div class="plain-header" onclick="togglePlain(\'plain-' + blockId + '\')">' +
                '<span class="plain-title">' + escapeHtml(displayName) + '</span>' +
                '<svg class="arrow-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<polyline points="6 9 12 15 18 9"></polyline>' +
                '</svg>' +
                '<div class="header-actions">' +
                    '<svg class="action-icon" onclick="copyCodeBlockById(\'' + blockId + '\', this); event.stopPropagation();" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                        '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
                        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
                    '</svg>' +
                '</div>' +
            '</div>';

            const pre = document.createElement('pre');
            const codeEl = document.createElement('code');
            if (hljsLang) {
                codeEl.classList.add('language-' + hljsLang);
            }
            codeEl.innerHTML = highlightCode(codeStr, hljsLang);
            pre.appendChild(codeEl);

            const content = document.createElement('div');
            content.className = 'plain-content';
            content.id = 'plain-content-' + blockId;
            content.appendChild(pre);

            wrapper.innerHTML = headerHtml;
            wrapper.appendChild(content);

            return wrapper;
        }
        
        function highlightCode(code, lang) {
            try {
                // 确保 code 是字符串
                const codeStr = String(code || '');
                // 使用 plaintext 作为默认语言，避免 highlightAuto 返回错误的语言类名
                const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
                return hljs.highlight(codeStr, { language: language }).value;
            } catch(e) {
                // 如果高亮失败，返回转义后的纯文本
                const div = document.createElement('div');
                div.textContent = code || '';
                return div.innerHTML;
            }
        }
        
        function mapLanguageToHljs(displayName) {
            const map = {
                'Python': 'python', 'Java': 'java', 'JavaScript': 'javascript',
                'TypeScript': 'typescript', 'HTML': 'html', 'CSS': 'css',
                'PHP': 'php', 'C++': 'cpp', 'C': 'c', 'C#': 'csharp',
                'Go': 'go', 'Rust': 'rust', 'Ruby': 'ruby', 'Swift': 'swift',
                'Kotlin': 'kotlin', 'Scala': 'scala', 'R': 'r',
                'MATLAB': 'matlab', 'SQL': 'sql', 'Bash': 'bash',
                'PowerShell': 'powershell', 'YAML': 'yaml', 'JSON': 'json',
                'XML': 'xml', 'Dockerfile': 'dockerfile', 'Vue': 'xml',
                'React': 'javascript', 'TypeScript React': 'typescript',
                'Angular': 'typescript', 'Sass': 'scss', 'SCSS': 'scss',
                'Less': 'less', 'Lua': 'lua', 'Perl': 'perl',
                'Haskell': 'haskell', 'Clojure': 'clojure', 'Erlang': 'erlang',
                'Elixir': 'elixir', 'Dart': 'dart', 'Objective-C': 'objectivec',
                'Assembly': 'x86asm', 'Verilog': 'verilog', 'VHDL': 'vhdl',
                'TOML': 'ini', 'INI': 'ini', 'Config': 'ini',
                'Properties': 'properties', 'Environment': 'bash',
                'Gitignore': 'bash', 'Markdown': 'markdown', 'LaTeX': 'latex',
                'BibTeX': 'bibtex', 'CSV': 'plaintext', 'TSV': 'plaintext',
                'Vim': 'vim', 'Makefile': 'makefile', 'CMake': 'cmake',
                'Gradle': 'groovy', 'Protocol Buffers': 'protobuf',
                'GraphQL': 'graphql', 'Svelte': 'xml', 'Solidity': 'solidity',
                'Julia': 'julia', 'F#': 'fsharp', 'OCaml': 'ocaml',
                'Elm': 'elm', 'CoffeeScript': 'coffeescript', 'Nginx': 'nginx',
                'Apache': 'apache', 'Kotlin Script': 'kotlin',
                'MDX': 'markdown', '代码': 'plaintext', 'Text': 'plaintext'
            };
            return map[displayName] || 'plaintext';
        }
        
        function isHtmlCode(code, filename, displayName) {
            const lowerFilename = (filename || '').toLowerCase();
            if (lowerFilename.includes('html') || lowerFilename.includes('htm')) return true;
            if (displayName && displayName.toLowerCase() === 'html') return true;
            const trimmed = code.trim().substring(0, 200).toLowerCase();
            if (trimmed.includes('<!doctype html') || trimmed.includes('<html')) return true;
            if ((trimmed.includes('<head') || trimmed.includes('<body') || trimmed.includes('<div')) && trimmed.includes('</')) return true;
            return false;
        }
        
        function previewHtmlCode(htmlCode) {
            // Harness 化重构（4.6）：webpage_api/webpage_preview 已删除，
            // HTML 预览改为纯客户端 Blob 实现，不再上传后端。
            const blob = new Blob([htmlCode], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
        }

        function previewHtmlCodeLegacy(htmlCode) {
            fetch('webpage_api.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html_code: htmlCode })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    const previewUrl = 'webpage_preview.php?token=' + data.data.preview_token;
                    window.open(previewUrl, '_blank');
                } else {
                    const blob = new Blob([htmlCode], { type: 'text/html;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    window.open(url, '_blank');
                }
            })
            .catch(() => {
                const blob = new Blob([htmlCode], { type: 'text/html;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank');
            });
        }
        
        // 解码HTML实体
        function decodeHtmlEntities(text) {
            const textarea = document.createElement('textarea');
            textarea.innerHTML = text;
            return textarea.value;
        }
        
        function renderContentWithCodeBlocks(container, content) {
            container.innerHTML = '';
            container.style.whiteSpace = 'normal';
            
            const codeBlockRegex = /```([\s\S]*?)```/g;
            let lastIndex = 0;
            let match;
            let blockIndex = 0;
            
            while ((match = codeBlockRegex.exec(content)) !== null) {
                const beforeCode = content.substring(lastIndex, match.index);
                if (beforeCode.trim()) {
                    const textDiv = document.createElement('div');
                    textDiv.style.marginBottom = '8px';
                    textDiv.innerHTML = parseMarkdown(beforeCode);
                    container.appendChild(textDiv);
                }
                
                let codeContent = match[1];
                let filename = '代码';
                
                codeContent = decodeHtmlEntities(codeContent);
                
                const firstLineEnd = codeContent.indexOf('\n');
                if (firstLineEnd !== -1) {
                    const firstLine = codeContent.substring(0, firstLineEnd).trim();
                    if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                        if (firstLine.includes('.')) {
                            filename = firstLine;
                            codeContent = codeContent.substring(firstLineEnd + 1);
                        } else {
                            codeContent = codeContent.substring(firstLineEnd + 1);
                        }
                    }
                }
                
                const codeBlock = createCodeBlock(codeContent.trim(), filename, blockIndex);
                container.appendChild(codeBlock);
                blockIndex++;
                
                lastIndex = match.index + match[0].length;
            }
            
            const remainingText = content.substring(lastIndex);
            if (remainingText.trim()) {
                const unclosedCodeIndex = remainingText.indexOf('```');
                if (unclosedCodeIndex !== -1) {
                    const textBefore = remainingText.substring(0, unclosedCodeIndex);
                    if (textBefore.trim()) {
                        const textDiv = document.createElement('div');
                        textDiv.style.marginBottom = '8px';
                        textDiv.innerHTML = parseMarkdown(textBefore);
                        container.appendChild(textDiv);
                    }
                    
                    let codeContent = remainingText.substring(unclosedCodeIndex + 3);
                    let filename = '代码';
                    
                    codeContent = decodeHtmlEntities(codeContent);
                    
                    const firstLineEnd = codeContent.indexOf('\n');
                    if (firstLineEnd !== -1) {
                        const firstLine = codeContent.substring(0, firstLineEnd).trim();
                        if (firstLine && !firstLine.includes(' ') && firstLine.length <= 30) {
                            if (firstLine.includes('.')) {
                                filename = firstLine;
                                codeContent = codeContent.substring(firstLineEnd + 1);
                            } else {
                                codeContent = codeContent.substring(firstLineEnd + 1);
                            }
                        }
                    }
                    
                    const codeBlock = createCodeBlock(codeContent.trim(), filename, blockIndex);
                    container.appendChild(codeBlock);
                } else {
                    const textDiv = document.createElement('div');
                    textDiv.innerHTML = parseMarkdown(remainingText);
                    container.appendChild(textDiv);
                }
            }
        }
        
        function parseMarkdown(text) {
            var lines = text.split('\n');
            var html = '';
            var inList = false;
            var listType = '';
            var inBlockquote = false;
            
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];
                var trimmedLine = line.trim();
                
                if (trimmedLine === '') {
                    if (inList) {
                        html += listType === 'ul' ? '</ul>' : '</ol>';
                        inList = false;
                    }
                    if (inBlockquote) {
                        html += '</blockquote>';
                        inBlockquote = false;
                    }
                    continue;
                }
                
                if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmedLine)) {
                    if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                    if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                    html += '<hr>';
                    continue;
                }
                
                // Table detection: look ahead for consecutive pipe-lines
                if (trimmedLine.startsWith('|') && trimmedLine.endsWith('|')) {
                    var tableRows = [];
                    var j = i;
                    while (j < lines.length && lines[j].trim().startsWith('|') && lines[j].trim().endsWith('|')) {
                        tableRows.push(lines[j].trim());
                        j++;
                    }
                    if (tableRows.length >= 3) {
                        var headerRow = tableRows[0];
                        var sepRow = tableRows[1];
                        var headerCells = headerRow.split('|').filter(function(s) { return s.trim() !== ''; });
                        var sepCells = sepRow.split('|').filter(function(s) { return s.trim() !== ''; });
                        var isSepRow = sepCells.length === headerCells.length && sepCells.every(function(cell) {
                            return cell.trim().match(/^:?-+:?$/);
                        });
                        if (isSepRow) {
                            var alignments = sepCells.map(function(cell) {
                                var c = cell.trim();
                                if (c.startsWith(':') && c.endsWith(':')) return 'center';
                                if (c.endsWith(':')) return 'right';
                                return 'left';
                            });
                            if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                            if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                            html += '<table><thead><tr>';
                            for (var ci = 0; ci < headerCells.length; ci++) {
                                var thStyle = ' style="text-align:' + alignments[ci] + '"';
                                html += '<th' + thStyle + '>' + formatInlineMarkdown(headerCells[ci].trim()) + '</th>';
                            }
                            html += '</tr></thead><tbody>';
                            for (var ri = 2; ri < tableRows.length; ri++) {
                                var dataCells = tableRows[ri].split('|').filter(function(s) { return s.trim() !== ''; });
                                html += '<tr>';
                                for (var di = 0; di < dataCells.length; di++) {
                                    var tdStyle = '';
                                    if (di < alignments.length) {
                                        tdStyle = ' style="text-align:' + alignments[di] + '"';
                                    }
                                    html += '<td' + tdStyle + '>' + formatInlineMarkdown(dataCells[di].trim()) + '</td>';
                                }
                                html += '</tr>';
                            }
                            html += '</tbody></table>';
                            i = j - 1;
                            continue;
                        }
                    }
                }
                
                var headingMatch = trimmedLine.match(/^(#{1,4})\s+(.+)$/);
                if (headingMatch) {
                    if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                    if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                    var level = headingMatch[1].length;
                    var headingText = formatInlineMarkdown(headingMatch[2]);
                    html += '<h' + level + '>' + headingText + '</h' + level + '>';
                    continue;
                }
                
                if (trimmedLine.startsWith('> ')) {
                    if (inList) { html += listType === 'ul' ? '</ul>' : '</ol>'; inList = false; }
                    var quoteText = formatInlineMarkdown(trimmedLine.substring(2));
                    if (!inBlockquote) {
                        html += '<blockquote>';
                        inBlockquote = true;
                    }
                    html += '<p>' + quoteText + '</p>';
                    continue;
                } else if (inBlockquote) {
                    html += '</blockquote>';
                    inBlockquote = false;
                }
                
                var olMatch = trimmedLine.match(/^(\d+)\.\s+(.+)$/);
                var ulMatch = trimmedLine.match(/^[-*]\s+(.+)$/);
                
                if (olMatch) {
                    if (inList && listType !== 'ol') {
                        html += listType === 'ul' ? '</ul>' : '</ol>';
                        inList = false;
                    }
                    if (!inList) {
                        html += '<ol>';
                        inList = true;
                        listType = 'ol';
                    }
                    html += '<li>' + formatInlineMarkdown(olMatch[2]) + '</li>';
                    continue;
                }
                
                if (ulMatch) {
                    if (inList && listType !== 'ul') {
                        html += listType === 'ul' ? '</ul>' : '</ol>';
                        inList = false;
                    }
                    if (!inList) {
                        html += '<ul>';
                        inList = true;
                        listType = 'ul';
                    }
                    html += '<li>' + formatInlineMarkdown(ulMatch[1]) + '</li>';
                    continue;
                }
                
                if (inList) {
                    html += listType === 'ul' ? '</ul>' : '</ol>';
                    inList = false;
                }
                
                html += '<p>' + formatInlineMarkdown(trimmedLine) + '</p>';
            }
            
            if (inList) {
                html += listType === 'ul' ? '</ul>' : '</ol>';
            }
            if (inBlockquote) {
                html += '</blockquote>';
            }
            
            return html;
        }
        
        function escapeHtml(text) {
            if (text === null || text === undefined) return '';
            if (typeof text !== 'string') text = String(text);
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        
        function formatInlineMarkdown(text) {
            text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
            text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
            text = text.replace(/`([^`]+)`/g, '<code style="background: var(--theme-surface, #f5f5f5);padding:2px 6px;border-radius:4px;font-size:13px;color: var(--theme-danger, #d14);">$1</code>');
            text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: var(--theme-accent-text, #1890ff);text-decoration:none;">$1</a>');
            return text;
        }
        
        // 复制代码块内容（执行结果区域使用）
        function copyCodeBlock(btn) {
            var pre = btn.parentElement.querySelector('pre');
            var code = pre ? pre.textContent : '';
            var checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
            var copySvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
            var doCopy = function() {
                btn.innerHTML = checkSvg;
                setTimeout(function() { btn.innerHTML = copySvg; }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).then(doCopy).catch(function() {
                    fallbackCopy(code, btn, copySvg, checkSvg);
                });
            } else {
                fallbackCopy(code, btn, copySvg, checkSvg);
            }
        }

        function fallbackCopy(code, btn, copySvg, checkSvg) {
            var textarea = document.createElement('textarea');
            textarea.value = code;
            textarea.style.position = 'fixed';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                btn.innerHTML = checkSvg;
                setTimeout(function() { btn.innerHTML = copySvg; }, 1500);
            } catch (e) {
                // 复制失败，静默处理
            }
            document.body.removeChild(textarea);
        }

        // 切换执行卡片的展开/收起
        function toggleExecutionBlock(header) {
            var block = header && header.closest ? header.closest('.execution-block') : null;
            if (!block) return;
            block.classList.toggle('collapsed');
            // 确保 command-inline 内容与代码块同步
            var codeEl = block.querySelector('.code-block-wrapper pre code');
            var inlineEl = block.querySelector('.command-inline');
            if (codeEl && inlineEl) {
                inlineEl.textContent = codeEl.textContent || '';
            }
        }

        // 重新执行当前命令块
        function reExecuteExecBlock(btn) {
            var block = btn && btn.closest ? btn.closest('.execution-block') : null;
            var codeEl = block ? block.querySelector('pre code') : null;
            var code = codeEl ? codeEl.textContent : '';
            var msgInput = document.getElementById('messageInput');
            if (msgInput && code) {
                msgInput.value = '请重新执行:\n' + code;
                msgInput.focus();
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ===== 自定义右键刷新菜单 =====
        (function setupContextMenu() {
            const ctxMenu = document.getElementById('myContextMenu');
            if (!ctxMenu) return;

            // 阻止默认右键菜单，显示自定义刷新菜单
            // 但在可选中/可复制的区域（对话内容、输入框、代码块）保留浏览器原生菜单
            document.addEventListener('contextmenu', function(e) {
                if (e.target.closest('.message-content, .wp-modal, input, textarea, pre, code, .execution-output, .thinking-text, .search-result-text')) {
                    return;
                }
                e.preventDefault();
                showCtxMenu(e.clientX, e.clientY);
            });

            // 显示菜单并做边界处理
            function showCtxMenu(x, y) {
                ctxMenu.classList.remove('show');
                // 先显示以测量尺寸
                ctxMenu.style.left = '0px';
                ctxMenu.style.top = '0px';
                ctxMenu.classList.add('show');
                const rect = ctxMenu.getBoundingClientRect();
                const w = rect.width;
                const h = rect.height;
                let left = x;
                let top = y;
                if (left + w > window.innerWidth) left = window.innerWidth - w - 6;
                if (top + h > window.innerHeight) top = window.innerHeight - h - 6;
                if (left < 6) left = 6;
                if (top < 6) top = 6;
                ctxMenu.style.left = left + 'px';
                ctxMenu.style.top = top + 'px';
            }

            // 点击菜单 - 刷新页面
            ctxMenu.addEventListener('click', function() {
                ctxMenu.classList.remove('show');
                if (typeof showToast === 'function') {
                    showToast('刷新成功');
                    // Toast 显示后立即刷新，用户能在页面重新加载前看到提示
                    setTimeout(function() {
                        location.reload();
                    }, 600);
                } else {
                    location.reload();
                }
            });

            // 点击其他区域隐藏菜单
            document.addEventListener('click', function(e) {
                if (!ctxMenu.contains(e.target)) {
                    ctxMenu.classList.remove('show');
                }
            });

            // 滚动或按 Esc 隐藏菜单
            document.addEventListener('scroll', function() {
                ctxMenu.classList.remove('show');
            }, true);
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') ctxMenu.classList.remove('show');
            });
        })();

        // ========== v4.12: 操作详情面板（右侧） ==========
        // 工具执行详情（操作/路径/结果/详情）从对话区域迁移到右侧独立面板
        function escapeDetailText(s) {
            if (s === null || s === undefined) return '';
            return String(s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }
        function formatDetailTime(ts) {
            try {
                const d = new Date(ts || Date.now());
                const pad = function(n) { return n < 10 ? '0' + n : '' + n; };
                return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            } catch (e) {
                return '';
            }
        }

        class CodexTurnTrace {
            constructor(key, startedAt) {
                this.version = 2;
                this.key = String(key || '');
                this.trace = [];
                this.finalContent = '';
                this.startedAt = Number(startedAt) || Date.now();
                this.completedAt = null;
                this.elapsedMs = 0;
                this.status = 'running';
            }
        }

        // ========== Multi-agent v1: structured team state and native MCP bridge ==========
        const teamUiState = {
            agents: new Map(),
            artifacts: new Map(),
            eventSeq: new Map(),
            turns: new Map(),
            tools: new Map(),
            approvals: new Map(),
            logNodes: new Map(),
            presentationRecords: new Map(),
            activePresentation: new Map(),
            runStatus: new Map(),
            synthesisRuns: new Set(),
            stoppedRuns: new Set(),
            projectGroups: new Map(),
            projectActors: new Map(),
            projectTaskActors: new Map(),
            activeRunId: null,
            approvalMode: 'confirm_writes',
            userId: null,
            bootstrapped: false,
            historyConversationId: null
        };
        const teamFollowStates = new WeakMap();

        function teamNearBottom(container, threshold) {
            if (!container) return true;
            return container.scrollHeight - container.scrollTop - container.clientHeight <= (threshold || 48);
        }

        function teamFollowController(container, label) {
            if (!container) return null;
            let state = teamFollowStates.get(container);
            if (state) return state;
            state = { following: teamNearBottom(container), scheduled: false, button: null };
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'team-new-content-button';
            const mainConversation = container.classList.contains('messages-container');
            if (mainConversation) {
                button.classList.add('conversation-follow-button');
                button.setAttribute('aria-label', '回到底部');
                button.innerHTML = '<span class="follow-dots" aria-hidden="true">' + window.MoonYaIcons.icon('more') + '</span>'
                    + '<span class="follow-arrow" aria-hidden="true">' + window.MoonYaIcons.icon('arrow-down') + '</span>';
                button.querySelectorAll('.follow-dots circle').forEach(dot => dot.setAttribute('r', '2'));
            } else button.textContent = label || '有新内容 · 回到底部';
            button.hidden = true;
            button.addEventListener('click', function() {
                state.following = true;
                button.hidden = true;
                container.scrollTop = container.scrollHeight;
            });
            const parent = mainConversation ? document.querySelector('.input-container-wrapper') : container.parentElement;
            if (parent) {
                if (!mainConversation) parent.classList.add('team-follow-host');
                parent.appendChild(button);
                state.button = button;
            }
            state.sync = function() {
                if (!mainConversation) return;
                const active = container.dataset.runtimeActive === '1' && !container.hidden;
                const runtime = conversationRuntimeContexts.get(container.dataset.conversationRuntime);
                button.hidden = !active || teamNearBottom(container);
                button.classList.toggle('is-streaming', active && !!runtime?.running);
            };
            if (mainConversation) {
                new MutationObserver(state.sync).observe(container, { attributes: true, attributeFilter: ['data-runtime-active', 'hidden'] });
                new ResizeObserver(state.sync).observe(container);
            }
            container.addEventListener('wheel', function(event) {
                if (event.deltaY < 0) state.following = false;
            }, { passive: true });
            container.addEventListener('touchstart', function() {
                state.touchTop = container.scrollTop;
            }, { passive: true });
            container.addEventListener('touchmove', function() {
                if (typeof state.touchTop === 'number' && container.scrollTop < state.touchTop) {
                    state.following = false;
                }
                state.touchTop = container.scrollTop;
            }, { passive: true });
            container.addEventListener('scroll', function() {
                if (teamNearBottom(container)) {
                    state.following = true;
                    if (state.button) state.button.hidden = true;
                } else if (!state.scheduled) {
                    state.following = false;
                }
                state.sync();
            }, { passive: true });
            teamFollowStates.set(container, state);
            state.sync();
            return state;
        }

        function syncConversationFollow(runtime) {
            if (runtime?.container) teamFollowController(runtime.container)?.sync();
            window.MoonYaChanges?.sync(runtime);
        }

        function teamScrollIfFollowing(container) {
            const state = teamFollowController(container);
            if (!state) return;
            if (!state.following) {
                if (container.classList.contains('messages-container')) state.sync();
                else if (state.button) state.button.hidden = false;
                return;
            }
            if (state.scheduled) return;
            state.scheduled = true;
            requestAnimationFrame(function() {
                state.scheduled = false;
                if (state.following) container.scrollTop = container.scrollHeight;
                state.sync();
            });
        }

        function teamProjectContext(event) {
            const payload = event && event.payload || {};
            const metadata = payload.metadata || {};
            const knownActor = teamUiState.projectTaskActors.get(String(event && event.task_id || ''));
            const known = knownActor && knownActor.context || {};
            return {
                groupId: String(payload.project_group_id || metadata.project_group_id || known.groupId || ''),
                actorId: String(payload.actor_id || metadata.actor_id || known.actorId || ''),
                roleKey: String(payload.role_key || metadata.role_key || known.roleKey || ''),
                roleLabel: String(payload.role_label || metadata.role_label || known.roleLabel || ''),
                workstream: String(payload.workstream || metadata.workstream || known.workstream || ''),
                ownedPaths: payload.owned_paths || metadata.owned_paths || known.ownedPaths || [],
                dependsOn: payload.depends_on || metadata.depends_on || known.dependsOn || [],
                phase: String(payload.project_phase || metadata.project_phase || payload.stage || known.phase || '')
            };
        }

        function ensureTeamProjectGroup(event) {
            const context = teamProjectContext(event);
            if (!context.groupId) return null;
            let group = teamUiState.projectGroups.get(context.groupId);
            if (group) return group;
            const content = document.getElementById('detailPanelContent');
            if (!content) return null;
            const empty = document.getElementById('detailPanelEmpty');
            if (empty) empty.remove();
            const board = document.createElement('section');
            board.className = 'team-project-board';
            board.dataset.projectGroupId = context.groupId;
            const head = document.createElement('button');
            head.type = 'button';
            head.className = 'team-project-board-head';
            const title = document.createElement('strong');
            title.textContent = '代码项目组';
            const status = document.createElement('span');
            status.className = 'team-project-board-status';
            status.textContent = '建立架构';
            head.append(title, status);
            const tabs = document.createElement('div');
            tabs.className = 'team-project-tabs';
            const lanes = document.createElement('div');
            lanes.className = 'team-project-lanes';
            head.addEventListener('click', function() {
                board.classList.toggle('collapsed');
            });
            board.append(head, tabs, lanes);
            content.insertBefore(board, content.firstChild);
            group = {
                id: context.groupId,
                board: board,
                lanes: lanes,
                tabs: tabs,
                status: status,
                actors: new Map(),
                selectedActor: ''
            };
            teamUiState.projectGroups.set(context.groupId, group);
            return group;
        }

        function ensureTeamProjectActor(event, actorData) {
            const context = Object.assign(teamProjectContext(event), actorData || {});
            if (!context.groupId || !context.actorId) return null;
            const group = ensureTeamProjectGroup(Object.assign({}, event, {
                payload: Object.assign({}, event.payload || {}, { project_group_id: context.groupId })
            }));
            if (!group) return null;
            let actor = group.actors.get(context.actorId);
            if (actor) {
                if (context.taskId && actor.taskId !== String(context.taskId)) {
                    actor.taskId = String(context.taskId);
                    teamUiState.projectTaskActors.set(actor.taskId, actor);
                }
                if (context.workstream) actor.workstream.textContent = context.workstream;
                const nextPaths = Array.isArray(context.ownedPaths) ? context.ownedPaths : [];
                const nextDeps = Array.isArray(context.dependsOn) ? context.dependsOn : [];
                if (nextPaths.length || nextDeps.length) {
                    actor.ownership.textContent = (nextPaths.length ? '负责：' + nextPaths.join('、') : '负责：待合同确认') +
                        (nextDeps.length ? '\n依赖：' + nextDeps.join('、') : '');
                }
                return actor;
            }
            const lane = document.createElement('article');
            lane.className = 'team-project-lane';
            lane.dataset.actorId = context.actorId;
            if (context.roleKey === 'project_lead') lane.classList.add('lead');
            const header = document.createElement('header');
            header.className = 'team-project-lane-head';
            const role = document.createElement('strong');
            role.textContent = context.roleLabel || (context.roleKey === 'project_lead' ? '项目负责人' : '项目成员');
            const status = document.createElement('span');
            status.className = 'team-project-lane-status running';
            status.textContent = '等待启动';
            const workstream = document.createElement('div');
            workstream.className = 'team-project-workstream';
            workstream.textContent = context.workstream || '项目工作流';
            const ownership = document.createElement('div');
            ownership.className = 'team-project-ownership';
            const paths = Array.isArray(context.ownedPaths) ? context.ownedPaths : [];
            const deps = Array.isArray(context.dependsOn) ? context.dependsOn : [];
            ownership.textContent = (paths.length ? '负责：' + paths.join('、') : '负责：待合同确认') +
                (deps.length ? '\n依赖：' + deps.join('、') : '');
            header.append(role, status, workstream, ownership);
            const log = document.createElement('div');
            log.className = 'team-project-lane-log';
            lane.append(header, log);
            group.lanes.appendChild(lane);
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'team-project-tab';
            tab.textContent = role.textContent + ' · ' + (context.workstream || '工作流');
            tab.addEventListener('click', function(eventClick) {
                eventClick.stopPropagation();
                group.selectedActor = context.actorId;
                group.actors.forEach(function(other) {
                    const selected = other.id === context.actorId;
                    other.lane.classList.toggle('selected', selected);
                    other.tab.classList.toggle('selected', selected);
                });
            });
            group.tabs.appendChild(tab);
            actor = {
                id: context.actorId,
                taskId: String(context.taskId || event.task_id || ''),
                lane: lane,
                log: log,
                tab: tab,
                status: status,
                workstream: workstream,
                ownership: ownership,
                context: context
            };
            group.actors.set(context.actorId, actor);
            teamUiState.projectActors.set(context.groupId + ':' + context.actorId, actor);
            if (actor.taskId) teamUiState.projectTaskActors.set(actor.taskId, actor);
            if (!group.selectedActor) tab.click();
            teamFollowController(log, '此工作流有新内容 · 回到底部');
            return actor;
        }

        function updateTeamProjectEvent(event) {
            const payload = event.payload || {};
            const context = teamProjectContext(event);
            if (!context.groupId) return;
            const group = ensureTeamProjectGroup(event);
            if (event.event === 'project.stage.changed' && Array.isArray(payload.roster)) {
                payload.roster.forEach(function(row) {
                    ensureTeamProjectActor(event, {
                        groupId: context.groupId,
                        actorId: String(row.actor_id || ''),
                        taskId: String(row.task_id || ''),
                        roleKey: row.role_label === '项目负责人' ? 'project_lead' : 'project_member',
                        roleLabel: row.role_label || '',
                        workstream: row.workstream || '',
                        ownedPaths: row.owned_paths || [],
                        dependsOn: row.depends_on || []
                    });
                });
            }
            const actor = context.actorId ? ensureTeamProjectActor(event) : null;
            const stageLabels = {
                contract: '建立架构与契约', implementation: '成员并行实现',
                rework: '定向返工', acceptance: '负责人集成验收',
                completed: '验收完成', partial: '部分完成', blocked: '项目阻塞', failed: '项目失败'
            };
            if (group && context.phase) group.status.textContent = stageLabels[context.phase] || context.phase;
            if (actor) {
                let label = '运行中';
                let className = 'running';
                if (event.event === 'agent.waiting') label = payload.label || '正在等待';
                if (event.event === 'agent.completed') { label = '已完成'; className = 'completed'; }
                if (event.event === 'agent.failed') { label = '失败'; className = 'failed'; }
                actor.status.textContent = label;
                actor.status.className = 'team-project-lane-status ' + className;
                actor.tab.dataset.status = className;
            }
            if (event.event === 'project.acceptance.completed' && group) {
                const outcome = payload.acceptance && payload.acceptance.outcome || context.phase;
                group.board.classList.add('finished', 'outcome-' + outcome);
                group.board.classList.add('collapsed');
                group.status.textContent = stageLabels[outcome] || '验收结束';
            }
        }
        const teamLegacyEventTypes = new Set([
            'workflow_plan', 'step_progress', 'step_done', 'error_recovery',
            'workflow_plan_updated', 'workflow_done', 'file_content', 'tool_detail',
            'stream_reset', 'status', 'agent_switch', 'thinking',
            'search_progress', 'search_result', 'crawler_progress', 'crawler_complete',
            'agent_tool_call', 'cu_status', 'cu_thinking', 'cu_screenshot',
            'cu_action', 'cu_step', 'cu_verify'
        ]);

        // Older persisted runs used "*_agent" keys. Resolve those aliases so
        // restored work logs still use the configured Agent identity/avatar.
        const teamLegacyAgentKeys = Object.freeze({
            app_agent: 'app',
            computer_agent: 'computer',
            browser_agent: 'browser',
            file_agent: 'file',
            search_agent: 'search',
            code_agent: 'code'
        });

        function teamCanonicalAgentKey(agentKey) {
            const key = String(agentKey || '');
            return teamLegacyAgentKeys[key] || key;
        }

        function teamAgent(agentOrKey) {
            if (agentOrKey && typeof agentOrKey === 'object') {
                const key = teamCanonicalAgentKey(agentOrKey.key || agentOrKey.agent_key || '');
                const configured = teamUiState.agents.get(key) || {};
                const resolved = Object.assign({}, agentOrKey, configured, { key: key, agent_key: key });
                if (configured.display_name) resolved.name = configured.display_name;
                return resolved;
            }
            const key = teamCanonicalAgentKey(agentOrKey || '');
            return teamUiState.agents.get(key) || {
                agent_key: key || 'moonya',
                display_name: key || 'MoonYa',
                avatar_url: (!key || key === 'moonya') ? '/assets/agents/moonya.png' : ''
            };
        }

        function teamEventLabel(name, payload) {
            payload = payload || {};
            if (name === 'run.completed') {
                if (payload.status === 'failed') return '任务失败';
                if (payload.status === 'partial') return '任务部分完成';
            }
            if (name === 'agent.completed' && payload.status === 'partial') {
                return '执行部分完成';
            }
            const labels = {
                'run.started': '任务开始',
                'run.completed': '任务完成',
                'agent.started': '开始执行',
                'agent.completed': '执行完成',
                'agent.failed': '执行受限',
                'agent.summary': '进度摘要',
                'tool.started': '工具调用',
                'tool.progress': '后台运行',
                'tool.completed': '工具结果',
                'agent.waiting': '正在等待',
                'agent.loop.detected': '正在纠偏',
                'coordination.finalized': '完成声明已验证',
                'project.team.started': '项目组启动',
                'project.contract.accepted': '项目合同已确认',
                'project.stage.changed': '项目阶段变更',
                'project.acceptance.completed': '项目验收完成',
                'approval.required': '等待确认',
                'approval.decided': '确认结果',
                'user_action.required': '等待用户接管',
                'user_action.decided': '用户接管结果',
                'artifact.created': '产出物',
                'assistant.completed': '最终汇总'
            };
            return labels[name] || String(name || '事件').replace(/\./g, ' · ');
        }

        function teamEventSummary(event) {
            const payload = event.payload || {};
            const agent = teamAgent(event.agent || event.agent_key);
            const agentKey = agent.agent_key || agent.key || '';
            const statuses = {
                completed: '已完成',
                success: '已完成',
                partial: '部分完成',
                failed: '失败',
                error: '失败',
                limited: '受限结束',
                cancelled: '已取消'
            };
            if (event.event === 'run.completed') {
                return statuses[payload.status] || '运行已结束';
            }
            if (event.event === 'agent.completed' && agentKey === 'moonya') {
                return statuses[payload.status] || '协调工作已结束';
            }
            if (event.event === 'assistant.completed') {
                return '最终答复已生成';
            }
            if (event.event === 'agent.completed' || event.event === 'agent.failed') {
                const fallback = event.event === 'agent.failed' ? '执行失败' : '执行完成';
                return cleanTeamCompactSummary(
                    payload.summary || (payload.error && payload.error.message) || fallback
                );
            }
            if (payload.summary) return payload.summary;
            if (payload.message) return payload.message;
            if (payload.display_message) return payload.display_message;
            if (payload.label) return payload.label;
            if (payload.content) return payload.content;
            if (payload.instruction) return payload.instruction;
            if (payload.reason) return payload.reason;
            if (payload.title) return payload.title;
            if (payload.display_name || payload.tool_key) {
                const name = payload.display_name || payload.tool_key;
                if (event.event === 'tool.completed') {
                    return name + (payload.ok === false ? '执行失败' : '执行完成');
                }
                return name;
            }
            if (payload.request_summary) return payload.request_summary;
            if (payload.status) return String(payload.status);
            return teamEventLabel(event.event);
        }

        function teamSetLive(running, text) {
            const indicator = document.getElementById('teamLiveIndicator');
            if (!indicator) return;
            indicator.classList.toggle('running', !!running);
            const label = indicator.querySelector('span');
            if (label) label.textContent = text || (running ? '运行中' : '待命');
        }

        function teamAgentKey(event) {
            const agent = teamAgent(event.agent || event.agent_key);
            return agent.agent_key || agent.key || event.agent_key || 'moonya';
        }

        function teamAvatarNode(agent, className) {
            const name = agent.name || agent.display_name || agent.agent_key || 'MoonYa';
            const avatarUrl = agent.avatar_url ||
                ((agent.agent_key || 'moonya') === 'moonya' ? '/assets/agents/moonya.png' : '');
            if (avatarUrl) {
                const image = document.createElement('img');
                image.className = className;
                image.src = avatarUrl;
                image.alt = '';
                // 图 404 时退回首字母，避免出现破图
                image.onerror = function() {
                    image.onerror = null;
                    const fallback = document.createElement('span');
                    fallback.className = className + ' team-event-avatar-fallback';
                    fallback.textContent = name.slice(0, 1).toUpperCase();
                    image.replaceWith(fallback);
                };
                return image;
            }
            const fallback = document.createElement('span');
            fallback.className = className + ' team-event-avatar-fallback';
            fallback.textContent = name.slice(0, 1).toUpperCase();
            return fallback;
        }

        function teamTurnKey(event) {
            const payload = event.payload || {};
            const runId = String(event.run_id || 'run');
            const transportTurn = event.turn !== undefined && event.turn !== null
                ? event.turn
                : payload.turn;
            const transportStep = event.step !== undefined && event.step !== null
                ? event.step
                : payload.step;
            // Harness 在一次用户轮次里会执行多个模型 step。每个 step 都有自己完整的
            // reasoning/content 生命周期；若只按 run_id 建 key，后一步就会继续改写前一步
            // 已经完成的“思考与回复”日志。turn.started 没有 step，它天然属于第 1 步。
            if (transportTurn !== undefined && transportTurn !== null && transportTurn !== '') {
                const step = transportStep !== undefined && transportStep !== null && transportStep !== ''
                    ? transportStep
                    : 1;
                return runId + ':turn:' + String(transportTurn) + ':step:' + String(step);
            }
            return runId + ':' + String(payload.turn_id || '');
        }

        // 主对话过程区/收尾行的轮次键。不能直接用 teamTurnKey：
        //   harness 的一条 session 会连续跑很多轮（客户端把 harness_session_id 存在
        //   localStorage 里复用），run_id 在一整段对话里是常量、payload 里又没有 turn_id，
        //   于是每一轮的键都一样 —— 第二轮的思考会并进第一轮的过程区，
        //   第二轮的收尾行会覆盖第一轮的。
        //   轮次身份改用该轮 agent.turn.started 的 seq（同一 session 内单调递增且唯一）。
        function conversationTurnKey(event) {
            const eventName = event && event.event;
            const transportTurn = event && event.turn;
            // 新版 Harness 明确携带 turn。优先使用它，避免窗口级“当前 key”在历史回放、
            // SSE 重连或相邻轮次事件交错时把后一轮并到前一轮。
            if (transportTurn !== undefined && transportTurn !== null && transportTurn !== '') {
                const transportKey = String(event.run_id || 'run') + ':turn:' + String(transportTurn);
                if (eventName === 'agent.turn.started' || eventName === 'turn.started') {
                    window.__moonyaTurnKey = transportKey;
                }
                return transportKey;
            }
            if (eventName === 'agent.turn.started' || eventName === 'turn.started') {
                window.__moonyaTurnKey = String(event.run_id || 'run') + ':' + String(event.seq || 0);
            }
            return window.__moonyaTurnKey || teamTurnKey(event);
        }

        function conversationReasoningBlockKey(event) {
            const payload = event && event.payload || {};
            const step = event && event.step !== undefined && event.step !== null
                ? event.step
                : payload.step;
            return step !== undefined && step !== null && step !== ''
                ? 'step:' + String(step)
                : 'step:1';
        }

        function teamMainScroll() {
            const container = document.querySelector('.messages-container');
            teamScrollIfFollowing(container);
        }

        const TEAM_STATUS_TOKEN_START = '\uE000';
        const TEAM_STATUS_TOKEN_END = '\uE001';
        const teamMarkdownRenderJobs = new WeakMap();

        function teamStatusToken(kind) {
            return TEAM_STATUS_TOKEN_START + kind + TEAM_STATUS_TOKEN_END;
        }

        function normalizeTeamEmoji(value) {
            let text = String(value || '');
            const replacements = [
                [/\u2705|\u2611\uFE0F?|\u2714\uFE0F?|\u{1F7E2}/gu, 'success'],
                [/\u26A0\uFE0F?|\u{1F7E1}|\u2757|\u2755/gu, 'warning'],
                [/\u274C|\u2716\uFE0F?|\u26D4|\u{1F6AB}|\u{1F534}/gu, 'error'],
                [/\u23F3|\u231B|\u{1F504}|\u{1F501}|\u{1F552}/gu, 'running']
            ];
            replacements.forEach(function(entry) {
                text = text.replace(entry[0], teamStatusToken(entry[1]));
            });
            // Presentation-only Emoji removal. Status meaning is preserved by
            // the private-use tokens above and becomes an inline SVG later.
            text = text.replace(
                /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0E|\uFE0F)?(?:\p{Emoji_Modifier})?)*)/gu,
                ''
            );
            return text
                .replace(/\p{Emoji_Modifier}|\p{Regional_Indicator}/gu, '')
                .replace(/[\uFE0E\uFE0F\u200D\u20E3]/g, '')
                .replace(/[\u{E0020}-\u{E007F}]/gu, '');
        }

        function teamStatusLabel(kind) {
            return ({
                success: '成功',
                warning: '警告',
                error: '失败',
                running: '进行中'
            })[kind] || '状态';
        }

        function teamStatusSvgMarkup(kind) {
            const commonStart = '<svg viewBox="0 0 24 24" aria-hidden="true">';
            const commonEnd = '</svg>';
            if (kind === 'success') {
                return commonStart +
                    '<circle cx="12" cy="12" r="9"></circle>' +
                    '<path d="m8 12 2.6 2.6L16.5 9"></path>' +
                    commonEnd;
            }
            if (kind === 'warning') {
                return commonStart +
                    '<path d="M10.3 4.2 3.1 17a2 2 0 0 0 1.7 3h14.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"></path>' +
                    '<path d="M12 9v4"></path><path d="M12 17h.01"></path>' +
                    commonEnd;
            }
            if (kind === 'error') {
                return commonStart +
                    '<circle cx="12" cy="12" r="9"></circle>' +
                    '<path d="m9 9 6 6M15 9l-6 6"></path>' +
                    commonEnd;
            }
            return commonStart +
                '<circle cx="12" cy="12" r="9"></circle>' +
                '<path d="M12 7v5l3 2"></path>' +
                commonEnd;
        }

        function teamActionSvgMarkup(kind) {
            if (kind === 'copy') {
                return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                    '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
                    '<path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>' +
                    '</svg>';
            }
            if (kind === 'check') {
                return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                    '<path d="m5 12 4 4L19 6"></path>' +
                    '</svg>';
            }
            return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<polyline points="9 6 15 12 9 18"></polyline>' +
                '</svg>';
        }

        function teamStatusIcon(kind) {
            const icon = document.createElement('span');
            icon.className = 'team-inline-status-icon ' + kind;
            icon.setAttribute('role', 'img');
            icon.setAttribute('aria-label', teamStatusLabel(kind));
            icon.innerHTML = teamStatusSvgMarkup(kind);
            return icon;
        }

        function teamTokenPattern() {
            return /\uE000(success|warning|error|running)\uE001/g;
        }

        function teamTokensToLabels(value) {
            return String(value || '').replace(teamTokenPattern(), function(match, kind) {
                return teamStatusLabel(kind);
            });
        }

        function appendTeamTokenizedText(parent, value) {
            const text = String(value || '');
            const pattern = teamTokenPattern();
            let index = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                if (match.index > index) {
                    parent.appendChild(document.createTextNode(text.slice(index, match.index)));
                }
                parent.appendChild(teamStatusIcon(match[1]));
                index = match.index + match[0].length;
            }
            if (index < text.length) {
                parent.appendChild(document.createTextNode(text.slice(index)));
            }
        }

        function teamSafeLink(rawHref) {
            const href = String(rawHref || '').trim();
            if (!href || /[\u0000-\u001F\u007F]/.test(href)) return null;
            try {
                const parsed = new URL(href, window.location.href);
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
                    return parsed.href;
                }
            } catch (error) {}
            return null;
        }

        function appendTeamInline(parent, value) {
            const text = String(value || '');
            const pattern = /(\uE000(?:success|warning|error|running)\uE001|`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\)\n]+\))/g;
            let index = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                if (match.index > index) {
                    appendTeamTokenizedText(parent, text.slice(index, match.index));
                }
                const token = match[0];
                const statusMatch = token.match(/^\uE000(success|warning|error|running)\uE001$/);
                if (statusMatch) {
                    parent.appendChild(teamStatusIcon(statusMatch[1]));
                } else if (token.startsWith('`')) {
                    const code = document.createElement('code');
                    code.className = 'team-inline-code';
                    code.textContent = teamTokensToLabels(token.slice(1, -1));
                    parent.appendChild(code);
                } else if (token.startsWith('***')) {
                    const strong = document.createElement('strong');
                    const emphasis = document.createElement('em');
                    appendTeamInline(emphasis, token.slice(3, -3));
                    strong.appendChild(emphasis);
                    parent.appendChild(strong);
                } else if (token.startsWith('**')) {
                    const strong = document.createElement('strong');
                    appendTeamInline(strong, token.slice(2, -2));
                    parent.appendChild(strong);
                } else if (token.startsWith('*')) {
                    const emphasis = document.createElement('em');
                    appendTeamInline(emphasis, token.slice(1, -1));
                    parent.appendChild(emphasis);
                } else {
                    const linkMatch = token.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
                    const safeHref = linkMatch ? teamSafeLink(teamTokensToLabels(linkMatch[2])) : null;
                    if (linkMatch && safeHref) {
                        const link = document.createElement('a');
                        link.href = safeHref;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        appendTeamInline(link, linkMatch[1]);
                        parent.appendChild(link);
                    } else if (linkMatch) {
                        appendTeamInline(parent, linkMatch[1]);
                    } else {
                        appendTeamTokenizedText(parent, token);
                    }
                }
                index = match.index + token.length;
            }
            if (index < text.length) {
                appendTeamTokenizedText(parent, text.slice(index));
            }
        }

        function teamTableCells(line) {
            let row = String(line || '').trim();
            if (row.startsWith('|')) row = row.slice(1);
            if (row.endsWith('|')) row = row.slice(0, -1);
            return row.split('|').map(function(cell) { return cell.trim(); });
        }

        function teamTableSeparator(line) {
            const cells = teamTableCells(line);
            return cells.length > 0 && cells.every(function(cell) {
                return /^:?-{3,}:?$/.test(cell);
            });
        }

        function teamStatusTone(value) {
            const text = String(value || '');
            if (text.includes(teamStatusToken('error')) || /(失败|错误|异常|拒绝|取消|未执行|无法|不存在)/.test(text)) {
                return 'error';
            }
            if (text.includes(teamStatusToken('warning')) || /(警告|注意|部分完成|未完成|待确认|受限)/.test(text)) {
                return 'warning';
            }
            if (text.includes(teamStatusToken('running')) || /(运行中|进行中|处理中|等待中|待处理)/.test(text)) {
                return 'running';
            }
            if (text.includes(teamStatusToken('success')) || /(成功|已完成|完成|已执行|已清空|正常|通过|可用)/.test(text)) {
                return 'success';
            }
            return '';
        }

        function teamContainsStatusToken(value) {
            return teamTokenPattern().test(String(value || ''));
        }

        function teamCopyText(value, button) {
            const text = String(value || '');
            const markCopied = function() {
                if (!button) return;
                button.classList.add('copied');
                button.setAttribute('aria-label', '已复制');
                button.innerHTML = teamActionSvgMarkup('check');
                window.setTimeout(function() {
                    button.classList.remove('copied');
                    button.setAttribute('aria-label', '复制');
                    button.innerHTML = teamActionSvgMarkup('copy');
                }, 1600);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(markCopied).catch(function() {
                    const textarea = document.createElement('textarea');
                    textarea.value = text;
                    textarea.setAttribute('readonly', '');
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    try { document.execCommand('copy'); } catch (error) {}
                    textarea.remove();
                    markCopied();
                });
                return;
            }
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try { document.execCommand('copy'); } catch (error) {}
            textarea.remove();
            markCopied();
        }

        function createTeamCodeBlock(rawCode, language, contextHeading, options) {
            const code = teamTokensToLabels(rawCode).replace(/\s+$/, '');
            const lines = code === '' ? 0 : code.split('\n').length;
            const collapsed = lines > 12;
            const figure = document.createElement('figure');
            figure.className = 'team-code-block' + (collapsed ? ' is-collapsed' : '');
            figure.dataset.lines = String(lines);

            const header = document.createElement('figcaption');
            header.className = 'team-code-header';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'team-code-toggle';
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            const chevron = document.createElement('span');
            chevron.className = 'team-code-chevron';
            chevron.innerHTML = teamActionSvgMarkup('chevron');
            const title = document.createElement('span');
            title.className = 'team-code-title';
            title.textContent = language ||
                (/(验证|校验|检查)/.test(contextHeading || '') ? '验证输出' : '文本输出');
            const lineCount = document.createElement('span');
            lineCount.className = 'team-code-lines';
            lineCount.textContent = lines + ' 行';
            toggle.append(chevron, title, lineCount);

            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'team-code-copy';
            copy.setAttribute('aria-label', '复制');
            copy.innerHTML = teamActionSvgMarkup('copy');
            copy.addEventListener('click', function(event) {
                event.stopPropagation();
                teamCopyText(code, copy);
            });
            toggle.addEventListener('click', function() {
                const isCollapsed = figure.classList.toggle('is-collapsed');
                toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            });
            header.append(toggle, copy);

            const pre = document.createElement('pre');
            const codeNode = document.createElement('code');
            codeNode.textContent = code;
            const lang = String(language || '').toLowerCase();
            if (options.final && lang && window.hljs && hljs.getLanguage(lang)) {
                try {
                    codeNode.innerHTML = hljs.highlight(code, { language: lang }).value;
                    codeNode.className = 'hljs language-' + lang;
                } catch (error) {
                    codeNode.textContent = code;
                }
            }
            pre.appendChild(codeNode);
            figure.append(header, pre);
            return figure;
        }

        function teamStartsBlock(lines, index) {
            const line = String(lines[index] || '').trim();
            if (!line) return true;
            if (/^```/.test(line) || /^(#{1,4})\s+/.test(line) || /^>\s?/.test(line)) return true;
            if (/^(\d+)\.\s+/.test(line) || /^[-*]\s+/.test(line)) return true;
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return true;
            return index + 1 < lines.length && line.includes('|') && teamTableSeparator(lines[index + 1]);
        }

        function buildTeamMarkdownFragment(source, options) {
            options = options || {};
            const normalized = normalizeTeamEmoji(source).replace(/\r\n?/g, '\n');
            const lines = normalized.split('\n');
            const fragment = document.createDocumentFragment();
            let lastHeading = '';
            let index = 0;

            while (index < lines.length) {
                const line = lines[index];
                const trimmed = line.trim();
                if (!trimmed) {
                    index++;
                    continue;
                }

                const fence = trimmed.match(/^```([A-Za-z0-9_+#.-]*)\s*$/);
                if (fence) {
                    const codeLines = [];
                    index++;
                    while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
                        codeLines.push(lines[index]);
                        index++;
                    }
                    if (index < lines.length) index++;
                    fragment.appendChild(createTeamCodeBlock(
                        codeLines.join('\n'),
                        fence[1] || '',
                        lastHeading,
                        options
                    ));
                    continue;
                }

                const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
                if (headingMatch) {
                    lastHeading = teamTokensToLabels(headingMatch[2]);
                    const heading = document.createElement('h' + headingMatch[1].length);
                    if (/(操作结果|执行结果|任务结果|验证输出|验证结果)/.test(lastHeading)) {
                        heading.className = 'team-result-heading';
                    }
                    appendTeamInline(heading, headingMatch[2]);
                    fragment.appendChild(heading);
                    index++;
                    continue;
                }

                if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                    fragment.appendChild(document.createElement('hr'));
                    index++;
                    continue;
                }

                if (index + 1 < lines.length && trimmed.includes('|') && teamTableSeparator(lines[index + 1])) {
                    const headers = teamTableCells(line);
                    const separator = teamTableCells(lines[index + 1]);
                    const alignments = separator.map(function(cell) {
                        if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
                        return cell.endsWith(':') ? 'right' : 'left';
                    });
                    const wrapper = document.createElement('div');
                    wrapper.className = 'team-table-wrap';
                    const table = document.createElement('table');
                    const thead = document.createElement('thead');
                    const headRow = document.createElement('tr');
                    headers.forEach(function(headerText, cellIndex) {
                        const th = document.createElement('th');
                        th.style.textAlign = alignments[cellIndex] || 'left';
                        appendTeamInline(th, headerText);
                        headRow.appendChild(th);
                    });
                    thead.appendChild(headRow);
                    table.appendChild(thead);
                    const tbody = document.createElement('tbody');
                    index += 2;
                    while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
                        const cells = teamTableCells(lines[index]);
                        const row = document.createElement('tr');
                        let rowTone = '';
                        cells.forEach(function(cellText, cellIndex) {
                            const td = document.createElement('td');
                            const label = teamTokensToLabels(headers[cellIndex] || '');
                            td.dataset.label = label;
                            td.style.textAlign = alignments[cellIndex] || 'left';
                            const cellValue = document.createElement('span');
                            cellValue.className = 'team-cell-value';
                            const statusColumn = /(状态|结果|验证|status|result)/i.test(label);
                            const tone = (statusColumn || teamContainsStatusToken(cellText))
                                ? teamStatusTone(cellText)
                                : '';
                            appendTeamInline(cellValue, cellText);
                            if (tone) {
                                td.classList.add('team-status-cell', tone);
                                rowTone = rowTone || tone;
                                if (!teamContainsStatusToken(cellText)) {
                                    cellValue.insertBefore(teamStatusIcon(tone), cellValue.firstChild);
                                }
                            }
                            td.appendChild(cellValue);
                            row.appendChild(td);
                        });
                        if (rowTone) row.classList.add('team-status-row-' + rowTone);
                        tbody.appendChild(row);
                        index++;
                    }
                    table.appendChild(tbody);
                    wrapper.appendChild(table);
                    fragment.appendChild(wrapper);
                    continue;
                }

                if (/^>\s?/.test(trimmed)) {
                    const quote = document.createElement('blockquote');
                    while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
                        const paragraph = document.createElement('p');
                        appendTeamInline(paragraph, lines[index].trim().replace(/^>\s?/, ''));
                        quote.appendChild(paragraph);
                        index++;
                    }
                    fragment.appendChild(quote);
                    continue;
                }

                const ordered = trimmed.match(/^(\d+)\.\s+(.+)$/);
                const unordered = trimmed.match(/^[-*]\s+(.+)$/);
                if (ordered || unordered) {
                    const list = document.createElement(ordered ? 'ol' : 'ul');
                    const listPattern = ordered ? /^(\d+)\.\s+(.+)$/ : /^[-*]\s+(.+)$/;
                    while (index < lines.length) {
                        const itemMatch = lines[index].trim().match(listPattern);
                        if (!itemMatch) break;
                        const item = document.createElement('li');
                        appendTeamInline(item, ordered ? itemMatch[2] : itemMatch[1]);
                        list.appendChild(item);
                        index++;
                    }
                    fragment.appendChild(list);
                    continue;
                }

                const paragraph = document.createElement('p');
                let firstLine = true;
                while (index < lines.length && lines[index].trim() && !teamStartsBlock(lines, index)) {
                    if (!firstLine) paragraph.appendChild(document.createElement('br'));
                    appendTeamInline(paragraph, lines[index].trim());
                    firstLine = false;
                    index++;
                }
                if (firstLine) {
                    appendTeamInline(paragraph, trimmed);
                    index++;
                }
                fragment.appendChild(paragraph);
            }
            return fragment;
        }

        function commitTeamMarkdown(container, source, options) {
            if (!container) return;
            container.classList.add('team-markdown');
            container.replaceChildren(buildTeamMarkdownFragment(source, options || {}));
        }

        function renderTeamMarkdown(container, source, options) {
            if (!container) return;
            options = options || {};
            let job = teamMarkdownRenderJobs.get(container);
            if (!job) {
                job = { frame: 0, source: '', options: {} };
                teamMarkdownRenderJobs.set(container, job);
            }
            job.source = String(source || '');
            job.options = Object.assign({}, options);
            const commit = function() {
                job.frame = 0;
                commitTeamMarkdown(container, job.source, job.options);
            };
            if (options.final || options.history || options.immediate) {
                if (job.frame) {
                    (window.cancelAnimationFrame || window.clearTimeout)(job.frame);
                    job.frame = 0;
                }
                commit();
                return;
            }
            if (!job.frame) {
                const schedule = window.requestAnimationFrame || function(callback) {
                    return window.setTimeout(callback, 16);
                };
                job.frame = schedule(commit);
            }
        }

        function cleanTeamCompactSummary(value) {
            const cleaned = normalizeTeamEmoji(value)
                .replace(/^```[^\n]*$/gm, '')
                .replace(/^#{1,4}\s+/gm, '')
                .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, '')
                .replace(/\*\*\*|\*\*|`/g, '')
                .replace(/\s*\|\s*/g, ' · ')
                .replace(/\s+/g, ' ')
                .trim();
            if (!cleaned) return '已完成';
            const chineseSentence = cleaned.match(/^.*?[。！？]/u);
            const englishSentence = cleaned.match(/^.*?[.!?](?=\s|$)/u);
            const candidates = [
                chineseSentence && chineseSentence[0],
                englishSentence && englishSentence[0]
            ].filter(Boolean).sort(function(left, right) { return left.length - right.length; });
            const sentence = candidates[0] || cleaned;
            return sentence.length > 180 ? sentence.slice(0, 179).trimEnd() + '…' : sentence;
        }

        function hasTeamVisibleContent(value) {
            return teamTokensToLabels(normalizeTeamEmoji(value)).trim() !== '';
        }

        function renderTeamPlainText(container, source, options) {
            if (!container) return;
            options = options || {};
            const text = options.summary
                ? cleanTeamCompactSummary(source)
                : normalizeTeamEmoji(source);
            container.replaceChildren();
            appendTeamTokenizedText(container, text);
        }

        function teamPresentationLookup(event) {
            return [
                event.run_id || 'run',
                teamAgentKey(event),
                event.task_id || ''
            ].join(':');
        }

        function startTeamPresentation(event, forcedKey) {
            const payload = event.payload || {};
            const runId = String(event.run_id || 'run');
            const agent = teamAgent(event.agent || event.agent_key);
            const agentKey = teamAgentKey(event);
            const projectContext = teamProjectContext(event);
            const phase = payload.phase || (agentKey === 'moonya' ? 'planning' : 'execution');
            const key = forcedKey || [
                runId,
                'presentation',
                agentKey,
                event.task_id || phase,
                event.seq || Date.now()
            ].join(':');
            const existing = teamUiState.presentationRecords.get(key);
            if (existing) return existing;

            const container = document.querySelector('.messages-container');
            if (!container) return null;
            const card = document.createElement('article');
            card.className = 'team-agent-message team-presentation-message is-live is-loading';
            card.dataset.teamPresentationKey = key;

            const traceHeader = document.createElement('button');
            traceHeader.type = 'button';
            traceHeader.className = 'turn-process-header codex-turn-header';
            traceHeader.setAttribute('aria-expanded', 'true');
            traceHeader.setAttribute('data-open', '1');
            const traceLabel = document.createElement('span');
            traceLabel.className = 'turn-process-label';
            traceLabel.textContent = '正在工作';
            const traceChevron = document.createElement('span');
            traceChevron.className = 'turn-process-chevron';
            traceChevron.innerHTML = createWorkflowChevronIcon(16, 'down');
            traceHeader.append(traceLabel, traceChevron);

            const header = document.createElement('div');
            header.className = 'team-main-head';
            header.appendChild(teamAvatarNode(agent, 'team-main-avatar'));
            const name = document.createElement('span');
            name.className = 'team-main-agent';
            name.textContent = projectContext.roleLabel || agent.name || agent.display_name || agent.agent_key || 'MoonYa';
            const status = document.createElement('span');
            status.className = 'team-main-status';
            status.textContent = projectContext.workstream || (phase === 'final_synthesis'
                ? '正在汇总'
                : (agentKey === 'moonya' ? '准备分工' : '处理中'));
            header.append(name, status);

            const loading = document.createElement('div');
            loading.className = 'team-main-loading-bubble';
            loading.setAttribute('aria-label', '正在处理');
            loading.innerHTML =
                '<span></span><span></span><span></span>';
            const approvals = document.createElement('div');
            approvals.className = 'team-main-approvals';
            card.append(traceHeader, header, loading, approvals);
            container.appendChild(card);

            const record = Object.assign(new CodexTurnTrace(key,
                event.timestamp ? Date.parse(event.timestamp) : Date.now()), {
                key: key,
                runId: runId,
                agentKey: agentKey,
                taskId: event.task_id || '',
                phase: phase,
                agent: agent,
                card: card,
                status: 'running',
                content: '',
                traceHeader: traceHeader,
                traceLabel: traceLabel,
                elapsedMs: 0
            });
            if (!Number.isFinite(record.startedAt)) record.startedAt = Date.now();
            card.setAttribute('data-turn-started-at', new Date(record.startedAt).toISOString());
            record.timer = window.setInterval(function() {
                if (!card.isConnected || record.status !== 'running') return;
                traceLabel.textContent = '正在工作 · ' + formatTurnDuration(Date.now() - record.startedAt);
            }, 1000);
            teamUiState.presentationRecords.set(key, record);
            teamUiState.activePresentation.set(teamPresentationLookup(event), key);
            if (agentKey === 'moonya' && phase === 'final_synthesis') {
                teamUiState.synthesisRuns.add(runId);
            }
            teamMainScroll();
            return record;
        }

        function activeTeamPresentation(event) {
            const key = teamUiState.activePresentation.get(teamPresentationLookup(event));
            return key ? teamUiState.presentationRecords.get(key) || null : null;
        }

        function finishTeamPresentationTimer(record, completedAt) {
            if (!record || !record.card) return;
            if (record.timer) {
                window.clearInterval(record.timer);
                record.timer = null;
            }
            const completedEpoch = completedAt ? Date.parse(completedAt) : Date.now();
            const settledAt = Number.isFinite(completedEpoch) ? completedEpoch : Date.now();
            record.elapsedMs = Math.max(0, settledAt - (record.startedAt || settledAt));
            record.completedAt = new Date(settledAt).toISOString();
            if (record.traceLabel) record.traceLabel.textContent = '用时 ' + formatTurnDuration(record.elapsedMs);
            if (record.traceHeader) {
                record.traceHeader.removeAttribute('data-open');
                record.traceHeader.setAttribute('aria-expanded', 'false');
            }
            record.card.setAttribute('data-turn-elapsed', String(Math.round(record.elapsedMs)));
            record.card.setAttribute('data-turn-completed-at', record.completedAt);
        }

        function updateTeamPresentation(record, content, options) {
            if (!record || !record.card) return;
            options = options || {};
            record.content = String(content || '');
            const card = record.card;
            let bubble = card.querySelector('.team-presentation-bubble');
            if (!bubble) {
                const loading = card.querySelector('.team-main-loading-bubble');
                if (loading) loading.remove();
                bubble = document.createElement('div');
                bubble.className = 'team-main-bubble team-presentation-bubble';
                const approvals = card.querySelector('.team-main-approvals');
                card.insertBefore(bubble, approvals || null);
            }
            if (options.markdown) {
                renderTeamMarkdown(bubble, record.content, { final: !!options.final });
            } else {
                renderTeamPlainText(bubble, record.content, { summary: !!options.summary });
            }
            card.classList.remove('is-loading');
            const status = card.querySelector('.team-main-status');
            if (options.final) {
                record.status = options.status || (options.failed ? 'failed' : 'completed');
                finishTeamPresentationTimer(record, options.completedAt || record.completedAt);
                card.classList.remove('is-live');
                card.classList.add('is-complete');
                if (status) {
                    status.textContent = options.statusLabel ||
                        (options.failed ? '执行失败' : '已完成');
                }
                const lookup = [
                    record.runId,
                    record.agentKey,
                    record.taskId
                ].join(':');
                if (teamUiState.activePresentation.get(lookup) === record.key) {
                    teamUiState.activePresentation.delete(lookup);
                }
            } else if (status) {
                status.textContent = '正在回复';
            }
            teamMainScroll();
        }

        function delegationAnnouncementFromEvent(event) {
            const payload = event.payload || {};
            if (payload.announcement) return payload.announcement;
            const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
            if (tasks.length === 1) {
                const task = tasks[0] || {};
                const agent = teamAgent(task.agent_key || '');
                const name = task.agent_display_name || agent.display_name || agent.name || task.agent_key || 'Agent';
                const instruction = String(task.instruction || '当前任务')
                    .replace(/\s+/g, ' ').replace(/[。！？.!?\s]+$/g, '').slice(0, 80);
                return '准备处理：' + (instruction || '当前任务') + '。这项工作交给 ' + name + '。';
            }
            if (tasks.length > 1) {
                const names = Array.from(new Set(tasks.map(function(task) {
                    const agent = teamAgent(task.agent_key || '');
                    return task.agent_display_name || agent.display_name || agent.name || task.agent_key || 'Agent';
                })));
                return '准备处理这项任务，已交给 ' + names.join('、') + ' 分工完成。';
            }
            return payload.summary || '已完成任务分工。';
        }

        function renderTeamDelegationMain(event) {
            let record = activeTeamPresentation({
                run_id: event.run_id,
                agent_key: 'moonya',
                task_id: ''
            });
            if (!record || record.phase === 'final_synthesis') {
                record = startTeamPresentation({
                    run_id: event.run_id,
                    seq: event.seq,
                    agent: teamAgent('moonya'),
                    agent_key: 'moonya',
                    task_id: '',
                    payload: { phase: 'planning' }
                });
            }
            updateTeamPresentation(record, delegationAnnouncementFromEvent(event), { final: true, completedAt: event.timestamp });
        }

        function renderTeamAgentCompletionMain(event) {
            const agentKey = teamAgentKey(event);
            const payload = event.payload || {};
            if (agentKey === 'moonya') {
                const rootFailure = payload.summary || (payload.error && payload.error.message) || '';
                if (event.event === 'agent.failed' && rootFailure) {
                    let root = activeTeamPresentation(event) || startTeamPresentation(event);
                    updateTeamPresentation(
                        root,
                        rootFailure,
                        { markdown: true, final: true, failed: true, completedAt: event.timestamp }
                    );
                    teamUiState.synthesisRuns.delete(String(event.run_id || ''));
                }
                return;
            }
            let record = activeTeamPresentation(event);
            if (!record) {
                record = startTeamPresentation(Object.assign({}, event, {
                    payload: Object.assign({}, payload, { phase: 'execution' })
                }));
            }
            const cancelled = (payload.error && payload.error.code === 'run_cancelled') ||
                (payload.structured_content && payload.structured_content.cancelled === true);
            if (cancelled) {
                updateTeamPresentation(
                    record,
                    '说停就停~等待新的工作安排。',
                    {
                        final: true,
                        summary: true,
                        status: 'cancelled',
                        statusLabel: '已停止',
                        completedAt: event.timestamp
                    }
                );
                return;
            }
            const failed = event.event === 'agent.failed' || payload.status === 'failed' || payload.status === 'limited';
            const summary = payload.summary ||
                (payload.error && payload.error.message) ||
                (failed ? '任务未能完成。' : '任务已完成。');
            // AgentResult.summary is the employee's complete final report. It is
            // persisted in full and must not be routed through the 180-character
            // compact-summary renderer, which would manufacture a trailing ellipsis.
            updateTeamPresentation(record, summary, {
                markdown: true,
                final: true,
                failed: failed,
                completedAt: event.timestamp
            });
        }

        function renderTeamSynthesisDelta(event) {
            const runId = String(event.run_id || '');
            const payload = event.payload || {};
            const phase = payload.phase || (payload.metadata && payload.metadata.phase) || '';
            if (teamAgentKey(event) !== 'moonya' || phase !== 'final_synthesis') return;
            // ★ 防御性兼容：若 agent.started(final_synthesis) 未到达或被乱序处理导致
            //   synthesisRuns 未注册该 runId，在此自动补建 presentation 卡片，
            //   确保流式 delta 不会因缺失前置事件而全部丢弃（左边对话区域整段一次性出现的另一诱因）。
            if (!teamUiState.synthesisRuns.has(runId)) {
                const synthetic = {
                    run_id: runId,
                    seq: event.seq,
                    agent: teamAgent('moonya'),
                    agent_key: 'moonya',
                    task_id: event.task_id || '',
                    payload: { phase: 'final_synthesis' }
                };
                startTeamPresentation(synthetic);
            }
            let record = activeTeamPresentation(event);
            if (!record || record.phase !== 'final_synthesis') return;
            record.content += String(payload.delta || '');
            if (hasTeamToolProtocolMarkup(record.content)) {
                record.protocolBlocked = true;
                updateTeamPresentation(record, '', { markdown: true });
                const status = record.card && record.card.querySelector('.team-main-status');
                if (status) status.textContent = '协议响应异常';
                return;
            }
            if (record.protocolBlocked) return;
            updateTeamPresentation(record, record.content, { markdown: true });
        }

        function hasTeamToolProtocolMarkup(value) {
            return /(?:<[|｜]{1,2}DSML[|｜]{1,2}|<\/?(?:tool_calls?|invoke|function_calls?)\b|"tool_calls"\s*:)/iu
                .test(String(value || ''));
        }

        function renderTeamAssistantCompletedMain(event) {
            const runId = String(event.run_id || '');
            const payloadContent = (event.payload && event.payload.content) || '';
            // ★ 修复：Image Agent 证据场景下，Phase 2 的 content/reasoning 已通过 legacy
            //   事件流式输出到左侧对话区域（.message.ai .message-content），
            //   assistant.completed 携带空内容。此时若已有 legacy 气泡包含内容，
            //   移除空的 presentation 卡片避免重复渲染；否则正常渲染。
            if (!payloadContent) {
                const legacyBubbles = document.querySelectorAll('.message.ai .message-content');
                let hasLegacyContent = false;
                for (let i = 0; i < legacyBubbles.length; i++) {
                    if ((legacyBubbles[i].textContent || '').trim() !== '') {
                        hasLegacyContent = true;
                        break;
                    }
                }
                if (hasLegacyContent) {
                    const lookup = teamPresentationLookup({
                        run_id: runId,
                        agent_key: 'moonya',
                        task_id: ''
                    });
                    const key = teamUiState.activePresentation.get(lookup);
                    if (key) {
                        const rec = teamUiState.presentationRecords.get(key);
                        if (rec && rec.card && !rec.content) {
                            rec.card.remove();
                            teamUiState.presentationRecords.delete(key);
                            teamUiState.activePresentation.delete(lookup);
                        }
                    }
                    teamUiState.synthesisRuns.delete(runId);
                    return;
                }
            }
            let record = activeTeamPresentation({
                run_id: runId,
                agent_key: 'moonya',
                task_id: ''
            });
            if (record && record.phase !== 'final_synthesis') {
                record.phase = 'final_synthesis';
                teamUiState.synthesisRuns.add(runId);
            } else if (!record) {
                record = startTeamPresentation({
                    run_id: runId,
                    seq: event.seq,
                    agent: teamAgent('moonya'),
                    agent_key: 'moonya',
                    task_id: '',
                    payload: { phase: 'final_synthesis' }
                });
            }
            updateTeamPresentation(
                record,
                payloadContent || record.content || '任务已完成。',
                { markdown: true, final: true, completedAt: event.timestamp }
            );
            teamUiState.synthesisRuns.delete(runId);
        }

        function renderTeamCancellation(runId) {
            runId = String(runId || '');
            if (!runId || teamUiState.stoppedRuns.has(runId)) return;
            teamUiState.approvals.forEach(function(approval, approvalId) {
                if (approval.runId !== runId || approval.status !== 'pending') return;
                updateTeamApprovalCard(approvalId, 'cancelled');
                const approvalHost = approval.card && approval.card.closest('.team-agent-message');
                if (approvalHost) approvalHost.classList.remove('has-pending-approval');
            });
            teamUiState.presentationRecords.forEach(function(record) {
                if (record.runId !== runId || record.status !== 'running') return;
                const hasPartial = !!record.content;
                if (hasPartial) {
                    record.status = 'cancelled';
                    finishTeamPresentationTimer(record);
                    record.card.classList.remove('is-live', 'is-loading');
                    record.card.classList.add('is-complete', 'is-interrupted');
                    const status = record.card.querySelector('.team-main-status');
                    if (status) status.textContent = '已停止';
                } else if (record.card) {
                    record.card.remove();
                    record.status = 'cancelled';
                }
            });
            teamUiState.stoppedRuns.add(runId);
            teamUiState.runStatus.set(runId, 'cancelled');
            teamUiState.synthesisRuns.delete(runId);
            teamSetLive(false, '已停止');
        }

        window.stopCurrentMoonYaResponse = function() {
            const runtime = getConversationRuntime(currentChatId);
            if (!runtime.running && !runtime.preparing && !runtime.abortController) return;
            approvalStateGeneration += 1;
            const runId = String(runtime.activeRunId || teamUiState.activeRunId || '');
            const isTeamRunning = !!runId;
            if (runtime.customModelChat && runtime.clientMessageId) {
                fetch('model_api.php', {
                    method: 'POST', keepalive: true, headers: getAuthHeaders(),
                    body: JSON.stringify({ action: 'cancel_chat', conversation_id: runtime.dbConversationId || null,
                        client_message_id: runtime.clientMessageId })
                }).catch(function() {});
            }
            if (runtime.harnessSessionKey) {
                const runtimeSessionId = runtime.harnessSessionId || localStorage.getItem(runtime.harnessSessionKey) || runId;
                if (runtimeSessionId) {
                    fetch('harness_api.php?action=cancel', {
                        method: 'POST', keepalive: true,
                        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
                        body: JSON.stringify({
                            session_id: runtimeSessionId,
                            project_path: runtime.workspaceIdentity === '__default__' ? '' : runtime.workspaceIdentity || ''
                        })
                    }).catch(function() {});
                }
            }
            if (runtime.dbConversationId && runtime.clientMessageId) {
                fetch(addTokenToUrl('conversation_api.php?action=stop_task'), {
                    method: 'POST',
                    keepalive: true,
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        conversation_id: runtime.dbConversationId,
                        client_message_id: runtime.clientMessageId
                    })
                }).catch(function() {});
                if (window.MoonYaSharedRuntime) {
                    window.MoonYaSharedRuntime.stop({
                        conversationId: runtime.dbConversationId,
                        clientMessageId: runtime.clientMessageId,
                        runId: runId || null
                    }).catch(function() {});
                }
            }
            if (isTeamRunning) renderTeamCancellation(runId);
            if (runtime.abortController) {
                runtime.abortController.abort();
            }
            if (runtime.finalizeCancelledResponse) {
                runtime.finalizeCancelledResponse();
                return;
            }
            runtime.abortController = null;
            runtime.running = false;
            syncConversationFollow(runtime);
            currentAbortController = null;
            window.isSendingMessage = false;
            runtime.container.querySelectorAll('.loading-indicator').forEach(function(node) { node.remove(); });
            stopStallDetector();
            const button = document.getElementById('sendBtn');
            if (button) {
                button.removeAttribute('data-state');
                button.innerHTML = SEND_ICON_HTML;
            }
            saveCurrentChat(runtime);
        };

        // ========== 工具/操作名称与图标（顶层：过程区与工作日志共用）==========
        // 这些函数原先定义在 sendMessage() 内层 try 块里，只有发消息时才存在；
        // 主对话过程区在 IIFE 顶层调用它们，会抛 ReferenceError 并中断整段渲染。
        // 它们只依赖入参、不捕获闭包状态，因此上移到顶层是行为等价的。
            // 本轮耗时格式化，照抄 DSH message-chrome.ts 的 formatRunDuration：
            //   满一分钟才进分钟档、满一小时才进小时档，进位后小单位补零
            //   （locale：duration.seconds '{seconds}秒' / duration.minutes '{minutes}分{seconds}秒'
            //    / duration.hours '{hours}小时{minutes}分{seconds}秒'）。
            function formatTurnDuration(ms) {
                var total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
                var hours = Math.floor(total / 3600);
                var minutes = Math.floor(total / 60) % 60;
                var seconds = total % 60;
                var pad2 = function(n) { return n < 10 ? '0' + n : String(n); };
                if (hours > 0) return hours + '小时' + pad2(minutes) + '分' + pad2(seconds) + '秒';
                if (minutes > 0) return minutes + '分' + pad2(seconds) + '秒';
                return seconds + '秒';
            }

            // 思考文本是否"视觉为空"（\s 覆盖不到的零宽字符单独列出）。
            // 唯一的判空标准，供空 wrapper 清理与历史保存共用。
            function isThinkingEmpty(text) {
                if (!text) return true;
                return String(text).replace(/[\s\u200B-\u200D\uFEFF]/g, '').length === 0;
            }

            // 旧的（气泡内）本轮过程表头折叠开关：点表头收起/展开气泡里的过程行。
            // 主对话过程区不用它 —— 那个走 document 委托的 toggleTurnProcessArea。
            function toggleTurnProcess(headerEl) {
                if (!headerEl) return;
                var open = headerEl.getAttribute('data-open') === '1';
                if (open) headerEl.removeAttribute('data-open');
                else headerEl.setAttribute('data-open', '1');
                headerEl.setAttribute('aria-expanded', open ? 'false' : 'true');
                var contentEl = headerEl.parentElement;
                if (contentEl) contentEl.classList.toggle('process-collapsed', open);
            }

            // ★ 跨 <script> 块调用：script-1c-save.php 回放历史时要重建旧表头并直接调用
            //   toggleTurnProcess / formatTurnDuration / isThinkingEmpty。留在内层作用域时
            //   回放侧拿到的是 undefined，整段历史还原会抛 ReferenceError（旧对话打不开）。
            window.formatTurnDuration = formatTurnDuration;
            window.isThinkingEmpty = isThinkingEmpty;
            window.toggleTurnProcess = toggleTurnProcess;

            function getOperationSummary(toolName, label, detail) {
                label = (label || '').trim();
                detail = (detail || '').trim();
                function extractAfterColon(s) {
                    if (!s) return '';
                    var idx = s.indexOf('：');
                    if (idx === -1) idx = s.indexOf(':');
                    if (idx === -1) return s;
                    return s.substring(idx + 1).trim();
                }
                function truncate(s, max) {
                    if (!s) return s;
                    if (s.length <= max) return s;
                    return s.substring(0, max) + '...';
                }
                function hasColon(s) {
                    return s && (s.indexOf('：') !== -1 || s.indexOf(':') !== -1);
                }
                function basename(s) {
                    if (!s) return s;
                    var normalized = s.replace(/\\/g, '/').replace(/\/+$/, '');
                    var parts = normalized.split('/');
                    return parts[parts.length - 1] || s;
                }
                var extracted;
                switch (toolName) {
                    case 'create_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'read_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'list_files':
                        // 只用 label；detail 里是完整目录列表，不能拼到摘要里
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件' && extracted !== '文件夹') return truncate(basename(extracted), 60);
                        return '文件夹';
                    case 'delete_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'create_folder':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件夹') return truncate(basename(extracted), 60);
                        return '文件夹';
                    case 'open_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'copy_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'move_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'download_file':
                        extracted = extractAfterColon(label);
                        if (extracted && extracted !== '文件') return truncate(basename(extracted), 60);
                        return '文件';
                    case 'web_search':
                        if (hasColon(label)) {
                            extracted = extractAfterColon(label);
                            if (extracted && extracted !== '内容') return '搜索了 ' + truncate(extracted, 60);
                        }
                        return '使用了联网搜索';
                    case 'web_fetch':
                        if (hasColon(label)) {
                            extracted = extractAfterColon(label);
                            if (extracted && extracted !== '网页') return '抓取了 ' + truncate(extracted, 60) + ' 网页';
                        }
                        return '抓取了网页';
                    case 'execute_command':
                        return '执行了系统命令';
                    case 'execute_python':
                        return '执行了 Python 代码';
                    case 'browser_automation_control':
                        return '操作了内置浏览器';
                    case 'interaction_request_action':
                        return '等待用户接管浏览器';
                    default:
                        // 后端部分 status 事件没有 tool_name，根据 label 生成可读摘要，永不显示"未知"
                        if (!toolName) {
                            if (label.indexOf('联网搜索') === 0) {
                                var q = hasColon(label) ? extractAfterColon(label) : '';
                                return q && q !== '内容' ? '搜索了 ' + truncate(q, 60) : '使用了联网搜索';
                            }
                            if (label.indexOf('网页爬虫') === 0) return detail ? '运行了网页爬虫：' + truncate(detail, 50) : '运行了网页爬虫';
                            if (label.indexOf('来点音乐') !== -1) return '使用了来点音乐';
                            if (label.indexOf('Code-Agent') !== -1) return truncate(label, 60);
                            if (label === '命令执行') return '执行了系统命令';
                            if (label === 'Python执行') return '执行了 Python 代码';
                            if (label === 'Agent 已终止') return 'Agent 已终止';
                            if (label) return '运行了 ' + truncate(label, 60);
                            if (detail) return '运行了 ' + truncate(detail, 60);
                        }
                        return '使用了 ' + (toolName || '工具') + ' 工具';
                }
            }
            // 根据 tool_name / label / detail 归一化出用于计数的工具类别
            function getToolCategory(toolName, label, detail) {
                label = (label || '').trim();
                if (toolName) return toolName;
                if (label.indexOf('联网搜索') === 0) return 'web_search';
                if (label.indexOf('网页爬虫') === 0) return 'web_crawler';
                if (label.indexOf('来点音乐') !== -1) return 'play_music';
                if (label.indexOf('Code-Agent') !== -1) return 'code_agent';
                if (label === '命令执行') return 'command_execution';
                if (label === 'Python执行') return 'python_execution';
                if (label === 'Agent 已终止') return 'agent_terminated';
                return label || detail || 'other';
            }
            // 过程行的动作短语：取 label 冒号前的部分（"编辑文件: app.js" → "编辑文件"），
            //   无冒号时退回 label 原文，仍为空时用 getOperationSummary 兜底。
            function getRowActionText(toolName, label, detail) {
                var raw = (label || '').trim();
                if (raw) {
                    var cut = raw.search(/[：:]/);
                    if (cut > 0) return raw.substring(0, cut).trim();
                    return raw;
                }
                return getOperationSummary(toolName, label, detail);
            }
            // ========== 工具类型 SVG 图标（来自 SVG/1.txt） ==========
            // 4 个工具图标：thinking(深度思考) / read_file(查看文件) / create_file(编辑文件) / browser_automation_control(浏览器自动化)
            // 原始 width="200" height="200" 改为通过 size 参数控制；显式 fill 改为 currentColor 以支持状态着色（灰/红）。
            function getToolIcon(toolName, size) {
                size = size || 16;
                // ICON_THINKING：深度思考
                var ICON_THINKING = '<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5496" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M433.493333 548.693333c19.626667 41.386667 68.693333 60.16 110.506667 41.813334a85.12 85.12 0 0 0 44.8-115.2 85.034667 85.034667 0 0 0-117.333333-38.826667c-40.96 20.906667-57.6 70.826667-37.973334 112.213333z" p-id="5497"></path><path d="M831.573333 511.146667c75.946667-136.533333 83.626667-274.773333 18.773334-339.626667-64.853333-64.426667-203.946667-56.746667-340.48 19.2-136.106667-74.666667-273.92-81.92-338.346667-17.493333-64.426667 64.426667-57.173333 201.813333 17.92 337.92-75.093333 135.68-82.346667 273.493333-17.92 337.493333 20.053333 20.053333 47.36 34.133333 78.933333 40.96 70.826667 14.933333 162.56-5.546667 258.986667-58.453333 97.28 53.76 190.293333 75.093333 261.546667 60.16 31.146667-6.826667 58.88-20.906667 78.933333-40.96 20.053333-20.053333 34.56-47.36 40.96-78.506667 15.36-71.253333-5.973333-163.84-59.733333-260.693333h0.426666zM232.533333 233.813333c26.026667-26.026667 73.813333-28.586667 142.506667-8.106666 17.066667 5.12 34.133333 11.52 51.2 18.773333-34.133333 25.173333-66.56 53.333333-97.28 84.053333-31.573333 31.146667-60.16 64.426667-85.76 98.986667-7.253333-17.066667-13.653333-34.133333-18.773333-51.626667-20.906667-68.693333-18.346667-116.48 8.106666-142.506666v0.426666z m142.506667 562.346667c-69.12 20.906667-116.48 17.92-142.506667-8.106667-26.026667-26.026667-28.586667-73.386667-8.106666-142.506666 5.12-17.066667 11.52-34.133333 18.773333-51.2a886.613333 886.613333 0 0 0 182.613333 183.04c-17.066667 7.253333-34.133333 13.653333-51.2 18.773333h0.426667z m14.506667-163.413333c-40.106667-40.106667-73.813333-80.64-100.693334-122.026667 26.88-41.386667 60.586667-81.92 100.693334-122.026667 39.68-39.68 79.786667-72.533333 120.32-99.413333 41.386667 26.88 82.346667 60.586667 122.453333 100.693333 39.68 39.68 72.96 79.786667 99.84 120.32-26.88 40.533333-60.16 80.64-99.84 120.32-40.533333 40.106667-81.066667 73.813333-122.453333 100.693334-40.533333-26.88-80.64-59.733333-120.32-99.413334v0.853334z m399.786666 157.013333c-26.026667 26.026667-73.813333 28.586667-142.506666 8.106667-17.92-5.546667-35.84-11.946667-53.76-19.626667 34.986667-25.6 68.266667-54.186667 99.84-85.76 31.146667-30.72 59.306667-63.573333 84.48-97.706667 7.68 17.493333 14.08 35.413333 19.626666 53.333334 20.906667 68.693333 18.346667 116.48-8.106666 142.506666l0.426666-0.853333z m8.106667-415.146667c-5.546667 17.92-11.946667 35.84-19.626667 53.333334-25.173333-34.133333-53.76-66.986667-84.906666-98.133334-31.573333-31.573333-64.853333-60.16-99.84-85.76 17.92-7.68 35.84-14.506667 53.76-20.053333 69.12-20.906667 116.48-17.92 142.506666 8.106667 26.026667 26.026667 28.586667 73.386667 8.106667 142.506666z" p-id="5498"></path></svg>';
                // ICON_READ_FILE：查看文件
                var ICON_READ_FILE = '<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1681" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M912.677 834.414l-74.46-72.12c47.69-66.705 32.183-159.45-34.523-207.14-66.707-47.689-159.452-32.183-207.14 34.524s-32.184 159.451 34.523 207.14c49.444 35.255 115.419 37.01 166.473 4.243l76.068 73.728c11.41 10.532 29.111 9.8 39.644-1.61 10.093-11.117 9.8-28.086-0.585-38.765z m-195.292-65.975c-51.2 0-92.745-41.399-92.745-92.599a92.55 92.55 0 0 1 14.043-49.006c27.063-43.447 84.261-56.759 127.708-29.696s56.759 84.26 29.696 127.708c-16.97 27.063-46.665 43.593-78.702 43.593z" p-id="1682"></path><path d="M574.903 824.759H216.21c-35.108 0-63.488-28.526-63.488-63.488V216.21c0-35.11 28.526-63.489 63.488-63.489h435.932c35.108 0 63.488 28.38 63.488 63.488v241.664c0 16.384 13.312 29.843 29.842 29.843 16.384 0 29.696-13.312 29.696-29.843V216.21c-0.146-67.876-55.15-123.026-123.026-123.026H216.21c-67.876 0.146-123.026 55.15-123.026 123.026v545.06c0 67.877 55.15 123.027 123.026 123.027h358.693c16.384 0 29.842-13.312 29.842-29.696 0-16.53-13.458-29.842-29.842-29.842z" p-id="1683"></path><path d="M281.161 571.246c-16.384 0-29.842 13.312-29.842 29.842 0 16.384 13.312 29.842 29.842 29.842H471.48c16.384 0 29.842-13.312 29.842-29.842s-13.312-29.842-29.842-29.842H281.16z m0-261.998h120.832c16.384 0 29.842-13.312 29.842-29.696s-13.312-29.842-29.696-29.842H281.307c-16.384 0-29.696 13.312-29.696 29.842-0.292 16.384 13.02 29.696 29.55 29.696z m327.973 122.295c0-16.384-13.312-29.842-29.696-29.842H281.16c-16.384 0-29.842 13.312-29.842 29.842 0 16.384 13.312 29.842 29.842 29.842h298.13c16.384-0.146 29.696-13.458 29.843-29.842z" p-id="1684"></path></svg>';
                // ICON_CREATE_FILE：编辑文件
                var ICON_CREATE_FILE = MoonYaIcons.icon('edit').replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
                // ICON_BROWSER：浏览器自动化
                var ICON_BROWSER = '<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1761" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M276.3 795.7c-0.3 0-6.9-0.4-6.9-0.4 0.1-0.3 3.9 0.6 0.1 0-1.1-0.2-2.2-0.4-3.3-0.7-2.2-0.5-4.3-1.1-6.4-1.8-0.6-0.2-2.1-0.5-2.5-0.9 2.3 1 2.5 1.1 0.7 0.3l-1.2-0.6c-2-0.9-3.9-2-5.7-3.1-1-0.6-6.9-4.3-2.8-1.7-3.5-2.3-6.6-5.8-9.4-9-0.2-0.2-2.6-3.6-1-1.2 1.6 2.4-0.7-1.2-0.9-1.4-1.2-1.8-2.3-3.7-3.4-5.6-0.4-0.8-0.8-1.6-1.2-2.3-0.1-0.3-1.6-4.2-0.7-1.5 0.9 2.8-0.4-1.3-0.5-1.6-0.4-1.3-0.8-2.5-1.2-3.8-0.6-2.2-1-4.4-1.4-6.6-0.7-3.5-0.1 0.4 0.1 0.7-0.4-0.8-0.2-2.5-0.3-3.4-0.1-1.2-0.1-2.4-0.1-3.7-0.1-6.5 0-13.1 0-19.6V615.5 460.3 325.8v-39.1-9.1-1.4c0-1 0-1.9 0.1-2.8 0-0.9 0.1-1.8 0.2-2.8 0.2-4.5-0.6 2.8-0.1 0 0.4-2 0.7-4 1.2-5.9 0.5-2 1.1-6.1 2.4-7.6-0.2 0.3-1.8 3.7-0.3 0.7 0.5-1 0.9-2 1.4-2.9 0.9-1.7 1.9-3.4 2.9-5.1 0.5-0.8 1.4-2.7 2.2-3.2-0.3 0.2-2.6 3.1-0.4 0.6 1.7-2 3.4-3.9 5.3-5.7 1.4-1.4 3-2.5 4.4-3.9 1.9-1.8-3.6 2.3 0 0.1 0.7-0.5 1.4-1 2.2-1.4 1.8-1.2 3.7-2.3 5.7-3.2 1-0.5 2-0.9 3-1.4 1.2-0.5 0.8-0.4-1.3 0.5 0.8-0.3 1.7-0.6 2.5-0.9 1.7-0.6 3.4-1.1 5.1-1.5 1.2-0.3 5.7-0.5 6.6-1.3-1.3 1.3-3 0.3 0 0.1 1.2-0.1 2.3-0.1 3.5-0.2H747.7c1.4 0 2.9 0 4.3 0.1 0.4 0 2.2 0 2.7 0.2l-2.1-0.3c0.9 0.1 1.8 0.3 2.7 0.4 2.2 0.4 4.4 0.9 6.5 1.6 1.1 0.3 7.8 2.5 3.2 0.9 2 0.7 4 1.9 5.9 2.9 1.9 1.1 3.7 2.3 5.5 3.5 0.7 0.5 2.9 1.8-0.5-0.5 1.1 0.7 2 1.7 3 2.5 1.6 1.4 3.2 3 4.6 4.5l2.1 2.4c1.2 1.3 2.7 1.7 0-0.1 2.6 1.6 4.7 7.4 6 10.1l0.6 1.2c0.8 1.8 0.7 1.6-0.3-0.7 0.4 0.4 0.8 2.1 0.9 2.5 0.7 2.1 1.3 4.2 1.8 6.4 0.2 0.9 0.4 1.8 0.6 2.6 0.1 0.4 0.2 0.9 0.2 1.3 0.3 2 0.3 1.8-0.1-0.7 0.8 1.7 0.3 5.1 0.4 6.9 0.1 9.4 8.2 18.4 18 18 9.7-0.4 18.1-7.9 18-18-0.5-44.9-36.2-82.1-81.2-83.9-6.3-0.3-12.7-0.1-19.1-0.1H285.6c-15.5 0-30.2 1.5-44.7 7.9-30.1 13.4-48.5 44.7-48.6 77.2V743.7c0 24.6 8.4 48.5 27 65.4 15.7 14.3 35.8 22.1 57 22.4 9.4 0.1 18.4-8.3 18-18-0.4-9.7-7.9-17.7-18-17.8z" fill="currentColor" p-id="1762"></path><path d="M276.3 322.6H588.6c14.4 0 29 0.4 43.4 0h0.6c9.4 0 18.4-8.3 18-18-0.4-9.8-7.9-18-18-18H320.3c-14.4 0-29-0.4-43.4 0h-0.6c-9.4 0-18.4 8.3-18 18 0.5 9.8 7.9 18 18 18zM210.3 409.3h529.2c24.4 0 48.8 0.6 73.1 0h1c9.4 0 18.4-8.3 18-18-0.4-9.8-7.9-18-18-18H284.4c-24.4 0-48.8-0.6-73.1 0h-1c-9.4 0-18.4 8.3-18 18 0.5 9.8 7.9 18 18 18zM719.4 322.6c9.4 0 18.4-8.3 18-18-0.4-9.8-7.9-18-18-18-9.4 0-18.4 8.3-18 18 0.4 9.8 7.9 18 18 18zM735.4 657.2c0 3-0.1 6-0.3 9.1-0.1 1.4-0.2 2.7-0.4 4.1 0 0.2-0.4 1.9-0.2 2-0.6-0.6 0.6-3.8-0.1-0.1-1 5.8-2.3 11.4-4.1 17-0.8 2.5-1.4 5.9-2.9 8.1 0 0 1.4-3.1 0.5-1.3-0.3 0.6-0.5 1.2-0.8 1.8-0.7 1.6-1.5 3.2-2.3 4.7-2.6 5.1-5.5 9.9-8.8 14.6-0.4 0.6-3.2 4.4-1.7 2.4 1.5-1.9-1 1.2-1.4 1.7-1.9 2.3-4 4.6-6.1 6.8-2 2-4 4-6.1 5.9-1 0.9-2 1.7-3 2.6-0.6 0.5-4.1 3.3-2.2 1.9 1.9-1.4-1.7 1.2-2.4 1.7-1.1 0.8-2.2 1.5-3.2 2.2-2.6 1.7-5.2 3.3-7.9 4.7-2.5 1.4-5 2.7-7.6 3.9-0.6 0.3-4.4 1.8-2.1 0.9 2.2-0.8-2 0.8-2.8 1-5.7 2.1-11.5 3.7-17.4 4.9-1.3 0.3-2.7 0.5-4 0.7-0.2 0-2 0.2-2 0.3 0.2-0.5 3.5-0.4 0.7-0.1-3 0.3-6 0.6-9 0.7-6.3 0.3-12.5 0-18.7-0.7-3.6-0.4 2.9 0.5-0.6-0.1-1.6-0.3-3.1-0.5-4.7-0.8-2.9-0.6-5.7-1.3-8.5-2-2.8-0.8-5.5-1.7-8.3-2.6-1.4-0.5-3.1-0.8-4.3-1.7 0 0 3.1 1.4 1.3 0.5-0.8-0.4-1.6-0.7-2.4-1.1-5.4-2.5-10.5-5.4-15.5-8.6-2.2-1.4-4.3-3-6.4-4.5 2.9 2.1 0.3 0.2-1-0.8-1.2-1-2.3-2-3.5-3-4.4-3.9-8.4-8.2-12.2-12.7-0.4-0.5-2.9-3.7-1.4-1.7s-0.9-1.3-1.3-1.8c-1.8-2.5-3.4-5-5-7.7-1.5-2.4-2.9-4.9-4.1-7.5-0.6-1.2-1.2-2.4-1.7-3.5-0.4-0.8-0.7-1.6-1.1-2.4-0.9-2.1-0.4-0.3 0.3 0.6-1.4-2-2-5.2-2.7-7.5-1-3-1.8-6-2.6-9-0.7-2.8-1.3-5.7-1.8-8.6 0-0.2-0.2-2-0.3-2 0.1 0 0.4 3.5 0.2 1.4-0.2-1.8-0.4-3.6-0.5-5.5-0.4-6-0.4-12.1 0-18.1 0.1-1.6 0.3-3.2 0.5-4.8 0.4-3.6-0.5 2.9 0.1-0.6 0.5-3.1 1.1-6.2 1.9-9.3 0.7-2.8 1.5-5.6 2.4-8.4 0.8-2.5 1.5-6 2.9-8.1-0.3 0.4-1.7 3.7-0.3 0.6 0.3-0.6 0.5-1.2 0.8-1.8 0.6-1.2 1.1-2.4 1.7-3.6 1.4-2.7 2.9-5.4 4.4-8 1.5-2.4 3-4.8 4.6-7.1 0.8-1.1 1.6-2.1 2.3-3.2-2.3 3.3 0.3-0.3 1.2-1.5 3.6-4.3 7.6-8.4 11.8-12.2 1-0.9 2-1.7 3-2.6 0.7-0.6 4.1-3.3 2.2-1.9-2 1.5 1.3-0.9 1.8-1.3 1.4-1 2.9-2 4.3-2.9 4.8-3.1 9.8-5.9 14.9-8.2 0.6-0.3 4.4-1.8 2.1-0.9-2.4 0.9 2.1-0.8 2.8-1 2.9-1.1 5.9-2 8.9-2.9 2.6-0.7 5.2-1.4 7.8-1.9 1.5-0.3 3.1-0.6 4.7-0.9 0.2 0 2-0.2 2-0.3-0.1 0.3-3.7 0.4-0.7 0.1 6.2-0.6 12.5-0.9 18.7-0.7 2.8 0.1 5.5 0.3 8.3 0.6 0.6 0.1 3.6 0.5 1 0.1-2.4-0.4-0.1 0 0.3 0.1 1.6 0.3 3.1 0.5 4.7 0.8 5.9 1.2 11.7 2.8 17.4 4.9 1.1 0.4 2.7 0.7 3.7 1.4 0 0-3.1-1.4-1.3-0.5 0.6 0.3 1.2 0.5 1.8 0.8 2.8 1.3 5.5 2.7 8.2 4.1 2.5 1.4 4.9 2.8 7.3 4.4 1.1 0.7 2.2 1.4 3.3 2.2l2.1 1.5c0.4 0.3 2.8 2 0.8 0.6-1.9-1.5 1.2 1 1.7 1.4 1.2 1 2.3 2 3.5 3 2.1 1.9 4.1 3.8 6.1 5.9 2 2 3.9 4.1 5.7 6.3 0.8 1 1.6 2 2.5 3-2.9-3.5 0.4 0.7 1.1 1.6 3.3 4.6 6.2 9.5 8.8 14.6 0.7 1.4 1.4 2.8 2 4.1 0.3 0.6 1.8 4.4 0.9 2.1-0.9-2.4 0.8 2.3 1 2.8 0.5 1.5 1 2.9 1.5 4.4 1.9 5.8 3.2 11.7 4.2 17.7 0.6 3.5-0.3-2.9 0.1 0.6 0.1 1.4 0.3 2.7 0.4 4.1 0.4 3.5 0.5 6.7 0.5 10 0.1 9.4 8.2 18.4 18 18 9.7-0.4 18.1-7.9 18-18-0.3-58.3-37.2-110.1-91.7-130.3-53.1-19.7-116.6-2.6-152.5 41.1-18.8 22.8-29.9 50-32.3 79.5-2.2 28 4.8 56.9 19.3 80.9 30.3 50.3 89.5 75.6 146.8 64.4 54.5-10.7 99.8-57.2 108.3-112.2 1.2-7.8 2-15.5 2.1-23.4 0.1-9.4-8.3-18.4-18-18-9.8 0.4-17.9 7.9-18 18z" fill="currentColor" p-id="1763"></path><path d="M813.7 639.2h-60.2c-9.4 0-18.4 8.3-18 18 0.4 9.8 7.9 18 18 18h60.2c9.4 0 18.4-8.3 18-18-0.5-9.8-7.9-18-18-18zM512.5 639.2h-60.2c-9.4 0-18.4 8.3-18 18 0.4 9.8 7.9 18 18 18h60.2c9.4 0 18.4-8.3 18-18-0.4-9.8-7.9-18-18-18zM707.8 491.6c-10 17.4-20.1 34.8-30.1 52.2-4.7 8.2-2.2 20.1 6.5 24.6 8.6 4.5 19.6 2.3 24.6-6.5 10-17.4 20.1-34.8 30.1-52.2 4.7-8.2 2.2-20.1-6.5-24.6-8.6-4.5-19.6-2.2-24.6 6.5zM557.2 752.4c-10 17.4-20.1 34.8-30.1 52.2-4.7 8.2-2.2 20.1 6.5 24.6 8.6 4.5 19.6 2.3 24.6-6.5 10-17.4 20.1-34.8 30.1-52.2 4.7-8.2 2.2-20.1-6.5-24.6-8.6-4.5-19.6-2.2-24.6 6.5zM527.1 509.8c10 17.4 20.1 34.8 30.1 52.2 4.7 8.2 16.5 11.7 24.6 6.5 8.2-5.3 11.5-15.9 6.5-24.6-10-17.4-20.1-34.8-30.1-52.2-4.7-8.2-16.5-11.7-24.6-6.5-8.3 5.3-11.6 15.8-6.5 24.6zM677.7 770.6c10 17.4 20.1 34.8 30.1 52.2 4.7 8.2 16.5 11.7 24.6 6.5 8.2-5.3 11.5-15.9 6.5-24.6-10-17.4-20.1-34.8-30.1-52.2-4.7-8.2-16.5-11.7-24.6-6.5-8.3 5.3-11.6 15.9-6.5 24.6zM795.7 276.3v236.2c0 9.4 8.3 18.4 18 18 9.8-0.4 18-7.9 18-18v-79.8-127.2-29.2c0-9.4-8.3-18.4-18-18-9.8 0.5-18 7.9-18 18zM451.7 795.7H276.4c-9.4 0-18.4 8.3-18 18 0.4 9.8 7.9 18 18 18h175.3c9.4 0 18.4-8.3 18-18-0.5-9.8-7.9-18-18-18z" fill="currentColor" p-id="1764"></path></svg>';
                // ICON_WEB_SEARCH：搜索
                var ICON_WEB_SEARCH = '<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="5302" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M453.056 844.896C238.176 844.896 64 670.08 64 454.4 64 238.816 238.176 64 453.056 64s389.088 174.816 389.088 390.432c0 101.248-38.4 193.504-101.408 262.88l176.32 177.696a38.272 38.272 0 0 1 0 53.888c-14.816 14.944-38.432 15.2-53.248 0.288l-179.36-180.8a386.432 386.432 0 0 1-231.36 76.48z m0-57.856c183.04 0 331.424-148.896 331.424-332.608 0-183.68-148.384-332.576-331.424-332.576S121.632 270.72 121.632 454.4c0 183.68 148.384 332.608 331.424 332.608z" p-id="5303"></path></svg>';
                // ICON_TERMINAL：命令行/CLI（复用 execution_code 块的终端图标）
                var ICON_TERMINAL = '<svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M499.712 481.792l-128-128c-16.896-16.384-44.032-15.872-60.416 1.024-15.872 16.384-15.872 42.496 0 59.392L409.088 512l-97.792 97.792c-16.896 16.384-17.408 43.52-1.024 60.416s43.52 17.408 60.416 1.024l1.024-1.024 128-128c16.384-16.896 16.384-43.52 0-60.416z"/><path d="M682.496 597.504h-128c-23.552 0-42.496 18.944-42.496 42.496 0 23.552 18.944 42.496 42.496 42.496h128c23.552 0 42.496-18.944 42.496-42.496s-18.944-42.496-42.496-42.496z"/><path d="M810.496 128H213.504c-70.656 0-128 57.344-128 128v512c0 70.656 57.344 128 128 128h597.504c70.656 0 128-57.344 128-128V256c-0.512-70.656-57.856-128-128.512-128z m0 682.496H213.504c-23.552 0-42.496-18.944-42.496-42.496V256c0-23.552 18.944-42.496 42.496-42.496h597.504c23.552 0 42.496 18.944 42.496 42.496v512c0 23.552-19.456 42.496-43.008 42.496z"/></svg>';
                var icons = {
                    thinking: ICON_THINKING,
                    read_file: ICON_READ_FILE,
                    read_skill: ICON_READ_FILE,
                    list_files: ICON_READ_FILE,
                    create_file: ICON_CREATE_FILE,
                    edit_file: ICON_CREATE_FILE,
                    open_file: ICON_READ_FILE,
                    copy_file: ICON_READ_FILE,
                    move_file: ICON_READ_FILE,
                    delete_file: ICON_CREATE_FILE,
                    download_file: ICON_READ_FILE,
                    browser_automation_control: ICON_BROWSER,
                    computer_use_tool: MoonYaIcons.icon('computer'),
                    computer_observe: MoonYaIcons.icon('computer'),
                    computer_interact: MoonYaIcons.icon('computer'),
                    web_search: ICON_WEB_SEARCH,
                    web_crawler: ICON_BROWSER,
                    web_fetch: ICON_WEB_SEARCH,
                    system_status: ICON_READ_FILE,
                    execute_command: ICON_TERMINAL,
                    execute_python: ICON_TERMINAL,
                    // Agent Runtime 的工具名（harness_api.php 的 runtimeToolLabel 同一套 key）：
                    //   不映射就会掉进 fallback，过程行的前导图标变成转圈/对勾，与 DSH 的
                    //   工具图标行不一致。
                    view_directory: ICON_READ_FILE,
                    glob: ICON_READ_FILE,
                    grep: ICON_WEB_SEARCH,
                    get_command_status: ICON_TERMINAL,
                    stop_command: ICON_TERMINAL,
                    get_diagnostics: ICON_READ_FILE,
                    find_references: ICON_WEB_SEARCH,
                    goto_definition: ICON_READ_FILE,
                    todo_write: ICON_CREATE_FILE,
                    plan_write: ICON_CREATE_FILE,
                    goal_write: ICON_CREATE_FILE,
                    read_image: createWorkflowImageIcon(size),
                    view_image: createWorkflowImageIcon(size),
                    cu_screenshot: createWorkflowImageIcon(size),
                    ba_screenshot: createWorkflowImageIcon(size)
                };
                return icons[toolName] || '';
            }

            // 工具行摘要：用**调用参数**描述这一步在做什么（DSH 的 ToolRow 摘要就是
            //   参数的短描述）。不要把结果 JSON 原样塞进这一行——13px/24px 的一行放
            //   `{"success":true,...}` 等于没有信息，完整结果在右侧工作日志里。
            function describeToolCall(toolName, args) {
                var a = (args && typeof args === 'object') ? args : {};
                function cut(s, max) {
                    s = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
                    return s.length > max ? s.substring(0, max) + '...' : s;
                }
                function pick() {
                    for (var i = 0; i < arguments.length; i++) {
                        if (a[arguments[i]]) return a[arguments[i]];
                    }
                    return '';
                }
                switch (toolName) {
                    case 'read_file':
                    case 'create_file':
                    case 'edit_file':
                    case 'delete_file':
                    case 'view_directory':
                        return cut(pick('path', 'file_path', 'directory', 'dir', 'filename'), 90);
                    case 'glob':
                        return cut(pick('pattern', 'glob'), 90);
                    case 'grep':
                        var pattern = cut(pick('pattern', 'query', 'regex'), 60);
                        var where = cut(pick('path', 'directory'), 40);
                        return pattern + (where ? ' · ' + where : '');
                    case 'execute_command':
                        return cut(pick('command', 'cmd'), 110);
                    case 'find_references':
                    case 'goto_definition':
                        return cut(pick('symbol', 'name'), 60);
                    case 'get_command_status':
                    case 'stop_command':
                        return cut(pick('task_id', 'id', 'command'), 60);
                    case 'get_diagnostics':
                        return cut(pick('path', 'file_path'), 90);
                    case 'browser_automation_control':
                        // 与 DSH 的 ToolRow 摘要同风格：动作在前，目标在后。
                        var baAction = cut(pick('action'), 20);
                        var baTarget = cut(pick('url', 'text', 'element_id', 'selector', 'tab_id', 'key'), 70);
                        return baTarget ? baAction + ' · ' + baTarget : baAction;
                    case 'interaction_request_action':
                        return cut(pick('display_message', 'type'), 110);
                    default:
                        var keys = Object.keys(a);
                        if (!keys.length) return '';
                        return cut(keys.map(function(k) {
                            var v = a[k];
                            if (v && typeof v === 'object') v = JSON.stringify(v);
                            return k + '=' + v;
                        }).join(' '), 110);
                }
            }
            // 生成一条过程行的状态图标（与既有工具图标体系保持一致）
            function makeProcessRowIcon(toolName, status, args) {
                if (codexActivityKind(toolName, args) === 'image') return createWorkflowImageIcon(16);
                var toolSvg = getToolIcon(toolName, 16);
                if (toolSvg) return toolSvg;
                if (status === 'executing' || status === 'thinking') {
                    return createWorkflowEmptyIcon(16, '#888888');
                }
                if (status === 'failure' || status === 'error') {
                    return createWorkflowCrossIcon(16, '#e53935');
                }
                if (status === 'stopped') {
                    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>';
                }
                return createWorkflowCheckIcon(16, '#9a9a9a');
            }

        // ========== 主对话过程区（照搬 DSH 对话区）==========
        // DSH 的对话区把一轮的全部过程收在一行表头下面：
        //   [turn-process 表头：本轮用时 X · N 次工具调用 · M 条消息]   ← TurnProcessNodeView，默认收起
        //     ├ 思考行：[图标] gap6 [思考] gap8 [2px 圆点] gap8 [首行摘要截断]   ← ReasoningRow
        //     └ 工具行：[图标] gap6 [标题 13/24] gap8 [2px 圆点] gap8 [参数摘要截断] ← ToolRow
        //   对话流里默认只露出这一行表头与最终交付正文，思考/工具调用全部折叠在表头下面，
        //   点表头才展开。右侧工作日志仍是完整详情的权威来源，这里只做对话流里那套紧凑行。
        // 顺序固定是「用户消息 → 过程区 → 回复正文」（见 placeTurnProcess）。

        // 过程区表格：turnKey → { container, header, body, toolRows, reasoningRows,
        //   toolCallCount, messageCount, startedAt, elapsedMs }
        //   按 DSH 的 turn-process 语义，一轮对话对应一个过程区。
        const turnProcessNodes = new Map();

        // 一轮对话的过程区宿主：插在该轮回复气泡之前，形成 DSH 的
        //   "表头在上、过程折叠在中间、交付正文在下" 版式。
        function turnProcessContainer(turnKey, timestamp) {
            let record = turnProcessNodes.get(turnKey);
            if (record && record.sequence.host.isConnected) return record;
            window.__moonyaDshTurnProcess = true;
            let message = lastReplyNode(messagesContainer);
            // A reply from an earlier turn cannot become the new turn's host.
            if (!message || (message.dataset.processTurn && message.dataset.processTurn !== turnKey)) {
                message = document.createElement('div'); message.className = 'message ai';
                messagesContainer.appendChild(message);
            }
            let content = message.querySelector(':scope > .message-content');
            if (!content) { content = document.createElement('div'); content.className = 'message-content'; message.appendChild(content); }
            content.querySelectorAll(':scope > .turn-process-header').forEach(node => node.remove());
            message.dataset.processTurn = turnKey;
            const sequence = MoonYaProcessUI.sequence(content, turnKey, {
                icon: makeProcessRowIcon, renderTool: renderCodexToolDetail,
                pathBase: getConversationRuntime()?.workspaceIdentity === '__default__' ? '' : getConversationRuntime()?.workspaceIdentity || ''
            });
            record = Object.assign(new CodexTurnTrace(turnKey,
                Number(timestamp) || Number(window.__moonyaTurnStartedAt) || Date.now()), {
                sequence, message, toolRows: new Map(), reasoningRows: sequence.reasons,
                reasoningBlocks: sequence.texts, activityGroups: new Map(), toolCallCount: 0, elapsedMs: 0
            });
            // Legacy approval/system renderers still use the current segment body.
            for (const field of ['container', 'header', 'label', 'body']) {
                Object.defineProperty(record, field, { get: () => MoonYaProcessUI.ensure(sequence)[field] });
            }
            const segment = MoonYaProcessUI.ensure(sequence);
            segment.container.dataset.turnStartedAt = new Date(record.startedAt).toISOString();
            turnProcessNodes.set(turnKey, record);
            MoonYaProcessUI.beginDuration(message, record.startedAt);
            if (window.MoonYaSubagentChat) window.MoonYaSubagentChat.refresh();
            return record;
        }

        // 当前轮次的回复节点 = 容器里最后一个回复节点。Agent 轮次的正文有两种形态：
        //   .message.ai（legacy content 渲染的 Codex 风格气泡）
        //   article.team-agent-message（presentation 卡片）
        //   只认前者的话，Agent 轮次里过程区/收尾行找不到锚点，会 append 到末尾交错错位。
        //   过程区与收尾行本身不算回复节点，跳过。
        function lastReplyNode(container) {
            if (!container) return null;
            const replies = [];
            for (const child of Array.from(container.children)) {
                const c = child.classList;
                if (!c) continue;
                if (c.contains('turn-process') || c.contains('turn-tail')) continue;
                if ((c.contains('message') && c.contains('ai')) || c.contains('team-agent-message')) {
                    replies.push(child);
                }
            }
            return replies.length ? replies[replies.length - 1] : null;
        }

        // 过程区在对话里的位置：**用户消息之后、AI 回复之前**（DSH 的轮次顺序）。
        //   既不能 appendChild 到末尾（思考跑到输出下面），
        //   也不能插到整轮最前（思考跑到用户消息上面）。
        function placeTurnProcess(container, processEl) {
            // Segments remain at their original position inside the reply.
            if (window.MoonYaSubagentChat) window.MoonYaSubagentChat.refresh();
        }

        // Codex disclosure label: show a live state while running and replace
        // it with elapsed time after completion. There is no separate tail row.
        function updateTurnProcessLabel(record) {
            if (record) record.sequence.segments.forEach(MoonYaProcessUI.refresh);
        }

        function revealTurnProcess(record) { updateTurnProcessLabel(record); }

        // （思考正文不再单独直写正文流：DSH 对每个 reasoning block 只渲染一个
        //   ReasoningRow，过程区里的思考行就是唯一那份，避免同一份思考显示两处。）

        // 过程区表头就是折叠开关：点它展开/收起下面的思考行与工具行。
        //   用 document 事件委托，而不是给每个表头绑监听：历史回放出来的过程区
        //   是保存时存下的静态 HTML（script-1c-save.php 存 outerHTML），
        //   没有机会绑监听，只有委托才能让回放里的过程区同样可展开。
        //   不用 closest('.turn-process > .turn-process-header')：子选择器进 closest
        //   是新内核特性，旧 CEF/WebView 不支持会直接展不开。
        function toggleTurnProcessArea(header) {
            if (!header) return;
            const body = header.parentElement.querySelector(':scope > .turn-process-body');
            MoonYaProcessUI.disclose(header, body, header.getAttribute('aria-expanded') !== 'true');
        }

        function toggleReasoningRow(row) {
            if (!row) return;
            const open = row.getAttribute('aria-expanded') !== 'true';
            row.dataset.expanded = open ? '1' : '0';
            MoonYaProcessUI.disclose(row, row.nextElementSibling, open);
        }

        // 表头点击统一入口：主对话过程区（.turn-process 里的表头）走
        //   toggleTurnProcessArea，气泡内旧表头（非 Agent 模式）走 toggleTurnProcess。
        function activateTurnProcessHeader(header) {
            if (!header || !header.parentNode) return;
            const area = header.parentNode;
            if (area.classList && area.classList.contains('turn-process')) {
                toggleTurnProcessArea(header);
            } else {
                toggleTurnProcess(header);
            }
        }

        // 表头与思考行都走 document 事件委托，不给单个元素绑监听：
        //   历史回放出来的过程区是保存的静态 HTML，没有机会绑监听，只有委托才管得住。
        document.addEventListener('click', function(e) {
            if (e.moonyaProcessHandled) return;
            const target = e.target;
            if (!target || !target.closest) return;
            const viewedImageTile = target.closest('.codex-viewed-image-tile');
            if (viewedImageTile) {
                const viewedImage = viewedImageTile.querySelector('img');
                if (viewedImage && viewedImage.src) openDetailLightbox(viewedImage.src);
                return;
            }
            const fileLink = target.closest('.codex-file-link');
            if (fileLink) {
                e.stopPropagation();
                const path = fileLink.getAttribute('data-file-path');
                if (path) openArtifactNative(path);
                return;
            }
            const groupHeader = target.closest('.codex-activity-header');
            if (groupHeader) {
                const group = groupHeader.closest('.codex-activity-group');
                const open = group && group.getAttribute('data-open') === '1';
                if (group) {
                    if (open) group.removeAttribute('data-open');
                    else group.setAttribute('data-open', '1');
                    groupHeader.setAttribute('aria-expanded', open ? 'false' : 'true');
                }
                return;
            }
            const toolMain = target.closest('.codex-tool-main');
            if (toolMain) {
                const toolRow = toolMain.closest('.tool-row');
                const detail = toolRow && toolRow.querySelector(':scope > .codex-tool-detail');
                if (detail) {
                    const open = toolMain.getAttribute('aria-expanded') === 'true';
                    if (open) toolRow.removeAttribute('data-open');
                    else toolRow.setAttribute('data-open', '1');
                    MoonYaProcessUI.disclose(toolMain, detail, !open);
                }
                return;
            }
            const header = target.closest('.turn-process-header');
            if (header) {
                activateTurnProcessHeader(header);
                return;
            }
            const row = target.closest('.reasoning-row');
            if (row) toggleReasoningRow(row);
        });

        // 主对话过程区的表头是原生 <button>，回车/空格自带 click；
        //   气泡内旧表头是 <div role="button">，必须自己接键盘。
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
            if (e.moonyaProcessHandled) return;
            const target = e.target;
            if (!target || !target.closest) return;
            if (target.closest('.codex-file-link, .codex-tool-main, .reasoning-row')) {
                e.preventDefault();
                target.click();
                return;
            }
            if (target.tagName === 'BUTTON') return;
            const header = target.closest('.turn-process-header');
            if (!header) return;
            e.preventDefault();
            activateTurnProcessHeader(header);
        });

        function codexActivityKind(toolName, args) { return MoonYaProcessUI.kind(toolName, args); }

        function codexCompletedVerb(toolName, state, args) {
            const failed = state === 'failure' || state === 'failed';
            const running = state === 'executing' || state === 'running';
            const kind = codexActivityKind(toolName, args);
            if (kind === 'command') return failed ? '运行失败' : (running ? '正在运行' : '已运行');
            if (kind === 'edit') return failed ? '编辑失败' : (running ? '正在编辑' : '已编辑');
            if (kind === 'read') return failed ? '读取失败' : (running ? '正在读取' : '已读取');
            if (kind === 'image') return failed ? '查看失败' : (running ? '正在查看' : '已查看');
            if (kind === 'browser') return failed ? '操作失败' : (running ? '正在操作' : '已操作');
            return failed ? '执行失败' : (running ? '正在执行' : '已完成');
        }

        function updateCodexActivityGroup(group) {
            if (!group) return;
            const counts = { edit: 0, read: 0, command: 0, image: 0, browser: 0, other: 0 };
            group.rows.forEach(function(row) {
                const kind = row.getAttribute('data-activity-kind') || 'other';
                counts[kind] = (counts[kind] || 0) + 1;
            });
            const parts = [];
            if (counts.edit) parts.push('编辑了 ' + counts.edit + ' 文件');
            if (counts.read) parts.push('读取了 ' + counts.read + ' 项');
            if (counts.command) parts.push('运行了 ' + counts.command + ' 命令');
            if (counts.image) parts.push('查看了 ' + counts.image + ' 张图像');
            if (counts.browser) parts.push('执行了 ' + counts.browser + ' 次浏览器操作');
            if (counts.other) parts.push('执行了 ' + counts.other + ' 项操作');
            group.label.textContent = parts.join(' ') || '执行了操作';
            const total = counts.edit + counts.read + counts.command + counts.image + counts.browser + counts.other;
            if (group.icon) {
                group.icon.innerHTML = counts.image === total
                    ? createWorkflowImageIcon(16)
                    : (counts.browser === total ? getToolIcon('browser_automation_control', 16) : getToolIcon('create_file', 16));
            }
        }

        function ensureCodexActivityGroup(record, step) {
            const key = 'step:' + String(step || 'current');
            let group = record.activityGroups.get(key);
            if (group) return group;
            const root = document.createElement('section');
            root.className = 'codex-activity-group';
            root.setAttribute('data-step', String(step || ''));
            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'codex-activity-header';
            header.setAttribute('aria-expanded', 'false');
            header.innerHTML = '<span class="codex-activity-icon">' + (getToolIcon('create_file', 16) || '') + '</span>' +
                '<span class="codex-activity-label"></span>' +
                '<span class="codex-activity-chevron">' + createWorkflowChevronIcon(14, 'down') + '</span>';
            const list = document.createElement('div');
            list.className = 'codex-activity-list';
            root.append(header, list);
            record.body.appendChild(root);
            group = { root: root, header: header, icon: header.querySelector('.codex-activity-icon'), label: header.querySelector('.codex-activity-label'), list: list, rows: [] };
            record.activityGroups.set(key, group);
            updateCodexActivityGroup(group);
            return group;
        }

        function renderCodexToolDetail(row, spec) {
            let detail = row.querySelector('.codex-tool-detail');
            const result = spec.result && typeof spec.result === 'object' ? spec.result : {};
            const command = spec.args && (spec.args.command || spec.args.cmd);
            const output = result.stdout || result.output || '';
            const stderr = result.stderr || result.error || '';
            const path = result.path || spec.args?.path;
            const hasDetail = !!(command || output || stderr || path || Object.keys(result).length);
            row.classList.toggle('has-detail', hasDetail);
            const main = row.querySelector('.codex-tool-main');
            if (main) {
                if (hasDetail) {
                    main.setAttribute('role', 'button');
                    main.setAttribute('tabindex', '0');
                    if (!main.hasAttribute('aria-expanded')) main.setAttribute('aria-expanded', 'false');
                } else {
                    main.removeAttribute('role');
                    main.removeAttribute('tabindex');
                    main.removeAttribute('aria-expanded');
                }
            }
            if (!hasDetail) {
                if (detail) detail.remove();
                return;
            }
            if (!detail) {
                detail = document.createElement('div');
                detail.className = 'codex-tool-detail';
                detail.hidden = true;
                row.appendChild(detail);
            }
            detail.textContent = '';
            const title = document.createElement('div');
            title.className = 'codex-tool-detail-title';
            title.textContent = command ? result.shell || (spec.args && spec.args.shell) || 'Shell' : path || spec.tool || '详情';
            detail.appendChild(title);
            if (command) {
                const commandPre = document.createElement('pre');
                commandPre.className = 'codex-command';
                commandPre.textContent = '$ ' + command;
                detail.appendChild(commandPre);
            }
            if (output || stderr) {
                const outputPre = document.createElement('pre');
                outputPre.className = 'codex-command-output' + (stderr ? ' has-error' : '');
                outputPre.textContent = [output, stderr].filter(Boolean).join('\n');
                detail.appendChild(outputPre);
            }
            if (!command && !output && !stderr) {
                const resultPre = document.createElement('pre'); resultPre.className = 'codex-command-output';
                resultPre.textContent = JSON.stringify(result, null, 2); detail.appendChild(resultPre);
            }
            const status = document.createElement('div');
            status.className = 'codex-tool-detail-status';
            const state = String(spec.state || '').toLowerCase();
            const statusLabel = state === 'executing' || state === 'running'
                ? '运行中'
                : (state === 'stopped' || state === 'cancelled'
                    ? '已取消'
                    : (state === 'failure' || state === 'failed' ? '失败' : '成功'));
            const duration = result.duration_ms !== undefined && result.duration_ms !== null
                ? ' · ' + formatTurnDuration(Number(result.duration_ms) || 0)
                : '';
            status.textContent = statusLabel +
                (result.exit_code !== undefined && result.exit_code !== null ? ' · exit ' + result.exit_code : '') +
                duration;
            detail.appendChild(status);
        }

        // 工具行：Codex 批次摘要 → 单项活动 → 可展开详情。
        function upsertToolRow(turnKey, toolId, spec) {
            if (!turnKey || !toolId) return null;
            const record = turnProcessContainer(turnKey);
            const row = MoonYaProcessUI.tool(record.sequence, toolId, spec);
            record.toolRows.set(toolId, row); record.toolCallCount = record.toolRows.size;
            return row;
        }

        // 思考行：结构照抄 DSH ReasoningRow（packages/client/ui-chat/src/client/chat/ReasoningRow.tsx）
        //   data-variant="think"  data-state="running|ok"  data-expanded
        //   折叠态摘要：运行中取**最后一行**（跟随流式尾部），结束后取**首行**；
        //   两种情况都要去掉 ** 标记（ReasoningRow.tsx 的 replaceAll('**', '')）。
        //
        //   ★ 一个思考块 = 一行。DSH 的 AssistantMarkdown 对每个 reasoning block
        //     渲染一个 ReasoningRow（不是把整轮思考合成一行），所以这里按块建行：
        // 思考行：一个思考块一行（DSH 对每个 reasoning block 渲染一个 ReasoningRow）。
        //   text 是该块**到当前为止的完整文本**（调用方从整轮累积串里按块起点切出来），
        //   行不做增量拼接——两份累积会互相打架，产生重复首 token。
        function upsertReasoningRow(turnKey, blockIndex, text, running) {
            if (!turnKey) return null;
            return MoonYaProcessUI.reason(turnProcessContainer(turnKey).sequence,
                String(blockIndex ?? 'step:1'), text, !!running);
        }

        // 主对话过程区的思考文本按模型 step 分块累积（存在该轮的过程区记录上）。
        //   不复用右侧日志的展示 state；这里的 Map 以 step 为键，保证工具调用后的下一次
        //   模型思考会新建一行，不会继续改写用户正在查看的上一行。
        function appendTurnReasoning(turnKey, blockIndex, delta) {
            const record = turnProcessContainer(turnKey);
            const idx = String(blockIndex === undefined || blockIndex === null ? 'step:1' : blockIndex);
            const blockText = (record.reasoningBlocks.get(idx) || '') + String(delta || '');
            record.reasoningBlocks.set(idx, blockText);
            return blockText;
        }

        function finalizeTurnReasoningBlock(turnKey, blockIndex) {
            const record = turnProcessNodes.get(turnKey);
            if (!record) return;
            const idx = String(blockIndex === undefined || blockIndex === null ? 'step:1' : blockIndex);
            const row = record.reasoningRows.get(idx);
            if (row) setReasoningRowState(row, false);
        }

        // 思考行渲染：折叠摘要 + 正文 + 状态。
        //   摘要规则来自 DSH ReasoningRow.tsx：
        //     running ? latestLine(text) : firstLine(text)，并去掉 ** 标记。
        function renderReasoningRow(row, text, running) {
            if (!row) return;
            const bodyEl = row.nextElementSibling;
            row.setAttribute('data-state', running ? 'running' : 'ok');
            const raw = String(text || '');
            const trimmed = raw.trimEnd();
            const nl = trimmed.lastIndexOf('\n');
            const summaryLine = (running
                ? (nl === -1 ? trimmed : trimmed.slice(nl + 1))
                : (function() {
                    const first = trimmed.indexOf('\n');
                    return first === -1 ? trimmed : trimmed.slice(0, first);
                })()).replace(/\*\*/g, '').trim();
            row.querySelector('.reasoning-row-summary-text').textContent = summaryLine;
            if (bodyEl) bodyEl.textContent = raw;
        }

        // 本轮结束时把某一历史思考块定稿（摘要从"末尾行"切到"首行"）
        function setReasoningRowState(row, running) {
            if (!row) return;
            // ★ 必须读行自己的累积字段 __text；用错字段名会传空串进来，把整行正文清空
            renderReasoningRow(row, row.__text || '', !!running);
            if (row.__processSegment) { row.__processSegment.thinking = !!running; MoonYaProcessUI.refresh(row.__processSegment); }
        }

        // 本轮结束：结算用时，并把它写进轮次末尾的收尾行（DSH 的 tail，不在过程表头里）。
        function markTurnProcessElapsed(turnKey, outcome) {
            const record = turnProcessNodes.get(turnKey);
            if (!record) return;
            record.elapsedMs = Math.max(0, Date.now() - record.startedAt);
            record.status = outcome || 'completed'; record.completedAt = new Date().toISOString();
            MoonYaProcessUI.endDuration(record.message, record.elapsedMs);
            MoonYaProcessUI.finish(record.sequence);
            record.sequence.segments.forEach(segment => {
                segment.container.dataset.turnElapsed = String(record.elapsedMs);
                segment.container.dataset.turnCompletedAt = record.completedAt;
            });
        }

        // 新建对话/切换会话时清掉主对话过程区
        function resetTurnProcessNodes() {
            turnProcessNodes.forEach(function(record) {
                if (record.timer) window.clearInterval(record.timer);
                if (record.message.__codexElapsedTimer) { window.clearInterval(record.message.__codexElapsedTimer); record.message.__codexElapsedTimer = null; }
                record.sequence.segments.forEach(segment => segment.container.remove());
            });
            turnProcessNodes.clear();
            // 过程区不在了，气泡内恢复"由自带表头折叠本行过程"的旧行为
            window.__moonyaDshTurnProcess = false;
            window.__moonyaTurnStartedAt = 0;
            window.__moonyaTurnKey = '';
        }

        function ensureTeamLogNode(event, key, kindLabel) {
            let card = teamUiState.logNodes.get(key);
            if (card) return card;
            const content = document.getElementById('detailPanelContent');
            if (!content) return null;
            const empty = document.getElementById('detailPanelEmpty');
            if (empty) empty.remove();
            const agent = teamAgent(event.agent || event.agent_key);
            const projectContext = teamProjectContext(event);
            const name = projectContext.roleLabel || agent.name || agent.display_name || agent.agent_key || 'MoonYa';
            card = document.createElement('article');
            card.className = 'team-event team-log-event depth-' +
                (event.tool_call_id ? 2 : (event.parent_agent_key ? 1 : 0));
            const header = document.createElement('div');
            header.className = 'team-event-head';
            header.appendChild(teamAvatarNode(agent, 'team-event-avatar'));
            const agentName = document.createElement('span');
            agentName.className = 'team-event-agent';
            agentName.textContent = name;
            const kind = document.createElement('span');
            kind.className = 'team-event-kind';
            kind.textContent = kindLabel;
            const time = document.createElement('span');
            time.className = 'team-event-time';
            time.textContent = formatDetailTime(event.timestamp || event.created_at);
            header.append(agentName, kind, time);
            const body = document.createElement('div');
            body.className = 'team-event-summary';
            card.append(header, body);
            const projectActor = projectContext.groupId && projectContext.actorId
                ? ensureTeamProjectActor(event)
                : null;
            const target = projectActor ? projectActor.log : content;
            target.appendChild(card);
            if (projectActor) teamScrollIfFollowing(projectActor.log);
            teamUiState.logNodes.set(key, card);
            return card;
        }

        function renderTeamTurnLog(event) {
            const payload = event.payload || {};
            const turnPhase = payload.phase || (payload.metadata && payload.metadata.phase) || '';
            const turnLabel = {
                planning: '规划轮次',
                coordination: '协调轮次',
                final_synthesis: '最终汇总',
                execution: '执行轮次'
            }[turnPhase] || '思考与回复';
            const turnKey = teamTurnKey(event);
            // 主对话里的过程区/收尾行按"轮"归属，不用会话级的 turnKey
            const conversationKey = conversationTurnKey(event);
            const key = 'turn:' + turnKey;
            const card = ensureTeamLogNode(event, key, turnLabel);
            if (!card) return;
            let reasoning = card.querySelector('.team-log-reasoning');
            let answer = card.querySelector('.team-log-content');
            if (!reasoning) {
                const body = card.querySelector('.team-event-summary');
                const reasoningSection = document.createElement('section');
                reasoningSection.className = 'team-log-section team-log-reasoning-section';
                const reasoningLabel = document.createElement('div');
                reasoningLabel.className = 'team-log-section-label';
                reasoningLabel.textContent = '思考过程';
                reasoning = document.createElement('div');
                reasoning.className = 'team-log-reasoning';
                reasoningSection.append(reasoningLabel, reasoning);
                const answerSection = document.createElement('section');
                answerSection.className = 'team-log-section team-log-content-section';
                const answerLabel = document.createElement('div');
                answerLabel.className = 'team-log-section-label';
                answerLabel.textContent = '输出内容';
                answer = document.createElement('div');
                answer.className = 'team-log-content';
                answerSection.append(answerLabel, answer);
                body.replaceWith(reasoningSection, answerSection);
            }
            let state = teamUiState.turns.get(turnKey);
            if (!state) {
                state = {
                    key: turnKey,
                    reasoning: '',
                    content: '',
                    renderedReasoningChars: 0,
                    renderedContentChars: 0,
                    receivedReasoningChars: 0,
                    receivedContentChars: 0,
                    phase: turnPhase,
                    status: 'running'
                };
                teamUiState.turns.set(turnKey, state);
            }
            function appendStableStream(node, field, renderedField, receivedField, delta) {
                delta = String(delta || '');
                state[field] += delta;
                state[receivedField] = Number(payload.received_chars || state[field].length);
                if (!hasTeamVisibleContent(delta)) return;
                const pending = state[field].slice(state[renderedField]);
                if (!pending) return;
                if (node.classList.contains('team-stream-placeholder')) {
                    node.textContent = '';
                    node.classList.remove('team-stream-placeholder');
                }
                node.classList.add('team-streaming-text');
                node.appendChild(document.createTextNode(pending));
                state[renderedField] = state[field].length;
            }
            if (event.event === 'agent.turn.started' && !state.reasoning) {
                reasoning.textContent = '模型正在思考';
                reasoning.classList.add('team-stream-placeholder');
            }
            if (event.event === 'agent.reasoning.delta') {
                appendStableStream(reasoning, 'reasoning', 'renderedReasoningChars', 'receivedReasoningChars', payload.delta);
            }
            if (event.event === 'agent.content.delta') {
                appendStableStream(answer, 'content', 'renderedContentChars', 'receivedContentChars', payload.delta);
            }
            const stepSettled = event.event === 'agent.turn.completed' ||
                (event.source === 'harness' && event.event === 'assistant.message');
            if (stepSettled) {
                state.reasoning = payload.reasoning_content || payload.reasoning || state.reasoning;
                state.content = payload.content_discarded
                    ? ''
                    : (payload.content || state.content);
                state.status = event.event === 'assistant.message' ? 'completed' : (payload.status || 'completed');
                state.receivedReasoningChars = Number(payload.received_reasoning_chars || state.reasoning.length);
                state.receivedContentChars = Number(payload.received_content_chars || state.content.length);
                const finalReasoning = payload.reasoning_content || payload.reasoning || (state && state.reasoning) || '';
                const finalContent = payload.content_discarded
                    ? ''
                    : (payload.content || (state && state.content) || '');
                renderTeamMarkdown(reasoning, finalReasoning, { final: true });
                renderTeamMarkdown(answer, finalContent, { final: true });
                reasoning.classList.remove('team-stream-placeholder', 'team-streaming-text');
                answer.classList.remove('team-stream-placeholder', 'team-streaming-text');
                state.renderedReasoningChars = finalReasoning.length;
                state.renderedContentChars = finalContent.length;
                card.classList.remove('running');
                card.querySelector('.team-event-kind').textContent =
                    payload.status === 'failed' ? turnLabel + ' · 失败' : turnLabel + ' · 已完成';
            } else {
                card.classList.add('running');
            }
            const visibleReasoning = stepSettled
                ? (payload.reasoning_content || payload.reasoning || (state && state.reasoning) || '')
                : ((state && state.reasoning) || '');
            const visibleContent = stepSettled
                ? (payload.content_discarded ? '' : (payload.content || (state && state.content) || ''))
                : ((state && state.content) || '');
            reasoning.hidden = event.event !== 'agent.turn.started' && !hasTeamVisibleContent(visibleReasoning) &&
                !reasoning.classList.contains('team-stream-placeholder');
            answer.hidden = !hasTeamVisibleContent(visibleContent);
            const reasoningSection = reasoning.closest('.team-log-section');
            const answerSection = answer.closest('.team-log-section');
            if (reasoningSection) reasoningSection.hidden = reasoning.hidden;
            if (answerSection) answerSection.hidden = answer.hidden;

            // ★ 主对话过程区：一个模型 step 的思考对应一行。
            //   同一 step 内的 token delta 只更新该行；assistant.message 将它定稿，下一
            //   step 的 reasoning.delta 再按 step key 新建一行。
            if (event.event === 'agent.reasoning.delta') {
                const blockKey = conversationReasoningBlockKey(event);
                const turnText = appendTurnReasoning(conversationKey, blockKey, payload.delta);
                upsertReasoningRow(conversationKey, blockKey, turnText, true);
            }
            // 本轮结束：把思考行定稿
            //   running 态的摘要跟随"末尾行"，不结算就会一直停在流式态。
            if (event.event === 'agent.turn.completed') {
                const proc = turnProcessNodes.get(conversationKey);
                if (proc) {
                    proc.reasoningRows.forEach(function(row) {
                        if (row.getAttribute('data-state') === 'running') {
                            setReasoningRowState(row, false);
                        }
                    });
                }
            }
        }

        function teamTurnForActivity(event) {
            if (event && event.source === 'harness') {
                const turnKey = conversationTurnKey(event);
                const trace = turnProcessContainer(
                    turnKey,
                    event.timestamp ? Date.parse(event.timestamp) : Date.now()
                );
                let approvals = trace.body.querySelector('.team-main-approvals');
                if (!approvals) {
                    approvals = document.createElement('div');
                    approvals.className = 'team-main-approvals codex-turn-approvals';
                    trace.body.appendChild(approvals);
                }
                revealTurnProcess(trace);
                return {
                    key: turnKey,
                    state: trace,
                    card: trace.container,
                    content: approvals
                };
            }
            let presentation = activeTeamPresentation(event);
            if (!presentation) {
                presentation = startTeamPresentation(Object.assign({}, event, {
                    payload: Object.assign({}, event.payload || {}, {
                        phase: teamAgentKey(event) === 'moonya' ? 'planning' : 'execution'
                    })
                }));
            }
            if (presentation) {
                return {
                    key: presentation.key,
                    state: presentation,
                    card: presentation.card
                };
            }
            return { key: '', state: null, card: null };
        }

        function renderTeamEventMedia(card, media) {
            if (!card) return;
            const previous = card.querySelector('.team-event-media');
            if (previous) previous.remove();
            if (!Array.isArray(media) || !media.length) return;

            const grid = document.createElement('div');
            grid.className = 'team-event-media';
            media.forEach(function(item, index) {
                const tile = document.createElement('button');
                tile.type = 'button';
                tile.className = 'team-event-media-tile';
                const original = item && item.content_url ? String(item.content_url) : '';
                const thumbnail = item && item.thumbnail_url ? String(item.thumbnail_url) : original;
                if (!thumbnail || (item && (item.kind === 'image_error' || item.error))) {
                    tile.classList.add('error');
                    tile.disabled = true;
                    const placeholder = document.createElement('span');
                    placeholder.className = 'team-event-media-placeholder';
                    placeholder.textContent = '图片保存失败' +
                        (item && item.error ? '：' + String(item.error) : '');
                    tile.appendChild(placeholder);
                } else {
                    const image = document.createElement('img');
                    image.loading = 'lazy';
                    image.decoding = 'async';
                    image.src = thumbnail;
                    image.alt = '工作日志图片 ' + (index + 1);
                    image.addEventListener('error', function() {
                        tile.classList.add('error');
                        tile.disabled = true;
                        image.remove();
                        const placeholder = document.createElement('span');
                        placeholder.className = 'team-event-media-placeholder';
                        placeholder.textContent = '图片暂时无法读取';
                        tile.appendChild(placeholder);
                    }, { once: true });
                    tile.appendChild(image);
                    tile.addEventListener('click', function() {
                        openDetailLightbox(original || thumbnail);
                    });
                }
                if (item && item.source) {
                    const source = document.createElement('span');
                    source.className = 'team-event-media-source';
                    source.textContent = String(item.source);
                    tile.appendChild(source);
                }
                grid.appendChild(tile);
            });
            card.appendChild(grid);
        }

        function renderTeamTool(event) {
            const payload = event.payload || {};
            const toolId = String(event.run_id || '') + ':' + String(event.turn ?? '') + ':' + String(event.step ?? '') + ':' +
                String(event.tool_call_id || payload.tool_call_id || payload.tool_key || event.seq || '');
            let tool = teamUiState.tools.get(toolId);
            if (!tool) {
                tool = { id: toolId, status: 'running', name: payload.display_name || payload.tool_key || '工具' };
                teamUiState.tools.set(toolId, tool);
            }
            tool.name = payload.display_name || payload.tool_key || tool.name;
            // 折叠行的摘要取自调用参数（tool.started 的 arguments），
            //   结果 JSON 只进右侧工作日志。
            if (payload.arguments && typeof payload.arguments === 'object') {
                tool.args = payload.arguments;
            }
            if (event.event === 'tool.completed' || event.event === 'tool.failed') {
                tool.status = event.event === 'tool.failed' || payload.ok === false || payload.result?.success === false ? 'failed' : 'completed';
                tool.result = payload.content || (payload.error && payload.error.message) || '';
                if (payload.result && typeof payload.result === 'object') {
                    tool.resultObject = payload.result;
                } else if (typeof tool.result === 'string' && /^[\[{]/.test(tool.result.trim())) {
                    try { tool.resultObject = JSON.parse(tool.result); } catch (parseError) {}
                }
            } else if (event.event === 'tool.progress') {
                tool.status = 'running';
                const output = payload.stderr || payload.stdout || '';
                tool.result = output ? String(output).slice(-1200) : (payload.label || '后台运行');
                tool.resultObject = Object.assign({}, tool.resultObject || {}, {
                    shell: payload.shell || (tool.args && tool.args.shell) || '',
                    stdout: payload.stdout || '',
                    stderr: payload.stderr || '',
                    output: payload.output || ''
                });
            }

            const log = ensureTeamLogNode(event, 'tool:' + toolId,
                (event.event === 'tool.completed' || event.event === 'tool.failed') ? '工具结果' :
                    (event.event === 'tool.progress' ? '后台运行' : '工具调用'));
            if (log) {
                log.classList.toggle('running', tool.status === 'running');
                log.classList.toggle('error', tool.status === 'failed');
                log.querySelector('.team-event-kind').textContent =
                    tool.status === 'running'
                        ? (event.event === 'tool.progress' ? '后台运行' : '工具调用')
                        : (tool.status === 'failed' ? '工具失败' : '工具完成');
                renderTeamPlainText(
                    log.querySelector('.team-event-summary'),
                    tool.name + (tool.result ? '\n' + tool.result : '')
                );
                renderTeamEventMedia(log, payload.media);
            }

            // ★ 主对话过程区的工具行（DSH ToolRow：图标 + 标题 + 圆点 + 摘要）
            //   标题用工具的中文名，摘要用调用参数的短描述；运行中保持 running 以便显示扫光。
            const toolKey = payload.tool_key || payload.name || '';
            const argSummary = describeToolCall(toolKey, tool.args);
            const resultLine = String(tool.result || '').split('\n')
                .find(function(line) { return line.trim() !== ''; }) || '';
            if (toolKey === 'subagent' && tool.status === 'completed' && payload.ok !== false) {
                const record = turnProcessNodes.get(conversationTurnKey(event));
                const row = record && record.toolRows.get(toolId);
                if (row) {
                    const group = row.__codexActivityGroup;
                    if (group) { group.rows = group.rows.filter(item => item !== row); group.root.hidden = !group.rows.length; updateCodexActivityGroup(group); }
                    row.remove(); record.toolRows.delete(toolId); record.sequence.tools.delete(toolId); record.sequence.segments.forEach(MoonYaProcessUI.refresh);
                }
                return;
            }
            upsertToolRow(conversationTurnKey(event), toolId, {
                tool: toolKey,
                title: tool.name,
                // 结果不是结构化 JSON 时，作为没有参数信息的兜底摘要
                detail: argSummary || (/^[[{]/.test(resultLine) ? '' : resultLine),
                args: tool.args || {},
                result: tool.resultObject || {},
                step: event.step || (event.payload && event.payload.step) || '',
                state: tool.status === 'failed' ? 'failure'
                    : (tool.status === 'running' ? 'executing' : 'success')
            });
        }

        function renderTeamGenericLog(event) {
            const key = 'event:' + (event.run_id || '') + ':' + (event.seq || Math.random());
            const card = ensureTeamLogNode(event, key, teamEventLabel(event.event, event.payload));
            if (!card) return;
            const status = event.payload && event.payload.status;
            const error = event.event === 'agent.failed' ||
                (event.event === 'run.completed' && status === 'failed');
            card.classList.toggle('error', error);
            card.classList.toggle('running', /\.started$/.test(event.event || ''));
            const summary = card.querySelector('.team-event-summary');
            const formattedOutputEvents = new Set(['agent.summary']);
            if (formattedOutputEvents.has(event.event)) {
                // 复用主回复已经使用的格式化输出渲染器；结果型工作日志不再把
                // Markdown 标记、表格和代码块当成普通文本展示。
                summary.classList.add('team-log-content');
                renderTeamMarkdown(summary, teamEventSummary(event), { final: true });
            } else {
                renderTeamPlainText(summary, teamEventSummary(event));
            }
            const tasks = event.payload && Array.isArray(event.payload.tasks)
                ? event.payload.tasks
                : [];
            if (tasks.length && !card.querySelector('.team-event-task-list')) {
                const list = document.createElement('ol');
                list.className = 'team-event-task-list';
                tasks.forEach(function(task) {
                    const item = document.createElement('li');
                    const owner = document.createElement('span');
                    const employee = teamAgent(task.agent_key || '');
                    owner.className = 'team-event-task-owner';
                    renderTeamPlainText(owner, employee.display_name || employee.name || task.agent_key || 'Agent');
                    const instruction = document.createElement('span');
                    instruction.className = 'team-event-task-instruction';
                    renderTeamPlainText(instruction, task.instruction || '');
                    item.append(owner, instruction);
                    if (Array.isArray(task.depends_on) && task.depends_on.length) {
                        const dependency = document.createElement('small');
                        renderTeamPlainText(dependency, '依赖：' + task.depends_on.join('、'));
                        item.appendChild(dependency);
                    }
                    list.appendChild(item);
                });
                card.appendChild(list);
            }
        }

        function renderHarnessAssistantMessage(event) {
            if (!event || event.source !== 'harness') return;
            finalizeTurnReasoningBlock(conversationTurnKey(event), conversationReasoningBlockKey(event));
            const record = turnProcessNodes.get(conversationTurnKey(event));
            if (record && !(event.payload?.tool_calls || []).length) record.message.classList.add('codex-final-answer');
        }

        const harnessCompactionNoticeSeq = new Map();
        function notifyHarnessCompaction(event) {
            const runId = String(event.run_id || '');
            const seq = Number(event.seq) || 0;
            if (!runId || !seq) return;
            const storageKey = 'moonya.harness.compaction.notice.' + runId;
            let previous = harnessCompactionNoticeSeq.get(runId) || 0;
            try { previous = Math.max(previous, Number(localStorage.getItem(storageKey)) || 0); } catch (error) {}
            if (seq <= previous) return;
            harnessCompactionNoticeSeq.set(runId, seq);
            try { localStorage.setItem(storageKey, String(seq)); } catch (error) {}
            if (typeof showToast === 'function') showToast('上下文已压缩，任务摘要已保留');
        }

        function renderCodexSystemActivity(event) {
            const record = turnProcessContainer(
                conversationTurnKey(event),
                event.timestamp ? Date.parse(event.timestamp) : Date.now()
            );
            const key = String(event.run_id || '') + ':' + String(event.turn || '') + ':' + String(event.step || '');
            let row = Array.from(record.body.querySelectorAll('.codex-system-activity'))
                .find(node => node.dataset.compactionKey === key);
            if (row && Number(row.dataset.eventSeq || 0) >= Number(event.seq || 0)) return;
            if (!row) row = document.createElement('div');
            row.className = 'codex-system-activity';
            row.dataset.compactionKey = key;
            row.setAttribute('data-event-seq', String(event.seq || ''));
            row.innerHTML = '<span class="codex-system-icon" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"></path></svg></span>' +
                '<span>' + (event.event === 'context.compacting' ? '正在压缩上下文…'
                    : event.event === 'context.compaction_failed' ? '上下文压缩未完成'
                    : '上下文已自动压缩') + '</span>';
            record.body.appendChild(row);
        }

        function renderTeamApprovalLog(event) {
            const payload = event.payload || {};
            const approvalId = payload.id || payload.approval_id;
            if (!approvalId) return;
            const key = 'approval:' + approvalId;
            const card = ensureTeamLogNode(event, key, '确认');
            if (!card) return;
            const state = teamUiState.approvals.get(String(approvalId)) || {};
            const tool = payload.tool_key || state.toolKey || '工具调用';
            const status = state.status || payload.status || 'pending';
            const args = payload.arguments || state.arguments || {};
            const phase = args.phase || state.phase || 'act';
            const phaseLabel = phase === 'inspect' ? '检查' : (phase === 'verify' ? '验证' : '执行变更');
            const intent = args.intent || state.intent || tool;
            const shell = args.shell || state.shell || '';
            const preview = args.command_preview || args.command || state.commandPreview || '';
            const risk = args.risk_reason || state.riskReason || payload.reason || state.reason || '';
            card.querySelector('.team-event-kind').textContent =
                status === 'pending' ? '等待确认' : '确认结果';
            renderTeamPlainText(
                card.querySelector('.team-event-summary'),
                '需要你的确认 · ' + phaseLabel + ' · ' + intent + '\n' +
                (shell ? 'Shell：' + shell + '\n' : '') +
                (risk ? '风险：' + risk + '\n' : '') +
                (preview ? '命令：' + preview + '\n' : '') +
                (status === 'pending' ? '等待用户决定' :
                    (status === 'allowed' ? '已允许本次调用。' :
                        (status === 'denied' ? '已拒绝本次调用。' : (status === 'cancelled' ? '确认已取消。' : '确认已过期。'))))
            );
        }

        const userActionUiState = { pending: null };

        function syncBrowserHandoffControl(pending) {
            if (pending && pending.type === 'desktopControl') pending = null;
            window.__moonyaBrowserHandoff = pending || null;
            if (typeof window.moonyaSetBrowserHandoff === 'function') {
                window.moonyaSetBrowserHandoff(pending || null);
            }
        }

        function showUserActionCard(event) {
            const payload = event.payload || {};
            if (!payload.id) return;
            const card = document.getElementById('userActionCard');
            const wrapper = card && card.closest('.input-container-wrapper');
            if (!card || !wrapper) return;
            const pending = {
                id: String(payload.id), runId: String(event.run_id || ''),
                projectPath: event.project_path || '',
                type: payload.action_type === 'fileUpload' ? 'fileUpload' : payload.action_type === 'desktopControl' ? 'desktopControl' : 'browserControl',
                message: String(payload.display_message || '请接管内置浏览器完成页面操作，完成后点击“确认完成”。'),
                deciding: false
            };
            userActionUiState.pending = pending;
            document.getElementById('userActionMessage').textContent = pending.message;
            document.getElementById('userActionOpenLabel').textContent = pending.type === 'fileUpload' ? '选择文件' : '去操作';
            const status = document.getElementById('userActionStatus');
            status.hidden = true; status.textContent = '';
            card.classList.remove('is-deciding');
            card.querySelectorAll('button').forEach(function(button) { button.disabled = false; });
            card.hidden = false;
            wrapper.classList.add('has-user-action');
            syncBrowserHandoffControl(pending);
        }

        function closeUserActionCard() {
            const card = document.getElementById('userActionCard');
            const wrapper = card && card.closest('.input-container-wrapper');
            if (card) { card.hidden = true; card.classList.remove('is-deciding'); }
            if (wrapper) wrapper.classList.remove('has-user-action');
            userActionUiState.pending = null;
            syncBrowserHandoffControl(null);
        }

        function setUserActionError(message) {
            const pending = userActionUiState.pending;
            const card = document.getElementById('userActionCard');
            if (pending) pending.deciding = false;
            if (card) {
                card.classList.remove('is-deciding');
                card.querySelectorAll('button').forEach(function(button) { button.disabled = false; });
            }
            const status = document.getElementById('userActionStatus');
            if (status) { status.textContent = message; status.hidden = false; }
            syncBrowserHandoffControl(pending);
        }

        function decideUserAction(decision) {
            const pending = userActionUiState.pending;
            if (!pending || pending.deciding) return Promise.resolve(false);
            pending.deciding = true;
            const card = document.getElementById('userActionCard');
            if (card) {
                card.classList.add('is-deciding');
                card.querySelectorAll('button').forEach(function(button) { button.disabled = true; });
            }
            syncBrowserHandoffControl(Object.assign({}, pending, { deciding: true }));
            return fetch('harness_api.php?action=user_action', {
                method: 'POST', credentials: 'same-origin',
                headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
                body: JSON.stringify({
                    session_id: pending.runId, action_id: pending.id, decision: decision,
                    project_path: pending.projectPath || ''
                })
            }).then(function(response) { return response.json(); }).then(function(result) {
                if (!result.success) throw new Error(result.error || '用户接管状态提交失败');
                return true;
            }).catch(function(error) {
                setUserActionError(error.message);
                return false;
            });
        }

        function handleUserAction(event) {
            const payload = event.payload || {};
            if (event.event === 'user_action.required') {
                showUserActionCard(event);
                return;
            }
            const pending = userActionUiState.pending;
            if (event.event === 'user_action.decided' && pending && String(payload.action_id || '') === pending.id) {
                closeUserActionCard();
            }
        }

        window.moonyaCompleteUserAction = function() { return decideUserAction('complete'); };
        window.moonyaCompleteDesktopAction = function(sessionId) {
            const pending = userActionUiState.pending;
            if (pending && pending.type === 'desktopControl' && pending.runId === String(sessionId)) return decideUserAction('complete');
            return Promise.resolve(false);
        };
        window.moonyaSkipDesktopAction = function(sessionId) {
            const pending = userActionUiState.pending;
            if (pending && pending.type === 'desktopControl' && pending.runId === String(sessionId)) return decideUserAction('skip');
            return Promise.resolve(false);
        };

        document.addEventListener('click', function(event) {
            if (event.target && event.target.closest('#userActionOpen')) {
                const pending = userActionUiState.pending;
                if (pending && pending.type === 'desktopControl') {
                    if (!window.moonyaDesktopPreview) { setUserActionError('虚拟屏幕服务未连接，请在 MoonYa Windows 客户端重试。'); return; }
                    window.moonyaDesktopPreview.open(pending.runId).catch(function(error) { setUserActionError(error.message); });
                    return;
                }
                const opened = typeof window.moonyaOpenBrowserPanel === 'function' && window.moonyaOpenBrowserPanel({ source: 'handoff' });
                if (!opened) setUserActionError('内置浏览器当前不可用，请在 MoonYa 桌面端重试或选择跳过。');
            } else if (event.target && event.target.closest('#userActionSkip')) {
                decideUserAction('skip');
            }
        });
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && userActionUiState.pending && !userActionUiState.pending.deciding) {
                event.preventDefault(); decideUserAction('skip');
            }
        }, true);

        function renderTeamEvent(event, options) {
            options = options || {};
            const eventName = event.event || '';
            updateTeamProjectEvent(event);
            // agent.waiting is a high-frequency transient heartbeat. Its sole
            // UI is the run-level live indicator updated by handleTeamEvent;
            // rendering every heartbeat as a history card creates an endless
            // stack of identical "模型正在思考" entries.
            if (eventName === 'agent.waiting') return;
            if (event.source === 'harness' && ['step.started', 'model.activity'].includes(eventName)) {
                MoonYaProcessUI.activity(turnProcessContainer(conversationTurnKey(event)).sequence);
                return;
            }
            if (eventName === 'agent.started') {
                startTeamPresentation(event);
                renderTeamGenericLog(event);
            } else if (eventName === 'agent.summary' &&
                ((event.payload && event.payload.phase === 'delegation') ||
                    (event.payload && Array.isArray(event.payload.tasks)))) {
                renderTeamDelegationMain(event);
                renderTeamGenericLog(event);
            } else if (eventName === 'agent.completed' || eventName === 'agent.failed') {
                renderTeamAgentCompletionMain(event);
                renderTeamGenericLog(event);
            } else if (eventName === 'assistant.completed') {
                renderTeamAssistantCompletedMain(event);
                renderTeamGenericLog(event);
            } else if (eventName === 'assistant.message') {
                renderHarnessAssistantMessage(event);
                if (event.source === 'harness') renderTeamTurnLog(event);
                else renderTeamGenericLog(event);
            } else if (['context.compacting', 'context.compacted', 'context.compaction_failed'].includes(eventName)) {
                renderCodexSystemActivity(event);
                renderTeamGenericLog(event);
            // ★ 必须带 m 标志：`$` 默认只匹配整个字符串末尾，而这里的分组是"多个候选"，
            //   没有 m 时 agent.reasoning.delta / agent.turn.started 全都不匹配，
            //   会掉进最后的 else，导致思考行与轮次日志永远不渲染。
            } else if (/^agent\.(turn\.started|reasoning\.delta|content\.delta|turn\.completed)$/m.test(eventName)) {
                // Runtime content already feeds the normal Codex-style main answer bubble.
                // Keep its complete trace in the right panel without duplicating text.
                if (eventName === 'agent.content.delta' && event.source !== 'harness') renderTeamSynthesisDelta(event);
                renderTeamTurnLog(event);
            } else if (eventName === 'desktop.started') {
                window.moonyaDesktopPreview?.show(event.payload || {});
            } else if (eventName === 'tool.started' || eventName === 'tool.progress' || eventName === 'tool.completed' || eventName === 'tool.failed') {
                renderTeamTool(event);
            } else if (eventName === 'approval.required' || eventName === 'approval.decided') {
                renderTeamApprovalLog(event);
            } else if (eventName === 'user_action.required' || eventName === 'user_action.decided') {
                renderTeamGenericLog(event);
            } else {
                renderTeamGenericLog(event);
            }
            const content = document.getElementById('detailPanelContent');
            teamScrollIfFollowing(content);
        }

        // Approval records outlive the work-log DOM and are scoped to a conversation.
        let composerApprovalTimer = null;
        let approvalStatePoll = null;
        let approvalStateGeneration = 0;
        const approvalServerSeq = new Map();

        function approvalBelongsToCurrentConversation(record) {
            if (record.chatId) return String(record.chatId) === String(currentChatId || '__new__');
            return Number(record.conversationId || 0) === Number(currentDbConversationId || 0);
        }

        function currentPendingApprovals() {
            return Array.from(teamUiState.approvals.values()).filter(function(record) {
                return record.status === 'pending' && approvalBelongsToCurrentConversation(record);
            });
        }

        function syncComposerApproval() {
            if (composerApprovalTimer) clearInterval(composerApprovalTimer);
            composerApprovalTimer = null;
            const host = document.getElementById('composerApprovalHost');
            if (!host) return;
            const wrapper = host.closest('.input-container-wrapper');
            const record = currentPendingApprovals()[0];
            if (approvalStatePoll && !record) { clearInterval(approvalStatePoll); approvalStatePoll = null; }
            if (!approvalStatePoll && record) {
                approvalStatePoll = setInterval(function() {
                    refreshComposerApprovals().catch(function() {});
                }, 15000);
            }
            if (host.firstElementChild !== (record && record.card)) host.replaceChildren();
            host.hidden = !record;
            if (wrapper) wrapper.classList.toggle('has-composer-approval', !!record);
            if (!record) return;
            if (host.firstElementChild !== record.card) host.appendChild(record.card);
            function tick() {
                const remaining = Math.max(0, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1000));
                const countdown = record.card.querySelector('.composer-approval-countdown');
                const deadlineKnown = Number.isFinite(remaining);
                countdown.hidden = !deadlineKnown || remaining > 60;
                countdown.textContent = remaining > 0 ? remaining + '秒' : '等待过期确认';
                record.card.querySelectorAll('button[data-decision]').forEach(function(button) {
                    button.disabled = record.deciding || (deadlineKnown && remaining <= 0);
                });
                if (deadlineKnown && remaining <= 0) {
                    clearInterval(composerApprovalTimer);
                    composerApprovalTimer = null;
                    // Server settles expiry; never turn a local clock tick into a decision.
                    if (!record.expiryRefreshRequested) {
                        record.expiryRefreshRequested = true;
                        refreshComposerApprovals().catch(function() {});
                    }
                }
            }
            composerApprovalTimer = setInterval(tick, 1000);
            tick();
        }

        function updateTeamApprovalCard(approvalId, status) {
            const record = teamUiState.approvals.get(String(approvalId));
            if (!record || record.status === status) return;
            record.status = status;
            record.deciding = false;
            record.card.remove();
            const decidedEvent = Object.assign({}, record.event, { event: 'approval.decided',
                payload: { approval_id: record.id, status: status } });
            if (approvalBelongsToCurrentConversation(record)) renderTeamApprovalLog(decidedEvent);
            if (window.MoonYaSharedRuntime && record.conversationId) {
                window.MoonYaSharedRuntime.streamEvent({ conversationId: record.conversationId,
                    runId: record.runId, event: decidedEvent }).catch(function() {});
            }
            syncComposerApproval();
        }

        function settleComposerApprovals(runId, status) {
            teamUiState.approvals.forEach(function(record) {
                if ((record.runId === String(runId) || record.rootRunId === String(runId)) && record.status === 'pending') {
                    updateTeamApprovalCard(record.id, status);
                }
            });
        }

        function handleTeamApproval(event) {
            const payload = event.payload || {};
            const approvalId = String(payload.id || payload.approval_id || '');
            if (!approvalId) return;
            if (event.seq) approvalServerSeq.set(String(event.run_id || ''),
                Math.max(approvalServerSeq.get(String(event.run_id || '')) || 0, Number(event.seq)));
            if (event.event === 'approval.decided') {
                updateTeamApprovalCard(approvalId, payload.status || 'expired');
                return;
            }
            if (teamUiState.approvals.has(approvalId)) {
                const existing = teamUiState.approvals.get(approvalId);
                if (approvalBelongsToCurrentConversation(existing)) renderTeamApprovalLog(existing.event);
                syncComposerApproval();
                return;
            }
            const args = payload.arguments || {};
            const record = {
                id: approvalId, runId: String(event.run_id || ''), rootRunId: String(event.root_run_id || event.run_id || ''), event: event,
                chatId: event.chat_id || null, conversationId: event.source === 'harness' ? null : (event.conversation_id || currentDbConversationId || null),
                projectPath: event.project_path !== undefined ? event.project_path
                    : ((typeof localStorage !== 'undefined' && localStorage.getItem('moonya_work_project_path')) || ''),
                status: payload.status || 'pending', expiresAt: payload.expires_at,
                toolKey: payload.tool_key || '工具调用', arguments: args, reason: payload.reason || '',
                phase: args.phase || 'act', intent: args.intent || payload.tool_key || '工具调用',
                shell: args.shell || '', riskReason: args.risk_reason || payload.reason || '此操作需要一次性授权。',
                commandPreview: args.command_preview || args.command || args.path || '', deciding: false
            };
            record.phaseLabel = record.phase === 'inspect' ? '检查' : (record.phase === 'verify' ? '验证' : '执行变更');
            const card = document.createElement('div');
            card.className = 'composer-approval-card';
            card.id = 'composerApproval-' + approvalId;
            const heading = document.createElement('div');
            heading.className = 'composer-approval-heading';
            const tool = document.createElement('span');
            tool.textContent = payload.tool_key === 'execute_command' ? '⌘ 终端' : (payload.display_name || record.toolKey);
            const countdown = document.createElement('span');
            countdown.className = 'composer-approval-countdown';
            countdown.hidden = true;
            heading.append(tool, countdown);
            const reason = document.createElement('p');
            reason.className = 'composer-approval-reason';
            renderTeamPlainText(reason, record.intent + (record.riskReason ? '。' + record.riskReason : ''));
            const preview = document.createElement('pre');
            preview.className = 'composer-approval-preview';
            preview.textContent = record.commandPreview;
            preview.hidden = !record.commandPreview;
            const errorNode = document.createElement('p');
            errorNode.className = 'composer-approval-error';
            errorNode.hidden = true;
            const actions = document.createElement('div');
            actions.className = 'composer-approval-actions';
            const allowed = Array.isArray(payload.allowed_decisions) && payload.allowed_decisions.length
                ? payload.allowed_decisions : ['deny', 'allow_once'];
            const labels = { deny: '拒绝 ×', block: '阻止', allow_once: '允许一次 →', allow_always: '始终允许' };
            ['deny', 'block', 'allow_once', 'allow_always'].filter(function(value) {
                return allowed.includes(value);
            }).forEach(function(value) {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.decision = value;
                button.textContent = labels[value];
                button.addEventListener('click', function() { decide(value); });
                actions.appendChild(button);
            });
            card.append(heading, reason, preview, errorNode, actions);
            record.card = card;
            teamUiState.approvals.set(approvalId, record);
            if (approvalBelongsToCurrentConversation(record)) renderTeamApprovalLog(event);
            syncComposerApproval();

            function decide(decision) {
                if (record.deciding || record.status !== 'pending') return;
                if (Date.parse(record.expiresAt) <= Date.now()) return;
                record.deciding = true;
                errorNode.hidden = true;
                card.querySelectorAll('button').forEach(function(button) { button.disabled = true; });
                fetch('harness_api.php?action=approval', {
                    method: 'POST', credentials: 'same-origin',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
                    body: JSON.stringify({ session_id: record.runId, approval_id: approvalId,
                        decision: decision, project_path: record.projectPath })
                }).then(function(response) { return response.json(); }).then(function(result) {
                    if (!result.success) throw new Error(result.error || result.content || '确认失败');
                    const status = (result.data && result.data.status) || result.status ||
                        ((decision === 'allow_once' || decision === 'allow_always') ? 'allowed' : 'denied');
                    updateTeamApprovalCard(approvalId, status);
                    const challenge = payload.challenge || {};
                    if (event.source === 'harness' && challenge.url) {
                        const riskCategory = challenge.approval_kind === 'site' ? 'site_access'
                            : (challenge.approval_kind === 'tls' ? 'tls_exception' : (challenge.risk_category || ''));
                        browserPermissionRequest({ operation: 'record_confirmation', url: challenge.url,
                            session_id: record.runId, page_version: Number(challenge.page_version || 0),
                            action: challenge.action || '', risk_category: riskCategory, approval_token: approvalId,
                            status: status === 'allowed' ? 'approved' : 'denied'
                        }).catch(function(error) { console.warn('[browser-approval] 确认审计记录失败:', error.message); });
                        if (challenge.approval_kind === 'site' && (decision === 'allow_always' || decision === 'block')) {
                            browserPermissionRequest({ operation: 'set', url: challenge.url, decision: decision })
                                .catch(function(error) { console.warn('[browser-approval] 站点权限保存失败:', error.message); });
                        }
                    }
                    refreshComposerApprovals().catch(function() {});
                }).catch(function(error) {
                    if (record.status !== 'pending') return;
                    record.deciding = false;
                    errorNode.textContent = error.message;
                    errorNode.hidden = false;
                    syncComposerApproval();
                    refreshComposerApprovals().catch(function() {});
                });
            }
            const challenge = payload.challenge || {};
            if (record.status === 'pending' && event.source === 'harness' && challenge.approval_kind === 'site' && challenge.url) {
                browserPermissionRequest({ operation: 'check', url: challenge.url }, 'GET').then(function(saved) {
                    // Older persistent site grants never auto-approve a runtime operation.
                    if (saved.decision === 'block') decide('block');
                }).catch(function() {});
            }
        }

        // Recover approval state from Runtime, including after a full page refresh.
        // Only a snapshot is fetched: this never submits a message or replays a tool.
        async function refreshComposerApprovals() {
            const runtime = getConversationRuntime(currentChatId);
            const chat = getChatHistory().find(chat => String(chat.id) === String(runtime.chatId));
            const identity = runtime.composer?.projectPath || chat?.activeWorkspaceIdentity || '__default__';
            const projectPath = identity === '__default__' ? '' : identity;
            const workspace = encodeURIComponent(projectPath || '__default__');
            const sessionId = chat?.runtimeSessions?.[identity] || runtime.harnessSessionId || localStorage.getItem('moonya.harness.session.' + runtime.chatId + '.' + workspace)
                || localStorage.getItem('moonya.harness.session.' + (runtime.dbConversationId || runtime.chatId) + '.' + workspace);
            if (runtime.mode !== 'work' || !sessionId) return;
            runtime.harnessSessionId = sessionId;
            runtime.workspaceIdentity = identity;
            const generation = approvalStateGeneration;
            runtime.harnessSessionKey = 'moonya.harness.session.' + runtime.chatId + '.' + workspace;
            const response = await fetch('harness_api.php?action=approval_state&session_id=' + encodeURIComponent(sessionId)
                + '&project_path=' + encodeURIComponent(projectPath), { credentials: 'same-origin', headers: getAuthHeaders() });
            const result = await response.json();
            if (generation !== approvalStateGeneration || String(runtime.chatId) !== String(currentChatId || '__new__:' + currentConversationMode())) return;
            if (!result.success) throw new Error(result.error || '读取审批状态失败');
            if (Number(result.data.seq || 0) < (approvalServerSeq.get(sessionId) || 0)) return;
            approvalServerSeq.set(sessionId, Number(result.data.seq || 0));
            const events = result.data.events || [];
            const settled = new Map(events.filter(function(event) { return event.event === 'approval.decided'; })
                .map(function(event) { return [String(event.payload.approval_id), event.payload.status]; }));
            events.filter(function(event) { return event.event === 'approval.required'; }).forEach(function(event) {
                const id = String(event.payload.id);
                const status = settled.get(id) || event.payload.status || 'pending';
                const existing = teamUiState.approvals.get(id);
                if (existing) {
                    if (existing.status === 'pending' && status !== 'pending') updateTeamApprovalCard(id, status);
                    return;
                }
                handleTeamApproval(Object.assign({}, event, { source: 'harness', run_id: event.run_id || sessionId, root_run_id: sessionId,
                    chat_id: runtime.chatId, conversation_id: runtime.dbConversationId, project_path: projectPath,
                    payload: Object.assign({}, event.payload, { status: status }) }));
            });
            const presentIds = new Set(events.filter(function(event) { return event.event === 'approval.required'; })
                .map(function(event) { return String(event.payload.id); }));
            teamUiState.approvals.forEach(function(record) {
                if ((record.runId === sessionId || record.rootRunId === sessionId) && record.status === 'pending' && !presentIds.has(record.id)) {
                    updateTeamApprovalCard(record.id, 'expired');
                }
            });
            if (!runtime.abortController && runtime.dbConversationId && window.MoonYaSharedRuntime) {
                window.MoonYaSharedRuntime.request('approvalSnapshot', { conversationId: runtime.dbConversationId,
                    runId: sessionId, running: result.data.status === 'running', status: result.data.status,
                    pendingApprovals: currentPendingApprovals().map(function(record) { return record.event; })
                }).catch(function() {});
            }
            if (!runtime.abortController) {
                runtime.running = result.data.status === 'running';
                syncConversationFollow(runtime);
                runtime.activeRunId = runtime.running ? sessionId : null;
                window.isSendingMessage = runtime.running;
                if (runtime.running) ensureStopButtonVisible();
                else resetSendButton();
            }
            syncComposerApproval();
        }

        function activateComposerApprovals() {
            approvalStateGeneration += 1;
            if (approvalStatePoll) clearInterval(approvalStatePoll);
            approvalStatePoll = null;
            syncComposerApproval();
            teamUiState.approvals.forEach(function(record) {
                if (approvalBelongsToCurrentConversation(record)) renderTeamApprovalLog(record.event);
            });
            refreshComposerApprovals().catch(function(error) { console.warn('[approval-state]', error.message); });

        }

        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) {
                syncComposerApproval();
                refreshComposerApprovals().catch(function() {});
            }
        });

        function artifactSvgMarkup(kind) {
            const start = '<svg viewBox="0 0 24 24" aria-hidden="true">';
            const end = '</svg>';
            if (kind === 'image') {
                return start +
                    '<rect x="3" y="4" width="18" height="16" rx="2"></rect>' +
                    '<circle cx="9" cy="10" r="2"></circle>' +
                    '<path d="m5 17 4-4 3 3 2-2 5 4"></path>' +
                    end;
            }
            if (kind === 'video') {
                return start +
                    '<rect x="3" y="5" width="18" height="14" rx="2"></rect>' +
                    '<path d="m10 9 5 3-5 3Z"></path>' +
                    end;
            }
            if (kind === 'audio') {
                return start +
                    '<path d="M9 18V6l10-2v12"></path>' +
                    '<circle cx="6" cy="18" r="3"></circle>' +
                    '<circle cx="16" cy="16" r="3"></circle>' +
                    end;
            }
            if (kind === 'link') {
                return start +
                    '<path d="M14 5h5v5"></path><path d="m10 14 9-9"></path>' +
                    '<path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"></path>' +
                    end;
            }
            return start +
                '<path d="M6 3h8l4 4v14H6Z"></path>' +
                '<path d="M14 3v5h5"></path>' +
                (kind === 'office' ? '<path d="M9 12h6M9 16h6"></path>' : '') +
                (kind === 'pdf' ? '<path d="M9 13h6M9 17h4"></path>' : '') +
                end;
        }

        function addTeamArtifact(artifact, agentKey) {
            if (!artifact || !(artifact.id || artifact.uri)) return;
            const key = artifact.id || artifact.uri;
            artifact.agent_key = artifact.agent_key || agentKey || 'moonya';
            teamUiState.artifacts.set(key, artifact);
            renderTeamArtifacts();
        }

        function renderTeamArtifacts() {
            const list = document.getElementById('teamArtifactList');
            const count = document.getElementById('teamArtifactCount');
            if (count) count.textContent = String(teamUiState.artifacts.size);
            if (!list) return;
            list.innerHTML = '';
            if (!teamUiState.artifacts.size) {
                list.innerHTML = '<div class="detail-panel-empty"><strong>暂无产出物</strong><span>文件、链接和媒体会按 Agent 分组</span></div>';
                return;
            }
            const groups = new Map();
            teamUiState.artifacts.forEach(function(artifact) {
                const key = artifact.agent_key || 'moonya';
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(artifact);
            });
            groups.forEach(function(artifacts, agentKey) {
                const agent = teamAgent(agentKey);
                const section = document.createElement('section');
                section.className = 'team-artifact-group';
                const heading = document.createElement('div');
                heading.className = 'team-artifact-group-title';
                if (agent.avatar_url) {
                    const avatar = document.createElement('img');
                    avatar.src = agent.avatar_url;
                    avatar.alt = '';
                    heading.appendChild(avatar);
                }
                heading.appendChild(document.createTextNode(agent.display_name || agent.name || agentKey));
                section.appendChild(heading);
                artifacts.forEach(function(artifact) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'team-artifact-card';
                    const icon = document.createElement('span');
                    icon.className = 'team-artifact-icon';
                    icon.innerHTML = artifactSvgMarkup(artifact.kind);
                    const info = document.createElement('span');
                    const name = document.createElement('span');
                    name.className = 'team-artifact-name';
                    renderTeamPlainText(
                        name,
                        artifact.display_name || artifact.name ||
                            String(artifact.uri || '').split(/[\\/]/).pop() || '产出物'
                    );
                    const meta = document.createElement('span');
                    meta.className = 'team-artifact-meta';
                    meta.textContent = (artifact.mime_type || artifact.kind || '文件') +
                        (artifact.size_bytes ? ' · ' + Math.ceil(artifact.size_bytes / 1024) + ' KB' : '');
                    info.appendChild(name);
                    info.appendChild(meta);
                    const open = document.createElement('span');
                    open.className = 'team-artifact-open';
                    open.innerHTML = createWorkflowChevronIcon(14, 'right');
                    button.appendChild(icon);
                    button.appendChild(info);
                    button.appendChild(open);
                    button.addEventListener('click', function() { previewTeamArtifact(artifact); });
                    section.appendChild(button);
                });
                list.appendChild(section);
            });
        }

        function activateTeamTab(tabName) {
            document.querySelectorAll('[data-team-tab]').forEach(function(tab) {
                const selected = tab.dataset.teamTab === tabName;
                tab.classList.toggle('selected', selected);
                tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            });
            document.querySelectorAll('.team-panel-pane').forEach(function(pane) {
                const selected = pane.id === 'teamPane' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
                pane.classList.toggle('selected', selected);
                pane.hidden = !selected;
            });
        }

        function openArtifactNative(path) {
            if (!path) return;
            if (/^https?:\/\//i.test(path)) {
                window.open(path, '_blank', 'noopener,noreferrer');
                return;
            }
            if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync) return;
            CefSharp.BindObjectAsync('moonYaFileOps').then(function() {
                return window.moonYaFileOps.fileOp(JSON.stringify({ action: 'open_file', path: path }));
            });
        }

        function renderArtifactPreview(artifact, preview) {
            const pane = document.getElementById('teamPreview');
            if (!pane) return;
            pane.innerHTML = '';
            const card = document.createElement('div');
            card.className = 'team-preview-card';
            const header = document.createElement('div');
            header.className = 'team-preview-header';
            const title = document.createElement('div');
            title.className = 'team-preview-title';
            title.textContent = artifact.display_name || artifact.name || preview.name || '产出物';
            const nativeButton = document.createElement('button');
            nativeButton.type = 'button';
            nativeButton.className = 'team-preview-open-native';
            nativeButton.textContent = /^https?:\/\//i.test(artifact.uri || '') ? '打开链接' : '原生打开';
            nativeButton.addEventListener('click', function() { openArtifactNative(artifact.uri || artifact.local_path); });
            header.appendChild(title);
            header.appendChild(nativeButton);
            card.appendChild(header);
            if (!preview.ok) {
                const error = document.createElement('div');
                error.className = 'detail-panel-empty';
                error.textContent = (preview.error && preview.error.message) || '无法预览此产出物。';
                card.appendChild(error);
            } else if (preview.kind === 'image') {
                const image = document.createElement('img');
                image.className = 'team-preview-media';
                image.src = preview.data_url || artifact.uri;
                image.alt = title.textContent;
                card.appendChild(image);
            } else if (preview.kind === 'audio') {
                const audio = document.createElement('audio');
                audio.className = 'team-preview-media';
                audio.controls = true;
                audio.src = preview.data_url || artifact.uri;
                card.appendChild(audio);
            } else if (preview.kind === 'video') {
                const video = document.createElement('video');
                video.className = 'team-preview-media';
                video.controls = true;
                video.src = preview.data_url || artifact.uri;
                card.appendChild(video);
            } else if (preview.kind === 'pdf') {
                const frame = document.createElement('iframe');
                frame.className = 'team-preview-frame';
                frame.title = title.textContent;
                frame.sandbox = '';
                frame.src = preview.data_url || artifact.uri;
                card.appendChild(frame);
            } else if (preview.kind === 'text') {
                if (preview.mime === 'text/html') {
                    const htmlFrame = document.createElement('iframe');
                    htmlFrame.className = 'team-preview-frame';
                    htmlFrame.title = title.textContent;
                    htmlFrame.sandbox = '';
                    htmlFrame.srcdoc = preview.text || '';
                    card.appendChild(htmlFrame);
                } else {
                    const code = document.createElement('pre');
                    code.className = 'team-preview-code';
                    code.textContent = preview.text || '';
                    card.appendChild(code);
                }
            } else {
                const meta = document.createElement('div');
                meta.className = 'detail-panel-empty';
                meta.innerHTML = '<strong>使用原生应用预览</strong><span>此格式仅展示安全元数据，不在网页中执行内容</span>';
                card.appendChild(meta);
            }
            pane.appendChild(card);
        }

        function previewTeamArtifact(artifact) {
            activateTeamTab('preview');
            setDetailPanelOpen(true);
            const uri = artifact.uri || artifact.local_path || '';
            if (/^https?:\/\//i.test(uri)) {
                const kind = artifact.kind === 'image' ? 'image' :
                    (artifact.kind === 'video' ? 'video' : (artifact.kind === 'audio' ? 'audio' :
                    (artifact.kind === 'pdf' ? 'pdf' : 'unsupported')));
                renderArtifactPreview(artifact, { ok: true, kind: kind, data_url: uri, name: artifact.display_name });
                return;
            }
            if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync) {
                renderArtifactPreview(artifact, { ok: false, error: { message: '本地文件预览仅在 MoonYa 桌面端可用。' } });
                return;
            }
            CefSharp.BindObjectAsync('moonYaFileOps').then(function() {
                const roots = [];
                const projectPath = localStorage.getItem('moonya_work_project_path');
                if (projectPath) roots.push(projectPath);
                return window.moonYaFileOps.previewArtifact(uri, JSON.stringify(roots));
            }).then(function(raw) {
                renderArtifactPreview(artifact, typeof raw === 'string' ? JSON.parse(raw) : raw);
            }).catch(function(error) {
                renderArtifactPreview(artifact, { ok: false, error: { message: error.message } });
            });
        }

        function handleTeamEvent(event, options) {
            if (!event || !event.event) return;
            options = options || {};
            const runId = event.run_id || 'unknown';
            const seq = Number(event.seq || 0);
            const previous = teamUiState.eventSeq.get(runId) || 0;
            if (seq && seq <= previous) return;
            if (seq) teamUiState.eventSeq.set(runId, seq);
            teamUiState.activeRunId = runId;
            if (event.event === 'workspace/changes' && event.source === 'harness') {
                const record = turnProcessContainer(conversationTurnKey(event));
                const runtime = getConversationRuntime();
                window.MoonYaChanges.create(event.payload, record.message.querySelector('.message-content'), runtime);
                return;
            }
            if (event.event === 'workspace/changes.error' && event.source === 'harness') {
                const record = turnProcessContainer(conversationTurnKey(event));
                const warning = document.createElement('div'); warning.className = 'changes-status';
                warning.textContent = '本轮变更记录保存失败：' + (event.payload?.message || '请检查磁盘和工作区权限');
                record.message.querySelector('.message-content').append(warning);
                return;
            }
            if (event.event === 'run.started') {
                teamUiState.runStatus.set(runId, 'running');
                teamSetLive(true, '运行中');
            }
            if (event.source === 'harness' && event.event === 'agent.turn.started') {
                teamUiState.runStatus.set(runId, 'running');
                teamSetLive(true, '运行中');
                // ★ 本轮计时起点：过程区/收尾行的 startedAt 从这里取，"用时"才包含
                //   思考开始之前的那段准备时间。
                window.__moonyaTurnStartedAt = Date.now();
                // ★ 整个 harness 轮次都归 DSH 版式管：过程表头 + 末尾的收尾行。
                //   即使这一轮没有思考也没有工具调用（没有过程区），也不能退回
                //   气泡内的旧「本轮过程」表头，否则同一轮会多出第二个表头。
                window.__moonyaDshTurnProcess = true;
                turnProcessContainer(conversationTurnKey(event), event.timestamp ? Date.parse(event.timestamp) : Date.now());
            }
            if (event.event === 'run.completed') {
                const status = event.payload && event.payload.status;
                teamUiState.runStatus.set(runId, status || 'completed');
                const text = status === 'failed'
                    ? '失败'
                    : (status === 'partial' ? '部分完成' :
                        (status === 'cancelled' ? '已停止' : '已完成'));
                teamSetLive(false, text);
                if (status === 'cancelled') renderTeamCancellation(runId);
                // ★ 主对话过程区收尾（run 级结束时兜底刷新用时）
                turnProcessNodes.forEach(function(record, key) {
                    if (String(key).indexOf(String(runId)) === 0) markTurnProcessElapsed(key, status);
                });
            }
            if (event.source === 'harness' && event.event === 'agent.turn.completed') {
                teamUiState.runStatus.set(runId, 'completed');
                teamSetLive(false, '已完成');
                // ★ 主对话过程区收尾：用时写回过程折叠栏
                markTurnProcessElapsed(conversationTurnKey(event));
                const turnKey = conversationTurnKey(event);
                if (!turnProcessNodes.has(turnKey)) {
                    const turnStart = Number(window.__moonyaTurnStartedAt) || 0;
                    const record = turnProcessContainer(turnKey, turnStart || Date.now());
                    if (turnStart) record.startedAt = turnStart;
                    markTurnProcessElapsed(turnKey, 'completed');
                }
            }
            if (event.source === 'harness' &&
                (event.event === 'turn.cancelled' || event.event === 'turn.interrupted' || event.event === 'session.error')) {
                const outcome = event.event === 'session.error' ? 'failed' :
                    (event.event === 'turn.cancelled' ? 'cancelled' : 'interrupted');
                markTurnProcessElapsed(conversationTurnKey(event), outcome);
                settleComposerApprovals(runId, outcome === 'cancelled' ? 'cancelled' : 'expired');
                teamUiState.runStatus.set(runId, outcome);
                teamSetLive(false, outcome === 'failed' ? '失败' : '已停止');
            }
            if (event.event === 'agent.waiting') {
                const state = event.payload && event.payload.state;
                const waitingLabel = state === 'model_thinking' ? '模型正在思考' :
                    (state === 'waiting_approval' ? '等待确认' :
                        (state === 'waiting_resource' ? '等待资源' : '正在等待'));
                teamSetLive(true, waitingLabel);
            } else if (event.event === 'tool.progress') {
                teamSetLive(true, '后台运行');
            } else if (event.event === 'approval.required') {
                teamSetLive(true, '等待确认');
            } else if (event.event === 'user_action.required') {
                teamSetLive(true, '等待用户操作');
            } else if (event.event === 'agent.loop.detected') {
                teamSetLive(true, '正在纠偏');
            }
            renderTeamEvent(event, options);
            if (options.history && event.event === 'assistant.completed' &&
                event.payload && event.payload.content) {
                const expected = String(event.payload.content).replace(/\s+/g, ' ').trim();
                const legacyMessages = Array.from(document.querySelectorAll('.message.ai .message-content'));
                for (let index = legacyMessages.length - 1; index >= 0; index--) {
                    const actual = String(legacyMessages[index].textContent || '').replace(/\s+/g, ' ').trim();
                    if (actual === expected) {
                        const wrapper = legacyMessages[index].closest('.message.ai');
                        if (wrapper) wrapper.remove();
                        break;
                    }
                }
            }
            if (event.event === 'approval.required' || event.event === 'approval.decided') {
                handleTeamApproval(event);
            }
            if (event.event === 'user_action.required' || event.event === 'user_action.decided') {
                handleUserAction(event);
            }
            if (event.source === 'harness' &&
                (event.event === 'turn.cancelled' || event.event === 'turn.interrupted' || event.event === 'session.error')) {
                closeUserActionCard();
            }
            if (event.event === 'artifact.created') addTeamArtifact(event.payload, (event.agent && event.agent.key) || event.agent_key);
        }

        function setTeamApprovalMode(mode, persist) {
            if (persist) return changeTeamApprovalMode(mode);
            const aliases = {
                full_access: 'full_access',
                high_risk_only: 'high_risk',
                high_risk: 'high_risk',
                always_confirm_changes: 'confirm_writes',
                confirm_writes: 'confirm_writes'
            };
            const normalized = aliases[mode] || 'confirm_writes';
            const uiMode = normalized === 'high_risk' ? 'high_risk_only' :
                (normalized === 'confirm_writes' ? 'always_confirm_changes' : 'full_access');
            const labels = {
                full_access: '完全访问权限',
                high_risk_only: '帮我批准',
                always_confirm_changes: '请求批准'
            };
            // 触发条用短标签；菜单项仍显示完整名称（完全访问权限）
            const triggerLabels = {
                full_access: '完全访问',
                high_risk_only: '帮我批准',
                always_confirm_changes: '请求批准'
            };
            teamUiState.approvalMode = normalized;
            document.querySelectorAll('[data-approval-mode]').forEach(function(item) {
                const selected = item.dataset.approvalMode === uiMode;
                item.classList.toggle('selected', selected);
                item.setAttribute('aria-checked', selected ? 'true' : 'false');
            });
            const text = document.getElementById('approvalModeButtonText');
            const button = document.getElementById('approvalModeButton');
            if (text) text.textContent = triggerLabels[uiMode];
            if (button) {
                button.setAttribute('aria-label', '工具权限：' + labels[uiMode]);
                // 图标与配色随模式切换：请求批准（手）/ 帮我批准（盾+终端）/ 完全访问（橙色盾+感叹号）
                button.classList.toggle('mode-always-confirm', uiMode === 'always_confirm_changes');
                button.classList.toggle('mode-high-risk', uiMode === 'high_risk_only');
                button.classList.toggle('mode-full-access', uiMode === 'full_access');
            }
            return Promise.resolve();
        }

        function changeTeamApprovalMode(value) {
            const runtime = getConversationRuntime(currentChatId);
            if (runtime.permissionUpdate) return runtime.permissionUpdate;
            const normalized = window.MoonYaPermissions.normalize(value);
            let previous = runtime.approvalMode || 'confirm_writes';
            let previousComposer;
            const permissionDraft = composer => ({ draft: runtime.draft, uploadedImages: runtime.uploadedImages,
                localPaths: runtime.localPaths, composer, scrollTop: runtime.scrollTop, mode: runtime.mode });
            const controls = document.querySelectorAll('#approvalModeSelector button');
            controls.forEach(item => { item.disabled = true; });
            const update = (async function() {
                await restoreConversationDraft(runtime);
                previous = runtime.approvalMode || 'confirm_writes';
                previousComposer = runtime.composer || snapshotConversationComposer(runtime);
                const composer = Object.assign({}, previousComposer, { approvalMode: normalized });
                if (await window.MoonYaHistoryStore.saveDraft(runtime.historyScope, runtime.chatId, permissionDraft(composer)) === false) {
                    throw new Error('本机权限保存失败，已保留原权限');
                }
                const chat = window.MoonYaHistoryStore.list(runtime.historyScope).find(item => String(item.id) === String(runtime.chatId));
                let sessionId = runtime.harnessSessionId;
                let workspace = runtime.workspaceIdentity || '__default__';
                if (!sessionId) {
                    const entry = Object.entries(chat?.runtimeSessions || {}).find(([, id]) => !!id);
                    if (entry) [workspace, sessionId] = entry;
                }
                if (sessionId) {
                    const response = await fetch('harness_api.php?action=permissions', {
                        method: 'POST', credentials: 'same-origin',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
                        body: JSON.stringify({ session_id: sessionId, client_chat_id: runtime.chatId,
                            project_path: workspace === '__default__' ? '' : workspace, approval_mode: normalized })
                    });
                    const result = await response.json();
                    if (!response.ok || result.success !== true) throw new Error(result.error || '权限更新失败');
                }
                runtime.approvalMode = normalized;
                runtime.composer = composer;
                if (runtime.container.dataset.runtimeActive === '1') setTeamApprovalMode(normalized, false);
                return normalized;
            })().catch(async function(error) {
                if (previousComposer) {
                    // Also replace the store's pending retry snapshot if its first write failed.
                    await window.MoonYaHistoryStore.saveDraft(runtime.historyScope, runtime.chatId,
                        permissionDraft(Object.assign({}, previousComposer, { approvalMode: previous })));
                }
                if (runtime.container.dataset.runtimeActive === '1') setTeamApprovalMode(runtime.approvalMode || previous, false);
                showToast(error.message || '权限更新失败，已保留原权限');
                return previous;
            }).finally(function() {
                controls.forEach(item => { item.disabled = false; });
                runtime.permissionUpdate = null;
            });
            runtime.permissionUpdate = update;
            return update;
        }

        function configureNativeMcp() {
            return Promise.resolve();
        }

        function renderMcpConnections(connections) {
            const list = document.getElementById('mcpConnectionList');
            if (!list) return;
            list.innerHTML = '';
            if (!connections || !connections.length) {
                list.innerHTML = '<span class="mcp-connection-empty">暂无已启用的 MCP 服务</span>';
                return;
            }
            connections.forEach(function(connection) {
                const row = document.createElement('div');
                row.className = 'mcp-connection-row';
                const info = document.createElement('div');
                info.className = 'mcp-connection-name';
                info.textContent = connection.display_name || connection.server_key;
                const state = document.createElement('span');
                state.className = 'mcp-connection-state';
                const connected = connection.connection_status === 'connected';
                state.textContent = connected ? '已连接' :
                    (connection.connection_status === 'error' ? '连接异常' : '未连接');
                info.appendChild(state);
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = connected ? '断开' : '连接';
                button.addEventListener('click', function(event) {
                    event.stopPropagation();
                    button.disabled = true;
                    button.textContent = connected ? '断开中…' : '连接中…';
                    const action = connected ? revokeMcpConnection(connection) : connectMcpConnection(connection);
                    action.catch(function(error) {
                        if (typeof showToast === 'function') showToast(error.message);
                    }).finally(function() {
                        button.disabled = false;
                    });
                });
                row.append(info, button);
                list.appendChild(row);
            });
        }

        function updateMcpConnectionState(connection, status, metadata, error) {
            return Promise.reject(new Error('多 Agent MCP 连接已移除'));
        }

        function connectMcpConnection(connection) {
            if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync || !teamUiState.userId) {
                return Promise.reject(new Error('MCP 账号连接需要 MoonYa 桌面端。'));
            }
            return CefSharp.BindObjectAsync('moonYaFileOps').then(function() {
                return updateMcpConnectionState(connection, 'authorizing', {}, null);
            }).then(function() {
                return window.moonYaFileOps.mcpOp(JSON.stringify({
                    action: 'list_tools',
                    user_id: teamUiState.userId,
                    server_key: connection.server_key,
                    timeout_seconds: 240
                }));
            }).then(function(raw) {
                const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (!result.ok) throw new Error((result.error && result.error.message) || result.content || 'MCP 连接失败');
                return updateMcpConnectionState(connection, 'connected', result.metadata || {}, null);
            }).then(function() {
                return bootstrapTeamUi();
            }).catch(function(error) {
                updateMcpConnectionState(connection, 'error', {}, error.message).finally(function() { bootstrapTeamUi(); });
                if (typeof showToast === 'function') showToast(error.message);
            });
        }

        function revokeMcpConnection(connection) {
            if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync || !teamUiState.userId) {
                return Promise.reject(new Error('MCP 账号断开需要 MoonYa 桌面端。'));
            }
            return CefSharp.BindObjectAsync('moonYaFileOps').then(function() {
                return window.moonYaFileOps.mcpOp(JSON.stringify({
                    action: 'revoke',
                    user_id: teamUiState.userId,
                    server_key: connection.server_key
                }));
            }).then(function(raw) {
                const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (!result.ok) throw new Error((result.error && result.error.message) || '撤销失败');
                return updateMcpConnectionState(connection, 'disconnected', result, null);
            }).then(function() {
                return bootstrapTeamUi();
            }).catch(function(error) {
                if (typeof showToast === 'function') showToast(error.message);
            });
        }

        function loadTeamHistory(conversationId) {
            return Promise.resolve();
        }

        function bootstrapTeamUi() {
            return Promise.resolve();
        }

        window.MoonYaTeam = {
            handleEvent: handleTeamEvent,
            refreshConversation: function() {
                const nextConversation = Number(currentDbConversationId || 0);
                if (teamUiState.historyConversationId !== null &&
                    teamUiState.historyConversationId !== nextConversation) {
                    resetTeamPanel();
                } else {
                    teamUiState.historyConversationId = null;
                }
                return bootstrapTeamUi();
            },
            previewArtifact: previewTeamArtifact
        };
        if (window.MoonYaSubagentChat) window.MoonYaSubagentChat.configure({
            renderMarkdown: renderTeamMarkdown,
            icon: makeProcessRowIcon,
            renderTool: renderCodexToolDetail
        });
        // 将一条 tool_detail 事件追加到右侧面板
        function appendToolDetail(data) {
            const content = document.getElementById('detailPanelContent');
            if (!content) return;
            // 移除空状态占位
            const empty = document.getElementById('detailPanelEmpty');
            if (empty) empty.remove();

            const entry = document.createElement('div');
            entry.className = 'detail-entry';

            const isSuccess = (data.result === '成功' || data.result === 'success');
            const resultClass = isSuccess ? 'success' : 'failure';

            const header = document.createElement('div');
            header.className = 'detail-entry-header';
            header.innerHTML =
                '<span class="detail-entry-icon">' + escapeDetailText(data.icon || '') + '</span>' +
                '<span class="detail-entry-name">' + escapeDetailText(data.name || data.operation || '') + '</span>' +
                '<span class="detail-entry-time">' + formatDetailTime(data.timestamp) + '</span>';
            entry.appendChild(header);

            const rows = [
                { key: '操作', val: data.operation },
                { key: data.label || '路径', val: data.value, mono: true },
                { key: '结果', val: data.result, cls: resultClass },
                { key: '详情', val: data.detail }
            ];
            rows.forEach(function(r) {
                if (r.val === null || r.val === undefined || r.val === '') return;
                const row = document.createElement('div');
                row.className = 'detail-entry-row';
                const key = document.createElement('span');
                key.className = 'detail-entry-key';
                key.textContent = r.key;
                const val = document.createElement('span');
                val.className = 'detail-entry-val' + (r.cls ? ' ' + r.cls : '') + (r.mono ? ' mono' : '');
                val.textContent = r.val;
                row.appendChild(key);
                row.appendChild(val);
                entry.appendChild(row);
            });

            // ★ 浏览器自动化截图：渲染缩略图，点击放大查看
            if (data.screenshot && typeof data.screenshot === 'string' && data.screenshot.length > 0) {
                const shotWrap = document.createElement('div');
                shotWrap.className = 'detail-entry-screenshot';
                shotWrap.dataset.tooltip = '点击查看大图';
                const img = document.createElement('img');
                img.src = 'data:image/png;base64,' + data.screenshot;
                img.alt = '操作截图';
                img.addEventListener('error', function() { shotWrap.style.display = 'none'; });
                shotWrap.appendChild(img);
                shotWrap.addEventListener('click', function() {
                    openDetailLightbox(img.src);
                });
                entry.appendChild(shotWrap);
            }

            content.appendChild(entry);
            // 只有用户原本位于底部时才跟随；向上阅读时不抢夺滚动位置。
            teamScrollIfFollowing(content);

            // 面板展开状态完全由用户控制；任何新事件都不能自动打开。
        }
        // ★ 详情截图灯箱：全屏查看浏览器自动化截图
        function ensureDetailLightbox() {
            let lb = document.getElementById('detailLightbox');
            if (!lb) {
                lb = document.createElement('div');
                lb.id = 'detailLightbox';
                lb.className = 'detail-lightbox';
                lb.setAttribute('aria-hidden', 'true');
                lb.innerHTML =
                    '<div class="detail-lightbox-overlay"></div>' +
                    '<button type="button" class="detail-lightbox-close" aria-label="关闭">×</button>' +
                    '<img class="detail-lightbox-img" src="" alt="截图预览" />';
                document.body.appendChild(lb);
                lb.querySelector('.detail-lightbox-overlay').addEventListener('click', closeDetailLightbox);
                lb.querySelector('.detail-lightbox-close').addEventListener('click', closeDetailLightbox);
                document.addEventListener('keydown', function(e) {
                    const box = document.getElementById('detailLightbox');
                    if (!box || box.getAttribute('aria-hidden') === 'true') return;
                    if (e.key === 'Escape') closeDetailLightbox();
                });
            }
            return lb;
        }
        function openDetailLightbox(src) {
            const lb = ensureDetailLightbox();
            const img = lb.querySelector('.detail-lightbox-img');
            if (img) img.src = src;
            lb.classList.add('show');
            lb.setAttribute('aria-hidden', 'false');
        }
        function closeDetailLightbox() {
            const lb = document.getElementById('detailLightbox');
            if (!lb) return;
            lb.classList.remove('show');
            lb.setAttribute('aria-hidden', 'true');
        }
        const TEAM_PANEL_OPEN_STORAGE_KEY = 'moonya.team.panel.open.v1';
        function setDetailPanelOpen(open, persist) {
            const panel = document.getElementById('detailPanel');
            const toggle = document.getElementById('detailToggleContainer');
            const resizer = document.getElementById('detailPanelResizer');
            // toggle 已随顶部工具栏改造从页面移除（桌面端由原生标题栏承担），
            // 这里只作为可选的激活态标记处理，不能因为它缺失而放弃开合面板。
            if (!panel) return;
            if (open) {
                panel.classList.add('open');
                panel.setAttribute('aria-hidden', 'false');
                if (toggle) toggle.classList.add('active');
                document.body.classList.add('detail-panel-open');
            } else {
                panel.classList.remove('open');
                panel.setAttribute('aria-hidden', 'true');
                if (toggle) toggle.classList.remove('active');
                document.body.classList.remove('detail-panel-open');
            }
            if (resizer) {
                resizer.tabIndex = open ? 0 : -1;
                resizer.setAttribute('aria-hidden', open ? 'false' : 'true');
            }
            if (persist !== false) {
                try {
                    localStorage.setItem(TEAM_PANEL_OPEN_STORAGE_KEY, open ? '1' : '0');
                } catch (storageError) {}
            }
            if (window.moonyaSplitLayout && typeof window.moonyaSplitLayout.sync === 'function') {
                window.moonyaSplitLayout.sync();
            }
        }
        // 暴露给其他脚本块（script-1d-dom 的 moonyaTitlebar / script-6 的浏览器面板）复用，
        // 替代已不存在的 #detailToggleContainer 点击入口。
        window.moonyaSetDetailPanelOpen = setDetailPanelOpen;
        function resetTeamPanel(options) {
            options = options || {};
            // clearConversation=true（默认）：同时清空 AI 对话区域的团队消息卡片（用于新建对话/切换会话）
            // clearConversation=false：仅清空工作面板日志与产出物，不影响 AI 对话区域（用于工作面板"清空"按钮）
            const clearConversation = options.clearConversation !== false;
            const content = document.getElementById('detailPanelContent');
            if (content) {
                content.innerHTML =
                    '<div class="detail-panel-empty" id="detailPanelEmpty">' +
                    '<span class="team-empty-icon" aria-hidden="true">' + window.MoonYaIcons.icon('briefcase') + '</span>' +
                    '<strong>团队尚未开始工作</strong>' +
                    '<span>FarSide 或电脑操作任务的执行过程会显示在这里</span></div>';
                const followState = teamFollowController(content);
                if (followState) {
                    followState.following = true;
                    if (followState.button) followState.button.hidden = true;
                }
            }
            teamUiState.artifacts.clear();
            teamUiState.eventSeq.clear();
            teamUiState.turns.clear();
            teamUiState.tools.clear();
            // Pending approvals survive clearing logs and switching conversations.
            syncComposerApproval();
            teamUiState.logNodes.clear();
            teamUiState.runStatus.clear();
            teamUiState.synthesisRuns.clear();
            teamUiState.stoppedRuns.clear();
            teamUiState.projectGroups.clear();
            teamUiState.projectActors.clear();
            teamUiState.projectTaskActors.clear();
            if (clearConversation) {
                // 仅在完整重置时清理与会话绑定的状态与 DOM，避免工作面板清空后产生状态不一致
                teamUiState.presentationRecords.forEach(function(record) {
                    if (record && record.timer) window.clearInterval(record.timer);
                });
                teamUiState.presentationRecords.clear();
                teamUiState.activePresentation.clear();
                teamUiState.activeRunId = null;
                teamUiState.historyConversationId = null;
                document.querySelectorAll('.team-agent-message').forEach(function(card) { card.remove(); });
            }
            // 主对话过程区与右侧日志同源，两种重置都清掉
            resetTurnProcessNodes();
            renderTeamArtifacts();
            teamSetLive(false, '待命');
        }
        (function initDetailPanel() {
            const toggle = document.getElementById('detailToggleContainer');
            const clearBtn = document.getElementById('detailPanelClear');
            const closeBtn = document.getElementById('detailPanelClose');
            const approvalSelector = document.getElementById('approvalModeSelector');
            const activeFeatureBadges = document.getElementById('activeFeatureBadges');
            const approvalButton = document.getElementById('approvalModeButton');
            const inputLeft = document.querySelector('.input-bottom-left');
            const fileInput = document.getElementById('fileInput');
            // Keep the existing permission state/listeners while placing its
            // trigger directly after the upload “+” control.
            if (inputLeft && fileInput && approvalSelector && approvalSelector.parentElement !== inputLeft) {
                fileInput.insertAdjacentElement('afterend', approvalSelector);
            }
            if (inputLeft && approvalSelector && activeFeatureBadges
                && activeFeatureBadges.previousElementSibling !== approvalSelector) {
                approvalSelector.insertAdjacentElement('afterend', activeFeatureBadges);
            }
            let restoreOpen = false;
            try {
                restoreOpen = localStorage.getItem(TEAM_PANEL_OPEN_STORAGE_KEY) === '1';
            } catch (storageError) {}
            setDetailPanelOpen(restoreOpen, false);
            teamFollowController(document.querySelector('.messages-container'), '主对话有新内容 · 回到底部');
            teamFollowController(document.getElementById('detailPanelContent'), '工作日志有新内容 · 回到底部');
            if (toggle) {
                toggle.addEventListener('click', function() {
                    const panel = document.getElementById('detailPanel');
                    if (!panel) return;
                    setDetailPanelOpen(!panel.classList.contains('open'));
                });
            }
            if (closeBtn) {
                closeBtn.addEventListener('click', function() { setDetailPanelOpen(false); });
            }
            if (clearBtn) {
                clearBtn.addEventListener('click', function() { resetTeamPanel({ clearConversation: false }); });
            }
            document.querySelectorAll('[data-team-tab]').forEach(function(tab) {
                tab.addEventListener('click', function() { activateTeamTab(tab.dataset.teamTab); });
                tab.addEventListener('keydown', function(event) {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const tabs = Array.from(document.querySelectorAll('[data-team-tab]'));
                    const offset = event.key === 'ArrowRight' ? 1 : -1;
                    const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
                    next.focus();
                    activateTeamTab(next.dataset.teamTab);
                });
            });
            if (approvalButton && approvalSelector) {
                function positionApprovalMenu() {
                    const menu = document.getElementById('approvalModeMenu');
                    if (!menu) return;
                    const railRight = document.querySelector('.app-rail')?.getBoundingClientRect().right || 0;
                    const margin = Math.max(12, railRight + 12);
                    menu.style.maxWidth = Math.max(0, window.innerWidth - margin - 12) + 'px';
                    const left = approvalSelector.getBoundingClientRect().left;
                    menu.style.left = Math.max(margin - left, Math.min(0, window.innerWidth - 12 - left - menu.offsetWidth)) + 'px';
                }
                approvalSelector.addEventListener('keydown', function(event) {
                    if (event.key === 'Escape' && approvalSelector.classList.contains('open')) {
                        event.preventDefault();
                        event.stopPropagation();
                        approvalSelector.classList.remove('open');
                        approvalButton.setAttribute('aria-expanded', 'false');
                        approvalButton.focus();
                    }
                });
                window.addEventListener('resize', positionApprovalMenu);
                document.addEventListener('keydown', function(event) {
                    if (event.key === 'Escape' && approvalSelector.classList.contains('open')) {
                        event.preventDefault();
                        approvalSelector.classList.remove('open');
                        approvalButton.setAttribute('aria-expanded', 'false');
                        approvalButton.focus();
                    }
                });
                approvalButton.addEventListener('click', function(event) {
                    event.stopPropagation();
                    const open = approvalSelector.classList.toggle('open');
                    approvalButton.setAttribute('aria-expanded', open ? 'true' : 'false');
                    if (open) positionApprovalMenu();
                });
                approvalButton.addEventListener('keydown', function(event) {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        approvalSelector.classList.add('open');
                        approvalButton.setAttribute('aria-expanded', 'true');
                        positionApprovalMenu();
                        const items = approvalSelector.querySelectorAll('[data-approval-mode]');
                        if (items.length) items[event.key === 'ArrowDown' ? 0 : items.length - 1].focus();
                    }
                });
                approvalSelector.querySelectorAll('[data-approval-mode]').forEach(function(item, index, items) {
                    item.addEventListener('click', function() {
                        setTeamApprovalMode(item.dataset.approvalMode, true);
                        approvalSelector.classList.remove('open');
                        approvalButton.setAttribute('aria-expanded', 'false');
                        approvalButton.focus();
                    });
                    item.addEventListener('keydown', function(event) {
                        if (event.key === 'Escape') {
                            approvalSelector.classList.remove('open');
                            approvalButton.setAttribute('aria-expanded', 'false');
                            approvalButton.focus();
                        }
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            const offset = event.key === 'ArrowDown' ? 1 : -1;
                            items[(index + offset + items.length) % items.length].focus();
                        }
                    });
                });
                document.addEventListener('click', function(event) {
                    if (!approvalSelector.contains(event.target)) {
                        approvalSelector.classList.remove('open');
                        approvalButton.setAttribute('aria-expanded', 'false');
                    }
                });
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', function() {
                    bootstrapTeamUi();
                    // 新会话开始时清空详情面板
                    const newChatBtn = document.getElementById('moreMenuNewChat');
                    if (newChatBtn) {
                        newChatBtn.addEventListener('click', resetTeamPanel);
                    }
                });
            } else {
                bootstrapTeamUi();
                const newChatBtn = document.getElementById('moreMenuNewChat');
                if (newChatBtn) {
                    newChatBtn.addEventListener('click', resetTeamPanel);
                }
            }
        })();

        // ========== Browser Automation 控制面板 ==========
        // 任务：渲染 BA / VLS 相关 SSE 事件，提供"重新分析页面 / 停止浏览器"按钮
        // 约束：
        //   - 仅在 Work 模式显示
        //   - 文件操作状态累加到时间线，不覆盖
        //   - UI 文本用 data-i18n 属性本地化
        //   - 右键菜单保留原生复制行为（.message-content, input, textarea, pre, code 已在 setupContextMenu 中放行）
        //   - 隐藏覆盖层 pointer-events: none
        (function initBrowserAutomationPanel() {
            // 注入样式（一次性，避免重复）
            function injectStyles() {
                if (document.getElementById('ba-panel-styles')) return;
                const style = document.createElement('style');
                style.id = 'ba-panel-styles';
                style.textContent = `
                /* BA 面板主容器：固定在右侧底部，浮动卡片样式 */
                .ba-panel {
                    position: fixed;
                    right: 16px;
                    bottom: 96px;
                    width: 360px;
                    max-width: calc(100vw - 32px);
                    max-height: 60vh;
                    display: none;
                    flex-direction: column;
                    background: var(--theme-surface, #ffffff);
                    border: 1px solid #e5e7eb;
                    border-radius: 12px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
                    z-index: 9000;
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
                    color: var(--theme-text, #1f2937);
                }
                .ba-panel.show { display: flex; }
                /* 顶部标题栏 */
                .ba-panel-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 14px;
                    background: var(--theme-accent-soft, #f9fafb);
                    border-bottom: 1px solid #e5e7eb;
                    flex-shrink: 0;
                }
                .ba-panel-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--theme-accent-text, #111827);
                }
                .ba-panel-close {
                    background: transparent;
                    border: none;
                    color: var(--theme-muted, #9ca3af);
                    font-size: 20px;
                    line-height: 1;
                    cursor: pointer;
                    padding: 2px 6px;
                    border-radius: 6px;
                    transition: background 0.2s ease, color 0.2s ease;
                }
                .ba-panel-close:hover {
                    background: var(--theme-accent-soft, #f1f3f4);
                    color: var(--theme-text, #374151);
                }
                /* 主体内容：可滚动 */
                .ba-panel-body {
                    flex: 1;
                    min-height: 0;
                    overflow-y: auto;
                    padding: 10px 14px;
                    scrollbar-width: thin;
                }
                .ba-panel-body::-webkit-scrollbar { width: 6px; }
                .ba-panel-body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
                /* 分区 */
                .ba-section { margin-bottom: 12px; }
                .ba-section:last-child { margin-bottom: 0; }
                .ba-section-title {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--theme-secondary, #6b7280);
                    margin-bottom: 6px;
                    text-transform: uppercase;
                    letter-spacing: 0.4px;
                }
                /* 截图缩略图列表：横向滚动 */
                .ba-screenshots {
                    display: flex;
                    gap: 6px;
                    overflow-x: auto;
                    padding-bottom: 4px;
                    scrollbar-width: thin;
                }
                .ba-screenshots::-webkit-scrollbar { height: 6px; }
                .ba-screenshots::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
                .ba-screenshot-thumb {
                    flex-shrink: 0;
                    width: 120px;
                    height: 80px;
                    object-fit: cover;
                    border-radius: 6px;
                    cursor: pointer;
                    border: 1px solid #e5e7eb;
                    transition: transform 0.2s ease, box-shadow 0.2s ease;
                    background: var(--theme-accent-soft, #f3f4f6);
                }
                .ba-screenshot-thumb:hover {
                    transform: scale(1.04);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
                }
                /* 状态时间线：纵向滚动，固定高度 */
                .ba-status-timeline {
                    max-height: 200px;
                    overflow-y: auto;
                    background: var(--theme-accent-soft, #f9fafb);
                    border: 1px solid #f3f4f6;
                    border-radius: 6px;
                    padding: 6px 8px;
                    font-size: 12px;
                    line-height: 1.6;
                    scrollbar-width: thin;
                }
                .ba-status-timeline::-webkit-scrollbar { width: 6px; }
                .ba-status-timeline::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
                .ba-status-line {
                    color: var(--theme-secondary, #4b5563);
                    word-break: break-all;
                    padding: 1px 0;
                }
                .ba-status-line .ba-status-time {
                    color: var(--theme-muted, #9ca3af);
                    margin-right: 4px;
                }
                .ba-status-line.ba-status-error {
                    color: var(--theme-danger, #dc2626);
                }
                /* VLS 分析卡片 */
                .ba-vls-container { display: flex; flex-direction: column; gap: 8px; }
                .vls-card {
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    padding: 10px 12px;
                    background: var(--theme-surface, #ffffff);
                    font-size: 12px;
                    color: var(--theme-text, #1f2937);
                }
                .vls-card-summary {
                    color: var(--theme-text, #374151);
                    margin-bottom: 8px;
                    line-height: 1.6;
                    word-break: break-word;
                }
                .vls-card-elements {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    margin-bottom: 8px;
                }
                .vls-element-row {
                    display: grid;
                    grid-template-columns: 70px 1fr;
                    gap: 6px;
                    padding: 3px 0;
                    border-bottom: 1px dashed #f3f4f6;
                    font-size: 11px;
                }
                .vls-element-row:last-child { border-bottom: none; }
                .vls-element-key {
                    color: var(--theme-secondary, #6b7280);
                    font-weight: 500;
                }
                .vls-element-val {
                    color: var(--theme-text, #1f2937);
                    word-break: break-all;
                }
                .vls-element-type {
                    display: inline-block;
                    padding: 1px 6px;
                    background: var(--theme-accent-soft, #eef2ff);
                    color: var(--theme-accent-text, #4338ca);
                    border-radius: 4px;
                    font-size: 10px;
                    font-weight: 600;
                    margin-right: 4px;
                }
                .vls-card-action {
                    margin-top: 6px;
                    padding: 6px 8px;
                    background: var(--theme-warning-soft, #fef3c7);
                    border-left: 3px solid #f59e0b;
                    border-radius: 4px;
                    color: var(--theme-warning, #92400e);
                    font-size: 11px;
                    line-height: 1.5;
                    word-break: break-word;
                }
                /* 主对话区域内的 VLS 摘要卡片（保持 message-content 可复制） */
                .vls-summary-card {
                    margin-top: 8px;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    padding: 10px 12px;
                    background: var(--theme-surface, #ffffff);
                    font-size: 13px;
                }
                /* 空状态提示 */
                .ba-empty {
                    color: var(--theme-muted, #9ca3af);
                    font-size: 12px;
                    text-align: center;
                    padding: 8px 0;
                }
                /* 底部按钮区 */
                .ba-panel-footer {
                    display: flex;
                    gap: 8px;
                    padding: 10px 14px;
                    background: var(--theme-accent-soft, #f9fafb);
                    border-top: 1px solid #e5e7eb;
                    flex-shrink: 0;
                }
                .ba-btn {
                    flex: 1;
                    padding: 6px 10px;
                    font-size: 12px;
                    border-radius: 6px;
                    border: 1px solid transparent;
                    cursor: pointer;
                    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
                    font-family: inherit;
                }
                .ba-btn:disabled { opacity: 0.55; cursor: not-allowed; }
                .ba-btn-secondary {
                    background: var(--theme-surface, #ffffff);
                    border-color: var(--theme-border, #d1d5db);
                    color: var(--theme-text, #374151);
                }
                .ba-btn-secondary:hover:not(:disabled) {
                    background: var(--theme-accent-soft, #f3f4f6);
                    border-color: var(--theme-border, #9ca3af);
                }
                .ba-btn-danger {
                    background: var(--theme-danger-soft, #fef2f2);
                    border-color: #fecaca;
                    color: var(--theme-danger, #b91c1c);
                }
                .ba-btn-danger:hover:not(:disabled) {
                    background: var(--theme-danger-soft, #fee2e2);
                    border-color: #f87171;
                }
                /* 浮动切换按钮（仅 agent/CU 模式可见） */
                .ba-toggle-btn {
                    position: fixed;
                    right: 16px;
                    bottom: 56px;
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    background: #4338ca;
                    color: #ffffff;
                    border: none;
                    cursor: pointer;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 4px 12px rgba(67, 56, 202, 0.4);
                    z-index: 8999;
                    transition: transform 0.2s ease, background 0.2s ease;
                }
                .ba-toggle-btn.show { display: flex; }
                .ba-toggle-btn:hover { transform: scale(1.08); background: #4f46e5; }
                .ba-toggle-btn svg { display: block; }
                /* BA 全屏灯箱（截图放大查看） */
                .ba-lightbox {
                    position: fixed;
                    inset: 0;
                    z-index: 9999;
                    display: none;
                    align-items: center;
                    justify-content: center;
                }
                .ba-lightbox.show { display: flex; }
                .ba-lightbox-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0, 0, 0, 0.9);
                }
                .ba-lightbox-img {
                    position: relative;
                    max-width: 90vw;
                    max-height: 85vh;
                    object-fit: contain;
                    z-index: 1;
                }
                .ba-lightbox-close {
                    position: fixed;
                    top: 16px;
                    right: 16px;
                    background: transparent;
                    border: none;
                    color: #ffffff;
                    font-size: 28px;
                    line-height: 1;
                    cursor: pointer;
                    z-index: 2;
                    padding: 8px 12px;
                    opacity: 0.8;
                    transition: opacity 0.2s ease;
                }
                .ba-lightbox-close:hover { opacity: 1; }
                /* 隐藏覆盖层（保留布局占位但不拦截事件） */
                .ba-hidden-overlay { pointer-events: none; }
                `;
                document.head.appendChild(style);
            }

            // 注入面板 HTML 结构
            function injectPanelHtml() {
                if (document.getElementById('browserAutomationPanel')) return;
                const panelHtml = `
                <div id="browserAutomationPanel" class="ba-panel" aria-hidden="true">
                    <div class="ba-panel-header">
                        <span class="ba-panel-title" data-i18n="ba_panel_title">浏览器自动化</span>
                        <button type="button" class="ba-panel-close" id="baPanelClose" aria-label="关闭">×</button>
                    </div>
                    <div class="ba-panel-body">
                        <div class="ba-section">
                            <div class="ba-section-title" data-i18n="ba_screenshots">截图</div>
                            <div class="ba-screenshots" id="baScreenshots">
                                <div class="ba-empty" data-i18n="ba_no_screenshots">暂无截图</div>
                            </div>
                        </div>
                        <div class="ba-section">
                            <div class="ba-section-title" data-i18n="ba_status_timeline">状态时间线</div>
                            <div class="ba-status-timeline" id="baStatusTimeline">
                                <div class="ba-empty" data-i18n="ba_no_status">暂无状态</div>
                            </div>
                        </div>
                        <div class="ba-section">
                            <div class="ba-section-title" data-i18n="ba_vls_analysis">VLS 分析</div>
                            <div class="ba-vls-container" id="baVlsContainer">
                                <div class="ba-empty" data-i18n="ba_no_vls">暂无分析</div>
                            </div>
                        </div>
                    </div>
                    <div class="ba-panel-footer">
                        <button type="button" class="ba-btn ba-btn-secondary" id="baReanalyzeBtn" data-i18n="ba_reanalyze">重新分析页面</button>
                        <button type="button" class="ba-btn ba-btn-danger" id="baStopBtn" data-i18n="ba_stop">停止浏览器</button>
                    </div>
                </div>
                <button type="button" id="baToggleBtn" class="ba-toggle-btn" aria-label="浏览器自动化" data-tooltip="浏览器自动化">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="2" y1="12" x2="22" y2="12"></line>
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                    </svg>
                </button>
                <div id="baLightbox" class="ba-lightbox" aria-hidden="true">
                    <div class="ba-lightbox-overlay"></div>
                    <button type="button" class="ba-lightbox-close" id="baLightboxClose" aria-label="关闭">×</button>
                    <img id="baLightboxImg" class="ba-lightbox-img" src="" alt="截图预览" />
                </div>
                `;
                document.body.insertAdjacentHTML('beforeend', panelHtml);
            }

            // BA 灯箱：全屏查看截图
            let baLightboxState = { shots: [], index: 0 };
            function ensureBaLightbox() {
                let lb = document.getElementById('baLightbox');
                if (!lb) return null;
                if (!lb._bound) {
                    lb.querySelector('.ba-lightbox-overlay').addEventListener('click', closeBaLightbox);
                    document.getElementById('baLightboxClose').addEventListener('click', closeBaLightbox);
                    document.addEventListener('keydown', function(e) {
                        const lbx = document.getElementById('baLightbox');
                        if (!lbx || lbx.getAttribute('aria-hidden') === 'true') return;
                        if (e.key === 'Escape') closeBaLightbox();
                    });
                    lb._bound = true;
                }
                return lb;
            }
            function openBaLightbox(src) {
                const lb = ensureBaLightbox();
                if (!lb) return;
                const img = document.getElementById('baLightboxImg');
                if (img) img.src = src;
                lb.classList.add('show');
                lb.setAttribute('aria-hidden', 'false');
            }
            function closeBaLightbox() {
                const lb = document.getElementById('baLightbox');
                if (!lb) return;
                lb.classList.remove('show');
                lb.setAttribute('aria-hidden', 'true');
            }

            // 时间格式化：HH:MM:SS
            function formatBaTime(d) {
                d = d || new Date();
                const pad = function(n) { return n < 10 ? '0' + n : '' + n; };
                return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            }

            // HTML 转义
            function baEscapeHtml(s) {
                if (s === null || s === undefined) return '';
                return String(s)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;');
            }

            // 构造 VLS 卡片 HTML（用于主对话区域与面板共用）
            function buildVlsCardHtml(data) {
                const summary = baEscapeHtml(data.summary || '');
                const elements = Array.isArray(data.elements) ? data.elements : [];
                let html = '<div class="vls-card">';
                if (summary) {
                    html += '<div class="vls-card-summary">' + summary + '</div>';
                }
                if (elements.length > 0) {
                    html += '<div class="vls-card-elements">';
                    elements.forEach(function(el) {
                        const type = baEscapeHtml(el.type || '');
                        const selector = baEscapeHtml(el.css_selector || el.selector || '');
                        const position = baEscapeHtml(el.position || '');
                        const state = baEscapeHtml(el.state || '');
                        html += '<div class="vls-element-row">';
                        html += '<span class="vls-element-key">元素</span>';
                        html += '<span class="vls-element-val">';
                        if (type) html += '<span class="vls-element-type">' + type + '</span>';
                        if (selector) html += baEscapeHtml(selector);
                        if (position) html += ' · 位置: ' + position;
                        if (state) html += ' · 状态: ' + state;
                        html += '</span>';
                        html += '</div>';
                    });
                    html += '</div>';
                }
                // 推荐操作：从任一 element.suggested_next_action 提取
                const suggested = elements
                    .map(function(el) { return el.suggested_next_action || el.suggested_action || ''; })
                    .filter(Boolean)[0];
                if (suggested) {
                    html += '<div class="vls-card-action">推荐操作: ' + baEscapeHtml(suggested) + '</div>';
                }
                html += '</div>';
                return html;
            }

            // 面板可见性更新：BA 输出已迁移到右侧操作详情面板，浮动面板不再显示
            function updateBaPanelVisibility() {
                const toggleBtn = document.getElementById('baToggleBtn');
                const panel = document.getElementById('browserAutomationPanel');
                // 永远隐藏浮动面板和切换按钮（BA 信息现在走 tool_detail 通道到右侧详情面板）
                if (toggleBtn) toggleBtn.classList.remove('show');
                if (panel) {
                    panel.classList.remove('show');
                    panel.setAttribute('aria-hidden', 'true');
                }
            }

            // 暴露给 SSE 处理器的全局 API
            window.BaPanel = {
                // 追加截图（不覆盖）
                appendScreenshot: function(data) {
                    const container = document.getElementById('baScreenshots');
                    if (!container) return;
                    // 首张截图：清空空状态
                    const empty = container.querySelector('.ba-empty');
                    if (empty) empty.remove();
                    const base64 = data.image || '';
                    const index = data.index || 0;
                    const thumb = document.createElement('img');
                    thumb.className = 'ba-screenshot-thumb';
                    thumb.src = 'data:image/png;base64,' + base64;
                    thumb.alt = '截图 ' + index;
                    thumb.dataset.tooltip = '点击查看大图 · #' + index;
                    thumb.addEventListener('click', function() {
                        openBaLightbox(thumb.src);
                    });
                    thumb.addEventListener('error', function() {
                        thumb.style.display = 'none';
                    });
                    container.appendChild(thumb);
                    container.scrollLeft = container.scrollWidth;
                    // 自动展开面板（首次截图到达）
                    const panel = document.getElementById('browserAutomationPanel');
                    if (panel && !panel.classList.contains('show')) {
                        panel.classList.add('show');
                        panel.setAttribute('aria-hidden', 'false');
                    }
                },
                // 追加状态（累加到时间线，不覆盖）
                appendStatus: function(data) {
                    const container = document.getElementById('baStatusTimeline');
                    if (!container) return;
                    const empty = container.querySelector('.ba-empty');
                    if (empty) empty.remove();
                    const status = (data.status || '').toLowerCase();
                    const action = data.action || '';
                    const isError = (status === 'error');
                    const line = document.createElement('div');
                    line.className = 'ba-status-line' + (isError ? ' ba-status-error' : '');
                    const timeEl = document.createElement('span');
                    timeEl.className = 'ba-status-time';
                    timeEl.textContent = '[' + formatBaTime() + ']';
                    line.appendChild(timeEl);
                    line.appendChild(document.createTextNode(action + ': ' + (data.status || '')));
                    container.appendChild(line);
                    container.scrollTop = container.scrollHeight;
                },
                // 渲染 VLS 分析卡片
                renderVlsAnalysis: function(data) {
                    const container = document.getElementById('baVlsContainer');
                    if (!container) return;
                    const empty = container.querySelector('.ba-empty');
                    if (empty) empty.remove();
                    const card = document.createElement('div');
                    card.innerHTML = buildVlsCardHtml(data);
                    // 取第一个子节点（vls-card）
                    const cardNode = card.firstElementChild;
                    if (cardNode) container.appendChild(cardNode);
                    // 自动展开面板
                    const panel = document.getElementById('browserAutomationPanel');
                    if (panel && !panel.classList.contains('show')) {
                        panel.classList.add('show');
                        panel.setAttribute('aria-hidden', 'false');
                    }
                },
                // 提供给主对话区域使用的卡片 HTML 构造器
                buildVlsCardHtml: buildVlsCardHtml
            };

            // 绑定面板交互
            function bindPanelEvents() {
                const toggleBtn = document.getElementById('baToggleBtn');
                const panel = document.getElementById('browserAutomationPanel');
                const closeBtn = document.getElementById('baPanelClose');
                const reanalyzeBtn = document.getElementById('baReanalyzeBtn');
                const stopBtn = document.getElementById('baStopBtn');

                if (toggleBtn && panel) {
                    toggleBtn.addEventListener('click', function() {
                        const isOpen = panel.classList.contains('show');
                        panel.classList.toggle('show', !isOpen);
                        panel.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
                    });
                }
                if (closeBtn && panel) {
                    closeBtn.addEventListener('click', function() {
                        panel.classList.remove('show');
                        panel.setAttribute('aria-hidden', 'true');
                    });
                }

                // 重新分析页面：通过发送聊天消息让 AI 调用 vls_analyze_browser 工具
                if (reanalyzeBtn) {
                    reanalyzeBtn.addEventListener('click', function() {
                        const mi = document.getElementById('messageInput') || document.querySelector('.message-input');
                        if (mi && typeof sendMessage === 'function') {
                            mi.value = '请对当前浏览器页面重新进行 VLS 视觉布局分析';
                            sendMessage();
                        } else {
                            showToast('消息输入不可用，无法触发重新分析');
                        }
                    });
                }
                // 停止浏览器：通过发送聊天消息让 AI 调用 browser_automation_control action=stop
                if (stopBtn) {
                    stopBtn.addEventListener('click', function() {
                        const mi = document.getElementById('messageInput') || document.querySelector('.message-input');
                        if (mi && typeof sendMessage === 'function') {
                            mi.value = '请停止浏览器自动化任务';
                            sendMessage();
                        } else {
                            showToast('消息输入不可用，无法停止浏览器');
                        }
                    });
                }
            }

            // 监听 Work/Chat 模式切换
            function observeModeChanges() {
                // Work 模式通过 document.body.classList.add('work-mode') 标记
                const target = document.body;
                if (typeof MutationObserver !== 'undefined') {
                    const observer = new MutationObserver(function() {
                        updateBaPanelVisibility();
                    });
                    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
                }
                // 兜底：定期轮询（200ms 间隔，开销极小）
                setInterval(updateBaPanelVisibility, 500);
            }

            // 启动
            function start() {
                injectStyles();
                injectPanelHtml();
                bindPanelEvents();
                updateBaPanelVisibility();
                observeModeChanges();
            }
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', start);
            } else {
                start();
            }
        })();
        Promise.resolve().then(activateComposerApprovals);
    
