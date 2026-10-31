import test from 'node:test';
import assert from 'node:assert/strict';
import { compactConversation, estimateMessageTokens, projectMessages } from '../src/conversation.mjs';

const handoff = summary => JSON.stringify({ summary, retain_groups: [] });
function history() {
  return [{ role: 'system', content: 'Follow user constraints.' },
    { role: 'user', content: 'Original objective: fix checkout. Constraint: preserve payments.' },
    ...Array.from({ length: 6 }, (_, index) => ({ role: 'assistant', content: `Evidence ${index}: ` + '旧'.repeat(2000), reasoning_content: `reason-${index}` })),
    { role: 'user', content: 'Correction: keep the existing API. Next: verify the changed checkout.' }];
}

test('no compression below threshold, while threshold equality triggers a handoff', async () => {
  const small = [{ role: 'system', content: '' }, { role: 'user', content: 'hello' }];
  assert.equal((await compactConversation(small, 10000)).messages, small);
  const exact = [{ role: 'system', content: '' }, { role: 'assistant', content: '旧'.repeat(7999) }, { role: 'user', content: '新' }];
  let requests = 0;
  const result = await compactConversation(exact, 10000, 0, {
    summarize: async () => { requests++; return handoff('Prior result summarized; continue the current request.'); },
  });
  assert.ok(requests > 0);
  assert.equal(result.beforeTokens, 8000);
  assert.ok(result.afterTokens + result.growthTokens < 8000);
});

test('handoffs vary with task information, preserve current inputs, and do not refill the window', async () => {
  const original = history();
  const saved = structuredClone(original);
  for (const summary of ['Checkout fix; preserve payments and API; verify changes.',
    'Checkout fix; preserve payments and API. ' + 'Evidence: verified checkout, pending regression. '.repeat(12)]) {
    const result = await compactConversation(original, 10000, 0, { summarize: async () => handoff(summary) });
    assert.equal(result.messages[0], original[0]);
    assert.equal(result.messages.at(-1), original.at(-1));
    assert.ok(result.messages[1].content.includes(summary.trim()));
    assert.ok(result.afterTokens < 4000, 'no window-filling tail');
    assert.equal((await compactConversation(result.messages, 10000)).removed, 0);
  }
  assert.deepEqual(original, saved);
});

test('multiple batches and compactions carry forward task facts and previous handoffs', async () => {
  const calls = [];
  const summarize = async (messages, { maxTokens }) => {
    assert.ok(estimateMessageTokens(messages) + maxTokens <= 10000);
    const data = JSON.parse(messages[1].content);
    calls.push(data);
    return handoff('Original objective: fix checkout. Preserve payments and API. Earlier evidence verified. Next: checkout regression.');
  };
  const first = await compactConversation(history(), 10000, 0, { summarize });
  assert.ok(calls.length > 1);
  assert.ok(calls.some(data => data.previous_handoff.includes('Preserve payments')));
  assert.ok(calls.some(data => JSON.stringify(data.groups).includes('Original objective')));
  const more = [...first.messages, ...history().slice(2)];
  calls.length = 0;
  const second = await compactConversation(more, 10000, 0, { summarize });
  assert.ok(calls.some(data => data.groups.some(group => group.messages?.some(message => message.content === first.messages[1].content))));
  const events = [{ event: 'user.message', payload: { content: 'raw old history' } },
    { event: 'context.compacted', payload: { history: second.messages.slice(1) } }];
  assert.deepEqual(projectMessages(events), second.messages.slice(1));
  assert.ok(!JSON.stringify(projectMessages(events)).includes('raw old history'));
});

test('model-requested exact evidence retains the whole exchange, reasoning and images', async () => {
  const image = { role: 'user', _origin: 'tool_images', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } }] };
  const exchange = id => [{ role: 'assistant', content: '', reasoning_content: 'important reasoning',
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, content: 'exact evidence ' + id }];
  const older = [...exchange('old'), image];
  const recent = exchange('recent');
  const messages = [history()[0], history()[1], ...older, ...history().slice(2, -1), ...recent, history().at(-1)];
  const result = await compactConversation(messages, 10000, 0, {
    summarize: async input => {
      const data = JSON.parse(input[1].content);
      const old = data.groups.find(group => group.messages?.some(message => message.tool_call_id === 'old'));
      return JSON.stringify({ summary: 'Continue checkout with exact old file evidence.', retain_groups: old ? [old.id] : [] });
    },
  });
  for (const message of [...older, ...recent]) assert.ok(result.messages.includes(message));
});

test('empty, oversized and invalid summaries have only one tighter retry and leave inputs intact', async () => {
  for (const invalid of ['', 'null', '[]', handoff(''), handoff('长'.repeat(9000)), '{"summary":"valid", "retain_groups":[999]}']) {
    let requests = 0;
    const original = history(), saved = structuredClone(original);
    await assert.rejects(compactConversation(original, 10000, 0, {
      summarize: async () => { requests++; return invalid; },
    }), /compaction_summary_invalid/);
    assert.equal(requests, 2);
    assert.deepEqual(original, saved);
  }
});

test('summary request failure and cancellation never produce replacement history', async () => {
  let requests = 0;
  await assert.rejects(compactConversation(history(), 10000, 0, {
    summarize: async () => { requests++; throw new Error('model unavailable'); },
  }), /model unavailable/);
  assert.equal(requests, 1);
  const controller = new AbortController();
  await assert.rejects(compactConversation(history(), 10000, 0, {
    signal: controller.signal,
    summarize: async () => { controller.abort(new Error('cancelled summary')); return handoff('valid'); },
  }), /cancelled summary/);
});

test('oversized necessary user input fails before any summary request', async () => {
  let called = false;
  await assert.rejects(compactConversation([...history(), { role: 'user', content: '新'.repeat(9000) }], 10000, 0, {
    summarize: async () => { called = true; return handoff('valid'); },
  }), /context_budget_exceeded/);
  assert.equal(called, false);
});

test('old observations are serialized in bounded fragments without splitting retained tool exchanges', async () => {
  const messages = history();
  messages[2].content = 'OLD_UNIQUE_EVIDENCE_' + '旧'.repeat(40000);
  const fragments = [];
  await compactConversation(messages, 10000, 0, {
    summarize: async input => {
      fragments.push(...JSON.parse(input[1].content).groups.filter(group => group.serialized_fragment));
      return handoff('Checkout objective, constraints, evidence and next actions are preserved.');
    },
  });
  assert.ok(fragments.length > 1);
  const joined = fragments.map(group => group.serialized_fragment).join('');
  assert.ok(joined.includes(messages[2].content));
  assert.equal(fragments[0].offset, 0);
});
