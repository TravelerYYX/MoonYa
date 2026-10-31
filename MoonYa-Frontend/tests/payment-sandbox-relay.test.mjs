import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
function run(args,input){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.PHP_BIN||'php',[join(repo,'MoonYa-Backend/tests/payment_http_fixture.php'),...args],{cwd:repo,windowsHide:true});let out='',err='';
 child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',code=>{if(code)return reject(new Error(err+out));try{resolve(out.trim()?JSON.parse(out):{});}catch(error){reject(error);}});child.stdin.end(input?JSON.stringify(input):undefined);
});}
async function start(fixture,optIn){
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const router=join(fixture.root,'sandbox-test-router.php');
 const originRoot=join(fixture.root,'empty-origin');await mkdir(originRoot,{recursive:true});
 await writeFile(router,`<?php $saved=[];foreach(['DB_NAME','JWT_SECRET','PAYMENT_MASTER_KEY_FILE']as$key)$saved[$key]=getenv($key);require '${join(repo,'MoonYa-Backend/env_loader.php').replaceAll('\\','/')}';foreach($saved as$key=>$value)putenv($key.'='.$value);putenv('MOONYA_SERVER_DATA_ROOT=${join(fixture.root,'server').replaceAll('\\','/')}');require '${join(repo,'tools/payment_sandbox_relay.php').replaceAll('\\','/')}';`);
 const server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${port}`,'-t',originRoot,router],{cwd:fixture.root,windowsHide:true,env:{...process.env,DB_NAME:fixture.database,JWT_SECRET:'isolated-sandbox-relay-secret-32-characters',PAYMENT_MASTER_KEY_FILE:join(fixture.root,'keys/master-keyring.json'),MOONYA_PAYMENT_SANDBOX_RELAY:optIn?'1':''}});
 let errors='';server.stderr.on('data',c=>errors+=c);const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{await fetch(base);return {base,errors:()=>errors,close:async()=>{server.kill();await new Promise(r=>server.once('exit',r));}};}catch{}await new Promise(r=>setTimeout(r,50));}
 server.kill();throw new Error('Sandbox relay did not start');
}
test('sandbox tunnel origin allows payment endpoints only and refuses production and forged notifications',async()=>{
 let fixture,relay,disabled;
 try{
  fixture=await run(['create']);relay=await start(fixture,true);disabled=await start(fixture,false);
  assert.equal((await fetch(disabled.base+'/api/alipay.php?action=return')).status,404);
  for(const path of ['/', '/.env','/admin/payment_settings.php','/admin/api/payment_settings.php?action=state','/Services/PaymentCrypto.php','/vendor/autoload.php','/sql/payment_security_cli.php','/api/membership.php','/api/alipay.php?action=unknown','/api/alipay.php?action[]=return','/api/alipay.php?action=return&action=return']){
   const response=await fetch(relay.base+path);assert.ok([400,404].includes(response.status),path);assert.equal(await response.text(),'');
  }
  const returned=await fetch(relay.base+'/api/alipay.php?action=return');assert.equal(returned.status,400,await returned.clone().text()+' '+relay.errors());assert.match(await returned.text(),/无法确认付款/);assert.equal(returned.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(relay.base+'/api/alipay.php?action=notify')).status,405);
  assert.equal((await fetch(relay.base+'/api/alipay.php?action=return',{method:'POST'})).status,405);
  assert.equal((await fetch(relay.base+'/api/alipay.php?action=checkout&token=bad')).status,400);
  const forged=await fetch(relay.base+'/api/alipay.php?action=notify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'sign=forged&sign_type=RSA2'});assert.equal(forged.status,400);assert.equal(await forged.text(),'failure');
  assert.equal((await fetch(relay.base+'/api/alipay.php?action=notify',{method:'POST',body:'a'.repeat(65537)})).status,400);
  assert.equal((await run(['inspect',fixture.database,fixture.root])).purchases,0);
  assert.equal((await run(['probe_sandbox_environment',fixture.database,fixture.root])).rejected,true,'Environment rechecked under the payment lock after configuration changes');
  for(const action of ['return','checkout','notify'])assert.equal((await fetch(relay.base+'/api/alipay.php?action='+action,{method:action==='notify'?'POST':'GET'})).status,503,'Never exposes a production merchant');
  assert.ok(!relay.errors().includes('Fatal error'));
 }finally{
  if(relay)await relay.close();if(disabled)await disabled.close();
  if(fixture){await run(['cleanup',fixture.database,fixture.root]);const path=resolve(fixture.root);assert.equal(dirname(path).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(path),/^moonya-payment-http-[a-f0-9]{16}$/);await rm(path,{recursive:true,force:true});}
 }
});
