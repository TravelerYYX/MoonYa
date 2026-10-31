import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(join(root,'MoonYa-Frontend/package.json'))('playwright-core');

// Exercise the production routes with isolated authentication/database adapters.
test('admin skill management, folder uploads and progress; runtime remains authenticated',{timeout:60000},async()=>{
  const stage=await mkdtemp(join(tmpdir(),'moonya-skill-api-'));
  for(const directory of ['admin/api','admin/assets','api','Services','skills'])await mkdir(join(stage,directory),{recursive:true});
  for(const path of ['admin/api/skills.php','api/skills.php','Services/SkillCatalog.php','Services/CorsPolicy.php','admin/assets/admin-ui.css','admin/assets/skills-upload.js'])await cp(join(root,'MoonYa-Backend',path),join(stage,path));
  await cp(join(root,'MoonYa-Backend/script/dashboard/skills.php'),join(stage,'admin/skills-view.php'));
  await writeFile(join(stage,'admin/config.php'), '<?php return [];');await writeFile(join(stage,'config.php'),'<?php return [];');
  await writeFile(join(stage,'admin/Database.php'),'<?php class Database { function __construct(...$args) {} function getConnection() { return new stdClass; } }');
  await writeFile(join(stage,'admin/Auth.php'),"<?php class Auth { function __construct(...$args) {} function authenticate($token) { return $token === 'admin-test' ? ['id'=>1] : false; } }");
  await writeFile(join(stage,'admin/Logger.php'),"<?php class Logger { function __construct(...$args) {} function logAdminAction(...$args) { file_put_contents(__DIR__.'/actions.jsonl',json_encode($args).PHP_EOL,FILE_APPEND); } }");
  await writeFile(join(stage,'Services/RuntimeRequestAuth.php'),"<?php function authenticateMoonYaRequest($config) { if(($_SERVER['HTTP_AUTHORIZATION']??'')==='Bearer user-test')return 1; http_response_code(401); throw new RuntimeException('unauthorized'); }");
  await writeFile(join(stage,'admin/dashboard.php'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="assets/admin-ui.css"></head><body><main class="content-area" style="padding:24px"><script>let token='admin-test';function showAlert(type,message){document.getElementById('testAlert').textContent=message;}</script><div id="testAlert" role="status"></div><?php include __DIR__.'/skills-view.php'; ?><script>document.getElementById('skillsSection').classList.add('active');loadSkills();</script></main></body></html>`);
  const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  await writeFile(join(stage,'upload-delay.php'),"<?php if(($_SERVER['REQUEST_METHOD']??'')==='POST' && str_starts_with($_SERVER['CONTENT_TYPE']??'','application/json')) { $input=json_decode(file_get_contents('php://input'),true); if(($input['action']??'')==='upload_tree') usleep(250000); }");
  const php=spawn('php',['-d','display_errors=0','-d','auto_prepend_file='+join(stage,'upload-delay.php'),'-d','upload_max_filesize=2M','-d','post_max_size=12M','-d','max_file_uploads=2','-S','127.0.0.1:'+port,'-t',stage],{windowsHide:true,stdio:'ignore'});
  const base='http://127.0.0.1:'+port;
  const request=async(path,options={})=>{const response=await fetch(base+path,options);return {status:response.status,...await response.json()};};
  const post=input=>request('/admin/api/skills.php',{method:'POST',headers:{Authorization:'Bearer admin-test','Content-Type':'application/json'},body:JSON.stringify(input)});
  let browser;
  try {
    for(let i=0;i<80;i++){try{await fetch(base+'/api/skills.php');break;}catch{await new Promise(resolve=>setTimeout(resolve,25));}}
    assert.equal((await request('/admin/api/skills.php')).status,401);
    assert.equal((await request('/api/skills.php')).status,401);
    assert.equal((await request('/api/skills.php',{method:'POST'})).status,405);
    browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/admin/dashboard.php');await page.locator('#skillCreateButton').click();
    await page.locator('#newSkillName').fill('writing-helper');await page.locator('#newSkillDisplayName').fill('写作助手');await page.locator('#newSkillDescription').fill('用于真实写作任务');await page.locator('#newSkillBody').fill('MAIN-UPLOADED-UNIQUE\n按需读取 提示词/guide.md');
    await page.locator('#skillCreateModal [type=submit]').click();await page.waitForFunction(()=>skillExplorer.name==='writing-helper');
    assert.equal(await page.locator('#skillCreateButton').isVisible(),false);
    await page.locator('#skillDirectoryButton').click();await page.locator('#newSkillDirectory').fill('提示词');await page.locator('#skillDirectoryModal [type=submit]').click();
    await page.locator('.skill-file-row').filter({hasText:'提示词'}).dblclick();await page.waitForFunction(()=>skillExplorer.path==='提示词');
    await page.locator('#skillUploadFiles').setInputFiles([{name:'guide.md',mimeType:'text/markdown',buffer:Buffer.from('REFERENCE-UPLOADED-UNIQUE')},{name:'extra.md',mimeType:'text/markdown',buffer:Buffer.from('SECOND-UPLOADED-UNIQUE')}]);
    await page.locator('.skill-file-row').filter({hasText:'guide.md'}).waitFor();
    await page.locator('.skill-file-row').filter({hasText:'guide.md'}).dblclick();await page.locator('#skillRaw').fill('REFERENCE-UPDATED-UNIQUE');await page.locator('#skillModal .btn-primary').click();await page.waitForFunction(()=>!document.getElementById('skillModal').classList.contains('show'));
    const result=await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}});
    assert.equal(result.data.skills[0].body,'MAIN-UPLOADED-UNIQUE\n按需读取 提示词/guide.md');
    assert.equal(result.data.skills[0].resources['提示词/guide.md'],'REFERENCE-UPDATED-UNIQUE\n');
    assert.equal(result.data.skills[0].path,undefined);assert.equal(result.data.skills[0].raw,undefined);
    assert.equal((await post({action:'create',name:'writing-helper',description:'duplicate',body:'duplicate'})).status,400);
    assert.equal((await post({action:'mkdir',name:'writing-helper',path:'../escape'})).status,400);
    await mkdir(join(stage,'outside'));await writeFile(join(stage,'outside','private.md'),'OUTSIDE-MUST-NOT-DISCLOSE');
    await symlink(join(stage,'outside'),join(stage,'skills','writing-helper','linked'),process.platform==='win32'?'junction':'dir');
    const linkUpload=new FormData();linkUpload.append('action','upload');linkUpload.append('name','writing-helper');linkUpload.append('path','linked');linkUpload.append('files[]',new Blob(['escape']),'escape.md');
    assert.equal((await request('/admin/api/skills.php',{method:'POST',headers:{Authorization:'Bearer admin-test'},body:linkUpload})).success,false);
    const afterLink=await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}});
    assert.equal(JSON.stringify(afterLink).includes('OUTSIDE-MUST-NOT-DISCLOSE'),false);
    const invalid=new FormData();invalid.append('action','upload');invalid.append('name','writing-helper');invalid.append('path','提示词');invalid.append('files[]',new Blob(['partial']),'partial.md');invalid.append('files[]',new Blob(['bad']),'invalid.txt');
    assert.equal((await request('/admin/api/skills.php',{method:'POST',headers:{Authorization:'Bearer admin-test'},body:invalid})).status,400);
    const browse=await request('/admin/api/skills.php?action=browse&name=writing-helper&path='+encodeURIComponent('提示词'),{headers:{Authorization:'Bearer admin-test'}});
    assert.equal(browse.data.directory.entries.some(entry=>entry.name==='partial.md'),false);
    const oversized=new FormData();oversized.append('action','upload');oversized.append('name','writing-helper');oversized.append('files[]',new Blob([Buffer.alloc(1048577,97)]),'large.md');
    assert.equal((await request('/admin/api/skills.php',{method:'POST',headers:{Authorization:'Bearer admin-test'},body:oversized})).status,413);
    const truncated=new FormData();truncated.append('action','upload');truncated.append('name','writing-helper');truncated.append('file_count','3');
    for(let i=0;i<3;i++)truncated.append('files[]',new Blob(['valid']),'truncated-'+i+'.md');
    assert.equal((await request('/admin/api/skills.php',{method:'POST',headers:{Authorization:'Bearer admin-test'},body:truncated})).status,400);
    assert.equal((await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills[0].resources['truncated-0.md'],undefined);
    const logged=(await readFile(join(stage,'admin/actions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(logged.map(row=>row[1]),['create_skill','create_skill_directory','upload_skill_tree','update_skill']);

    // Expected failures must preserve the existing files and reject traversal even for skipped formats.
    assert.equal((await post({action:'update_info',name:'writing-helper',display_name:'invalid',description:'',body:'bad'})).status,400);
    assert.equal((await post({action:'delete',name:'computer-use'})).status,403);
    assert.equal((await post({action:'delete',name:'missing-helper'})).status,404);
    assert.equal((await post({action:'delete',name:'writing-helper'})).status,400,'linked tree must not be deleted');
    assert.equal(await readFile(join(stage,'outside','private.md'),'utf8'),'OUTSIDE-MUST-NOT-DISCLOSE');
    assert.equal((await post({action:'upload_tree',name:'writing-helper',path:'',directories:[],files:[{path:'../escaped.png',raw:'bad'}]})).status,400);
    await rm(join(stage,'skills','writing-helper','linked'));

    await page.locator('#skillBreadcrumb button').first().click();
    const writingRow=page.locator('.skill-root-row').filter({hasText:'写作助手'});
    await writingRow.getByRole('button',{name:'编辑信息'}).click();
    await page.locator('#skillInfoModal').waitFor({state:'visible'});
    assert.equal(await page.locator('#editSkillName').inputValue(),'writing-helper');
    assert.equal(await page.locator('#editSkillName').getAttribute('readonly'),'');
    await page.locator('#editSkillDisplayName').fill('更新后的写作助手');await page.locator('#editSkillDescription').fill('更新后的用途说明');await page.locator('#editSkillBody').fill('MAIN-EDITED-UNIQUE');
    await page.locator('#skillInfoModal [type=submit]').click();await page.waitForFunction(()=>!document.getElementById('skillInfoModal').classList.contains('show'));
    await page.locator('.skill-root-row').filter({hasText:'更新后的写作助手'}).waitFor();
    const edited=(await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills[0];
    assert.equal(edited.body,'MAIN-EDITED-UNIQUE');assert.equal(edited.description,'更新后的用途说明');assert.equal(edited.resources['提示词/guide.md'],'REFERENCE-UPDATED-UNIQUE\n');
    await page.locator('.skill-root-row').filter({hasText:'更新后的写作助手'}).getByRole('button',{name:'删除',exact:true}).click();
    await page.locator('#skillDeleteModal').getByRole('button',{name:'取消'}).click();assert.equal((await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills.length,1);
    await page.locator('.skill-root-row').filter({hasText:'更新后的写作助手'}).dblclick();await page.waitForFunction(()=>skillExplorer.name==='writing-helper');

    // Folder picker retains nested paths and uses one JSON request despite max_file_uploads=2.
    const folder=join(stage,'local-input','资料文件夹');await mkdir(join(folder,'深层','更深'),{recursive:true});
    await writeFile(join(folder,'root.md'),'ROOT-RESOURCE');await writeFile(join(folder,'深层','guide.md'),'NESTED-RESOURCE');await writeFile(join(folder,'深层','更深','last.md'),'DEEPEST-RESOURCE');await writeFile(join(folder,'picture.png'),'UNSUPPORTED-IMAGE');
    await page.locator('#skillUploadFolder').setInputFiles(folder);
    await page.waitForFunction(()=>document.getElementById('skillUploadMessage').textContent.includes('服务器正在校验'));
    assert.equal(await page.locator('#skillFolderButton').isDisabled(),true);
    await page.waitForFunction(()=>!skillUploadBusy);
    assert.equal(await page.locator('#skillUploadProgress').getAttribute('value'),'100');
    await page.locator('#skillUploadSkippedSummary').click();await page.locator('#skillUploadSkippedList').getByText('资料文件夹/picture.png',{exact:false}).waitFor();
    const folderResult=(await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills[0];
    assert.equal(folderResult.resources['资料文件夹/深层/更深/last.md'],'DEEPEST-RESOURCE');assert.equal(folderResult.resources['资料文件夹/picture.png'],undefined);

    // Drop a real OS directory, including an empty subfolder, through Chromium's drag API.
    const dropFolder=join(stage,'local-input','拖入资料');await mkdir(join(dropFolder,'空目录'),{recursive:true});await mkdir(join(dropFolder,'子目录'),{recursive:true});
    await writeFile(join(dropFolder,'子目录','drop.md'),'REAL-DROP-RESOURCE');await writeFile(join(dropFolder,'skip.txt'),'UNSUPPORTED-TEXT');
    const cdp=await page.context().newCDPSession(page),box=await page.locator('#skillDropZone').boundingBox();
    const drag={items:[],files:[dropFolder],dragOperationsMask:1};
    for(const type of ['dragEnter','dragOver','drop'])await cdp.send('Input.dispatchDragEvent',{type,x:box.x+box.width/2,y:box.y+box.height/2,data:drag});
    await page.waitForFunction(()=>!skillUploadBusy && document.getElementById('skillUploadMessage').textContent.includes('上传完成'));
    assert.equal(await readFile(join(stage,'skills','writing-helper','拖入资料','子目录','drop.md'),'utf8'),'REAL-DROP-RESOURCE');
    assert.equal((await request('/admin/api/skills.php?action=browse&name=writing-helper&path='+encodeURIComponent('拖入资料'),{headers:{Authorization:'Bearer admin-test'}})).data.directory.entries.some(entry=>entry.name==='空目录'),true);

    // Drive the actual drop listener with a paginated reader, including a second batch beyond 100 entries.
    await page.evaluate(()=>{
      const children=Array.from({length:105},(_,i)=>({name:'file-'+i+'.md',isFile:true,file(resolve){resolve(new File(['RESOURCE-'+i],this.name));}}));
      const entry={name:'many-files',isDirectory:true,createReader(){let offset=0;return {readEntries(resolve){const batch=children.slice(offset,offset+100);offset+=batch.length;setTimeout(()=>resolve(batch),0);}};}};
      const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],items:[{kind:'file',getAsFile(){return null;},webkitGetAsEntry(){return entry;}}]}});document.getElementById('skillDropZone').dispatchEvent(event);
    });
    await page.waitForFunction(()=>!skillUploadBusy);
    assert.equal(await readFile(join(stage,'skills','writing-helper','many-files','file-104.md'),'utf8'),'RESOURCE-104');

    // A conflicting file produces a visible error and leaves neither partial content nor directories.
    await page.locator('#skillUploadFolder').setInputFiles(folder);await page.waitForFunction(()=>!skillUploadBusy);
    assert.equal(await page.locator('#skillUploadStatus').evaluate(node=>node.classList.contains('is-error')),true);
    assert.equal(await page.locator('#skillFolderButton').isDisabled(),false);
    assert.equal(await readFile(join(stage,'skills','writing-helper','资料文件夹','root.md'),'utf8'),'ROOT-RESOURCE');

    // Import a complete skill folder at the root; install by manifest name rather than the local folder name.
    const importedFolder=join(stage,'local-input','任意技能文件夹');await mkdir(join(importedFolder,'references','deep'),{recursive:true});
    await writeFile(join(importedFolder,'SKILL.md'),'---\nname: imported-helper\ndescription: imported description\nmetadata: {"display_name":"导入助手"}\n---\n\nIMPORTED-MAIN');
    await writeFile(join(importedFolder,'references','deep','guide.md'),'IMPORTED-REFERENCE');await writeFile(join(importedFolder,'script.py'),'UNSUPPORTED-SCRIPT');
    await page.locator('#skillBreadcrumb button').first().click();await page.locator('#skillUploadFolder').setInputFiles(importedFolder);await page.waitForFunction(()=>!skillUploadBusy);
    await page.locator('.skill-root-row').filter({hasText:'导入助手'}).waitFor();
    const imported=(await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills.find(skill=>skill.name==='imported-helper');
    assert.equal(imported.body,'IMPORTED-MAIN');assert.equal(imported.resources['references/deep/guide.md'],'IMPORTED-REFERENCE');assert.equal(imported.resources['script.py'],undefined);
    assert.equal(await page.locator('#skillUploadSkippedSummary').textContent(),'已跳过 1 个不支持的文件（查看详情）');
    await page.locator('.skill-root-row').filter({hasText:'导入助手'}).getByRole('button',{name:'删除',exact:true}).click();await page.locator('#skillDeleteModal [type=submit]').click();await page.waitForFunction(()=>!document.getElementById('skillDeleteModal').classList.contains('show'));
    assert.equal((await request('/api/skills.php',{headers:{Authorization:'Bearer user-test'}})).data.skills.some(skill=>skill.name==='imported-helper'),false);
    const latestLogs=(await readFile(join(stage,'admin/actions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).map(row=>row[1]);
    assert.equal(latestLogs.includes('update_skill_info'),true);assert.equal(latestLogs.includes('import_skills'),true);assert.equal(latestLogs.at(-1),'delete_skill');
    const artifacts=join(root,'artifacts/skill-upload');await mkdir(artifacts,{recursive:true});await page.screenshot({path:join(artifacts,'admin-skill-files.png')});
    await page.setViewportSize({width:460,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
  } finally {
    await browser?.close();const exited=new Promise(resolve=>php.once('exit',resolve));php.kill();await exited;await rm(stage,{recursive:true,force:true});
  }
});
