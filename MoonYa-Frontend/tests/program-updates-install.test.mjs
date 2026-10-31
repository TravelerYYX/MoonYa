import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,cp,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args){return new Promise((resolve,reject)=>{const process=spawn(command,args,{cwd:repo,windowsHide:true});let output='',errors='';process.stdout.on('data',value=>output+=value);process.stderr.on('data',value=>errors+=value);process.on('error',reject);process.on('exit',code=>code?reject(new Error(errors+output)):resolve(output));});}
async function port(){const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const value=listener.address().port;await new Promise(resolve=>listener.close(resolve));return value;}
async function waitFor(action,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const value=await action();if(value)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Integration condition timed out');}
async function removeFixture(root,pattern){const path=resolve(root);assert.equal(dirname(path).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(path),pattern);await rm(path,{recursive:true,force:true});}
test('real PHP publishing, native gateway/downloader and actual WPF installer complete an original-directory update and restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'moonya-updates-install-'));let fixture,server,parent;
  try {
    const setupBuild=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(repo,'MoonYa-Win/Installer/Test-UpdateInstaller.ps1')]);
    const evidence=setupBuild.match(/Evidence: ([^\r\n]+)/)?.[1];assert.ok(evidence,setupBuild);
    const setup=await readFile(join(evidence,'setup/FarSideSetup.exe'));
    fixture=JSON.parse(await run(process.env.PHP_BIN||'php',['MoonYa-Backend/tests/program_update_http_fixture.php']));
    const backend=`http://127.0.0.1:${await port()}/`;
    server=spawn(process.env.PHP_BIN||'php',['-S',new URL(backend).host,'-t',fixture.root],{cwd:repo,windowsHide:true});server.stderr.resume();
    await waitFor(async()=>{const response=await fetch(backend+'admin/api/updates.php?action=latest');return response.ok;});
    async function api(action,body){const response=await fetch(backend+'admin/api/updates.php?action='+action,{method:'POST',headers:{Authorization:'Bearer '+fixture.token,'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.ok(response.ok&&result.success,JSON.stringify(result));return result.data;}
    const upload=await api('begin',{version:'1.0.0',notes:'集成测试',file_name:'FarSideSetup.exe',file_size:setup.length});
    for(let offset=0;offset<setup.length;offset+=upload.chunk_bytes){const response=await fetch(backend+`admin/api/updates.php?action=chunk&upload_id=${upload.upload_id}&offset=${offset}`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token},body:setup.subarray(offset,offset+upload.chunk_bytes)});assert.equal(response.status,200);}
    const release=await api('complete',{upload_id:upload.upload_id});await api('publish',{id:release.id});
    const installed=join(root,'原目录 with spaces'),cache=join(root,'cache');await mkdir(installed);await mkdir(cache);
    const smoke=join(repo,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows');await cp(smoke,installed,{recursive:true});await copyFile(join(installed,'MoonYa.FrontendSmoke.exe'),join(installed,'FarSide.exe'));
    await mkdir(join(installed,'.MoonYa'));await cp(join(evidence,'原安装目录 with spaces/personal.txt'),join(installed,'.MoonYa/history.txt'));
    const restart=join(root,'restarted.txt');
    parent=spawn(join(installed,'FarSide.exe'),['--update-integration-host',backend,join(repo,'MoonYa-Frontend/dist')],{cwd:installed,windowsHide:true,env:{...process.env,MOONYA_SMOKE_DATA:cache,MOONYA_UPDATE_E2E_RESTART:restart}});
    const lines=createInterface({input:parent.stdout});let errors='';parent.stderr.on('data',value=>errors+=value);
    const info=await new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));parent.once('exit',code=>reject(new Error('Native host exited '+code+': '+errors)));});
    const headers={'X-MoonYa-Gateway':info.token};
    const ready=await waitFor(async()=>{const response=await fetch(info.url+'gateway/updates/status',{headers});const result=await response.json();return result.data?.state==='ready'?result.data:null;});
    assert.equal(ready.release.version,'1.0.0');assert.equal(ready.percent,100);
    const stopped=new Promise(resolve=>parent.once('exit',resolve));
    const response=await fetch(info.url+'gateway/updates/install',{method:'POST',headers});const result=await response.json();assert.ok(response.ok&&result.success,JSON.stringify(result));
    assert.equal(await stopped,0,'current program exits after both handshake acknowledgements');
    const path=await waitFor(async()=>readFile(restart,'utf8'));assert.equal(path.toLowerCase(),join(installed,'FarSide.exe').toLowerCase());
    const install=JSON.parse(await readFile(join(cache,'updates/install-result.json'),'utf8'));assert.equal(install.Success,true);
    assert.equal((await readFile(join(installed,'program-file.txt'),'utf8')).trim(),'new program');
    assert.equal((await readFile(join(installed,'.MoonYa/history.txt'),'utf8')).trim(),'preserve user data');
  } finally {
    if(parent&&parent.exitCode===null){const stopped=new Promise(resolve=>parent.once('exit',resolve));parent.kill();await stopped;}
    if(server&&server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
    if(fixture)await removeFixture(fixture.root,/^moonya-updates-http-[a-f0-9]{16}$/);
    await removeFixture(root,/^moonya-updates-install-/);
  }
});
