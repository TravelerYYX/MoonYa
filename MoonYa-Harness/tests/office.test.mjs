import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficeScheduler, projectOffice } from '../src/office.mjs';
import { assertOfficeToolSchemas } from './helpers/office-tool-schemas.mjs';

test('per-user permits queue, release while waiting, and resize without killing admitted work', async () => {
  const scheduler = new OfficeScheduler(); scheduler.setLimit('user:1', 1);
  const signal = new AbortController().signal;
  await scheduler.acquire({ id: 'a', parentSessionId: 'root', userContext: 'user:1' }, signal);
  let admitted = false;
  const pending = scheduler.acquire({ id: 'b', parentSessionId: 'a', userContext: 'user:1' }, signal).then(() => { admitted = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(admitted, false);
  scheduler.release('a'); await pending; assert.equal(admitted, true);
  scheduler.setLimit('user:1', 3); assert.equal(scheduler.active.size, 1);
  assert.throws(() => scheduler.setLimit('user:1', 0));
});

test('office catalog labels and lifecycle remain idempotent and clear per conversation', () => {
  assert.deepEqual(projectOffice({ id: 'r', events: [{ seq: 1, event: 'subagent/start', payload: { id: 'unpublished' } }, { seq: 2, event: 'subagent/end', payload: { id: 'unpublished', stopReason: 'error' } }] }), [], 'unpublished creation must not leave a ghost employee');
  const root = { id: 'r', events: [
    { seq: 1, event: 'subagent/start', payload: { id: 'a', runId: 'run' } },
    { seq: 2, event: 'subagent/catalog', origin_session_id: 'r', payload: { childId: 'a', label: 'Research Mars' } },
    { seq: 3, event: 'subagent/end', payload: { id: 'a', stopReason: 'completed' } },
    { seq: 3, event: 'subagent/end', payload: { id: 'a', stopReason: 'error' } },
  ] };
  assert.equal(projectOffice(root).length, 1); assert.equal(projectOffice(root)[0].status, 'completed');
  assert.equal(projectOffice(root)[0].label, 'Research Mars');
  root.events.push({ seq: 4, event: 'office/cleared' }); assert.deepEqual(projectOffice(root), []);
});

test('original DeepSeek composition dispatches twelve real children, limits execution and delivers results', { timeout: 30000 }, async () => {
  let active = 0, maximum = 0, rootRounds = 0, childCalls = 0;
  const schemaErrors = [];
  const model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    try { assertOfficeToolSchemas(input.tools); }
    catch (error) { schemaErrors.push(error); res.statusCode = 400; res.end(`Invalid tool schema: ${error.message}`); return; }
    const child = input.messages.some(message => String(message.content).startsWith('child-task-'));
    let message;
    if (child) {
      childCalls++; active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 100)); active--;
      message = { role: 'assistant', content: 'child result' };
    } else if (++rootRounds === 1) {
      message = { role: 'assistant', content: '', tool_calls: Array.from({ length: 12 }, (_, i) => ({ id: `spawn-${i}`, type: 'function',
        function: { name: 'subagent', arguments: JSON.stringify({ description: `Task ${i}`, prompt: `child-task-${i}`, avatar: 'search' }) } })) };
    } else message = { role: 'assistant', content: 'all children summarized' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(join(tmpdir(), 'moonya-office-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const runtime = spawn(process.env.MOONYA_HARNESS_EXECUTABLE || process.execPath, process.env.MOONYA_HARNESS_EXECUTABLE ? [] : ['src/server.mjs'], { cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, MOONYA_HARNESS_PORT: String(port), MOONYA_HARNESS_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; runtime.stderr.on('data', chunk => { diagnostics += chunk; });
  const api = async (path, body) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return response.json(); };
  try {
    for (let i = 0; ; i++) { try { await api('/health'); break; } catch { if (i > 150) throw new Error(diagnostics); await new Promise(resolve => setTimeout(resolve, 20)); } }
    const session = await api('/v1/sessions', { workspace: data, user_context: 'user:office' });
    await api(`/v1/sessions/${session.id}/messages`, { content: 'delegate twelve', model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'fixture', name: 'deepseek-flash' } });
    let snapshot, history;
    for (let i = 0; i < 500; i++) {
      history = await api(`/v1/sessions/${session.id}`); snapshot = await api(`/v1/sessions/${session.id}/office`);
      if (['completed', 'error'].includes(history.status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(history.status, 'completed', JSON.stringify(history.events.slice(-3)) + diagnostics);
    assert.equal(snapshot.employees.length, 12, JSON.stringify(history.events.filter(event => event.event.startsWith('tool.'))));
    assert.ok(snapshot.employees.every(row => row.status === 'completed' && row.avatar === 'search'), JSON.stringify(snapshot));
    assert.equal(childCalls, 12); assert.equal(maximum, 8);
    assert.deepEqual(schemaErrors, [], 'every parent and child model request must have valid delegation schemas');
    assert.ok(history.events.some(event => event.event === 'user.message' && String(event.payload.content).includes('Background subagent')));
    assert.equal(history.events.findLast(event => event.event === 'turn.completed').payload.content, 'all children summarized');
  } finally {
    if (runtime.exitCode === null && runtime.signalCode === null) { runtime.kill(); await new Promise(resolve => runtime.once('exit', resolve)); }
    await new Promise(resolve => model.close(resolve)); await rm(data, { recursive: true, force: true });
  }
});
