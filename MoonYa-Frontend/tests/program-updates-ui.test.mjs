import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(import.meta.url)('playwright-core');
test('update control matches avatar, shows circular progress, switches to white install SVG and exposes release notes',async()=>{
  const data=await mkdtemp(join(tmpdir(),'moonya-updates-ui-'));
  let host,browser;
  try {
    const child=spawn('dotnet',[join(root,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),join(root,'MoonYa-Frontend/dist'),'http://127.0.0.1:1/','http://127.0.0.1:2/'],{cwd:root,windowsHide:true,env:{...process.env,MOONYA_SMOKE_DATA:data,MOONYA_SMOKE_UPDATES:'1'}});
    host=child; const lines=createInterface({input:child.stdout}); let errors='';child.stderr.on('data',value=>errors+=value);
    const info=await new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));child.once('exit',()=>reject(new Error(errors)));});
    // Gateway requires a token even though updating requires no account login.
    assert.equal((await fetch(info.url+'gateway/updates/status')).status,403);
    assert.equal((await fetch(info.url+'gateway/updates/status',{headers:{'X-MoonYa-Gateway':info.token,Origin:'https://foreign.invalid'}})).status,403);
    const statusResponse=await fetch(info.url+'gateway/updates/status',{headers:{'X-MoonYa-Gateway':info.token}});assert.equal(statusResponse.status,200);assert.equal((await statusResponse.json()).success,true,'native update status works without a user login');
    assert.equal((await fetch(info.url+'gateway/updates/install',{headers:{'X-MoonYa-Gateway':info.token}})).status,405);
    assert.equal((await fetch(info.url+'gateway/updates/install',{method:'POST',headers:{'X-MoonYa-Gateway':info.token}})).status,409,'unverified downloads cannot be installed');
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:800}});
    let status={state:'downloading',percent:37,downloaded_bytes:370,release:{id:1,version:'1.0.1',notes:'改进下载\n修复安装'},error:''}, installs=0;
    await page.route('**/gateway/updates/**',async route=>{
      assert.equal(route.request().headers()['x-moonya-gateway'],info.token);
      if(route.request().url().endsWith('/install')){installs++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({success:false,error:'安装准备已取消'})});}
      return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:status})});
    });
    await page.goto(info.url,{waitUntil:'domcontentloaded'});
    const button=page.locator('#programUpdateButton'); await button.waitFor({state:'visible'});
    assert.equal(await button.locator('.program-update-percent').textContent(),'37%');
    const dimensions=await page.evaluate(()=>{const button=document.getElementById('programUpdateButton'),avatar=document.querySelector('.user-avatar');const b=button.getBoundingClientRect(),a=avatar.getBoundingClientRect();return {button:[b.width,b.height],avatar:[a.width,a.height],above:b.bottom<=a.top,background:getComputedStyle(button).backgroundColor,stroke:getComputedStyle(button.querySelector('circle')).stroke};});
    assert.deepEqual(dimensions.button,[24,24]); assert.deepEqual(dimensions.button,dimensions.avatar); assert.ok(dimensions.above);
    assert.equal(dimensions.background,'rgb(41, 121, 255)'); assert.equal(dimensions.stroke,'rgb(255, 255, 255)');
    const screenshots=join(root,'artifacts/program-updates-ui');await mkdir(screenshots,{recursive:true});
    await page.locator('.app-rail').screenshot({path:join(screenshots,'downloading.png')});
    status={...status,state:'ready',percent:100};await page.waitForFunction(()=>document.getElementById('programUpdateButton').dataset.state==='ready');
    assert.equal(await button.locator('.program-update-percent').isVisible(),false);assert.equal(await button.locator('.program-update-progress').isVisible(),false);assert.equal(await button.locator('.program-update-install').isVisible(),true);
    await button.hover();await page.waitForFunction(()=>document.getElementById('moonyaTooltip').textContent.includes('修复安装'));
    assert.match(await page.locator('#moonyaTooltip').textContent(),/1\.0\.1/);
    await page.locator('.app-rail').screenshot({path:join(screenshots,'ready.png')});
    await button.screenshot({path:join(screenshots,'install-icon.png')});
    const reference=await readFile(join(root,'MoonYa-Frontend/tests/fixtures/program-updates/install-reference.png'));
    const shape=await page.evaluate(async reference=>{
      const svg=document.querySelector('.program-update-install').cloneNode(true);svg.removeAttribute('class');svg.setAttribute('width','24');svg.setAttribute('height','24');svg.setAttribute('stroke','#000');
      async function pixels(source){const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,24,24);context.drawImage(image,0,0);return context.getImageData(0,0,24,24).data;}
      const actual=await pixels('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg)));
      const expected=await pixels(reference);let intersection=0,union=0;
      for(let index=0;index<actual.length;index+=4){const a=actual[index]<128,b=expected[index]<128;if(a||b)union++;if(a&&b)intersection++;}
      return intersection/union;
    },'data:image/png;base64,'+reference.toString('base64'));
    assert.ok(shape>=.98,'SVG silhouette must match the attached reference: '+shape);
    status={...status,state:'installing'};await page.waitForFunction(()=>document.getElementById('programUpdateButton').dataset.state==='installing');
    assert.equal(await button.locator('.program-update-percent').isVisible(),false);assert.equal(await button.locator('.program-update-install').isVisible(),true);
    status={...status,state:'ready'};await page.waitForFunction(()=>document.getElementById('programUpdateButton').dataset.state==='ready');
    await button.click();await page.waitForFunction(()=>!document.getElementById('programUpdateButton').disabled);assert.equal(installs,1);
    status={...status,update_required:true,current_version:'1.0.0'};
    await page.waitForFunction(()=>window.MoonYaUpdateRequired);
    const blocked=await page.evaluate(async()=>{
      const original=MoonYaHistoryStore.initialize;let writes=0;
      MoonYaHistoryStore.initialize=async()=>{writes++;throw new Error('A blocked chat must not touch history');};
      try { await createNewChat({reuse:false}); await sendMessage('blocked new task'); return writes; }
      finally { MoonYaHistoryStore.initialize=original; }
    });
    assert.equal(blocked,0,'mandatory updates block actual frontend chat/task entrypoints before history mutation');
    await page.keyboard.press('Escape');assert.equal(await page.locator('.system-dialog-overlay').isVisible(),true);
    status={state:'idle',release:null,percent:0,error:''};await button.waitFor({state:'hidden'});
  } finally {
    if(browser)await browser.close();
    if(host&&host.exitCode===null){const exited=new Promise(resolve=>host.once('exit',resolve));host.stdin.end('\n');await exited;}
    const target=resolve(data);assert.equal(dirname(target).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(target),/^moonya-updates-ui-/);await rm(target,{recursive:true,force:true});
  }
});
