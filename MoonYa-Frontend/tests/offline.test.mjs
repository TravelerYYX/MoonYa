import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
async function nativeHost(backend, runtime, port, existingData) {
  const data=existingData||await mkdtemp(join(tmpdir(),'moonya-frontend-'));
  const exe=join(root,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll');
  const child=spawn('dotnet',[exe,join(root,'MoonYa-Frontend/dist'),backend,runtime,...(port?[String(port)]:[])],{env:{...process.env,MOONYA_SMOKE_DATA:data},windowsHide:true});
  let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const info=await new Promise((resolve,reject)=>{
    const lines=createInterface({input:child.stdout});lines.once('line',line=>resolve(JSON.parse(line)));
    child.once('exit',code=>reject(new Error('Native host failed ('+code+'): '+errors)));
  });
  return {...info,data,stop:()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('\n');})};
}
async function backendFixture() {
  const requests=[];let configuration;
  const server=createServer(async(req,res)=>{
    const body=[];for await(const chunk of req)body.push(chunk);
    requests.push({url:req.url,headers:req.headers,body:Buffer.concat(body).toString()});
    res.setHeader('content-type','application/json');
    if(req.url.includes('check_session')) return res.end(JSON.stringify({success:true,data:{logged_in:req.headers.authorization==='Bearer u1',user:{id:1,username:'fixture'}}}));
    if(req.url.includes('login'))return res.end(JSON.stringify({success:true,data:{token:'u1',expires_in:1296000,user:{id:1,username:'fixture'}}}));
    if(req.url.includes('client_config.php'))return res.end(JSON.stringify({success:true,data:configuration||{}}));
    if(req.url.includes('admin/api/updates.php'))return res.end(JSON.stringify({success:true,data:null}));
    if(req.url==='/api/skills.php')return res.end(JSON.stringify({success:true,data:{version:1,skills:[]}}));
    if(req.url.includes('api/download.php')){res.statusCode=206;res.setHeader('Content-Range','bytes 0-3/10');res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Disposition','attachment; filename=fixture.txt');return res.end('part');}
    if(req.url.includes('model_api.php'))return res.end(JSON.stringify({success:true,data:{providers:[],presets:[]}}));
    if(req.url.includes('api.php')) {res.setHeader('content-type','text/event-stream');res.write('data: {"type":"content","content":"first"}\n\n');await new Promise(resolve=>setTimeout(resolve,100));res.end('data: {"type":"done"}\n\n');return;}
    res.end(JSON.stringify({success:true,data:{}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:'http://127.0.0.1:'+server.address().port+'/',requests,setConfig:value=>configuration=value,stop:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
test('fresh offline installation opens complete UI; local drafts/history/settings survive reload and runtime failure',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext({userAgent:'MoonYaDesktop/1.0',viewport:{width:1400,height:900}});
    const page=await context.newPage(); const errors=[],external=[],missing=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',req=>{if(!req.url().startsWith(host.url)&&!req.url().startsWith('data:'))external.push(req.url());});
    page.on('response',res=>{if(res.status()===404)missing.push(res.url());});
    await page.goto(host.url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.MoonYaOffice&&!!window.MoonYaModels&&!!window.MoonYaHistoryStore);
    assert.equal(await page.locator('.message-input').count(),1);
    assert.ok(await page.locator('#officeView').count());
    assert.equal(await page.evaluate(()=>!!window.pdfjsLib&&!!window.mammoth&&!!window.hljs),true);
    await page.evaluate(async()=>{
      renderAuthState({id:7,username:'offline'});
      await initializeChatHistory();
      // 本地历史整机共享：scope 恒为 CHAT_HISTORY_KEY，不随账号变化。
      await MoonYaHistoryStore.save(CHAT_HISTORY_KEY,[{id:'saved',title:'离线记录',createdAt:'2026-09-30',mode:'work',messages:[{type:'user',content:'离线内容'}]}]);
      localStorage.setItem('moonya.deepseek.reasoning.work.v2','max');
      await MoonYaHistoryStore.saveDraft(CHAT_HISTORY_KEY,'saved',{text:'保留草稿'});
    });
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>currentUser?.id===7 && getChatHistory().some(c=>c.id==='saved'));
    assert.equal(await page.evaluate(async()=>(await MoonYaHistoryStore.hydrate(CHAT_HISTORY_KEY,'saved')).messages[0].content),'离线内容');
    assert.equal(await page.evaluate(async()=>(await MoonYaHistoryStore.loadDraft(CHAT_HISTORY_KEY,'saved')).text),'保留草稿');
    assert.equal(await page.evaluate(()=>localStorage.getItem('moonya.deepseek.reasoning.work.v2')),'max');
    await page.evaluate(()=>MoonYaOffice.open());
    assert.equal(await page.locator('#officeView').isVisible(),true);
    const shared=await page.evaluate(async()=>{
      const history=getChatHistory();await MoonYaHistoryStore.save(CHAT_HISTORY_KEY,[...history,{id:'worker-fixture',mode:'chat',storage:'cloud',dbConversationId:70,messages:[]}]);
      return MoonYaSharedRuntime.activate(70);
    });
    assert.equal(shared.conversationId,'70','the packaged SharedWorker must load and reply locally');
    assert.deepEqual(external,[]);assert.deepEqual(missing,[]);assert.deepEqual(errors,[]);
    await context.close();
  } finally {await browser.close();await host.stop();}
});

test('custom skills sync through native routes, render dynamically, preserve preferences and send selected names',async()=>{
  const backend=await backendFixture(),config=JSON.parse(await readFile(join(root,'MoonYa-Frontend/src/defaults.json'),'utf8'));
  backend.setConfig(config);
  let calls=0,source='server';const submissions=[];
  const skill={name:'writing-helper',display_name:'写作助手',description:'上传的写作提示词',enabled:true};
  const runtime=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    res.setHeader('content-type','application/json');
    if(req.url.includes('api/skills.php')) {calls++;await new Promise(resolve=>setTimeout(resolve,50));return res.end(JSON.stringify({success:true,data:{source,skills:[...config.skills,skill]}}));}
    if(req.url==='/v1/desktop/harness_api.php'&&req.method==='POST') {
      submissions.push(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','text/event-stream');
      return res.end('data: {"type":"error","error_code":"skill_unavailable","content":"所选技能尚未同步，请恢复网络后重试"}\n\n');
    }
    res.end(JSON.stringify({success:true,data:{providers:[],presets:[]}}));
  });
  await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
  const host=await nativeHost(backend.url,'http://127.0.0.1:'+runtime.address().port+'/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaModels&&!!window.MoonYaPluginView);
    await page.evaluate(async()=>{
      const result=await(await fetch('user_auth.php?action=login',{method:'POST',body:'{}'})).json();
      localStorage.setItem('api_token',result.data.token);renderAuthState(result.data.user);
      await initializeChatHistory();await MoonYaClient.refreshConfig();
    });
    assert.equal(await page.locator('[data-skill-group=custom] [data-skill-name=writing-helper]').count(),1);
    assert.equal(await page.locator('[data-plugin-id=writing-helper] [role=switch]').getAttribute('aria-checked'),'true');
    await page.evaluate(()=>MoonYaPlugins.setEnabled('writing-helper',false));
    assert.equal(await page.locator('[data-skill-name=writing-helper]').count(),0);
    await page.reload();await page.waitForFunction(()=>MoonYaClientConfig.skills.some(skill=>skill.name==='writing-helper'));
    assert.equal(await page.evaluate(()=>MoonYaPlugins.isEnabled('writing-helper')),false);
    await page.evaluate(()=>MoonYaPlugins.setEnabled('writing-helper',true));
    // Wait for prior startup sync, then verify only one request for simultaneous refreshes.
    await page.evaluate(()=>MoonYaClient.refreshSkills());const before=calls;
    await page.evaluate(()=>Promise.all([MoonYaClient.refreshSkills(),MoonYaClient.refreshSkills(),MoonYaClient.refreshSkills()]));
    assert.equal(calls,before+1);
    await page.evaluate(()=>document.querySelector('[data-skill-name=writing-helper]').click());
    assert.deepEqual(await page.evaluate(()=>selectedSkills),['writing-helper']);
    await page.evaluate(()=>{messageInput.value='保留技能任务草稿';messageInput.dispatchEvent(new Event('input',{bubbles:true}));MoonYaClient.state.online=null;void sendMessage();});
    await page.waitForFunction(()=>!MoonYaConversationRuntime.current().running&&!MoonYaConversationRuntime.current().preparing&&messageInput.value==='保留技能任务草稿');
    assert.deepEqual(submissions[0].selected_skills,['writing-helper']);assert.equal(submissions.length,1);
    assert.deepEqual(await page.evaluate(()=>selectedSkills),['writing-helper']);
    source='cache';await page.evaluate(()=>MoonYaClient.refreshSkills());
    assert.match(await page.locator('body').textContent(),/正在使用最近同步的技能版本/);
    const denied=await fetch(host.url+'gateway/model/1/skills',{headers:{Authorization:'Bearer invalid'}});assert.equal(denied.status,403);
    const allowed=await fetch(host.url+'gateway/model/1/skills',{headers:{Authorization:'Bearer '+host.runtimeSecret}});assert.equal(allowed.status,200);
    assert.ok(backend.requests.some(request=>request.url==='/api/skills.php'&&request.headers.authorization==='Bearer u1'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await host.stop();await backend.stop();await new Promise(resolve=>{runtime.close(resolve);runtime.closeAllConnections();});}
});
test('native gateway authenticates, isolates local routes, forbids foreign origins and streams server responses',async()=>{
  const backend=await backendFixture(), runtime=await backendFixture();
  const host=await nativeHost(backend.url,runtime.url);
  try {
    assert.equal((await fetch(host.url+'gateway/remote/user_auth.php?action=login',{method:'POST',body:'{}'})).status,403);
    const headers={'X-MoonYa-Gateway':host.token,'Content-Type':'application/json'};
    assert.equal((await fetch(host.url+'gateway/remote/user_auth.php?action=login',{method:'POST',headers:{...headers,Origin:'https://foreign.test'},body:'{}'})).status,403);
    assert.equal((await fetch(host.url+'gateway/remote/config.php',{headers})).status,404);
    const login=await(await fetch(host.url+'gateway/remote/user_auth.php?action=login',{method:'POST',headers,body:'{}'})).json();assert.equal(login.data.user.id,1);
    headers.Authorization='Bearer u1';
    const local=await fetch(host.url+'gateway/local/model_api.php',{headers});assert.equal(local.status,200);
    assert.equal(runtime.requests.length,1);assert.ok(runtime.requests[0].url.startsWith('/v1/desktop/'));
    assert.equal(runtime.requests[0].headers['x-moonya-user'],'1');assert.ok(runtime.requests[0].headers['x-moonya-desktop-secret']);
    const model=await fetch(host.url+'gateway/model/1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+runtime.requests[0].headers['x-moonya-desktop-secret']},body:'{"model":"deepseek-flash","messages":[]}'});
    assert.equal(model.status,200);
    assert.equal(backend.requests.find(r=>r.url==='/api/model_proxy.php').headers.authorization,'Bearer u1');
    const stream=await fetch(host.url+'gateway/remote/api.php',{method:'POST',headers,body:'{}'});
    const reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/first/);
    assert.match(new TextDecoder().decode((await reader.read()).value),/done/);
    const denied=await fetch(host.url+'gateway/local/model_api.php',{headers:{...headers,Authorization:'Bearer wrong'}});assert.equal(denied.status,401);
    assert.equal(runtime.requests.length,1);
    const download=await fetch(host.url+'gateway/remote/api/download.php?file=fixture.txt',{headers:{...headers,Range:'bytes=0-3'}});
    assert.equal(download.status,206);assert.equal(download.headers.get('content-range'),'bytes 0-3/10');assert.equal(await download.text(),'part');
    assert.equal(backend.requests.find(r=>r.url.includes('api/download.php')).headers.range,'bytes=0-3');
  } finally {await host.stop();await backend.stop();await runtime.stop();}
});

test('office recovers from runtime startup failures, clears stale notices and never retries writes',async()=>{
  const backend=await backendFixture();let unavailable=true,writes=0,reads=0;
  const runtime=createServer(async(req,res)=>{
    for await(const chunk of req) {};
    const action=new URL(req.url,'http://fixture').searchParams.get('action');
    if(req.method==='POST')writes++;else reads++;
    res.setHeader('content-type','application/json');
    if(unavailable||req.method==='POST') {res.statusCode=503;return res.end(JSON.stringify({success:false,error:'本地运行时暂不可用，请稍后重试'}));}
    if(action==='office_events') {res.setHeader('content-type','text/event-stream');res.write(': connected\n\n');return;}
    res.end(JSON.stringify({success:true,data:action==='office_settings'?{concurrency:6}:{session_id:'startup-room',seq:0,employees:[],concurrency:6}}));
  });
  await new Promise(resolve=>runtime.listen(0,'127.0.0.1',resolve));
  const host=await nativeHost(backend.url,'http://127.0.0.1:'+runtime.address().port+'/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaOffice);
    await page.evaluate(async()=>{
      const result=await(await fetch('user_auth.php?action=login',{method:'POST',body:'{}'})).json();
      localStorage.setItem('api_token',result.data.token);renderAuthState(result.data.user);
      MoonYaOffice.open();await MoonYaOffice.bind('startup-room','');
    });
    await page.waitForFunction(()=>document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving) .toast-text')?.textContent);
    assert.equal(await page.locator('#officeNotice').textContent(), '', 'Office feedback uses the shared top notification');
    assert.ok(reads>0,'the office reads the not-yet-ready runtime');
    unavailable=false;
    await page.waitForFunction(()=>document.getElementById('officeConcurrency').value==='6'&&!document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving)'));
    await page.locator('#officeConcurrency').fill('3');await page.locator('#officeConcurrency').dispatchEvent('change');
    await page.waitForFunction(()=>document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving) .toast-text')?.textContent==='本地运行时暂不可用，请稍后重试');
    await page.waitForTimeout(1700);assert.equal(writes,1,'a failed settings write is never replayed');
    await page.evaluate(()=>{MoonYaOffice.close();MoonYaOffice.open();});
    await page.waitForFunction(()=>!document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving)')&&document.getElementById('officeConcurrency').value==='6');
    unavailable=true;
    await page.evaluate(()=>{MoonYaOffice.close();MoonYaOffice.open();});
    await page.waitForFunction(()=>document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving) .toast-text')?.textContent.includes('本地'));
    await page.evaluate(()=>MoonYaOffice.close());
    await page.waitForFunction(()=>!document.querySelector('[data-notification-id="office-status"]:not(.toast-leaving)'));
    const readsAtClose=reads;await page.waitForTimeout(1700);
    assert.equal(reads,readsAtClose,'closing the office cancels background recovery');
  } finally {
    await browser.close();await host.stop();await backend.stop();
    await new Promise(resolve=>{runtime.close(resolve);runtime.closeAllConnections();});
  }
});

test('occupied frontend port reports an explicit error without remote fallback',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/');
  try {await assert.rejects(nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/',new URL(host.url).port),/本地界面服务启动失败.*端口/);}
  finally {await host.stop();}
});

test('invalid cached public config falls back to defaults; asynchronous updates keep model and skill controls usable',async()=>{
  const backend=await backendFixture(),host=await nativeHost(backend.url,'http://127.0.0.1:2/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('moonya.client-config.v1','{"version":1,"modelGroups":{}}'));
    await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaModels);
    // 内置模型在未登录时是禁用的（2026-10-03 起），本用例要验的是「配置热更新后菜单仍可用」，
    // 因此先建立登录态，保持原有断言语义不变。
    await page.evaluate(async()=>{
      const result=await(await fetch('user_auth.php?action=login',{method:'POST',body:'{}'})).json();
      localStorage.setItem('api_token',result.data.token);renderAuthState(result.data.user);
      await initializeChatHistory();
    });
    assert.equal(await page.evaluate(()=>DEEPSEEK_MODEL_GROUP.default),'deepseek-flash');
    assert.equal(await page.locator('#builtinModelOptions').count(),1,'the Chat model container has a unique ID');
    assert.equal(await page.locator('#agentModelMenu [data-agent-model="deepseek-flash"]').count(),1,'offline defaults also populate the Work model menu');
    const config=JSON.parse(await readFile(join(root,'MoonYa-Frontend/src/defaults.json'),'utf8'));
    config.modelGroups.deepseek.models[0].label='模型配置已刷新';config.skills[0].description='技能配置已刷新';
    config.modelGroups.deepseek.models.push({id:'fixture-builtin',label:'新增内置模型'});
    config.modelCapabilities['fixture-builtin']=structuredClone(config.modelCapabilities['deepseek-flash']);backend.setConfig(config);
    await page.evaluate(()=>MoonYaClient.refreshConfig());
    await page.waitForFunction(()=>document.getElementById('deepseekModelBtnText').textContent==='模型配置已刷新');
    const skill=config.skills[0].name;
    assert.equal(await page.evaluate(name=>{const button=document.querySelector('[data-skill-name="'+name+'"]');button.click();return selectedSkills.includes(name);},skill),true);
    assert.equal(await page.evaluate(()=>configuredModelLabel('deepseek','deepseek-flash')),'模型配置已刷新');
    assert.equal(await page.locator('#agentModelMenu [data-agent-model]').count(),2);
    assert.equal(await page.locator('#agentSettingsCaptionModel').textContent(),'模型配置已刷新');
    await page.locator('#agentSettingsStatus').click();await page.locator('#agentModelCaptionToggle').click();
    await page.locator('#agentModelMenu [data-agent-model="fixture-builtin"]').click();
    assert.equal(await page.evaluate(()=>deepseekModelVersion),'fixture-builtin','new Work options remain interactive after asynchronous replacement');
    assert.equal(await page.locator('#agentSettingsCaptionModel').textContent(),'新增内置模型');
    assert.equal(await page.locator('#agentModelMenu [data-agent-model="fixture-builtin"]').getAttribute('aria-checked'),'true');
    assert.equal(await page.evaluate(()=>localStorage.getItem(DEEPSEEK_MODEL_STORAGE_KEY)),'fixture-builtin');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await host.stop();await backend.stop();}
});

test('failed first Work request preserves editable draft and attachments without automatic execution retries',async()=>{
  const backend=await backendFixture(),host=await nativeHost(backend.url,'http://127.0.0.1:2/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage(),requests=[];
    page.on('request',req=>{if(req.url().endsWith('/harness_api.php')&&req.method()==='POST')requests.push(req);});
    await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaModels);
    await page.evaluate(async()=>{
      const result=await(await fetch('user_auth.php?action=login',{method:'POST',body:'{}'})).json();
      localStorage.setItem('api_token',result.data.token);renderAuthState(result.data.user);
      await initializeChatHistory();currentChatId=null;activateConversationRuntime(null);
      await stageWorkAttachment(new File(['local draft attachment'],'offline.txt',{type:'text/plain'}),'offline.txt','document',MoonYaConversationRuntime.current());
      messageInput.value='任务发送失败后应保留';messageInput.dispatchEvent(new Event('input',{bubbles:true}));
      MoonYaClient.state.online=null;void sendMessage();
    });
    await page.waitForFunction(()=>!MoonYaConversationRuntime.current().running&&!MoonYaConversationRuntime.current().preparing&&messageInput.value==='任务发送失败后应保留');
    assert.equal(await page.evaluate(()=>uploadedImages[0]?.filename),'offline.txt');
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    assert.equal(requests.length,1);
    assert.equal(await page.evaluate(async()=>{const r=MoonYaConversationRuntime.current();return(await MoonYaHistoryStore.loadDraft(r.historyScope,r.chatId))?.draft;}),'任务发送失败后应保留');
  } finally {await browser.close();await host.stop();await backend.stop();}
});

test('actual native gateway and Runtime execute Work locally through the server model proxy; resume never executes twice',async()=>{
  let modelCalls=0,localCalls=0;const modelRequests=[],localRequests=[];
  const data=await mkdtemp(join(tmpdir(),'moonya-live-gateway-')),file=join(data,'only-on-user-pc.txt');
  await writeFile(file,'Only the user computer has this fixture.');
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url.includes('login')) {res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{token:'u1',expires_in:1296000,user:{id:1,username:'fixture'}}}));}
    if(req.url.includes('client_config.php')) {res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{modelGroups:{deepseek:{default:'catalog-fixture',models:[{id:'catalog-fixture',label:'Configured model',multiplier:'0.25'}]}},modelCapabilities:{'catalog-fixture':{context_window:8192,max_output_tokens:2048,supports_tools:true,supports_thinking:false,protocol:'openai-completions'}}}}));}
    if(req.url.includes('membership.php')) {res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{account:{balance:'100.000000'}}}));}
    if(req.url==='/api/skills.php') {res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{version:1,skills:[]}}));}
    const input=JSON.parse(Buffer.concat(chunks).toString());modelRequests.push({url:req.url,token:req.headers.authorization,input});modelCalls++;
    const delta=modelCalls===1?{tool_calls:[{index:0,id:'local-read',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:file})}}]}:{content:'本机读取完成'};
    res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:modelCalls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  const local=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);localCalls++;
    const body=JSON.parse(Buffer.concat(chunks).toString());localRequests.push(body);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,content:await readFile(file,'utf8')}));
  });
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await new Promise(resolve=>local.listen(0,'127.0.0.1',resolve));
  const host=await nativeHost('http://127.0.0.1:'+server.address().port+'/','http://127.0.0.1:'+port+'/');
  const runtime=spawn(process.execPath,['src/server.mjs'],{cwd:join(root,'MoonYa-Harness'),windowsHide:true,
    env:{...process.env,MOONYA_HARNESS_PORT:String(port),MOONYA_HARNESS_DATA:data,MOONYA_FRONTEND_SECRET:host.runtimeSecret,
      MOONYA_FRONTEND_URL:host.url.replace(/\/$/,''),MOONYA_FRONTEND_DEFAULTS:join(root,'MoonYa-Frontend/dist/defaults.json'),
      MOONYA_BACKEND_URL:'http://127.0.0.1:'+server.address().port+'/',
      MOONYA_SKILLS_ROOT:join(root,'MoonYa-Backend/skills'),MOONYA_LOCAL_SERVICE_URL:'http://127.0.0.1:'+local.address().port},stdio:['ignore','pipe','pipe']});
  let errors='';runtime.stderr.on('data',chunk=>errors+=chunk);runtime.stdout.resume();
  try {
    await new Promise((resolve,reject)=>{let attempts=0;const poll=async()=>{try{const health=await fetch('http://127.0.0.1:'+port+'/health');if(health.ok)return resolve();}catch{}if(++attempts>100)return reject(new Error(errors||'Runtime failed to start'));setTimeout(poll,50);};void poll();});
    const headers={'X-MoonYa-Gateway':host.token,'Content-Type':'application/json'};
    await fetch(host.url+'gateway/remote/user_auth.php?action=login',{method:'POST',headers,body:'{}'});headers.Authorization='Bearer u1';
    const body={message:'Read the local file once',project_path:data,client_message_id:'one-local-execution',client_chat_id:'local-chat',reasoningProfile:'high'};
    const readFrames=async(response)=>(await response.text()).split('\n\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    const frames=await readFrames(await fetch(host.url+'gateway/local/harness_api.php',{method:'POST',headers,body:JSON.stringify(body)}));
    assert.equal(frames.at(-1).type,'done',JSON.stringify(frames));assert.equal(modelCalls,2);assert.equal(localCalls,1,JSON.stringify(frames));
    assert.ok(modelRequests.every(request=>request.url==='/api/model_proxy.php'&&request.token==='Bearer u1'&&request.input.model==='catalog-fixture'));
    assert.equal(localRequests[0].action,'read_file');assert.equal(localRequests[0].path,file);
    assert.ok(JSON.stringify(modelRequests[1].input.messages).includes('Only the user computer has this fixture.'));
    const sessionId=frames.find(frame=>frame.type==='harness_session').session_id;
    const resumed=await readFrames(await fetch(host.url+'gateway/local/harness_api.php',{method:'POST',headers,body:JSON.stringify({...body,harness_session_id:sessionId,resume:{after_seq:0,turn_started:1}})}));
    assert.equal(resumed.at(-1).type,'done');assert.equal(modelCalls,2);assert.equal(localCalls,1);
  } finally {
    await new Promise(resolve=>{runtime.once('exit',resolve);runtime.kill();});await host.stop();
    await Promise.all([new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}),new Promise(resolve=>{local.close(resolve);local.closeAllConnections();})]);
  }
});

test('real browser and native-host restart preserve offline drafts and settings in the same local origin',async()=>{
  let host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/');
  const profile=await mkdtemp(join(tmpdir(),'moonya-browser-'));
  let context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true});
  try {
    const page=await context.newPage();await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaConversationRuntime);
    await page.locator('.message-input').fill('重启后仍保留的草稿');
    await page.waitForFunction(async()=>{const r=MoonYaConversationRuntime.current();return(await MoonYaHistoryStore.loadDraft(r.historyScope,r.chatId))?.draft==='重启后仍保留的草稿';});
    await page.evaluate(()=>{
      localStorage.setItem('voiceBroadcastEnabled','false');
      MoonYaPlugins.setEnabled('browser-use-automation',false);
      MoonYaPlugins.setEnabled('realtime-voice-chat',false);
    });
    const url=host.url,data=host.data,port=new URL(url).port;
    await context.close();await host.stop();
    host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/',port,data);
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true});
    const restored=await context.newPage();await restored.goto(host.url);
    await restored.waitForFunction(()=>document.querySelector('.message-input').value==='重启后仍保留的草稿');
    assert.equal(await restored.evaluate(()=>localStorage.getItem('voiceBroadcastEnabled')),'false');
    assert.deepEqual(await restored.evaluate(()=>['browser-use-automation','computer-use-automation','realtime-voice-chat'].map(id=>MoonYaPlugins.isEnabled(id))),[false,true,false]);
    assert.equal(await restored.locator('[data-skill-name="browser-use-automation"]').count(),0);
    assert.equal(await restored.locator('#voiceChatToggle').getAttribute('hidden'),'');
    assert.equal(await restored.locator('#officeView').isVisible(),false);
    assert.equal(await restored.locator('#modeMenuLabel').textContent(),'FarSide');
    await restored.goto(host.url+'index.html?office_popout=1');
    await restored.waitForFunction(()=>document.body.dataset.officePopout==='1' && MoonYaOffice.isOpen());
    assert.equal(await restored.locator('#officeView').isVisible(),true);
  } finally {await context.close();await host.stop();}
});

test('old-origin export retains binary attachments; failed import can retry without losing old data',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/');const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext(),old=await context.newPage();await old.goto(host.url);
    await old.waitForFunction(()=>!!window.MoonYaHistoryStore);
    await old.evaluate(async()=>{
      await MoonYaHistoryStore.initialize('chat_history_11');
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('moonya-history');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction('attachments','readwrite');tx.objectStore('attachments').put({key:['chat_history_11','old','blob'],scope:'chat_history_11',conversation:['chat_history_11','old'],blob:new Blob(['附件内容'],{type:'text/plain'})});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
      localStorage.setItem('chatDisplayMode','compact');
    });
    await old.addScriptTag({path:join(root,'MoonYa-Frontend/src/migration-export.js')});await old.waitForFunction(()=>!!window.__moonyaMigration);
    const data=await old.evaluate(async()=>{
      const data={version:1,source:__moonyaMigration.source,storage:{},stores:{}};
      while(!(await MoonYaMigrationExport.next()).done){
        const part=JSON.parse(window.__moonyaMigrationChunk);Object.assign(data.storage,part.storage);
        for(const [name,rows]of Object.entries(part.stores))(data.stores[name]||=[]).push(...rows);
      }return data;
    });data.source='http://previous-origin.test';
    const fresh=await browser.newContext(),page=await fresh.newPage();await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaMigration);
    const result=await page.evaluate(async data=>{
      const broken=structuredClone(data);broken.stores.attachments.push({scope:'invalid'});
      let failed=false;try{await MoonYaMigration.importMigration(broken);}catch{failed=true;}
      const marker=localStorage.getItem('moonya.migration.v1:'+data.source);
      await MoonYaMigration.importMigration(data);await MoonYaMigration.importMigration(data);
      const db=await new Promise(resolve=>{const r=indexedDB.open('moonya-history');r.onsuccess=()=>resolve(r.result);});
      const row=await new Promise(resolve=>{const r=db.transaction('attachments').objectStore('attachments').get(['chat_history_11','old','blob']);r.onsuccess=()=>resolve(r.result);});db.close();
      return{failed,marker,text:await row.blob.text(),setting:localStorage.getItem('chatDisplayMode')};
    },data);
    assert.deepEqual(result,{failed:true,marker:null,text:'附件内容',setting:'compact'});
    assert.equal(await old.evaluate(()=>localStorage.getItem('chatDisplayMode')),'compact');
    await fresh.close();await context.close();
  } finally {await browser.close();await host.stop();}
});
test('migration preserves newer records, is idempotent, and keeps user data separate',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(host.url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!!window.MoonYaMigration);
    const result=await page.evaluate(async()=>{
      await MoonYaHistoryStore.initialize('chat_history_1');
      await MoonYaHistoryStore.save('chat_history_1',[{id:'same',title:'新数据',messages:[{type:'user',content:'新正文'}]}]);
      const data={version:1,source:'http://previous.test',storage:{'moonya.setting':'old'},stores:{
        conversations:[{key:['chat_history_1','same'],scope:'chat_history_1',meta:{id:'same',title:'旧数据'}},{key:['chat_history_2','other'],scope:'chat_history_2',meta:{id:'other',title:'用户二',messageCount:1}}],
        messages:[{key:['chat_history_1','same'],scope:'chat_history_1',messages:[{type:'user',content:'旧正文'}]},{key:['chat_history_2','other'],scope:'chat_history_2',messages:[{type:'user',content:'用户二正文'}]}]}};
      localStorage.setItem('moonya.setting','new');
      await MoonYaMigration.importMigration(data);await MoonYaMigration.importMigration(data);
      await MoonYaHistoryStore.reload('chat_history_1');await MoonYaHistoryStore.initialize('chat_history_2');
      return {one:(await MoonYaHistoryStore.hydrate('chat_history_1','same')).messages[0].content,
        two:(await MoonYaHistoryStore.hydrate('chat_history_2','other')).messages[0].content,count:MoonYaHistoryStore.list('chat_history_2').length,setting:localStorage.getItem('moonya.setting')};
    });
    assert.deepEqual(result,{one:'新正文',two:'用户二正文',count:1,setting:'new'});
  } finally {await browser.close();await host.stop();}
});

test('migration exporter bounds each batch rather than assembling all historical events',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/'),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaHistoryStore);
    await page.evaluate(async()=>{
      await MoonYaHistoryStore.initialize('chat_history_31');
      const db=await new Promise(r=>{const q=indexedDB.open('moonya-history');q.onsuccess=()=>r(q.result);});
      await new Promise((r,j)=>{const tx=db.transaction('events','readwrite');for(let i=0;i<250;i++)tx.objectStore('events').put({key:['chat_history_31','test',i],scope:'chat_history_31',conversation:['chat_history_31','test'],payload:'x'.repeat(131072)});tx.oncomplete=r;tx.onerror=()=>j(tx.error);});db.close();
    });
    await page.addScriptTag({path:join(root,'MoonYa-Frontend/src/migration-export.js')});await page.waitForFunction(()=>!!window.MoonYaMigrationExport);
    const result=await page.evaluate(async()=>{let events=0,batches=0,maxChars=0;
      while(!(await MoonYaMigrationExport.next()).done){const text=__moonyaMigrationChunk,part=JSON.parse(text);events+=(part.stores.events||[]).length;batches++;maxChars=Math.max(maxChars,text.length);}
      return{events,batches,maxChars,version:__moonyaMigration.version,wholeDatabasePresent:!!__moonyaMigration.stores};
    });
    assert.equal(result.events,250);assert.equal(result.version,2);assert.equal(result.wholeDatabasePresent,false);assert.ok(result.batches>30);assert.ok(result.maxChars<2*1024*1024);
  }finally{await browser.close();await host.stop();}
});

test('chunked import resumes after a failed batch, preserves newer rows and only marks completion at the end',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/'),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaMigration);
    let fail=true,completed=0;const source='http://chunked-old.test';
    const parts=[{version:1,source,storage:{'moonya.chunk-setting':'saved'},stores:{}},
      {version:1,source,storage:{},stores:{conversations:[{key:['chat_history_31','old'],scope:'chat_history_31',meta:{id:'old',title:'旧记录'}}]}},
      {version:1,source,storage:{},stores:{drafts:[{key:['chat_history_31','old'],scope:'chat_history_31',draft:{text:'旧草稿'}}]}}];
    await page.route('**/gateway/migration*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(req.method()==='DELETE'){completed++;return route.fulfill({json:{}});}
      const index=url.searchParams.get('chunk');
      if(index==='1'&&fail)return route.fulfill({status:503,json:{error:'fixture interruption'}});
      return route.fulfill({json:index===null?{version:2,source,chunks:parts.length}:parts[Number(index)]});
    });
    assert.equal(await page.evaluate(()=>MoonYaMigration.run()),false);assert.equal(completed,0);
    assert.equal(await page.evaluate(source=>localStorage.getItem('moonya.migration.v1:'+source),source),null);
    await page.evaluate(()=>localStorage.setItem('moonya.chunk-setting','newer'));
    fail=false;assert.equal(await page.evaluate(()=>MoonYaMigration.run()),true);assert.equal(completed,1);
    assert.equal(await page.evaluate(()=>localStorage.getItem('moonya.chunk-setting')),'newer');
    assert.equal(await page.evaluate(source=>localStorage.getItem('moonya.migration.v1:'+source),source),'1');
    assert.equal(await page.locator('#migrationRetry').count(),0);
  }finally{await browser.close();await host.stop();}
});

test('settings opens inside application in a light application modal and handles in-app options',async()=>{
  const host=await nativeHost('http://127.0.0.1:1/','http://127.0.0.1:2/'),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();await page.goto(host.url);
    await page.waitForFunction(()=>!!window.MoonYaClient&&!!window.openSettingsModal);
    
    // 初始状态下弹窗处于隐藏状态
    assert.equal(await page.locator('#settingsOverlay').isVisible(),false);

    // 模拟已登录用户并点击侧边栏设置或用户信息
    await page.evaluate(()=>{
      renderAuthState({id:997124,username:'user997124',real_name:'月雅泫'});
    });

    // 1. 点击侧边栏设置按钮或用户信息，弹窗在应用内打开
    await page.locator('#settingsBtn').click();
    assert.equal(await page.locator('#settingsOverlay').isVisible(),true);

    // 2. 检查头像、昵称、用户ID、账号管理按钮
    assert.equal(await page.locator('#settingsProfileName').textContent(),'月雅泫');
    assert.ok((await page.locator('#settingsProfileId').textContent()).includes('用户997124'));
    assert.equal(await page.locator('#settingsManageBtn').textContent(),'MoonYa账号管理');

    // 3. 检查卡片分组与各设置项（严格对应图片1）
    assert.ok(await page.locator('#itemPlan').isVisible());
    assert.ok(await page.locator('#itemQuota').isVisible());
    assert.ok(await page.locator('#itemVoice').isVisible());
    assert.ok(await page.locator('#itemAppearance').isVisible());
    assert.ok(await page.locator('#itemMemory').isVisible());
    assert.ok(await page.locator('#itemNotification').isVisible());
    assert.ok(await page.locator('#itemDefaultModel').isVisible());
    assert.ok(await page.locator('#itemWorkMode').isVisible());
    assert.ok(await page.locator('#itemDataSync').isVisible());
    assert.ok(await page.locator('#itemGeneration').isVisible());
    assert.ok(await page.locator('#itemVideoToggleRow').isVisible());
    assert.ok(await page.locator('#itemSendKey').isVisible());
    assert.ok(await page.locator('#itemPaging').isVisible());
    assert.ok(await page.locator('#itemShortcuts').isVisible());
    assert.ok(await page.locator('#itemAutostartRow').isVisible());

    // 4. 检查外观子页面交互（区域显示 vs 全屏显示）
    await page.locator('#itemAppearance').click();
    assert.ok(await page.locator('#settingsAppearanceView').isVisible());
    assert.equal(await page.locator('#settingsSubTitle').textContent(),'外观设置');
    await page.locator('#choiceFullscreen').click();
    assert.equal(await page.evaluate(()=>localStorage.getItem('chatDisplayMode')),'fullscreen');
    assert.equal(await page.evaluate(()=>document.body.classList.contains('chat-fullscreen')),true);

    // 返回主视图
    await page.locator('#settingsBackBtn').click();
    assert.ok(await page.locator('#settingsMainView').isVisible());
    assert.equal(await page.locator('#settingsAppearanceValue').textContent(),'跟随系统');
    assert.equal(await page.evaluate(()=>MoonYaTheme.getPreference()),'system');

    // 5. 检查视频/桌宠开关切换
    const initialVideoState = await page.evaluate(()=>document.getElementById('settingsVideoToggle').classList.contains('active'));
    await page.locator('#settingsVideoToggle').click();
    const nextVideoState = await page.evaluate(()=>document.getElementById('settingsVideoToggle').classList.contains('active'));
    assert.notEqual(initialVideoState, nextVideoState);

    // 6. 测试 openAccountPage 拦截：不跳出外部页面，而是在应用内弹出弹窗
    await page.locator('#settingsCloseBtn').click();
    assert.equal(await page.locator('#settingsOverlay').isVisible(),false);
    await page.evaluate(()=>MoonYaClient.openAccountPage('user/user_xinxi.php'));
    assert.equal(await page.locator('#settingsOverlay').isVisible(),true);

    // 7. 测试 Esc 键关闭
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsOverlay').isVisible(),false);
  }finally{await browser.close();await host.stop();}
});
