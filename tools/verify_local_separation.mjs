import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../MoonYa-Frontend/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const backend=process.argv[2]||'http://localhost/';
assert.ok(['localhost','127.0.0.1'].includes(new URL(backend).hostname),'This verification is limited to a local PHP server');
const fixture=await mkdtemp(join(tmpdir(),'moonya-local-separation-'));
const nativeData=await mkdtemp(join(tmpdir(),'moonya-local-identity-'));
const profile=await mkdtemp(join(tmpdir(),'moonya-local-profile-'));
const username='codex_local_auth_'+randomBytes(6).toString('hex'),password=randomBytes(24).toString('hex');
let id,host,runtime,context;
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const runtimePort=await freePort();
async function startHost(port){
 const child=spawn('dotnet',[join(root,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),join(root,'MoonYa-Frontend/dist'),backend,'http://127.0.0.1:'+runtimePort+'/',...(port?[String(port)]:[])],{env:{...process.env,MOONYA_SMOKE_DATA:nativeData},windowsHide:true});
 let errors='';child.stderr.on('data',c=>errors+=c);
 const info=await new Promise((r,j)=>{createInterface({input:child.stdout}).once('line',s=>r(JSON.parse(s)));child.once('exit',()=>j(new Error('Native host failed: '+errors)));});
 return {...info,child,stop:()=>new Promise(r=>{child.once('exit',r);child.stdin.end('\n');})};
}
function frames(text){return text.split(/\r?\n/).filter(l=>l.startsWith('data: ')).flatMap(l=>{try{return[JSON.parse(l.slice(6))];}catch{return[];}});}
try{
 const registered=await(await fetch(new URL('user_auth.php?action=register',backend),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).json();
 assert.equal(registered.success,true,'Local PHP registration failed: '+(registered.error||''));id=registered.data.user.id;
 host=await startHost();
 context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true});let page=await context.newPage();await page.goto(host.url);
 await page.locator('#qqLoginBtn').click();await page.locator('#loginAccount').fill(username);await page.locator('#loginPassword').fill(password);await page.locator('#loginBtn').click();await page.waitForFunction(()=>isLoggedIn,{},{timeout:15000});
 assert.equal(await page.evaluate(()=>currentUser.id),Number(id));
 await page.reload();await page.waitForFunction(()=>isLoggedIn,{},{timeout:15000});
 console.log('PASS: actual PHP login, native gateway and frontend refresh retain the account');
 const port=new URL(host.url).port;await context.close();context=null;await host.stop();host=await startHost(port);
 context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true});page=await context.newPage();await page.goto(host.url);await page.waitForFunction(()=>isLoggedIn,{},{timeout:15000});
 console.log('PASS: actual PHP identity remains valid after both frontend and native-host restart');
 runtime=spawn(process.execPath,['src/server.mjs'],{cwd:join(root,'MoonYa-Harness'),windowsHide:true,env:{...process.env,MOONYA_DATA_ROOT:fixture,MOONYA_HARNESS_DATA:join(fixture,'runtime'),MOONYA_HARNESS_PORT:String(runtimePort),MOONYA_FRONTEND_URL:host.url.replace(/\/$/,''),MOONYA_FRONTEND_SECRET:host.runtimeSecret,MOONYA_FRONTEND_DEFAULTS:join(root,'MoonYa-Frontend/dist/defaults.json'),MOONYA_SKILLS_ROOT:join(root,'MoonYa-Backend/skills')},stdio:['ignore','pipe','pipe']});runtime.stdout.resume();runtime.stderr.resume();
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:'+runtimePort+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));if(i===99)throw new Error('Local Runtime startup failed');}
 const chat=await page.evaluate(async messageId=>{const r=await fetch('/api.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'只回复四个字：联调成功。不要执行任务或使用工具。',client_message_id:messageId,modelType:'deepseek',deepThinking:false})});return{status:r.status,text:await r.text()};},randomUUID());
 const chatFrames=frames(chat.text);assert.equal(chat.status,200);assert.ok(chatFrames.some(f=>f.type==='content'&&f.content),'Builtin Chat returned no content: '+JSON.stringify(chatFrames.filter(f=>f.type==='error')));
 console.log('PASS: actual PHP Chat streams a real supplier response through the frontend gateway');
 const work=await page.evaluate(async input=>{const r=await fetch('/harness_api.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(120000)});return{status:r.status,text:await r.text()};},{message:'这是本地连通性测试。不要使用任何工具、浏览器、桌面或文件操作，只回复四个字：联调成功。',project_path:fixture,client_message_id:randomUUID(),client_chat_id:'local-integration-work',reasoningProfile:'high'});
 const workFrames=frames(work.text);assert.equal(work.status,200);assert.ok(workFrames.some(f=>f.type==='content'&&f.content),'Work returned no content: '+JSON.stringify(workFrames.filter(f=>f.type==='error')));assert.ok(workFrames.some(f=>f.type==='done'));
 const session=workFrames.find(f=>f.type==='harness_session')?.session_id;assert.ok(session);
 const office=await page.evaluate(async input=>{const r=await fetch('/harness_api.php?action=office_state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:r.status,body:await r.json()};},{session_id:session,project_path:fixture});
 assert.equal(office.status,200);assert.equal(office.body.success,true);
 console.log('PASS: real builtin Work executes in the local Runtime through the PHP model proxy; office state loads');
 const logout=await page.evaluate(async()=>{await fetch('/user_auth.php?action=logout');return(await(await fetch('/user_auth.php?action=check_session')).json()).data.logged_in;});assert.equal(logout,false);console.log('PASS: logout revokes the Bearer credential');
}finally{
 if(context)await context.close();
 if(runtime)await new Promise(r=>{runtime.once('exit',r);runtime.kill();});
 if(host)await host.stop();
 if(id){const code=`$c=require 'MoonYa-Backend/config.php';$p=new PDO('mysql:host='.$c['db_host'].';dbname='.$c['db_name'].';charset=utf8mb4',$c['db_user'],$c['db_pass']);$v=json_decode(stream_get_contents(STDIN),true);$s=$p->prepare('DELETE FROM users WHERE id=? AND username=?');$s->execute([$v['id'],$v['username']]);echo $s->rowCount();`;const clean=spawnSync('php',['-r',code],{cwd:root,input:JSON.stringify({id,username}),encoding:'utf8',windowsHide:true});assert.equal(clean.status,0,'Temporary account cleanup failed');assert.equal(clean.stdout.trim(),'1');console.log('Temporary local test account removed; existing users preserved');}
}
