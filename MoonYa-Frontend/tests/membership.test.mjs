import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
test('membership shows only server catalog, contains failed/account-switched data, and supports quota replay and narrow keyboard UI',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  try{
    await page.route('http://membership.test/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><body style="font-family:Arial"><div id="accountMenu"><b id="accountMenuPlan"></b><small id="accountMenuCredits"></small><button id="accountMenuUpgrade">升级套餐</button></div><div id="reply"><div class="message-content">已经生成的回答</div></div></body>'}));
    await page.goto('http://membership.test/');
    await page.addStyleTag({content:await readFile(join(root,'src/styles/css-30-membership.css'),'utf8')});await page.addStyleTag({path:join(root,'../MoonYa-Backend/admin/assets/system-dialog.css')});
    await page.addScriptTag({path:join(root,'src/ui-icons.js')});
    await page.evaluate(()=>{
      window.currentUser={id:1};window.isLoggedIn=true;window.MoonYaClient={refreshConfig:async()=>{}};
      const plans=['GO','Plus','Pro','Max'].map((name,i)=>({id:i+2,name,is_free:false,price_cents:[800,4000,6000,8800][i],monthly_credits:[300,1500,2400,3600][i],description:'每月积分额度',features:[{title:'积分额度',items:['每月重置，剩余积分不结转']}]}));
      plans.unshift({id:1,name:'免费版',is_free:true,price_cents:0,monthly_credits:100,description:'每月免费积分',features:[]});
      window.summary={account:{plan:plans[0],balance:'100.000000',period_allowance:'100.000000',resets_at:'2026-11-02 12:00:00',expires_at:null},plans};
      window.failed=false;window.pending=[];
      window.fetch=async()=>{if(window.pause)return await new Promise(resolve=>pending.push(resolve));return {ok:!failed,json:async()=>failed?{success:false,error:'加载失败'}:{success:true,data:summary}};};
    });
    await page.addScriptTag({path:join(root,'src/membership.js')});await page.waitForFunction(()=>MoonYaMembership.account()?.balance==='100.000000');
    await page.locator('#accountMenuUpgrade').click();assert.equal(await page.locator('.membership-card').count(),5);
    const columns=await page.locator('.membership-card').evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().y));assert.equal(new Set(columns).size,1);
    assert.equal(await page.locator('.membership-subscribe').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(32, 32, 32)');
    assert.deepEqual(await page.locator('.membership-price strong').allTextContents(),['0','8','40','60','88']);
    assert.equal(await page.locator('.membership-subscribe:disabled').count(),5);
    const artifacts=join(root,'artifacts/membership');await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.querySelector('.membership-page').scrollWidth<=innerWidth),true);
    await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.className),'membership-back');
    await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.className),'membership-row membership-orders-toggle');
    await page.keyboard.press('Escape');assert.equal(await page.locator('.membership-overlay').isVisible(),false);
    await page.evaluate(()=>{MoonYaMembership.quotaNotice(document.getElementById('reply'));MoonYaMembership.quotaNotice(document.getElementById('reply'));});
    assert.equal(await page.locator('.credits-exhausted-notice').count(),1);assert.match(await page.locator('#reply').textContent(),/已经生成的回答/);
    await page.evaluate(()=>{const clone=document.getElementById('reply').cloneNode(true);clone.id='replayed';document.body.append(clone);});
    await page.locator('#replayed .credits-exhausted-notice button').click();assert.equal(await page.locator('.membership-overlay').isVisible(),true);
    await page.evaluate(async()=>{failed=true;await MoonYaMembership.refresh();});assert.equal(await page.locator('#accountMenuCredits').textContent(),'100 积分');assert.equal(await page.locator('.membership-card').count(),5);assert.match(await page.locator('.membership-load-status').textContent(),/上次成功加载/);assert.equal(await page.locator('.membership-retry').isVisible(),true);
    await page.evaluate(async()=>{failed=false;pause=true;void MoonYaMembership.refresh();await Promise.resolve();currentUser={id:2};isLoggedIn=false;window.dispatchEvent(new Event('moonya:auth-state'));pause=false;for(const resolve of pending)resolve({ok:true,json:async()=>({success:true,data:summary})});});
    await page.waitForFunction(()=>MoonYaMembership.account()===null);assert.equal(await page.locator('.membership-card').count(),0);
  }finally{await browser.close();}
});

test('subscription shares real plans, preserves data on failure, shows monthly remaining bars and paginates records',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  try{
    await page.route('http://subscription.test/',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><body style="font-family:Arial"><div id="accountMenu"><span id="userPlan"></span><b id="accountMenuPlan"></b><small id="accountMenuCredits"></small><small id="accountMenuMembershipStatus"></small><button id="accountMenuUpgrade">升级套餐</button></div><span id="settingsPlanName"></span><span id="settingsPlanStatus"></span></body>'}));
    await page.goto('http://subscription.test/');
    await page.addStyleTag({path:join(root,'src/styles/css-30-membership.css')});await page.addStyleTag({path:join(root,'../MoonYa-Backend/admin/assets/system-dialog.css')});
    await page.addScriptTag({path:join(root,'src/ui-icons.js')});
    await page.evaluate(()=>{
      window.currentUser={id:1};window.isLoggedIn=true;window.MoonYaClient={refreshConfig:async()=>{}};
      window.failed=true;window.actions=[];
      window.summary={account:{plan:{id:1,name:'免费版',is_free:true,description:'每月真实额度',features:[{title:'权益',items:['后端提供的权益']}]},balance:'75.000000',period_allowance:'100.000000',resets_at:'2026-11-04 12:00:00',expires_at:null},plans:[]};
      window.fetch=async path=>{
        const url=new URL(path,location.href),action=url.searchParams.get('action');actions.push(url.search);
        if(failed)throw new Error('网络测试失败');
        if(action==='ledger')return {ok:true,json:async()=>({success:true,data:{items:[{created_at:'2026-10-04 12:00:00',kind:'model_usage',delta:'-0.25',balance:'75',details:{model_id:'deepseek-flash'}}],total:21}})};
        if(action==='orders')return {ok:true,json:async()=>({success:true,data:{items:[],total:21}})};
        return {ok:true,json:async()=>({success:true,data:summary})};
      };
    });
    await page.addScriptTag({path:join(root,'src/membership.js')});
    await page.evaluate(()=>MoonYaMembership.openDetail());
    assert.equal(await page.locator('#userPlan').textContent(),'免费版');
    assert.equal(await page.locator('#settingsPlanName').textContent(),'免费版');
    assert.equal(await page.locator('[role="progressbar"]').count(),0);
    assert.match(await page.locator('.membership-load-status').textContent(),/会员信息未加载/);
    await page.evaluate(()=>failed=false);await page.locator('.membership-retry').click();
    await page.waitForFunction(()=>MoonYaMembership.account()?.balance==='75.000000');
    assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'),'75');
    assert.match(await page.locator('.membership-benefits').textContent(),/后端提供的权益/);
    await page.evaluate(async()=>{summary.account.queued_purchases=[{plan:{name:'Plus'},starts_at:'2026-11-04',ends_at:'2026-12-04'}];await MoonYaMembership.refresh();});
    assert.equal(await page.locator('.membership-purchases').isVisible(),false);
    assert.equal(await page.locator('.membership-payment-status').count(),0);
    assert.equal(await page.locator('.membership-catalog').isVisible(),false);
    assert.equal(await page.locator('.membership-hero').isVisible(),true);
    assert.equal(await page.locator('.membership-show-plans').isVisible(),true);
    assert.equal(await page.locator('.membership-ledger-toggle').isVisible(),true);
    assert.equal(await page.locator('.membership-orders-toggle').isVisible(),true);
    for(const name of ['免费版','GO','Plus','Pro','Max']){
      await page.evaluate(async name=>{summary.account.plan.name=name;summary.account.plan.is_free=name==='免费版';summary.account.expires_at=name==='免费版'?null:'2026-11-04 12:00:00';await MoonYaMembership.refresh();},name);
      for(const selector of ['#userPlan','#accountMenuPlan','#settingsPlanName'])assert.equal(await page.locator(selector).textContent(),name);
      assert.match(await page.locator('.membership-current-plan').textContent(),new RegExp(name));
    }
    for(const [balance,allowance,expected] of [['0','100','0'],['0','0','0'],['20','0','100'],['180','100','100'],['15','300','5']]){
      await page.evaluate(async values=>{summary.account.balance=values[0];summary.account.period_allowance=values[1];await MoonYaMembership.refresh();},[balance,allowance]);
      assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'),expected);
      assert.match(await page.locator('.membership-quota-heading').textContent(),new RegExp(balance+' / '+allowance));
    }
    await page.evaluate(async()=>{failed=true;await MoonYaMembership.refresh();});
    assert.equal(await page.locator('#userPlan').textContent(),'Max');assert.equal(await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'),'5');
    assert.match(await page.locator('.membership-load-status').textContent(),/上次成功加载/);
    await page.evaluate(async()=>{failed=false;summary.account.plan.name='免费版';summary.account.plan.is_free=true;summary.account.expires_at=null;summary.account.balance='100';summary.account.period_allowance='100';summary.account.resets_at='2026-12-04 12:00:00';await MoonYaMembership.refresh();});
    assert.equal(await page.locator('#settingsPlanName').textContent(),'免费版');assert.match(await page.locator('.membership-account').textContent(),/2026-12-04/);
    const artifacts=join(root,'artifacts/membership');await mkdir(artifacts,{recursive:true});
    await page.screenshot({path:join(artifacts,'subscription-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'subscription-mobile.png')});
    const geometry=await page.locator('.membership-page').evaluate(el=>({width:el.scrollWidth,client:el.clientWidth,height:el.getBoundingClientRect().height}));
    assert.ok(geometry.width<=geometry.client);assert.ok(geometry.height<=844);
    await page.evaluate(async()=>{summary.account.plan.description='很长的真实套餐介绍\n'.repeat(100);await MoonYaMembership.refresh();});
    assert.equal(await page.locator('.membership-page').evaluate(el=>el.scrollHeight>el.clientHeight),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(async()=>{summary.account.plan.description='每月真实额度';await MoonYaMembership.refresh();});
    await page.locator('.membership-ledger-toggle').click();await page.locator('.membership-ledger table').waitFor();
    assert.match(await page.locator('.membership-ledger').textContent(),/模型消耗/);
    await page.locator('.membership-ledger .membership-pagination button').last().click();await page.waitForFunction(()=>actions.includes('?action=ledger&page=2'));
    await page.screenshot({path:join(artifacts,'ledger-mobile.png')});
    await page.locator('.membership-back').click();assert.equal(await page.locator('[role="progressbar"]').isVisible(),true);
    await page.locator('.membership-orders-toggle').click();await page.locator('.membership-orders .membership-pagination').waitFor();
    await page.locator('.membership-orders .membership-pagination button').last().click();await page.waitForFunction(()=>actions.includes('?action=orders&page=2'));
    await page.evaluate(()=>{currentUser={id:2};failed=true;window.dispatchEvent(new Event('moonya:auth-state'));});
    await page.waitForFunction(()=>MoonYaMembership.account()===null);assert.equal(await page.locator('#settingsPlanName').textContent(),'免费版');assert.equal(await page.locator('.membership-orders').textContent(),'');
    await page.evaluate(()=>{isLoggedIn=false;window.dispatchEvent(new Event('moonya:auth-state'));});
    await page.locator('.membership-back').click();assert.match(await page.locator('.membership-account').textContent(),/请先登录/);assert.equal(await page.locator('[role="progressbar"]').count(),0);
  }finally{await browser.close();}
});
