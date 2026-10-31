import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {callModel} from '../src/model-client.mjs';
import {guardBuiltinCredits,clearCreditScope} from '../src/builtin-credit.mjs';
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
test('built-in settlement stops shared child scopes, never retries quota, and custom keys remain exempt',async()=>{
  let balance='1',calls=0,checks=0;const server=createServer(async(req,res)=>{
    req.resume();
    if(req.url==='/balance'){checks++;res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,data:{account:{balance}}}));}
    calls++;res.setHeader('content-type','text/event-stream');
    res.write(frame({choices:[{delta:{content:'保留已生成内容'}}]}));
    res.end(frame({type:'credits_update',data:{exhausted:true,call_id:'actual-call',account:{balance:'0'}}})+'data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const model={builtin:true,credit_scope:'parent-child',credit_url:base+'/balance',base_url:base+'/v1',name:'catalog-id',api_key:'ephemeral',protocol:'openai-completions',supports_thinking:false};
  try{
    let billing;const response=await callModel(model,[{role:'user',content:'hi'}],'none',undefined,()=>{}, {onBilling:value=>billing=value});
    assert.equal(response.content,'保留已生成内容');assert.equal(billing.exhausted,true);
    await assert.rejects(callModel({...model},[{role:'user',content:'child'}],'none',undefined,()=>{}),error=>error.code==='credits_exhausted');
    assert.equal(calls,1);assert.equal(checks,1);
    clearCreditScope(model.credit_scope);balance='0';
    await assert.rejects(guardBuiltinCredits(model),error=>error.code==='credits_exhausted');assert.equal(calls,1);
    const custom={...model,builtin:false};await callModel(custom,[{role:'user',content:'custom'}],'none',undefined,()=>{});assert.equal(calls,2);assert.equal(checks,2);
    balance='1';clearCreditScope(model.credit_scope);
    await assert.rejects(callModel(model,[{role:'user',content:'summary'}],'none',undefined,()=>{}, {summary:true}),error=>error.code==='credits_exhausted');assert.equal(calls,3);
  }finally{clearCreditScope(model.credit_scope);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
