import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('mandatory modal priority, task gate, announcements revisions, withdrawal, keyboard and image fallback',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:900,height:700}});
    let status={state:'downloading',current_version:'1.0.0',percent:30,update_required:false,release:{id:1,version:'1.0.3',notes:'修复与改进'},error:''};
    let feed=[{id:1,revision:1,title:'公告一',blocks:[{type:'text',text:'<script>unsafe</script>\n新功能'},{type:'image',url:'/uploads/new-images/missing.png',width:70,align:'center'}]},{id:2,revision:1,title:'公告二',blocks:[{type:'text',text:'第二条'}]}],read={},acks=[],installs=0,retries=0;
    await page.route('http://moonya.test/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body><button id="background">开始聊天</button><button id="programUpdateButton"><span class="program-update-percent"></span><svg><circle class="program-update-arc"/></svg></button>'});
      if(path.includes('/updates/')){if(path.endsWith('/install')){installs++;status={...status,error:'安装准备已取消'};}if(path.endsWith('/retry'))retries++;return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:status})});}
      if(path==='/gateway/announcements/read'){const body=route.request().postDataJSON();read[body.id]=body.revision;acks.push(body);return route.fulfill({contentType:'application/json',body:'{"success":true}'});}
      if(path==='/gateway/announcements/feed')return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{announcements:feed,read}})});
      return route.fulfill({status:404,body:''});
    });
    await page.goto('http://moonya.test/');
    await page.addStyleTag({path:join(repo,'MoonYa-Backend/admin/assets/system-dialog.css')});
    await page.evaluate(()=>{window.MoonYaHost={gatewayToken:'fixture',backendUrl:'http://moonya.test/'};const interval=window.setInterval.bind(window);window.setInterval=(fn,ms)=>interval(fn,ms===300000?100:ms);});
    for(const path of ['MoonYa-Backend/admin/assets/announcement-content.js','MoonYa-Frontend/src/system-dialog.js','MoonYa-Frontend/src/program-updates.js','MoonYa-Frontend/src/announcements.js'])await page.addScriptTag({path:join(repo,path)});
    const modal=page.locator('.system-dialog-overlay');await modal.waitFor({state:'visible'});await page.waitForFunction(()=>document.getElementById('systemDialogTitle').textContent==='公告一');
    assert.match(await modal.textContent(),/<script>unsafe<\/script>/);await page.getByText('图片暂时无法加载').waitFor();
    await page.keyboard.press('Escape');await page.waitForFunction(()=>document.getElementById('systemDialogTitle').textContent==='公告二');assert.deepEqual(acks,[{id:1,revision:1}]);
    status={...status,update_required:true};await page.waitForFunction(()=>window.MoonYaUpdateRequired);
    assert.equal(await page.evaluate(()=>MoonYaCanStartTask()),false);assert.equal(await page.locator('#background').evaluate(node=>node.inert),true);
    assert.equal(await modal.locator('.membership-dialog-close').isVisible(),false);await page.keyboard.press('Escape');assert.equal(await modal.isVisible(),true);
    await page.locator('#background').evaluate(node=>node.focus());assert.equal(await page.evaluate(()=>document.querySelector('.system-dialog-overlay').contains(document.activeElement)),true);
    await mkdir(join(repo,'artifacts/announcements'),{recursive:true});await modal.screenshot({path:join(repo,'artifacts/announcements/mandatory-update.png')});
    status={...status,state:'error',error:'网络异常'};await page.getByRole('button',{name:'重试下载',exact:true}).click();assert.equal(retries,1);
    status={...status,state:'ready',percent:100,error:''};await page.getByRole('button',{name:'安装更新',exact:true}).click();assert.equal(installs,1);await page.getByText('安装准备已取消',{exact:true}).waitFor();assert.equal(await modal.isVisible(),true);
    status={...status,update_required:false};await page.waitForFunction(()=>document.getElementById('systemDialogTitle').textContent==='公告二');
    await page.getByRole('button',{name:'我知道了'}).click();await modal.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>MoonYaCanStartTask()),true);
    feed=[{...feed[0],revision:2,title:'公告修订'}];await page.waitForFunction(()=>document.getElementById('systemDialogTitle').textContent==='公告修订'&&!document.querySelector('.system-dialog-overlay').hidden);
    feed=[];await modal.waitFor({state:'hidden'});assert.equal(acks.length,2,'withdrawal never acknowledges an unseen revision');
    await page.setViewportSize({width:360,height:580});feed=[{id:3,revision:1,title:'长公告',blocks:[{type:'text',text:'内容\n'.repeat(100)}]}];await modal.waitFor({state:'visible'});
    const dimensions=await modal.locator('.membership-dialog').evaluate(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,scroll:node.scrollHeight>node.clientHeight}));
    assert.ok(dimensions.width<=328&&dimensions.height<=532&&dimensions.scroll);await page.keyboard.press('Tab');await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
    await page.reload(); // Read persistence itself is covered by the native store smoke.
  } finally {await browser.close();}
});
