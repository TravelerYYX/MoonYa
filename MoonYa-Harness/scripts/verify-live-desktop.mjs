// Exercise the running client's authenticated Python -> native host path.
// A deterministic model fixture drives the tool protocol; final screenshots
// require visual inspection. This does not claim a real model completed the task.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { validateToolExchanges } from '../src/conversation.mjs';

const runtimeUrl = process.env.MOONYA_VERIFY_RUNTIME || 'http://127.0.0.1:58907';
const output = resolve(process.argv[2] || '../artifacts/cu-runtime-fix');
const body = await readFile(new URL('../../MoonYa-Backend/skills/computer-use-automation/SKILL.md', import.meta.url), 'utf8');
const compatibility = await readFile(new URL('../../MoonYa-Backend/skills/computer-use-automation/references/moonya-runtime.md', import.meta.url), 'utf8');
const request = async (path, payload) => {
  const response = await fetch(runtimeUrl + path, payload ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
};
let round = 0;
let callSequence = 0;
let protocolOnly = false;
let previewPage;
let previewBrowser;
let windowVerification;
let fixtureError;
const inspectWindow = (image) => JSON.parse(execFileSync('dotnet', [resolve(process.env.MOONYA_VERIFY_SMOKE || '../artifacts/physical-desktop-build/MoonYa.DesktopSmoke.dll'), '--live-window', ...(image ? [resolve(output, image)] : [])], { encoding: 'utf8' }));
if (process.argv.includes('--window')) {
  const require = createRequire(new URL('../../MoonYa-Backend/tests/package.json', import.meta.url));
  const { chromium } = require('playwright-core');
  previewBrowser = await chromium.connectOverCDP('http://127.0.0.1:58908');
  previewPage = previewBrowser.contexts().flatMap(context => context.pages()).find(page => new URL(page.url()).hostname === 'localhost');
  if (!previewPage) throw new Error('The trusted MoonYa page is not open');
}
const launchCode = `import seed_computer_use as cu
apps = cu.list_apps()
matches = [app for app in apps if app.name.casefold() in ("calculator", "计算器")]
print([app.name for app in matches])
if len(matches) != 1: raise RuntimeError("Expected exactly one Calculator application")
launch = cu.launch_app(matches[0].name)
print(launch)
import ctypes
from ctypes import wintypes
user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
hwnd = user32.GetForegroundWindow()
pid = wintypes.DWORD()
user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
title = ctypes.create_unicode_buffer(512)
kind = ctypes.create_unicode_buffer(256)
user32.GetWindowTextW(hwnd, title, 512)
user32.GetClassNameW(hwnd, kind, 256)
print({"foreground": hwnd, "pid": pid.value, "title": title.value, "class": kind.value})
cu.wait(1)
cu.screenshot(tag="calculator-ready")
if launch.get("status") != "ready": raise RuntimeError("Calculator launch is unverified; do not repeat or input keys")`;
const calculateCode = `import seed_computer_use as cu
import ctypes
from ctypes import wintypes
user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
def assert_calculator():
    hwnd = user32.GetForegroundWindow()
    title = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, title, 512)
    if title.value not in ("计算器", "Calculator"):
        raise RuntimeError("Foreground changed away from Calculator; no input will be sent")
assert_calculator()
cu.screenshot(tag="calculator-before-input")
assert_calculator()
cu.press("escape")
cu.screenshot(tag="calculator-cleared")
assert_calculator()
cu.type("781+12-122")
assert_calculator()
cu.press("enter")
cu.wait(1)
cu.screenshot(tag="calculator-result")`;
const model = http.createServer(async (req, res) => {
  try {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  validateToolExchanges(input.messages);
  const makeCall = (name, args) => ({ id: `acceptance-${++callSequence}-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const failed = input.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(r => r.success === false);
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  round++;
  if (protocolOnly) message.content = 'Complete historical tool exchanges accepted; no desktop operations executed.';
  else if (failed) message.content = `Live desktop blocked: ${failed.error || failed.error_code}`;
  else if (round === 1) message.tool_calls = [makeCall('read_skill', { name: 'computer-use-automation' }),
    makeCall('read_skill', { name: 'computer-use-automation', path: 'references/moonya-runtime.md' })];
  else if (round === 2) message.tool_calls = [makeCall('computer_use_tool', { plane: 'cu', code: launchCode, title: '打开计算器并观察实体桌面' })];
  else if (round === 3) {
    message.tool_calls = [makeCall('computer_use_tool', { plane: 'cu', code: calculateCode, title: '计算 781+12-122 并观察结果' })];
  } else {
    if (previewPage) {
      await previewPage.evaluate(async id => {
        const parent = document.createElement('div'); parent.id = 'moonya-desktop-acceptance';
        parent.style.cssText = 'position:fixed;right:24px;top:100px;z-index:2147483647';
        document.body.append(parent);
        await window.moonyaDesktopPreview.show({ session_id: id }, parent);
      }, session.id);
      await previewPage.locator('.moonya-desktop-preview button').last().click();
      await new Promise(resolve => setTimeout(resolve, 1200));
      execFileSync('dotnet', [resolve(process.env.MOONYA_VERIFY_SMOKE || '../artifacts/physical-desktop-build/MoonYa.DesktopSmoke.dll'), '--activate-viewer']);
      const after = inspectWindow('live-window-result.png');
      if (!after.normal) throw new Error('Physical preview did not open as a normal window');
      windowVerification = { after };
    }
    message.content = 'Protocol fixture completed; inspect calculator-result.png to verify 671.';
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message }] }));
  } catch (error) {
    fixtureError = error.message;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `Acceptance fixture failed: ${fixtureError}` } }] }));
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
await mkdir(output, { recursive: true });
let session;
try {
  const health = await request('/health');
  if (health.runtime_capability_version !== 2) throw new Error('Running client has a stale Harness');
  session = await request('/v1/sessions', { workspace: output, user_context: 'computer-use-acceptance-fixture' });
  const payload = { content: '打开计算器计算781+12-122',
    skills: [{ name: 'computer-use-automation', description: 'Operate desktop apps on the MoonYa physical primary desktop', body, resources: { 'references/moonya-runtime.md': compatibility } }],
    selected_skills: ['computer-use-automation'], model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'local-fixture', name: 'deepseek-flash' } };
  await request(`/v1/sessions/${session.id}/messages`, payload);
  let snapshot;
  const deadline = Date.now() + 90000;
  do {
    await new Promise(resolve => setTimeout(resolve, 200));
    snapshot = await request(`/v1/sessions/${session.id}`);
  } while (!['completed', 'error', 'cancelled'].includes(snapshot.status) && Date.now() < deadline);
  const results = snapshot.events.filter(e => ['tool.completed', 'tool.failed'].includes(e.event) && e.payload.name === 'computer_use_tool');
  for (const e of results) for (const frame of e.payload.result.screenshots || [])
    await writeFile(resolve(output, frame.tag + '.png'), Buffer.from(frame.image, 'base64'));
  const failure = results.find(e => e.payload.result.success === false);
  const report = { health, session_id: session.id, status: snapshot.status,
    desktop_cells: results.map(e => ({ success: e.payload.result.success, error_code: e.payload.result.error_code,
      error: e.payload.result.error, output: e.payload.result.output, screenshot_tags: e.payload.result.screenshots?.map(f => f.tag) })),
    tool_failures: snapshot.events.filter(e => e.event === 'tool.failed').map(e => ({ name: e.payload.name,
      error_code: e.payload.result.error_code, error: e.payload.result.error })),
    session_error: snapshot.events.findLast(e => e.event === 'session.error')?.payload.message,
    visual_verification: failure || results.length !== 2 ? 'blocked' : 'pending' };
  if (windowVerification) report.live_window = windowVerification;
  if (fixtureError) { report.fixture_error = fixtureError; report.visual_verification = 'blocked'; }
  if (process.argv.includes('--restart')) {
    protocolOnly = true;
    const continueHistory = async () => {
      await request(`/v1/sessions/${session.id}/messages`, { ...payload,
        content: 'Protocol verification only: accept the complete prior history; do not operate the desktop.' });
      let state;
      const deadline = Date.now() + 10000;
      do {
        await new Promise(resolve => setTimeout(resolve, 100));
        state = await request(`/v1/sessions/${session.id}`);
      } while (state.status === 'running' && Date.now() < deadline);
      if (state.status !== 'completed') throw new Error('History continuation failed');
      return true;
    };
    report.continuation_before_restart = await continueHistory();
    // Use only when the owning client is running and all other tasks are idle.
    const shutdown = await fetch(runtimeUrl + '/v1/runtime/shutdown', { method: 'POST', headers: { 'x-moonya-runtime': 'shutdown' } });
    if (!shutdown.ok) throw new Error('Runtime did not accept the restart request');
    const { pid } = await shutdown.json();
    report.restarted_runtime_pid = pid;
    await new Promise(resolve => setTimeout(resolve, 3500));
    const deadline = Date.now() + 15000;
    let restarted = false;
    do {
      try { restarted = (await request('/health')).runtime_capability_version === 2; } catch { }
      if (!restarted) await new Promise(resolve => setTimeout(resolve, 200));
    } while (!restarted && Date.now() < deadline);
    if (!restarted) throw new Error('Owning client did not restart its runtime');
    report.continuation_after_restart = await continueHistory();
  }
  await writeFile(resolve(output, 'live-desktop-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (snapshot.status !== 'completed' || failure || results.length !== 2 || fixtureError) process.exitCode = 1;
} finally {
  if (session) await request(`/v1/sessions/${session.id}/cancel`, {}).catch(() => {});
  if (previewPage) await previewPage.evaluate(id => { window.moonyaDesktopPreview?.disconnect(id); document.querySelector('#moonya-desktop-acceptance')?.remove(); }, session?.id).catch(() => {});
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  if (previewBrowser) await previewBrowser.close();
}
