import { mkdir, readFile, appendFile, writeFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from './data-paths.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function normalizeUsage(raw, protocol = 'openai-completions') {
  if (!raw || typeof raw !== 'object') return null;
  if (protocol === 'openai-responses') return normalizeUsage({ prompt_tokens: raw.input_tokens,
    completion_tokens: raw.output_tokens, prompt_tokens_details: raw.input_tokens_details });
  if (protocol === 'anthropic-messages') {
    const input = count(raw.input_tokens), output = count(raw.output_tokens);
    const read = count(raw.cache_read_input_tokens ?? 0), write = count(raw.cache_creation_input_tokens ?? 0);
    return { input, cache_read: read, cache_write: write, output,
      total_input: input !== null && read !== null && write !== null ? input + read + write : null };
  }
  const reportedTotal = count(raw.prompt_tokens), output = count(raw.completion_tokens);
  const read = count(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens);
  const write = count(raw.cache_creation_input_tokens ?? 0);
  let input = count(raw.prompt_cache_miss_tokens) ?? (reportedTotal !== null && read !== null && write !== null ? count(reportedTotal - read - write) : null);
  const total = reportedTotal ?? (input !== null && read !== null && write !== null ? input + read + write : null);
  if (total !== null && input !== null && read !== null && write !== null && input + read + write !== total) input = null;
  return { input, cache_read: read, cache_write: write, output, total_input: total };
}

/** Local accounting journal. A settlement replaces its start; replay never accrues twice. */
export class ConversationStats {
  constructor(path = dataPath('agent-runtime', 'statistics', 'conversations.jsonl')) {
    this.path = path; this.rows = new Map(); this.aliases = new Map(); this.revision = 0;
    this.queue = Promise.resolve(); this.ready = this.load();
  }
  user(value) { return String(value || '').replace(/^user:/, ''); }
  key(user, id) { return JSON.stringify([this.user(user), String(id)]); }
  resolve(user, id) { const key = this.key(user, id); return this.aliases.get(key) || key; }
  apply(row) {
    this.revision++;
    if (row.kind === 'binding') {
      const primary = this.resolve(row.user, row.chat_id);
      for (const id of row.aliases) {
        const alias = this.resolve(row.user, id);
        if (alias !== primary) {
          const old = this.rows.get(alias);
          if (old) { const target = this.rows.get(primary) || new Map(); for (const [id, record] of old) target.set(id, record); this.rows.set(primary, target); this.rows.delete(alias); }
          for (const [key, value] of this.aliases) if (value === alias) this.aliases.set(key, primary);
          this.aliases.set(this.key(row.user, id), primary);
        }
      }
      return;
    }
    const key = this.resolve(row.user, row.chat_id), rows = this.rows.get(key) || new Map();
    rows.set(row.id, { ...row, revision: this.revision }); this.rows.set(key, rows);
  }
  async load() {
    let text; try { text = await readFile(this.path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const lines = text.split('\n'); let validBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) { validBytes += i < lines.length - 1 ? 1 : 0; continue; }
      try { this.apply(JSON.parse(lines[i])); }
      catch (error) {
        if (i !== lines.length - 1) throw error;
        await writeFile(this.path + '.interrupted-' + Date.now(), text, { mode: 0o600 });
        await truncate(this.path, validBytes); return;
      }
      validBytes += Buffer.byteLength(lines[i]) + (i < lines.length - 1 ? 1 : 0);
    }
    // A valid last row without a newline needs a separator before the next append.
    if (text && !text.endsWith('\n')) await appendFile(this.path, '\n');
  }
  async append(row) {
    await this.ready;
    const task = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(row) + '\n', { mode: 0o600 }); this.apply(row);
    });
    this.queue = task.catch(() => {}); return task;
  }
  async bind(user, chatId, aliases = []) {
    if (!this.user(user) || !chatId) throw new Error('statistics_scope_required');
    const filtered = [...new Set(aliases.filter(Boolean).map(String))].filter(id => id !== String(chatId));
    await this.ready;
    if (filtered.every(id => this.resolve(user, id) === this.resolve(user, chatId))) return;
    await this.append({ kind: 'binding', user: this.user(user), chat_id: String(chatId), aliases: filtered });
  }
  async record(user, chatId, input) {
    if (!this.user(user) || !chatId || !input?.id || !['model', 'tool', 'context'].includes(input.kind)) throw new Error('invalid_statistics_record');
    const row = { kind: input.kind, user: this.user(user), chat_id: String(chatId), id: String(input.id),
      status: ['running', 'completed', 'failed', 'cancelled'].includes(input.status) ? input.status : 'completed',
      model_id: String(input.model_id || ''), model_ref: input.model_ref || null, session_id: String(input.session_id || ''),
      updated_at: input.updated_at || new Date().toISOString() };
    if (row.kind === 'model') {
      row.llm_ms = duration(input.llm_ms); row.ttft_ms = duration(input.ttft_ms); row.decode_ms = duration(input.decode_ms);
      row.usage = input.usage ? Object.fromEntries(['input', 'cache_read', 'cache_write', 'output', 'total_input'].map(key => [key, count(input.usage[key])])) : null;
    } else if (row.kind === 'tool') row.tool_ms = duration(input.tool_ms);
    else {
      row.mode = input.mode === 'work' ? 'work' : 'chat';
      row.seq = count(input.seq); row.limit_tokens = count(input.limit_tokens);
      for (const key of ['used_tokens', 'system_tokens', 'tools_tokens', 'messages_tokens']) row[key] = count(input[key]);
      row.estimated = true;
    }
    await this.ready;
    const existing = this.rows.get(this.resolve(user, chatId))?.get(row.id);
    if (row.kind === 'context' && existing?.seq != null && row.seq != null && existing.seq > row.seq) return;
    if (existing?.status !== 'running' && row.status === 'running') { if (existing) return; }
    if (existing && JSON.stringify({ ...existing, updated_at: '', revision: 0 }) === JSON.stringify({ ...row, updated_at: '', revision: 0 })) return;
    await this.append(row);
  }
  async open(user, chatId, hasHistory = false) {
    await this.ready;
    if (this.rows.get(this.resolve(user, chatId))?.has('coverage')) return;
    await this.append({ kind: 'coverage', user: this.user(user), chat_id: String(chatId), id: 'coverage', legacy: Boolean(hasHistory) });
  }
  async snapshot(user, chatId, { has_history = false, model_id, model_ref, session_id, limit_tokens, mode, conversation_id } = {}) {
    await this.ready; await this.queue;
    const records = this.rows.get(this.resolve(user, chatId)) || (conversation_id ? this.rows.get(this.resolve(user, 'db:' + conversation_id)) : null);
    const rows = [...(records?.values() || [])];
    const models = rows.filter(row => row.kind === 'model'), tools = rows.filter(row => row.kind === 'tool');
    const coverage = rows.find(row => row.kind === 'coverage');
    has_history = coverage ? coverage.legacy || has_history && models.length === 0 : has_history;
    const settled = models.filter(row => row.status !== 'running');
    const empty = !has_history && models.length === 0;
    const sumField = (key, list = settled) => {
      const known = list.map(row => row.usage?.[key]).filter(value => value !== null && value !== undefined);
      return known.length ? known.reduce((a, b) => a + b, 0) : empty ? 0 : null;
    };
    const sumMs = (list, key) => { const known = list.map(row => row[key]).filter(value => value !== null && value !== undefined); return known.length ? known.reduce((a, b) => a + b, 0) : empty && list.length === 0 ? 0 : null; };
    const tokenRows = settled.filter(row => row.usage?.total_input != null && row.usage?.output != null);
    const total = tokenRows.length ? tokenRows.reduce((sum, row) => sum + row.usage.total_input + row.usage.output, 0) : empty ? 0 : null;
    const cacheRows = settled.filter(row => row.usage?.total_input != null && row.usage?.cache_read != null);
    const cacheInput = cacheRows.reduce((sum, row) => sum + row.usage.total_input, 0);
    const ttftRows = settled.filter(row => row.ttft_ms != null);
    const decodeRows = settled.filter(row => row.decode_ms > 0 && row.usage?.output != null);
    const decodeMs = decodeRows.reduce((sum, row) => sum + row.decode_ms, 0);
    const tokenComplete = models.every(row => row.status !== 'running' && row.usage && ['input','cache_read','cache_write','output','total_input'].every(key => row.usage[key] != null));
    const contexts = rows.filter(row => row.kind === 'context' && (!model_id || row.model_id === model_id)
      && (!mode || row.mode === mode)
      && (!model_ref || row.model_ref?.provider_id === model_ref.provider_id && row.model_ref?.model_id === model_ref.model_id)
      && (!session_id || row.session_id === session_id) && (!limit_tokens || row.limit_tokens === Number(limit_tokens)));
    const context = contexts.sort((a, b) => a.revision - b.revision).at(-1) || null;
    return { client_chat_id: String(chatId), revision: this.revision,
      token_usage: { total, input: sumField('input'), cache_read: sumField('cache_read'), cache_write: sumField('cache_write'), output: sumField('output'),
        cache_hit_percent: cacheInput > 0 ? cacheRows.reduce((sum, row) => sum + row.usage.cache_read, 0) / cacheInput * 100 : null },
      timing: { llm_ms: sumMs(settled, 'llm_ms'), tool_ms: tools.length ? sumMs(tools, 'tool_ms') : empty || models.length && !has_history ? 0 : null,
        ttft_ms: ttftRows.length ? sumMs(ttftRows, 'ttft_ms') / ttftRows.length : null,
        tps: decodeMs > 0 ? decodeRows.reduce((sum, row) => sum + row.usage.output, 0) * 1000 / decodeMs : null },
      context, completeness: { token_usage: empty || tokenComplete && !has_history ? 'complete' : total !== null ? 'partial' : 'unavailable',
        timing: !has_history && settled.length === models.length && settled.every(row => row.llm_ms != null) && tools.every(row => row.status !== 'running' && row.tool_ms != null) ? 'complete' : settled.length || tools.length ? 'partial' : 'unavailable',
        attempts: models.length, recorded_attempts: settled.length, running: [...models, ...tools].some(row => row.status === 'running') } };
  }
}
