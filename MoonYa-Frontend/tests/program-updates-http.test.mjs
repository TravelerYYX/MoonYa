import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const repo=fileURLToPath(new URL('../../',import.meta.url));
function php(args){return new Promise((resolve,reject)=>{const child=spawn(process.env.PHP_BIN||'php',args,{cwd:repo,windowsHide:true});let output='',errors='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>errors+=value);child.on('error',reject);child.on('exit',code=>code?reject(new Error(errors+output)):resolve(output));});}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function installerBytes(version,product='FarSideSetup.UpdateProtocol/1') {
  function node(key,value,length,type,children=[]) {
    const keyBytes=Buffer.from(key+'\0','utf16le'),head=Buffer.alloc((6+keyBytes.length+3)&~3);keyBytes.copy(head,6);
    const data=Buffer.concat([head,value,Buffer.alloc((4-(head.length+value.length)%4)%4),...children.map(child=>Buffer.concat([child,Buffer.alloc((4-child.length%4)%4)]))]);
    data.writeUInt16LE(data.length,0);data.writeUInt16LE(length,2);data.writeUInt16LE(type,4);return data;
  }
  const fixed=Buffer.alloc(52),[major,minor,patch]=version.split('.').map(Number);fixed.writeUInt32LE(0xfeef04bd);fixed.writeUInt32LE(0x10000,4);fixed.writeUInt32LE((major*65536+minor)>>>0,8);fixed.writeUInt32LE((patch*65536)>>>0,12);
  const productValue=Buffer.from(product+'\0','utf16le');
  const info=node('VS_VERSION_INFO',fixed,52,0,[node('StringFileInfo',Buffer.alloc(0),0,1,[node('040904b0',Buffer.alloc(0),0,1,[node('ProductName',productValue,product.length+1,1)])])]);
  const bytes=Buffer.alloc(200000,0x55);bytes.fill(0,0,512+4096);bytes.write('MZ');bytes.writeUInt32LE(64,60);bytes.write('PE\0\0',64);bytes.writeUInt16LE(1,70);bytes.writeUInt16LE(224,84);bytes.writeUInt16LE(0x10b,88);bytes.writeUInt32LE(0x1000,200);bytes.writeUInt32LE(4096,204);
  bytes.writeUInt32LE(4096,320);bytes.writeUInt32LE(0x1000,324);bytes.writeUInt32LE(4096,328);bytes.writeUInt32LE(512,332);
  for(const [offset,id,next] of [[0,16,0x80000020],[32,1,0x80000040],[64,1033,96]]){bytes.writeUInt16LE(1,512+offset+14);bytes.writeUInt32LE(id,512+offset+16);bytes.writeUInt32LE(next,512+offset+20);}
  bytes.writeUInt32LE(0x1000+112,512+96);bytes.writeUInt32LE(info.length,512+100);info.copy(bytes,512+112);return bytes;
}
test('updates API authenticates uploads, validates publication, preserves immutable versions and serves verified byte ranges',async()=>{
  let fixture,server;
  try {
    fixture=JSON.parse(await php(['MoonYa-Backend/tests/program_update_http_fixture.php']));
    const port=await freePort(),base=`http://127.0.0.1:${port}/admin/api/updates.php?action=`;
    server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${port}`,'-t',fixture.root],{cwd:repo,windowsHide:true});let errors='';server.stderr.on('data',value=>errors+=value);
    for(let attempt=0;;attempt++){try{if((await fetch(base+'latest')).ok)break;}catch{}if(attempt>50)throw new Error(errors);await new Promise(resolve=>setTimeout(resolve,100));}
    async function api(action,body,auth=true){const response=await fetch(base+action,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+fixture.token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};}
    const bytes=installerBytes('1.9.0');
    const description={version:'1.9.0',notes:'更新内容\n第二行',file_name:'FarSideSetup.exe',file_size:bytes.length};
    assert.equal((await api('begin',description,false)).status,401);
    assert.equal((await api('publish',{id:1},false)).status,401);
    assert.equal((await api('begin',{...description,file_name:'installer.zip'})).status,400);
    assert.equal((await api('begin',{...description,version:'1.0'})).status,400);
    assert.equal((await api('begin',{...description,file_size:2147483649})).status,400);
    assert.equal((await api('latest',undefined,false)).data,null);
    const session=(await api('begin',description)).data;
    assert.equal((await api('complete',{upload_id:session.upload_id})).status,400);
    async function chunk(offset,body){const response=await fetch(base+`chunk&upload_id=${session.upload_id}&offset=${offset}`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token,'Content-Type':'application/octet-stream'},body});return {status:response.status,...await response.json()};}
    assert.equal((await chunk(1000,bytes.subarray(0,1000))).status,400);
    assert.equal((await chunk(0,bytes.subarray(0,25000))).data.uploaded_bytes,25000);
    assert.equal((await chunk(0,bytes.subarray(0,50000))).data.uploaded_bytes,50000);
    assert.equal((await chunk(0,bytes.subarray(0,50000))).data.uploaded_bytes,50000,'lost-response chunk retry is idempotent');
    assert.equal((await chunk(0,Buffer.alloc(100,0))).status,400);
    assert.equal((await chunk(50000,bytes.subarray(50000))).status,200);
    const draft=(await api('complete',{upload_id:session.upload_id})).data;
    assert.equal(draft.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await api('complete',{upload_id:session.upload_id})).data.id,draft.id);
    assert.equal((await api('latest',undefined,false)).data,null,'draft is not visible to clients');
    assert.equal((await fetch(base+'download&id='+draft.id)).status,404);
    assert.equal((await api('publish',{id:draft.id})).data.status,'published');
    assert.equal((await api('begin',description)).status,400,'published versions cannot be replaced');
    assert.equal((await api('latest',undefined,false)).data.version,'1.9.0');
    assert.equal((await api('set_force',{id:draft.id,force_update:true},false)).status,401);
    assert.equal((await api('set_force',{id:draft.id,force_update:'true'})).status,400);
    assert.equal((await api('set_force',{id:draft.id,force_update:true})).data.force_update,true);
    assert.equal((await api('latest',undefined,false)).data.minimum_required_version,'1.9.0');

    const download=base+'download&id='+draft.id;
    let response=await fetch(download);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    const etag=response.headers.get('etag');assert.equal(etag,'"'+draft.sha256+'"');
    response=await fetch(download,{headers:{Range:'bytes=50000-','If-Range':etag}});assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 50000-${bytes.length-1}/${bytes.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(50000));
    response=await fetch(download,{headers:{Range:'bytes=3-12'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(3,13));
    response=await fetch(download,{headers:{Range:'bytes=-10'}});assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(-10));
    response=await fetch(download,{headers:{Range:'bytes=3-','If-Range':'"changed"'}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    for(const range of ['bytes=200000-','bytes=10-3','bytes=0-1,3-4','bytes=-0']){response=await fetch(download,{headers:{Range:range}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */200000');}
    response=await fetch(download,{method:'HEAD',headers:{Range:'bytes=10-19'}});assert.equal(response.status,206);assert.equal(response.headers.get('content-length'),'10');assert.equal((await response.arrayBuffer()).byteLength,0);
    // Invalid executable headers are rejected after a full upload.
    const invalid=(await api('begin',{...description,version:'1.9.1',file_size:100})).data;
    response=await fetch(base+`chunk&upload_id=${invalid.upload_id}&offset=0`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token},body:Buffer.alloc(100)});assert.equal(response.status,200);
    assert.equal((await api('complete',{upload_id:invalid.upload_id})).status,400);
    // Latest is selected numerically rather than lexically or by publish time.
    const newer=(await api('begin',{...description,version:'1.10.0'})).data;
    response=await fetch(base+`chunk&upload_id=${newer.upload_id}&offset=0`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token},body:installerBytes('1.10.0')});assert.equal(response.status,200);
    const newerDraft=(await api('complete',{upload_id:newer.upload_id})).data;await api('publish',{id:newerDraft.id});
    assert.equal((await api('latest',undefined,false)).data.version,'1.10.0');
    assert.equal((await api('latest',undefined,false)).data.minimum_required_version,'1.9.0','a later optional release keeps the minimum mandatory version');
    for(const [version,payload] of [['1.10.1',installerBytes('1.10.0')],['1.10.2',installerBytes('1.10.2','FarSide')]]) {
      const session=(await api('begin',{...description,version})).data;
      await fetch(base+`chunk&upload_id=${session.upload_id}&offset=0`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token},body:payload});
      assert.equal((await api('complete',{upload_id:session.upload_id})).status,400,'reject unsupported protocol or mismatched version before publication');
    }
    // Delete: authentication, validation, disk cleanup, batch semantics and latest() fallback.
    const uploadsDir=resolve(fixture.root,'uploads/program-updates');
    const countExe=async()=>(await readdir(uploadsDir)).filter(name=>name.endsWith('.exe')).length;
    async function upload(version){const session=(await api('begin',{...description,version})).data;await fetch(base+`chunk&upload_id=${session.upload_id}&offset=0`,{method:'POST',headers:{Authorization:'Bearer '+fixture.token},body:installerBytes(version)});return (await api('complete',{upload_id:session.upload_id})).data;}
    assert.equal((await api('delete',{ids:[draft.id]},false)).status,401,'delete requires authentication');
    assert.equal((await api('delete',{})).status,400);
    assert.equal((await api('delete',{ids:[]})).status,400);
    assert.equal((await api('delete',{ids:['abc']})).status,400);
    assert.equal((await api('delete',{ids:[999999]})).status,400,'a single missing id is rejected');
    // Single delete removes the row and the installer file.
    const tempDraft=await upload('1.9.9');
    const exeBefore=await countExe();
    let removal=await api('delete',{ids:[tempDraft.id]});
    assert.equal(removal.status,200);assert.equal(removal.data.deleted.length,1);assert.equal(removal.data.failed.length,0);
    assert.ok(!(await api('list')).data.releases.some(row=>row.id===tempDraft.id),'deleted version leaves the listing');
    assert.equal(await countExe(),exeBefore-1,'single delete removes the installer from disk');
    // Batch delete reports partial success without aborting the whole request.
    const tempDraft2=await upload('1.8.0');
    const exeBefore2=await countExe();
    removal=await api('delete',{ids:[999999,tempDraft2.id]});
    assert.equal(removal.status,200);assert.equal(removal.data.deleted.length,1);assert.equal(removal.data.failed.length,1);
    assert.equal(await countExe(),exeBefore2-1,'batch delete still removes the valid installer');
    // Deleting the newest published version rolls latest() back to the previous release.
    assert.equal((await api('latest',undefined,false)).data.version,'1.10.0');
    const latestRow=(await api('list')).data.releases.find(row=>row.version==='1.10.0');
    const exeBefore3=await countExe();
    removal=await api('delete',{ids:[latestRow.id]});
    assert.equal(removal.data.deleted.length,1);
    assert.equal((await api('latest',undefined,false)).data.version,'1.9.0','latest falls back after deleting the newest published version');
    assert.equal(await countExe(),exeBefore3-1,'published installer is removed from disk');
    // Removing every remaining release halts updates entirely.
    const remaining=(await api('list')).data.releases.map(row=>row.id);
    removal=await api('delete',{ids:remaining});
    assert.equal(removal.data.deleted.length,remaining.length);assert.equal(removal.data.failed.length,0);
    assert.equal((await api('latest',undefined,false)).data,null);
    assert.equal(await countExe(),0,'every installer is removed from disk');
  } finally {
    if(server){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
    if(fixture){const target=resolve(fixture.root);assert.equal(dirname(target).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(target),/^moonya-updates-http-[a-f0-9]{16}$/);await rm(target,{recursive:true,force:true});}
  }
});
