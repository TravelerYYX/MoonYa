import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname,basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createInterface} from 'node:readline';
const repo=fileURLToPath(new URL('../../',import.meta.url));
function run(args){return new Promise((resolve,reject)=>{const child=spawn(process.env.PHP_BIN||'php',args,{cwd:repo,windowsHide:true});let output='',errors='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>errors+=value);child.on('error',reject);child.on('exit',code=>code?reject(new Error(errors+output)):resolve(output));});}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('announcement publication snapshots, CRUD/authentication, image validation and drag editor',async()=>{
  let fixture,server,browser,native;
  try {
    fixture=JSON.parse(await run(['MoonYa-Backend/tests/program_update_http_fixture.php']));
    const port=await freePort(),origin=`http://127.0.0.1:${port}`;
    server=spawn(process.env.PHP_BIN||'php',['-S',`127.0.0.1:${port}`,'-t',fixture.root],{cwd:repo,windowsHide:true});
    let errors='';server.stderr.on('data',value=>errors+=value);
    async function api(action,body,auth=true){const response=await fetch(origin+'/admin/api/announcements.php?action='+action,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer '+fixture.token}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};}
    for(let attempt=0;;attempt++){try{if((await api('feed')).status===200)break;}catch{}if(attempt>50)throw new Error(errors);await new Promise(resolve=>setTimeout(resolve,100));}
    const draft={title:'公告一',blocks:[{type:'text',text:'第一段\n第二行'},{type:'image',url:'/uploads/new-images/fixture.png',width:60,align:'right'}]};
    assert.equal((await api('list',undefined,false)).status,401);
    for(const action of ['save','publish','withdraw','delete'])assert.equal((await api(action,draft,false)).status,401);
    assert.equal((await api('save',{...draft,title:''})).status,400);
    assert.equal((await api('save',{...draft,blocks:[]})).status,400);
    for(const url of ['https://evil.invalid/a.png','/uploads/new-images/../fixture.png','/uploads/new-images/missing.png'])assert.equal((await api('save',{...draft,blocks:[{type:'image',url,width:100,align:'center'}]})).status,400);
    const first=(await api('save',draft)).data;
    assert.deepEqual((await api('feed',undefined,false)).data.announcements,[]);
    assert.equal((await api('publish',{id:first.id})).data.revision,1);
    const second=(await api('save',{title:'公告二',blocks:[{type:'text',text:'后发布'}]})).data;
    await api('publish',{id:second.id});
    await api('save',{...draft,id:first.id,title:'修订草稿',blocks:[{type:'text',text:'<script>alert(1)</script>'}]});
    let feed=(await api('feed',undefined,false)).data.announcements;
    assert.deepEqual(feed.map(item=>item.id),[first.id,second.id]);assert.equal(feed[0].title,'公告一');assert.equal(feed[0].revision,1,'draft edits are not published');
    await api('publish',{id:first.id}); feed=(await api('feed')).data.announcements;
    assert.equal(feed[0].revision,2);assert.equal(feed[0].title,'修订草稿');assert.equal(feed[0].blocks[0].text,'<script>alert(1)</script>');
    await api('withdraw',{id:first.id});assert.deepEqual((await api('feed')).data.announcements.map(item=>item.id),[second.id]);
    await api('publish',{id:first.id});assert.equal((await api('feed')).data.announcements[0].revision,3);
    await api('delete',{id:first.id});assert.equal((await api('publish',{id:first.id})).status,400);
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1100,height:850}});
    await page.addInitScript(token=>{window.token=token;window.confirm=()=>true;},fixture.token);
    await page.goto(origin+'/admin/announcement-fixture.php');await page.evaluate(()=>window.announcements.load());
    await page.locator('#announcementTitle').fill('编辑器公告');
    await page.locator('#announcementBlocks textarea').fill('第一段');await page.locator('#announcementAddText').click();
    await page.locator('#announcementBlocks textarea').nth(1).fill('第二段');
    await page.locator('.announcement-drag').nth(0).dragTo(page.locator('.announcement-block').nth(1));
    assert.deepEqual(await page.locator('#announcementBlocks textarea').evaluateAll(nodes=>nodes.map(node=>node.value)),['第二段','第一段']);
    // Existing validated upload can be edited and previewed with the same renderer.
    const imageNotice=(await api('save',draft)).data;await page.evaluate(()=>window.announcements.load());
    await page.locator('.announcement-row').filter({hasText:'公告一'}).getByRole('button',{name:'编辑',exact:true}).click();
    await page.locator('.block-fields input[type=number]').fill('40');await page.locator('.block-fields select').selectOption('left');
    await page.locator('#announcementPreview').click();await page.locator('#announcementAdminPreview').waitFor({state:'visible'});
    const preview=page.locator('#announcementAdminPreview');assert.equal(await preview.locator('img').evaluate(node=>node.style.width),'40%');
    assert.equal(await preview.locator('.membership-dialog').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(0, 0, 0)');
    await mkdir(join(repo,'artifacts/announcements'),{recursive:true});await preview.screenshot({path:join(repo,'artifacts/announcements/admin-preview.png')});
    await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();await page.waitForFunction(()=>document.getElementById('announcementEditorStatus').textContent.includes('已保存'));
    const saved=(await api('list')).data.announcements.find(item=>item.id===imageNotice.id);assert.equal(saved.blocks[1].width,40);assert.equal(saved.blocks[1].align,'left');
    const uploaded=page.waitForResponse(response=>response.url().endsWith('/api/upload_image.php'));
    await page.locator('#announcementImage').setInputFiles(join(fixture.root,'uploads/new-images/fixture.png'));
    const uploadResponse=await uploaded;assert.equal(uploadResponse.status(),200,await uploadResponse.text());
    await page.waitForFunction(()=>document.querySelectorAll('#announcementBlocks img').length===2);
    await page.getByRole('button',{name:'保存并发布',exact:true}).click();await page.waitForFunction(()=>document.getElementById('announcementEditorStatus').textContent.startsWith('公告已发布'));
    assert.equal((await api('feed')).data.announcements.find(item=>item.id===imageNotice.id).blocks.length,3,'uploaded picture participates in publication');
    async function host() {
      const child=spawn('dotnet',[join(repo,'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),join(repo,'MoonYa-Frontend/dist'),origin+'/', 'http://127.0.0.1:1/'],{cwd:repo,windowsHide:true,env:{...process.env,MOONYA_SMOKE_DATA:join(fixture.root,'device')}});
      native=child;const lines=createInterface({input:child.stdout});let errors='';child.stderr.on('data',value=>errors+=value);
      return await new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));child.once('exit',()=>reject(new Error(errors)));});
    }
    async function stopHost(){const stopped=new Promise(resolve=>native.once('exit',resolve));native.stdin.end('\n');await stopped;native=null;}
    let info=await host(),headers={'X-MoonYa-Gateway':info.token,'Content-Type':'application/json'};
    assert.equal((await fetch(info.url+'gateway/announcements/feed')).status,403);
    assert.equal((await fetch(info.url+'gateway/announcements/feed',{headers:{...headers,Origin:'https://foreign.invalid'}})).status,403);
    const gatewayFeed=await (await fetch(info.url+'gateway/announcements/feed',{headers})).json();assert.equal(gatewayFeed.success,true);assert.deepEqual(gatewayFeed.data.read,{});
    assert.equal((await fetch(info.url+'gateway/announcements/read',{method:'POST',headers,body:JSON.stringify({id:second.id,revision:1})})).status,200);
    await stopHost();info=await host();headers={'X-MoonYa-Gateway':info.token};
    const restored=await (await fetch(info.url+'gateway/announcements/feed',{headers})).json();assert.equal(restored.data.read[second.id],1,'native gateway persists device acknowledgements across ephemeral ports');
    await stopHost();
  } finally {
    if(browser)await browser.close();if(native){const stopped=new Promise(resolve=>native.once('exit',resolve));native.kill();await stopped;}if(server){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill();await stopped;}
    if(fixture){const target=resolve(fixture.root);assert.equal(dirname(target).toLowerCase(),resolve(tmpdir()).toLowerCase());assert.match(basename(target),/^moonya-updates-http-[a-f0-9]{16}$/);await rm(target,{recursive:true,force:true});}
  }
});
