import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStats, normalizeUsage } from '../src/conversation-stats.mjs';
import { callModel } from '../src/model-client.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(handler) { const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
const url = server => `http://127.0.0.1:${server.address().port}`;
const frame = object => 'data: ' + JSON.stringify(object) + '\n\n';
const model = base => ({ protocol: 'openai-completions', base_url: base + '/v1', name: 'test-model', id: 'test-model', max_output_tokens: 2048, api_key: 'test-secret' });
const usage = { prompt_tokens: 240, prompt_cache_hit_tokens: 160, prompt_cache_miss_tokens: 80, completion_tokens: 32 };

test('provider token buckets remain disjoint and missing cache data stays unknown', () => {
  assert.deepEqual(normalizeUsage(usage), { input: 80, cache_read: 160, cache_write: 0, output: 32, total_input: 240 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 5 } }),
    { input: 30, cache_read: 20, cache_write: 0, output: 8, total_input: 50 });
  assert.deepEqual(normalizeUsage({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 }, 'anthropic-messages'),
    { input: 10, cache_read: 20, cache_write: 5, output: 7, total_input: 35 });
  assert.equal(normalizeUsage({ prompt_tokens: 50, completion_tokens: 4 }).input, null);
  assert.equal(normalizeUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 20 }).input, null);
  assert.equal(normalizeUsage(null), null);
});

test('durable totals survive retries, bindings, compaction, restart and a torn append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-stats-'));
  try {
    const path = join(directory, 'statistics.jsonl'), store = new ConversationStats(path);
    await store.open('user:1', 'local-chat', false);
    const first = { kind: 'model', id: 'attempt-1', status: 'completed', model_id: 'a', usage: normalizeUsage(usage), llm_ms: 2200, ttft_ms: 200, decode_ms: 2000 };
    await store.record('1', 'local-chat', { ...first, status: 'running', usage: null });
    await store.record('1', 'local-chat', first);
    await store.record('1', 'local-chat', first);
    await store.record('1', 'local-chat', { ...first, status: 'running' });
    await store.bind('1', 'local-chat', ['db:14']);
    await store.record('1', 'db:14', { ...first, id: 'attempt-2', model_id: 'b', llm_ms: 3300, ttft_ms: 300, decode_ms: 3000 });
    await store.record('1', 'local-chat', { kind: 'tool', id: 'tool-a', tool_ms: 80 });
    await store.record('1', 'local-chat', { kind: 'tool', id: 'tool-b', tool_ms: 90 });
    await store.record('1', 'local-chat', { kind: 'context', id: 'context:a', model_id: 'a', seq: 8, limit_tokens: 8192, used_tokens: 1000, system_tokens: 100, tools_tokens: 100, messages_tokens: 800 });
    await store.record('1', 'local-chat', { kind: 'context', id: 'context:a', model_id: 'a', seq: 12, limit_tokens: 8192, used_tokens: 400, system_tokens: 100, tools_tokens: 100, messages_tokens: 200 });
    await store.record('1', 'child-chat', { ...first, id: 'child-model' });
    await store.record('2', 'local-chat', { ...first, id: 'other-user' });
    let stats = await store.snapshot('1', 'db:14', { model_id: 'a', limit_tokens: 8192, has_history: true });
    assert.equal(stats.token_usage.total, 544);
    assert.equal(stats.timing.llm_ms, 5500); assert.equal(stats.timing.tool_ms, 170);
    assert.equal(stats.timing.ttft_ms, 250); assert.equal(stats.timing.tps, 12.8);
    assert.equal(stats.context.used_tokens, 400); assert.equal(stats.completeness.attempts, 2);
    assert.equal(stats.completeness.token_usage, 'complete');
    assert.equal((await store.snapshot('1', 'db_14', { conversation_id: '14' })).token_usage.total, 544);
    assert.equal((await store.snapshot('1', 'local-chat', { model_id: 'other-model' })).context, null);
    await appendFile(path, '{"incomplete');
    const restarted = new ConversationStats(path); await restarted.ready;
    stats = await restarted.snapshot('1', 'local-chat'); assert.equal(stats.token_usage.total, 544);
    await restarted.record('1', 'local-chat', { ...first, id: 'attempt-3', usage: null, status: 'cancelled' });
    assert.equal((await new ConversationStats(path).snapshot('1', 'db:14')).token_usage.total, 544);
    stats = await restarted.snapshot('1', 'local-chat'); assert.equal(stats.completeness.token_usage, 'partial');
    assert.equal(stats.timing.tps, 12.8, 'missing usage must not join the TPS denominator');
    assert.doesNotMatch(await readFile(path, 'utf8'), /test-secret/);
    const legacy = await restarted.snapshot('1', 'old-chat', { has_history: true });
    assert.equal(legacy.token_usage.total, null); assert.equal(legacy.timing.tool_ms, null);
    const empty = await restarted.snapshot('1', 'new-chat');
    assert.equal(empty.token_usage.total, 0); assert.equal(empty.timing.ttft_ms, null);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'moonya-'))); await rm(directory, { recursive: true, force: true }); }
});

test('real streaming measures reasoning and tool arguments but ignores metadata-only chunks', async () => {
  const records = [];
  const server = await listen(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(frame({ choices: [{ delta: { role: 'assistant' } }] }));
    await delay(35);
    res.write(frame({ choices: [{ delta: { reasoning_content: 'Reasoning' } }] }));
    await delay(20);
    res.write(frame({ choices: [{ delta: { content: 'Answer' } }] }));
    await delay(20);
    res.end(frame({ choices: [{ finish_reason: 'stop', delta: {} }] }) + frame({ choices: [], usage }) + 'data: [DONE]\n\n');
  });
  try {
    await callModel(model(url(server)), [{ role: 'user', content: 'Hi' }], 'none', null, async () => {}, { onMetrics: event => records.push(event) });
    assert.equal(records.length, 2); assert.equal(records[0].status, 'running');
    assert.equal(records[1].status, 'completed'); assert.ok(records[1].ttft_ms >= 30);
    assert.ok(records[1].decode_ms >= 30); assert.equal(records[1].usage.output, 32);
  } finally { await close(server); }
  const toolServer = await listen(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file' } }] } }] }));
    await delay(25);
    res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] }));
    await delay(15); res.end(frame({ choices: [{ finish_reason: 'tool_calls' }], usage }) + 'data: [DONE]\n\n');
  });
  try {
    records.length = 0;
    await callModel(model(url(toolServer)), [{ role: 'user', content: 'Hi' }], 'none', null, async () => {}, { onMetrics: event => records.push(event) });
    assert.ok(records[1].ttft_ms >= 20); assert.ok(records[1].decode_ms >= 10);
  } finally { await close(toolServer); }
});

test('Anthropic usage updates retain input buckets; non-streaming has no invented TTFT', async () => {
  const events = [];
  const server = await listen(async (req, res) => {
    if (req.url.includes('nonstream')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 13, output_tokens: 4 } })); return; }
    res.setHeader('content-type', 'text/event-stream');
    res.write(frame({ type: 'message_start', message: { usage: { input_tokens: 13, cache_read_input_tokens: 30, cache_creation_input_tokens: 7, output_tokens: 0 } } }));
    await delay(20); res.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'OK' } }));
    await delay(20); res.end(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }) + frame({ type: 'message_stop' }));
  });
  try {
    const anthropic = { ...model(url(server)), protocol: 'anthropic-messages' };
    await callModel(anthropic, [{ role: 'user', content: 'Hi' }], 'none', null, async () => {}, { onMetrics: event => events.push(event) });
    assert.deepEqual(events[1].usage, { input: 13, cache_read: 30, cache_write: 7, output: 4, total_input: 50 });
    assert.ok(events[1].ttft_ms >= 15);
    events.length = 0;
    await callModel({ ...anthropic, base_url: url(server) + '/nonstream' }, [{ role: 'user', content: 'Hi' }], 'none', null, async () => {}, { onMetrics: event => events.push(event) });
    assert.equal(events[1].ttft_ms, null); assert.equal(events[1].decode_ms, null); assert.equal(events[1].usage.output, 4);
  } finally { await close(server); }
});

test('failed, cancelled and rejected usage-option attempts preserve distinct actual records', async () => {
  let requests = 0;
  const server = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); requests++;
    if (input.stream_options) { res.writeHead(400); res.end('{"error":{"message":"unknown stream_options"}}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage }));
  });
  try {
    const records = [];
    await callModel(model(url(server)), [{ role: 'user', content: 'Hi' }], 'none', null, async () => {}, { onMetrics: event => records.push(event) });
    assert.equal(requests, 2); assert.equal(records.length, 4);
    assert.notEqual(records[0].id, records[2].id); assert.equal(records[1].status, 'failed'); assert.equal(records[3].status, 'completed');
  } finally { await close(server); }
  const waiting = await listen((req, res) => { res.setHeader('content-type', 'text/event-stream'); res.write(frame({ choices: [{ delta: { role: 'assistant' } }] })); });
  try {
    const records = [];
    await assert.rejects(callModel(model(url(waiting)), [{ role: 'user', content: 'Hi' }], 'none', AbortSignal.timeout(40), async () => {}, { onMetrics: event => records.push(event) }));
    assert.equal(records[1].status, 'cancelled'); assert.equal(records[1].usage, null); assert.equal(records[1].ttft_ms, null);
    assert.ok(records[1].llm_ms > 0);
  } finally { await close(waiting); }
});

test('PHP built-in Chat captures the same actual usage and request context through the runtime journal', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-php-stats-'));
  const stats = new ConversationStats(join(directory, 'statistics.jsonl'));
  const runtime = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    await stats.open(input.user_context, input.client_chat_id, input.has_history);
    await stats.record(input.user_context, input.client_chat_id, input.record);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(await stats.snapshot(input.user_context, input.client_chat_id)));
  });
  const upstream = await listen(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream'); await delay(25);
    res.write(frame({ choices: [{ delta: { reasoning_content: 'Think' } }] })); await delay(20);
    res.end(frame({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + frame({ choices: [], usage }) + 'data: [DONE]\n\n');
  });
  try {
    const source = `<?php require '${new URL('../../MoonYa-Backend/tests/membership_fixture.php', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')}';
      require '${new URL('../../MoonYa-Backend/Services/ConversationStatistics.php', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')}';
      [$db,$config,$database]=membershipTestDatabase();
      try {
      $db->prepare("UPDATE builtin_models SET endpoint=?,api_key='fixture-key',upstream_model='test-model' WHERE id='deepseek-flash'")->execute(['${url(upstream)}/v1/chat/completions']);
      BuiltinBilling::configure($config,1,'deepseek-flash',false);
      MoonYaStatistics::configure(['agent_runtime_url'=>'${url(runtime)}'],['client_chat_id'=>'php-chat','context_limit'=>8192],1);
      $request=['model'=>'test-model','stream'=>true,'messages'=>[['role'=>'system','content'=>'Actual system prompt'],['role'=>'user','content'=>'Hello']]];
      $curl=curl_init('${url(upstream)}/v1/chat/completions');
      curl_setopt_array($curl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($request)]);
      BuiltinBilling::writeCallback($curl,function($curl,$chunk){MoonYaStatistics::chunk($curl,$chunk);return strlen($chunk);});
      MoonYaStatistics::execute($curl,$request); curl_close($curl);
      $tool=curl_init('${url(upstream)}/search');curl_setopt($tool,CURLOPT_RETURNTRANSFER,true);
      MoonYaStatistics::executeTool($tool);curl_close($tool);
      if ((new MembershipService($db))->summary(1)['balance']!=='99.959200') throw new RuntimeException('Actual usage was not charged');
      } finally { $db->exec('DROP DATABASE '.chr(96).$database.chr(96)); }`;
    const child = spawn(process.env.PHP_BIN || 'php', [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk);
    child.stdin.end(source); const code = await new Promise(resolve => child.once('exit', resolve)); assert.equal(code, 0, errors);
    assert.match(output, /statistics_record/);
    // PHP emits measurements; the authenticated desktop adapter writes the local journal.
    for (const line of output.split('\n').filter(line => line.startsWith('data: '))) {
      const event = JSON.parse(line.slice(6));
      if (event.type !== 'statistics_record') continue;
      const response = await fetch(url(runtime), { method:'POST', body:JSON.stringify({...event.data,user_context:'1'}) });
      assert.equal(response.status,200);
    }
    const snapshot = await stats.snapshot('1', 'php-chat');
    assert.equal(snapshot.token_usage.total, 272); assert.ok(snapshot.timing.ttft_ms >= 20);
    assert.ok(snapshot.context.system_tokens > 0); assert.ok(snapshot.context.messages_tokens > 0);
    assert.equal(snapshot.context.limit_tokens, 8192); assert.ok(snapshot.timing.tool_ms >= 40);
  } finally { await close(upstream); await close(runtime); assert.ok(directory.startsWith(join(tmpdir(), 'moonya-'))); await rm(directory, { recursive: true, force: true }); }
});

test('actual Runtime composition accumulates Chat and project roots, excludes children and restores after restart', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-stats-runtime-'));
  let upstreamCalls = 0, childCalls = 0, child;
  const upstream = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); upstreamCalls++;
    if(input.messages.some(message=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('child task')))childCalls++;
    const hasTool = input.messages.some(message => message.role === 'tool');
    const delegate = input.tools && !hasTool && input.messages.some(message => message.role === 'user' && message.content === 'Delegate a small task');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: delegate ? { content: '', tool_calls: [{ id: 'delegate', type: 'function',
      function: { name: 'subagent', arguments: JSON.stringify({ prompt: 'child task', description: 'Statistics child' }) } }] } : { content: 'OK' } }], usage }));
  });
  const probe = await listen(() => {}), port = probe.address().port; await close(probe);
  const base = `http://127.0.0.1:${port}`;
  const api = async (path, input) => (await fetch(base + path, input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).json();
  const start = async () => {
    child = spawn(process.execPath, ['src/server.mjs'], { cwd: new URL('..', import.meta.url), windowsHide: true,
      env: { ...process.env, MOONYA_DATA_ROOT: directory, MOONYA_HARNESS_DATA: join(directory, 'agent-runtime'), MOONYA_HARNESS_PORT: String(port) }, stdio: 'ignore' });
    for (let n = 0; n < 200; n++) { try { if ((await api('/health')).status === 'ok') return; } catch {} await delay(20); }
    throw new Error('Runtime did not start');
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; };
  try {
    await start();
    await api('/v1/model-config', { action: 'save', provider: { id: 'test', name: 'Test', provider: 'custom', base_url: url(upstream) + '/v1', protocol: 'openai-completions', api_key: 'test-secret',
      models: [{ id: 'test-model', context_window: 8192, context_window_source: 'manual', max_output_tokens: 2048 }] } });
    const ref = { provider_id: 'test', model_id: 'test-model' };
    const chat = { user_context: '1', client_chat_id: 'local-chat', conversation_id: '8', client_message_id: 'message-1', model_ref: ref,
      messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }] };
    const sendChat = async input => (await fetch(base + '/v1/llm/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).text();
    assert.match(await sendChat(chat), /session_statistics/);
    await sendChat({ ...chat, resume: true }); assert.equal(upstreamCalls, 1);
    const root = await api('/v1/sessions', { user_context: 'user:1', workspace: directory });
    await api(`/v1/sessions/${root.id}/messages`, { user_context: 'user:1', client_chat_id: 'local-chat', content: 'Delegate a small task', model_ref: ref });
    let history;
    for (let n = 0; n < 400; n++) { history = await api(`/v1/sessions/${root.id}`); if (['completed', 'error'].includes(history.status)) break; await delay(20); }
    assert.equal(history.status, 'completed', JSON.stringify(history.events.at(-1)));
    const statsUrl = '/v1/conversation-stats?user_context=1&client_chat_id=local-chat&model_id=test-model';
    const snapshot = await api(statsUrl);
    // Calls whose draft answer was held while children settled still consumed
    // real tokens, even though no assistant.message was published for that draft.
    const primaryCalls = upstreamCalls-childCalls;
    assert.equal(snapshot.completeness.attempts, primaryCalls);
    assert.ok(upstreamCalls > primaryCalls, 'the child was called but is accounted separately');
    assert.equal(snapshot.token_usage.total, primaryCalls * 272);
    assert.ok(snapshot.timing.tool_ms > 0);
    assert.equal((await api('/v1/conversation-stats?user_context=2&client_chat_id=local-chat&has_history=1')).token_usage.total, null);
    assert.equal((await api('/v1/conversation-stats?user_context=1&client_chat_id=db%3A8')).token_usage.total, snapshot.token_usage.total);
    await stop(); await start();
    assert.equal((await api(statsUrl)).token_usage.total, snapshot.token_usage.total);
    assert.doesNotMatch(await readFile(join(directory, 'agent-runtime', 'statistics', 'conversations.jsonl'), 'utf8'), /test-secret/);
  } finally { await stop(); await close(upstream); assert.ok(directory.startsWith(join(tmpdir(), 'moonya-'))); await rm(directory, { recursive: true, force: true }); }
});
