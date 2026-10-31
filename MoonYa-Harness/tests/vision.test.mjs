import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToolVisuals, toolImageMessage } from '../src/vision.mjs';
import { compactConversation, projectMessages, estimateTokensForContent } from '../src/conversation.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
const summaryOptions = { summarize: async () => JSON.stringify({ summary: 'Continue the original task using the retained visual evidence.', retain_groups: [] }) };

test('visual tool bytes become images without leaking into tool text', () => {
  for (const [name, field] of [['computer_observe', 'image'], ['computer_interact', 'evidence_image'], ['browser_automation_control', 'screenshot']]) {
    const raw = { success: true, [field]: png, snapshot_version: 'v1', page_version: 3, window: { title: 'test' } };
    const projection = projectToolVisuals(name, raw, 'call1');
    assert.equal(projection.images[0].url, `data:image/png;base64,${png}`);
    assert.equal(projection.images[0].source.tool_call_id, 'call1');
    assert.equal(projection.result.snapshot_version, 'v1');
    assert.ok(!JSON.stringify(projection.result).includes(png));
    assert.equal(raw[field], png, 'the durable raw evidence must remain intact');
    const message = toolImageMessage(projection.images, 'low');
    assert.equal(message.content[1].image_url.detail, 'low');
    assert.equal(estimateTokensForContent([message.content[1]]), 1100);
  }
});

test('invalid or absent screenshot bytes never produce fake visual evidence', () => {
  for (const value of [null, '', 'invalid', 'data:image/jpeg;base64,AAAA', { path: 'C:\\secret.png' }]) {
    const projected = projectToolVisuals('computer_observe', { success: true, image: value }, 'call');
    assert.equal(projected.images.length, 0);
    assert.equal(projected.result.image, undefined);
    if (value) assert.match(projected.result.visual_error, /no image was supplied/);
  }
  assert.equal(projectToolVisuals('read_file', { image: png }, 'call').images.length, 0);
});

test('compaction retains the actual user task and keeps tool images in their exchange', async () => {
  const image = toolImageMessage(projectToolVisuals('computer_observe', { image: png }, 'visual').images);
  const call = { id: 'visual', type: 'function', function: { name: 'computer_observe', arguments: '{}' } };
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old turn' },
    { role: 'assistant', content: 'old verbose output '.repeat(3000) },
    { role: 'user', content: 'CURRENT USER OBJECTIVE' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'visual', content: '{}' },
    image,
  ];
  const compacted = await compactConversation(messages, 10000, 0, summaryOptions);
  assert.ok(compacted.removed > 0);
  assert.ok(compacted.messages.some(message => message.content === 'CURRENT USER OBJECTIVE'));
  assert.deepEqual(compacted.messages.slice(-3), messages.slice(-3));
  const withAnotherExchange = [...messages, { role: 'assistant', content: 'later response '.repeat(800) }];
  const next = await compactConversation(withAnotherExchange, 10000, 0, summaryOptions);
  const keptImage = next.messages.find(message => message._origin === 'tool_images');
  assert.equal(Boolean(keptImage), next.messages.some(message => message.tool_call_id === 'visual'));
});

test('history replay and persisted compaction preserve source and image bytes', () => {
  const result = { success: true, image: png, snapshot_version: 'v1' };
  const message = toolImageMessage(projectToolVisuals('computer_observe', result, 'call').images, 'low');
  const events = [
    { event: 'user.message', payload: { content: 'user objective' } },
    { event: 'assistant.message', payload: { content: '', tool_calls: [{ id: 'call' }] } },
    { event: 'tool.completed', tool_call_id: 'call', payload: { name: 'computer_observe', result } },
    { event: 'tool.images', payload: { message } },
  ];
  const history = projectMessages(events);
  assert.equal(history.at(-1).content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(history.at(-1)._origin, 'tool_images');
  assert.ok(!history.at(-2).content.includes(png));
  const checkpoint = JSON.parse(JSON.stringify({ event: 'context.compacted', payload: { history } }));
  assert.deepEqual(projectMessages([...events, checkpoint]), history);
});

test('many screenshots compact by image byte limits as well as token limits', async () => {
  // Repeated references avoid allocating the large fixture more than once.
  const url = 'data:image/png;base64,' + 'A'.repeat(16 * 1024 * 1024); // 12 MiB per image
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'preserve original user task' }];
  for (let index = 0; index < 7; index++) {
    messages.push(
      { role: 'assistant', content: '', tool_calls: [{ id: `call-${index}` }] },
      { role: 'tool', tool_call_id: `call-${index}`, content: '{}' },
      { role: 'user', _origin: 'tool_images', content: [{ type: 'image_url', image_url: { url, detail: 'low' } }] },
    );
  }
  const compacted = await compactConversation(messages, 300000, 0, summaryOptions);
  assert.ok(compacted.messages.some(message => message.content === 'preserve original user task'));
  assert.equal(compacted.messages.filter(message => message._origin === 'tool_images').length, 1);
  assert.equal(compacted.messages.filter(message => message.role === 'tool').length, 1);
  await assert.rejects(compactConversation([
    { role: 'system', content: 'system' },
    { role: 'user', content: Array.from({ length: 7 }, () => ({ type: 'image_url', image_url: { url } })) },
  ], 300000, 0, summaryOptions), /visual_budget_exceeded/);
});

test('restart between raw evidence and the image event recovers a complete batch', () => {
  const events = [
    { event: 'user.message', payload: { content: 'human task', image_detail: 'low' } },
    { event: 'assistant.message', payload: { tool_calls: [{ id: 'image' }, { id: 'interrupted' }] } },
    { event: 'tool.completed', tool_call_id: 'image', payload: { name: 'computer_observe', result: { success: true, image: png } } },
    { event: 'tool.failed', tool_call_id: 'interrupted', payload: { name: 'read_file', result: { success: false, error: 'runtime_restarted' } } },
  ];
  const history = projectMessages(events);
  assert.deepEqual(history.slice(-3).map(message => message.role), ['tool', 'tool', 'user']);
  assert.equal(history.at(-1).content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(history.at(-1).content[1].image_url.detail, 'low');
});
