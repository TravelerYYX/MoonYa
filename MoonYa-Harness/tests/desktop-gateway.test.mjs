import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleDesktopRequest, assertDesktopScope, presentationEvents, userContent, readSkills } from '../src/desktop-gateway.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { openaiPayload } from '../src/model-client.mjs';

async function fixture(handler) {
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
async function gateway(runtime,extra={}) {return fixture((req,res)=>handleDesktopRequest(req,res,{runtimeUrl:runtime,secret:'internal-secret',...extra}));}
const headers={'X-MoonYa-Desktop-Secret':'internal-secret','X-MoonYa-User':'1','Content-Type':'application/json'};
const json=(res,data)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
const frames=res=>res.text().then(body=>body.split('\n\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))));

test('desktop synchronizes custom skills for custom models, uses cache and rejects unsynced choices before admission',async()=>{
  const cacheRoot=await mkdtemp(join(tmpdir(),'moonya-gateway-skills-'));
  const defaults=JSON.parse(await readFile(new URL('../../MoonYa-Frontend/src/defaults.json',import.meta.url),'utf8'));
  let version='MAIN-FIRST',offline=false,expired=false;const submissions=[];
  const service=await fixture((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer internal-secret');
    if(expired){res.statusCode=401;return json(res,{success:false});}
    if(offline){res.statusCode=503;return json(res,{success:false});}
    json(res,{success:true,data:{version:1,skills:[{name:'writing-helper',description:'写作',body:version,resources:{'nested/guide.md':'REFERENCE-UNIQUE'}}]}});
  });
  const runtime=await fixture(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url==='/v1/sessions')return json(res,{id:'skills-session'});
    if(req.url.endsWith('/messages')){submissions.push(JSON.parse(Buffer.concat(chunks)));return json(res,{after_seq:0});}
    res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({event:'turn.completed',seq:1,payload:{}})+'\n\n');
  });
  const host=await gateway(runtime.url,{defaults,skillSync:{backend:'https://skill-server.example',frontend:service.url,cacheRoot}});
  function fetchResponse(selected){return fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify({message:'work',model_ref:'custom-model',selected_skills:selected})});}
  try {
    const list=await(await fetch(host.url+'/v1/desktop/api/skills.php',{headers})).json();
    assert.equal(list.data.skills[0].name,'writing-helper');assert.equal(list.data.skills[0].body,undefined);
    let events=await frames(await fetchResponse(['writing-helper']));
    assert.equal(events[0].type,'skill_sync');assert.equal(events[0].source,'server');assert.equal(events.at(-1).type,'done');
    assert.equal(submissions[0].skills[0].body,'MAIN-FIRST');assert.equal(submissions[0].skills[0].resources['nested/guide.md'],'REFERENCE-UNIQUE');
    version='MAIN-SECOND';await frames(await fetchResponse(['writing-helper']));
    assert.equal(submissions[1].skills[0].body,'MAIN-SECOND');assert.equal(submissions[0].skills[0].body,'MAIN-FIRST');
    offline=true;events=await frames(await fetchResponse(['writing-helper']));assert.equal(events[0].source,'cache');
    assert.equal(submissions[2].skills[0].body,'MAIN-SECOND');
    events=await frames(await fetchResponse(['never-synced']));assert.equal(events[0].error_code,'skill_unavailable');assert.match(events[0].content,/尚未同步/);assert.equal(submissions.length,3);
    expired=true;events=await frames(await fetchResponse(['writing-helper']));assert.equal(events[0].error_code,'AUTH_REQUIRED');assert.equal(submissions.length,3);
  }finally{await host.close();await runtime.close();await service.close();await rm(cacheRoot,{recursive:true,force:true});}
});

test('versioned Work admission preserves all configured tiers and rejects stale choices before submission',async()=>{
  const defaults=JSON.parse(await readFile(new URL('../../MoonYa-Frontend/src/defaults.json',import.meta.url),'utf8'));
  const caps=defaults.modelCapabilities['deepseek-flash'];
  Object.assign(caps,{reasoning:'openai',supports_thinking:true,efforts:['medium','xhigh','ultra'],default_effort:'medium'});
  const submissions=[];
  const runtime=await fixture(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url==='/v1/sessions')return json(res,{id:'exact'});
    if(req.url.endsWith('/messages')){submissions.push(JSON.parse(Buffer.concat(chunks)));return json(res,{accepted:true,after_seq:0});}
    res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({event:'turn.completed',seq:1,payload:{}})+'\n\n');
  });
  const host=await gateway(runtime.url,{defaults,skills:[]});
  try {
    for(const effort of ['medium','xhigh','ultra']) {
      const events=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify({message:'work',client_chat_id:'exact',client_message_id:effort,reasoningProfileVersion:2,reasoningProfile:effort,reasoningEffort:effort})}));
      assert.equal(events.at(-1).type,'done');assert.equal(submissions.at(-1).reasoning_effort,effort);
      assert.equal(submissions.at(-1).model.default_effort,'medium');
    }
    const events=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify({message:'work',reasoningProfileVersion:2,reasoningEffort:'high'})}));
    assert.match(events[0].content,/不支持/);assert.equal(submissions.length,3);
    Object.assign(caps,{efforts:[],default_effort:'auto'});
    const binary=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify({message:'work',client_message_id:'binary',reasoningProfileVersion:2,reasoningProfile:'auto',reasoningEffort:'auto',reasoning_default:'auto'})}));
    assert.equal(binary.at(-1).type,'done');
    const input=submissions.at(-1);
    assert.equal(openaiPayload(input.model,[],input.reasoning_effort,{defaultEffort:input.reasoning_default}).reasoning_effort,undefined);
  } finally {await host.close();await runtime.close();}
});

test('desktop scope verifies both account and workspace; child terminal does not complete its parent',()=>{
  assertDesktopScope({user_context:'user:1',workspace_identity:'C:\\Work\\'},1,'c:\\work');
  assert.throws(()=>assertDesktopScope({user_context:'user:2',workspace_identity:'__default__'},1),/不属于/);
  assert.throws(()=>assertDesktopScope({user_context:'user:1',workspace_identity:'C:\\Work'},1,'C:\\Other'),/目录/);
  const child=presentationEvents({event:'office/child-event',seq:3,payload:{child_id:'child',event:'turn.completed',payload:{content:'child answer'}}},'root');
  assert.equal(child.length,1);assert.equal(child[0].run_id,'child');assert.equal(child[0].root_run_id,'root');
  assert.equal(presentationEvents({event:'turn.completed',seq:4,payload:{}},'root').at(-1).type,'done');
});

test('desktop API requires native secret and verified identity, and rejects another user before mutation',async()=>{
  const calls=[];
  const runtime=await fixture((req,res)=>{calls.push(req.url);json(res,{user_context:'user:2',workspace_identity:'__default__'});});
  const host=await gateway(runtime.url);
  try {
    assert.equal((await fetch(host.url+'/v1/desktop/model_api.php')).status,403);
    assert.equal((await fetch(host.url+'/v1/desktop/model_api.php',{headers:{...headers,'X-MoonYa-User':'0'}})).status,401);
    assert.equal((await fetch(host.url+'/v1/desktop/harness_api.php?action=cancel',{method:'POST',headers,body:JSON.stringify({session_id:'other'})})).status,403);
    assert.deepEqual(calls,['/v1/sessions/other']);
  } finally {await host.close();await runtime.close();}
});

test('accepted Work resume reads events only, even if original files are gone; cursor is preserved',async()=>{
  const calls=[];
  const runtime=await fixture((req,res)=>{
    calls.push({url:req.url,method:req.method});
    if(req.url.includes('/events')) {res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({event:'turn.completed',seq:9,payload:{}})+'\n\n');}
    else json(res,{user_context:'user:1',workspace_identity:'__default__',status:'completed',events:[{event:'desktop.message.accepted',seq:4,payload:{client_message_id:'message'}},{event:'turn.completed',seq:9,payload:{}}]});
  });
  const host=await gateway(runtime.url);
  try {
    const body={harness_session_id:'root',client_message_id:'message',resume:{turn_started:0,after_seq:7},local_paths:[{path:'C:\\missing.png',kind:'file'}]};
    const events=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.equal(events.at(-1).type,'done');assert.deepEqual(calls,[{url:'/v1/sessions/root',method:'GET'},{url:'/v1/sessions/root/events?after=7',method:'GET'}]);
    calls.length=0;body.client_message_id='unaccepted';
    const failed=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.equal(failed[0].error_code,'message_not_accepted');assert.equal(failed[0].recoverable,false);assert.equal(calls.length,1);
    body.resume.turn_started=1;
    const forged=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.equal(forged[0].error_code,'message_not_accepted');
  } finally {await host.close();await runtime.close();}
});

test('Work admission sends a server proxy and ephemeral gateway credential, never a supplier key',async()=>{
  const calls=[];const defaults=JSON.parse(await readFile(new URL('../../MoonYa-Frontend/src/defaults.json',import.meta.url),'utf8'));
  const runtime=await fixture(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();calls.push({url:req.url,body});
    if(req.url==='/v1/sessions')return json(res,{id:'root'});
    if(req.url.endsWith('/messages'))return json(res,{accepted:true,after_seq:0});
    res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({event:'turn.completed',seq:3,payload:{}})+'\n\n');
  });
  const host=await gateway(runtime.url,{defaults,skills:[]});const previous=process.env.MOONYA_FRONTEND_URL;process.env.MOONYA_FRONTEND_URL='http://127.0.0.1:58908';
  try {
    const events=await frames(await fetch(host.url+'/v1/desktop/harness_api.php',{method:'POST',headers,body:JSON.stringify({message:'work',client_chat_id:'chat',client_message_id:'task',reasoningProfile:'high',approval_mode:'high_risk_only'})}));
    assert.equal(events.at(-1).type,'done');
    const payload=JSON.parse(calls.find(c=>c.url.endsWith('/messages')).body);
    assert.equal(payload.model.base_url,'http://127.0.0.1:58908/gateway/model/1');assert.equal(payload.model.api_key,'internal-secret');
    assert.equal(payload.user_context,'user:1');assert.equal(payload.client_message_id,'task');
    assert.equal(payload.approval_mode,'high_risk');
    assert.equal(JSON.parse(calls.find(c=>c.url==='/v1/sessions').body).approval_mode,'high_risk');
  } finally {if(previous===undefined)delete process.env.MOONYA_FRONTEND_URL;else process.env.MOONYA_FRONTEND_URL=previous;await host.close();await runtime.close();}
});

test('permission update authenticates chat ownership and forwards only a validated root mode',async()=>{
  let snapshot={id:'root',user_context:'user:1',client_chat_id:'chat',workspace_identity:'__default__'};
  const mutations=[];
  const runtime=await fixture(async(req,res)=>{
    if(req.method==='GET')return json(res,snapshot);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    mutations.push({url:req.url,input:JSON.parse(Buffer.concat(chunks))});json(res,{success:true,approval_mode:'full_access'});
  });
  const host=await gateway(runtime.url);
  const update=body=>fetch(host.url+'/v1/desktop/harness_api.php?action=permissions',{method:'POST',headers,body:JSON.stringify({session_id:'root',client_chat_id:'chat',approval_mode:'full_access',...body})});
  try{
    assert.equal((await update({client_chat_id:'other'})).status,403);
    snapshot.user_context='user:2';assert.equal((await update({})).status,403);
    snapshot.user_context='user:1';snapshot.parent_session_id='parent';assert.equal((await update({})).status,403);
    delete snapshot.parent_session_id;assert.equal((await update({approval_mode:'invalid'})).status,400);
    assert.equal(mutations.length,0);
    assert.equal((await update({})).status,200);
    assert.deepEqual(mutations,[{url:'/v1/sessions/root/permissions',input:{user_context:'user:1',client_chat_id:'chat',approval_mode:'full_access'}}]);
  }finally{await host.close();await runtime.close();}
});

test('attachments are read on this machine; content types are checked; packaged skills retain resources',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moonya-gateway-'));const image=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(image);image.writeUInt32BE(100,16);image.writeUInt32BE(200,20);
  const path=join(dir,'input.png');await writeFile(path,image);
  const parts=await userContent({message:'read',local_paths:[{path,kind:'file'}]},'low');
  assert.equal(parts[0].image_url.detail,'low');assert.ok(parts[0].image_url.url.endsWith(image.toString('base64')));
  await assert.rejects(userContent({local_attachments:[{category:'image',name:'fake.png',data_url:'data:image/png;base64,YmFk'}]}),/不受支持/);
  const skills=await readSkills(new URL('../../MoonYa-Backend/skills',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
  assert.equal(skills.length,2);assert.ok(skills.every(skill=>skill.raw.includes('---')&&skill.body.length>100));
});

test('restart after durable admission never replays the unstarted action',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moonya-admission-'));const store=new SessionStore(dir);await store.initialize();
  const session=await store.create({userContext:'user:1',workspaceIdentity:'__default__'});
  await store.append(session,'desktop.message.accepted',{client_message_id:'task',after_seq:1},{turn:1,status:'accepted'});
  const restored=new SessionStore(dir);await restored.initialize();
  const snapshot=restored.get(session.id);assert.equal(snapshot.status,'interrupted');assert.equal(snapshot.events.at(-1).event,'turn.interrupted');
});

test('custom model mixed reasoning/content chunks keep distinct UI cursors and resume a partially read chunk',async()=>{
  const requests=[];
  const runtime=await fixture(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('Content-Type','text/event-stream');
    res.end('data: '+JSON.stringify({moonya_seq:2,choices:[{delta:{reasoning_content:'think',content:'answer'}}]})+'\n\ndata: '+JSON.stringify({moonya_seq:3,moonya_done:true})+'\n\n');
  });
  const host=await gateway(runtime.url);
  try {
    const body={model_ref:{provider_id:'p',model_id:'m'},client_chat_id:'chat',client_message_id:'task',resume:{after_seq:4}};
    const events=await frames(await fetch(host.url+'/v1/desktop/api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.deepEqual(events.map(event=>[event.type,event.model_seq]),[['thinking',4],['content',5],['done',undefined]]);
    assert.equal(requests[0].after_seq,1);body.resume.after_seq=5;
    await frames(await fetch(host.url+'/v1/desktop/api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.equal(requests[1].after_seq,2);
  } finally {await host.close();await runtime.close();}
});
