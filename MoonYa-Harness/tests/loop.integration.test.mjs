import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session-store.mjs';
import { RUNTIME_CAPABILITY_VERSION, RUNTIME_CAPABILITIES } from '../src/runtime-contract.mjs';

test('uploaded custom main and nested prompts reach actual model tool context and update on the next turn', {timeout:15000},async()=>{
  const fixtureRoot=await mkdtemp(join(tmpdir(),'moonya-uploaded-skill-'));
  const script=join(fixtureRoot,'catalog.php');
  await writeFile(script,`<?php
require $argv[1];
$root=$argv[2]; if(!is_dir($root))mkdir($root);
$catalog=new SkillCatalog($root);
if(!is_dir($root.'/writing-helper')) {
  $catalog->create('writing-helper','写作助手','Use this for test writing tasks','MAIN-FIRST');
  $catalog->createDirectory('writing-helper','prompts');
  $catalog->createDirectory('writing-helper','prompts/nested');
  $catalog->upload('writing-helper','prompts/nested',[['name'=>'guide.md','raw'=>'RESOURCE-UPLOADED-UNIQUE']]);
}
$skill=$catalog->read('writing-helper');
$catalog->update('writing-helper',str_replace($skill['body'],$argv[3],$skill['raw']));
echo json_encode($catalog->runtimeSkills(),JSON_UNESCAPED_UNICODE);
`);
  const catalogPath=fileURLToPath(new URL('../../MoonYa-Backend/Services/SkillCatalog.php',import.meta.url));
  const load=async marker=>JSON.parse((await promisify(execFile)('php',[script,catalogPath,join(fixtureRoot,'skills'),marker])).stdout);
  let expected='MAIN-FIRST',responses=0;
  const model=await listen((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const input=JSON.parse(Buffer.concat(chunks));
      const lastUser=input.messages.findLastIndex(message=>message.role==='user');
      const results=input.messages.slice(lastUser+1).filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
      res.setHeader('content-type','application/json');
      if(!results.length) {
        assert.match(input.messages.find(message=>message.role==='system').content,/writing-helper/);
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'main-'+expected,type:'function',function:{name:'read_skill',arguments:JSON.stringify({name:'writing-helper'})}}]}}]}));
      } else if(results.length===1) {
        assert.equal(results[0].content,expected);assert.deepEqual(results[0].resource_paths,['prompts/nested/guide.md']);
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'reference-'+expected,type:'function',function:{name:'read_skill',arguments:JSON.stringify({name:'writing-helper',path:results[0].resource_paths[0]})}}]}}]}));
      } else {
        assert.equal(results[0].content,expected);assert.equal(results[1].content,'RESOURCE-UPLOADED-UNIQUE');responses++;
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Applied '+expected+' and RESOURCE-UPLOADED-UNIQUE'}}]}));
      }
    });
  });
  const runtime=await startRuntime(1);
  try {
    const session=await request(runtime.port,'/v1/sessions',{workspace:runtime.workspace});
    for(const marker of ['MAIN-FIRST','MAIN-SECOND']) {
      expected=marker;
      await request(runtime.port,'/v1/sessions/'+session.id+'/messages',{content:'Use the writing skill '+marker,skills:await load(marker),selected_skills:['writing-helper'],
        model:{base_url:'http://127.0.0.1:'+model.address().port,api_key:'fixture',name:'fixture',context_window:100000}});
      await waitForStatus(runtime.port,session.id,'completed');
    }
    assert.equal(responses,2);
    const snapshot=await get(runtime.port,'/v1/sessions/'+session.id);
    assert.equal(snapshot.events.filter(event=>event.event==='tool.completed'&&event.payload.name==='read_skill').length,4);
  } finally {
    const exited=new Promise(resolve=>runtime.child.once('exit',resolve));runtime.child.kill();await exited;
    await close(model);await rm(runtime.dataRoot,{recursive:true,force:true});await rm(fixtureRoot,{recursive:true,force:true});
  }
});

test('health declares the desktop and history contract and exposes only the matching desktop tool', async () => {
  const runtime = await startRuntime(1);
  try {
    const health = await get(runtime.port, '/health');
    assert.equal(health.runtime_capability_version, RUNTIME_CAPABILITY_VERSION);
    assert.deepEqual(health.capabilities, RUNTIME_CAPABILITIES);
    const { tools } = await get(runtime.port, '/v1/tools');
    const names = tools.map(tool => tool.function.name);
    assert.ok(names.includes('computer_use_tool'));
    assert.ok(!names.includes('computer_observe') && !names.includes('computer_interact'));
  } finally { runtime.child.kill(); await rm(runtime.dataRoot, { recursive: true, force: true }); }
});

test('duplicate model call ids fail before any host operation is admitted', async () => {
  let hostCalls = 0;
  const tools = await listen((req, res) => { hostCalls++; req.resume(); res.end('{}'); });
  const model = await listen((req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    const call = { id: 'duplicate', type: 'function', function: { name: 'execute_command', arguments: '{"command":"Write-Output test"}' } };
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [call, call] } }] }));
  });
  const runtime = await startRuntime(tools.address().port);
  try {
    const session = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${session.id}/messages`, { content: 'verify invalid decision',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'fixture', name: 'deepseek-flash' } });
    const failed = await waitForStatus(runtime.port, session.id, 'error');
    assert.match(failed.events.findLast(e => e.event === 'session.error').payload.message, /duplicate call id/);
    assert.equal(hostCalls, 0);
    assert.equal(failed.events.filter(e => e.event === 'tool.started').length, 0);
  } finally { runtime.child.kill(); await Promise.all([close(model), close(tools)]); await rm(runtime.dataRoot, { recursive: true, force: true }); }
});

test('long work exceeds 100 steps, preserves raw tools and accepts sends after loop errors and cancellation', { timeout: 30000 }, async () => {
  let behavior = 'long';
  let summaries = 0;
  let round = 0;
  let toolRound = 0;
  let modelEntered;
  const fullOutput = 'complete-local-result:'.repeat(6000);
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (!input.tools) {
        summaries++;
        assert.equal(input.thinking.type, 'disabled');
        assert.equal(input.tool_choice, undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
          summary: 'Objective: long work. Earlier file reads completed; continue reading and verifying the remaining files.', retain_groups: [],
        }) } }] }));
        return;
      }
      const outstanding = new Set();
      for (const message of input.messages) {
        if (message.role === 'tool') { assert.ok(outstanding.delete(message.tool_call_id)); continue; }
        assert.equal(outstanding.size, 0, 'a new message cannot orphan an assistant tool call');
        for (const call of message.tool_calls || []) outstanding.add(call.id);
      }
      assert.equal(outstanding.size, 0);
      for (const message of input.messages.filter(message => message.role === 'tool')) {
        assert.ok(message.content.length < fullOutput.length, 'model history must use compact tool projections');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (behavior === 'wait') { modelEntered(); return; }
      const index = ++round;
      if (behavior === 'repeat' || (behavior === 'long' && index <= 105)) {
        const path = behavior === 'repeat' ? 'repeated.txt' : `step-${index}.txt`;
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: `call-${behavior}-${index}`, function: { name: 'read_file', arguments: JSON.stringify({ path }) }
        }] } }] }) + '\n\n');
      } else res.write('data: {"choices":[{"delta":{"content":"finished"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, content: ++toolRound <= 5 ? fullOutput : 'verified fixture' }));
    });
  });
  const runtime = await startRuntime(tools.address().port);
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    const attachmentPath = join(runtime.workspace, 'local-attachment.txt');
    await writeFile(attachmentPath, 'original attachment bytes');
    const payload = { content: 'long work', local_paths: [{ path: attachmentPath, kind: 'file' }], context_limit: 50000, model: { context_window:50000, base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' } };
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, payload);
    const complete = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(complete.events.filter(event => event.event === 'step.started').length, 106);
    const archived = complete.events.find(event => event.event === 'attachment.saved');
    await writeFile(attachmentPath, 'changed source bytes');
    assert.equal(await readFile(join(runtime.dataRoot, archived.payload.relative_path), 'utf8'), 'original attachment bytes');
    const rawTool = complete.events.find(event => event.event === 'tool.completed');
    assert.equal(rawTool.payload.result.content, fullOutput);
    assert.equal(rawTool.payload.result.truncated, undefined);
    assert.ok(complete.events.some(event => event.event === 'context.compacted'));
    assert.ok(!complete.events.some(event => event.event === 'context.compacted' && event.step > 10),
      'ordinary small follow-up steps must not repeatedly compact');
    for (const checkpoint of complete.events.filter(event => event.event === 'context.compacted')) {
      const following = complete.events.find(event => event.seq === checkpoint.seq + 1);
      assert.equal(following.event, 'context.usage');
      for (const key of ['used_tokens', 'system_tokens', 'tools_tokens', 'messages_tokens']) {
        assert.equal(following.payload[key], checkpoint.payload[key]);
      }
      assert.equal(checkpoint.payload.seq, checkpoint.seq);
      assert.ok(checkpoint.payload.after_tokens + checkpoint.payload.growth_tokens < payload.model.context_window * 0.8);
    }
    const initialStatistics = await get(runtime.port, '/v1/conversation-stats?user_context=' + encodeURIComponent('session:' + created.id)
      + '&client_chat_id=' + encodeURIComponent('session:' + created.id));
    assert.ok(summaries > 0);
    assert.equal(initialStatistics.completeness.attempts, 106 + summaries, 'every compaction request contributes an actual model attempt');
    assert.equal(initialStatistics.context.used_tokens, complete.events.findLast(event => event.event === 'context.usage').payload.used_tokens);
    behavior = 'repeat'; round = 0;
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, payload);
    const failed = await waitForStatus(runtime.port, created.id, 'error');
    assert.match(failed.events.at(-1).payload.message, /Repeated tool-call loop/);
    const recovered = new SessionStore(join(runtime.dataRoot, 'sessions'));
    await recovered.initialize();
    assert.equal(recovered.get(created.id).status, 'error');
    assert.equal(recovered.get(created.id).events.at(-1).event, 'session.error');
    behavior = 'finish'; round = 0;
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, payload);
    await waitForStatus(runtime.port, created.id, 'completed');
    behavior = 'wait';
    const entered = new Promise(resolve => { modelEntered = resolve; });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, payload);
    await entered;
    await request(runtime.port, `/v1/sessions/${created.id}/cancel`, {});
    assert.equal((await get(runtime.port, `/v1/sessions/${created.id}`)).status, 'cancelled');
    behavior = 'finish';
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, payload);
    await waitForStatus(runtime.port, created.id, 'completed');
    const lines = (await readFile(join(runtime.dataRoot, 'sessions', `${created.id}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(lines.every((event, index) => event.seq === index + 1));
  } finally {
    runtime.child.kill();
    model.closeAllConnections();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

process.env.MOONYA_BROWSER_TIMEOUT_MS = '5000';

test('original desktop skill drives a Python cell and takeover resumes with a fresh model image', { timeout: 15000 }, async () => {
  const body = await readFile(new URL('../../MoonYa-Backend/skills/computer-use-automation/SKILL.md', import.meta.url), 'utf8');
  const compatibility = await readFile(new URL('../../MoonYa-Backend/skills/computer-use-automation/references/moonya-runtime.md', import.meta.url), 'utf8');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
  const hostCalls = []; let round = 0;
  const calls = [
    ['read_skill', { name: 'computer-use' }],
    ['read_skill', { name: 'computer-use-automation', path: 'references/moonya-runtime.md' }],
    ['computer_use_tool', { plane: 'cu', title: '观察虚拟屏幕', code: 'import seed_computer_use as cu; print("observed"); cu.screenshot()' }],
    ['interaction_request_action', { type: 'desktopControl', display_message: '请在虚拟屏幕完成操作，然后确认完成。' }],
  ];
  const model = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    const previous = input.messages.findLast(message => message.role === 'tool');
    if (round === 1) assert.equal(JSON.parse(previous.content).content, body);
    if (round === 2) assert.equal(JSON.parse(previous.content).content, compatibility);
    if (round === 3 || round === 4) {
      const last = input.messages.at(-1);
      assert.equal(last.role, 'user'); assert.ok(last.content.some(item => item.type === 'image_url'));
      assert.ok(!previous.content.includes(png), 'image bytes must stay out of tool text');
      assert.equal(JSON.parse(previous.content).success, true);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const call = calls[round++];
    const delta = call ? { tool_calls: [{ index: 0, id: `desktop-${round}`, function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } : { content: '已重新观察并完成。' };
    res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n');
  });
  const host = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const args = JSON.parse(Buffer.concat(chunks)); hostCalls.push({ path: req.url, ...args });
    assert.equal(req.headers['x-moonya-host-token'], 'desktop-test-secret');
    const result = args.method === 'screenshot' ? { success: true, image: png, width: 1, height: 1, display: 'virtual' } : { success: true, display: { device: 'virtual', width: 1, height: 1 } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  const runtime = await startRuntime(host.address().port, {
    MOONYA_DESKTOP_HOST_TOKEN: 'desktop-test-secret',
    MOONYA_DESKTOP_PYTHON: process.env.MOONYA_TEST_PYTHON || 'python',
  });
  try {
    const session = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${session.id}/messages`, {
      content: '观察虚拟屏幕并让用户接管', selected_skills: ['computer-use'], approval_mode: 'full_access',
      skills: [{ name: 'computer-use-automation', description: 'Windows desktop operations', body, resources: { 'references/moonya-runtime.md': compatibility } }],
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' },
    });
    const pending = await waitForEvent(runtime.port, session.id, 'user_action.required');
    assert.equal(pending.status, 'running');
    const action = pending.events.find(event => event.event === 'user_action.required');
    assert.equal(action.payload.action_type, 'desktopControl');
    await request(runtime.port, `/v1/sessions/${session.id}/user-actions`, { action_id: action.payload.id, decision: 'complete' });
    const finished = await waitForStatus(runtime.port, session.id, 'completed');
    assert.ok(finished.events.some(event => event.event === 'desktop.started'));
    assert.equal(hostCalls.filter(call => call.method === 'screenshot').length, 2);
    assert.deepEqual(hostCalls.filter(call => call.path === '/desktop/control').map(call => call.command), ['takeover', 'resume']);
    assert.equal(hostCalls.filter(call => call.path === '/desktop/stop').length, 1);
    assert.equal(hostCalls.filter(call => call.path === '/desktop/release').length, 1);
  } finally {
    runtime.child.kill(); model.closeAllConnections(); host.closeAllConnections();
    await Promise.all([close(model), close(host)]); await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('model tool round is logged and resumes to a verified final answer', { timeout: 15000 }, async () => {
  let modelRound = 0;
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(request.tools.some(tool => tool.function.name === 'read_file'));
      assert.equal(request.model, 'deepseek-flash');
      assert.deepEqual(request.thinking, { type: 'enabled' });
      assert.equal(request.reasoning_effort, 'low');
      const userWithImage = request.messages.find(message => message.role === 'user' && Array.isArray(message.content));
      assert.equal(userWithImage.content[0].image_url.detail, 'low');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"已读取并验证。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(request.action, 'read_file');
      assert.match(request.path, /README\.md$/);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, content: '# fixture' }));
    });
  });
  const runtimePort = await freePort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'moonya-agent-runtime-'));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, MOONYA_HARNESS_PORT: String(runtimePort), MOONYA_HARNESS_DATA: dataRoot,
      MOONYA_LOCAL_SERVICE_URL: `http://127.0.0.1:${tools.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForHealth(runtimePort);
    const created = await request(runtimePort, '/v1/sessions', { workspace: 'D:\\Fixture' });
    const accepted = await request(runtimePort, `/v1/sessions/${created.id}/messages`, {
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } },
        { type: 'text', text: 'Inspect the readme' }
      ],
      reasoning_effort: 'low',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash', supports_tool_choice: false }
    });
    assert.equal(accepted.accepted, true);
    let history;
    for (let attempt = 0; attempt < 100; attempt++) {
      history = await get(runtimePort, `/v1/sessions/${created.id}`);
      if (history.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(history.status, 'completed');
    assert.deepEqual(history.events.filter(event => event.event.startsWith('tool.')).map(event => event.event), ['tool.started', 'tool.completed']);
    assert.equal(history.events.at(-1).event, 'turn.completed');
    const persisted = await readFile(join(dataRoot, 'sessions', `${created.id}.jsonl`), 'utf8');
    assert.match(persisted, /"turn.completed"/);
  } finally {
    child.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('high-risk commands wait with heartbeats and resume once after reconnect', { timeout: 30000 }, async () => {
  let modelRound = 0;
  let executed = false;
  let executionCount = 0;
  const model = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-risk","function":{"name":"execute_command","arguments":"{\\"command\\":\\"Remove-Item target.txt\\",\\"phase\\":\\"act\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"已执行并验证。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (input.action === 'validate_command') {
        res.end(JSON.stringify({ valid: true, status: 'success', riskLevel: 'high', effect: 'destructive', shell: 'powershell', commandPreview: input.command }));
      } else {
        assert.equal(input.action, 'execute_command');
        assert.equal(input.approval_granted, true);
        executed = true;
        executionCount += 1;
        res.end(JSON.stringify({ status: 'success', exitCode: 0, output: 'removed' }));
      }
    });
  });
  const runtime = await startRuntime(tools.address().port);
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: 'Remove the temporary target',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    const pending = await waitForEvent(runtime.port, created.id, 'approval.required');
    const approvalEvent = pending.events.find(event => event.event === 'approval.required');
    const approvalId = approvalEvent.payload.id;
    const deadline = Date.parse(approvalEvent.payload.expires_at);
    assert.ok(Number.isFinite(deadline), 'default approvals must expose their actual expiry');
    assert.ok(Math.abs(deadline - Date.parse(approvalEvent.timestamp) - 600000) < 1000,
      'default approval expiry must be ten minutes');
    const streamController = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${created.id}/events?after=${approvalEvent.seq}`,
      { signal: streamController.signal });
    const reader = stream.body.getReader();
    const heartbeat = await reader.read();
    assert.match(new TextDecoder().decode(heartbeat.value), /: heartbeat\n\n/);
    assert.equal(executed, false, 'waiting with heartbeats must not execute the command');
    streamController.abort();
    await reader.cancel().catch(() => {});
    const resumedController = new AbortController();
    const resumed = await fetch(`http://127.0.0.1:${runtime.port}/v1/sessions/${created.id}/events?after=${approvalEvent.seq - 1}`,
      { signal: resumedController.signal });
    const replay = await resumed.body.getReader().read();
    assert.match(new TextDecoder().decode(replay.value), new RegExp(approvalId));
    resumedController.abort();
    const stillPending = await get(runtime.port, `/v1/sessions/${created.id}`);
    assert.equal(stillPending.events.filter(event => event.event === 'approval.required').length, 1);

    await request(runtime.port, `/v1/sessions/${created.id}/approvals`, { approval_id: approvalId, decision: 'allow_once' });
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(executed, true);
    assert.equal(executionCount, 1, 'a reconnect must never execute the approved tool twice');
    assert.ok(history.events.some(event => event.event === 'approval.decided' && event.payload.status === 'allowed'));
    assert.ok(history.events.some(event => event.event === 'tool.completed'));
    const stats = await get(runtime.port, '/v1/conversation-stats?user_context=' + encodeURIComponent('session:' + created.id)
      + '&client_chat_id=' + encodeURIComponent('session:' + created.id));
    assert.ok(stats.timing.tool_ms > 0 && stats.timing.tool_ms < 5000,
      'the fifteen-second approval heartbeat wait must not count toward tool execution');
    assert.equal(stats.completeness.attempts, 2);
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('browser calls consume site, TLS and sensitive approvals before returning one final result to the model', { timeout: 15000 }, async () => {
  let modelRound = 0;
  const modelRequests = [];
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        // An otherwise local action can still surface a host authorization challenge.
        // Network pre-approval is exercised separately in permissions.integration.
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-browser","function":{"name":"browser_automation_control","arguments":"{\\"action\\":\\"inspect\\",\\"url\\":\\"https://fixture.invalid/\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"导航完成。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const kinds = ['site', 'tls', 'sensitive'];
  let executeCount = 0;
  const browser = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/browser/authorize') {
        res.end(JSON.stringify({ success: true, approval_token: input.approval_token }));
        return;
      }
      const kind = kinds[executeCount++];
      if (kind) {
        res.end(JSON.stringify({
          success: false, approval_required: true, error_code: 'approval_required',
          approval_token: `token-${kind}`, approval_kind: kind,
          url: 'https://fixture.invalid/', domain: 'fixture.invalid', action: 'navigate',
          risk_category: kind === 'sensitive' ? 'submit_personal_data' : '', page_version: 7,
          certificate_fingerprint: kind === 'tls' ? 'fixture-fingerprint' : '',
          expires_at: new Date(Date.now() + 10000).toISOString(),
          browser: { session_id: 'browser-session' },
        }));
        return;
      }
      res.end(JSON.stringify({ success: true, action: 'navigate', page_url: 'https://fixture.invalid/', page_version: 8 }));
    });
  });
  const tools = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  const runtime = await startRuntime(tools.address().port, { MOONYA_BROWSER_SERVICE_URL: `http://127.0.0.1:${browser.address().port}` });
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace, user_context: 'user:9' });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: 'Navigate through all browser safety gates',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    for (let index = 0; index < kinds.length; index++) {
      let pending;
      for (let attempt = 0; attempt < 200; attempt++) {
        const history = await get(runtime.port, `/v1/sessions/${created.id}`);
        const approvals = history.events.filter(event => event.event === 'approval.required');
        if (approvals.length > index) { pending = approvals[index]; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(pending, `approval ${index + 1} was not emitted`);
      assert.equal(pending.payload.challenge.approval_kind, kinds[index]);
      assert.ok(!JSON.stringify(pending.payload).includes(`token-${kinds[index]}`), 'desktop approval token leaked into the event log');
      await request(runtime.port, `/v1/sessions/${created.id}/approvals`, {
        approval_id: pending.payload.id, decision: 'allow_once'
      });
    }
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(executeCount, 4);
    assert.equal(history.events.filter(event => event.event === 'tool.started').length, 1);
    assert.equal(history.events.filter(event => event.event === 'tool.completed').length, 1);
    assert.equal(history.events.filter(event => event.event === 'tool.failed').length, 0);
    const toolMessages = modelRequests.at(-1).messages.filter(message => message.role === 'tool');
    assert.equal(toolMessages.length, 1);
    assert.equal(JSON.parse(toolMessages[0].content).success, true);
    assert.ok(!JSON.stringify(modelRequests).includes('token-site'));
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(browser), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('browser approval denial, expiry, repeated challenge, authorization failure and cancellation are terminal', { timeout: 30000 }, async t => {
  await t.test('denial', async () => {
    const result = await runBrowserApprovalFailureScenario('deny');
    assert.equal(result.toolResult.error_code, 'approval_denied');
    assert.equal(result.authorizeCount, 1);
  });
  await t.test('expiry', async () => {
    const result = await runBrowserApprovalFailureScenario('expire');
    assert.equal(result.toolResult.error_code, 'approval_expired');
    assert.equal(result.authorizeCount, 0);
    assert.ok(result.history.events.some(event => event.event === 'approval.decided' && event.payload.status === 'expired'));
  });
  await t.test('repeated challenge after approval', async () => {
    const result = await runBrowserApprovalFailureScenario('repeat');
    assert.equal(result.toolResult.error_code, 'invalid_approval_challenge');
    assert.equal(result.executeCount, 2);
  });
  await t.test('desktop authorization failure', async () => {
    const result = await runBrowserApprovalFailureScenario('authorize_fail');
    assert.equal(result.toolResult.error_code, 'approval_denied');
    assert.equal(result.authorizeCount, 1);
  });
  await t.test('runtime cancellation closes the pending approval', async () => {
    const result = await runBrowserApprovalFailureScenario('cancel');
    assert.equal(result.history.status, 'cancelled');
    assert.ok(result.history.events.some(event => event.event === 'approval.decided' && event.payload.status === 'cancelled'));
    assert.equal(result.history.events.at(-1).event, 'turn.cancelled');
  });
});

test('a semantic host-tool failure is recorded as tool.failed', { timeout: 15000 }, async () => {
  let modelRound = 0;
  const model = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-fail","function":{"name":"read_file","arguments":"{\\"path\\":\\"missing.txt\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"已报告明确阻塞。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'not found' }));
    });
  });
  const runtime = await startRuntime(tools.address().port);
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: 'Read the missing file',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.deepEqual(history.events.filter(event => event.event.startsWith('tool.')).map(event => event.event), ['tool.started', 'tool.failed']);
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('second turn replays a plain-text assistant reply without an empty tool_calls array', { timeout: 15000 }, async () => {
  const modelRequests = [];
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"好的。"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const runtime = await startRuntime(tools.address().port);
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    const modelConfig = { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' };
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, { content: '第一句', model: modelConfig });
    await waitForStatus(runtime.port, created.id, 'completed');
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, { content: '第二句', model: modelConfig });
    await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(modelRequests.length, 2);
    const replayedAssistantMessages = modelRequests[1].messages.filter(message => message.role === 'assistant');
    assert.equal(replayedAssistantMessages.length, 1);
    assert.ok(!Array.isArray(replayedAssistantMessages[0].tool_calls) || replayedAssistantMessages[0].tool_calls.length > 0,
      `assistant history message carries an empty tool_calls array: ${JSON.stringify(replayedAssistantMessages[0])}`);
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('thinking tool history survives compaction and runtime restart without a 400', { timeout: 30000 }, async () => {
  const requests = [];
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input.tools) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({
          summary: 'The original user task and earlier progress are established. The file read completed; continue the current task.', retain_groups: [],
        }) } }] }));
        return;
      }
      requests.push(input);
      if (input.messages.some(message => message.role === 'assistant'
        && !Object.hasOwn(message, 'reasoning_content'))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'reasoning_content must be passed back' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `reason-${requests.length}` } }] })}\n\n`);
      if (requests.length === 2) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-compact', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '完成' } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, content: 'file contents' }));
    });
  });
  const runtime = await startRuntime(tools.address().port);
  let activeChild = runtime.child;
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace, user_context: 'user:7' });
    const modelConfig = { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' };
    const send = async content => {
      await request(runtime.port, `/v1/sessions/${created.id}/messages`, { content, model: { ...modelConfig, context_window:30000 }, context_limit: 30000 });
      try { return await waitForStatus(runtime.port, created.id, 'completed'); }
      catch (error) {
        const snapshot = await get(runtime.port, `/v1/sessions/${created.id}`);
        throw new Error(`${error.message}: ${snapshot.events.findLast(event => event.event === 'session.error')?.payload.message || snapshot.status}`);
      }
    };
    await send('甲'.repeat(13000));
    await send('读取文件');
    const before = await get(runtime.port, `/v1/sessions/${created.id}/context-usage`);
    assert.equal(before.user_context, 'user:7');
    assert.ok(before.usage.used_tokens > 0);
    const afterThird = await send('乙'.repeat(13000));
    const checkpoint = afterThird.events.findLast(event => event.event === 'context.compacted');
    assert.ok(checkpoint, 'expected a durable compaction checkpoint');
    assert.ok(checkpoint.payload.before_tokens > checkpoint.payload.after_tokens);
    const toolCall = checkpoint.payload.history.find(message => message.role === 'assistant' && message.tool_calls?.length);
    const toolResult = checkpoint.payload.history.find(message => message.role === 'tool' && message.tool_call_id === 'call-compact');
    assert.ok(toolCall && toolResult, 'compaction must retain a complete tool round');
    assert.ok(!checkpoint.payload.history.some(message => message.role === 'user' && message.content === '甲'.repeat(13000)));
    activeChild.kill();
    await new Promise(resolve => activeChild.once('exit', resolve));
    activeChild = spawn(process.execPath, ['src/server.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, MOONYA_HARNESS_PORT: String(runtime.port), MOONYA_HARNESS_DATA: runtime.dataRoot,
        MOONYA_LOCAL_SERVICE_URL: `http://127.0.0.1:${tools.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForHealth(runtime.port);
    await send('重启后继续');
    assert.equal(requests.length, 5);
    assert.ok(!requests.at(-1).messages.some(message => message.role === 'user' && message.content === '甲'.repeat(13000)));
    assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-compact'));
    const latest = await get(runtime.port, `/v1/sessions/${created.id}/context-usage`);
    assert.ok(latest.usage.used_tokens > 0);
    const compactedCount = (await get(runtime.port, `/v1/sessions/${created.id}`)).events
      .filter(event => event.event === 'context.compacted').length;
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: '丙'.repeat(26000), model: { ...modelConfig, context_window:30000 }, context_limit: 30000
    });
    const failed = await waitForStatus(runtime.port, created.id, 'error');
    assert.match(failed.events.findLast(event => event.event === 'session.error').payload.message, /context_budget_exceeded/);
    assert.equal(failed.events.filter(event => event.event === 'context.compacted').length, compactedCount);
    assert.equal(requests.length, 5, 'an oversized current message must fail before the model request');
  } finally {
    activeChild.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('summary failure, truncation and cancellation preserve the committed checkpoint', { timeout: 15000 }, async t => {
  for (const mode of ['failure', 'truncated', 'cancel']) await t.test(mode, async () => {
    let summaryRequests = 0;
    const model = await listen((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input.tools) {
          summaryRequests++;
          assert.equal(input.thinking.type, 'disabled');
          assert.equal(input.parallel_tool_calls, undefined);
          if (mode === 'cancel') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
          if (mode === 'failure') { res.writeHead(503); res.end('summary service unavailable'); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant',
            content: JSON.stringify({ summary: 'A superficially valid but truncated summary.', retain_groups: [] }) } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Completed first task.', reasoning_content: 'original reasoning' } }] }));
      });
    });
    const tools = await listen((req, res) => { req.resume(); res.end('{}'); });
    const runtime = await startRuntime(tools.address().port);
    try {
      const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
      const modelConfig = { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' };
      await request(runtime.port, `/v1/sessions/${created.id}/messages`, { content: '甲'.repeat(13000), model: { ...modelConfig, context_window:30000 }, context_limit: 30000 });
      const before = await waitForStatus(runtime.port, created.id, 'completed');
      const previousUsage = before.events.findLast(event => event.event === 'context.usage');
      await request(runtime.port, `/v1/sessions/${created.id}/messages`, { content: '乙'.repeat(13000), model: { ...modelConfig, context_window:30000 }, context_limit: 30000 });
      await waitForEvent(runtime.port, created.id, 'context.compacting');
      if (mode === 'cancel') await request(runtime.port, `/v1/sessions/${created.id}/cancel`, {});
      const after = await waitForStatus(runtime.port, created.id, mode === 'cancel' ? 'cancelled' : 'error');
      assert.equal(after.events.filter(event => event.event === 'context.compacted').length, 0);
      assert.ok(after.events.some(event => event.event === 'context.compaction_failed'));
      assert.equal(after.events.findLast(event => event.event === 'context.usage').seq, previousUsage.seq);
      const snapshot = await get(runtime.port, `/v1/sessions/${created.id}/context-usage`);
      assert.equal(snapshot.usage.seq, previousUsage.seq);
      assert.equal(snapshot.usage.history, undefined);
      assert.equal(summaryRequests, mode === 'truncated' ? 2 : 1);
      assert.ok(!after.events.some(event => event.event === 'content.delta'), 'summary text must never enter the normal reply stream');
    } finally {
      runtime.child.kill();
      await Promise.all([close(model), close(tools)]);
      await rm(runtime.dataRoot, { recursive: true, force: true });
    }
  });
});

test('user browser handoff pauses, resumes, and returns a fresh browser observation', { timeout: 15000 }, async () => {
  let modelRound = 0;
  let returnedToolResult = null;
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const toolMessage = input.messages.findLast(message => message.role === 'tool');
      if (toolMessage) returnedToolResult = JSON.parse(toolMessage.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-handoff","function":{"name":"interaction_request_action","arguments":"{\\"type\\":\\"browserControl\\",\\"display_message\\":\\"请完成登录后点击确认完成。\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"登录后页面已重新观察。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  let inspectCount = 0;
  const browser = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.action, 'inspect');
      inspectCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, action: 'inspect', page_version: 22,
        page_url: 'https://fixture.invalid/account', page_text: '已登录', dom_elements: [] }));
    });
  });
  const tools = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  const runtime = await startRuntime(tools.address().port, { MOONYA_BROWSER_SERVICE_URL: `http://127.0.0.1:${browser.address().port}` });
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: '登录测试站点',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    const pendingHistory = await waitForEvent(runtime.port, created.id, 'user_action.required');
    const pending = pendingHistory.events.find(event => event.event === 'user_action.required');
    assert.equal(pending.payload.action_type, 'browserControl');
    assert.equal(pendingHistory.status, 'running');
    await request(runtime.port, `/v1/sessions/${created.id}/user-actions`, {
      action_id: pending.payload.id, decision: 'complete'
    });
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(inspectCount, 1);
    assert.equal(returnedToolResult.success, true);
    assert.equal(returnedToolResult.observation.page_version, 22);
    assert.ok(history.events.some(event => event.event === 'user_action.decided' && event.payload.status === 'completed'));
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(browser), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('skipping a user handoff stops that tool branch without inspecting the browser', { timeout: 15000 }, async () => {
  let modelRound = 0;
  let returnedToolResult = null;
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const toolMessage = input.messages.findLast(message => message.role === 'tool');
      if (toolMessage) returnedToolResult = JSON.parse(toolMessage.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-upload","function":{"name":"interaction_request_action","arguments":"{\\"type\\":\\"fileUpload\\",\\"display_message\\":\\"请选择图片。\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"用户已跳过上传。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const tools = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  const runtime = await startRuntime(tools.address().port, { MOONYA_BROWSER_SERVICE_URL: 'http://127.0.0.1:1' });
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: '上传测试',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    const pendingHistory = await waitForEvent(runtime.port, created.id, 'user_action.required');
    const pending = pendingHistory.events.find(event => event.event === 'user_action.required');
    await request(runtime.port, `/v1/sessions/${created.id}/user-actions`, {
      action_id: pending.payload.id, decision: 'skip'
    });
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(returnedToolResult.error_code, 'user_action_skipped');
    assert.ok(history.events.some(event => event.event === 'user_action.decided' && event.payload.status === 'skipped'));
    assert.ok(history.events.some(event => event.event === 'tool.failed' && event.payload.name === 'interaction_request_action'));
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
});

test('user handoff timeout and task cancellation settle the pending action', { timeout: 15000 }, async t => {
  async function run(mode) {
    let modelRound = 0;
    const model = await listen((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (modelRound++ === 0) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-terminal-handoff","function":{"name":"interaction_request_action","arguments":"{\\"type\\":\\"browserControl\\",\\"display_message\\":\\"请完成验证。\\"}"}}]}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"接管未完成。"}}]}\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    const tools = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
    const runtime = await startRuntime(tools.address().port, { MOONYA_USER_ACTION_TIMEOUT_MS: '80' });
    try {
      const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace });
      await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
        content: '触发用户接管',
        model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
      });
      await waitForEvent(runtime.port, created.id, 'user_action.required');
      if (mode === 'cancel') {
        await request(runtime.port, `/v1/sessions/${created.id}/cancel`, {});
        return await waitForStatus(runtime.port, created.id, 'cancelled');
      }
      return await waitForStatus(runtime.port, created.id, 'completed');
    } finally {
      runtime.child.kill();
      await Promise.all([close(model), close(tools)]);
      await rm(runtime.dataRoot, { recursive: true, force: true });
    }
  }
  await t.test('timeout', async () => {
    const history = await run('timeout');
    assert.ok(history.events.some(event => event.event === 'user_action.decided' && event.payload.status === 'expired'));
    assert.ok(history.events.some(event => event.event === 'tool.failed'
      && event.payload.result.error_code === 'user_action_expired'));
  });
  await t.test('cancel', async () => {
    const history = await run('cancel');
    assert.ok(history.events.some(event => event.event === 'user_action.decided' && event.payload.status === 'cancelled'));
  });
});

test('runtime restart settles pending approvals and tool calls before interrupting the turn', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'moonya-session-restart-'));
  const sessionRoot = join(dataRoot, 'sessions');
  try {
    const firstStore = new SessionStore(sessionRoot);
    await firstStore.initialize();
    const session = await firstStore.create({ workspace: dataRoot, workspaceIdentity: dataRoot, userContext: 'user:4' });
    session.turn = 1;
    await firstStore.append(session, 'turn.started', {}, { turn: 1, status: 'running' });
    await firstStore.append(session, 'assistant.message', {
      content: '', tool_calls: [{ id: 'call-pending', type: 'function', function: { name: 'browser_automation_control', arguments: '{"action":"navigate"}' } }]
    }, { turn: 1, step: 1 });
    await firstStore.append(session, 'tool.started', {
      name: 'browser_automation_control', arguments: { action: 'navigate' }
    }, { turn: 1, step: 1, toolCallId: 'call-pending', status: 'running' });
    await firstStore.append(session, 'approval.required', {
      id: 'approval-pending', status: 'pending', tool_key: 'browser_automation_control'
    }, { turn: 1, step: 1, toolCallId: 'call-pending', status: 'pending' });
    await firstStore.append(session, 'user_action.required', {
      id: 'user-action-pending', status: 'pending', action_type: 'browserControl'
    }, { turn: 1, step: 1, toolCallId: 'call-pending', status: 'pending' });
    await firstStore.append(session, 'context.compacting', {}, { turn: 1, step: 2, status: 'running' });

    const recoveredStore = new SessionStore(sessionRoot);
    await recoveredStore.initialize();
    const recovered = recoveredStore.get(session.id);
    assert.ok(recovered.events.some(event => event.event === 'context.compaction_failed' && event.step === 2));
    assert.ok(!recovered.events.some(event => event.event === 'context.compacted'));
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.events.at(-1).event, 'turn.interrupted');
    assert.ok(recovered.events.some(event => event.event === 'tool.failed'
      && event.tool_call_id === 'call-pending'
      && event.payload.result.error_code === 'runtime_restarted'));
    assert.ok(recovered.events.some(event => event.event === 'approval.decided'
      && event.payload.approval_id === 'approval-pending'
      && event.payload.status === 'expired'));
    assert.ok(recovered.events.some(event => event.event === 'user_action.decided'
      && event.payload.action_id === 'user-action-pending'
      && event.payload.status === 'expired'));
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = await listen((_req, res) => res.end());
  const port = server.address().port;
  await close(server);
  return port;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await get(port, '/health')).status === 'ok') return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('runtime did not become healthy');
}
async function get(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
async function request(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

test('a parallel quota rejection waits for the admitted operation and preserves its final file/result before terminal',async()=>{
  let checks=0,calls=0,tools=0,runtime,admitted;
  const began=new Promise(resolve=>admitted=resolve);
  const host=await listen(async(req,res)=>{
    req.resume();tools++;admitted();await new Promise(resolve=>setTimeout(resolve,120));
    await writeFile(join(runtime.workspace,'finished-before-quota.txt'),'retained bytes');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,content:'operation finished'}));
  });
  const upstream=await listen(async(req,res)=>{
    req.resume();
    if(req.url==='/balance'){
      const check=++checks;if(check===3)await began;
      res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{account:{balance:check===3?'0':'1'}}}));
    }
    calls++;res.setHeader('content-type','application/json');
    const tool_calls=['admitted','blocked'].map(id=>({id,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:join(runtime.workspace,id+'.txt')})}}));
    res.end(JSON.stringify({choices:[{message:{content:'已有内容',tool_calls}}]}));
  });
  runtime=await startRuntime(host.address().port);runtime.workspace=await mkdtemp(join(tmpdir(),'moonya-parallel-quota-'));
  try{
    const session=await request(runtime.port,'/v1/sessions',{workspace:runtime.workspace});
    await request(runtime.port,`/v1/sessions/${session.id}/messages`,{content:'run',model:{builtin:true,credit_url:`http://127.0.0.1:${upstream.address().port}/balance`,base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'ephemeral',name:'deepseek-flash'}});
    const history=await waitForStatus(runtime.port,session.id,'quota_stopped');assert.equal(tools,1);assert.equal(calls,1);
    assert.equal(await readFile(join(runtime.workspace,'finished-before-quota.txt'),'utf8'),'retained bytes');
    assert.ok(history.events.findIndex(e=>e.event==='tool.completed')<history.events.findIndex(e=>e.event==='turn.quota_stopped'));
    assert.ok(history.events.some(e=>e.event==='tool.failed'&&e.tool_call_id==='blocked'&&e.payload.result.error_code==='credits_exhausted'));
    assert.ok(history.events.some(e=>e.event==='workspace/changes'));
  }finally{const exit=new Promise(resolve=>runtime.child.once('exit',resolve));runtime.child.kill();await exit;await Promise.all([close(upstream),close(host)]);await rm(runtime.dataRoot,{recursive:true,force:true});assert.ok(runtime.workspace.startsWith(join(tmpdir(),'moonya-parallel-quota-')));await rm(runtime.workspace,{recursive:true,force:true});}
});

test('quota terminal preserves the model answer and workspace record, blocks its tools, and replays once after restart',async()=>{
  let calls=0,tools=0,runtime;
  const host=await listen((req,res)=>{tools++;req.resume();res.end('{}');});
  const upstream=await listen(async(req,res)=>{
    req.resume();
    if(req.url==='/balance'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{account:{balance:'0.1'}}}));}
    calls++;await writeFile(join(runtime.workspace,'already-completed.txt'),'preserved changes');res.setHeader('content-type','text/event-stream');
    const delta={content:'已生成的结果保留',tool_calls:[{index:0,id:'never-execute',type:'function',function:{name:'execute_command',arguments:JSON.stringify({command:'Write-Output forbidden'})}}]};
    res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: '+JSON.stringify({type:'credits_update',data:{call_id:'settled',exhausted:true,account:{balance:'0'}}})+'\n\ndata: [DONE]\n\n');
  });
  runtime=await startRuntime(host.address().port);
  runtime.workspace=await mkdtemp(join(tmpdir(),'moonya-quota-workspace-'));
  try{
    const session=await request(runtime.port,'/v1/sessions',{workspace:runtime.workspace});
    await request(runtime.port,`/v1/sessions/${session.id}/messages`,{content:'run',model:{builtin:true,credit_url:`http://127.0.0.1:${upstream.address().port}/balance`,base_url:`http://127.0.0.1:${upstream.address().port}/v1`,api_key:'ephemeral',name:'deepseek-flash'}});
    const history=await waitForStatus(runtime.port,session.id,'quota_stopped');
    assert.equal(tools,0);assert.equal(calls,1);assert.equal(history.events.filter(e=>e.event==='turn.quota_stopped').length,1);
    assert.equal(history.events.find(e=>e.event==='assistant.message').payload.content,'已生成的结果保留');
    assert.ok(history.events.some(e=>e.event==='workspace/changes'),JSON.stringify(history.events.map(e=>({event:e.event,payload:e.event==='workspace/changes.error'?e.payload:undefined}))));
    assert.equal(await readFile(join(runtime.workspace,'already-completed.txt'),'utf8'),'preserved changes');
    const exit=new Promise(resolve=>runtime.child.once('exit',resolve));runtime.child.kill();await exit;
    const reloaded=new SessionStore(join(runtime.dataRoot,'sessions'));await reloaded.initialize();
    const restored=reloaded.get(session.id);assert.equal(restored.status,'quota_stopped');assert.equal(restored.events.filter(e=>e.event==='turn.quota_stopped').length,1);
    assert.equal(tools,0);assert.equal(calls,1);
  }finally{runtime.child.kill();await Promise.all([close(upstream),close(host)]);await rm(runtime.dataRoot,{recursive:true,force:true});assert.ok(runtime.workspace.startsWith(join(tmpdir(),'moonya-quota-workspace-')));await rm(runtime.workspace,{recursive:true,force:true});}
});

async function startRuntime(toolPort, extraEnv = {}) {
  const port = await freePort();
  const dataRoot = await mkdtemp(join(tmpdir(), 'moonya-agent-runtime-'));
  const workspace = join(dataRoot, 'workspace');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, MOONYA_HARNESS_PORT: String(port), MOONYA_HARNESS_DATA: dataRoot,
      MOONYA_LOCAL_SERVICE_URL: `http://127.0.0.1:${toolPort}`, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await import('node:fs/promises').then(fs => fs.mkdir(workspace, { recursive: true }));
  await waitForHealth(port);
  return { port, dataRoot, workspace, child };
}

async function waitForEvent(port, sessionId, eventName) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const history = await get(port, `/v1/sessions/${sessionId}`);
    if (history.events.some(event => event.event === eventName)) return history;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`event not observed: ${eventName}`);
}

async function waitForStatus(port, sessionId, status) {
  const deadline = Date.now() + 15000;
  let history;
  while (Date.now() < deadline) {
    history = await get(port, `/v1/sessions/${sessionId}`);
    if (history.status === status) return history;
    if (history.status === 'error' && status !== 'error') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`status not observed: ${status}; actual: ${history?.status}; last event: ${JSON.stringify(history?.events.at(-1))}`);
}

async function runBrowserApprovalFailureScenario(mode) {
  let modelRound = 0;
  let toolResult = null;
  let executeCount = 0;
  let authorizeCount = 0;
  const model = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const toolMessage = input.messages.findLast(message => message.role === 'tool');
      if (toolMessage) toolResult = JSON.parse(toolMessage.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (modelRound++ === 0) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-browser-failure","function":{"name":"browser_automation_control","arguments":"{\\"action\\":\\"inspect\\",\\"url\\":\\"https://failure.invalid/\\"}"}}]}}]}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"已处理失败结果。"}}]}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  const browser = await listen((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/browser/authorize') {
        authorizeCount++;
        if (mode === 'authorize_fail') {
          res.end(JSON.stringify({ success: false, error_code: 'approval_denied', error: 'authorization rejected' }));
        } else {
          res.end(JSON.stringify({ success: true }));
        }
        return;
      }
      executeCount++;
      res.end(JSON.stringify({
        success: false, approval_required: true, error_code: 'approval_required',
        approval_token: 'desktop-secret', approval_kind: 'site',
        url: 'https://failure.invalid/', domain: 'failure.invalid', action: 'navigate',
        page_version: 2, expires_at: new Date(Date.now() + (mode === 'expire' ? 80 : 10000)).toISOString(),
        browser: { session_id: 'browser-failure-session' },
      }));
    });
  });
  const tools = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  const runtime = await startRuntime(tools.address().port, { MOONYA_BROWSER_SERVICE_URL: `http://127.0.0.1:${browser.address().port}` });
  try {
    const created = await request(runtime.port, '/v1/sessions', { workspace: runtime.workspace, user_context: 'user:failure' });
    await request(runtime.port, `/v1/sessions/${created.id}/messages`, {
      content: 'Exercise browser approval failure handling',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'test', name: 'deepseek-flash' }
    });
    const pending = await waitForEvent(runtime.port, created.id, 'approval.required');
    const approvalId = pending.events.find(event => event.event === 'approval.required').payload.id;
    if (mode === 'cancel') {
      await request(runtime.port, `/v1/sessions/${created.id}/cancel`, {});
      const history = await waitForStatus(runtime.port, created.id, 'cancelled');
      return { history, toolResult, executeCount, authorizeCount };
    }
    if (mode !== 'expire') {
      await request(runtime.port, `/v1/sessions/${created.id}/approvals`, {
        approval_id: approvalId, decision: mode === 'deny' ? 'deny' : 'allow_once'
      });
    }
    const history = await waitForStatus(runtime.port, created.id, 'completed');
    assert.equal(history.events.filter(event => event.event === 'tool.started').length, 1);
    assert.equal(history.events.filter(event => event.event === 'tool.failed').length, 1);
    return { history, toolResult, executeCount, authorizeCount };
  } finally {
    runtime.child.kill();
    await Promise.all([close(model), close(browser), close(tools)]);
    await rm(runtime.dataRoot, { recursive: true, force: true });
  }
}
