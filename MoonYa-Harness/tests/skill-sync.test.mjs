import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncSkills, validateRuntimeSkills } from '../src/skill-sync.mjs';

const skill = body => ({name:'writing-helper',display_name:'写作',description:'写作提示词',enabled:true,body,resources:{'提示词/guide.md':'RESOURCE-UNIQUE'}});
const reply = skills => new Response(JSON.stringify({success:true,data:{version:1,skills}}));
test('skills refresh each turn, cache across restart and isolate accounts and backends',async()=>{
  const cacheRoot=await mkdtemp(join(tmpdir(),'moonya-skill-cache-'));
  const packaged=async()=>[{...skill('BUILTIN'),name:'browser-use-automation'}];
  const options={user:1,backend:'https://first.example/backend/',frontend:'http://127.0.0.1:1',secret:'native',cacheRoot,packaged};
  try {
    let calls=0;
    const first=await syncSkills({...options,fetcher:async(url,init)=>{calls++;assert.match(url,/gateway\/model\/1\/skills$/);assert.equal(init.headers.Authorization,'Bearer native');return reply([skill('FIRST')]);}});
    assert.equal(first.source,'server');assert.equal(first.skills[0].body,'FIRST');
    const second=await syncSkills({...options,fetcher:async()=>{calls++;return reply([skill('SECOND')]);}});
    assert.equal(second.skills[0].body,'SECOND');assert.equal(calls,2);
    const offline=async()=>{throw new Error('network');};
    const cache=await syncSkills({...options,fetcher:offline});
    assert.equal(cache.source,'cache');assert.equal(cache.skills[0].body,'SECOND');
    assert.equal(cache.skills[0].resources['提示词/guide.md'],'RESOURCE-UNIQUE');
    assert.equal((await syncSkills({...options,user:2,fetcher:offline})).source,'packaged');
    assert.equal((await syncSkills({...options,backend:'https://other.example/',fetcher:offline})).source,'packaged');
    await assert.rejects(syncSkills({...options,fetcher:async()=>new Response('{}',{status:401})}),/重新登录/);
    await assert.rejects(syncSkills({...options,fetcher:async()=>new Response('{}',{status:403})}),/重新登录/);
    assert.equal((await syncSkills({...options,fetcher:async()=>reply([{...skill('BAD'),resources:{'../secret.md':'escape'}}])})).source,'cache');
    await syncSkills({...options,fetcher:async()=>reply([])});
    assert.deepEqual((await syncSkills({...options,fetcher:offline})).skills,[], 'server removals must replace the cache');
  } finally {await rm(cacheRoot,{recursive:true,force:true});}
});
test('concurrent refreshes coalesce and return independent snapshots',async()=>{
  const cacheRoot=await mkdtemp(join(tmpdir(),'moonya-skill-flight-'));let calls=0;
  const options={user:3,backend:'https://example.test',frontend:'http://127.0.0.1:1',secret:'native',cacheRoot,packaged:async()=>[],
    fetcher:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return reply([skill('FROZEN')]);}};
  try {
    const [a,b]=await Promise.all([syncSkills(options),syncSkills(options)]);
    assert.equal(calls,1);a.skills[0].body='MUTATED';assert.equal(b.skills[0].body,'FROZEN');
  }finally{await rm(cacheRoot,{recursive:true,force:true});}
});
test('invalid catalogs and resource paths are rejected',()=>{
  for(const value of [null,[skill('')],[skill('a'),skill('b')],[{...skill('a'),enabled:false}],
    [{...skill('a'),resources:{'/absolute.md':'x'}}],[{...skill('a'),resources:{'guide.txt':'x'}}]]) assert.throws(()=>validateRuntimeSkills(value));
});
