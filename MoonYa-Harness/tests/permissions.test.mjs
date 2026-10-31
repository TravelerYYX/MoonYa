import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathIsInside, toolPermission, toolGrant, normalizeApprovalMode } from '../src/permissions.mjs';
import { resolvePathArguments, executeTool } from '../src/tools.mjs';
import { reviewPermission } from '../src/permission-review.mjs';
import { SessionStore } from '../src/session-store.mjs';

test('permission paths handle case, traversal, sibling prefixes and junction targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moonya-permission-path-'));
  const workspace = join(dir, 'project'), outside = join(dir, 'outside');
  try {
    await mkdir(workspace); await mkdir(outside);
    await symlink(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await pathIsInside(workspace, join(workspace, 'new.txt')), true);
    assert.equal(await pathIsInside(workspace, join(dir, 'project-other', 'new.txt')), false);
    assert.equal(await pathIsInside(workspace, '../outside/new.txt'), false);
    assert.equal(await pathIsInside(workspace, 'link/new/sub/file.txt'), false);
    assert.equal(await pathIsInside('D:\\Project', 'd:\\project\\new.txt'), true);
    assert.equal(await pathIsInside('D:\\Project', 'D:\\Project-other\\new.txt'), false);
  assert.equal(resolvePathArguments('execute_command', { cwd: '..' }, workspace).cwd, dir);
    assert.equal(resolvePathArguments('grep', { pattern: 'hello' }, workspace).path, workspace);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('routine workspace operations are allowed; external edits, network, destructive and opaque calls require approval', async () => {
  const workspace = 'D:\\Work';
  const classify = (name, args, preflight) => toolPermission(name, resolvePathArguments(name, args, workspace), workspace, preflight);
  for (const [name,args] of [['create_file',{path:'a.txt'}],['edit_file',{command:'insert',path:'a.txt'}],['read_file',{path:'E:\\Other\\a.txt'}]]) {
    assert.equal((await classify(name,args)).required,false);
  }
  for (const [name,args] of [['create_file',{path:'..\\a.txt'}],['delete_file',{path:'a.txt'}],['web_search',{query:'news'}],['web_fetch',{url:'https://example.com'}],['computer_use_tool',{code:'print(1)'}],['browser_automation_control',{action:'navigate'}]]) {
    assert.equal((await classify(name,args)).required,true);
  }
  assert.equal((await classify('execute_command',{command:'Get-Date'},{effect:'read',riskLevel:'low'})).required,false);
  assert.equal((await classify('execute_command',{command:'Get-Date',cwd:'E:\\Other'},{effect:'read',riskLevel:'low'})).required,true);
  assert.equal((await classify('execute_command',{command:'npm run build'},{effect:'unknown',riskLevel:'high'})).required,true);
  assert.equal((await classify('read_file',{path:'\\\\server\\share\\file.txt'})).required,true);
  assert.equal((await classify('browser_automation_control',{action:'inspect'})).required,false);
  assert.equal((await classify('browser_automation_control',{action:'screenshot',save_screenshot_to:'..\\outside.png'})).required,true);
  assert.equal(normalizeApprovalMode(), 'confirm_writes');
  assert.equal(normalizeApprovalMode('high_risk_only'), 'high_risk');
  assert.throws(() => normalizeApprovalMode('bogus'), /invalid_approval_mode/);
});

test('a grant is bound to exact tool arguments and cannot permit another external operation', async () => {
  const args = { path: 'E:\\Other\\a.txt', content: 'first' };
  const context = { session: {}, workspace: 'D:\\Work', localServiceUrl: 'http://127.0.0.1:1', permissionGrant: toolGrant('create_file',args) };
  await assert.rejects(executeTool('create_file',{...args,content:'changed'},context),/outside/);
  await assert.rejects(executeTool('delete_file',{path:args.path},context),/outside/);
});

test('independent review excludes credentials/reasoning, has no tools and handles approval, denial, malformed results and failure', async () => {
  let answer = '{"decision":"allow","reason":"用户明确要求"}';
  const opts = { model:{name:'fixture',api_key:'private-model-key'}, userRequest:'write file',
    evidence:[{password:'secret',reasoning_content:'hidden',output:'Bearer token123'}],
    operation:{name:'execute_command',arguments:{command:'echo private-model-key'}},
    request:async (_model,messages,_effort,_signal,_delta,options) => {
      assert.deepEqual(options.tools,[]);
      const body=JSON.stringify(messages);
      for(const secret of ['private-model-key','hidden','token123','"secret"']) assert.ok(!body.includes(secret));
      return {content:answer};
    } };
  assert.equal((await reviewPermission(opts)).decision,'allow');
  answer='{"decision":"deny","reason":"未经授权的删除"}';
  assert.equal((await reviewPermission(opts)).decision,'deny');
  answer='invalid'; assert.equal((await reviewPermission(opts)).decision,'manual');
  assert.equal((await reviewPermission({...opts,request:async()=>{throw new Error('timeout');}})).decision,'manual');
  let timedOut = false;
  assert.equal((await reviewPermission({...opts,timeoutMs:5,request:async(_model,_messages,_effort,signal)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('mock provider delayed')),100);
    signal.addEventListener('abort',()=>{timedOut=true;clearTimeout(timer);reject(signal.reason);},{once:true});
  })})).decision,'manual');
  assert.equal(timedOut,true);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await assert.rejects(reviewPermission({...opts,signal:controller.signal,request:async()=>{throw new Error('aborted');}}),/cancelled/);
});

test('chat permission changes are durable and serialized while child sessions retain root ownership', async () => {
  const dir=await mkdtemp(join(tmpdir(),'moonya-permission-store-'));
  try {
    const store=new SessionStore(dir); await store.initialize();
    const root=await store.create({workspace:'D:\\Work',userContext:'user:1',clientChatId:'chat'});
    assert.equal(root.approvalMode,'confirm_writes');
    await Promise.all([store.setPermissions(root,'full_access'),store.setPermissions(root,'confirm_writes'),store.setPermissions(root,'high_risk')]);
    const child=await store.create({parentSessionId:root.id,rootSessionId:root.id,workspace:root.workspace,userContext:root.userContext});
    const restored=new SessionStore(dir);await restored.initialize();
    assert.equal(restored.summary(restored.get(root.id)).approval_mode,'high_risk');
    assert.equal(restored.get(root.id).clientChatId,'chat');
    assert.equal(restored.get(child.id).rootSessionId,root.id);
  } finally {await rm(dir,{recursive:true,force:true});}
});
