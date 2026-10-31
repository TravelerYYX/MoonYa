import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactConversation, projectMessages, validateToolExchanges } from '../src/conversation.mjs';
import { SessionStore } from '../src/session-store.mjs';

const call = id => ({ id, type: 'function', function: { name: 'computer_use_tool', arguments: '{}' } });
const assistant = ids => ({ role: 'assistant', content: '', tool_calls: ids.map(call) });
const tool = id => ({ role: 'tool', tool_call_id: id, content: '{}' });
const decision = ids => ({ event: 'assistant.message', payload: { tool_calls: ids.map(call) } });
const result = (id, value = {}) => ({ event: 'tool.completed', tool_call_id: id, payload: { name: 'computer_interact', result: value } });

test('all requests reject orphan, duplicate and unfinished tool exchanges even below budget', async () => {
  for (const history of [[tool('a')], [assistant(['a']), tool('b')], [assistant(['a']), tool('a'), tool('a')],
    [assistant(['a'])], [assistant(['a']), { role: 'user', content: 'next' }, tool('a')], [assistant(['a', 'a']), tool('a')],
    [{ role: 'user', _origin: 'tool_images', content: [] }]]) {
    assert.throws(() => validateToolExchanges(history), /invalid_tool_history/);
    await assert.rejects(compactConversation([{ role: 'system', content: 'system' }, ...history], 8192), /invalid_tool_history/);
  }
  validateToolExchanges([assistant(['a', 'b']), tool('b'), tool('a'), { role: 'user', content: 'next' }]);
});

test('legacy screenshot bytes do not trigger the old 240000-character threshold', async () => {
  // Valid PNG header with a large payload, matching the old inline image shape.
  const header = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const png = Buffer.concat([header, Buffer.alloc(50000)]).toString('base64');
  const events = [{ event: 'user.message', payload: { content: '打开计算器计算781+12-122' } }];
  for (let i = 0; i < 4; i++) events.push(decision([`image-${i}`]), result(`image-${i}`, { success: true, evidence_image: png }));
  const messages = [{ role: 'system', content: 'system' }, ...projectMessages(events)];
  assert.ok(JSON.stringify(messages).length > 240000);
  assert.equal(messages.filter(m => m._origin === 'tool_images').length, 4);
  assert.ok(messages.filter(m => m.role === 'tool').every(m => !m.content.includes(png)));
  assert.equal((await compactConversation(messages, 300000)).removed, 0);
  validateToolExchanges(messages);
});

test('invalid checkpoints fall back to the last valid history and legacy checkpoints replay raw events', () => {
  const first = [{ role: 'user', content: 'original objective' }, assistant(['old']), tool('old')];
  const events = [{ event: 'context.compacted', payload: { history: first } },
    decision(['next']), result('next'),
    { event: 'context.compacted', payload: { history: [tool('next')] } }];
  assert.deepEqual(projectMessages(events).slice(0, first.length), first);
  assert.equal(projectMessages(events).at(-1).tool_call_id, 'next');
  const legacy = [{ event: 'user.message', payload: { content: 'original objective' } }, decision(['a']), result('a'),
    { event: 'context.compacted', payload: { removed_messages: 23, before_chars: 253308, after_chars: 52121 } }];
  assert.equal(projectMessages(legacy)[0].content, 'original objective');
  validateToolExchanges(projectMessages(legacy));
});

test('cancelled multi-tool rounds settle unknown outcomes before images and ignore late duplicate results', () => {
  const events = [decision(['done', 'unknown']), result('done'),
    { event: 'user.message', payload: { content: 'continue after cancellation' } }, result('unknown')];
  const history = projectMessages(events);
  validateToolExchanges(history);
  assert.equal(history.filter(m => m.tool_call_id === 'unknown').length, 1);
  assert.equal(JSON.parse(history[2].content).error_code, 'history_interrupted');
});

test('truncated legacy observation requests a fresh screen without leaking sliced base64', () => {
  const history = projectMessages([decision(['a']), { ...result('a'), payload: { name: 'computer_observe',
    result: { success: true, truncated: true, original_chars: 500000, output: 'sliced-image-data' } } }]);
  const recovered = JSON.parse(history.at(-1).content);
  assert.equal(recovered.requires_fresh_observation, true);
  assert.ok(!history.at(-1).content.includes('sliced-image-data'));
});

test('restart persists failures for decisions without tool.started, including terminal cancelled turns, only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moonya-history-'));
  try {
    const first = new SessionStore(root); await first.initialize();
    const session = await first.create({ workspace: root });
    await first.append(session, 'turn.started', {}, { turn: 1 });
    await first.append(session, 'assistant.message', { tool_calls: [call('never-started')] }, { turn: 1, step: 1 });
    await first.append(session, 'turn.cancelled', {}, { turn: 1, status: 'cancelled' });
    const second = new SessionStore(root); await second.initialize();
    const recovered = second.get(session.id);
    assert.equal(recovered.events.filter(e => e.event === 'tool.failed').length, 1);
    assert.equal(recovered.events.filter(e => e.event === 'tool.started').length, 0);
    validateToolExchanges(projectMessages(recovered.events));
    const persisted = await readFile(join(root, `${session.id}.jsonl`), 'utf8');
    const third = new SessionStore(root); await third.initialize();
    assert.equal(await readFile(join(root, `${session.id}.jsonl`), 'utf8'), persisted);
  } finally { await rm(root, { recursive: true, force: true }); }
});
