/* Browser-local history. No network requests and no localStorage writes. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.MoonYaHistoryStore = factory({ indexedDB: root.indexedDB, storage: root.localStorage,
        onError: (detail) => root.dispatchEvent(new CustomEvent('moonya:history-save-error', { detail })),
        isBusy: (scope, id) => root.MoonYaWorkspace?.isBusy(scope, id),
        onChange: detail => root.dispatchEvent(new CustomEvent('moonya:workspace-change', { detail })) });
})(typeof window === 'undefined' ? globalThis : window, function createHistoryStore(options) {
    'use strict';
    const scopes = new Map();
    const queues = new Map();
    const dirty = new Map();
    const committed = new Map();
    const pendingDeletes = new Map();
    const sidebarStates = new Map();
    const ownership = new Map();
    const managedFields = ['projectId', 'workingDirectory', 'projectName', 'sectionId', 'pinned', 'archivedAt', 'activeWorkspaceIdentity'];
    const normalizePath = path => String(path || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    function mergeOwnership(scope, chat) {
        const authoritative = ownership.get(JSON.stringify([scope, String(chat.id)]));
        if (authoritative) Object.assign(chat, authoritative);
        return chat;
    }
    function mergeDraft(scope, id, draft) {
        const chat = state(scope).chats.find(chat => String(chat.id) === String(id));
        if (chat && Object.hasOwn(chat, 'workingDirectory')) {
            draft.composer = Object.assign({}, draft.composer, { projectPath: chat.workingDirectory,
                projectName: chat.projectName || '', projectId: chat.projectId || null });
        }
        return draft;
    }
    let opening;
    const clone = value => structuredClone(value);
    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const completed = tx => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('history_transaction_aborted'));
    });
    function enqueue(key, operation) {
        const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
        queues.set(key, next);
        void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
        return next;
    }
    function open() {
        if (!opening) opening = new Promise((resolve, reject) => {
            if (!options.indexedDB) return reject(new Error('indexeddb_unavailable'));
            const req = options.indexedDB.open('moonya-history', 1);
            req.onupgradeneeded = () => {
                for (const name of ['conversations', 'messages', 'events', 'attachments', 'drafts', 'migrations']) {
                    const store = req.result.createObjectStore(name, { keyPath: 'key' });
                    store.createIndex('scope', 'scope');
                    if (name === 'events' || name === 'attachments') store.createIndex('conversation', 'conversation');
                }
            };
            req.onsuccess = () => {
                req.result.onversionchange = () => { req.result.close(); opening = null; };
                resolve(req.result);
            };
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('history_upgrade_blocked'));
        }).catch(error => { opening = null; throw error; });
        return opening;
    }
    function state(scope) {
        if (!scopes.has(scope)) scopes.set(scope, { chats: [], ready: null });
        return scopes.get(scope);
    }
    function failure(scope, key, error) {
        const chat = state(scope).chats.find(item => String(item.id) === String(key[1]));
        if (chat) chat.unsaved = true;
        if (options.onError) options.onError({ scope, chatId: key[1], message: error.message });
        return false;
    }
    async function read(name, key) {
        const db = await open();
        return request(db.transaction(name).objectStore(name).get(key));
    }
    async function writeChat(scope, snapshot, includeMessages) {
        snapshot = mergeOwnership(scope, clone(snapshot));
        const key = [scope, String(snapshot.id)];
        const db = await open();
        const tx = db.transaction(['conversations', 'messages', 'attachments'], 'readwrite');
        const done = completed(tx);
        const { messages, messagesLoaded, unsaved, ...meta } = snapshot;
        if (includeMessages) {
            meta.messageCount = messages.length;
            const storedMessages = messages.map((message, index) => {
                const saved = clone(message);
                const identity = message.clientMessageId || message.serverMessageId || String(index);
                if (Array.isArray(message.images)) saved.images = message.images.map((image, imageIndex) => {
                    if (typeof image !== 'string' || !image.startsWith('data:')) return image;
                    const attachmentKey = [scope, String(snapshot.id), 'message:' + identity + ':' + imageIndex];
                    tx.objectStore('attachments').put({ key: attachmentKey, scope, conversation: key, data: image });
                    return { localAttachment: attachmentKey };
                });
                return saved;
            });
            tx.objectStore('messages').put({ key, scope, messages: storedMessages });
        }
        tx.objectStore('conversations').put({ key, scope, meta });
        await done;
    }
    function persist(scope, snapshot, includeMessages) {
        const key = [scope, String(snapshot.id)];
        const queueKey = JSON.stringify(key);
        const { unsaved, ...comparable } = snapshot;
        const fingerprint = JSON.stringify(comparable);
        if (!dirty.has(queueKey) && committed.get(queueKey) === fingerprint) return Promise.resolve(true);
        // The latest complete snapshot survives a failed transaction in memory.
        const item = { snapshot: clone(snapshot), includeMessages };
        dirty.set(queueKey, item);
        return enqueue('scope:' + scope, async () => {
            try {
                await writeChat(scope, item.snapshot, item.includeMessages);
                committed.set(queueKey, fingerprint);
                if (dirty.get(queueKey) === item) {
                    dirty.delete(queueKey);
                    const chat = state(scope).chats.find(chat => String(chat.id) === key[1]);
                    if (chat) delete chat.unsaved;
                }
                return true;
            } catch (error) { return failure(scope, key, error); }
        });
    }
    async function remove(scope, id) {
        const key = [scope, String(id)];
        const queueKey = JSON.stringify(key);
        pendingDeletes.set(queueKey, { scope, id });
        dirty.delete(queueKey);
        for (const [recordKey, record] of pendingRecords) {
            if (record.scope === scope && String(record.id) === String(id)) pendingRecords.delete(recordKey);
        }
        return enqueue('scope:' + scope, async () => {
            const db = await open();
            const tx = db.transaction(['conversations', 'messages', 'drafts', 'events', 'attachments'], 'readwrite');
            const done = completed(tx);
            for (const name of ['conversations', 'messages', 'drafts']) tx.objectStore(name).delete(key);
            for (const name of ['events', 'attachments']) {
                const cursor = tx.objectStore(name).index('conversation').openCursor(key);
                cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
            }
            await done;
            dirty.delete(queueKey);
            committed.delete(queueKey);
            pendingDeletes.delete(queueKey);
            ownership.delete(queueKey);
            return true;
        }).catch(error => failure(scope, key, error));
    }
    function legacyBindings(chat) {
        const bindings = {};
        const keys = [];
        try {
            for (let index = 0; index < options.storage.length; index++) {
                const key = options.storage.key(index);
                for (const id of [chat.id, chat.dbConversationId].filter(id => id != null)) {
                    const prefix = 'moonya.harness.session.' + id + '.';
                    if (key && key.startsWith(prefix)) {
                        bindings[decodeURIComponent(key.slice(prefix.length))] = options.storage.getItem(key);
                        keys.push(key);
                        break;
                    }
                }
            }
        } catch (_) {}
        return { bindings, keys };
    }
    function legacyMode(scope, chat) {
        if (chat.mode === 'work' || chat.mode === 'chat') return chat.mode;
        return Object.keys(legacyBindings(chat).bindings).length ? 'work' : 'legacy';
    }
    async function sourceDigest(value) {
        if (!globalThis.crypto?.subtle) return null;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    async function migrate(scope) {
        let raw;
        try { raw = options.storage && options.storage.getItem(scope); } catch (_) { return; }
        if (!raw) return;
        const legacy = JSON.parse(raw);
        if (!Array.isArray(legacy)) throw new Error('invalid_legacy_history');
        const imported = [];
        const bindingKeys = new Set();
        for (const original of legacy) {
            if (!original || original.id == null || !Array.isArray(original.messages)) throw new Error('invalid_legacy_conversation');
            const chat = clone(original);
            const legacyRuntime = legacyBindings(chat);
            chat.runtimeSessions = Object.assign({}, legacyRuntime.bindings, chat.runtimeSessions || {});
            legacyRuntime.keys.forEach(key => bindingKeys.add(key));
            chat.mode = legacyMode(scope, chat);
            chat.storage = chat.mode === 'chat' ? 'cloud' : 'local';
            chat.readOnly = chat.mode === 'legacy';
            if (chat.storage === 'local' && chat.dbConversationId) {
                chat.legacyDbConversationId = chat.dbConversationId;
                delete chat.dbConversationId;
            }
            chat.messagesLoaded = true;
            chat.messageCount = chat.messages.length;
            imported.push(chat);
            const migrationKey = [scope, String(chat.id)];
            const digest = await sourceDigest(original);
            const marker = await read('migrations', migrationKey);
            if (digest && marker && marker.sourceDigest === digest) continue;
            // The desktop-origin import preserves newer conversations already stored here.
            if (await read('conversations', migrationKey)) continue;
            // Verify every migrated message and image by reading the committed data.
            await writeChat(scope, chat, true);
            const recovered = await loadMessages(scope, chat.id);
            if (JSON.stringify(recovered) !== JSON.stringify(chat.messages)) throw new Error('history_migration_verification_failed');
            const db = await open();
            const tx = db.transaction('migrations', 'readwrite');
            const done = completed(tx);
            tx.objectStore('migrations').put({ key: migrationKey, scope, sourceDigest: digest });
            await done;
        }
        // Do not remove or rewrite the original until all conversations verify.
        if (options.storage.getItem(scope) !== raw) throw new Error('legacy_history_changed_during_migration');
        options.storage.removeItem(scope);
        for (const key of bindingKeys) { try { options.storage.removeItem(key); } catch (_) {} }
        return imported;
    }
    async function loadMessages(scope, id) {
        const stored = await read('messages', [scope, String(id)]);
        const messages = stored ? clone(stored.messages) : [];
        for (const message of messages) {
            if (Array.isArray(message.images)) message.images = await Promise.all(message.images.map(async image => {
                if (!image || !image.localAttachment) return image;
                const attachment = await read('attachments', image.localAttachment);
                if (!attachment) throw new Error('local_attachment_missing');
                return attachment.data;
            }));
        }
        return messages;
    }
    async function initialize(scope) {
        const current = state(scope);
        if (!current.ready) current.ready = (async () => {
            try {
                await migrate(scope);
                const db = await open();
                const rows = await request(db.transaction('conversations').objectStore('conversations').index('scope').getAll(scope));
                current.chats = rows.map(row => ({ ...row.meta, messages: [], messagesLoaded: false }));
                current.chats.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            } catch (error) {
                // Recover the old data in memory even when IndexedDB is unavailable.
                try {
                    const legacy = JSON.parse(options.storage.getItem(scope) || '[]');
                    if (Array.isArray(legacy)) current.chats = legacy.map(chat => ({ ...chat,
                        legacyDbConversationId: chat.dbConversationId, dbConversationId: null,
                        mode: legacyMode(scope, chat), storage: 'local', readOnly: true,
                        messagesLoaded: true, messageCount: (chat.messages || []).length, unsaved: true }));
                } catch (_) {}
                failure(scope, [scope, ''], error);
            }
            return current.chats;
        })();
        return current.ready;
    }
    function list(scope) { return state(scope).chats.slice(); }
    function save(scope, chats) {
        const previous = state(scope).chats;
        chats = chats.map(chat => mergeOwnership(scope, chat));
        state(scope).chats = chats.slice();
        const ids = new Set(chats.map(chat => String(chat.id)));
        const tasks = previous.filter(chat => !ids.has(String(chat.id))).map(chat => remove(scope, chat.id));
        for (const chat of chats) {
            const includeMessages = chat.messagesLoaded !== false;
            if (includeMessages) chat.messageCount = (chat.messages || []).length;
            tasks.push(persist(scope, chat, includeMessages));
        }
        return Promise.all(tasks).then(results => results.every(result => result !== false));
    }
    async function hydrate(scope, id) {
        await initialize(scope);
        const chat = state(scope).chats.find(chat => String(chat.id) === String(id));
        if (!chat) return null;
        if (chat.messagesLoaded === false) {
            chat.messages = await loadMessages(scope, id);
            chat.messagesLoaded = true;
        }
        return chat;
    }
    const pendingRecords = new Map();
    const localProjects = new Map();
    function putRecord(name, scope, id, recordId, value) {
        const key = recordId == null ? [scope, String(id)] : [scope, String(id), String(recordId)];
        const pendingKey = name + JSON.stringify(key);
        const row = { key, scope, conversation: [scope, String(id)], value: clone(value) };
        const pending = { name, scope, id, recordId, value: clone(value) };
        pendingRecords.set(pendingKey, pending);
        return enqueue('scope:' + scope, async () => {
            try {
                if (name === 'drafts' && recordId == null && !String(id).startsWith('__')) row.value = mergeDraft(scope, id, row.value);
                const db = await open();
                const tx = db.transaction(name, 'readwrite');
                const done = completed(tx);
                tx.objectStore(name).put(row);
                await done;
                if (pendingRecords.get(pendingKey) === pending) pendingRecords.delete(pendingKey);
                return true;
            } catch (error) { return failure(scope, [scope, String(id)], error); }
        });
    }
    async function loadWorkspace(scope) {
        if (!localProjects.has(scope)) localProjects.set(scope, (await read('drafts', [scope, '__work_projects__']))?.value || []);
        if (!sidebarStates.has(scope)) sidebarStates.set(scope, Object.assign({ sections: [], expanded: {}, selectedProjectId: null },
            (await read('drafts', [scope, '__sidebar_layout__']))?.value || {}));
        return { projects: clone(localProjects.get(scope)), layout: clone(sidebarStates.get(scope)) };
    }
    function requireIdle(scope, chats) {
        if (chats.some(chat => options.isBusy?.(scope, chat.id) ||
            ['starting', 'running', 'waiting_approval', 'recovering', 'stopping'].includes(chat.taskState?.phase))) {
            throw new Error('任务正在执行或等待审批，请等待结束或先停止');
        }
    }
    // One scope queue orders message saves, draft saves and atomic workspace changes.
    // Authoritative metadata is merged into late streaming snapshots at write time.
    async function sidebarRequest(scope, action, body = {}) {
        await initialize(scope);
        return enqueue('scope:' + scope, async () => {
            try {
                let { projects, layout } = await loadWorkspace(scope);
                if (action === 'list') return { success: true, data: { projects, layout } };
                const changes = new Map(), now = new Date().toISOString();
                let protectedChats = [];
                const chats = state(scope).chats;
                const change = (chat, patch) => changes.set(String(chat.id), Object.assign({}, changes.get(String(chat.id)), patch));
                const project = projects.find(item => String(item.id) === String(body.id));
                const members = project ? chats.filter(chat => String(chat.projectId) === String(project.id)) : [];
                const selected = body.ids ? body.ids.map(id => {
                    const chat = chats.find(item => String(item.id) === String(id));
                    if (!chat || !['work', 'legacy'].includes(chat.mode)) throw new Error('会话不存在');
                    return chat;
                }) : [];
                if (body.sectionId && !layout.sections.some(section => section.id === body.sectionId)) throw new Error('分区不存在');
                let result = {};
                if (action === 'project_create') {
                    const name = String(body.name || '').trim(), path = String(body.path || '').trim();
                    if (!name || !path) throw new Error('请填写项目名称并选择路径');
                    const existing = projects.find(item => normalizePath(item.path) === normalizePath(path));
                    if (existing) return { success: false, data: existing, message: '项目已存在' };
                    result = { id: crypto.randomUUID(), name, path, pinned: false, sectionId: null,
                        order: projects.length, created_at: now, last_used_at: now };
                    projects.push(result);
                } else if (action.startsWith('project_')) {
                    if (!project) throw new Error('项目不存在');
                    result = project;
                    if (action === 'project_update') {
                        const name = String(body.name ?? project.name).trim(), path = String(body.path ?? project.path).trim();
                        if (!name || !path) throw new Error('请填写项目名称并选择路径');
                        if (projects.some(item => item.id !== project.id && normalizePath(item.path) === normalizePath(path))) throw new Error('项目已存在');
                        if (path !== project.path) { requireIdle(scope, members); protectedChats = members; }
                        Object.assign(project, { name, path });
                        members.forEach(chat => change(chat, { workingDirectory: path, projectName: name, activeWorkspaceIdentity: path }));
                    } else if (action === 'project_delete') {
                        requireIdle(scope, members);
                        protectedChats = members;
                        members.forEach(chat => change(chat, { projectId: null, sectionId: null, pinned: false }));
                        projects = projects.filter(item => item.id !== project.id);
                        if (layout.selectedProjectId === project.id) layout.selectedProjectId = null;
                    } else if (action === 'project_archive' || action === 'project_restore') {
                        requireIdle(scope, members);
                        protectedChats = members;
                        members.forEach(chat => change(chat, { archivedAt: action === 'project_archive' ? now : null }));
                    } else if (action === 'project_pin') project.pinned = !!body.pinned;
                    else if (action === 'project_section') project.sectionId = body.sectionId || null;
                    else if (action === 'project_save_current') project.last_used_at = now;
                    else throw new Error('未知项目操作');
                } else if (action === 'section_create') {
                    const name = String(body.name || '').trim();
                    if (!name) throw new Error('请输入分区名称');
                    result = { id: crypto.randomUUID(), name, order: layout.sections.length };
                    layout.sections.push(result);
                } else if (action === 'section_update' || action === 'section_delete') {
                    const section = layout.sections.find(item => item.id === body.id);
                    if (!section) throw new Error('分区不存在');
                    if (action === 'section_update') {
                        const name = String(body.name || '').trim();
                        if (!name) throw new Error('请输入分区名称');
                        section.name = name;
                    } else {
                        layout.sections = layout.sections.filter(item => item.id !== section.id);
                        projects.filter(item => item.sectionId === section.id).forEach(item => { item.sectionId = null; });
                        chats.filter(chat => chat.sectionId === section.id).forEach(chat => change(chat, { sectionId: null }));
                    }
                } else if (action === 'layout') {
                    if (body.expanded) Object.assign(layout.expanded, body.expanded);
                    if (Object.hasOwn(body, 'selectedProjectId')) {
                        if (body.selectedProjectId && !projects.some(item => item.id === body.selectedProjectId)) throw new Error('项目不存在');
                        layout.selectedProjectId = body.selectedProjectId || null;
                    }
                } else if (action === 'reorder') {
                    const items = body.kind === 'section' ? layout.sections : projects;
                    if (!Array.isArray(body.order) || new Set(body.order).size !== items.length || body.order.length !== items.length ||
                        body.order.some(id => !items.some(item => item.id === id))) throw new Error('排序列表已变化，请重试');
                    body.order.forEach((id, index) => { items.find(item => item.id === id).order = index; });
                } else if (action === 'chat_move') {
                    requireIdle(scope, selected);
                    protectedChats = selected;
                    if (selected.some(chat => chat.readOnly)) throw new Error('旧历史仅供查看');
                    const target = projects.find(item => item.id === body.projectId);
                    if (body.projectId && !target) throw new Error('项目不存在');
                    selected.forEach(chat => change(chat, { projectId: target?.id || null, sectionId: null,
                        workingDirectory: target ? target.path : (body.clearDirectory ? '' : chat.workingDirectory || ''),
                        projectName: target ? target.name : (body.clearDirectory ? '' : chat.projectName || ''),
                        activeWorkspaceIdentity: target ? target.path : (body.clearDirectory ? '__default__' : chat.workingDirectory || '__default__') }));
                } else if (action === 'chat_pin') selected.forEach(chat => change(chat, { pinned: !!body.pinned }));
                else if (action === 'chat_section') selected.forEach(chat => change(chat, { sectionId: body.sectionId || null }));
                else if (action === 'chat_archive' || action === 'chat_restore') {
                    requireIdle(scope, selected);
                    protectedChats = selected;
                    selected.forEach(chat => change(chat, { archivedAt: action === 'chat_archive' ? now : null }));
                } else if (action === 'associate_legacy') {
                    for (const chat of chats.filter(chat => chat.mode === 'work' && !Object.hasOwn(chat, 'workingDirectory'))) {
                        const draft = (await read('drafts', [scope, String(chat.id)]))?.value;
                        const evidence = [chat.activeWorkspaceIdentity, draft?.composer?.projectPath].filter(path => path && path !== '__default__');
                        if (!evidence.length) evidence.push(...Object.keys(chat.runtimeSessions || {}).filter(path => path !== '__default__'));
                        const unique = [...new Set(evidence.map(normalizePath))];
                        const matches = unique.length === 1 ? projects.filter(item => normalizePath(item.path) === unique[0]) : [];
                        const target = matches.length === 1 ? matches[0] : null;
                        // Conflicting evidence stays unassigned; an explicit active directory is still preserved.
                        const path = target?.path || (chat.activeWorkspaceIdentity !== '__default__' && chat.activeWorkspaceIdentity) || draft?.composer?.projectPath || '';
                        change(chat, { projectId: target?.id || null, workingDirectory: path,
                            projectName: target?.name || draft?.composer?.projectName || '', activeWorkspaceIdentity: path || '__default__' });
                    }
                } else throw new Error('未知侧边栏操作');

                const db = await open();
                requireIdle(scope, protectedChats);
                const tx = db.transaction(['conversations', 'drafts'], 'readwrite'), done = completed(tx);
                try {
                    const put = (id, value) => tx.objectStore('drafts').put({ key: [scope, id], scope, conversation: [scope, id], value });
                    put('__work_projects__', projects); put('__sidebar_layout__', layout);
                    for (const [id, patch] of changes) {
                        const chat = chats.find(item => String(item.id) === id);
                        const { messages, messagesLoaded, unsaved, ...meta } = chat;
                        Object.assign(meta, patch);
                        tx.objectStore('conversations').put({ key: [scope, id], scope, meta });
                        if (Object.hasOwn(patch, 'workingDirectory') || Object.hasOwn(patch, 'projectId')) {
                            const req = tx.objectStore('drafts').get([scope, id]);
                            req.onsuccess = () => {
                                if (!req.result) return;
                                const draft = req.result.value;
                                draft.composer = Object.assign({}, draft.composer, { projectPath: meta.workingDirectory || '',
                                    projectName: meta.projectName || '', projectId: meta.projectId || null });
                                put(id, draft);
                            };
                        }
                    }
                    await done;
                } catch (error) {
                    try { tx.abort(); } catch (_) {}
                    await done.catch(() => {});
                    throw error;
                }
                localProjects.set(scope, projects); sidebarStates.set(scope, layout);
                for (const [id, patch] of changes) {
                    const chat = state(scope).chats.find(item => String(item.id) === id);
                    if (!chat) continue;
                    Object.assign(chat, patch);
                    const authoritative = {};
                    for (const field of managedFields) if (Object.hasOwn(chat, field)) authoritative[field] = chat[field];
                    ownership.set(JSON.stringify([scope, id]), authoritative);
                    committed.delete(JSON.stringify([scope, id]));
                }
                options.onChange?.({ scope, action, ids: [...changes.keys()] });
                return { success: true, data: Object.assign({ projects: clone(projects), layout: clone(layout) }, result) };
            } catch (error) {
                // Failed transactions leave the old workspace intact; the caller can retry the operation.
                return { success: false, message: error.message };
            }
        });
    }
    async function projectRequest(scope, action, body = {}) {
        if (action === 'list') {
            const result = await sidebarRequest(scope, 'list');
            if (result.success) result.data.projects.sort((a, b) => String(b.last_used_at).localeCompare(String(a.last_used_at)));
            return result;
        }
        return sidebarRequest(scope, 'project_' + action, body);
    }
    return {
        initialize, list, save, hydrate, projectRequest, sidebarRequest, normalizePath,
        reload: async scope => {
            state(scope).ready = null; localProjects.delete(scope); sidebarStates.delete(scope);
            for (const key of ownership.keys()) if (JSON.parse(key)[0] === scope) ownership.delete(key);
            await initialize(scope);
        },
        saveDraft: (scope, id, value) => putRecord('drafts', scope, id, null, value),
        loadDraft: async (scope, id) => {
            const value = (await read('drafts', [scope, String(id)]))?.value;
            return value ? mergeDraft(scope, id, value) : null;
        },
        appendEvent: (scope, id, event) => putRecord('events', scope, id, String(event.run_id || event.session_id) + ':' + event.seq, event),
        events: async (scope, id) => {
            const db = await open();
            const rows = await request(db.transaction('events').objectStore('events').index('conversation').getAll([scope, String(id)]));
            return rows.map(row => row.value).sort((a, b) => Number(a.seq) - Number(b.seq));
        },
        loadAttachment: async (scope, id, attachmentId) => {
            const key = [scope, String(id), String(attachmentId)];
            const memory = pendingRecords.get('attachments' + JSON.stringify(key));
            return memory ? clone(memory.value) : (await read('attachments', key))?.value || null;
        },
        saveAttachment: (scope, id, attachmentId, value) => putRecord('attachments', scope, id, attachmentId, value),
        retry: async scope => {
            try {
                const imported = await migrate(scope);
                for (const original of imported || []) {
                    const chat = state(scope).chats.find(chat => String(chat.id) === String(original.id));
                    if (!chat) continue;
                    chat.mode = original.mode; chat.storage = original.storage; chat.readOnly = original.readOnly;
                    chat.runtimeSessions = original.runtimeSessions;
                    if (original.dbConversationId) chat.dbConversationId = original.dbConversationId;
                }
            } catch (error) { failure(scope, [scope, ''], error); return false; }
            const tasks = [];
            for (const item of pendingDeletes.values()) if (item.scope === scope) tasks.push(remove(scope, item.id));
            for (const [key, item] of dirty) if (JSON.parse(key)[0] === scope) tasks.push(persist(scope, item.snapshot, item.includeMessages));
            for (const item of pendingRecords.values()) if (item.scope === scope) tasks.push(putRecord(item.name, item.scope, item.id, item.recordId, item.value));
            return (await Promise.all(tasks)).every(Boolean);
        }
    };
});
