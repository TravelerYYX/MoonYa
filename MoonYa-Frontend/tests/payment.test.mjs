import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const modal='.membership-dialog-overlay';
async function setup(page){
  await page.route('http://localhost/',route=>route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body style="font-family:Arial"><div id="accountMenu"><b id="accountMenuPlan"></b><small id="accountMenuCredits"></small><button id="accountMenuUpgrade">升级套餐</button></div></body>'}));
  await page.goto('http://localhost/');await page.addStyleTag({content:await readFile(join(root,'src/styles/css-30-membership.css'),'utf8')});await page.addStyleTag({path:join(root,'../MoonYa-Backend/admin/assets/system-dialog.css')});await page.addScriptTag({path:join(root,'src/ui-icons.js')});
  await page.evaluate(()=>{
    window.currentUser={id:1};window.isLoggedIn=true;window.MoonYaClient={refreshConfig:async()=>{}};
    const plans=['免费版','GO','Plus','Pro','Max'].map((name,i)=>({id:i+1,code:['free','go','plus','pro','max'][i],name,is_free:i===0,tier_rank:i,price_cents:[0,800,4000,6000,8800][i],monthly_credits:[100,300,1500,2400,3600][i],features:[],description:'每月积分额度'}));
    window.summary={account:{plan:plans[0],balance:'100.000000',resets_at:'2026-11-02 12:00:00',expires_at:null,queued_purchases:[]},plans,purchase_enabled:true,csrf_token:'fixture-csrf'};
    window.calls=[];window.orders=[];window.opens=[];window.createFailure=false;window.paid=false;window.deleted=[];
    window.open=url=>{opens.push(url);return null;};window.confirm=()=>{throw new Error('Native confirmation must not be used');};
    window.fetch=async(path,options)=>{
      const action=new URL(path,location.href).searchParams.get('action')||'summary';const body=options?.body?JSON.parse(options.body):null;calls.push({action,body,headers:options?.headers});
      if(action==='summary')return {ok:true,json:async()=>({success:true,data:summary})};
      if(action==='create_order'){
        if(window.holdCreate)return await new Promise(resolve=>window.releaseCreate=resolve);
        if(createFailure){createFailure=false;throw new Error('连接不可用');}
        if(!orders.length)orders.push({order_no:'MYfixture0000000001',plan:plans.find(p=>p.id===body.plan_id),amount_cents:800,status:'pending',purchase:null,can_delete:true});
        return {ok:true,json:async()=>({success:true,data:{order:orders[0],checkout_url:'https://payment.example.invalid/api/alipay.php?action=checkout&token=fixture'}})};
      }
      if(action==='resume_order'){
        if(window.holdResume)return await new Promise(resolve=>window.releaseResume=resolve);
        return {ok:true,json:async()=>({success:true,data:{order:orders[0],checkout_url:'https://payment.example.invalid/api/alipay.php?action=checkout&token=fixture'}})};
      }
      if(action==='orders'){const page=Number(new URL(path,location.href).searchParams.get('page')||1);return {ok:true,json:async()=>({success:true,data:{items:orders.slice((page-1)*20,page*20),page,total:orders.length}})};}
      if(action==='sync_order'){
        if(window.syncFailure){window.syncFailure=false;throw new Error('查单失败');}
        if(paid){orders[0].status='paid';orders[0].can_delete=false;orders[0].purchase={status:'active',starts_at:'2026-10-02 12:00:00',ends_at:'2026-11-02 12:00:00'};summary.account={...summary.account,plan:orders[0].plan,balance:'300.000000',expires_at:'2026-11-02 12:00:00'};}
        return {ok:true,json:async()=>({success:true,data:orders[0]})};
      }
      if(action==='delete_order'){
        if(window.deleteFailure){window.deleteFailure=false;throw new Error('关单失败');}
        deleted.push(body.order_no);orders=orders.filter(o=>o.order_no!==body.order_no);
        return {ok:true,json:async()=>({success:true,data:{order_no:body.order_no,deleted:true}})};
      }
      throw new Error('Unexpected action '+action);
    };
  });
  await page.addScriptTag({path:join(root,'src/membership.js')});await page.waitForFunction(()=>MoonYaMembership.account());await page.locator('#accountMenuUpgrade').click();
}
async function buy(page,index=1){await page.locator('.membership-subscribe').nth(index).click();await page.locator(modal+' .membership-dialog-primary').click();}
async function dismiss(page){await page.locator('.membership-dialog-close').click();}

test('desktop payment return refreshes membership and displays the verified success result',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try{
    await setup(page);await buy(page);await page.locator('.membership-dialog-secondary').waitFor();
    await page.evaluate(async()=>{paid=true;MoonYaMembership.close();await MoonYaMembership.paymentReturn(orders[0].order_no);});
    assert.equal(await page.locator('#membershipDialogTitle').textContent(),'支付成功');assert.match(await page.locator('#membershipDialogMessage').textContent(),/会员信息已更新/);
    assert.equal(await page.evaluate(()=>MoonYaMembership.account().plan.name),'GO');assert.equal(await page.evaluate(()=>MoonYaMembership.account().balance),'300.000000');
    assert.equal(await page.locator('.membership-overlay').isVisible(),true);
    const before=await page.evaluate(()=>calls.length);await page.evaluate(()=>MoonYaMembership.paymentReturn('https://evil.invalid/'));assert.equal(await page.evaluate(()=>calls.length),before);
    await page.evaluate(async()=>{MoonYaMembership.close();isLoggedIn=false;window.dispatchEvent(new Event('moonya:auth-state'));await MoonYaMembership.paymentReturn(orders[0].order_no);});
    assert.equal(await page.locator(modal).isVisible(),true);assert.match(await page.locator('#membershipDialogMessage').textContent(),/请先登录/);
    await page.evaluate(()=>{isLoggedIn=true;window.dispatchEvent(new Event('moonya:auth-state'));});await page.waitForFunction(()=>document.getElementById('membershipDialogTitle').textContent==='支付成功');
  }finally{await browser.close();}
});

test('free tier, current membership, custom purchase confirmation, payment actions, and responsive black dialogs',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  try{
    await setup(page);assert.deepEqual(await page.locator('.membership-card h3').allTextContents(),['免费版','GO','Plus','Pro','Max']);
    assert.deepEqual(await page.locator('.membership-subscribe').allTextContents(),['已开通','开通','开通','开通','开通']);assert.equal(await page.locator('.membership-subscribe').first().isDisabled(),true);
    assert.equal(await page.locator('.membership-card.current h3').textContent(),'免费版');assert.equal(await page.locator('.membership-current').textContent(),'已开通');
    assert.equal(new Set(await page.locator('.membership-card').evaluateAll(cards=>cards.map(c=>c.getBoundingClientRect().y))).size,1);
    await page.locator('.membership-subscribe').nth(1).click();assert.match(await page.locator('#membershipDialogMessage').textContent(),/免费版剩余积分结束/);await page.locator('.membership-dialog-cancel').click();assert.equal(await page.evaluate(()=>calls.some(c=>c.action==='create_order')),false);
    await page.evaluate(()=>createFailure=true);await buy(page);await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent==='连接不可用');await dismiss(page);
    await buy(page);await page.locator('.membership-dialog-secondary').waitFor();
    const creates=await page.evaluate(()=>calls.filter(c=>c.action==='create_order'));assert.equal(creates.length,2);assert.equal(creates[0].body.request_key,creates[1].body.request_key);assert.equal(creates[0].headers['X-CSRF-Token'],'fixture-csrf');
    assert.equal(await page.locator('.membership-payment-status').count(),0);assert.equal(await page.evaluate(()=>opens.length),0);
    await page.locator('.membership-dialog-primary').click();assert.equal(await page.evaluate(()=>opens.length),1);
    await page.locator('.membership-dialog-secondary').click();await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent.includes('尚未确认付款'));assert.equal(await page.locator('.membership-dialog-secondary').isEnabled(),true);
    assert.equal(await page.locator('.membership-dialog').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');
    const artifacts=join(root,'artifacts/payment');await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'checkout-desktop.png')});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const box=await page.locator('.membership-dialog').boundingBox();assert.ok(box.x>=16&&box.x+box.width<=374);await page.screenshot({path:join(artifacts,'checkout-mobile.png')});
    await page.locator('.membership-dialog-close').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'我已完成支付');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.className),'membership-dialog-close');
    await page.keyboard.press('Escape');assert.equal(await page.locator(modal).isVisible(),false);assert.equal(await page.locator('.membership-overlay').isVisible(),true);assert.equal(await page.locator('.membership-page').evaluate(el=>el.inert),false);
    await page.locator('[data-resume]').click();await page.locator('.membership-dialog-secondary').waitFor();assert.equal(await page.evaluate(()=>opens.length),1);
    await page.evaluate(()=>syncFailure=true);await page.locator('.membership-dialog-secondary').click();await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent==='查单失败');assert.equal(await page.locator('.membership-dialog-secondary').isEnabled(),true);
    await page.evaluate(()=>paid=true);await page.locator('.membership-dialog-secondary').click();await page.waitForFunction(()=>MoonYaMembership.account().balance==='300.000000');await page.waitForFunction(()=>document.getElementById('membershipDialogTitle').textContent==='支付成功');
    assert.equal(await page.locator('.membership-card.current h3').textContent(),'GO');assert.deepEqual(await page.locator('.membership-subscribe').allTextContents(),['免费版','续费','升级','升级','升级']);assert.equal(await page.locator('[data-delete]').count(),0);
    await dismiss(page);await page.locator('.membership-subscribe').nth(2).click();assert.match(await page.locator('#membershipDialogMessage').textContent(),/原剩余天数作废/);await page.locator('.membership-dialog-cancel').click();
    await page.evaluate(()=>{summary.account.queued_purchases=[{plan:summary.plans[2],starts_at:'2026-11-02',ends_at:'2026-12-02'}];return MoonYaMembership.refresh();});assert.equal(await page.locator('.membership-card.current h3').textContent(),'GO');
    await page.evaluate(()=>{summary.account.plan=summary.plans[0];summary.account.expires_at=null;return MoonYaMembership.refresh();});assert.equal(await page.locator('.membership-card.current h3').textContent(),'免费版');
    await page.setViewportSize({width:1000,height:1000});const positions=await page.locator('.membership-card').evaluateAll(cards=>cards.map(c=>c.getBoundingClientRect().y));assert.equal(positions[0],positions[1]);assert.ok(positions[2]>positions[1]);
  }finally{await browser.close();}
});

test('automatic polling remains quiet while unpaid and announces confirmed payment only once',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try{
    await setup(page);await page.clock.install();await buy(page);await page.locator('.membership-dialog-secondary').waitFor();await dismiss(page);
    await page.clock.runFor(5100);await page.waitForFunction(()=>calls.some(c=>c.action==='sync_order'));assert.equal(await page.locator(modal).isVisible(),false);
    await page.evaluate(()=>paid=true);await page.clock.runFor(5100);await page.waitForFunction(()=>document.getElementById('membershipDialogTitle').textContent==='支付成功');await dismiss(page);
    await page.clock.runFor(11000);assert.equal(await page.locator(modal).isVisible(),false);
    await page.keyboard.press('Escape');const count=await page.evaluate(()=>calls.filter(c=>c.action==='sync_order').length);await page.clock.runFor(20000);assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='sync_order').length),count);
  }finally{await browser.close();}
});

test('order deletion confirms, preserves failures, clears request keys and allows a new purchase',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try{
    await setup(page);await buy(page);await page.locator('.membership-dialog-secondary').waitFor();await dismiss(page);
    await page.locator('[data-delete]').click();await page.locator('.membership-dialog-cancel').click();assert.equal(await page.evaluate(()=>calls.some(c=>c.action==='delete_order')),false);
    await page.evaluate(()=>deleteFailure=true);await page.locator('[data-delete]').click();await page.locator('.membership-dialog-primary').click();await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent==='关单失败');assert.equal(await page.locator('[data-delete]').count(),1);await dismiss(page);
    await page.locator('[data-delete]').click();await page.locator('.membership-dialog-primary').click();await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent==='订单已删除。');await page.waitForFunction(()=>document.querySelectorAll('[data-delete]').length===0);await dismiss(page);
    await buy(page);await page.locator('.membership-dialog-secondary').waitFor();const keys=await page.evaluate(()=>calls.filter(c=>c.action==='create_order').map(c=>c.body.request_key));assert.notEqual(keys[0],keys[1]);
  }finally{await browser.close();}
});

test('closed dialogs, closed pages and previous accounts cannot show late checkout results',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try{
    await setup(page);await page.evaluate(()=>holdCreate=true);await buy(page);await page.waitForFunction(()=>typeof releaseCreate==='function');
    await page.evaluate(()=>{currentUser={id:2};window.dispatchEvent(new Event('moonya:auth-state'));releaseCreate({ok:true,json:async()=>({success:true,data:{order:{status:'pending'},checkout_url:'https://payment.example.invalid/api/alipay.php?action=checkout&token=old'}})});});
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>opens.length),0);assert.equal(await page.locator('.membership-orders').textContent(),'');assert.equal(await page.locator(modal).isVisible(),false);
    await page.evaluate(()=>holdCreate=false);await buy(page);await page.locator('.membership-dialog-secondary').waitFor();await dismiss(page);
    await page.evaluate(()=>holdResume=true);await page.locator('[data-resume]').click();await page.waitForFunction(()=>typeof releaseResume==='function');await dismiss(page);
    await page.evaluate(()=>releaseResume({ok:true,json:async()=>({success:true,data:{order:orders[0],checkout_url:'https://payment.example.invalid/api/alipay.php?action=checkout&token=old'}})}));await page.waitForTimeout(100);assert.equal(await page.locator(modal).isVisible(),false);
    await page.locator('[data-resume]').click();await page.waitForFunction(()=>document.getElementById('membershipDialogMessage').textContent==='正在准备付款…');await page.evaluate(()=>MoonYaMembership.close());
    await page.evaluate(()=>releaseResume({ok:true,json:async()=>({success:true,data:{order:orders[0],checkout_url:'https://payment.example.invalid/api/alipay.php?action=checkout&token=old'}})}));await page.waitForTimeout(100);assert.equal(await page.locator('.membership-overlay').isVisible(),false);
    await page.evaluate(()=>{holdResume=false;return MoonYaMembership.open('orders');});await page.locator('[data-resume]').click();await page.locator('.membership-dialog-secondary').waitFor();await dismiss(page);
    await page.evaluate(()=>{summary.purchase_enabled=false;summary.purchase_message='购买暂未开放（支付宝配置尚未完成）';return MoonYaMembership.refresh();});assert.equal(await page.locator('.membership-subscribe:disabled').count(),5);assert.match(await page.locator('.membership-note').textContent(),/支付宝配置尚未完成/);
  }finally{await browser.close();}
});

test('deleting the last order on the final page returns to a valid page',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
  try{
    await setup(page);await page.evaluate(()=>{orders=Array.from({length:21},(_,i)=>({order_no:'MYpagination000000'+i,plan:summary.plans[1],amount_cents:800,status:'expired',purchase:null,can_delete:true}));return MoonYaMembership.open('orders');});
    await page.locator('.membership-orders .membership-pagination button').last().click();await page.waitForFunction(()=>document.querySelector('.membership-orders .membership-pagination span').textContent==='2');assert.equal(await page.locator('[data-delete]').count(),1);
    await page.locator('[data-delete]').click();await page.locator('.membership-dialog-primary').click();await page.waitForFunction(()=>document.querySelector('.membership-orders .membership-pagination span').textContent==='1');assert.equal(await page.locator('[data-delete]').count(),20);assert.equal(await page.locator('.membership-orders .membership-pagination button').last().isDisabled(),true);
  }finally{await browser.close();}
});
