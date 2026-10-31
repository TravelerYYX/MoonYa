import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));const php=process.env.PHP_BIN||'php';
function run(args,input){return new Promise((resolve,reject)=>{const p=spawn(php,args,{cwd:repo,windowsHide:true});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error(err+out));try{resolve(out.trim()?JSON.parse(out):{});}catch(error){reject(new Error('Fixture '+args[1]+': '+error.message));}});p.stdin.end(input?JSON.stringify(input):undefined);});}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function removeTestDirectory(path){const target=resolve(path);assert.equal(dirname(target).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(target),/^moonya-payment-(?:http-[a-f0-9]{16}|desktop-[a-zA-Z0-9]+)$/);await rm(target,{recursive:true,force:true});}
test('real HTTP payment flow: auth, CSRF, public checkout, RSA2 callbacks, concurrent fulfillment, admin permissions and desktop gateway',async()=>{
  const fixtureFile=join(repo,'MoonYa-Backend/tests/payment_http_fixture.php');let fixture,server,desktop,dataDir;
  try{
    fixture=await run([fixtureFile,'create']);const port=await freePort(),base=`http://127.0.0.1:${port}`;
    server=spawn(php,['-S',`127.0.0.1:${port}`,join(repo,'MoonYa-Backend/tests/payment_http_router.php')],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_PAYMENT_TEST_DATABASE:fixture.database,MOONYA_PAYMENT_TEST_ROOT:fixture.root}});let errors='';server.stderr.on('data',c=>errors+=c);
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/ready')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Fixture server did not become ready: '+errors);
    const request=async(path,{token='fixture-user',cookie,body,csrf}={})=>{const headers={...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})};if(body)headers['Content-Type']='application/json';const response=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const text=await response.text();try{return {status:response.status,data:JSON.parse(text)};}catch{throw new Error(path+' HTTP '+response.status+' returned invalid JSON: '+text+'; server: '+errors);}};
    assert.equal((await request('/api/membership.php',{token:null})).status,401);
    const summary=(await request('/api/membership.php')).data.data;assert.equal(summary.purchase_enabled,true);
    const session=await fetch(base+'/session');assert.equal(session.status,200,errors);const cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrf;
    assert.equal((await request('/api/membership.php?action=create_order',{token:null,cookie,body:{plan_id:summary.plans[1].id,request_key:'csrf_order_request_123'}})).status,403);
    const first=await request('/api/membership.php?action=create_order',{token:null,cookie,csrf,body:{plan_id:summary.plans[1].id,request_key:'csrf_order_request_123'}});assert.equal(first.status,200);const order=first.data.data.order;
    assert.equal((await request('/api/membership.php?action=order&order_no='+order.order_no,{token:'fixture-other-user'})).status,404);
    const checkout=new URL(first.data.data.checkout_url);const form=await fetch(base+checkout.pathname+checkout.search);assert.equal(form.status,200);assert.match(await form.text(),/alipay\.trade\.page\.pay/);assert.equal(form.headers.get('referrer-policy'),'no-referrer');
    const returnPage=await fetch(base+'/api/alipay.php?action=return&trade_status=TRADE_SUCCESS');assert.equal(returnPage.status,400);assert.match(await returnPage.text(),/无法确认付款/);assert.equal((await request('/api/membership.php')).data.data.account.plan.is_free,true);
    const evidence={app_id:'2026000000000001',seller_id:'2088000000000001',out_trade_no:order.order_no,trade_no:'20261002000000000001',total_amount:'8.00',trade_status:'TRADE_SUCCESS',gmt_payment:'2026-10-02 12:00:00'};
    const signed=await run([fixtureFile,'sign',fixture.database,fixture.root],evidence);
    const {trade_status,gmt_payment,...returnEvidence}=evidence;
    const signedReturn=await run([fixtureFile,'sign',fixture.database,fixture.root],{...returnEvidence,method:'alipay.trade.page.pay.return',charset:'utf-8',timestamp:'2026-10-02 12:00:01',version:'1.0',auth_app_id:evidence.app_id});
    const returned=async(params,json=false)=>fetch(base+'/api/alipay.php?action=return&'+new URLSearchParams(params),{headers:json?{Accept:'application/json'}:{}});
    const pendingReturn=await returned(signedReturn);assert.equal(pendingReturn.status,200);const pendingHtml=await pendingReturn.text();assert.match(pendingHtml,/正在确认付款/);assert.doesNotMatch(pendingHtml,/href="moonya:/);assert.equal((await request('/api/membership.php')).data.data.account.plan.is_free,true);
    assert.equal((await returned({...signed,total_amount:'0.01'})).status,400);
    const badMerchant=await run([fixtureFile,'sign',fixture.database,fixture.root],{...evidence,seller_id:'2088000000000099'});assert.equal((await returned(badMerchant)).status,400);
    const duplicates=await fetch(base+'/api/alipay.php?action=return&'+new URLSearchParams(signed)+'&out_trade_no='+order.order_no);assert.equal(duplicates.status,400);
    const notify=async(params)=>{const r=await fetch(base+'/api/alipay.php?action=notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});return {status:r.status,body:await r.text()};};
    assert.equal((await notify({...signed,total_amount:'0.01'})).body,'failure');assert.equal((await notify(signed)).body,'success');
    assert.equal((await request('/api/membership.php')).data.data.account.balance,'300.000000');
    const successReturn=await returned(signedReturn);assert.equal(successReturn.status,200);const successHtml=await successReturn.text();assert.match(successHtml,/<h1 id="title">付款成功<\/h1>/);assert.match(successHtml,new RegExp('href="moonya://payment/return\\?order_no='+order.order_no+'"'));assert.doesNotMatch(successHtml,/请返回 MoonYa 查询支付结果/);assert.ok(successReturn.headers.get('content-security-policy').includes("script-src 'nonce-"));
    assert.deepEqual(await (await returned(signedReturn,true)).json(),{state:'paid',open_url:'moonya://payment/return?order_no='+order.order_no});
    const second=(await request('/api/membership.php?action=create_order',{body:{plan_id:summary.plans[1].id,request_key:'renew_http_request_123'}})).data.data.order;
    const signedSecond=await run([fixtureFile,'sign',fixture.database,fixture.root],{...evidence,out_trade_no:second.order_no,trade_no:'20261002000000000002'});
    const results=await Promise.all(Array.from({length:8},()=>run([fixtureFile,'notify',fixture.database,fixture.root],signedSecond)));assert.ok(results.every(r=>r.status==='paid'));
    const inspected=await run([fixtureFile,'inspect',fixture.database,fixture.root]);assert.equal(inspected.purchases,2);assert.equal(inspected.account.queued_purchases.length,1);assert.equal(inspected.account.balance,'300.000000');
    assert.equal((await request('/admin/api/membership_orders.php',{token:null})).status,401);assert.equal((await request('/admin/api/membership_orders.php',{token:'invalid-admin-token'})).status,401);
    const admin=(await request('/admin/api/membership_orders.php?status=paid',{token:fixture.admin_token})).data.data;assert.equal(admin.total,2);assert.ok(!JSON.stringify(admin).includes('private.pem'));
    const third=(await request('/api/membership.php?action=create_order',{body:{plan_id:summary.plans[2].id,request_key:'query_http_request_123'}})).data.data.order;
    await run([fixtureFile,'query_response',fixture.database,fixture.root],{...evidence,out_trade_no:third.order_no,trade_no:'20261002000000000003',total_amount:'40.00'});
    const signedThird=await run([fixtureFile,'sign',fixture.database,fixture.root],{...evidence,out_trade_no:third.order_no,trade_no:'20261002000000000003',total_amount:'40.00'});
    assert.equal((await (await returned(signedThird,true)).json()).state,'paid','Return query confirms payment even before an asynchronous notification');
    assert.equal((await request('/api/membership.php?action=sync_order',{body:{order_no:third.order_no}})).data.data.status,'paid');
    assert.equal((await request('/api/membership.php')).data.data.account.balance,'1800.000000');
    assert.equal((await request('/admin/api/membership_orders.php',{token:fixture.admin_token,body:{order_no:third.order_no}})).status,200);
    const logs=(await run([fixtureFile,'inspect',fixture.database,fixture.root])).logs;assert.ok(logs.some(l=>l.action==='membership_order_sync'));
    // The desktop's existing remote membership route must carry POST bodies and user tokens.
    dataDir=await mkdtemp(join(tmpdir(),'moonya-payment-desktop-'));const dll=join(repo,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll');
    desktop=spawn('dotnet',[dll,join(repo,'MoonYa-Frontend/dist'),base,'http://127.0.0.1:1'],{windowsHide:true,env:{...process.env,MOONYA_SMOKE_DATA:dataDir}});
    const host=await new Promise((resolve,reject)=>{let output='';desktop.stdout.on('data',c=>{output+=c;try{resolve(JSON.parse(output.trim()));}catch{}});desktop.on('error',reject);desktop.on('exit',code=>reject(new Error('desktop exited '+code)));});
    const proxied=await fetch(host.url+'gateway/remote/api/membership.php?action=sync_order',{method:'POST',headers:{'X-MoonYa-Gateway':host.token,Authorization:'Bearer fixture-user','Content-Type':'application/json'},body:JSON.stringify({order_no:third.order_no})});assert.equal(proxied.status,200);const proxyText=await proxied.text();assert.ok(proxyText,errors);assert.equal(JSON.parse(proxyText).data.status,'paid');
    const other=(await request('/api/membership.php?action=create_order',{token:'fixture-other-user',body:{plan_id:summary.plans[1].id,request_key:'desktop_delete_request_123'}})).data.data.order;
    await run([fixtureFile,'query_response',fixture.database,fixture.root],{...evidence,out_trade_no:other.order_no,trade_no:'20261004000000000004',trade_status:'TRADE_CLOSED'});
    const deleted=await fetch(host.url+'gateway/remote/api/membership.php?action=delete_order',{method:'POST',headers:{'X-MoonYa-Gateway':host.token,Authorization:'Bearer fixture-other-user','Content-Type':'application/json'},body:JSON.stringify({order_no:other.order_no})});assert.equal(deleted.status,200);assert.equal((await deleted.json()).data.deleted,true);
    assert.equal((await fetch(host.url+'gateway/remote/api/alipay.php?action=notify',{headers:{'X-MoonYa-Gateway':host.token}})).status,404);
    assert.equal((await fetch(host.url+'gateway/remote/api/membership.php',{method:'DELETE',headers:{'X-MoonYa-Gateway':host.token}})).status,405);
    assert.ok(!errors.includes('Fatal error'),errors);
  }finally{
    if(desktop){desktop.stdin.end('\n');await new Promise(r=>desktop.once('exit',r));}
    if(server){server.kill();await new Promise(r=>server.once('exit',r));}
    if(fixture){await run([fixtureFile,'cleanup',fixture.database,fixture.root]);await removeTestDirectory(fixture.root);}if(dataDir)await removeTestDirectory(dataDir);
  }
});

test('user deletion HTTP protects ownership and CSRF, retains records and honors late verified payments',async()=>{
  const fixtureFile=join(repo,'MoonYa-Backend/tests/payment_http_fixture.php');let fixture,server,errors='';
  try{
    fixture=await run([fixtureFile,'create']);const port=await freePort(),base=`http://127.0.0.1:${port}`;
    server=spawn(php,['-S',`127.0.0.1:${port}`,join(repo,'MoonYa-Backend/tests/payment_http_router.php')],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_PAYMENT_TEST_DATABASE:fixture.database,MOONYA_PAYMENT_TEST_ROOT:fixture.root}});
    server.stderr.on('data',chunk=>errors+=chunk);
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/ready')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
    const request=async(action,body,{token='fixture-user',cookie,csrf}={})=>{
      const response=await fetch(base+'/api/membership.php'+(action?'?action='+action:''),{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
      return {status:response.status,data:await response.json()};
    };
    const summary=(await request()).data.data;
    const session=await fetch(base+'/session'),cookie=session.headers.get('set-cookie').split(';')[0],csrf=(await session.json()).csrf;
    const key='delete_http_request_123';const created=(await request('create_order',{plan_id:summary.plans[1].id,request_key:key})).data.data;const number=created.order.order_no;
    assert.equal(created.order.can_delete,true);
    assert.equal((await request('delete_order',{order_no:number},{token:null})).status,401);
    assert.equal((await request('delete_order',{order_no:number},{token:null,cookie})).status,403);
    assert.equal((await request('delete_order',{order_no:number},{token:'fixture-other-user'})).status,404);
    assert.equal((await request('delete_order',{order_no:123})).status,400);
    const firstDeletion=await request('delete_order',{order_no:number},{token:null,cookie,csrf});assert.equal(firstDeletion.status,200,JSON.stringify(firstDeletion.data)+errors);assert.equal(firstDeletion.data.data.deleted,true);
    assert.equal((await request('delete_order',{order_no:number})).data.data.deleted,true);
    assert.equal((await request('orders')).data.data.total,0);
    const adminList=await fetch(base+'/admin/api/membership_orders.php?user_id=1',{headers:{Authorization:'Bearer '+fixture.admin_token}});assert.equal((await adminList.json()).data.total,1);
    assert.equal((await request('resume_order',{order_no:number})).status,409);
    assert.equal((await request('create_order',{plan_id:summary.plans[1].id,request_key:key})).status,409);
    const checkout=new URL(created.checkout_url);assert.equal((await fetch(base+checkout.pathname+checkout.search)).status,400);
    assert.equal((await run([fixtureFile,'inspect',fixture.database,fixture.root])).orders.length,1);
    assert.equal((await request('create_order',{plan_id:summary.plans[1].id,request_key:'delete_http_next_12345'})).status,200);
    const evidence={app_id:'2026000000000001',seller_id:'2088000000000001',out_trade_no:number,trade_no:'20261004000000000001',total_amount:'8.00',trade_status:'TRADE_SUCCESS',gmt_payment:'2026-10-04 12:00:00'};
    const signed=await run([fixtureFile,'sign',fixture.database,fixture.root],evidence);
    for(let i=0;i<2;i++){const response=await fetch(base+'/api/alipay.php?action=notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(signed)});assert.equal(await response.text(),'success');}
    const orders=(await request('orders')).data.data;assert.equal(orders.total,2);assert.equal(orders.items.find(o=>o.order_no===number).status,'paid');assert.equal(orders.items.find(o=>o.order_no===number).can_delete,false);
    assert.equal((await request('delete_order',{order_no:number})).status,409);assert.equal((await run([fixtureFile,'inspect',fixture.database,fixture.root])).purchases,1);
  }finally{
    if(server){server.kill();await new Promise(r=>server.once('exit',r));}
    if(fixture){await run([fixtureFile,'cleanup',fixture.database,fixture.root]);await removeTestDirectory(fixture.root);}
  }
});
