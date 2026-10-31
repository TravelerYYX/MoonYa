'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '../MoonYa-Frontend/src/modules/script-1e-rest.js'), 'utf8');
const start = source.indexOf('        const harnessCompactionNoticeSeq = new Map();');
const end = source.indexOf('        function renderTeamApprovalLog(event)', start);
assert.ok(start >= 0 && end > start);

function ui(storage = new Map()) {
  const notifications = [], rows = [];
  const context = vm.createContext({
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    showToast: text => notifications.push(text),
    conversationTurnKey: event => event.run_id + ':' + event.turn,
    turnProcessContainer: () => ({ body: {
      querySelectorAll: () => rows,
      appendChild: row => { const old = rows.indexOf(row); if (old >= 0) rows.splice(old, 1); rows.push(row); },
    } }),
    document: { createElement: () => ({ dataset: {}, setAttribute: function(key, value) {
      if (key === 'data-event-seq') this.dataset.eventSeq = value;
    } }) },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, notifications, rows, storage };
}
const event = (name, seq, step = 1) => ({ run_id: 'session-one', event: name, turn: 1, step, seq });

test('one checkpoint notification survives replay and page reload without duplicates', () => {
  const first = ui();
  first.context.notifyHarnessCompaction(event('context.compacted', 5));
  first.context.notifyHarnessCompaction(event('context.compacted', 5));
  first.context.notifyHarnessCompaction(event('context.compacted', 4));
  assert.equal(first.notifications.length, 1);
  const restored = ui(first.storage);
  restored.context.notifyHarnessCompaction(event('context.compacted', 5));
  assert.equal(restored.notifications.length, 0);
  restored.context.notifyHarnessCompaction(event('context.compacted', 8, 2));
  assert.equal(restored.notifications.length, 1);
});

test('progress becomes one completed row and old replay cannot overwrite it', () => {
  const page = ui();
  page.context.renderCodexSystemActivity(event('context.compacting', 4));
  assert.match(page.rows[0].innerHTML, /正在压缩上下文/);
  page.context.renderCodexSystemActivity(event('context.compacted', 5));
  assert.equal(page.rows.length, 1);
  assert.match(page.rows[0].innerHTML, /上下文已自动压缩/);
  page.context.renderCodexSystemActivity(event('context.compacting', 4));
  page.context.renderCodexSystemActivity(event('context.compacted', 5));
  assert.equal(page.rows.length, 1);
  assert.match(page.rows[0].innerHTML, /上下文已自动压缩/);
  page.context.renderCodexSystemActivity(event('context.compacting', 6, 2));
  page.context.renderCodexSystemActivity(event('context.compaction_failed', 7, 2));
  assert.equal(page.rows.length, 2);
  assert.match(page.rows[1].innerHTML, /上下文压缩未完成/);
});
