import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const artifacts=join(root,'MoonYa-Frontend/artifacts/builtin-reasoning');

test('native composer filters catalog tiers, remembers models and modes, migrates and sends exact parameters', {timeout:60000}, async()=>{
  const config=JSON.parse(await readFile(join(root,'MoonYa-Frontend/src/defaults.json'),'utf8'));
  const base={...config.modelCapabilities['deepseek-flash'],reasoning:'openai',supports_thinking:true};
  config.modelCapabilities={
    a:{...base,efforts:['low','medium','high'],default_effort:'medium',effort_labels:{medium:'日常',high:'认真'}},
    b:{...base,efforts:['xhigh','ultra'],default_effort:'ultra',effort_labels:{}},
    binary:{...base,reasoning:'deepseek',efforts:[],default_effort:'auto'},
    always:{...base,reasoning:'always',efforts:[],default_effort:'auto'},
    plain:{...base,supports_thinking:false,reasoning:'',efforts:[],default_effort:'auto'},
    single:{...base,efforts:['high'],default_effort:'high'}
  };
  config.modelGroups.deepseek={default:'a',models:Object.keys(config.modelCapabilities).map(id=>({id,label:id}))};
  const requests=[],proxyRequests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    if(req.url.endsWith('/api/model_proxy.php')) {
      proxyRequests.push({body,authorization:req.headers.authorization});res.setHeader('content-type','text/event-stream');res.end('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');return;
    }
    if ((req.url.endsWith('/api.php') || req.url.endsWith('/harness_api.php')) && req.method==='POST') {
      requests.push(body);res.setHeader('content-type','text/event-stream');res.end('data: {"type":"content","content":"完成"}\n\ndata: {"type":"done"}\n\n');return;
    }
    let data={};
    if(req.url.includes('client_config.php'))data=config;
    if(req.url.includes('check_session'))data={logged_in:true,token:'fixture',expires_in:1296000,user:{id:41,username:'fixture'}};
    if(req.url.includes('model_api.php'))data={providers:[],presets:[]};
    if(req.url.includes('workspace_settings'))data={root:'D:\\MoonYaDefault',workspaces:[],retained_paths:[]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const backend='http://127.0.0.1:'+server.address().port+'/';
  const data=await mkdtemp(join(tmpdir(),'moonya-reasoning-'));
  const child=spawn('dotnet',[join(root,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),join(root,'MoonYa-Frontend/dist'),backend,backend],{env:{...process.env,MOONYA_SMOKE_DATA:data},windowsHide:true});
  let stderr='';child.stderr.on('data',c=>stderr+=c);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const host=await new Promise((resolve,reject)=>{createInterface({input:child.stdout}).once('line',line=>resolve(JSON.parse(line)));child.once('exit',code=>reject(new Error('Native host '+code+': '+stderr)));});
    const page=await browser.newPage({userAgent:'MoonYaDesktop/1.0',viewport:{width:1300,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(host.url);
    await page.waitForFunction(()=>!!window.MoonYaModels&&MoonYaClientConfig.modelGroups.deepseek.default==='a');
    await page.waitForFunction(()=>!!MoonYaConversationRuntime.current().draftRestorePromise);
    await page.evaluate(()=>MoonYaConversationRuntime.current().draftRestorePromise);
    const auth=await fetch(new URL('/gateway/remote/user_auth.php?action=check_session',host.url),{headers:{'X-MoonYa-Gateway':host.token,Authorization:'Bearer fixture'}});assert.equal(auth.status,200);await auth.text();
    const responsesPath=new URL('/gateway/model/41/responses',host.url);
    const wire={model:'gpt-6.1-sol',stream:true,input:[{role:'user',content:'Hi'}],reasoning:{effort:'medium',summary:'auto'}};
    const bridge=await fetch(responsesPath,{method:'POST',headers:{Authorization:'Bearer '+host.runtimeSecret,'content-type':'application/json'},body:JSON.stringify(wire)});
    assert.equal(bridge.status,200);assert.match(await bridge.text(),/response.completed/);assert.deepEqual(proxyRequests,[{body:wire,authorization:'Bearer fixture'}]);
    const rejected=await fetch(new URL('/gateway/model/42/responses',host.url),{method:'POST',headers:{Authorization:'Bearer '+host.runtimeSecret},body:'{}'});assert.equal(rejected.status,403);
    const state=()=>page.evaluate(()=>({choices:[...document.querySelectorAll('#reasoningEffortDropdown [data-effort]')].map(el=>el.dataset.effort),effort:reasoningEffort,label:document.getElementById('agentSettingsCaptionEffort').textContent,disabled:document.getElementById('reasoningEffortSlider').disabled}));
    const select=(id,work=true)=>page.evaluate(async({id,work})=>{await switchMoonYaConversationMode(work?'work':'chat');deepseekModelVersion=id;isAgentMode=work;activateReasoningMode();renderMoonYaAgentSettings();},{id,work});
    assert.deepEqual(await state(),{choices:['low','medium','high'],effort:'medium',label:'日常',disabled:false});
    await page.locator('#agentSettingsStatus').click();
    await page.locator('#reasoningEffortSlider').focus();await page.keyboard.press('End');
    assert.equal((await state()).effort,'high');assert.equal((await state()).label,'认真');
    await mkdir(artifacts,{recursive:true});await page.locator('#agentSettingsPopover').screenshot({path:join(artifacts,'composer.png')});
    await select('b');assert.equal((await state()).effort,'ultra');assert.deepEqual((await state()).choices,['xhigh','ultra']);
    await select('a');assert.equal((await state()).effort,'high');
    await select('a',false);assert.equal((await state()).effort,'medium');assert.deepEqual((await state()).choices,['none','low','medium','high']);
    await page.evaluate(()=>{setReasoningProfile('low');renderMoonYaAgentSettings();});
    await select('a');assert.equal((await state()).effort,'high');
    await select('a',false);assert.equal((await state()).effort,'low');
    await page.reload();await page.waitForFunction(()=>!!window.MoonYaModels);
    await page.waitForFunction(()=>!!MoonYaConversationRuntime.current().draftRestorePromise);
    await page.evaluate(()=>MoonYaConversationRuntime.current().draftRestorePromise);
    await select('a',false);assert.equal((await state()).effort,'low');
    await page.evaluate(()=>{restoreBuiltinReasoningComposer({workReasoningProfile:'medium',chatReasoningProfile:'ultra'});isAgentMode=true;activateReasoningMode();renderMoonYaAgentSettings();});
    assert.equal((await state()).effort,'low');
    await select('b');
    await page.evaluate(()=>{restoreBuiltinReasoningComposer({reasoningProfileVersion:2,workReasoningProfile:'xhigh'});activateReasoningMode();renderMoonYaAgentSettings();});
    assert.equal((await state()).effort,'xhigh');
    await page.evaluate(()=>{MoonYaClientConfig.modelCapabilities.b.efforts=['ultra'];applyMoonYaPublicConfiguration(MoonYaClientConfig);});
    assert.deepEqual(await state(),{choices:['ultra'],effort:'ultra',label:'Ultra',disabled:true});
    await select('binary',false);assert.deepEqual((await state()).choices,['none','auto']);
    await select('binary');assert.deepEqual((await state()).choices,['auto']);assert.equal((await state()).label,'开启思考');
    await select('always',false);assert.deepEqual((await state()).choices,['auto']);
    await page.waitForFunction(()=>document.querySelector('#reasoningEffortSlider').closest('.effort-spring-slider').style.getPropertyValue('--slider-position') === '1');
    assert.deepEqual(await page.evaluate(()=>({
      label:document.getElementById('agentSettingsCaptionEffort').textContent,
      flow:document.getElementById('agentSettingsPopover').dataset.flow,
      opacity:getComputedStyle(document.querySelector('#reasoningEffortSlider').closest('.effort-spring-slider')).opacity,
      disabled:document.getElementById('reasoningEffortSlider').disabled,
      effort:reasoningEffort
    })),{label:'开启思考',flow:'normal',opacity:'1',disabled:true,effort:'auto'});
    await page.locator('#agentSettingsStatus').click();
    await page.locator('#agentSettingsPopover').screenshot({path:join(artifacts,'always-thinking.png')});
    await select('plain');assert.equal((await state()).disabled,true);assert.equal((await state()).label,'无思考');
    await page.waitForFunction(()=>document.querySelector('#reasoningEffortSlider').closest('.effort-spring-slider').style.getPropertyValue('--slider-position') === '0');
    await page.evaluate(()=>MoonYaModels.syncUi());assert.equal((await state()).disabled,true);
    await select('single');assert.equal((await state()).disabled,true);
    // Both real submission paths carry the version marker and the exact selected effort.
    await page.evaluate(async()=>{localStorage.setItem('api_token','fixture');renderAuthState({id:41,username:'fixture'});await initializeChatHistory();});
    for(const mode of ['chat','work']) {
      await page.evaluate(async mode=>{await switchMoonYaConversationMode(mode);deepseekModelVersion='a';isAgentMode=mode==='work';setReasoningProfile('medium');renderMoonYaAgentSettings();syncActiveConversationComposer();},mode);
      const count=requests.length;
      const response=page.waitForResponse(res=>res.request().method()==='POST' && /\/(?:api|harness_api)\.php/.test(res.url()),{timeout:10000});
      await page.locator('.message-input').fill('检查真实档位');await page.evaluate(()=>sendMessage());
      try {await response;} catch(error) {
        throw new Error(mode+' submission: '+JSON.stringify(await page.evaluate(()=>({loggedIn:isLoggedIn,profile:reasoningProfile,mode:isAgentMode,toasts:document.querySelector('#toast')?.textContent,errors:[...document.querySelectorAll('.notification-title,.notification-message,.toast')].map(e=>e.textContent)})))+' '+error.message);
      }
      await page.waitForFunction(()=>document.getElementById('sendBtn').dataset.state!=='stop');
      assert.equal(requests.length,count+1);
      assert.equal(requests.at(-1).reasoningProfileVersion,2);assert.equal(requests.at(-1).reasoningEffort,'medium');
      assert.equal(requests.at(-1).reasoningProfile,'medium');
    }
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    if(child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('\n');});
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
});

test('admin saves names and default tiers, and requires a replacement after deselecting the default',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try {
    const shell=await readFile(join(root,'MoonYa-Backend/script/dashboard/membership.php'),'utf8');
    await page.route('http://admin.test/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8">'+shell+'<div id="modalContent"></div>'}));
    await page.goto('http://admin.test/');
    await page.addStyleTag({path:join(root,'MoonYa-Backend/admin/assets/admin-ui.css')});
    await page.evaluate(()=>{
      window.token='fixture';window.saved=[];window.alerts=[];window.showAlert=(type,message)=>alerts.push({type,message});
      window.hideModal=()=>document.getElementById('modalContent').replaceChildren();window.showModal=html=>document.getElementById('modalContent').innerHTML=html;
      window.model={id:'fixture',label:'Fixture',upstream_model:'supplier',endpoint:'http://localhost/v1/chat/completions',has_api_key:true,multiplier:'1',enabled:true,capabilities:{provider:'custom',context_window:8192,max_output_tokens:1024,supports_thinking:true,reasoning:'openai',efforts:['low','medium','high']}};
      window.fetch=async(path,options)=>{if(options.method==='POST'){model={...JSON.parse(options.body),has_api_key:true};saved.push(model);}return {ok:true,json:async()=>({success:true,data:{items:[model]}})};};
    });
    await page.addScriptTag({path:join(root,'MoonYa-Backend/admin/assets/membership-admin.js')});
    await page.evaluate(async()=>{await loadBuiltinModels();editBuiltinModel(0);});
    assert.equal(await page.locator('#bmDefaultEffort').inputValue(),'high');
    await page.locator('#bmLabel_medium').fill('日常 <b>名称</b>');await page.selectOption('#bmDefaultEffort','medium');
    await mkdir(artifacts,{recursive:true});await page.locator('#bmThinkingPanel').screenshot({path:join(artifacts,'admin.png')});
    await page.locator('#memberSave').click();await page.waitForFunction(()=>saved.length===1);
    assert.equal(await page.evaluate(()=>saved[0].capabilities.default_effort),'medium');
    assert.equal(await page.evaluate(()=>saved[0].capabilities.effort_labels.medium),'日常 <b>名称</b>');
    await page.evaluate(()=>editBuiltinModel(0));assert.equal(await page.locator('#bmLabel_medium').inputValue(),'日常 <b>名称</b>');
    await page.locator('[data-effort="medium"]').click();assert.equal(await page.locator('#bmDefaultEffort').inputValue(),'');
    await page.locator('#memberSave').click();assert.equal(await page.evaluate(()=>saved.length),1);
    assert.match(await page.evaluate(()=>alerts.at(-1).message),/重新选择/);
    await page.selectOption('#bmDefaultEffort','low');await page.locator('#memberSave').click();await page.waitForFunction(()=>saved.length===2);
    assert.deepEqual(await page.evaluate(()=>saved[1].capabilities.efforts),['low','high']);
    assert.equal(await page.evaluate(()=>saved[1].capabilities.effort_labels.medium),undefined);
    await page.evaluate(()=>editBuiltinModel(0));await page.locator('[data-effort="low"]').click();await page.locator('[data-effort="high"]').click();
    assert.equal(await page.locator('#bmDefaultEffort').inputValue(),'auto');
    await page.locator('#memberSave').click();await page.waitForFunction(()=>saved.length===3);assert.deepEqual(await page.evaluate(()=>saved[2].capabilities.efforts),[]);
    await page.evaluate(()=>editBuiltinModel(0));await page.locator('#bmUpstream').fill('gpt-6.1-sol');await page.locator('#bmOfficialThinking').click();
    assert.equal(await page.locator('#bmProtocol').inputValue(),'openai-responses');assert.equal(await page.locator('#bmRequired').isChecked(),true);
    await page.locator('#memberSave').click();await page.waitForFunction(()=>saved.length===4);
    assert.deepEqual(await page.evaluate(()=>saved[3].capabilities.efforts),['low','medium','high','xhigh','max']);
    assert.equal(await page.evaluate(()=>saved[3].capabilities.protocol),'openai-responses');
    await page.evaluate(()=>editBuiltinModel(0));await page.locator('#bmUpstream').fill('gemini-3.8-flash');await page.locator('#bmOfficialThinking').click();
    await page.locator('#memberSave').click();await page.waitForFunction(()=>saved.length===5);
    assert.equal(await page.evaluate(()=>saved[4].capabilities.reasoning),'gemini');assert.equal(await page.evaluate(()=>saved[4].capabilities.allow_thinking_off),false);
    assert.equal(await page.evaluate(()=>saved[4].capabilities.protocol),'openai-completions');
  } finally {await browser.close();}
});
