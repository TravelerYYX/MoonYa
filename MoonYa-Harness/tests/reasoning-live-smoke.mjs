// Opt-in: sends a harmless calculator tool round trip using saved database credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { callModel } from '../src/model-client.mjs';
import { normalizeModel } from '../src/model-catalog.mjs';
if (process.argv[2] !== '--live') throw new Error('Usage: node tests/reasoning-live-smoke.mjs --live [model-id]');
const backend=fileURLToPath(new URL('../../MoonYa-Backend/',import.meta.url));
const ids=process.argv[3]?[process.argv[3]]:['gpt-6.1-sol','gemini-3.8-flash'];
for (const id of ids) {
  // stdout stays in memory. Only the final smoke report is printed.
  const php='require "Services/BuiltinModelService.php"; $config=require "config.php"; $service=new BuiltinModelService(MembershipService::connect($config),$config); echo json_encode($service->resolve($argv[1]),JSON_THROW_ON_ERROR);';
  const {stdout}=await promisify(execFile)(process.env.PHP_BIN||'php',['-r',php,id],{cwd:backend,windowsHide:true});
  const row=JSON.parse(stdout);
  const model={...normalizeModel({id,overrides:{context_window:row.capabilities.context_window}},'custom','openai-completions'),
    provider_id:'live-wawapi',name:row.upstream_model,base_url:row.endpoint,api_key:row.api_key,
    protocol:id==='gpt-6.1-sol'?'openai-responses':'openai-completions'};
  const tools=[{type:'function',function:{name:'sum_numbers',description:'Return the sum of two numbers.',parameters:{type:'object',properties:{a:{type:'number'},b:{type:'number'}},required:['a','b']}}}];
  const messages=[{role:'user',content:'请调用 sum_numbers 工具计算 127 + 389，再给出结果。'}];
  try {
    const first=await callModel(model,messages,'medium',AbortSignal.timeout(55000),async()=>{},{tools,maxTokens:4096});
    if (!first.tool_calls.length) throw new Error('Supplier returned no requested tool call');
    messages.push(first);
    for(const call of first.tool_calls){
      const input=JSON.parse(call.function.arguments);
      const number=value=>typeof value==='number'?value:typeof value==='string'&&/^-?\d+(\.\d+)?$/.test(value)?Number(value):NaN;
      const a=number(input.a),b=number(input.b);
      if(call.function.name!=='sum_numbers'||!Number.isFinite(a)||!Number.isFinite(b))throw new Error('Invalid calculator call');
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({result:a+b})});
    }
    const final=await callModel(model,messages,'medium',AbortSignal.timeout(55000),async()=>{},{tools,maxTokens:4096});
    if (!final.content.includes('516')) throw new Error('Supplier did not use calculator result');
    console.log(JSON.stringify({model:id,tool_calls:first.tool_calls.length,reasoning_chars:first.reasoning_content.length+final.reasoning_content.length,answer_chars:final.content.length,tool_result_verified:true}));
  }catch(error){console.log(JSON.stringify({model:id,error:String(error.message).replaceAll(row.api_key,'[redacted]')}));process.exitCode=1;}
}
