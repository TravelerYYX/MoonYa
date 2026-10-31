/* 本地历史曾按登录账号分桶存进 scope 'chat_history_<id>'。现在整机只用一个
   scope 'chat_history'，本模块在启动时把旧的账号桶合并进来。

   三条硬规则：
   1. 只复制、从不删除源数据（旧桶原样留作备份）。
   2. 幂等：每个源 scope 在 migrations 里留一个标记，重复执行不会产生重复记录。
   3. 失败静默：任何异常都不能阻断应用启动。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.MoonYaScopeMigration = factory(typeof window === 'undefined' ? globalThis : window);
})(typeof window === 'undefined' ? globalThis : window, function createScopeMigration(root) {
    'use strict';

    const DB = 'moonya-history';
    const TARGET = 'chat_history';
    const SOURCE_SCOPE = /^chat_history_\d+$/;
    const COPIED_STORES = ['conversations', 'messages', 'events', 'attachments', 'drafts'];
    const PROJECTS_KEY = '__work_projects__';
    const LAYOUT_KEY = '__sidebar_layout__';

    const request = req => new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    const completed = tx => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('scope_merge_aborted'));
    });

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = root.indexedDB.open(DB); // 不带版本号：沿用 history-store 已建好的结构
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('scope_merge_blocked'));
        });
    }

    // 项目列表按 id 去重（目标已有的优先保留），合并后 order 连续重编号。
    function mergeProjects(target, source) {
        const byId = new Map();
        for (const project of [...(target || []), ...(source || [])]) {
            if (!project || project.id == null) continue;
            const id = String(project.id);
            if (!byId.has(id)) byId.set(id, project);
        }
        return [...byId.values()].map((project, index) => Object.assign({}, project, { order: index }));
    }

    // 分区按 id 去重（目标优先）；expanded 浅合并且目标显式值优先；选中项目目标优先。
    function mergeLayout(target, source) {
        target = target || {};
        source = source || {};
        const seen = new Set();
        const sections = [];
        for (const section of [...(target.sections || []), ...(source.sections || [])]) {
            if (!section || section.id == null) continue;
            const id = String(section.id);
            if (seen.has(id)) continue;
            seen.add(id);
            sections.push(Object.assign({}, section, { order: sections.length }));
        }
        return {
            sections,
            expanded: Object.assign({}, source.expanded || {}, target.expanded || {}),
            selectedProjectId: target.selectedProjectId ?? source.selectedProjectId ?? null
        };
    }

    // 整行搬运：只改 key / scope / conversation，保留 data / value / blob 等原始载荷字段。
    function retargetRow(row, scope) {
        const copy = Object.assign({}, row);
        const key = Array.isArray(row.key) ? row.key : [scope, row.key];
        copy.key = [TARGET, ...key.slice(1).map(String)];
        copy.scope = TARGET;
        if (Array.isArray(row.conversation)) copy.conversation = [TARGET, String(row.conversation[1])];
        return copy;
    }

    const rowId = row => String(Array.isArray(row.key) ? row.key[1] : row.key);
    const rowRecord = row => Array.isArray(row.key) && row.key.length > 2 ? String(row.key[2]) : null;

    async function mergeScope(db, scope, read) {
        const markerKey = [TARGET, '__merge__' + scope];
        if (await read('migrations', markerKey)) return false; // 已合并过

        const source = {};
        for (const name of COPIED_STORES) source[name] = await read.all(name, scope);
        const held = await read.all('conversations', TARGET);
        const heldIds = new Set(held.map(rowId));
        const heldDrafts = await read.all('drafts', TARGET);
        const heldDraftIds = new Set(heldDrafts.map(rowId));
        let projects = (heldDrafts.find(row => rowId(row) === PROJECTS_KEY) || {}).value;
        let layout = (heldDrafts.find(row => rowId(row) === LAYOUT_KEY) || {}).value;

        const puts = [];
        const take = (name, row) => puts.push([name, retargetRow(row, scope)]);
        // 冲突策略：目标 scope 已有同 id 的会话，整条链（消息/事件/附件/草稿）一并跳过。
        const fresh = row => !heldIds.has(rowId(row));

        for (const row of source.conversations) if (fresh(row)) take('conversations', row);
        for (const row of source.messages) if (fresh(row)) take('messages', row);
        for (const row of source.events) if (fresh(row)) take('events', row);
        for (const row of source.attachments) if (fresh(row)) take('attachments', row);
        for (const row of source.drafts) {
            const id = rowId(row);
            if (id === PROJECTS_KEY) {
                projects = mergeProjects(projects, row.value);
                puts.push(['drafts', Object.assign(retargetRow(row, scope), { value: projects })]);
            } else if (id === LAYOUT_KEY) {
                layout = mergeLayout(layout, row.value);
                puts.push(['drafts', Object.assign(retargetRow(row, scope), { value: layout })]);
            } else if (!heldDraftIds.has(id) && fresh(row)) {
                take('drafts', row);
            }
        }
        if (!puts.length) {
            // 源 scope 里只有空壳，标记掉避免以后每次启动重复扫描。
            await mark(db, markerKey);
            return false;
        }

        const tx = db.transaction([...COPIED_STORES, 'migrations'], 'readwrite');
        const done = completed(tx);
        for (const [name, row] of puts) tx.objectStore(name).put(row);
        tx.objectStore('migrations').put({
            key: markerKey, scope: TARGET, sourceScope: scope, mergedAt: new Date().toISOString()
        });
        await done;
        return true;
    }

    async function mark(db, markerKey) {
        const tx = db.transaction('migrations', 'readwrite');
        const done = completed(tx);
        tx.objectStore('migrations').put({ key: markerKey, scope: TARGET, mergedAt: new Date().toISOString() });
        await done;
    }

    async function perform() {
        const store = root.MoonYaHistoryStore;
        if (!root.indexedDB || !store) return 0;
        // 必须先让 history-store 建表：它带 onupgradeneeded，若被裸连接抢先建出空库，
        // 整个 store 会因为版本已到位而永远拿不到 object store。
        await store.initialize(TARGET);
        const db = await openDb();
        try {
            const read = async (name, key) => request(db.transaction(name).objectStore(name).get(key));
            read.all = (name, scope) => request(db.transaction(name).objectStore(name).index('scope').getAll(scope));

            const scopes = new Set();
            for (const name of ['conversations', 'drafts']) {
                const all = await request(db.transaction(name).objectStore(name).index('scope').getAll());
                for (const row of all) if (row && SOURCE_SCOPE.test(row.scope)) scopes.add(row.scope);
            }

            let merged = 0;
            for (const scope of [...scopes].sort()) {
                try {
                    if (await mergeScope(db, scope, read)) merged += 1;
                } catch (error) {
                    console.warn('本地历史合并跳过 scope：', scope, error);
                }
            }
            // store 的 state(scope) 只在首次 initialize 时读一次，必须让它重新读。
            if (merged) await store.reload(TARGET);
            return merged;
        } finally {
            db.close();
        }
    }

    let running = null;

    const api = {
        TARGET,
        mergeProjects,
        mergeLayout,
        run() {
            if (running) return running; // 并发调用复用同一个 Promise
            const current = perform()
                .catch(error => {
                    console.warn('本地历史合并迁移失败，已跳过：', error);
                    return 0;
                })
                // 结束后释放，后续调用可以再跑一次：此时靠 migrations 标记保证幂等。
                .finally(() => { if (running === current) running = null; });
            running = current;
            return current;
        }
    };
    return api;
});
