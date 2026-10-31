// Contract tests for the browser tool moved from the delegated Browser Agent
// into the Agent Runtime.  The runtime drives the same loopback protocol, so
// these assertions pin the parts that must not drift from the backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { CODING_TOOLS, executeTool, resolvePathArguments } from '../src/tools.mjs';
import { BROWSER_ACTIONS, browserEffectAndRisk, describeChallenge, executeBrowser } from '../src/browser.mjs';
import { assembleSystemPrompt } from '../src/prompt.mjs';

process.env.MOONYA_BROWSER_TIMEOUT_MS = '5000';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..', '..', 'MoonYa-Backend');
const desktop = join(here, '..', '..', 'MoonYa-Win', 'MoonYa-Solution', 'MoonYa');

test('browser tool is registered with the full action set', () => {
  const tool = CODING_TOOLS.find(entry => entry.function.name === 'browser_automation_control');
  assert.ok(tool, 'browser_automation_control must be exposed to the model');
  assert.deepEqual(tool.function.parameters.properties.action.enum, [...BROWSER_ACTIONS]);
  assert.deepEqual(tool.function.parameters.required, ['action']);
  assert.deepEqual(tool.function.parameters.properties.browser.enum, ['builtin', 'chrome', 'edge']);
});

test('cancelling an in-flight action sends its private operation id and browser to the desktop', async () => {
  let requestReceived;
  const admitted = new Promise(resolve => requestReceived = resolve);
  let cancelReceived;
  const cancelled = new Promise(resolve => cancelReceived = resolve);
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/browser/cancel') { cancelReceived(input); res.end('{"success":true}'); }
    else requestReceived(input);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.MOONYA_BROWSER_SERVICE_URL;
  process.env.MOONYA_BROWSER_SERVICE_URL = 'http://127.0.0.1:' + server.address().port;
  try {
    const controller = new AbortController();
    const action = executeBrowser({ action: 'navigate', browser: 'edge', url: 'https://example.test' }, { signal: controller.signal, userContext: 'user:cancel' });
    const request = await admitted;
    controller.abort();
    await assert.rejects(action, error => error.name === 'AbortError');
    const cancellation = await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('cancellation was not forwarded')), 1000))]);
    assert.equal(cancellation.operation_id, request.operation_id);
    assert.equal(cancellation.browser, 'edge');
    assert.equal(cancellation.user_context, 'user:cancel');
  } finally {
    if (previous === undefined) delete process.env.MOONYA_BROWSER_SERVICE_URL; else process.env.MOONYA_BROWSER_SERVICE_URL = previous;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test('action list stays identical to BrowserAutomationGateway::ACTIONS', () => {
  const gateway = readFileSync(join(backend, 'Services', 'BrowserAutomationGateway.php'), 'utf8');
  const block = gateway.slice(gateway.indexOf('public const ACTIONS'), gateway.indexOf('];', gateway.indexOf('public const ACTIONS')));
  const phpActions = [...block.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.deepEqual([...BROWSER_ACTIONS].sort(), phpActions.sort());
});

test('desktop supplies a configured client deadline beyond the operation deadline', () => {
  const launcher = JSON.parse(readFileSync(join(desktop, 'launcher_config.json'), 'utf8'));
  const config = launcher.browser_automation;
  assert.ok(config.operation_timeout_ms > 0);
  assert.ok(config.frame_collection_timeout_ms > 0);
  assert.ok(config.frame_collection_timeout_ms <= config.operation_timeout_ms);
  assert.ok(config.relay_timeout_ms > config.operation_timeout_ms);

  const runtime = readFileSync(join(desktop, 'Services', 'AgentRuntimeService.cs'), 'utf8');
  assert.match(runtime, /RequiredPositiveInt\(browserConfig, "relay_timeout_ms"\)/);
  assert.match(runtime, /MOONYA_BROWSER_TIMEOUT_MS/);

  const app = readFileSync(join(desktop, 'App.xaml.cs'), 'utf8');
  assert.match(app, /"\.\.", "\.\.", "\.\.", "\.\.", "launcher_config\.json"/);
  assert.match(app, /File\.GetLastWriteTimeUtc\(development\) > File\.GetLastWriteTimeUtc\(adjacent\)/);
});

test('browser client has no independent hardcoded timeout fallback', async () => {
  const previous = process.env.MOONYA_BROWSER_TIMEOUT_MS;
  delete process.env.MOONYA_BROWSER_TIMEOUT_MS;
  try {
    const result = await executeBrowser({ action: 'status' });
    assert.equal(result.success, false);
    assert.equal(result.error_code, 'invalid_configuration');
  } finally {
    process.env.MOONYA_BROWSER_TIMEOUT_MS = previous;
  }
});

test('risk classification mirrors RiskPolicy::effectivePolicy', () => {
  assert.deepEqual(browserEffectAndRisk('screenshot'), { effect: 'read', riskLevel: 'low' });
  assert.deepEqual(browserEffectAndRisk('inspect'), { effect: 'read', riskLevel: 'low' });
  assert.deepEqual(browserEffectAndRisk('navigate'), { effect: 'write', riskLevel: 'medium' });
  assert.deepEqual(browserEffectAndRisk('fill'), { effect: 'write', riskLevel: 'medium' });
  assert.deepEqual(browserEffectAndRisk('submit_sensitive'), { effect: 'write', riskLevel: 'high' });
  assert.deepEqual(browserEffectAndRisk('purchase'), { effect: 'write', riskLevel: 'high' });
});

test('unknown actions fail before any network call', async () => {
  const result = await executeTool('browser_automation_control', { action: 'teleport' }, {
    session: {}, workspace: 'D:\\Work', localServiceUrl: 'http://127.0.0.1:1', lspServiceUrl: 'http://127.0.0.1:1'
  });
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'unknown_action');
});

test('an unreachable browser service surfaces one actionable error', async () => {
  const previous = process.env.MOONYA_BROWSER_SERVICE_URL;
  // Port 1 is reserved and never listening, so this stays deterministic even
  // when the real desktop service happens to be running on 58905.
  process.env.MOONYA_BROWSER_SERVICE_URL = 'http://127.0.0.1:1';
  try {
    const result = await executeTool('browser_automation_control', { action: 'status' }, {
      session: {}, workspace: 'D:\\Work', localServiceUrl: 'http://127.0.0.1:1', lspServiceUrl: 'http://127.0.0.1:1',
      userContext: 'user:7'
    });
    assert.equal(result.success, false);
    assert.equal(result.error_code, 'browser_service_unreachable');
    assert.match(result.error, /MoonYa 桌面端/);
  } finally {
    if (previous === undefined) delete process.env.MOONYA_BROWSER_SERVICE_URL;
    else process.env.MOONYA_BROWSER_SERVICE_URL = previous;
  }
});

test('browser arguments are never validated as file paths', async () => {
  // A URL must survive path resolution untouched, and no boundary error may fire.
  const args = resolvePathArguments('browser_automation_control', { action: 'navigate', url: 'https://example.com/a/b' }, 'D:\\Work');
  assert.equal(args.url, 'https://example.com/a/b');
  await assert.rejects(
    () => executeTool('browser_automation_control', { action: 'screenshot', save_screenshot_to: 'E:\\Other\\shot.png' }, {
      session: {}, workspace: 'D:\\Work', localServiceUrl: 'http://127.0.0.1:1', lspServiceUrl: 'http://127.0.0.1:1'
    }),
    /outside the selected workspace/
  );
  assert.equal(
    resolvePathArguments('browser_automation_control', { action: 'screenshot', save_screenshot_to: 'shots/a.png' }, 'D:\\Work').save_screenshot_to,
    'D:\\Work\\shots\\a.png'
  );
});

test('the harness persona must not carry the delegation protocol', () => {
  const bridge = readFileSync(join(backend, 'harness_api.php'), 'utf8');
  const body = bridge.slice(bridge.indexOf('function loadRuntimePersona'), bridge.indexOf('function emitRuntimeEvent'));
  assert.ok(!body.includes("'agent_moonya'"), 'agent_moonya would forbid direct execution in the runtime');
  assert.ok(!body.includes("['browser_automation']"), 'browser instructions must come only from SKILL.md');
  assert.ok(bridge.includes("'user_context' => $userContext"), 'browser site trust needs the owner context');
});

test('browser guidance is disclosed through the skill catalog', () => {
  const prompt = assembleSystemPrompt({ workspace: 'D:\\Work', skills: [{
    name: 'browser-use-automation', description: 'Operate a browser.', body: 'private body'
  }], selectedSkills: ['browser-use-automation'] });
  assert.match(prompt, /browser-use-automation: Operate a browser/);
  assert.match(prompt, /Read each selected skill/);
  assert.ok(!prompt.includes('private body'));
});

test('approval challenges are described in user-facing Chinese', () => {
  assert.match(describeChallenge({ approval_kind: 'site', domain: 'example.com' }), /首次访问该站点/);
  assert.match(describeChallenge({ approval_kind: 'tls', domain: 'example.com' }), /TLS/);
  assert.match(describeChallenge({ approval_kind: 'sensitive', domain: 'shop.test' }), /敏感动作/);
});
