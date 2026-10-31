import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../../',import.meta.url));
test('dashboard membership and announcement deep links initialize after the admin script loads',async()=>{
  const html=execFileSync('php',[join(repo,'MoonYa-Backend/admin/dashboard.php')],{encoding:'utf8'});
  const script=await readFile(join(repo,'MoonYa-Backend/admin/assets/membership-admin.js'),'utf8');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const section of ['membershipOrders','membershipPlans','builtinModels','announcements']) {
      const page=await browser.newPage();const errors=[];const requests=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{localStorage.setItem('adminToken','fixture-admin');localStorage.setItem('adminInfo',JSON.stringify({role:'super_admin',username:'fixture'}));});
      await page.route('http://localhost/admin/**',async route=>{
        const url=new URL(route.request().url());
        if(url.pathname.endsWith('/dashboard.php'))return route.fulfill({contentType:'text/html',body:html});
        if(url.pathname.endsWith('/membership-admin.js'))return route.fulfill({contentType:'text/javascript',body:script});
        if(url.pathname.startsWith('/admin/assets/') && url.pathname.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:await readFile(join(repo,'MoonYa-Backend',url.pathname.slice(1)),'utf8')});
        if(url.pathname.includes('/api/')) {
          requests.push(url.pathname);
          return route.fulfill({json:{success:true,data:{items:[],announcements:[],total:0,page:1,configuration:{enabled:false,ready:false,schema_ready:true,missing:[]}}}});
        }
        return route.fulfill({body:''});
      });
      await page.goto('http://localhost/admin/dashboard.php?section='+section);
      const endpoint={membershipOrders:'membership_orders',membershipPlans:'membership_plans',builtinModels:'builtin_models',announcements:'announcements'}[section];
      await page.waitForFunction(section=>document.querySelector('#'+section+'Section').classList.contains('active'),section);
      assert.ok(requests.some(path=>path.endsWith('/'+endpoint+'.php')),section+' must load its data');
      assert.deepEqual(errors,[],section+' must not throw during initialization');
      await page.close();
    }
  } finally {await browser.close();}
});
test('admin orders show configuration, filter/detail/sync operations, and independently editable tier rank',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  try{
    const html=await readFile(join(repo,'MoonYa-Backend/script/dashboard/membership.php'),'utf8');
    await page.route('http://localhost/admin/',r=>r.fulfill({contentType:'text/html',body:'<meta charset="utf-8">'+html+'<div id="modalContent"></div>'}));await page.goto('http://localhost/admin/');
    await page.addStyleTag({path:join(repo,'MoonYa-Backend/admin/assets/admin-ui.css')});
    await page.evaluate(()=>{
      window.token='fixture-admin';window.requests=[];window.showAlert=()=>{};window.hideModal=()=>document.getElementById('modalContent').replaceChildren();window.showModal=html=>document.getElementById('modalContent').innerHTML=html;
      window.plan={id:2,code:'go',name:'GO',is_free:false,price_cents:800,monthly_credits:'300.000000',tier_rank:1,description:'每月积分',features:[],enabled:true,sort_order:1};
      window.order={order_no:'MYadminfixture',user_id:1,plan,amount_cents:800,status:'paid',created_at:'2026-10-03 12:00:00',paid_at:'2026-10-03 12:00:05',purchase:{status:'queued',starts_at:'2026-11-03 12:00:05',ends_at:'2026-12-03 12:00:05'}};
      window.fetch=async(path,options)=>{requests.push({path,method:options.method,body:options.body?JSON.parse(options.body):null,headers:options.headers});let data;
        if(path.startsWith('api/membership_plans.php'))data={items:[plan]};
        else if(path.includes('order_no='))data={order,trade_no:'2026100300000001',configuration:{enabled:false,ready:false,schema_ready:true,missing:['app_id'],environment:'production'}};
        else if(options.method==='POST')data=order;
        else data={items:[order],total:1,page:1,configuration:{enabled:false,ready:false,schema_ready:true,missing:['app_id'],environment:'production'}};
        return {ok:true,json:async()=>({success:true,data})};};
    });
    await page.addScriptTag({path:join(repo,'MoonYa-Backend/admin/assets/membership-admin.js')});
    await page.evaluate(()=>{document.getElementById('membershipOrdersSection').classList.add('active');return loadMembershipOrders();});
    assert.match(await page.locator('#paymentConfigurationState').textContent(),/购买开关关闭/);assert.match(await page.locator('#membershipOrderRows').textContent(),/待生效/);
    await page.locator('#orderSearch').fill('MYadminfixture');await page.locator('#orderUser').fill('1');await page.selectOption('#orderStatus','paid');await page.evaluate(()=>loadMembershipOrders());
    const filter=await page.evaluate(()=>requests.at(-1).path);assert.match(filter,/status=paid/);assert.match(filter,/user_id=1/);
    await page.locator('[data-order-detail]').click();assert.match(await page.locator('#modalContent').textContent(),/2026100300000001/);assert.match(await page.locator('#modalContent').textContent(),/等级 1/);
    await page.locator('[data-order-sync]').click();assert.ok(await page.evaluate(()=>requests.some(r=>r.method==='POST'&&r.body.order_no==='MYadminfixture')));
    await page.evaluate(async()=>{await loadMembershipPlans();editMembershipPlan(0);});assert.equal(await page.locator('#mpRank').inputValue(),'1');await page.locator('#mpRank').fill('9');await page.locator('#memberSave').click();
    await page.waitForFunction(()=>requests.some(r=>r.path==='api/membership_plans.php'&&r.method==='POST'));
    const saved=await page.evaluate(()=>requests.find(r=>r.path==='api/membership_plans.php'&&r.method==='POST').body);assert.equal(saved.tier_rank,9);assert.equal(saved.price_cents,800);assert.equal(saved.sort_order,1);
    const artifacts=join(repo,'MoonYa-Frontend/artifacts/payment');await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'admin-orders.png'),fullPage:true});
  }finally{await browser.close();}
});
