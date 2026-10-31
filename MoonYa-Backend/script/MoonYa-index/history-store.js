/* Browser-local history. No network requests and no localStorage writes. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.MoonYaHistoryStore = factory({ indexedDB: root.indexedDB, storage: root.localStorage,
        onError: (detail) => root.dispatchEvent(new CustomEvent('moonya:history-save-error', { detail })) });
})(typeof window === 'undefined' ? globalThis : window, function createHistoryStore(options) {
    'use strict';
    const scopes = new Map();
    const queues = new Map();
    const dirty = new Map();
    const committed = new Map();
    const pendingDeletes = new Map();
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
        return enqueue(queueKey, async () => {
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
        return enqueue(queueKey, async () => {
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
        return enqueue(JSON.stringify([scope, String(id)]), async () => {
            try {
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
    async function projectRequest(scope, action, body = {}) {
        return enqueue('projects:' + scope, async () => {
            try {
                if (!localProjects.has(scope)) localProjects.set(scope, (await read('drafts', [scope, '__work_projects__']))?.value || []);
                const projects = localProjects.get(scope);
                if (action === 'list') return { success: true, data: { projects: clone(projects).sort((a, b) => String(b.last_used_at).localeCompare(String(a.last_used_at))) } };
                let project;
                if (action === 'create') {
                    const name = String(body.name || '').trim(), path = String(body.path || '').trim();
                    if (!name || !path) return { success: false, message: '请填写项目名称并选择路径' };
                    if (projects.some(project => project.path === path)) return { success: false, message: '项目已存在' };
                    project = { id: crypto.randomUUID(), name, path, created_at: new Date().toISOString(), last_used_at: new Date().toISOString() };
                    projects.push(project);
                } else if (action === 'delete') {
                    localProjects.set(scope, projects.filter(project => String(project.id) !== String(body.id)));
                } else if (action === 'save_current') {
                    project = projects.find(project => String(project.id) === String(body.id));
                    if (!project) return { success: false, message: '项目不存在' };
                    project.last_used_at = new Date().toISOString();
                } else return { success: false, message: '未知本地项目操作' };
                const saved = await putRecord('drafts', scope, '__work_projects__', null, localProjects.get(scope));
                return { success: saved, data: project || {}, message: saved ? '' : '项目保留在内存中，本地保存失败，请重试' };
            } catch (error) {
                failure(scope, [scope, '__work_projects__'], error);
                return { success: false, message: error.message };
            }
        });
    }
    return {
        initialize, list, save, hydrate, projectRequest,
        saveDraft: (scope, id, value) => putRecord('drafts', scope, id, null, value),
        loadDraft: async (scope, id) => (await read('drafts', [scope, String(id)]))?.value || null,
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
