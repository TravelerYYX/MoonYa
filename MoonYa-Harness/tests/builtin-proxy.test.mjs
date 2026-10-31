import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const exec=promisify(execFile),root=fileURLToPath(new URL('../../MoonYa-Backend/',import.meta.url));
const php=process.env.PHP_BIN||'php';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('database GPT Responses and Gemini serve real PHP Chat and raw Work streams, including JSON fallback and billing', async()=>{
  let mode='stream', protocol='openai-responses', effort='medium'; const requests=[];
  const output=[{id:'r1',type:'reasoning',summary:[{type:'summary_text',text:'检查配置'}],encrypted_content:'opaque'},
    {id:'m1',type:'message',role:'assistant',content:[{type:'output_text',text:'完成'}],status:'completed'}];
  const response={status:'completed',output,usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:10}}};
  const upstream=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);requests.push(input);
    assert.equal(req.headers.authorization,'Bearer fixture-key');
    if(protocol==='openai-responses'){
      assert.equal(req.url,'/v1/responses');assert.deepEqual(input.reasoning,{effort,summary:'auto'});
      assert.equal(input.messages,undefined);assert.equal(input.stream_options,undefined);assert.equal(input.max_output_tokens,1024);
      assert.ok(input.input.some(item=>item.role==='user'));assert.equal(input.store,false);
      if(mode==='json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(response));}
      res.setHeader('content-type','text/event-stream');
      const events=[{type:'response.reasoning_summary_text.delta',output_index:0,summary_index:0,delta:'检查配置'},
        {type:'response.output_text.delta',output_index:1,content_index:0,delta:'完成'},
        ...(mode==='truncated'?[]:[{type:'response.completed',response}])];
      const wire=events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join('');
      for(let i=0;i<wire.length;i+=17)res.write(wire.slice(i,i+17));res.end();
    }else{
      assert.equal(req.url,'/v1/chat/completions');assert.equal(input.reasoning_effort,undefined);
      assert.deepEqual(input.extra_body.google.thinking_config,{thinking_level:effort,include_thoughts:true});
      const message={content:[{type:'text',text:'检查配置',thought:true},{type:'text',text:'完成'}]};
      const usage={prompt_tokens:100,completion_tokens:20};
      if(mode==='json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({choices:[{message}],usage}));}
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:message,finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const fixture=async(...args)=>(await exec(php,[join(root,'tests/membership_fixture.php'),...args],{windowsHide:true})).stdout;
  let database,child;
  try{
    database=(await fixture('create',`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`)).trim();
    const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    const base=`http://127.0.0.1:${port}`;let errors='';
    child=spawn(php,['-S',`127.0.0.1:${port}`,join(root,'tests/membership_proxy_router.php')],{windowsHide:true,env:{...process.env,MOONYA_TEST_DATABASE:database},stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>errors+=chunk);
    let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/ready')).ok){ready=true;break;}}catch{}await delay(30);}assert.ok(ready,errors);
    const token=await fixture('auth',database);
    const send=async(path,data,admin=false)=>{const r=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+(admin?token:'fixture-user'),'content-type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200,errors);return r.text();};
    const save=async()=>send('/models',{id:'protocol-test',label:'Protocol fixture',upstream_model:'supplier-test',endpoint:`http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,api_key:'fixture-key',multiplier:'1',enabled:true,capabilities:{protocol,context_window:8192,max_output_tokens:1024,supports_thinking:true,supports_tools:true,reasoning:protocol==='openai-responses'?'openai':'gemini',efforts:['low','medium','high'],default_effort:'medium',reasoning_required:true}},true);
    const chat=()=>send('/chat',{message:'hi',deepseekModelVersion:'protocol-test',client_chat_id:'protocol-fixture',context_limit:8192,reasoningProfileVersion:2,reasoningProfile:'medium',reasoningEffort:'medium'});
    for(protocol of ['openai-responses','openai-completions']){
      await save();
      for(mode of ['stream','json']){
        effort='medium';
        const text=await chat();const events=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
        assert.equal(events.filter(event=>event.type==='thinking').map(event=>event.content).join(''),'检查配置');
        assert.equal(events.filter(event=>event.type==='content').map(event=>event.content).join(''),'完成');assert.match(text,/"type":"done"/);assert.equal(text.match(/"type":"thinking"/g)?.length,1,text);
        assert.match(text,/"status":"completed"/);assert.match(text,/credits_update/);
        effort='low';
        const raw=await send('/proxy',{model:'protocol-test',stream:true,...(protocol==='openai-responses'?{input:[{role:'user',content:'hi'}],reasoning:{effort,summary:'auto'}}:{messages:[{role:'user',content:'hi'}],extra_body:{google:{thinking_config:{thinking_level:effort,include_thoughts:true}}}})});
        assert.match(raw,protocol==='openai-responses'?/response.completed/:/thought/);assert.match(raw,/credits_update/);
      }
    }
    protocol='openai-responses';effort='medium';await save();mode='truncated';const text=await chat();const decoded=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
    assert.match(decoded.filter(event=>event.type==='error').map(event=>event.content).join(''),/响应不完整/);assert.match(text,/"status":"failed"/);
    assert.equal(requests.length,9);const state=JSON.parse(await fixture('inspect',database));assert.equal(state.calls.length,9);assert.equal(state.calls.at(-1).status,'usage_missing');
  } finally {
    if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
    if(database)await fixture('drop',database);upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
  }
});
test('real PHP proxy maps models, settles fragmented/final usage before DONE, journals missing usage, and blocks exhausted requests',async()=>{
  let mode='stream',calls=0,upstreamId='deepseek-flash',expectedReasoning,expectNoEffort=false;
  const upstream=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);calls++;
    assert.equal(input.model,upstreamId);assert.equal(req.headers.authorization,'Bearer fixture-key');
    assert.equal(input.stream_options.include_usage,true);
    if(expectedReasoning!==undefined){assert.equal(input.reasoning_effort,expectedReasoning);assert.equal(input.max_completion_tokens,1024);assert.equal(input.thinking,undefined);}
    if(expectNoEffort)assert.equal(input.reasoning_effort,undefined);
    assert.ok(input.messages.some(message=>message.role==='user'&&(message.content==='hi'||Array.isArray(message.content)&&message.content.some(part=>part.type==='text'&&part.text==='hi'))),'selected models receive the real user text');
    if(mode==='json'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({choices:[{message:{content:'JSON result'}}],usage:{prompt_tokens:1000,completion_tokens:0}}));}
    res.setHeader('content-type','text/event-stream');
    const body='data: '+JSON.stringify({choices:[{delta:{content:'actual output'},finish_reason:'stop'}]})+'\r\n\r\n'+(mode==='missing'?'':'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:700,prompt_cache_hit_tokens:500}})+'\n\ndata: '+JSON.stringify({choices:[],usage:{completion_tokens:300,completion_tokens_details:{reasoning_tokens:100}}}));
    for(let i=0;i<body.length;i+=13){res.write(body.slice(i,i+13));await delay(1);}res.end(); // Usage has no final newline.
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const fixture=async(...args)=>(await exec(php,[join(root,'tests/membership_fixture.php'),...args],{windowsHide:true})).stdout;
  let database,child;
  try{
    database=(await fixture('create',`http://127.0.0.1:${upstream.address().port}/chat/completions`)).trim();
    const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    const base=`http://127.0.0.1:${port}`;let errors='';
    child=spawn(php,['-S',`127.0.0.1:${port}`,join(root,'tests/membership_proxy_router.php')],{windowsHide:true,env:{...process.env,MOONYA_TEST_DATABASE:database},stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>errors+=chunk);
    let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/ready')).ok){ready=true;break;}}catch{}await delay(30);}assert.ok(ready,errors);
    const send=(model='deepseek-flash')=>fetch(base+'/proxy',{method:'POST',headers:{Authorization:'Bearer fixture-user','content-type':'application/json'},body:JSON.stringify({model,stream:true,messages:[{role:'user',content:'hi'}]})});
    const response=await send();assert.equal(response.status,200);const text=await response.text();assert.match(text,/actual output/,errors);assert.ok(text.indexOf('credits_update')<text.indexOf('[DONE]'));
    let state=JSON.parse(await fixture('inspect',database));assert.equal(state.account.balance,'99.850000');assert.equal(state.calls.length,1);
    mode='missing';await(await send()).text();state=JSON.parse(await fixture('inspect',database));assert.equal(state.account.balance,'99.850000');assert.equal(state.calls[1].status,'usage_missing');
    mode='json';assert.match(await(await send()).text(),/JSON result/);state=JSON.parse(await fixture('inspect',database));assert.equal(state.account.balance,'99.700000');
    await fixture('adjust',database,'-99.6');mode='stream';assert.match(await(await send()).text(),/"exhausted":true/);
    assert.equal(JSON.parse(await fixture('inspect',database)).account.balance,'0.000000');const stopped=await send();assert.equal(stopped.status,402);assert.match(await stopped.text(),/credits_exhausted/);assert.equal(calls,4);
    const unauth=await fetch(base+'/proxy',{method:'POST',headers:{Authorization:'Bearer invalid'},body:'{}'});assert.equal(unauth.status,401);
    const token=await fixture('auth',database);
    const admin=async(path,method='GET',body)=>{
      const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.success,true);return data.data;
    };
    const plan=await admin('/plans','POST',{code:'test',name:'后台新套餐',price_cents:1234,monthly_credits:'500',description:'editable',features:[{title:'后台分组',items:['真实介绍']}],sort_order:6,enabled:true});
    await admin('/users?action=set_membership&user_id=1','POST',{plan_id:plan.id});
    const snapshot=(await admin('/users?action=membership&user_id=1')).account;assert.equal(snapshot.balance,'500.000000');assert.ok(snapshot.expires_at);
    await admin('/plans','PUT',{...plan,enabled:false});await admin('/plans','DELETE',{id:plan.id});
    assert.equal((await admin('/users?action=membership&user_id=1')).account.plan.name,'后台新套餐');
    const model={id:'new-catalog-id',label:'后台新模型',upstream_model:'real-supplier-id',endpoint:`http://127.0.0.1:${upstream.address().port}/chat/completions`,api_key:'fixture-key',multiplier:'0.25',enabled:true,is_default:true,capabilities:{context_window:8192,max_output_tokens:1024,supports_tools:true}};
    await admin('/models','POST',model);upstreamId=model.upstream_model;
    const catalog=await(await fetch(base+'/catalog')).json();assert.equal(catalog.data.modelGroups.deepseek.default,model.id);assert.doesNotMatch(JSON.stringify(catalog),/fixture-key/);
    const listed=await admin('/models');assert.doesNotMatch(JSON.stringify(listed),/fixture-key/);assert.equal(listed.items[0].has_api_key,true);
    await(await send(model.id)).text();assert.equal(JSON.parse(await fixture('inspect',database)).account.balance,'499.750000');
    await admin('/models','PUT',{...model,api_key:'',multiplier:'0.5'});await(await send(model.id)).text();assert.equal(JSON.parse(await fixture('inspect',database)).account.balance,'499.250000');
    await admin('/models','PUT',{...model,api_key:'',multiplier:'0.5',capabilities:{...model.capabilities,supports_thinking:true,reasoning:'openai',efforts:['low','high']}});
    expectedReasoning='none';
    const chat=await fetch(base+'/chat',{method:'POST',headers:{Authorization:'Bearer fixture-user','content-type':'application/json'},body:JSON.stringify({message:'hi',deepseekModelVersion:model.id,deepThinking:false,agent_mode:'normal',client_chat_id:'fixture-chat',context_limit:8192})});
    const chatText=await chat.text();assert.match(chatText,/actual output/);assert.match(chatText,/credits_update/);
    assert.ok(chatText.indexOf('credits_update')<chatText.lastIndexOf('"type":"done"'));
    assert.equal(JSON.parse(await fixture('inspect',database)).account.balance,'498.750000');
    await admin('/users?action=adjust_credits&user_id=1','POST',{delta:'-498.65',reason:'quota final stats'});
    const exhaustedChat=await(await fetch(base+'/chat',{method:'POST',headers:{Authorization:'Bearer fixture-user','content-type':'application/json'},body:JSON.stringify({message:'hi',deepseekModelVersion:model.id,deepThinking:false,agent_mode:'normal',client_chat_id:'fixture-chat',context_limit:8192})})).text();
    assert.match(exhaustedChat,/credits_exhausted/);assert.match(exhaustedChat,/statistics_record/);
    assert.ok(exhaustedChat.lastIndexOf('statistics_record')<exhaustedChat.indexOf('credits_exhausted'));
    assert.equal(JSON.parse(await fixture('inspect',database)).account.balance,'0.000000');
    await admin('/models','DELETE',{id:model.id});const disabled=await send(model.id);assert.equal(disabled.status,400);assert.equal(calls,8);
    const logs=JSON.parse(await fixture('logs',database));assert.equal(logs.length,9);assert.doesNotMatch(JSON.stringify(logs),/fixture-key/);
    // Exercise the versioned Chat contract against the real PHP endpoint and database.
    const exactModel={...model,id:'exact-tiers',api_key:'fixture-key',capabilities:{...model.capabilities,supports_thinking:true,reasoning:'openai',efforts:['medium','xhigh','ultra'],default_effort:'medium',effort_labels:{medium:'日常',xhigh:'认真'}}};
    await admin('/models','POST',exactModel);
    const exactCatalog=await(await fetch(base+'/catalog')).json();
    assert.equal(exactCatalog.data.modelCapabilities['exact-tiers'].default_effort,'medium');
    assert.equal(exactCatalog.data.modelCapabilities['exact-tiers'].effort_labels.xhigh,'认真');
    await admin('/users?action=adjust_credits&user_id=1','POST',{delta:'5',reason:'exact tier fixture'});
    const exactChat=effort=>fetch(base+'/chat',{method:'POST',headers:{Authorization:'Bearer fixture-user','content-type':'application/json'},body:JSON.stringify({message:'hi',deepseekModelVersion:exactModel.id,agent_mode:'normal',client_chat_id:'exact-'+effort,context_limit:8192,reasoningProfileVersion:2,reasoningProfile:effort,reasoningEffort:effort})});
    for(const effort of ['medium','xhigh','ultra']) {
      expectedReasoning=effort;assert.match(await(await exactChat(effort)).text(),/actual output/);
    }
    const beforeRejected=calls;
    assert.match(await(await exactChat('high')).text(),/不支持该思考强度/);assert.equal(calls,beforeRejected);
    await admin('/models','PUT',{...exactModel,api_key:'',capabilities:{...exactModel.capabilities,efforts:[],default_effort:'auto',effort_labels:{}}});
    expectedReasoning=undefined;expectNoEffort=true;
    assert.match(await(await exactChat('auto')).text(),/actual output/);
  }finally{if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}if(database)await fixture('drop',database);upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
});
