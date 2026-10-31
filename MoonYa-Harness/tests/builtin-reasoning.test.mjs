import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuiltinReasoning } from '../src/builtin-reasoning.mjs';
import { openaiPayload } from '../src/model-client.mjs';

test('catalog reasoning preserves exact parameters through Work admission and supplier payloads', () => {
  const model = {supports_thinking:true,reasoning:'openai',efforts:['medium','xhigh','ultra'],default_effort:'medium',name:'fixture'};
  for (const effort of model.efforts) {
    const resolved = resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningProfile:effort,reasoningEffort:effort}, model, true);
    assert.equal(openaiPayload(model, [], resolved.effort).reasoning_effort, effort);
  }
  assert.throws(() => resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'high'},model,true), /不支持/);
  assert.throws(() => resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'none'},model,true), /不允许/);
  assert.throws(() => resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningProfile:'high',reasoningEffort:'medium'},model,true), /不匹配/);
  assert.equal(resolveBuiltinReasoning({reasoningProfileVersion:2},model,true).effort,'medium');
  assert.equal(resolveBuiltinReasoning({reasoningProfile:'medium'}, {...model,efforts:['low','high','max']},true).effort,'low');
  assert.equal(resolveBuiltinReasoning({reasoningProfile:'ultra'}, {...model,efforts:['low','high','max']},true).effort,'max');
});

test('binary, always-on and nonreasoning models omit adjustable strength', () => {
  for (const reasoning of ['deepseek','openai','always']) {
    const model={name:'fixture',supports_thinking:true,reasoning,efforts:[],default_effort:'auto'};
    const resolved=resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'auto'},model,true);
    assert.equal(openaiPayload(model,[],resolved.effort).reasoning_effort,undefined);
    if (reasoning==='always') assert.throws(()=>resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'none'},model),/不允许/);
    else assert.equal(resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'none'},model).effort,'none');
  }
  const model={name:'fixture',supports_thinking:false,efforts:[]};
  const resolved=resolveBuiltinReasoning({reasoningProfileVersion:2,reasoningEffort:'none'},model,true);
  assert.equal(openaiPayload(model,[],resolved.effort).reasoning_effort,undefined);
});
