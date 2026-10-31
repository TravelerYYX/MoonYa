// End-to-end proof that browser automation is reachable from the Agent Runtime:
// a real runtime process, driven over its HTTP API, must actually invoke
// browser_automation_control against the loopback desktop service.
//
// The model is stubbed so the test is deterministic and needs no credentials.
// The test skips itself when the desktop browser service is not running, so it
// stays honest in environments without MoonYa.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeEntry = join(here, '..', 'src', 'server.mjs');
let BROWSER_SERVICE = process.env.MOONYA_BROWSER_SERVICE_URL || 'http://127.0.0.1:58905';
const LIVE_URL = process.env.MOONYA_BROWSER_SMOKE_URL || '';

async function connectedHost() {
  if (!process.env.MOONYA_BROWSER_SMOKE_CDP_PORT) return null;
  const host = spawn('dotnet', [join(here, '../../MoonYa-Win/MoonYa-Solution/MoonYa.BrowserSmoke/bin/Debug/net8.0-windows10.0.19041.0/MoonYa.BrowserSmoke.dll'),
    '--serve-connected', '--connect', process.env.MOONYA_BROWSER_SMOKE_CDP_PORT, '--target-url', process.env.MOONYA_BROWSER_SMOKE_TARGET || LIVE_URL],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; host.stderr.on('data', data => stderr += data);
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connected host startup timed out: ' + stderr)), 10000);
      const lines = createInterface({ input: host.stdout });
      lines.on('line', line => { if (line.startsWith('{')) { clearTimeout(timer); resolve(JSON.parse(line)); } });
      host.once('exit', code => { clearTimeout(timer); reject(new Error('connected host exited ' + code + ': ' + stderr)); });
    });
    BROWSER_SERVICE = ready.browser_service_url;
    return { ...ready, stop: () => new Promise(resolve => { host.once('exit', resolve); host.stdin.end('\n'); }) };
  } catch (error) { host.kill(); throw error; }
}

async function serviceIsUp() {
  try {
    const response = await fetch(`${BROWSER_SERVICE}/browser/manifest`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Stub model: first step calls the browser tool, second step answers. */
function startStubModel() {
  const seen = { toolCount: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const toolNames = (body.tools || []).map(tool => tool.function?.name);
      seen.toolCount = toolNames.length;
      seen.lastToolNames = toolNames;
      const first = (body.messages || []).filter(message => message.role === 'tool').length === 0;
      const payload = first
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'browser_automation_control', arguments: JSON.stringify(LIVE_URL ? { action: 'navigate', url: LIVE_URL } : { action: 'status' }) } }] }
        : { role: 'assistant', content: '浏览器服务已就绪。' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: payload }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('the runtime invokes browser_automation_control end to end', async t => {
  const native = await connectedHost();
  if (!(await serviceIsUp())) {
    await native?.stop();
    t.skip(`desktop browser service not reachable at ${BROWSER_SERVICE}`);
    return;
  }
  const dataRoot = await mkdtemp(join(tmpdir(), 'moonya-harness-ba-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const runtimePort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const stub = await startStubModel();
  const runtime = spawn(process.execPath, [runtimeEntry], {
    env: {
      ...process.env,
      MOONYA_HARNESS_PORT: String(runtimePort),
      MOONYA_HARNESS_DATA: dataRoot,
      MOONYA_BROWSER_SERVICE_URL: BROWSER_SERVICE,
      MOONYA_BROWSER_TIMEOUT_MS: LIVE_URL ? '55000' : '5000',
    },
    stdio: 'ignore',
  });

  try {
    const base = `http://127.0.0.1:${runtimePort}`;
    await waitFor(async () => (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok);

    const created = await (await fetch(`${base}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: '', user_context: 'user:test', approval_mode: LIVE_URL ? 'full_access' : 'confirm_writes' }),
    })).json();
    assert.ok(created.id, 'session should be created without a workspace');

    const accepted = await (await fetch(`${base}/v1/sessions/${created.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '展示下浏览器操作能力',
        model: { base_url: `http://127.0.0.1:${stub.port}`, api_key: 'stub', name: 'deepseek-flash' },
      }),
    })).json();
    assert.equal(accepted.accepted, true);

    const events = await waitForEvents(base, created.id, event =>
      event.event === 'turn.completed' || event.event === 'session.error');

    assert.ok(stub.seen.lastToolNames?.includes('browser_automation_control'),
      'the runtime must offer the browser tool to the model');

    const completed = events.find(event => event.event === 'tool.completed' && event.payload?.name === 'browser_automation_control');
    assert.ok(completed, `browser tool did not complete; events: ${events.map(event => event.event).join(', ')}; failure: ${String(JSON.stringify(events.find(event => event.event === 'tool.failed')?.payload?.result) || '').slice(0, 400)}`);
    assert.notEqual(completed.payload.result.success, false, `browser call failed: ${JSON.stringify(completed.payload.result).slice(0, 300)}`);
    assert.ok(completed.payload.result.browser, 'the result must carry real browser state');
    if (LIVE_URL) {
      assert.equal(completed.payload.result.browser.mode, 'builtin');
      if (native) assert.equal(completed.payload.result.browser.session_id, native.cold_session_id);
      assert.equal(new URL(completed.payload.result.page_url).hostname, new URL(LIVE_URL).hostname);
      assert.ok(completed.payload.result.page_title.includes('小红书'));
      t.diagnostic('No project: cold session authorized and opened ' + completed.payload.result.page_url);
    }
    assert.ok(events.some(event => event.event === 'turn.completed'), 'the turn must finish');
  } finally {
    runtime.kill();
    stub.server.close();
    await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    await native?.stop();
  }
});

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* keep polling */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('timed out waiting for the runtime to become ready');
}

async function waitForEvents(base, sessionId, done, timeoutMs = LIVE_URL ? 60000 : 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await (await fetch(`${base}/v1/sessions/${sessionId}`)).json();
    if ((payload.events || []).some(done)) return payload.events;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const payload = await (await fetch(`${base}/v1/sessions/${sessionId}`)).json();
  return payload.events || [];
}
