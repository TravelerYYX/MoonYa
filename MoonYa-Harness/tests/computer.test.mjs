import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { executeTool } from '../src/tools.mjs';
import { projectToolVisuals } from '../src/vision.mjs';
import { executeComputerCell } from '../src/computer.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
test('desktop cells require both actual skill bodies before any host call', async () => {
  const context = { session: { id: 'test' }, workspace: process.cwd(), skills: [{ name: 'computer-use-automation', body: 'ORIGINAL', resources: { 'references/moonya-runtime.md': 'COMPATIBILITY' } }] };
  const args = { plane: 'cu', code: 'import seed_computer_use as cu; cu.screenshot()', title: 'Observe' };
  assert.equal((await executeComputerCell(args, context)).error_code, 'desktop_skill_required');
  assert.equal((await executeTool('read_skill', { name: 'computer-use' }, context)).content, 'ORIGINAL');
  assert.equal((await executeComputerCell(args, context)).error_code, 'desktop_skill_required');
  await executeTool('read_skill', { name: 'computer-use-automation', path: 'references/moonya-runtime.md' }, context);
  assert.equal(context.session.desktopCompatibilityLoaded, true);
});

test('cancelling a cell aborts a host RPC paused for takeover, then releases without replay', { timeout: 8000 }, async () => {
  let entered, rpcCount = 0, releases = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const server = http.createServer(async (req, res) => {
    req.resume();
    if (req.url === '/desktop/rpc') { rpcCount++; entered(); return; }
    if (req.url === '/desktop/release') releases++;
    res.setHeader('content-type', 'application/json'); res.end('{"success":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  process.env.MOONYA_DESKTOP_PYTHON = process.env.MOONYA_TEST_PYTHON || 'python';
  const context = { signal: controller.signal, session: { id: 'cancel', desktopSkillLoaded: true, desktopCompatibilityLoaded: true }, workspace: process.cwd(), localServiceUrl: `http://127.0.0.1:${server.address().port}` };
  try {
    const cell = executeComputerCell({ plane: 'cu', title: 'Paused cell', code: 'import seed_computer_use as cu; cu.screenshot()' }, context);
    const rejected = assert.rejects(cell, /cancelled/);
    await waiting; controller.abort(new Error('cancelled')); await rejected;
    assert.equal(rpcCount, 1); assert.equal(releases, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('fresh Python cells marshal every compatibility helper and project only explicit screenshots', async () => {
  const calls = []; const released = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.session_id, 'cell-test');
    let result = { success: true };
    if (req.url === '/desktop/rpc') {
      calls.push(body);
      if (body.method === 'screenshot') result = { success: true, image: png, width: 1, height: 1, display: 'virtual' };
      if (body.method === 'list_apps') result.apps = [{ name: 'Notepad' }, { name: 'Calculator' }];
      if (body.method === 'get_clipboard') result.text = '中文';
      if (body.method === 'wait') result.wait_ms = 0;
      if (body.method === 'launch_app') result.status = 'ready';
    }
    if (req.url === '/desktop/release') released.push(body);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.MOONYA_DESKTOP_PYTHON = process.env.MOONYA_TEST_PYTHON || 'python';
  const context = { session: { id: 'cell-test', desktopSkillLoaded: true, desktopCompatibilityLoaded: true }, workspace: process.cwd(), localServiceUrl: `http://127.0.0.1:${server.address().port}` };
  try {
    const result = await executeComputerCell({ plane: 'cu', title: 'Compatibility', code: `
import seed_computer_use as cu
frame = cu.screenshot(tag="before")
assert isinstance(frame, bytes) and frame.width == 1 and frame.height == 1
apps = cu.list_apps()
assert len(apps) == 2 and apps[0].name == "Notepad"
assert cu.launch_app(apps[0].name)["status"] == "ready"
cu.click(0, 1000); cu.left_double(1000, 0); cu.triple_click(500, 500)
cu.right_single(5, 5); cu.hover(1, 2); cu.move(2, 3); cu.move_mouse(3, 4)
cu.drag(0, 0, 1000, 1000); cu.scroll(500, 500, "right"); cu.scroll(500, 500, -2)
cu.type("中文\\n"); cu.hotkey("ctrl", "s"); cu.press("enter")
cu.key_down("shift"); cu.key_up("shift"); cu.wait(0)
cu.set_clipboard("中文"); assert cu.get_clipboard() == "中文"
assert cu.copy_selection() == "中文"
cu.screenshot(tag="after")
print("verified")
` }, context);
    assert.equal(result.success, true, result.error);
    assert.match(result.output, /verified/);
    assert.equal(released.length, 1);
    assert.equal(new Set(calls.map(call => call.operation_id)).size, calls.length);
    const projection = projectToolVisuals('computer_use_tool', result, 'tool-id');
    assert.equal(projection.images.length, 2); assert.equal(projection.images[0].source.tag, 'before');
    assert.ok(!JSON.stringify(projection.result).includes(png));
    const handoff = projectToolVisuals('interaction_request_action', { action_type: 'desktopControl', observation: { screenshots: result.screenshots } }, 'handoff');
    assert.equal(handoff.images.length, 2);
    const noCalls = await executeComputerCell({ plane: 'cu', title: 'Invalid', code: 'print("must not execute")' }, context);
    assert.equal(noCalls.success, false); assert.equal(noCalls.output, '');
    const next = await executeComputerCell({ plane: 'cu', title: 'Fresh', code: 'import seed_computer_use as cu\nassert "frame" not in globals()\ncu.screenshot()' }, context);
    assert.equal(next.success, true, next.error);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
