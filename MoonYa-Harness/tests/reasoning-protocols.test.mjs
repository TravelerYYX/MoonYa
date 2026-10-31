import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelConfigStore, endpoint } from '../src/model-config.mjs';
import { normalizeModel } from '../src/model-catalog.mjs';
import { callModel, openaiPayload, anthropicPayload, responsesPayload } from '../src/model-client.mjs';
import { normalizeUsage } from '../src/conversation-stats.mjs';
import { ChatHistory } from '../src/chat-history.mjs';

const listen = async handler => { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; };
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const body = async req => { const parts = []; for await (const part of req) parts.push(part); return JSON.parse(Buffer.concat(parts)); };
const base = server => `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
const fixture = (server, id = 'gpt-6-sol') => ({ ...normalizeModel({ id, overrides: { context_window: 32768 } }, 'custom', 'openai-completions'),
  name: id, base_url: base(server), provider_id: 'gateway', api_key: 'fixture-secret', protocol: id === 'gpt-6-sol' ? 'openai-responses' : 'openai-completions' });
const thought = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '先检查配置。' }], encrypted_content: 'opaque-reasoning' };
const answer = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经完成。', annotations: [] }], status: 'completed' };
const call = { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'todo_write', arguments: '{"items":[]}', status: 'completed' };
const result = output => ({ object: 'response', status: 'completed', output, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 40 } });
const emit = (res, event) => res.write('data: ' + JSON.stringify(event) + '\r\n\r\n');

test('exact gateway IDs gain thinking profiles; existing explicit overrides and protocols win', async () => {
  const actual = normalizeModel({ id: 'gpt-6.1-sol' }, 'custom', 'openai-completions');
  assert.equal(actual.recommended_protocol, 'openai-responses'); assert.equal(actual.allow_thinking_off, false);
  assert.deepEqual(actual.efforts, ['low','medium','high','xhigh','max']);
  assert.throws(() => responsesPayload(actual, [], 'none'), /关闭思考/);
  const gpt = normalizeModel({ id: 'gpt-6-sol' }, 'custom', 'openai-completions');
  assert.equal(gpt.supports_thinking, true); assert.equal(gpt.default_effort, 'medium');
  assert.deepEqual(gpt.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(gpt.recommended_protocol, 'openai-responses'); assert.equal(gpt.custom_protocol, false);
  const gemini = normalizeModel({ id: 'gemini-3.8-flash' }, 'openai', 'openai-completions');
  assert.equal(gemini.reasoning, 'gemini'); assert.equal(gemini.allow_thinking_off, false);
  assert.deepEqual(gemini.efforts, ['low', 'medium', 'high']); assert.equal(gemini.context_window, null);
  assert.throws(() => openaiPayload(gemini, [], 'none'), /关闭思考/);
  assert.throws(() => openaiPayload(gemini, [], 'max'), /不支持该思考强度/);
  const old = { ...gpt, reasoning: '', supports_thinking: false, efforts: [], default_effort: 'auto', source: 'api', overrides: {} };
  assert.equal(normalizeModel(old, 'custom', 'openai-completions', { stored: true }).supports_thinking, true);
  assert.equal(normalizeModel({ ...old, overrides: { supports_thinking: false } }, 'custom', 'openai-completions', { stored: true }).supports_thinking, false);
  assert.equal(normalizeModel({ ...old, overrides: { efforts: ['low'], default_effort: 'low' } }, 'custom', 'openai-completions', { stored: true }).default_effort, 'low');
  assert.equal(normalizeModel({ id: 'gpt-6-sol-alias' }, 'custom', 'openai-completions').supports_thinking, false);
  const disabled = normalizeModel({ id: 'gpt-6-sol', custom_protocol: true, protocol: 'openai-responses', api_capabilities: { responses: { supported: false } } }, 'custom', 'openai-completions');
  assert.equal(disabled.supports_chat, false);
  const dir = await mkdtemp(join(tmpdir(), 'moonya-responses-config-'));
  try {
    const path = join(dir, 'config.toml'), store = new ModelConfigStore(path);
    await store.save({ id: 'gateway', provider: 'custom', base_url: 'https://wawapii.com/v1/chat/completions',
      protocol: 'openai-completions', api_key: 'fixture-secret', models: [{ ...gpt, overrides: { custom_protocol: true, protocol: 'openai-responses' } }] });
    const before = await readFile(path, 'utf8');
    const model = await new ModelConfigStore(path).resolve({ provider_id: 'gateway', model_id: 'gpt-6-sol' });
    assert.equal(model.protocol, 'openai-responses'); assert.equal(model.api_key, 'fixture-secret');
    assert.equal(await readFile(path, 'utf8'), before, 'reading must not migrate the file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('payloads normalize full endpoint URLs and keep Gemini thinking separate from OpenAI effort', () => {
  for (const path of ['', '/chat/completions', '/responses', '/models', '/messages/']) assert.equal(endpoint('https://wawapii.com/v1' + path, '/responses'), 'https://wawapii.com/v1/responses');
  const gpt = { ...normalizeModel({ id: 'gpt-6-sol' }, 'custom', 'openai-completions'), name: 'gpt-6-sol' };
  const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'todo_write', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'OK' }];
  const tools = [{ type: 'function', function: { name: 'todo_write', parameters: { type: 'object', properties: {} } } }];
  const payload = responsesPayload(gpt, messages, 'auto', { maxTokens: 2048, tools });
  assert.deepEqual(payload.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(payload.max_output_tokens, 2048); assert.equal(payload.store, false);
  assert.equal(payload.input[1].content[1].type, 'input_image'); assert.equal(payload.input[2].call_id, 'call_1');
  assert.equal(payload.input[3].type, 'function_call_output'); assert.equal(payload.tools[0].strict, false);
  assert.equal(responsesPayload(gpt, [], 'none').reasoning.summary, undefined);
  assert.equal(responsesPayload(gpt, [], 'high', { summary: true, tools }).tools, undefined);
  const gemini = { ...normalizeModel({ id: 'gemini-3.8-flash' }, 'custom', 'openai-completions'), name: 'gemini-3.8-flash' };
  const google = openaiPayload(gemini, [], 'auto');
  assert.deepEqual(google.extra_body.google.thinking_config, { thinking_level: 'medium', include_thoughts: true });
  assert.equal(google.reasoning_effort, undefined);
  assert.equal(openaiPayload(gemini, [], 'none', { summary: true }).extra_body.google.thinking_config.include_thoughts, true);
  assert.deepEqual(normalizeUsage(result([]).usage, 'openai-responses'), { input: 80, cache_read: 20, cache_write: 0, output: 40, total_input: 100 });
});

test('Responses stream reconciles summary, text and fragmented tool snapshots exactly once and replays encrypted items', async () => {
  const requests = [], errors = [];
  const server = await listen(async (req, res) => {
    try {
      requests.push({ path: req.url, body: await body(req), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      emit(res, { type: 'response.output_item.added', output_index: 0, item: { ...thought, summary: [] } });
      emit(res, { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '先检查' });
      emit(res, { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '先检查配置。' });
      emit(res, { type: 'response.output_item.done', output_index: 0, item: thought });
      emit(res, { type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } });
      emit(res, { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '已经完成。' });
      emit(res, { type: 'response.output_text.done', output_index: 1, content_index: 0, text: '已经完成。' });
      emit(res, { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } });
      for (const delta of ['{"items":', '[]}']) emit(res, { type: 'response.function_call_arguments.delta', output_index: 2, delta });
      emit(res, { type: 'response.function_call_arguments.done', output_index: 2, arguments: call.arguments });
      emit(res, { type: 'response.output_item.done', output_index: 2, item: call });
      emit(res, { type: 'response.completed', response: result([thought, answer, call]) }); res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.destroy(); }
  });
  const dir = await mkdtemp(join(tmpdir(), 'moonya-responses-history-'));
  try {
    const model = fixture(server), deltas = [], activity = [], metrics = [];
    const assistant = await callModel(model, [{ role: 'user', content: 'Hi' }], 'high', AbortSignal.timeout(3000), d => deltas.push(d), { onActivity: a => activity.push(a), onMetrics: m => metrics.push(m) });
    assert.equal(requests[0].path, '/v1/responses'); assert.equal(requests[0].auth, 'Bearer fixture-secret');
    assert.equal(assistant.content, '已经完成。'); assert.equal(assistant.reasoning_content, '先检查配置。');
    assert.equal(deltas.filter(d => d.type === 'reasoning').map(d => d.text).join(''), assistant.reasoning_content);
    assert.equal(deltas.filter(d => d.type === 'content').map(d => d.text).join(''), assistant.content);
    assert.equal(assistant.tool_calls[0].id, 'call_1'); assert.equal(assistant.tool_calls[0].function.arguments, call.arguments);
    assert.deepEqual(activity, [{ phase: 'tool_arguments' }]); assert.equal(metrics.at(-1).usage.output, 40);
    const path = join(dir, 'history.jsonl'); await new ChatHistory(path).remember('scope', model, assistant, 'first');
    const messages = await new ChatHistory(path).replay('scope', model, [{ role: 'assistant', content: assistant.content, _moonya_message_id: 'first' }, { role: 'tool', tool_call_id: 'call_1', content: 'OK' }]);
    const payload = responsesPayload(model, messages, 'high'); assert.deepEqual(payload.input.slice(0, 3), [thought, answer, call]);
    assert.equal(payload.input[3].call_id, 'call_1'); assert.ok(!JSON.stringify(payload).includes('_moonya_message_id'));
    assert.ok(!JSON.stringify(responsesPayload({ ...model, provider_id: 'other' }, messages, 'high')).includes('opaque-reasoning'));
    assert.doesNotThrow(() => anthropicPayload(model, messages)); assert.deepEqual(errors, []);
  } finally { await close(server); await rm(dir, { recursive: true, force: true }); }
});

test('Gemini separates typed thoughts from answers and retains tool signatures through local history', async () => {
  let streaming = true;
  const server = await listen(async (req, res) => {
    await body(req);
    const message = { content: [{ type: 'thinking', thinking: '先检查配置。' }, { type: 'text', text: { value: '已经完成。' } }, { type: 'image', text: undefined }],
      reasoning_content: [{ type: 'text', text: '先检查配置。' }],
      tool_calls: [{ ...call, id: 'call_1', type: 'function', function: { name: 'todo_write', arguments: call.arguments }, extra_content: { google: { thought_signature: 'opaque-signature' } } }] };
    if (!streaming) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    emit(res, { choices: [{ delta: { ...message, tool_calls: message.tool_calls.map(c => ({ ...c, index: 0 })) } }] }); res.end('data: [DONE]\n\n');
  });
  const dir = await mkdtemp(join(tmpdir(), 'moonya-gemini-history-'));
  try {
    for (const stream of [true, false]) {
      streaming = stream; const model = fixture(server, 'gemini-3.8-flash'), deltas = [];
      const assistant = await callModel(model, [{ role: 'user', content: 'Hi' }], 'medium', AbortSignal.timeout(3000), d => deltas.push(d));
      assert.equal(assistant.reasoning_content, '先检查配置。'); assert.equal(assistant.content, '已经完成。');
      assert.ok(!JSON.stringify(deltas).includes('[object Object]'));
      const path = join(dir, 'history.jsonl'); await new ChatHistory(path).remember('scope', model, assistant, 'first');
      const messages = await new ChatHistory(path).replay('scope', model, [{ role: 'assistant', content: assistant.content, tool_calls: assistant.tool_calls, _moonya_message_id: 'first' }]);
      assert.equal(openaiPayload(model, messages, 'medium').messages[0].tool_calls[0].extra_content.google.thought_signature, 'opaque-signature');
      assert.ok(!JSON.stringify(openaiPayload({ ...model, name: 'other' }, messages, 'medium')).includes('opaque-signature'));
    }
  } finally { await close(server); await rm(dir, { recursive: true, force: true }); }
});

test('Responses non-streaming allows answer-only and summary-only, and does not mask failed or incomplete responses', async () => {
  let value = result([thought]), mode = 'json';
  const server = await listen(async (req, res) => {
    await body(req);
    if (mode === 'http-error') { res.writeHead(400); res.end('unsupported include_thoughts fixture-secret'); return; }
    if (mode !== 'json') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      emit(res, { type: 'response.output_item.added', output_index: 0, item: answer });
      if (mode === 'hang') return;
      if (mode === 'error') emit(res, { type: 'response.failed', response: { error: { message: 'upstream rejected fixture-secret' }, usage: { input_tokens: 12, output_tokens: 4 } } });
      res.end('data: [DONE]\n\n'); return;
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value));
  });
  try {
    const model = fixture(server), request = (options = {}) => callModel(model, [{ role: 'user', content: 'Hi' }], 'high', AbortSignal.timeout(100), async () => {}, options);
    assert.equal((await request()).reasoning_content, thought.summary[0].text);
    value = result([answer]); assert.equal((await request()).content, '已经完成。');
    value = { ...result([answer]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    assert.equal((await request()).content, '已经完成。'); assert.equal((await request({ summary: true })).content, '');
    value = { ...value, incomplete_details: { reason: 'content_filter' } }; await assert.rejects(request(), /content_filter/);
    value = { status: 'failed', error: { message: 'fixture-secret unavailable' } }; await assert.rejects(request(), e => /unavailable/.test(e.message) && !e.message.includes('fixture-secret'));
    mode = 'truncated'; await assert.rejects(request(), /流提前结束/);
    mode = 'error'; const records=[];
    await assert.rejects(request({onMetrics:record=>records.push(record)}), e => /upstream rejected/.test(e.message) && !e.message.includes('fixture-secret'));
    assert.equal(records.at(-1).status,'failed');assert.equal(records.at(-1).usage.output,4);
    mode = 'hang'; await assert.rejects(request(), e => ['TimeoutError', 'AbortError'].includes(e.name));
    mode = 'http-error'; await assert.rejects(request(), /HTTP 400/);
    await assert.rejects(callModel(fixture(server, 'gemini-3.8-flash'), [{ role: 'user', content: 'Hi' }], 'high', AbortSignal.timeout(1000)), /include_thoughts/);
  } finally { await close(server); }
});
