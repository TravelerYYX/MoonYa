import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, appendFile, writeFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from './data-paths.mjs';

export class ChatRuns {
  constructor(root = dataPath('chat', 'runs')) { this.root = root; this.runs = new Map(); this.loading = new Map(); }
  id(input) { return createHash('sha256').update(JSON.stringify([String(input.user_context || ''),String(input.conversation_id || ''),String(input.client_message_id || '')])).digest('hex'); }
  async get(input) {
    const id = input.client_message_id ? this.id(input) : randomUUID();
    if (this.runs.has(id)) return this.runs.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const pending = (async () => {
      const run = { id, events:[], subscribers:new Set(), queue:Promise.resolve(), controller:new AbortController(), started:false, done:false };
      await mkdir(this.root,{recursive:true});
      try {
        const text = await readFile(join(this.root,id+'.jsonl'),'utf8');
        const lines=text.split('\n');
        let validBytes=0;
        for (let i=0;i<lines.length;i++) {
          if (!lines[i]) { validBytes+=i<lines.length-1?1:0; continue; }
          try { run.events.push(JSON.parse(lines[i])); }
          catch(error) {
            if(i!==lines.length-1) throw error;
            // An interrupted append may leave a partial final event. Preserve it
            // before repairing the journal so subsequent appends remain readable.
            await writeFile(join(this.root,id+'.interrupted-'+Date.now()+'.jsonl'),text,{mode:0o600});
            await truncate(join(this.root,id+'.jsonl'),validBytes);
            break;
          }
          validBytes+=Buffer.byteLength(lines[i])+(i<lines.length-1?1:0);
        }
        if(text && !text.endsWith('\n') && validBytes===Buffer.byteLength(text))
          await appendFile(join(this.root,id+'.jsonl'),'\n');
        run.started = run.events.length > 0; run.done = !!run.events.at(-1)?.moonya_done;
        if (run.started && !run.done) {
          await this.publish(run,{ error:{message:'本机运行时已重启，本轮生成已中断，请重新发送。'} });
          await this.publish(run,{moonya_done:true,moonya_status:'failed'});
        }
      } catch(error) { if(error.code !== 'ENOENT') throw error; }
      this.runs.set(id,run); return run;
    })();
    this.loading.set(id,pending);
    try { return await pending; } finally { this.loading.delete(id); }
  }
  async publish(run, data) {
    const task = run.queue.then(async () => {
      const event = { ...data, moonya_seq:run.events.length+1 };
      await appendFile(join(this.root,run.id+'.jsonl'), JSON.stringify(event)+'\n',{mode:0o600});
      run.events.push(event); if(event.moonya_done)run.done=true;
      for(const subscriber of run.subscribers)subscriber(event);
    });
    run.queue=task.catch(()=>{});return task;
  }
  async start(run, initialize) {
    if (run.started) return;
    if (run.starting) return run.starting;
    run.starting = initialize();
    try { await run.starting; } finally { run.starting = null; }
  }
  stream(run,res,after=0) {
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
    res.flushHeaders();
    let cursor=Math.max(0,Number(after)||0);
    const write=event=>{
      if(event.moonya_seq<=cursor || res.writableEnded || res.destroyed)return;
      cursor=event.moonya_seq;res.write('data: '+JSON.stringify(event)+'\n\n');
      if(event.moonya_done)res.end('data: [DONE]\n\n');
    };
    run.subscribers.add(write);
    for(const event of run.events)write(event);
    if(run.done && !res.writableEnded)res.end('data: [DONE]\n\n');
    const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},15000);
    res.on('close',()=>{run.subscribers.delete(write);clearInterval(heartbeat);});
  }
  async cancel(input) {
    const run=this.runs.get(this.id(input));
    if(run && !run.done) { run.controller.abort(new Error('用户停止生成')); await run.promise?.catch(()=>{}); }
    return {success:true};
  }
}
