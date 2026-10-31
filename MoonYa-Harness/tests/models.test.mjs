import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelConfigStore } from '../src/model-config.mjs';
import { normalizeModel, requireModelContext, resolveContextLimit, resolveModelEffort, PROVIDER_PRESETS } from '../src/model-catalog.mjs';
import { callModel, openaiPayload, anthropicPayload } from '../src/model-client.mjs';
import { ChatHistory } from '../src/chat-history.mjs';
import { ChatRuns } from '../src/chat-runs.mjs';

const listen = async handler => { const server = http.createServer(handler); await new Promise(r => server.listen(0,'127.0.0.1',r)); return server; };
const close = server => { server.closeAllConnections(); return new Promise(r => server.close(r)); };
const url = server => `http://127.0.0.1:${server.address().port}/v1`;
const row = (base_url, protocol = 'openai-completions') => ({ id:'gateway',name:'Gateway',provider:'custom',base_url,protocol,api_key:'fixture-secret',models:[{id:'fixture-model',context_window:32768,context_window_source:'manual'}] });
const readBody = async req => { const chunks=[]; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); };

test('context metadata uses verified models and API windows without guessing input-only limits', () => {
  const normalize = (row, provider = 'custom', stored = false) => normalizeModel(row, provider, 'openai-completions', {stored});
  assert.equal(normalize({id:'unknown',max_input_tokens:64000}).context_window,null);
  assert.equal(normalize({id:'unknown'}).context_window_source,'unknown');
  assert.equal(normalize({id:'kimi-k3',context_window:32768,source:'api'},'kimi',true).context_window,1048576);
  for (const id of ['kimi-k2.6','kimi-k2.7-code','kimi-k2.7-code-highspeed'])
    assert.equal(normalize({id},'kimi').context_window,262144);
  const api = normalize({id:'kimi-k2.6',context_window:128000},'kimi');
  assert.equal(api.context_window_source,'api');
  assert.equal(normalize(api,'kimi',true).context_window,128000);
  assert.equal(normalize({id:'legacy',context_window:64000,source:'api'},'custom',true).context_window,null);
  assert.equal(normalize({id:'legacy',context_window:32768,overrides:{context_window:8192}},'custom',true).context_window_source,'manual');
  assert.equal(requireModelContext(normalize({id:'small',context_window:8192})),8192);
  assert.throws(()=>requireModelContext(normalize({id:'unknown'})),/真实上下文长度/);
  assert.equal(normalize({id:'bad',context_window:0}).context_window,null);
  assert.equal(normalize({id:'kimi-k3',context_window:1.5},'kimi').context_window,1048576);
  assert.throws(()=>normalize({id:'bad',overrides:{context_window:0}}),/正整数/);
  assert.equal(PROVIDER_PRESETS.glm.models[0].context_window,null);
});

test('pending model configurations persist without TOML nulls and require an explicit length before resolving', async () => {
  const dir = await mkdtemp(join(tmpdir(),'moonya-pending-model-'));
  try {
    const path = join(dir,'config.toml'), store = new ModelConfigStore(path);
    const pending = {...row('http://localhost:1/v1'),models:[{id:'unverified',context_window:null,context_window_source:'unknown'}]};
    const listed = await store.save(pending);
    assert.equal(listed.providers[0].models[0].context_window,null);
    assert.ok(!(await readFile(path,'utf8')).includes('context_window ='));
    await assert.rejects(store.resolve({provider_id:'gateway',model_id:'unverified'}),/真实上下文长度/);
    await store.save({...pending,models:[{id:'unverified',overrides:{context_window:8192}}]});
    const resolved = await new ModelConfigStore(path).resolve({provider_id:'gateway',model_id:'unverified'});
    assert.equal(resolved.context_window,8192);
    assert.equal(resolved.context_window_source,'manual');
    await writeFile(path,'config_version=1\n[providers.gateway]\nprovider="kimi"\nbase_url="http://localhost:1/v1"\n[[providers.gateway.models]]\nid="kimi-k3"\ncontext_window=32768\nsource="api"\n');
    assert.equal((await store.resolve({provider_id:'gateway',model_id:'kimi-k3'})).context_window,1048576);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('identical Anthropic replies retain each original signed content block by message identity', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moonya-thinking-replay-'));
  try{
    const model={provider_id:'gateway',name:'fixture'}, history=new ChatHistory(join(dir,'history.jsonl'));
    for(const id of ['first','second'])await history.remember('conversation',model,{content:'OK',provider_content:{provider_id:'gateway',model:'fixture',blocks:[{type:'thinking',thinking:id,signature:id},{type:'text',text:'OK'}]}},id);
    const messages=await new ChatHistory(join(dir,'history.jsonl')).replay('conversation',model,[{role:'assistant',content:'OK',_moonya_message_id:'first'},{role:'user',content:'Repeat'},{role:'assistant',content:'OK',_moonya_message_id:'second'}]);
    assert.equal(messages[0].provider_content.blocks[0].signature,'first');assert.equal(messages[2].provider_content.blocks[0].signature,'second');
    assert.ok(!JSON.stringify(openaiPayload(model,messages,'none')).includes('_moonya_message_id'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('interrupted Chat journal preserves partial append and remains readable across repeated restarts', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moonya-chat-journal-'));
  try {
    const input={user_context:'owner',conversation_id:'chat',client_message_id:'interrupted'};
    const journal=new ChatRuns(dir), id=journal.id(input), path=join(dir,id+'.jsonl');
    await writeFile(path,JSON.stringify({moonya_started:true,moonya_seq:1})+'\n{"broken');
    const run=await journal.get(input); assert.equal(run.done,true);
    assert.equal(run.events.at(-1).moonya_status,'failed');
    assert.ok((await readdir(dir)).some(name=>name.includes('.interrupted-')));
    const restored=await new ChatRuns(dir).get(input);assert.deepEqual(restored.events,run.events);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Windows locked configuration rejects atomic replacement without changing the original', {skip:process.platform!=='win32'}, async()=>{
  const dir=await mkdtemp(join(tmpdir(),'moonya-config-write-')), path=join(dir,'config.toml');
  let lock;
  try {
    await writeFile(path,'[appearance]\ntheme="dark"\n');
    const script="$f=[System.IO.File]::Open($env:MOONYA_TEST_CONFIG,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null; $f.Dispose()";
    lock=spawn('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,env:{...process.env,MOONYA_TEST_CONFIG:path},stdio:['pipe','pipe','pipe']});
    await new Promise((resolve,reject)=>{lock.stdout.once('data',resolve);lock.once('error',reject);lock.once('exit',code=>reject(new Error('lock process exited '+code)));});
    await assert.rejects(new ModelConfigStore(path).save(row('http://localhost:1')),/写入失败，原文件已保留/);
    assert.equal(await readFile(path,'utf8'),'[appearance]\ntheme="dark"\n');
    assert.deepEqual(await readdir(dir),['config.toml']);
  }finally{
    if(lock && lock.exitCode===null){const exited=new Promise(resolve=>lock.once('exit',resolve));lock.stdin.end('\n');await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});

test('both protocols reject truncated upstream responses and respect timeout cancellation', async()=>{
  const server=await listen(async(req,res)=>{
    await readBody(req);res.writeHead(200,{'content-type':'text/event-stream'});
    if(req.url.startsWith('/hang'))return;
    const event=req.url.endsWith('/messages')?{type:'content_block_start',index:0,content_block:{type:'text',text:'partial'}}:{choices:[{delta:{content:'partial'}}]};
    res.end('data: '+JSON.stringify(event)+'\n\n');
  });
  try {
    for(const protocol of ['openai-completions','anthropic-messages']){
      const model={name:'fixture',protocol,base_url:url(server),api_key:'fixture-secret'};
      await assert.rejects(callModel(model,[{role:'user',content:'Hi'}],'none',AbortSignal.timeout(1000)),/中断|结束|incomplete|terminated/i);
      await assert.rejects(callModel({...model,base_url:url(server).replace('/v1','/hang')},[{role:'user',content:'Hi'}],'none',AbortSignal.timeout(50)),error=>error.name==='TimeoutError'||error.name==='AbortError');
    }
  }finally{await close(server);}
});

test('TOML atomically preserves other settings, redacts metadata and retains omitted keys across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(),'moonya-models-')), path = join(dir,'config.toml');
  try {
    await writeFile(path, '[appearance]\ntheme="dark"\ncreated=2026-09-29T12:00:00Z\n'); const store = new ModelConfigStore(path);
    const listed = await store.save(row('http://localhost:1/v1'));
    assert.equal(listed.providers[0].has_key,true); assert.ok(!JSON.stringify(listed).includes('fixture-secret'));
    assert.match(await readFile(path,'utf8'), /theme = "dark"/);
    assert.ok((await store.read()).appearance.created instanceof Date,'preserve other TOML types');
    const edit = {...listed.providers[0],name:'Updated'}; await store.save(edit);
    const model = await new ModelConfigStore(path).resolve({provider_id:'gateway',model_id:'fixture-model'});
    assert.equal(model.api_key,'fixture-secret'); assert.equal(model.context_window,32768); assert.equal(model.max_output_tokens,4096);
    await assert.rejects(store.save({...edit,models:[{id:'same'},{id:'same'}]}),/重复/);
    await store.remove('gateway'); assert.equal((await store.list()).providers.length,0);
    const damaged='[providers\n broken'; await writeFile(path,damaged);
    await assert.rejects(store.save(row('http://localhost:1')), /原文件已保留/); assert.equal(await readFile(path,'utf8'),damaged);
    await rm(path); await mkdir(path); await assert.rejects(store.save(row('http://localhost:1')),/读取失败/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('discovery respects protocol authentication and paging, manual overrides win, preset fallback never saves', async () => {
  let failed=false, requests=[];
  const server=await listen((req,res) => { requests.push(req); if(failed){res.writeHead(401);res.end('invalid fixture-secret');return;}
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(req.url.includes('after_id') ? {data:[{id:'embedding-model',output_modalities:['embedding']}],has_more:false} :
      {data:[{id:'fixture-model',context_window:64000,max_input_tokens:60000,max_tokens:8000,capabilities:{vision:{supported:true},thinking:{supported:true,types:{adaptive:{supported:true}}}}}],has_more:true,last_id:'fixture-model'})); });
  const dir=await mkdtemp(join(tmpdir(),'moonya-models-')); const store=new ModelConfigStore(join(dir,'config.toml'));
  try {
    const draft=row(url(server),'anthropic-messages'); const result=await store.discover(draft);
    assert.equal(result.models.length,2); assert.equal(result.models[0].context_window,64000); assert.equal(result.models[0].supports_images,true);
    assert.equal(result.models[1].supports_chat,false); assert.equal(requests[0].headers['x-api-key'],'fixture-secret'); assert.equal(requests[0].headers['anthropic-version'],'2023-06-01');
    const manual=normalizeModel({...result.models[0],capabilities:{vision:{supported:true}},overrides:{supports_images:false,context_window:12345}},'custom','anthropic-messages');
    assert.equal(manual.supports_images,false); assert.equal(manual.context_window,12345);
    failed=true; const fallback=await store.discover({...draft,provider:'deepseek'}); assert.equal(fallback.source,'preset'); assert.ok(fallback.models.length); assert.ok(!fallback.error.includes('fixture-secret'));
    const custom=await store.discover(draft); assert.equal(custom.source,'error'); assert.deepEqual((await store.list()).providers,[]);
  } finally { await close(server); await rm(dir,{recursive:true,force:true}); }
});

test('OpenAI and Anthropic stream images, fragmented tools and signed thinking, with local replay after restart', async () => {
  const requests=[];
  const server=await listen(async(req,res)=>{ requests.push({headers:req.headers,input:await readBody(req),path:req.url}); res.writeHead(200,{'content-type':'text/event-stream'});
    const send = object => res.write('data: '+JSON.stringify(object)+'\r\n\r\n');
    if(req.url.endsWith('/messages')) {
      send({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
      send({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'thought'}});
      send({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signed'}});
      send({type:'content_block_start',index:1,content_block:{type:'text',text:'hello'}});
      send({type:'content_block_start',index:2,content_block:{type:'tool_use',id:'tool1',name:'todo_write',input:{}}});
      send({type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"items":[]}'}});
      send({type:'message_stop'});
    } else {
      send({choices:[{delta:{content:'hello',tool_calls:[{index:0,id:'tool1',function:{name:'todo_write',arguments:'{"items":'}}]}}]});
      send({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'[]}'}}]}}]}); res.write('data: [DONE]\n\n');
    } res.end(); });
  const dir=await mkdtemp(join(tmpdir(),'moonya-models-'));
  try {
    for (const protocol of ['openai-completions','anthropic-messages']) {
      const model={...normalizeModel({id:'fixture',supports_images:true},'custom',protocol),name:'fixture',provider_id:'gateway',base_url:url(server),protocol,api_key:'fixture-secret'};
      const image={type:'image_url',image_url:{url:'data:image/png;base64,YQ=='}};
      const messages=[{role:'system',content:'System'},{role:'user',content:[{type:'text',text:'Test'},image]}];
      const deltas=[], activities=[]; const result=await callModel(model,messages,'auto',AbortSignal.timeout(5000),d=>deltas.push(d),{onActivity:activity=>activities.push(activity)});
      assert.deepEqual(activities,[{phase:'tool_arguments'}]);
      assert.equal(deltas.some(delta=>delta.type==='tool_arguments'),false);
      assert.equal(result.content,'hello'); assert.equal(result.tool_calls[0].function.arguments,'{"items":[]}'); assert.ok(deltas.length);
      if(protocol==='anthropic-messages') {
        assert.equal(requests.at(-1).headers['x-api-key'],'fixture-secret'); assert.equal(requests.at(-1).input.messages[0].content[1].source.media_type,'image/png');
        const history=new ChatHistory(join(dir,'chat.jsonl')); await history.remember('user:1:chat',model,result);
        const replay=await new ChatHistory(join(dir,'chat.jsonl')).replay('user:1:chat',model,[{role:'assistant',content:'hello'}]);
        const payload=anthropicPayload(model,[...messages,...replay,{role:'tool',tool_call_id:'tool1',content:'done'}]);
        assert.equal(payload.messages[1].content[0].signature,'signed'); assert.equal(payload.messages[2].content[0].type,'tool_result');
      } else assert.equal(requests.at(-1).headers.authorization,'Bearer fixture-secret');
    }
    const payload=openaiPayload({name:'glm-5.3',reasoning:'glm',reasoning_required:true,efforts:['low','high','max']},[],'none',{summary:true}); assert.equal(payload.thinking.type,'enabled');
    await assert.rejects(callModel({name:'fixture',protocol:'openai-completions',base_url:'http://127.0.0.1:1',api_key:'fixture-secret'},[], 'none',AbortSignal.timeout(100)),/fetch failed/);
  } finally { await close(server); await rm(dir,{recursive:true,force:true}); }
});

test('advanced capabilities preserve five effort levels and reject invalid combinations', () => {
  const base = {id:'manual',context_window:1048576,context_window_options:[1048576,300000,300000],supports_thinking:true,reasoning:'openai',efforts:['low','medium','high','xhigh','max'],default_effort:'medium'};
  const model = normalizeModel(base,'custom','openai-completions');
  assert.deepEqual(model.context_window_options,[300000,1048576]);
  assert.equal(resolveContextLimit(model),1048576);
  assert.equal(resolveContextLimit(model,300000),300000);
  for (const invalid of [1,1048577,'300000',300000.5]) assert.throws(()=>resolveContextLimit(model,invalid),/上下文档位/);
  assert.equal(resolveModelEffort(model,'auto','high'),'medium');
  assert.equal(resolveModelEffort(model,'xhigh'),'xhigh');
  for (const effort of base.efforts) assert.equal(openaiPayload(model,[],effort).reasoning_effort,effort);
  assert.equal(openaiPayload(model,[],'none').reasoning_effort,'none');
  const required = normalizeModel({...base,reasoning_required:true},'custom','openai-completions');
  assert.equal(required.allow_thinking_off,false);
  assert.throws(()=>resolveModelEffort(required,'none'),/不允许关闭/);
  assert.equal(resolveModelEffort(required,'auto','none'),'medium');
  assert.equal(openaiPayload(required,[],'none',{summary:true}).reasoning_effort,'high');
  assert.throws(()=>normalizeModel({...base,efforts:['high'],default_effort:'medium'},'custom','openai-completions'),/默认思考强度/);
  assert.throws(()=>normalizeModel({...base,reasoning:'auto'},'custom','openai-completions'),/请选择/);
  assert.throws(()=>normalizeModel({...base,context_window_options:[1048577]},'custom','openai-completions'),/上下文档位/);
  const unsupported = normalizeModel({id:'text',context_window:4096},'custom','openai-completions');
  assert.equal(resolveModelEffort(unsupported),'none');
  assert.throws(()=>resolveModelEffort(unsupported,'high'),/不支持思考/);
  for (const protocol of ['openai-completions','anthropic-messages']) {
    const reasoning = protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
    const toggle = normalizeModel({id:'toggle',context_window:8192,supports_thinking:true,reasoning},'custom',protocol);
    assert.deepEqual(toggle.efforts,[]);
    assert.equal(resolveModelEffort(toggle,'auto','none'),'none');
  }
  const anthropic = normalizeModel({...base,custom_protocol:true,protocol:'anthropic-messages',reasoning:'anthropic',thinking_type:'adaptive'},'custom','openai-completions');
  for (const effort of base.efforts) assert.equal(anthropicPayload(anthropic,[],{},effort).output_config.effort,effort);
  assert.equal(anthropicPayload(anthropic,[],{},'none').thinking,undefined);
  const budgets = {...anthropic,thinking_type:'enabled',max_output_tokens:65536};
  for (const [effort,budget] of Object.entries({low:1024,medium:2048,high:4096,xhigh:8192,max:16384})) assert.equal(anthropicPayload(budgets,[],{},effort).thinking.budget_tokens,budget);
  for (const reasoning of ['deepseek','kimi','glm','minimax']) {
    const vendor=normalizeModel({...base,reasoning},'custom','openai-completions');
    for (const effort of base.efforts) assert.equal(openaiPayload(vendor,[],effort).reasoning_effort,effort);
    assert.equal(openaiPayload(vendor,[],'none').thinking.type,'disabled');
  }
  assert.throws(()=>normalizeModel({...base,custom_protocol:true,protocol:'anthropic-messages'},'custom','openai-completions'),/不兼容/);
});

test('advanced overrides survive TOML restart and clearing capacities restores discovered defaults', async () => {
  const dir=await mkdtemp(join(tmpdir(),'moonya-advanced-'));
  try {
    const store=new ModelConfigStore(join(dir,'config.toml'));
    const discovered=normalizeModel({id:'fixture-model',context_window:1048576,max_output_tokens:8192},'custom','openai-completions');
    const advanced={...discovered,overrides:{context_window:65536,max_output_tokens:4096,context_window_options:[32768,65536],supports_thinking:true,reasoning:'anthropic',custom_protocol:true,protocol:'anthropic-messages',efforts:['medium','xhigh'],default_effort:'medium'}};
    const saved=await store.save({...row('http://localhost:1/v1'),models:[advanced]});
    const restarted=new ModelConfigStore(store.path), ref={provider_id:'gateway',model_id:'fixture-model'};
    const model=await restarted.resolve(ref);
    assert.equal(model.protocol,'anthropic-messages');
    assert.equal(model.context_window,65536);
    assert.deepEqual(model.efforts,['medium','xhigh']);
    const editing=saved.providers[0];
    delete editing.models[0].overrides.context_window;
    delete editing.models[0].overrides.max_output_tokens;
    delete editing.models[0].overrides.context_window_options;
    editing.models[0].context_window_source='api';
    editing.models[0].context_window_options=[1048576];
    await restarted.save(editing);
    const restored=await restarted.resolve(ref);
    assert.equal(restored.context_window,1048576);
    assert.equal(restored.max_output_tokens,8192);
    assert.deepEqual(restored.context_window_options,[1048576]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

async function runtimeFixture() {
  const dir=await mkdtemp(join(tmpdir(),'moonya-model-runtime-')); const probe=await listen(()=>{}), port=probe.address().port; await close(probe);
  let child; const api=async(path,input)=>{ const response=await fetch(`http://127.0.0.1:${port}${path}`,input===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}); return response.json(); };
  const start=async()=>{ child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,MOONYA_DATA_ROOT:dir,MOONYA_HARNESS_DATA:join(dir,'agent-runtime'),MOONYA_HARNESS_PORT:String(port)},stdio:'ignore'});
    for(let n=0;n<200;n++){try{if((await api('/health')).status==='ok')return;}catch{} await new Promise(r=>setTimeout(r,20));} throw new Error('runtime did not start'); };
  const stop=async()=>{ const exited=new Promise(r=>child.once('exit',r)); child.kill(); await exited; };
  await start(); return {dir,api,base:`http://127.0.0.1:${port}`,restart:async()=>{await stop();await start();},close:async()=>{await stop();await rm(dir,{recursive:true,force:true});}};
}

test('GPT Responses and Gemini thinking reach Work tools and Chat journals, resume once and restore protocol history', {timeout:20000}, async () => {
  const inputs = [], errors = [];
  const thought = {type:'reasoning',id:'rs_1',summary:[{type:'summary_text',text:'检查配置。'}],encrypted_content:'opaque'};
  const answer = {type:'message',id:'msg_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'finished',annotations:[]}]};
  const call = {type:'function_call',id:'fc_1',call_id:'todo_1',name:'todo_write',arguments:'{"todos":[]}',status:'completed'};
  const server = await listen(async (req,res) => {
    try {
      const input = await readBody(req); inputs.push({path:req.url,input});
      const responses = req.url.endsWith('/responses');
      const messages = input.input || input.messages;
      const hasTool = messages.some(m=>m.type==='function_call_output'||m.role==='tool');
      const work = !!input.tools?.length;
      if (hasTool && responses) {
        assert.equal(messages.find(m=>m.type==='reasoning').encrypted_content,'opaque');
        assert.equal(messages.find(m=>m.type==='function_call').call_id,'todo_1');
      } else if (hasTool) assert.equal(messages.find(m=>m.role==='assistant').tool_calls[0].extra_content.google.thought_signature,'signed');
      res.writeHead(200,{'content-type':'text/event-stream'});
      const send = event => res.write('data: '+JSON.stringify(event)+'\n\n');
      if (responses) {
        assert.ok(input.reasoning.summary==='auto');
        const output = [thought,work&&!hasTool?call:answer];
        for (const [index,item] of output.entries()) send({type:'response.output_item.done',output_index:index,item});
        send({type:'response.completed',response:{status:'completed',output,usage:{input_tokens:100,input_tokens_details:{cached_tokens:10},output_tokens:20}}});
      } else {
        assert.equal(input.extra_body.google.thinking_config.include_thoughts,true);
        assert.equal(input.reasoning_effort,undefined);
        send({choices:[{delta:{reasoning_content:'检查配置。',...(work&&!hasTool?{tool_calls:[{index:0,id:'todo_1',type:'function',function:{name:'todo_write',arguments:'{"todos":[]}'},extra_content:{google:{thought_signature:'signed'}}}]}:{content:'finished'})}}]});
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); res.destroy(); }
  });
  const f = await runtimeFixture();
  const events = text => text.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)));
  const chat = async input => events(await (await fetch(f.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).text());
  try {
    for (const id of ['gpt-6.1-sol','gemini-3.8-flash']) {
      const model = {id,overrides:{context_window:32768,max_output_tokens:4096,...(id==='gpt-6.1-sol'?{custom_protocol:true,protocol:'openai-responses'}:{})}};
      await f.api('/v1/model-config',{action:'save',provider:{...row(url(server)+'/chat/completions'),models:[model]}});
      const ref = {provider_id:'gateway',model_id:id};
      const session = await f.api('/v1/sessions',{workspace:f.dir,user_context:'owner'});
      await f.api(`/v1/sessions/${session.id}/messages`,{content:'Hi',model_ref:ref,reasoning_effort:'medium'});
      let snapshot;
      for(let n=0;n<400;n++){snapshot=await f.api(`/v1/sessions/${session.id}`);if(['completed','error'].includes(snapshot.status))break;await new Promise(r=>setTimeout(r,20));}
      assert.equal(snapshot.status,'completed',JSON.stringify(snapshot.events.at(-1)));
      assert.equal(snapshot.events.filter(e=>e.event==='reasoning.delta').map(e=>e.payload.delta).join(''),'检查配置。检查配置。');
      assert.ok(snapshot.events.some(e=>e.event==='todo.updated'), JSON.stringify(snapshot.events.filter(e=>e.event.startsWith('tool.')||e.event.startsWith('todo.'))));
      const savedThought = snapshot.events.find(e=>e.event==='assistant.message'&&e.payload.provider_content);
      assert.ok(savedThought,'Work must retain provider history');
      const input = {model_ref:ref,messages:[{role:'user',content:'Hi'}],user_context:'owner',conversation_id:id,client_message_id:'first-'+id,reasoning_effort:'medium'};
      const output = await chat(input);
      assert.equal(output.filter(e=>e.choices?.[0]?.delta?.reasoning_content).map(e=>e.choices[0].delta.reasoning_content).join(''),'检查配置。');
      assert.equal(output.at(-1).moonya_status,'completed');
      const count = inputs.length;
      const resumed = await chat({...input,messages:[],resume:true,after_seq:output.find(e=>e.choices?.[0]?.delta?.reasoning_content).moonya_seq});
      assert.equal(inputs.length,count); assert.ok(!resumed.some(e=>e.choices?.[0]?.delta?.reasoning_content));
      await f.restart();
      const restarted = await f.api(`/v1/sessions/${session.id}`);
      assert.deepEqual(restarted.events.find(e=>e.event==='assistant.message'&&e.payload.provider_content).payload.provider_content,savedThought.payload.provider_content);
      const followup = await chat({...input,client_message_id:'second-'+id,messages:[{role:'user',content:'Hi'},{role:'assistant',content:'finished',_moonya_message_id:'first-'+id},{role:'user',content:'Continue'}]});
      assert.equal(followup.at(-1).moonya_status,'completed');
      if(id==='gpt-6.1-sol') assert.equal(inputs.at(-1).input.input.find(m=>m.type==='reasoning').encrypted_content,'opaque');
      assert.ok(inputs.filter(r=>r.input.model===id).every(r=>r.path===(id==='gpt-6.1-sol'?'/v1/responses':'/v1/chat/completions')));
    }
    assert.deepEqual(errors,[]);
  } finally { await f.close(); await close(server); }
});
test('pending models cannot test or generate, and a confirmed 8192 window controls Chat and Work', {timeout:15000}, async()=>{
  const requests=[];
  const upstream=await listen(async(req,res)=>{
    requests.push(await readBody(req));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'}}]}));
  });
  const f=await runtimeFixture();
  try {
    const provider={...row(url(upstream)),models:[{id:'pending',context_window:null,context_window_source:'unknown'}]};
    const ref={provider_id:'gateway',model_id:'pending'};
    await f.api('/v1/model-config',{action:'save',provider});
    const session=await f.api('/v1/sessions',{workspace:f.dir,user_context:'owner'});
    const chatInput={model_ref:ref,messages:[{role:'system',content:'System'},{role:'user',content:'Hi'}],user_context:'owner',conversation_id:'small',client_message_id:'pending'};
    for(const [path,input] of [
      ['/v1/model-config',{action:'test',provider,model_id:'pending'}],
      ['/v1/llm/chat',chatInput],
      [`/v1/sessions/${session.id}/messages`,{content:'Hi',model_ref:ref}],
    ]) {
      const response=await fetch(f.base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      assert.ok(!response.ok);
      assert.match(await response.text(),/真实上下文长度/);
    }
    assert.equal(requests.length,0,'unknown models must never reach the provider');
    await f.api('/v1/model-config',{action:'save',provider:{...provider,models:[{id:'pending',overrides:{context_window:8192,max_output_tokens:20000}}]}});
    const invalid=await f.api('/v1/llm/chat',{...chatInput,client_message_id:'invalid',context_limit:1000000});
    assert.match(invalid.error,/上下文档位/);
    const chat=await fetch(f.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...chatInput,client_message_id:'confirmed',context_limit:8192})});
    const events=(await chat.text()).split('\n').filter(line=>line.startsWith('data: ') && line.slice(6)!=='[DONE]').map(line=>JSON.parse(line.slice(6)));
    const usage=events.find(event=>event.moonya_context)?.moonya_context;
    assert.equal(usage.limit_tokens,8192);
    assert.deepEqual(usage.model_ref,ref);
    assert.ok(requests.at(-1).max_tokens+usage.used_tokens<=8192);
    const invalidWork=await f.api(`/v1/sessions/${session.id}/messages`,{content:'Hi',model_ref:ref,context_limit:300000});
    assert.match(invalidWork.error,/上下文档位/);
    await f.api(`/v1/sessions/${session.id}/messages`,{content:'Hi',model_ref:ref,context_limit:8192});
    let snapshot;
    for(let n=0;n<400;n++) {
      snapshot=await f.api(`/v1/sessions/${session.id}`);
      if(['completed','error'].includes(snapshot.status))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(snapshot.status,'completed',JSON.stringify(snapshot.events.at(-1)));
    const workUsage=snapshot.events.findLast(event=>event.event==='context.usage').payload;
    assert.equal(workUsage.limit_tokens,8192);
    assert.deepEqual(workUsage.model_ref,ref);
    assert.ok(requests.at(-1).max_tokens+workUsage.used_tokens<=8192);
  } finally { await f.close();await close(upstream); }
});

test('both saved protocols drive Work tools, child agents inherit pinned configuration and Chat survives restart', {timeout:20000}, async()=>{
  const errors=[], inputs=[]; let fixture, rotated = false;
  const model=await listen(async(req,res)=>{try{
    const input=await readBody(req); inputs.push(input); const anthropic=req.url.endsWith('/messages');
    assert.equal(req.headers.authorization || req.headers['x-api-key'], req.headers.authorization ? 'Bearer fixture-secret' : 'fixture-secret');
    const child=JSON.stringify(input.messages).includes('child-test'); const hasTool=JSON.stringify(input.messages).includes('tool_result') || input.messages.some(m=>m.role==='tool');
    if (child && !rotated) { rotated = true; await fixture.api('/v1/model-config',{action:'save',provider:{...row('http://127.0.0.1:1/v1'),api_key:'rotated-secret'}}); }
    let calls=[]; if(input.tools && !hasTool) calls=[{id:'sub',name:'subagent',input:{prompt:'child-test',description:'Child'}}];
    if(child) calls=[];
    res.setHeader('content-type','application/json');
    if(anthropic)res.end(JSON.stringify({content:calls.length?calls.map(c=>({type:'tool_use',...c})):[{type:'text',text:'finished'}],stop_reason:calls.length?'tool_use':'end_turn'}));
    else res.end(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'finished',tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.input)}}))}}]}));
  }catch(e){errors.push(e);res.writeHead(500);res.end(e.message);}});
  fixture=await runtimeFixture();
  try{
    for(const protocol of ['openai-completions','anthropic-messages']){
      const advanced = row(url(model),protocol);
      advanced.models[0] = {...advanced.models[0],context_window_options:[24576,32768],supports_thinking:true,reasoning:protocol === 'anthropic-messages' ? 'anthropic' : 'openai',thinking_type:'adaptive',efforts:['low','medium','high','xhigh','max'],default_effort:'medium'};
      await fixture.api('/v1/model-config',{action:'save',provider:advanced});
      const before = inputs.length;
      const session=await fixture.api('/v1/sessions',{workspace:fixture.dir,user_context:'user:models'});
      await fixture.api(`/v1/sessions/${session.id}/messages`,{content:'Root task',context_limit:24576,reasoning_effort:'xhigh',model_ref:{provider_id:'gateway',model_id:'fixture-model'}});
      let snapshot; for(let n=0;n<400;n++){snapshot=await fixture.api(`/v1/sessions/${session.id}`);if(['completed','error'].includes(snapshot.status))break;await new Promise(r=>setTimeout(r,20));}
      assert.equal(snapshot.status,'completed',JSON.stringify(snapshot.events.at(-1)));
      const usage = snapshot.events.findLast(event => event.event === 'context.usage').payload;
      assert.equal(usage.limit_tokens,24576);
      assert.equal(usage.model_ref.model_id,'fixture-model');
      const office=await fixture.api(`/v1/sessions/${session.id}/office`); assert.equal(office.employees.length,1);
      assert.ok(inputs.slice(before).every(input => (input.output_config?.effort || input.reasoning_effort) === 'xhigh'), 'parent and child preserve the selected effort even after configuration rotation');
      const child = await fixture.api(`/v1/sessions/${office.employees[0].child_id}`);
      assert.equal(child.events.findLast(event => event.event === 'context.usage').payload.limit_tokens,24576);
      assert.ok(inputs.every(input=>input.model==='fixture-model'));
      await fixture.api('/v1/model-config',{action:'save',provider:row(url(model),protocol)});
      const chat=await fetch(fixture.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model_ref:{provider_id:'gateway',model_id:'fixture-model'},messages:[{role:'system',content:'System'},{role:'user',content:'Hi'}],user_context:'1',conversation_id:'test'})});
      assert.match(await chat.text(),/finished/);
      const followup=await fetch(fixture.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model_ref:{provider_id:'gateway',model_id:'fixture-model'},messages:[{role:'system',content:'System'},{role:'user',content:'Hi'},{role:'assistant',content:'finished'},{role:'user',content:'Continue'}],user_context:'1',conversation_id:'test'})});
      assert.match(await followup.text(),/finished/);
      assert.ok(JSON.stringify(inputs.at(-1).messages).includes('Continue'));
    }
    await fixture.restart(); assert.equal((await fixture.api('/v1/model-config')).providers[0].has_key,true);
    for (const name of await readdir(join(fixture.dir,'agent-runtime','sessions'))) assert.ok(!(await readFile(join(fixture.dir,'agent-runtime','sessions',name),'utf8')).includes('fixture-secret'));
    assert.deepEqual(errors,[]);
  }finally{await fixture.close();await close(model);}
});

test('Chat reconnect replays once, concurrent subscribers share generation, and explicit cancellation aborts both protocols', {timeout:15000}, async()=>{
  let requests=0, upstreamClosed=0;
  const server=await listen(async(req,res)=>{
    await readBody(req); requests++; res.writeHead(200,{'content-type':'text/event-stream'});
    const send=event=>res.write('data: '+JSON.stringify(event)+'\n\n');
    if(req.url.endsWith('/messages')) { send({type:'content_block_start',index:0,content_block:{type:'text',text:'partial'}}); }
    else send({choices:[{delta:{content:'partial'}}]});
    res.on('close',()=>{upstreamClosed++;});
  });
  const f=await runtimeFixture();
  try{
    for (const [index,protocol] of ['openai-completions','anthropic-messages'].entries()) {
      await f.api('/v1/model-config',{action:'save',provider:row(url(server),protocol)});
      const input={model_ref:{provider_id:'gateway',model_id:'fixture-model'},user_context:'owner',conversation_id:'chat',client_message_id:'request-'+index,
        messages:[{role:'system',content:'System'},{role:'user',content:'Hi'}]};
      const stream=await fetch(f.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      const reader=stream.body.getReader(); let text='',seq=0;
      while(!text.includes('partial')){const chunk=await reader.read();assert.ok(!chunk.done,'stream ended before the partial reply: '+text);text+=new TextDecoder().decode(chunk.value);}
      for(const match of text.matchAll(/data: (.+)/g)){const event=JSON.parse(match[1]);seq=Math.max(seq,event.moonya_seq);}
      await reader.cancel();
      const resume=await fetch(f.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,messages:[],resume:true,after_seq:seq})});
      const cancelled=await f.api('/v1/llm/cancel',input);assert.equal(cancelled.success,true);
      const rest=await resume.text();assert.match(rest,/cancelled/);assert.ok(!rest.includes('partial'),'already received delta must not replay');
      assert.equal(requests,index+1,'reconnect must not call the model again');
      const terminal=await fetch(f.base+'/v1/llm/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,resume:true,after_seq:0})});
      assert.match(await terminal.text(),/partial/);
    }
    await f.restart();assert.equal(requests,2);assert.equal(upstreamClosed,2);
  }finally{await f.close();await close(server);}
});
