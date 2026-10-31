import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function listen(handler) {
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
async function wait(read, predicate) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}
  throw new Error('permission state not observed');
}
async function fixture() {
  const data=await mkdtemp(join(tmpdir(),'moonya-permission-runtime-')); const workspace=join(data,'project');await mkdir(workspace);
  let calls=[], review='allow', scripts=[], childScripts=[], browserHandler=null;
  const host=await listen(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());calls.push(input);
    res.setHeader('content-type','application/json');
    if (req.url.startsWith('/browser/') && browserHandler) { res.end(JSON.stringify(await browserHandler(req.url, input))); return; }
    if(input.action==='validate_command') res.end(JSON.stringify({valid:input.command!=='invalid',status:input.command==='invalid'?'error':'success',effect:'unknown',riskLevel:'high'}));
    else if(req.url==='/browser/authorize')res.end(JSON.stringify({success:true,approval_token:'single-operation-receipt'}));
    else if(req.url==='/browser/execute')res.end(JSON.stringify(input.approval_token==='single-operation-receipt'
      ? {success:true,action:input.action,page_url:input.url}
      : {success:false,approval_required:true,approval_kind:'site',approval_token:'host-private-token',url:input.url,domain:'example.test',action:input.action,page_version:1,expires_at:new Date(Date.now()+60000).toISOString(),browser:{session_id:'browser'}}));
    else res.end(JSON.stringify({success:true,status:'success',output:'executed'}));
  });
  const model=await listen(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type','application/json');
    if(!input.tools){res.end(JSON.stringify({choices:[{message:{role:'assistant',content:review==='bad'?'bad':JSON.stringify({decision:review,reason:'审核理由'})}}]}));return;}
    const queue=input.messages.some(message=>message.role==='user'&&String(message.content).includes('spec:permissions-child'))?childScripts:scripts;
    const script=queue.shift();
    res.end(JSON.stringify({choices:[{message:script?{role:'assistant',content:'',tool_calls:[{id:'call-'+Math.random(),type:'function',function:{name:script[0],arguments:JSON.stringify(script[1])}}]}:{role:'assistant',content:'completed'}}]}));
  });
  const port=await listen((req,res)=>res.end());const runtimeUrl=port.url;await port.close();
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,
    env:{...process.env,MOONYA_HARNESS_PORT:new URL(runtimeUrl).port,MOONYA_HARNESS_DATA:join(data,'runtime'),MOONYA_DATA_ROOT:data,
      MOONYA_LOCAL_SERVICE_URL:host.url,MOONYA_SEARCH_SERVICE_URL:host.url,MOONYA_BROWSER_SERVICE_URL:host.url,MOONYA_BROWSER_TIMEOUT_MS:'5000'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
  const request=async(path,input)=>{
    const response=await fetch(runtimeUrl+path,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
    return {status:response.status,...await response.json()};
  };
  try{await wait(()=>request('/health').catch(()=>({})),result=>result.status==='ok');}catch(error){child.kill();throw new Error(error.message+stderr);}
  const create=(chat='chat',mode='confirm_writes',project=workspace)=>request('/v1/sessions',{workspace:project,client_chat_id:chat,user_context:'user:1',approval_mode:mode});
  const send=async(session,mode,operations)=>{
    scripts=[...operations];return request('/v1/sessions/'+session.id+'/messages',{content:'请执行这些有限范围的操作',client_chat_id:session.client_chat_id,user_context:'user:1',approval_mode:mode,
      model:{base_url:model.url,name:'fixture',api_key:'private-model-key',context_window:32768,max_output_tokens:4096,protocol:'openai-chat-completions',supports_thinking:false}});
  };
  const snapshot=session=>request('/v1/sessions/'+session.id);
  return {request,create,send,snapshot,workspace,data,calls,setBrowserHandler:value=>{browserHandler=value;},setReview:value=>{review=value;},setChildOperations:value=>{childScripts=[...value];},
    stop:async()=>{await new Promise(resolve=>{child.once('exit',resolve);child.kill();});await host.close();await model.close();await rm(data,{recursive:true,force:true});}};
}

test('manual approval blocks external effects, mode changes preserve pending cards and apply to the next operation', {timeout:20000},async()=>{
  const f=await fixture();try{
    const session=await f.create();const other=await f.create('other');const sibling=await f.create('chat');
    assert.equal((await f.request('/v1/sessions/'+session.id+'/permissions',{user_context:'user:2',client_chat_id:'chat',approval_mode:'full_access'})).status,403);
    assert.equal((await f.request('/v1/sessions/'+session.id+'/permissions',{user_context:'user:1',client_chat_id:'wrong',approval_mode:'full_access'})).status,403);
    await f.send(session,'confirm_writes',[['create_file',{path:'inside.txt',content:'a'}],['create_file',{path:join(f.data,'external.txt'),content:'b'}],['delete_file',{path:'inside.txt'}]]);
    const pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.event==='approval.required'));
    assert.equal(f.calls.filter(c=>c.action==='create_file').length,1);
    const approval=pending.events.find(e=>e.event==='approval.required').payload.id;
    assert.equal((await f.request('/v1/sessions/'+session.id+'/permissions',{user_context:'user:1',client_chat_id:'chat',approval_mode:'full_access'})).approval_mode,'full_access');
    assert.equal((await f.snapshot(sibling)).approval_mode,'full_access');
    assert.equal((await f.snapshot(other)).approval_mode,'confirm_writes');
    assert.equal(f.calls.filter(c=>c.action==='create_file').length,1,'changing mode does not resolve an existing approval');
    await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:approval,decision:'allow_once'});
    const done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
    assert.equal(done.events.filter(e=>e.event==='approval.required').length,1);
    assert.equal(f.calls.filter(c=>c.action==='create_file').length,2);
    assert.equal(f.calls.filter(c=>c.action==='delete_file').length,1);
    assert.equal((await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:approval,decision:'allow_once'})).status,404);
  }finally{await f.stop();}
});

test('auto review allows or denies the exact call, malformed review falls back to manual, full access still validates syntax', {timeout:20000},async()=>{
  const f=await fixture();try{
    const session=await f.create();
    await f.send(session,'high_risk',[['execute_command',{command:'Write-Output hello'}]]);
    let done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
    assert.equal(done.events.findLast(e=>e.event==='permission.reviewed').payload.decision,'allow');
    assert.equal(f.calls.find(c=>c.action==='execute_command').approval_granted,true);
    assert.equal(done.events.filter(e=>e.event==='approval.required').length,0);
    f.setReview('deny');
    await f.send(session,'high_risk',[['delete_file',{path:'file.txt'}],['execute_command',{command:'alternative-delete'}]]);
    done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
    assert.equal(f.calls.filter(c=>c.action==='delete_file').length,0);
    assert.match(done.events.findLast(e=>e.event==='tool.failed').payload.result.error,/自动审核拒绝/);
    assert.equal(f.calls.filter(c=>c.action==='execute_command'&&c.command==='alternative-delete').length,0);
    assert.equal(done.events.filter(e=>e.turn===done.turn&&e.event==='permission.reviewed').length,1,'denial does not trigger another automatic review');
    f.setReview('bad');
    await f.send(session,'high_risk',[['web_search',{query:'example'}]]);
    const pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.turn===s.turn&&e.event==='approval.required'));
    assert.equal(f.calls.filter(c=>c.action==='web_search').length,0);
    await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:pending.events.findLast(e=>e.event==='approval.required').payload.id,decision:'deny'});
    await wait(()=>f.snapshot(session),s=>s.status==='completed');
    await f.send(session,'full_access',[['web_fetch',{url:'https://example.test'}],['create_file',{path:3,content:'invalid'}],['execute_command',{command:'invalid'}],['execute_command',{command:'valid'}]]);
    done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
    assert.equal(f.calls.filter(c=>c.action==='web_fetch').length,1);
    assert.equal(f.calls.filter(c=>c.action==='create_file').length,0,'full access still validates tool parameters');
    assert.equal(f.calls.filter(c=>c.action==='execute_command'&&c.command==='invalid').length,0);
    assert.equal(f.calls.find(c=>c.action==='execute_command'&&c.command==='valid').approval_granted,true);
    assert.equal(done.events.filter(e=>e.turn===done.turn&&e.event==='approval.required').length,0);
  }finally{await f.stop();}
});

test('browser navigation requires approval before contacting the browser; denying and cancelling have no effects', {timeout:20000},async()=>{
  const f=await fixture();try{
    const session=await f.create();
    await f.send(session,'confirm_writes',[['browser_automation_control',{action:'navigate',url:'https://example.test'}]]);
    let pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.event==='approval.required'));
    assert.equal(f.calls.length,0);
    await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:pending.events.findLast(e=>e.event==='approval.required').payload.id,decision:'deny'});
    await wait(()=>f.snapshot(session),s=>s.status==='completed');assert.equal(f.calls.length,0);
    await f.send(session,'confirm_writes',[['delete_file',{path:'file.txt'}]]);
    pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.turn===s.turn&&e.event==='approval.required'));
    await f.request('/v1/sessions/'+session.id+'/cancel',{});
    await wait(()=>f.snapshot(session),s=>s.status==='cancelled');assert.equal(f.calls.length,0);
  }finally{await f.stop();}
});

test('a running child reads the root mode on every operation while an existing approval remains pending', {timeout:20000},async()=>{
  const f=await fixture();try{
    const root=await f.create();const other=await f.create('unrelated');
    f.setChildOperations([['delete_file',{path:'first.txt'}],['delete_file',{path:'second.txt'}]]);
    await f.send(root,'confirm_writes',[['subagent',{prompt:'spec:permissions-child',description:'权限继承测试'}]]);
    const pending=await wait(()=>f.snapshot(root),s=>s.events.some(e=>e.event==='office/child-event'&&e.payload.event==='approval.required'));
    const forwarded=pending.events.find(e=>e.event==='office/child-event'&&e.payload.event==='approval.required').payload;
    const child={id:forwarded.child_id};
    assert.equal((await f.snapshot(child)).approval_mode,'confirm_writes');
    assert.equal((await f.request('/v1/sessions/'+child.id+'/permissions',{user_context:'user:1',client_chat_id:'chat',approval_mode:'full_access'})).status,403);
    await f.request('/v1/sessions/'+root.id+'/permissions',{user_context:'user:1',client_chat_id:'chat',approval_mode:'full_access'});
    assert.equal((await f.snapshot(child)).approval_mode,'full_access');
    assert.equal((await f.snapshot(other)).approval_mode,'confirm_writes');
    assert.equal(f.calls.filter(c=>c.action==='delete_file').length,0);
    await f.request('/v1/sessions/'+child.id+'/approvals',{approval_id:forwarded.payload.id,decision:'deny'});
    await wait(()=>f.snapshot(root),s=>s.status==='completed');
    assert.deepEqual(f.calls.filter(c=>c.action==='delete_file').map(c=>c.path),[join(f.workspace,'second.txt')]);
    assert.equal((await f.snapshot(child)).events.filter(e=>e.event==='approval.required').length,1);
  }finally{await f.stop();}
});

test('browser site challenges reuse the exact navigation permission without duplicate cards in all three modes', {timeout:20000},async()=>{
  const f=await fixture();try{
    const session=await f.create();
    for(const mode of ['confirm_writes','high_risk','full_access']){
      const before=f.calls.length;
      await f.send(session,mode,[['browser_automation_control',{action:'navigate',url:'https://example.test'}]]);
      if(mode==='confirm_writes'){
        const pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.turn===s.turn&&e.event==='approval.required'));
        assert.equal(f.calls.length,before);
        await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:pending.events.findLast(e=>e.event==='approval.required').payload.id,decision:'allow_once'});
      }
      const done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
      assert.equal(done.events.filter(e=>e.turn===done.turn&&e.event==='approval.required').length,mode==='confirm_writes'?1:0);
      assert.equal(done.events.filter(e=>e.turn===done.turn&&e.event==='tool.completed').length,1);
      assert.equal(f.calls.slice(before).filter(call=>call.approval_token==='single-operation-receipt').length,1);
      assert.equal(done.events.filter(e=>e.turn===done.turn&&e.event==='permission.reviewed').length,mode==='high_risk'?1:0);
    }
  }finally{await f.stop();}
});


test('cold browser approval works with and without a project and preserves the selected backend', {timeout:20000}, async()=>{
  const f=await fixture();
  try {
    for (const project of ['', f.workspace]) for (const browser of ['builtin', 'chrome', 'edge']) {
      let trusted=false; const identity='cold-'+browser;
      f.setBrowserHandler((route,input)=>{
        assert.equal(input.browser || 'builtin',browser);
        if (route==='/browser/authorize') {
          assert.equal(input.session_id,identity); assert.equal(input.action,'navigate'); assert.equal(input.user_context,'user:1');
          trusted=true;return {success:true};
        }
        return trusted ? {success:true,browser:{session_id:identity,mode:browser},page_url:input.url}
          : {success:false,approval_required:true,approval_token:'cold-token',approval_kind:'site',url:input.url,domain:'example.test',action:input.action,
            page_version:0,expires_at:new Date(Date.now()+60000).toISOString(),browser:{session_id:identity}};
      });
      const session=await f.create('cold-'+browser+'-'+!!project,'confirm_writes',project);
      await f.send(session,'confirm_writes',[['browser_automation_control',{action:'navigate',browser,url:'https://example.test'}]]);
      const pending=await wait(()=>f.snapshot(session),s=>s.events.some(e=>e.event==='approval.required'));
      await f.request('/v1/sessions/'+session.id+'/approvals',{approval_id:pending.events.findLast(e=>e.event==='approval.required').payload.id,decision:'allow_once'});
      const done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
      assert.equal(done.workspace_identity, project || '__default__');
      assert.equal(done.events.filter(e=>e.event==='approval.required').length,1);
      assert.equal(done.events.findLast(e=>e.event==='tool.completed').payload.result.browser.mode,browser);
    }
  }finally{await f.stop();}
});

test('malformed and repeated browser challenges terminate without an approval loop', {timeout:20000},async()=>{
  const f=await fixture();
  try {
    for (const malformed of [true,false]) {
      f.setBrowserHandler((route,input)=>route==='/browser/authorize'?{success:true}:
        {success:false,approval_required:true,approval_token:'token',approval_kind:'site',url:input.url,domain:'example.test',action:input.action,
          page_version:0,expires_at:new Date(Date.now()+60000).toISOString(),browser:{session_id:malformed?'':'cold-session'}});
      const session=await f.create('challenge-'+malformed,'full_access','');
      await f.send(session,'full_access',[['browser_automation_control',{action:'navigate',url:'https://example.test'}]]);
      const done=await wait(()=>f.snapshot(session),s=>s.status==='completed');
      assert.equal(done.events.findLast(e=>e.event==='tool.failed').payload.result.error_code,'invalid_approval_challenge');
      assert.equal(done.events.filter(e=>e.event==='approval.required').length,0);
    }
  }finally{await f.stop();}
});
