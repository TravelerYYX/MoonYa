import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function listen(handler) { const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function until(operation, predicate) {
  const end = Date.now() + 10000; let value;
  while (Date.now() < end) { value = await operation(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('timeout: ' + JSON.stringify(value));
}
test('real runtime aggregates parent/child/command changes before completion, authenticates review, migrates and restores after restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-workspace-flow-'));
  const errors = [], rounds = new Map(); let runtime, diagnostics = '';
  const tools = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks));
    let result = { success: true };
    if (args.action === 'validate_command') result = { success: true, valid: true, effect: 'write' };
    else if (args.action === 'create_file') { await mkdir(dirname(args.path), { recursive: true }); await writeFile(args.path, args.content); }
    else if (args.action === 'execute_command') { await writeFile(join(args.cwd, 'command.txt'), 'command write\n'); result = { success: true, status: 'completed' }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  const model = await listen(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const args = JSON.parse(Buffer.concat(chunks));
      const task = args.messages.filter(message => message.role === 'user' && String(message.content).startsWith('spec:workspace:')).at(-1)?.content?.split('\n')[0];
      const round = (rounds.get(task) || 0) + 1; rounds.set(task, round);
      let calls;
      if (task === 'spec:workspace:parent' && round === 1) calls = [call('parent-create', 'create_file', { path: 'parent.txt', content: 'parent write\n' }), call('dispatch', 'subagent', { prompt: 'spec:workspace:child', description: 'child writes one file' })];
      if (task === 'spec:workspace:parent' && round === 2) calls = [call('command', 'execute_command', { command: 'fixture write', blocking: true })];
      if (task === 'spec:workspace:child' && round === 1) calls = [call('child-create', 'create_file', { path: 'child.txt', content: 'child write\n' })];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: calls ? '' : 'all files written', ...(calls ? { tool_calls: calls } : {}) } }] }));
    } catch (error) { errors.push(error); res.statusCode = 500; res.end(error.message); }
  });
  const portProbe = await listen(); const port = portProbe.address().port; await close(portProbe);
  const base = 'http://127.0.0.1:' + port;
  const api = async (path, data, headers) => {
    const response = await fetch(base + path, { ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }), headers: { 'Content-Type': 'application/json', ...headers } });
    return { status: response.status, ...await response.json() };
  };
  const start = async () => {
    runtime = spawn(process.env.MOONYA_TEST_RUNTIME_EXECUTABLE || process.execPath,
      process.env.MOONYA_TEST_RUNTIME_EXECUTABLE ? [] : ['src/server.mjs'], { cwd: new URL('..', import.meta.url), windowsHide: true,
      env: { ...process.env, MOONYA_HARNESS_PORT: String(port), MOONYA_HARNESS_DATA: join(directory, 'runtime'), MOONYA_DATA_ROOT: join(directory, 'app'),
        MOONYA_LOCAL_SERVICE_URL: 'http://127.0.0.1:' + tools.address().port, MOONYA_FRONTEND_SECRET: 'flow-secret' }, stdio: ['ignore', 'ignore', 'pipe'] });
    runtime.stderr.on('data', chunk => { diagnostics += chunk; });
    await until(async () => { try { return await api('/health'); } catch { if (runtime.exitCode !== null) throw new Error(diagnostics); return null; } }, value => value?.status === 'ok');
  };
  const stop = async () => { if (runtime && runtime.exitCode === null && runtime.signalCode === null) { const done = new Promise(resolve => runtime.once('exit', resolve)); runtime.kill(); await done; } };
  t.after(async () => { await stop(); await close(model); await close(tools); await rm(directory, { recursive: true, force: true }); });
  await start();
  const legacyDirectory = join(directory, 'legacy-user-home'); await mkdir(legacyDirectory); await writeFile(join(legacyDirectory, 'retain.txt'), 'legacy bytes');
  const legacy = await api('/v1/sessions', { workspace: legacyDirectory, workspace_identity: '__default__', user_context: 'user:1', client_chat_id: 'legacy-chat', approval_mode: 'full_access' });
  await api(`/v1/sessions/${legacy.id}/messages`, { content: 'spec:workspace:legacy', user_context: 'user:1', client_chat_id: 'legacy-chat',
    model: { base_url: 'http://127.0.0.1:' + model.address().port, api_key: 'fixture', name: 'deepseek-flash' } });
  const legacyDone = await until(() => api('/v1/sessions/' + legacy.id), value => value.status === 'completed');
  assert.notEqual(legacyDone.workspace, legacyDirectory); assert.ok(legacyDone.workspace_id);
  assert.equal(await readFile(join(legacyDirectory, 'retain.txt'), 'utf8'), 'legacy bytes');
  const session = await api('/v1/sessions', { user_context: 'user:1', client_chat_id: 'chat-flow', approval_mode: 'full_access' });
  assert.match(session.workspace, /workspaces[\\/]default/);
  assert.notEqual(session.workspace, process.env.USERPROFILE);
  const accepted = await api(`/v1/sessions/${session.id}/messages`, { content: 'spec:workspace:parent', user_context: 'user:1', client_chat_id: 'chat-flow',
    model: { base_url: 'http://127.0.0.1:' + model.address().port, api_key: 'fixture', name: 'deepseek-flash' } });
  assert.equal(accepted.accepted, true);
  const completed = await until(() => api('/v1/sessions/' + session.id), value => value.status === 'completed' || value.status === 'error');
  assert.equal(completed.status, 'completed', JSON.stringify(completed.events.at(-1)));
  const event = completed.events.find(event => event.event === 'workspace/changes');
  assert.ok(event.seq < completed.events.find(event => event.event === 'turn.completed').seq);
  assert.deepEqual(event.payload.files.map(file => file.path), ['child.txt', 'command.txt', 'parent.txt']);
  const headers = { 'X-MoonYa-Desktop-Secret': 'flow-secret', 'X-MoonYa-User': '1' };
  const params = new URLSearchParams({ session_id: session.id, turn: '1', client_chat_id: 'chat-flow' });
  const gatewayPath = '/v1/desktop/harness_api.php?action=changes_summary&' + params;
  const reviewed = await api(gatewayPath, undefined, headers); assert.equal(reviewed.data.total, 3);
  const foreign = await api(gatewayPath, undefined, { ...headers, 'X-MoonYa-User': '2' }); assert.equal(foreign.status, 403);
  const wrongChat = await api(gatewayPath.replace('chat-flow', 'wrong-chat'), undefined, headers); assert.equal(wrongChat.status, 403);
  await writeFile(join(session.workspace, 'parent.txt'), 'later edit');
  const undoPath = '/v1/desktop/harness_api.php?action=changes_undo';
  const undoInput = { session_id: session.id, turn: 1, client_chat_id: 'chat-flow', revision: 1, request_id: 'undo-flow' };
  const conflict = await api(undoPath, undoInput, headers); assert.equal(conflict.status, 409); assert.deepEqual(conflict.data.conflicts, ['parent.txt']);
  await writeFile(join(session.workspace, 'parent.txt'), 'parent write\n');
  const newRoot = join(directory, 'migrated');
  const moved = await api('/v1/desktop/harness_api.php?action=workspace_settings', { root: newRoot, migrate: true }, headers);
  assert.equal(moved.success, true, JSON.stringify(moved));
  const relocated = await api('/v1/sessions/' + session.id); assert.ok(relocated.workspace.startsWith(newRoot));
  await assert.rejects(access(session.workspace));
  await stop(); await start();
  const replay = await api(gatewayPath, undefined, headers); assert.equal(replay.data.total, 3);
  const undone = await api(undoPath, undoInput, headers); assert.equal(undone.data.state, 'undone', JSON.stringify(undone));
  for (const name of ['parent.txt', 'child.txt', 'command.txt']) await assert.rejects(access(join(relocated.workspace, name)));
  const repeated = await api(undoPath, undoInput, headers); assert.equal(repeated.data.state, 'undone');
  assert.deepEqual(errors, []);
});
