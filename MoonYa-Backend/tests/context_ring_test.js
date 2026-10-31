'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../MoonYa-Frontend/src', 'modules', 'script-1a-vars.js'), 'utf8');
const start = source.indexOf('window.MoonYaContextRing = (function() {');
const end = source.indexOf('        window.MoonYaModelContext.update(window.MoonYaModelContext.builtin());', start);
assert.ok(start >= 0 && end > start);
const ringScript = source.slice(start, end);

function createRing() {
  const nodes = new Map();
  const storage = new Map();
  const input = { value: '' };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, textContent: '',
      classList: { toggle() {}, remove() {} },
      addEventListener() {}, setAttribute() {},
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    window: { MoonYaModelContext: { key: () => 'builtin:deepseek-flash', builtin: () => ({id:'deepseek-flash'}) } },
    document: { getElementById: element, querySelector: () => input, addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    contextLimitTokens: 1000000,
    currentChatId: 'local-1',
    currentDbConversationId: 42,
    isAgentMode: true,
    getChatHistory: () => [],
    getAuthHeaders: () => ({ Authorization: 'Bearer fixture' }),
    fetch: async () => { throw new Error('no response configured'); },
    setTimeout, clearTimeout,
  });
  vm.runInContext(ringScript, context);
  return { context, nodes, storage, input, text: id => element(id).textContent };
}

test('Work ring restores the latest runtime usage, changes scope, and shows failures', async () => {
  const ring = createRing();
  ring.storage.set('moonya.harness.session.local-1.__default__', 'session-1');
  ring.context.fetch = async (url, options) => {
    assert.match(url, /action=context_usage&session_id=session-1/);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    return { ok: true, json: async () => ({ success: true, data: {
      used_tokens: 1200, limit_tokens: 1000000,
      system_tokens: 400, tools_tokens: 200, messages_tokens: 600,
    } }) };
  };
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.text('crtPercent'), '<1%');
  assert.equal(ring.text('crtNums'), '~1.2K / 1M');
  assert.equal(ring.text('crtSystemPct'), '~400');

  ring.context.currentChatId = 'local-2';
  ring.context.currentDbConversationId = 43;
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.text('crtNums'), '~0 / 1M');
  ring.storage.set('moonya.harness.session.local-2.__default__', 'session-2');
  ring.context.fetch = async () => ({ ok: false, json: async () => ({ success: false }) });
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.text('crtPercent'), '—');
  assert.match(ring.text('crtNums'), /暂不可用/);

  ring.context.currentChatId = 'local-1';
  ring.context.currentDbConversationId = 42;
  ring.context.contextLimitTokens = 262144;
  ring.context.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: {
    used_tokens: 1200, limit_tokens: 1000000,
    system_tokens: 400, tools_tokens: 200, messages_tokens: 600,
  } }) });
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.text('crtNums'), '~0 / 262.1K');
});

test('Work ring reads legacy database bindings without rewriting localStorage', async () => {
  const ring = createRing();
  ring.storage.set('moonya.harness.session.42.__default__', 'legacy-session');
  ring.context.fetch = async url => {
    assert.match(url, /session_id=legacy-session/);
    return { ok: true, json: async () => ({ success: true, data: {
      used_tokens: 2500, limit_tokens:1000000, system_tokens: 1000, tools_tokens: 500, messages_tokens: 1000,
    } }) };
  };
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.storage.get('moonya.harness.session.local-1.__default__'), undefined);
  assert.equal(ring.text('crtNums'), '~2.5K / 1M');
});


test('Work ring uses its migrated IndexedDB session binding without localStorage history', async () => {
  const ring = createRing();
  ring.context.currentDbConversationId = null;
  ring.context.getChatHistory = () => [{ id: 'local-1', runtimeSessions: { __default__: 'local-session' } }];
  ring.context.fetch = async url => {
    assert.match(url, /session_id=local-session/);
    return { ok: true, json: async () => ({ success: true, data: { used_tokens: 3200, limit_tokens:1000000 } }) };
  };
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(ring.text('crtNums'), '~3.2K / 1M');
  assert.equal(ring.storage.size, 0);
});

test('committed compaction usage defeats delayed queries and older SSE events', async () => {
  const ring = createRing();
  ring.storage.set('moonya.harness.session.local-1.__default__', 'session-1');
  let finish;
  ring.context.fetch = async () => new Promise(resolve => { finish = resolve; });
  const pending = ring.context.window.MoonYaContextRing.refresh();
  const apply = ring.context.window.MoonYaContextRing.applyServerUsage;
  assert.equal(apply({ _harness: true, session_id: 'session-1', seq: 20,
    used_tokens: 9000, limit: 1000000, system_tokens: 2000, tools_tokens: 3000, messages_tokens: 4000 }), true);
  finish({ ok: true, json: async () => ({ success: true, data: {
    used_tokens: 800000, session_id: 'session-1', seq: 18,
  } }) });
  await pending;
  assert.equal(ring.text('crtNums'), '~9K / 1M');
  assert.equal(apply({ _harness: true, session_id: 'session-1', seq: 19, used_tokens: 800000 }), false);
  assert.equal(ring.text('crtNums'), '~9K / 1M');
  assert.equal(apply({ _harness: true, session_id: 'other-session', seq: 99, used_tokens: 999999 }), false);
  assert.equal(ring.text('crtNums'), '~9K / 1M');
});

test('switching chats during a Work usage query cannot apply the previous chat snapshot', async () => {
  const ring = createRing();
  ring.storage.set('moonya.harness.session.local-1.__default__', 'session-1');
  let finish;
  ring.context.fetch = async () => new Promise(resolve => { finish = resolve; });
  const pending = ring.context.window.MoonYaContextRing.refresh();
  ring.context.currentChatId = 'local-2';
  ring.context.currentDbConversationId = null;
  await ring.context.window.MoonYaContextRing.refresh();
  finish({ ok: true, json: async () => ({ success: true, data: {
    used_tokens: 800000, session_id: 'session-1', seq: 18,
  } }) });
  await pending;
  assert.equal(ring.text('crtNums'), '~0 / 1M');
});

test('creating an active new chat clears previous usage and invalidates pending queries', async () => {
  const ring = createRing();
  ring.context.currentDbConversationId = null;
  ring.context.window.MoonYaContextRing.applyServerUsage({ limit:1000000, used_tokens: 227000, messages_tokens: 222600 });
  ring.storage.set('moonya.harness.session.local-1.__default__', 'session-1');
  let finish;
  ring.context.fetch = async () => new Promise(resolve => { finish = resolve; });
  const pending = ring.context.window.MoonYaContextRing.refresh();
  const history = [];
  Object.assign(ring.context, {
    CHAT_HISTORY_KEY: 'fixture',
    currentConversationMode: () => 'work',
    createClientUuid: () => 'new-chat',
    activateConversationRuntime() {}, renderChatList() {},
    getChatHistory: () => history,
  });
  ring.context.window.MoonYaHistoryStore = {
    initialize: async () => {}, list: () => history, save: async () => {},
  };
  const features = fs.readFileSync(path.join(__dirname, '../../MoonYa-Frontend/src', 'modules', 'script-1b-features.js'), 'utf8');
  const begin = features.indexOf('async function createNewChat(');
  const stop = features.indexOf('// 共享 helper', begin);
  vm.runInContext(features.slice(begin, stop), ring.context);
  await ring.context.createNewChat();
  assert.equal(ring.context.currentChatId, 'new-chat');
  assert.equal(ring.text('crtNums'), '~0 / 1M');
  finish({ ok: true, json: async () => ({ success: true, data: { used_tokens: 227000 } }) });
  await pending;
  assert.equal(ring.text('crtNums'), '~0 / 1M');

  ring.context.window.MoonYaContextRing.applyServerUsage({ limit:1000000, used_tokens: 1200 });
  await ring.context.createNewChat({ activate: false, reuse: false });
  assert.equal(ring.text('crtNums'), '~1.2K / 1M');
});

test('Chat usage events from an old conversation cannot restore its occupancy', async () => {
  const ring = createRing();
  ring.context.isAgentMode = false;
  ring.context.currentDbConversationId = null;
  ring.context.currentChatId = 'new-chat';
  await ring.context.window.MoonYaContextRing.refresh();
  const apply = ring.context.window.MoonYaContextRing.applyServerUsage;
  assert.equal(apply({ _chat_id: 'local-1', used_tokens: 227000 }), false);
  assert.equal(ring.text('crtNums'), '~0 / 1M');
  assert.equal(apply({ limit:1000000, _chat_id: 'new-chat', used_tokens: 1200 }), true);
  assert.equal(ring.text('crtNums'), '~1.2K / 1M');
});

test('legacy context samples never invent missing category token counts', () => {
  const ring = createRing();
  assert.equal(ring.context.window.MoonYaContextRing.applyServerUsage({ limit:1000000, used_tokens:1200 }), true);
  assert.equal(ring.text('crtSystemPct'), '暂不可用');
  assert.equal(ring.text('crtToolsPct'), '暂不可用');
  assert.equal(ring.text('crtMessagesPct'), '暂不可用');
});

test('over-capacity drafts display the actual ratio while the ring stays bounded', () => {
  const ring = createRing();
  ring.context.window.MoonYaContextRing.render(1200000,1000000,{system:1000,tools:0,messages:1199000});
  assert.equal(ring.text('crtPercent'),'120%');
  assert.equal(ring.nodes.get('contextRingFill').style.strokeDashoffset,'0');
});

test('model switches reject stale usage even when both models have the same capacity', async () => {
  const ring = createRing();
  ring.context.currentDbConversationId = null;
  let ref = {provider_id:'kimi',model_id:'kimi-k2.6'};
  ring.context.window.MoonYaModels = {reference:()=>ref};
  ring.context.window.MoonYaModelContext.key = () => JSON.stringify(ref);
  ring.context.contextLimitTokens = 262144;
  await ring.context.window.MoonYaContextRing.refresh();
  const apply = ring.context.window.MoonYaContextRing.applyServerUsage;
  assert.equal(apply({model_ref:ref,limit_tokens:262144,used_tokens:2000}),true);
  ref = {provider_id:'kimi',model_id:'kimi-k2.7-code'};
  await ring.context.window.MoonYaContextRing.refresh();
  assert.equal(apply({model_ref:{provider_id:'kimi',model_id:'kimi-k2.6'},limit_tokens:262144,used_tokens:90000}),false);
  assert.equal(ring.text('crtNums'),'~0 / 262.1K');
  assert.equal(apply({model_ref:ref,limit_tokens:262144,used_tokens:1200}),true);
  assert.equal(ring.text('crtNums'),'~1.2K / 262.1K');
  ring.context.contextLimitTokens = null;
  await ring.context.window.MoonYaContextRing.refresh();
  assert.match(ring.text('crtNums'),/待配置/);
  assert.equal(apply({model_ref:ref,limit_tokens:262144,used_tokens:9999}),false);
});
