import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));

test('permission menu matches reference, defaults apply only to new chats, changes persist and failed updates retain the old mode', {timeout:45000},async t=>{
  const requests=[];let rejectPermissions=false;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks).toString();const url=new URL(req.url,'http://fixture');
    if(url.pathname.endsWith('/updates.php')) {res.end(JSON.stringify({success:false}));return;}
    requests.push({path:url.pathname,action:url.searchParams.get('action'),body:body?JSON.parse(body):{}});
    let data={};
    if(url.pathname.includes('check_session')||url.searchParams.get('action')==='check_session') data={logged_in:true,user:{id:41,username:'fixture'}};
    if(url.pathname.endsWith('/model_api.php'))data={providers:[],presets:[]};
    if(url.searchParams.get('action')==='permissions'){
      if(rejectPermissions){res.statusCode=503;res.end(JSON.stringify({success:false,error:'模拟权限更新失败'}));return;}
      res.end(JSON.stringify({success:true,approval_mode:JSON.parse(body).approval_mode}));return;
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const backend='http://127.0.0.1:'+server.address().port+'/';const data=await mkdtemp(join(tmpdir(),'moonya-permission-ui-'));
  const child=spawn('dotnet',[join(root,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),join(root,'MoonYa-Frontend/dist'),backend,backend],
    {env:{...process.env,MOONYA_SMOKE_DATA:data},windowsHide:true});
  t.after(()=>child.exitCode!==null?undefined:new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('\n');}));
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const host=await new Promise((resolve,reject)=>{createInterface({input:child.stdout}).once('line',line=>resolve(JSON.parse(line)));child.once('exit',code=>reject(new Error('Host '+code+': '+stderr)));});
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({userAgent:'MoonYaDesktop/1.0',viewport:{width:1200,height:900}});
  page.setDefaultTimeout(8000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const artifacts=join(root,'artifacts/permissions');await mkdir(artifacts,{recursive:true});
  try{
    await page.goto(host.url);await page.waitForFunction(()=>!!window.MoonYaPermissions&&!!window.MoonYaHistoryStore);
    await page.evaluate(async()=>{localStorage.setItem('api_token','fixture-token');renderAuthState({id:41,username:'fixture'});await initializeChatHistory();await switchMoonYaConversationMode('work');});
    const chat=await page.evaluate(async()=>{const chat=await createNewChat({reuse:false});return chat.id;});
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='请求批准');
    assert.equal(await page.locator('#approvalModeMenu [role=menuitemradio]').count(),3);
    assert.equal(await page.locator('#mcpConnectionList').count(),0);
    assert.ok(!(await page.locator('#approvalModeMenu').textContent()).includes('了解更多'));
    for(const [value,label] of [['always_confirm_changes','请求批准'],['high_risk_only','帮我批准'],['full_access','完全访问']]){
      await page.locator('#approvalModeButton').click();await page.locator('[data-approval-mode="'+value+'"]').click();
      await page.waitForFunction(label=>document.getElementById('approvalModeButtonText').textContent===label,label);
      await page.waitForFunction(()=>!getConversationRuntime(currentChatId).permissionUpdate);
      await page.locator('#approvalModeButton').click();
      assert.equal(await page.locator('#approvalModeMenu [aria-checked=true]').count(),1);
      await page.locator('#approvalModeMenu').screenshot({path:join(artifacts,value+'.png')});
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#approvalModeButton').getAttribute('aria-expanded'),'false');
    }
    await page.evaluate(()=>openSettingsModal());await page.locator('#itemDefaultPermission').click();
    await page.locator('[data-default-permission=high_risk]').click();
    assert.equal(await page.locator('#settingsDefaultPermissionValue').textContent(),'帮我批准');
    await page.locator('#settingsPermissionView').screenshot({path:join(artifacts,'default-setting.png')});
    await page.locator('#settingsCloseBtn').click();
    assert.equal(await page.locator('#approvalModeButtonText').textContent(),'完全访问');
    const next=await page.evaluate(async()=>{const chat=await createNewChat({reuse:false});return chat.id;});
    const newState=await page.evaluate(async()=>{const runtime=getConversationRuntime(currentChatId);await restoreConversationDraft(runtime);return {default:MoonYaPermissions.defaultMode(),mode:runtime.approvalMode,composer:runtime.composer,chat:getChatHistory().find(chat=>chat.id===currentChatId),label:document.getElementById('approvalModeButtonText').textContent};});
    assert.equal(newState.mode,'high_risk',JSON.stringify(newState));
    assert.equal(newState.label,'帮我批准',JSON.stringify(newState));
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='帮我批准');
    await page.evaluate(async id=>{await loadChat(id);},chat);
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='完全访问');
    await page.evaluate(async()=>{const history=getChatHistory();for(const chat of history){chat.messages=[{role:'user',content:'权限恢复测试'}];chat.messageCount=1;}await saveChatHistory(history);});
    await page.reload();await page.waitForFunction(()=>!!window.MoonYaPermissions&&!!window.MoonYaHistoryStore);
    await page.evaluate(async id=>{renderAuthState({id:41,username:'fixture'});await initializeChatHistory();await loadChat(id);},chat);
    const restored=await page.evaluate(async()=>{const runtime=getConversationRuntime(currentChatId);await restoreConversationDraft(runtime);return {scope:CHAT_HISTORY_KEY,id:currentChatId,mode:runtime.approvalMode,composer:runtime.composer,draft:await MoonYaHistoryStore.loadDraft(CHAT_HISTORY_KEY,currentChatId),label:document.getElementById('approvalModeButtonText').textContent};});
    assert.equal(restored.mode,'full_access',JSON.stringify(restored));
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='完全访问');
    assert.equal(await page.evaluate(()=>MoonYaPermissions.defaultMode()),'high_risk');
    await page.evaluate(()=>{const runtime=getConversationRuntime(currentChatId);runtime.harnessSessionId='fixture-root';runtime.workspaceIdentity='__default__';});
    const beforeSaveFailure=requests.filter(request=>request.action==='permissions').length;
    await page.evaluate(()=>{window.permissionSaveDraft=MoonYaHistoryStore.saveDraft;MoonYaHistoryStore.saveDraft=async()=>false;});
    await page.locator('#approvalModeButton').click();await page.locator('[data-approval-mode=always_confirm_changes]').click();
    await page.waitForFunction(()=>!getConversationRuntime(currentChatId).permissionUpdate);
    await page.evaluate(()=>{MoonYaHistoryStore.saveDraft=window.permissionSaveDraft;delete window.permissionSaveDraft;});
    assert.equal(await page.locator('#approvalModeButtonText').textContent(),'完全访问');
    assert.equal(requests.filter(request=>request.action==='permissions').length,beforeSaveFailure,'failed local save never updates the executing session');
    rejectPermissions=true;
    await page.locator('#approvalModeButton').click();await page.locator('[data-approval-mode=always_confirm_changes]').click();
    await page.waitForFunction(()=>!getConversationRuntime(currentChatId).permissionUpdate);
    assert.equal(await page.locator('#approvalModeButtonText').textContent(),'完全访问');
    rejectPermissions=false;
    await page.locator('#approvalModeButton').click();await page.locator('[data-approval-mode=always_confirm_changes]').click();
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='请求批准');
    const update=requests.findLast(request=>request.action==='permissions');
    assert.equal(update.body.client_chat_id,chat);assert.equal(update.body.approval_mode,'confirm_writes');
    await page.evaluate(async id=>{await loadChat(id);},next);
    await page.waitForFunction(()=>document.getElementById('approvalModeButtonText').textContent==='帮我批准');
    await page.locator('#approvalModeButton').focus();await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('#approvalModeButton').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.approvalMode),'high_risk_only');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#approvalModeButton').getAttribute('aria-expanded'),'false');
    await page.waitForFunction(()=>!document.getElementById('toast').classList.contains('show'));
    await page.setViewportSize({width:360,height:740});await page.locator('#approvalModeButton').click();
    const box=await page.locator('#approvalModeMenu').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=360,JSON.stringify(box));
    await page.locator('#approvalModeMenu').screenshot({path:join(artifacts,'narrow.png')});
    assert.deepEqual(errors,[]);
  }finally{
    await browser.close();
  }
});
