import { createHash } from 'node:crypto';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from './data-paths.mjs';

/** Protocol replay data belongs to the local runtime, alongside Work sessions. */
export class ChatHistory {
  constructor(path = dataPath('chat', 'protocol-history.jsonl')) { this.path = path; this.rows = new Map(); this.ready = this.load(); this.queue = Promise.resolve(); }
  key(scope, model, content, messageId = '') {
    const identity=[scope, model.provider_id, model.name, content];
    if(messageId)identity.push(String(messageId));
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
  async load() {
    let text; try { text = await readFile(this.path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of text.split('\n').filter(Boolean)) {
      // An interrupted final append does not invalidate earlier completed messages.
      try { const row = JSON.parse(line); this.rows.set(row.key, row.content); } catch (_) {}
    }
  }
  async replay(scope, model, messages) {
    await this.ready;
    return messages.map(message => {
      const raw = message.role === 'assistant' && (this.rows.get(this.key(scope, model, message.content, message._moonya_message_id))
        || this.rows.get(this.key(scope, model, message.content)));
      return raw ? { ...message, provider_content: raw } : message;
    });
  }
  async remember(scope, model, message, messageId = '') {
    if (!message.provider_content) return;
    await this.ready;
    const keys=new Set([this.key(scope, model, message.content),this.key(scope, model, message.content,messageId)]);
    const rows=[...keys].map(key=>({key,content:message.provider_content}));
    const task = this.queue.then(async () => { await mkdir(dirname(this.path), {recursive:true}); await appendFile(this.path, rows.map(row=>JSON.stringify(row)+'\n').join(''), { mode:0o600 }); for(const row of rows)this.rows.set(row.key, row.content); });
    this.queue = task.catch(() => {}); return task;
  }
}
