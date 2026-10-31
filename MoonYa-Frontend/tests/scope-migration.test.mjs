// 迁移模块的测试。本机 node 无法 spawn 子进程（EBUSY），Playwright/dotnet 那套跑不了，
// 所以这里用一个内存版 IndexedDB 桩，把 run() 的真实合并流程完整跑一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const STORES = ['conversations', 'messages', 'events', 'attachments', 'drafts', 'migrations'];

function loadModule(extra = {}) {
    const source = readFileSync(join(root, 'MoonYa-Frontend/src/history-scope-migration.js'), 'utf8');
    const sandbox = { console, ...extra };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'history-scope-migration.js' });
    return sandbox.MoonYaScopeMigration;
}

// ── 内存版 IndexedDB：只实现 history-scope-migration.js 实际用到的那点 API ──
// 关键点是「写入同步生效、请求异步回调」，与真实 IDB 语义一致，
// 因此能真实检验事务里 put 的顺序与幂等性。
function createIDB(seed = {}) {
    const stores = new Map(STORES.map(name => [name, new Map()]));
    for (const [name, rows] of Object.entries(seed)) {
        for (const row of rows) stores.get(name).set(JSON.stringify(row.key), structuredClone(row));
    }
    const keyOf = key => JSON.stringify(key);
    const respond = value => {
        const req = {};
        queueMicrotask(() => { req.result = value; if (req.onsuccess) req.onsuccess(); });
        return req;
    };
    const db = {
        closed: false,
        transaction(names) {
            const list = Array.isArray(names) ? names : [names];
            const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
            tx.objectStore = name => ({
                name,
                put(row) { stores.get(name).set(keyOf(row.key), structuredClone(row)); return respond(row.key); },
                get(key) { return respond(stores.get(name).get(keyOf(key))); },
                index: () => ({ getAll: scope => respond([...stores.get(name).values()]
                    .filter(row => scope === undefined || row.scope === scope)
                    .map(row => structuredClone(row))) })
            });
            if (!list.every(name => stores.has(name))) throw new Error('unknown store in transaction');
            queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
            return tx;
        },
        close() { db.closed = true; }
    };
    return {
        indexedDB: { open: () => respond(db) },
        rows: name => [...stores.get(name).values()],
        scopes: name => [...new Set([...stores.get(name).values()].map(r => r.scope))]
    };
}

function seedFixture() {
    const s7 = 'chat_history_7', s12 = 'chat_history_12', t = 'chat_history';
    return {
        conversations: [
            { key: [t, 'dup'], scope: t, title: '目标同名' },
            { key: [s7, 'c1'], scope: s7, title: '账号7会话' },
            { key: [s7, 'dup'], scope: s7, title: '源同名' },
            { key: [s12, 'c9'], scope: s12, title: '账号12会话' }
        ],
        messages: [{ key: [s7, 'c1'], scope: s7, messages: [{ type: 'user', content: '离线内容' }] }],
        events: [{ key: [s7, 'c1', 0], scope: s7, conversation: [s7, 'c1'], type: 'done' }],
        attachments: [{ key: [s7, 'c1', 'att1'], scope: s7, conversation: [s7, 'c1'], value: new Blob(['x']) }],
        drafts: [
            { key: [t, '__work_projects__'], scope: t, value: [{ id: 'pTarget', order: 0, name: '目标项目' }] },
            { key: [t, '__sidebar_layout__'], scope: t, value: { sections: [{ id: 'sTarget' }], expanded: { keep: true } } },
            { key: [s7, 'c1'], scope: s7, value: { draft: '保留草稿' } },
            { key: [s7, '__work_projects__'], scope: s7, value: [{ id: 'p7', order: 0, name: '账号7项目' }] },
            { key: [s7, '__sidebar_layout__'], scope: s7, value: { sections: [{ id: 's7' }], expanded: { a: true }, selectedProjectId: 'p7' } },
            { key: [s12, '__work_projects__'], scope: s12, value: [{ id: 'p12', order: 0, name: '账号12项目' }] }
        ]
    };
}

async function runAgainstFixture() {
    const fixture = seedFixture();
    const fake = createIDB(fixture);
    const reloads = [];
    const api = loadModule({
        indexedDB: fake.indexedDB,
        MoonYaHistoryStore: {
            initialize: async () => {},
            reload: async scope => reloads.push(scope)
        }
    });
    const same = api.run() === api.run(); // 并发调用必须复用同一个 Promise
    const first = await api.run();
    const second = await api.run();
    return { api, fake, reloads, first, second, same, fixture };
}

const draftValue = (fake, key) => fake.rows('drafts').find(r => r.key[0] === 'chat_history' && r.key[1] === key)?.value;

// 沙箱里造出来的数组/对象属于另一个 realm，deepStrictEqual 会因原型不同而失败，
// 因此比较前统一过一遍 JSON，把它们带回宿主 realm。
const host = value => JSON.parse(JSON.stringify(value === undefined ? null : value));

test('scope migration exposes the global target scope and pure merge helpers', () => {
    const api = loadModule();
    assert.ok(api, 'the module must attach MoonYaScopeMigration to the global object');
    assert.equal(api.TARGET, 'chat_history');
    assert.equal(typeof api.run, 'function');
});

test('project merge keeps target rows on id collision and renumbers order', () => {
    const { mergeProjects } = loadModule();
    const merged = host(mergeProjects(
        [{ id: 'a', order: 7, name: '目标项目' }],
        [{ id: 'a', order: 0, name: '源项目' }, { id: 'b', order: 3, name: '源项目二' }]
    ));
    assert.deepEqual(merged.map(p => p.id), ['a', 'b'], 'duplicate ids collapse to one row');
    assert.equal(merged[0].name, '目标项目', 'the target row wins the id collision');
    assert.deepEqual(merged.map(p => p.order), [0, 1], 'order is renumbered contiguously');
});

test('layout merge dedupes sections and lets the target win explicit values', () => {
    const { mergeLayout } = loadModule();
    const merged = host(mergeLayout(
        { sections: [{ id: 's1' }], expanded: { x: true }, selectedProjectId: 'target' },
        { sections: [{ id: 's1' }, { id: 's2' }], expanded: { x: false, y: true }, selectedProjectId: 'source' }
    ));
    assert.deepEqual(merged.sections.map(s => s.id), ['s1', 's2']);
    assert.deepEqual(merged.sections.map(s => s.order), [0, 1]);
    assert.deepEqual(merged.expanded, { x: true, y: true }, 'expanded is merged with target priority');
    assert.equal(merged.selectedProjectId, 'target');
});

test('both merge helpers are idempotent and tolerate empty or malformed input', () => {
    const { mergeProjects, mergeLayout } = loadModule();
    const projects = host(mergeProjects([{ id: 'a', order: 0 }], [{ id: 'a' }, { id: 'b' }]));
    assert.deepEqual(host(mergeProjects(projects, [])), projects, 're-running on its own output changes nothing');
    assert.deepEqual(host(mergeProjects(undefined, undefined)), []);
    assert.deepEqual(host(mergeProjects([null, { id: null }], [{ id: 'x' }])).map(p => p.id), ['x']);

    const layout = host(mergeLayout({ sections: [{ id: 's1' }] }, { sections: [{ id: 's2' }] }));
    assert.deepEqual(host(mergeLayout(layout, {})), layout);
    assert.deepEqual(host(mergeLayout(undefined, undefined)), { sections: [], expanded: {}, selectedProjectId: null });
});

test('run() merges every account scope into the global scope exactly once', async () => {
    const { fake, reloads, first, second, same } = await runAgainstFixture();

    assert.equal(same, true, 'concurrent run() calls must share one Promise');
    assert.equal(first, 2, 'both chat_history_7 and chat_history_12 must be merged');
    assert.equal(second, 0, 'a second run must be a no-op thanks to the migrations marker');
    assert.deepEqual(reloads, ['chat_history'], 'the store cache is invalidated once, and only when something merged');

    // 目标 scope 里恰好 3 条会话：目标原有的 dup + 两个源 scope 各一条。
    const target = fake.rows('conversations').filter(r => r.scope === 'chat_history');
    assert.deepEqual(target.map(r => String(r.key[1])).sort(), ['c1', 'c9', 'dup']);
    // id 冲突时保留目标行。
    assert.equal(target.find(r => String(r.key[1]) === 'dup').title, '目标同名');

    // 消息 / 事件 / 附件都跟着换了 scope，附件载荷（Blob）原样保留。
    assert.equal(fake.rows('messages').find(r => r.scope === 'chat_history').messages[0].content, '离线内容');
    const event = fake.rows('events').find(r => r.scope === 'chat_history');
    assert.deepEqual(host(event.key), ['chat_history', 'c1', '0']);
    assert.deepEqual(host(event.conversation), ['chat_history', 'c1'], 'embedded conversation refs must be retargeted');
    const attachment = fake.rows('attachments').find(r => r.scope === 'chat_history');
    assert.ok(attachment.value instanceof Blob, 'Blob payloads must survive the copy');
    assert.deepEqual(host(attachment.conversation), ['chat_history', 'c1']);

    // 项目列表按内容合并：目标项目在前，源项目去重后追加，order 连续。
    const projects = draftValue(fake, '__work_projects__');
    assert.deepEqual(host(projects.map(p => p.id)), ['pTarget', 'p12', 'p7']);
    assert.deepEqual(host(projects.map(p => p.order)), [0, 1, 2]);

    // 分区：目标分区在前，源分区追加；expanded 浅合并且目标显式值优先。
    const layout = draftValue(fake, '__sidebar_layout__');
    assert.deepEqual(host(layout.sections.map(s => s.id)), ['sTarget', 's7']);
    assert.equal(layout.expanded.keep, true);
    assert.equal(layout.expanded.a, true);

    // 普通草稿也复制过来了。
    assert.equal(draftValue(fake, 'c1').draft, '保留草稿');
});

test('run() never deletes source data and marks each merged scope', async () => {
    const { fake, second } = await runAgainstFixture();
    assert.equal(second, 0);

    // 源桶必须原样保留（备份语义）：会话/消息/事件/附件/草稿一条不少、字段不改。
    for (const [name, rows] of Object.entries(seedFixture())) {
        const seedSource = rows.filter(r => r.scope !== 'chat_history');
        const kept = fake.rows(name).filter(r => r.scope !== 'chat_history');
        assert.equal(kept.length, seedSource.length, `${name} rows in the old buckets must be untouched`);
        for (const row of seedSource) {
            const same = kept.find(r => JSON.stringify(r.key) === JSON.stringify(row.key));
            assert.ok(same, `${name} row ${JSON.stringify(row.key)} must still exist`);
            assert.equal(same.scope, row.scope, 'the source scope field must not be rewritten');
        }
    }

    // 每个源 scope 一个幂等标记，且指向正确的来源。
    const markers = fake.rows('migrations').map(r => host(r.key));
    assert.deepEqual(markers.sort(), [
        ['chat_history', '__merge__chat_history_12'],
        ['chat_history', '__merge__chat_history_7']
    ]);
});

test('run() marks a scope whose rows all collide, so it is not rescanned forever', async () => {
    const fake = createIDB({
        conversations: [
            { key: ['chat_history', 'dup'], scope: 'chat_history' },
            { key: ['chat_history_9', 'dup'], scope: 'chat_history_9' }
        ]
    });
    const api = loadModule({ indexedDB: fake.indexedDB, MoonYaHistoryStore: { initialize: async () => {}, reload: async () => {} } });
    assert.equal(await api.run(), 0, 'a scope with nothing fresh to copy counts as unchanged');
    assert.equal(fake.scopes('migrations').length, 1, 'but it is still marked so startup stops rescanning it');
    assert.equal(fake.rows('conversations').length, 2, 'no duplicate rows are created');
});

test('run() degrades to a no-op when the browser lacks IndexedDB or the store module', async () => {
    assert.equal(await loadModule({ MoonYaHistoryStore: { initialize: async () => {}, reload: async () => {} } }).run(), 0);
    assert.equal(await loadModule({ indexedDB: createIDB().indexedDB }).run(), 0);
});
