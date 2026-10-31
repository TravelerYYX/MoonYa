import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createServer as createHttpsServer} from 'node:https';
import {createServer as createTlsServer} from 'node:tls';
import {request as httpRequest} from 'node:http';
import {readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
const repo=fileURLToPath(new URL('../../',import.meta.url)),fixtureFile=join(repo,'MoonYa-Backend/tests/payment_http_fixture.php');
function run(args,input){return new Promise((resolve,reject)=>{const p=spawn(process.env.PHP_BIN||'php',[fixtureFile,...args],{cwd:repo,windowsHide:true});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(new Error(err+out));try{resolve(out.trim()?JSON.parse(out):{});}catch(e){reject(new Error(out+err));}});p.stdin.end(input?JSON.stringify(input):undefined);});}
async function cleanup(fixture){if(!fixture)return;await run(['cleanup',fixture.database,fixture.root]);const path=resolve(fixture.root);assert.equal(dirname(path).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(path),/^moonya-payment-http-[a-f0-9]{16}$/);await rm(path,{recursive:true,force:true});}
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}

async function smtpFixture(fixture){
 const messages=[],sockets=new Set();
 const server=createTlsServer({key:await readFile(join(fixture.root,'private.pem')),cert:await readFile(join(fixture.root,'tls.pem'))},socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  let buffer='',state='command',recipient='',message='';socket.write('220 localhost ESMTP fixture\r\n');
  socket.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\r\n'))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
   if(state==='data'){if(line!=='.'){message+=line.replace(/^\.\./,'.')+'\r\n';continue;}
    let body=message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    if(/Content-Transfer-Encoding: base64/i.test(message))body=Buffer.from(body.replace(/\s/g,''),'base64').toString();
    if(/Content-Transfer-Encoding: quoted-printable/i.test(message))body=body.replace(/=\r\n/g,'').replace(/=([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
    const code=body.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1];messages.push({recipient,code,message});state='command';socket.write('250 accepted\r\n');continue;
   }
   if(state==='user'){state='password';socket.write('334 UGFzc3dvcmQ6\r\n');continue;}
   if(state==='password'){state='command';socket.write('235 authenticated\r\n');continue;}
   if(/^EHLO/i.test(line))socket.write('250-localhost\r\n250 AUTH LOGIN\r\n');
   else if(/^AUTH LOGIN/i.test(line)){state='user';socket.write('334 VXNlcm5hbWU6\r\n');}
   else if(/^RCPT TO:/i.test(line)){recipient=line.slice(8).trim();socket.write('250 recipient\r\n');}
   else if(/^DATA$/i.test(line)){state='data';message='';socket.write('354 end with dot\r\n');}
   else if(/^QUIT$/i.test(line))socket.end('221 bye\r\n');
   else socket.write('250 ok\r\n');
  }});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {port:server.address().port,messages,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}};
}

test('payment settings HTTP: password only without email or SMTP, immutable actions, replay and concurrent consumption',async()=>{
 let fixture,server,tlsServer,smtp;
 try{
  fixture=await run(['create']);const p=await port(),base=`http://127.0.0.1:${p}`;smtp=await smtpFixture(fixture);
  assert.equal((await run(['smtp_tls_probe',fixture.database,fixture.root],{port:smtp.port})).rejected,true,'SMTP rejects an untrusted TLS certificate');assert.equal(smtp.messages.length,0);
  tlsServer=createHttpsServer({key:await readFile(join(fixture.root,'private.pem')),cert:await readFile(join(fixture.root,'tls.pem'))},(request,response)=>response.end('{}'));await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));
  const tlsProbe=await run(['query_tls',fixture.database,fixture.root],{port:tlsServer.address().port});assert.equal(tlsProbe.rejected,true);assert.equal(tlsProbe.certificate_error,true);
  await run(['disable_email',fixture.database,fixture.root]);
  server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${p}`,join(repo,'MoonYa-Backend/tests/payment_http_router.php')],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_PAYMENT_TEST_DATABASE:fixture.database,MOONYA_PAYMENT_TEST_ROOT:fixture.root,MOONYA_PAYMENT_TEST_SMTP_PORT:''}});
  let errors='';server.stderr.on('data',c=>errors+=c);for(let i=0;i<100;i++){try{if((await fetch(base+'/ready')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const call=async(action,body,token=fixture.admin_token,extra={})=>{const response=await fetch(base+'/admin/api/payment_settings.php?action='+action,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error(text+'; '+errors);}return {status:response.status,data,headers:response.headers,text};};
  assert.equal((await call('state',null,null)).status,401);assert.equal((await call('state',null,fixture.ordinary_token)).status,403);assert.equal((await call('state',null,fixture.admin_token,{Origin:'https://attacker.invalid'})).status,403);
  const initial=await call('state');assert.equal(initial.status,200);assert.equal(initial.headers.get('cache-control'),'no-store');assert.equal(initial.headers.get('access-control-allow-origin'),null);assert.equal(initial.data.data.configuration.revision,1);assert.equal(initial.data.data.verification.ready,true);assert.ok(!initial.text.includes('BEGIN')&&!initial.text.includes('private.pem'));
  assert.equal((await call('enroll',{password:'fixture-password',authorization:'ignored'})).status,400);
  const operation={operation:'settle',order_numbers:['MY20261003123456fixture']};
  assert.equal((await call('challenge',{operation:'save',configuration:{revision:1,enabled:false}})).status,400);
  assert.equal((await call('save_password',{password:'wrong-password',configuration:{revision:1,enabled:false}})).status,403);
  const changedUrl='https://updated-payment.example.invalid';
  const blocked=await call('save_password',{password:'fixture-password',configuration:{revision:1,enabled:true,public_url:changedUrl}});
  assert.equal(blocked.status,400,blocked.text);assert.match(blocked.data.error,/修改后端地址前必须先关闭购买/);
  const unchanged=(await call('state')).data.data.configuration;
  assert.equal(unchanged.revision,1);assert.equal(unchanged.enabled,true);assert.equal(unchanged.public_url,initial.data.data.configuration.public_url);
  const a=(await call('challenge',operation)).data.data,b=(await call('challenge',operation)).data.data;assert.equal(smtp.messages.length,0);
  assert.equal(initial.data.data.verification.method,'password');
  assert.equal((await call('send_code',{challenge_id:a.challenge_id,password:'fixture-password'})).status,400,'email endpoint is disabled');
  assert.equal((await call('confirm',{challenge_id:a.challenge_id,code:'123456'})).status,400,'code alone cannot authorize an operation');
  assert.equal((await call('confirm',{challenge_id:a.challenge_id,password:'wrong-password'})).status,403);
  assert.equal((await call('confirm',{challenge_id:a.challenge_id,password:'fixture-password',app_id:'2026000000000999'})).status,400);
  const settled=await call('confirm',{challenge_id:a.challenge_id,password:'fixture-password'});assert.equal(settled.status,200,settled.text);assert.equal(settled.data.data.results.length,1);
  const saved=await call('save_password',{password:'fixture-password',configuration:{revision:1,enabled:false,public_url:changedUrl}});assert.equal(saved.status,200,saved.text);assert.equal(saved.data.data.configuration.enabled,false);assert.equal(smtp.messages.length,0);
  assert.equal(saved.data.data.configuration.revision,2);assert.equal(saved.data.data.configuration.public_url,changedUrl);
  assert.equal(saved.data.data.configuration.notify_url,changedUrl+'/api/alipay.php?action=notify');assert.equal(saved.data.data.configuration.return_url,changedUrl+'/api/alipay.php?action=return');
  const persisted=(await call('state')).data.data.configuration;assert.equal(persisted.enabled,false);assert.equal(persisted.public_url,changedUrl);assert.equal(persisted.revision,2);
  assert.equal((await call('save_password',{password:'fixture-password',configuration:{revision:1,enabled:false}})).status,409);
  assert.equal((await call('confirm',{challenge_id:a.challenge_id,password:'fixture-password'})).status,403);assert.equal((await call('confirm',{challenge_id:b.challenge_id,password:'fixture-password'})).status,409);
  assert.equal((await call('challenge',{operation:'import'})).status,400);
  const c=(await call('challenge',operation)).data.data;
  const concurrent=await Promise.all([1,2].map(()=>run(['authorize_password',fixture.database,fixture.root],{challenge_id:c.challenge_id,password:'fixture-password'})));
  assert.equal(concurrent.filter(result=>result.success).length,1,'only one process consumes the same password challenge');
  await run(['reset_for_import',fixture.database,fixture.root]);
  const importedChallenge=await call('challenge',{operation:'import'});assert.equal(importedChallenge.status,200,importedChallenge.text);
  const imported=await call('confirm',{challenge_id:importedChallenge.data.data.challenge_id,password:'fixture-password'});assert.equal(imported.status,200,imported.text);assert.equal(imported.data.data.configuration.imported,true);
  assert.equal((await call('challenge',{operation:'import'})).status,400,'legacy import stays one-time');
  const numbers=await run(['seed_unsettled',fixture.database,fixture.root]),deleteOperation={operation:'force_delete',order_numbers:numbers};
  assert.equal((await call('challenge',deleteOperation,fixture.ordinary_token)).status,403,'only super administrator can force deletion');
  assert.equal((await call('challenge',{operation:'force_delete',order_numbers:[]})).status,400);
  assert.equal((await call('challenge',{operation:'force_delete',order_numbers:[numbers[0],'MY20261003123456missing']})).status,409);
  const deletionChallenge=await call('challenge',deleteOperation);assert.equal(deletionChallenge.status,200,deletionChallenge.text);
  assert.equal((await call('confirm',{challenge_id:deletionChallenge.data.data.challenge_id,password:'wrong-password'})).status,403);
  assert.equal((await run(['inspect',fixture.database,fixture.root])).orders.length,2,'Wrong password keeps orders');
  const deleted=await call('confirm',{challenge_id:deletionChallenge.data.data.challenge_id,password:'fixture-password'});assert.equal(deleted.status,200,deleted.text);assert.equal(deleted.data.data.results.length,2);assert.ok(deleted.data.data.results.every(r=>r.status==='deleted'));
  const deletionState=await run(['inspect',fixture.database,fixture.root]);assert.equal(deletionState.orders.length,0);assert.equal(deletionState.logs.filter(l=>l.action==='payment_order_force_delete').length,2);
  assert.equal((await call('state')).data.data.configuration.blocking_orders,0);
  const limited=(await call('challenge',operation)).data.data;
  for(let i=0;i<5;i++)await call('confirm',{challenge_id:limited.challenge_id,password:'bad-password'});
  assert.equal((await call('confirm',{challenge_id:limited.challenge_id,password:'fixture-password'})).status,429);assert.equal(smtp.messages.length,0);
  assert.ok(!errors.includes('Fatal error'),errors);
 }finally{if(tlsServer)await new Promise(r=>tlsServer.close(r));if(server){server.kill();await new Promise(r=>server.once('exit',r));}if(smtp)await smtp.close();await cleanup(fixture);}
});

test('payment settings UI: password-only save, import and settle, upload and no secret persistence',async()=>{
 let fixture,browser;
 try{
  fixture=await run(['create']);const rendered=await run(['render_page',fixture.database,fixture.root]);
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),requests=[],violations=[];
  page.on('console',msg=>{if(msg.type()==='error'&&msg.text()!=='Failed to load resource: the server responded with a status of 403 (Forbidden)')violations.push(msg.text());});
  const fields=['private_key','public_key','app_cert','alipay_cert','root_cert'];let challengedOperation;
  const config={enabled:false,environment:'production',mode:'public_key',app_id:'2026000000000001',seller_id:'2088000000000001',public_url:'https://payment.example.invalid',revision:1,ready:true,missing:[],blocking_orders:2,imported:false,notify_url:'https://payment.example.invalid/api/alipay.php?action=notify',return_url:'https://payment.example.invalid/api/alipay.php?action=return',materials:Object.fromEntries(fields.map(field=>[field,{configured:true,fingerprint:''}]))};
  await page.addInitScript(()=>{localStorage.setItem('adminToken','isolated-browser-admin');localStorage.setItem('adminInfo',JSON.stringify({role:'super_admin',username:'fixture'}));});
  await page.route('https://payment.example.invalid/admin/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/admin/dashboard.php')return route.fulfill({contentType:'text/html',body:rendered.html});
   if(url.pathname.includes('/assets/')){const name=url.pathname.slice('/admin/assets/'.length);const contentType=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'application/octet-stream';return route.fulfill({contentType,body:await readFile(join(repo,'MoonYa-Backend/admin/assets',name))});}
   if(!url.pathname.endsWith('/api/payment_settings.php'))return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:{items:[],total:0,configuration:{environment:'sandbox',enabled:false,ready:true,schema_ready:true,missing:[]}}})});
   const body=route.request().postDataJSON(),action=url.searchParams.get('action');requests.push({action,body});let data;
   if(action==='state')data={configuration:config,verification:{method:'password',ready:true}};
   else if(action==='challenge'){challengedOperation=body.operation;data={challenge_id:'a'.repeat(64),expires_at:Math.floor(Date.now()/1000)+120,summary:{operation:body.operation,order_numbers:body.order_numbers||[]}};}
   else if((action==='save_password'||action==='confirm')&&body.password!=='fixture-password')return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({success:false,error:'管理员密码无效'})});
   else if(action==='save_password'){config.revision++;data={message:'支付配置已加密保存',configuration:config};}
   else if(action==='confirm'){data={results:[{order_no:'MY20261003123456fixture',status:challengedOperation==='force_delete'?'deleted':'closed'}]};if(challengedOperation==='force_delete')config.blocking_orders=0;}
   else throw new Error('Unexpected request '+action);
   return route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
  });
  await page.goto('https://payment.example.invalid/admin/dashboard.php?section=paymentSettings');await page.waitForFunction(()=>!document.getElementById('save').disabled);
  assert.equal(await page.locator('#app_cert').isVisible(),false);await page.selectOption('#mode','certificate');assert.equal(await page.locator('#app_cert').isVisible(),true);assert.equal(await page.locator('#public_key').isVisible(),false);await page.selectOption('#mode','public_key');
  const privateText='-----BEGIN PRIVATE KEY-----\nISOLATED-UPLOAD-FIXTURE\n-----END PRIVATE KEY-----';
  await page.locator('[data-file="private_key"]').setInputFiles({name:'fixture.pem',mimeType:'text/plain',buffer:Buffer.from(privateText)});assert.equal(await page.locator('#private_key').inputValue(),privateText);
  await page.locator('#save').click();await page.locator('#verification').waitFor({state:'visible'});assert.match(await page.locator('#operationSummary').textContent(),/保存支付配置/);assert.equal(await page.locator('#private_key').inputValue(),'');
  assert.equal(requests.filter(r=>r.action==='challenge').length,0);
  assert.equal(await page.locator('#verifyCode,#emailCodeStep,#resendCode').count(),0);
  await page.locator('#verifyPassword').fill('wrong-password');await page.locator('#confirmVerification').click();await page.waitForFunction(()=>document.getElementById('verifyError').textContent.length>0);
  assert.equal(await page.locator('#verifyCode').count(),0);assert.equal(await page.locator('#verifyPassword').inputValue(),'');
  await page.locator('#verifyPassword').fill('fixture-password');await page.locator('#confirmVerification').click();await page.locator('#verification').waitFor({state:'hidden'});
  const submitted=requests.find(r=>r.action==='save_password'&&r.body.password==='fixture-password').body;assert.equal(submitted.configuration.private_key,privateText);assert.equal(submitted.configuration.revision,1);
  assert.equal(requests.filter(r=>r.action==='send_code'||r.action==='confirm').length,0);
  assert.equal(await page.locator('#verifyPassword').inputValue(),'');assert.equal(await page.locator('#private_key').inputValue(),'');
  config.revision=0;await page.locator('#reload').click();await page.waitForFunction(()=>!document.getElementById('import').disabled);
  for(const operation of ['import','settle']){
   if(operation==='settle')await page.locator('#orderNumbers').fill('MY20261003123456fixture');
   await page.locator('#'+operation).click();await page.locator('#verification').waitFor({state:'visible'});
   assert.doesNotMatch(await page.locator('#verification').textContent(),/验证码|发送邮件/);assert.equal(await page.locator('#confirmVerification').textContent(),'确认并执行操作');
   await page.locator('#verifyPassword').fill('fixture-password');await page.locator('#confirmVerification').click();await page.locator('#verification').waitFor({state:'hidden'});
   const confirmed=requests.filter(r=>r.action==='confirm').at(-1).body;assert.deepEqual(Object.keys(confirmed).sort(),['challenge_id','password']);assert.equal(confirmed.password,'fixture-password');
   assert.equal(await page.locator('#verifyPassword').inputValue(),'');await page.waitForFunction(()=>!document.getElementById('settle').disabled);
  }
  assert.match(await page.locator('#settleResults').textContent(),/MY20261003123456fixture：closed/);assert.equal(requests.filter(r=>r.action==='send_code').length,0);
  await page.locator('#forceDelete').click();await page.locator('#verification').waitFor({state:'visible'});
  assert.match(await page.locator('#operationSummary').textContent(),/强制删除未结清订单/);assert.match(await page.locator('#verificationHint').textContent(),/不会关闭支付宝交易/);assert.equal(await page.locator('#confirmVerification').textContent(),'确认强制删除');
  const confirmations=requests.filter(r=>r.action==='confirm').length;await page.locator('#cancelVerification').click();assert.equal(requests.filter(r=>r.action==='confirm').length,confirmations,'Cancellation submits no deletion');
  await page.locator('#forceDelete').click();await page.locator('#verification').waitFor({state:'visible'});await page.locator('#verifyPassword').fill('wrong-password');await page.locator('#confirmVerification').click();await page.waitForFunction(()=>document.getElementById('verifyError').textContent.length>0);
  assert.equal(await page.locator('#orderNumbers').inputValue(),'MY20261003123456fixture');await page.locator('#verifyPassword').fill('fixture-password');await page.locator('#confirmVerification').click();await page.locator('#verification').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.getElementById('blockingState').textContent.includes('0 笔'));assert.match(await page.locator('#settleResults').textContent(),/已删除/);assert.equal(await page.locator('#orderNumbers').inputValue(),'');
  await page.locator('#private_key').fill('UNSAVED-SECRET');await page.evaluate(()=>switchSection('membershipOrders'));assert.equal(await page.locator('#private_key').inputValue(),'');await page.evaluate(()=>switchSection('paymentSettings'));await page.waitForFunction(()=>!document.getElementById('save').disabled);
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!stored.includes('PRIVATE KEY')&&!stored.includes('fixture-password')&&!stored.includes('123456'));
  const artifacts=join(repo,'MoonYa-Frontend/artifacts/payment');await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'admin-payment-settings.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.main-content').getBoundingClientRect().width>350);await page.screenshot({path:join(artifacts,'admin-payment-settings-mobile.png'),fullPage:true,animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.equal(await page.locator('.sidebar-toggle').isVisible(),true);assert.equal(await page.locator('#alert').textContent(),'');assert.deepEqual(violations,[]);
 }finally{if(browser)await browser.close();await cleanup(fixture);}
});

test('payment settings local development: direct HTTP works and origin, host and proxy bypasses fail',async()=>{
 let fixture,server;
 try{
  fixture=await run(['create']);const p=await port(),base=`http://127.0.0.1:${p}`;
  server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${p}`,join(repo,'MoonYa-Backend/tests/payment_http_router.php')],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_PAYMENT_TEST_DATABASE:fixture.database,MOONYA_PAYMENT_TEST_ROOT:fixture.root,MOONYA_PAYMENT_TEST_HTTP_MODE:'1'}});
  let errors='';server.stderr.on('data',c=>errors+=c);for(let i=0;i<100;i++){try{if((await fetch(base+'/ready')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const redirect=await fetch(base+'/admin/payment_settings.php',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'dashboard.php?section=paymentSettings');
  const call=extra=>fetch(base+'/admin/api/payment_settings.php?action=state',{headers:{Authorization:'Bearer '+fixture.admin_token,Origin:base,...extra}});
  const state=await call();assert.equal(state.status,200);assert.equal((await state.json()).data.configuration.revision,1);assert.equal(state.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(base+'/admin/api/payment_settings.php?action=state')).status,401);
  for(const headers of [{Origin:'http://attacker.invalid'},{Origin:`http://127.0.0.1:${p+1}`},{'X-Forwarded-Proto':'https'},{'X-Forwarded-For':'127.0.0.1'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await call(headers)).status,403,JSON.stringify(headers));
  // fetch normalizes Host; use a raw HTTP request to test a forged authority.
  const forgedHostStatus=await new Promise((resolve,reject)=>{const request=httpRequest(base+'/admin/api/payment_settings.php?action=state',{headers:{Host:'attacker.invalid',Authorization:'Bearer '+fixture.admin_token}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(forgedHostStatus,403);
  assert.ok(!errors.includes('Fatal error'),errors);
 }finally{if(server){server.kill();await new Promise(r=>server.once('exit',r));}await cleanup(fixture);}
});
