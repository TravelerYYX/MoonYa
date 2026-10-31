import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
const waitSource = source.slice(source.indexOf('async function waitForApproval('), source.indexOf('async function waitForUserAction('));

function fixture() {
  let now = Date.parse('2030-01-01T00:00:00Z');
  let timerSeq = 0;
  const timers = new Map();
  const events = [];
  const controller = new AbortController();
  const session = { pendingApprovals: new Map() };
  class Clock extends Date { static now() { return now; } }
  const store = { append: async (_session, event, payload, meta) => events.push({ event, payload, meta }) };
  const wait = vm.runInNewContext(`${waitSource}\nwaitForApproval`, {
    Date: Clock, Number, Math, Promise, Error, process: { env: {} }, DEFAULT_APPROVAL_TIMEOUT_MS: 600000,
    randomUUID: () => 'approval-test', store, office: { waiting: (_session, operation) => operation() },
    withoutWaitTime: (_meta, operation) => operation(),
    setTimeout: (callback, delay) => { timers.set(++timerSeq, { callback, at: now + delay }); return timerSeq; },
    clearTimeout: id => timers.delete(id)
  });
  const start = (preflight = {}) => wait(session, { id: 'tool-test', function: { name: 'execute_command' } },
    { command: 'Write-Output demo' }, preflight, { signal: controller.signal });
  const advance = async milliseconds => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.callback(); }
  };
  return { events, timers, session, controller, store, start, advance, now: () => now };
}

test('ordinary approval exposes and enforces exactly ten minutes', async () => {
  const f = fixture();
  const result = f.start();
  assert.equal(Date.parse(f.events[0].payload.expires_at) - f.now(), 600000);
  await f.advance(599999);
  assert.equal(f.session.pendingApprovals.size, 1);
  assert.equal(f.events.length, 1);
  await f.advance(1);
  assert.equal(await result, 'expired');
  assert.equal(f.events[1].payload.status, 'expired');
  assert.equal(f.events[1].meta.status, 'expired');
  assert.equal(f.session.pendingApprovals.size, 0);
  assert.equal(f.timers.size, 0);
});

test('browser approval uses its real absolute deadline', async () => {
  const f = fixture();
  const expiresAt = new Date(f.now() + 30000).toISOString();
  const result = f.start({ expiresAt });
  assert.equal(f.events[0].payload.expires_at, expiresAt);
  await f.advance(30000);
  assert.equal(await result, 'expired');
});

test('allowing claims settlement so a delayed expiry cannot overwrite it', async () => {
  const f = fixture();
  const result = f.start();
  const pending = f.session.pendingApprovals.get('approval-test');
  f.session.pendingApprovals.delete(pending.id);
  pending.resolve('allow_once');
  await pending.expire();
  assert.equal(await result, 'allow_once');
  assert.equal(f.events.filter(event => event.event === 'approval.decided').length, 0);
  assert.equal(f.timers.size, 0);
});

test('expiry removes the pending request before an asynchronous log write', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => release = resolve);
  const append = f.store.append;
  f.store.append = async (...args) => { await append(...args); if (args[1] === 'approval.decided') await gate; };
  const result = f.start();
  const expiring = f.session.pendingApprovals.get('approval-test').expire();
  assert.equal(f.session.pendingApprovals.size, 0, 'late approval requests must already see not pending');
  release();
  await expiring;
  assert.equal(await result, 'expired');
  assert.equal(f.events.filter(event => event.event === 'approval.decided').length, 1);
});

test('stopping a task clears the approval timer without expiring the cancelled request', async () => {
  const f = fixture();
  const result = f.start();
  f.session.pendingApprovals.clear();
  f.controller.abort(new Error('Cancelled by user'));
  await assert.rejects(result, /Cancelled by user/);
  await f.advance(600000);
  assert.equal(f.events.filter(event => event.event === 'approval.decided').length, 0);
  assert.equal(f.timers.size, 0);
});
