import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOfficeToolSchemas } from './helpers/office-tool-schemas.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const delegate = (id, prompt, description = prompt) => ({ id, type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ prompt, description }) } });
const reply = (content = 'done', calls) => ({ role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) });
async function until(operation, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await operation(); if (predicate(value)) return value; await sleep(15); }
  throw new Error(`Timed out: ${JSON.stringify(value).slice(-4000)}`);
}

async function fixture(handler, {builtin=false}={}) {
    const rounds = new Map(), errors = [];
  const model = http.createServer(async (req, res) => {
    try {
      if(req.url==='/balance'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{account:{balance:'1'}}}));}
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assertOfficeToolSchemas(input.tools);
      const task = input.messages.filter(message => message.role === 'user' && String(message.content).startsWith('spec:')).at(-1)?.content;
      const round = (rounds.get(task) || 0) + 1; rounds.set(task, round);
      const message = await handler(task, round, input);
      if(message._billing) {
        res.setHeader('content-type','text/event-stream');
        const delta={content:message.content,tool_calls:(message.tool_calls||[]).map((call,index)=>({...call,index}))};
        res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: '+JSON.stringify({type:'credits_update',data:message._billing})+'\n\ndata: [DONE]\n\n');return;
      }
      if (message._stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: message.content } }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
    } catch (error) { errors.push(error); res.statusCode = 500; res.end(error.message); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(join(tmpdir(), 'moonya-office-integration-'));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let runtime, diagnostics = '';
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.json();
  };
  const start = async () => {
    runtime = spawn(process.env.MOONYA_HARNESS_EXECUTABLE || process.execPath, process.env.MOONYA_HARNESS_EXECUTABLE ? [] : ['src/server.mjs'], {
      cwd: new URL('..', import.meta.url), windowsHide: true, env: { ...process.env, MOONYA_HARNESS_PORT: String(port), MOONYA_HARNESS_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    runtime.stderr.on('data', chunk => { diagnostics += chunk; });
    await until(async () => { try { return await api('/health'); } catch { if (runtime.exitCode !== null) throw new Error(diagnostics); return null; } }, Boolean);
  };
  const stop = async () => { if (runtime.exitCode === null && runtime.signalCode === null) { const exited = new Promise(resolve => runtime.once('exit', resolve)); runtime.kill(); await exited; } };
  await start();
  return { api, rounds, errors, data, baseUrl: `http://127.0.0.1:${port}`,
    create: user => api('/v1/sessions', { workspace: data, user_context: user || 'user:integration' }),
    send: (id, content, extra = {}) => api(`/v1/sessions/${id}/messages`, { content, model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'fixture', name: 'deepseek-flash',...(builtin?{builtin:true,credit_url:`http://127.0.0.1:${model.address().port}/balance`}:{}) }, ...extra }),
    office: id => api(`/v1/sessions/${id}/office`),
    done: id => until(() => api(`/v1/sessions/${id}`), value => ['completed', 'error', 'cancelled','quota_stopped'].includes(value.status)),
    restart: async mutate => { await stop(); if (mutate) await mutate(data); await start(); },
    close: async () => { await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(data, { recursive: true, force: true }); },
  };
}

test('a child settlement stops the root scope, preserves its reply, and never starts the requested next child operation',async()=>{
  let settled;const childDone=new Promise(resolve=>settled=resolve);
  const f=await fixture(async(task,round)=>{
    if(task==='spec:quota-root'&&round===1)return reply('',[delegate('dispatch','spec:quota-child')]);
    if(task.startsWith('spec:quota-child')){
      settled();return {...reply('child result preserved',[{id:'forbidden-read',type:'function',function:{name:'read_file',arguments:'{"path":"never-read.txt"}'}}]),_billing:{exhausted:true,call_id:'child-billed',account:{balance:'0'}}};
    }
    await childDone;await sleep(40);return reply('root result');
  },{builtin:true});
  try{
    const root=await f.create();await f.send(root.id,'spec:quota-root');
    const history=await f.done(root.id);assert.equal(history.status,'quota_stopped');
    const snapshot=await until(()=>f.office(root.id),value=>value.employees[0]?.status==='quota_stopped');
    const child=await f.api(`/v1/sessions/${snapshot.employees[0].child_id}`);
    assert.equal(child.status,'quota_stopped');assert.equal(child.events.filter(e=>e.event==='tool.started').length,0);
    assert.match(child.events.find(e=>e.event==='assistant.message').payload.content,/child result preserved/);
    assert.ok(history.events.some(e=>e.event==='office/child-event'&&e.payload.event==='credits.updated'));
    assert.equal([...f.rounds].find(([task])=>task.startsWith('spec:quota-child'))?.[1],1);assert.deepEqual(f.errors,[]);
    await f.restart();assert.equal((await f.office(root.id)).employees[0].status,'quota_stopped');
  }finally{await f.close();}
});

test('eight waiting parents release permits for grandchildren; fourth level is rejected without ghost employees', { timeout: 30000 }, async () => {
  const f = await fixture(async (task, round, input) => {
    if (task === 'spec:nested-root' && round === 1) return reply('', Array.from({ length: 8 }, (_, i) => delegate(`p${i}`, `spec:nested-parent:${i}`)));
    if (task.startsWith('spec:nested-parent:') && round === 1) return reply('', [delegate('grandchild', task.replace('parent', 'leaf'))]);
    if (task.startsWith('spec:nested-leaf:') && round === 1) return reply('', [delegate('forbidden', 'spec:forbidden')]);
    assert.notEqual(task, 'spec:forbidden');
    if (task.startsWith('spec:nested-leaf:')) assert.ok(input.messages.some(message => message.role === 'tool' && String(message.content).includes('depth')));
    return reply('settled');
  });
  try {
    const root = await f.create(); await f.send(root.id, 'spec:nested-root');
    assert.equal((await f.done(root.id)).status, 'completed');
    const snapshot = await f.office(root.id);
    assert.equal(snapshot.employees.length, 16); assert.ok(snapshot.employees.every(row => row.status === 'completed'));
    const parents = new Set(snapshot.employees.filter(row => row.parent_id === root.id).map(row => row.child_id));
    assert.equal(parents.size, 8); assert.equal(snapshot.employees.filter(row => parents.has(row.parent_id)).length, 8);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('employee records preserve full tasks and original turns, replay together, and reject foreign branches', { timeout: 30000 }, async () => {
  const longTask = 'spec:long:' + '核对资料'.repeat(1800);
  const f = await fixture(async (task, round) => {
    if (task === 'spec:turn-one' && round === 1) return reply('', [delegate('long', longTask, 'Long task'), delegate('tree', 'spec:tree-parent', 'Parent')]);
    if (task.startsWith('spec:tree-parent') && round === 1) return reply('', [delegate('leaf', 'spec:tree-leaf', 'Leaf')]);
    if (task === 'spec:turn-two' && round === 1) return reply('', [delegate('second', 'spec:second-child', 'Second turn')]);
    return reply('settled');
  });
  const controller = new AbortController();
  try {
    const root = await f.create(); await f.send(root.id, 'spec:turn-one'); assert.equal((await f.done(root.id)).status, 'completed');
    const first = await f.office(root.id), original = new Map(first.employees.map(row => [row.child_id, row.created_seq]));
    assert.equal(first.employees.length, 3, JSON.stringify(first.employees.map(row => ({ label: row.label, status: row.status, result: row.result?.slice(0, 1500) }))) + JSON.stringify([...f.rounds].map(([task, count]) => [task?.slice(0, 80), count]))); assert.ok(first.employees.every(row => row.created_turn === 1 && row.created_seq > 0));
    const long = first.employees.find(row => row.label === 'Long task');
    assert.equal((await f.api(`/v1/sessions/${root.id}/office/employees/${long.child_id}`)).task, longTask);
    await f.send(root.id, 'spec:turn-two'); assert.equal((await f.done(root.id)).status, 'completed');
    const second = await f.office(root.id);
    assert.equal(second.employees.find(row => row.label === 'Second turn').created_turn, 2);
    assert.ok(second.employees.filter(row => original.has(row.child_id)).every(row => row.created_turn === 1 && row.created_seq === original.get(row.child_id)));
    const cursors = Object.fromEntries(second.employees.map(row => [row.child_id, 0]));
    const response = await fetch(f.baseUrl + `/v1/sessions/${root.id}/office/employee-events?` + new URLSearchParams({ children: JSON.stringify(cursors) }), { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(), records = []; let buffer = '';
    while (new Set(records.filter(event => event.event === 'turn.completed').map(event => event.session_id)).size < 4) {
      const part = await reader.read(); buffer += decoder.decode(part.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('data: ')) records.push(JSON.parse(frame.slice(6)));
      }
    }
    assert.ok(records.every(event => event.session_id in cursors)); controller.abort();
    const foreign = await f.create();
    const rejected = await fetch(f.baseUrl + `/v1/sessions/${foreign.id}/office/employee-events?` + new URLSearchParams({ children: JSON.stringify(cursors) }));
    assert.equal(rejected.status, 403);
    await f.restart();
    assert.deepEqual((await f.office(root.id)).employees.map(row => [row.child_id, row.created_turn, row.created_seq]), second.employees.map(row => [row.child_id, row.created_turn, row.created_seq]));
    assert.deepEqual(f.errors, []);
  } finally { controller.abort(); await f.close(); }
});

test('branch stop removes running and queued descendants, fences late messages, and leaves sibling branch running', { timeout: 30000 }, async () => {
  let release, cancelledId; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (task, round, input) => {
    if (task === 'spec:cancel-root' && round === 1) return reply('', ['A', 'B'].map(branch => delegate(branch, `spec:branch:${branch}`, `Branch ${branch}`)));
    if (task.startsWith('spec:branch:') && round === 1) return reply('', Array.from({ length: 8 }, (_, i) => delegate(`leaf${i}`, `spec:held:${task.at(-1)}:${i}`)));
    if (task.startsWith('spec:held:')) await gate;
    if (task === 'spec:late' && round === 1) return reply('', [{ id: 'late', type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ agent_id: cancelledId, message: 'Continue cancelled work' }) } }]);
    if (task === 'spec:late') assert.ok(input.messages.some(message => message.role === 'tool' && String(message.content).includes('task_branch_cancelled')));
    return reply('settled');
  });
  try {
    const root = await f.create(); await f.send(root.id, 'spec:cancel-root');
    const before = await until(() => f.office(root.id), value => value.employees.length === 18 && value.employees.some(row => row.status === 'queued'));
    const a = before.employees.find(row => row.label === 'Branch A'), b = before.employees.find(row => row.label === 'Branch B');
    cancelledId = a.child_id;
    await f.api(`/v1/sessions/${root.id}/office/employees/${a.child_id}/cancel`, {});
    const cancelled = await f.office(root.id);
    assert.ok(cancelled.employees.filter(row => row.child_id === a.child_id || row.parent_id === a.child_id).every(row => row.status === 'cancelled'));
    assert.ok(!['cancelled', 'completed', 'failed'].includes(cancelled.employees.find(row => row.child_id === b.child_id).status));
    assert.equal((await f.api(`/v1/sessions/${root.id}`)).status, 'running');
    release(); assert.equal((await f.done(root.id)).status, 'completed');
    const settled = await f.office(root.id);
    assert.equal(settled.employees.length, 18);
    assert.ok(settled.employees.filter(row => row.child_id === a.child_id || row.parent_id === a.child_id).every(row => row.status === 'cancelled'));
    assert.ok(settled.employees.filter(row => row.child_id === b.child_id || row.parent_id === b.child_id).every(row => row.status === 'completed'));
    const calls = f.rounds.size, aRounds = [...f.rounds].filter(([task]) => task.startsWith('spec:branch:A')).reduce((sum, [, count]) => sum + count, 0); await f.restart();
    assert.deepEqual((await f.office(root.id)).employees, settled.employees); assert.equal(f.rounds.size, calls);
    await f.send(root.id, 'spec:late'); assert.equal((await f.done(root.id)).status, 'completed');
    assert.equal([...f.rounds].filter(([task]) => task.startsWith('spec:branch:A')).reduce((sum, [, count]) => sum + count, 0), aRounds); assert.deepEqual(f.errors, []);
    await f.api(`/v1/sessions/${root.id}/office/clear`, {}); assert.equal((await f.office(root.id)).employees.length, 0);
  } finally { release(); await f.close(); }
});

test('concurrency is shared across user sessions, resized immediately, persisted, and isolated from another user', { timeout: 30000 }, async () => {
  let active = 0, maximum = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (task, round) => {
    if (task.startsWith('spec:room:') && round === 1) return reply('', Array.from({ length: 6 }, (_, i) => delegate(`c${i}`, `spec:worker:${task.at(-1)}:${i}`)));
    if (task.startsWith('spec:worker:')) { active++; maximum = Math.max(maximum, active); await gate; active--; }
    return reply('settled');
  });
  try {
    const a = await f.create('user:shared'), b = await f.create('user:shared'), other = await f.create('user:other');
    await f.api('/v1/office/settings', { user_context: 'user:shared', concurrency: 2 });
    await Promise.all([f.send(a.id, 'spec:room:A'), f.send(b.id, 'spec:room:B')]);
    await until(() => f.office(b.id), value => value.employees.length === 6); await until(async () => active, value => value === 2);
    await f.api('/v1/office/settings', { user_context: 'user:shared', concurrency: 5 });
    await until(async () => active, value => value === 5);
    await f.api('/v1/office/settings', { user_context: 'user:shared', concurrency: 1 });
    assert.equal(active, 5);
    assert.equal((await f.office(other.id)).concurrency, 8); assert.equal((await f.office(other.id)).employees.length, 0);
    const foreign = (await f.office(a.id)).employees[0].child_id;
    assert.equal((await f.api(`/v1/sessions/${b.id}/office/employees/${foreign}`)).error, 'subagent_not_found');
    release(); await Promise.all([f.done(a.id), f.done(b.id)]); assert.equal(maximum, 5);
    assert.equal((await f.office(a.id)).employees.length, 6); assert.equal((await f.office(b.id)).employees.length, 6);
    await f.restart(); assert.equal((await f.office(a.id)).concurrency, 1);
    assert.equal((await f.send(a.id, 'spec:chat', { mode: 'chat' })).error, 'agent_runtime_requires_work_mode');
  } finally { release(); await f.close(); }
});

test('streamed final text is withheld until durable settlement notices are consumed', { timeout: 30000 }, async () => {
  let release, premature = false; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (task, round, input) => {
    if (task === 'spec:stream-root' && round === 1) return reply('', [delegate('child', 'spec:stream-child')]);
    if (task.startsWith('spec:stream-child')) { await gate; return reply('verified child evidence'); }
    if (task === 'spec:stream-root' && round === 2) { premature = true; return { ...reply('PREMATURE SUMMARY'), _stream: true }; }
    assert.ok(input.messages.some(message => message.role === 'user' && String(message.content).includes('verified child evidence')));
    return { ...reply('FINAL WITH EVIDENCE'), _stream: true };
  });
  try {
    const root = await f.create(); await f.send(root.id, 'spec:stream-root');
    await until(async () => premature, Boolean); await sleep(30);
    const pending = await f.api(`/v1/sessions/${root.id}`);
    assert.equal(pending.status, 'running', JSON.stringify(pending.events.slice(-4))); assert.ok(!JSON.stringify(pending.events).includes('PREMATURE SUMMARY'));
    release(); const settled = await f.done(root.id);
    assert.equal(settled.status, 'completed'); assert.ok(!JSON.stringify(settled.events).includes('PREMATURE SUMMARY'));
    assert.equal(settled.events.findLast(event => event.event === 'turn.completed').payload.content, 'FINAL WITH EVIDENCE');
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});

test('child approval releases its permit, preserves child identity and isolates a failed sibling', { timeout: 30000 }, async () => {
  const f = await fixture(async (task, round, input) => {
    if (task === 'spec:approval-root' && round === 1) return reply('', ['approve', 'ok', 'fail'].map(kind => delegate(kind, `spec:approval-${kind}`)));
    if (task.startsWith('spec:approval-approve') && round === 1) return reply('', [{ id: 'delete', type: 'function', function: { name: 'delete_file', arguments: JSON.stringify({ path: 'approval-fixture.txt' }) } }]);
    if (task.startsWith('spec:approval-fail')) throw new Error('fixture child model failure');
    if (task.startsWith('spec:approval-approve')) assert.ok(input.messages.some(message => message.role === 'tool' && String(message.content).includes('denied')));
    return reply('settled');
  });
  try {
    const root = await f.create(); await f.api('/v1/office/settings', { user_context: 'user:integration', concurrency: 1 });
    await f.send(root.id, 'spec:approval-root');
    const before = await until(() => f.office(root.id), value => value.employees.some(row => row.label.includes('approval-ok') && row.status === 'completed') && value.employees.some(row => row.status === 'failed') && value.employees.some(row => row.label.includes('approval-approve') && row.status === 'waiting'));
    const approver = before.employees.find(row => row.label.includes('approval-approve')); assert.equal(approver.status, 'waiting');
    const rootHistory = await f.api(`/v1/sessions/${root.id}`);
    const forwarded = rootHistory.events.find(event => event.event === 'office/child-event' && event.payload.event === 'approval.required');
    assert.equal(forwarded.payload.child_id, approver.child_id); assert.equal(rootHistory.status, 'running');
    await f.api(`/v1/sessions/${approver.child_id}/approvals`, { approval_id: forwarded.payload.payload.id, decision: 'deny' });
    assert.equal((await f.done(root.id)).status, 'completed');
    assert.equal((await f.office(root.id)).employees.filter(row => row.status === 'failed').length, 1);
  } finally { await f.close(); }
});

test('restart repairs a missing catalog mirror without starting work, and interrupted children do not execute again', { timeout: 30000 }, async () => {
  let release, childCalls = 0; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async (task, round) => {
    if (task === 'spec:restart-root' && round === 1) return reply('', [delegate('child', 'spec:restart-child', 'Durable employee')]);
    if (task.startsWith('spec:restart-child')) { childCalls++; await gate; }
    return reply('done');
  });
  try {
    const root = await f.create(); await f.send(root.id, 'spec:restart-root');
    await until(() => f.office(root.id), snapshot => snapshot.employees.length === 1 && snapshot.employees[0].status === 'running');
    await until(async () => childCalls, value => value === 1);
    await until(() => f.api(`/v1/sessions/${root.id}`), history => history.events.some(event => event.event === 'tool.completed' && event.payload.name === 'subagent'));
    await f.restart(async data => {
      const file = join(data, 'sessions', root.id + '.jsonl');
      const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse).filter(event => event.event !== 'subagent/catalog');
      await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
    });
    const restored = await f.office(root.id);
    assert.equal(restored.employees.length, 1); assert.equal(restored.employees[0].label, 'Durable employee');
    assert.equal(restored.employees[0].status, 'failed'); assert.equal(childCalls, 1);
    await sleep(80); assert.equal(childCalls, 1);
    release(); await f.send(root.id, 'spec:restart-continue'); assert.equal((await f.done(root.id)).status, 'completed'); assert.equal(childCalls, 1);
  } finally { release(); await f.close(); }
});
