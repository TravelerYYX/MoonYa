import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { dataPath } from './data-paths.mjs';
import { PROVIDER_PRESETS, MODEL_PROTOCOLS, normalizeModel, requireModelContext } from './model-catalog.mjs';

const PROTOCOLS = MODEL_PROTOCOLS;
export function redactError(error, key = '') {
  let message = String(error?.message || error);
  if (key) message = message.split(key).join('[密钥已隐藏]');
  return message.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, '[密钥已隐藏]').slice(0, 600);
}
export function endpoint(base, suffix) {
  return base.replace(/\/(chat\/completions|responses|messages|models)\/?$/, '').replace(/\/$/, '') + suffix;
}
export function validateProvider(input, saved = {}) {
  const id = String(input.id || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || ['__proto__', 'constructor', 'prototype', 'builtin'].includes(id)) throw new Error('Provider ID 必须以小写字母开头，只能包含小写字母、数字、下划线和短横线');
  const provider = String(input.provider || 'custom');
  if (provider !== 'custom' && !Object.hasOwn(PROVIDER_PRESETS, provider)) throw new Error('供应商无效');
  const preset = PROVIDER_PRESETS[provider];
  const protocol = String(input.protocol || preset?.protocol || 'openai-completions');
  if (!PROTOCOLS.includes(protocol)) throw new Error('API 协议无效');
  const base_url = String(input.base_url || preset?.base_url || '').trim().replace(/\/$/, '');
  let url; try { url = new URL(base_url); } catch { throw new Error('请填写有效的 HTTP 或 HTTPS API 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须是 HTTP/HTTPS 地址，不能包含凭据、查询参数或片段');
  const api_key = Object.hasOwn(input, 'api_key') ? String(input.api_key).trim() : String(saved.api_key || '');
  const models = (input.models || []).map(row => normalizeModel(row, provider, protocol, { stored: true }));
  if (new Set(models.map(row => row.id)).size !== models.length) throw new Error('同一供应商内模型 ID 不能重复');
  return { ...saved, id, provider, name: String(input.name || preset?.name || id).trim(), base_url, protocol, api_key, models };
}
export class ModelConfigStore {
  constructor(path = dataPath('config.toml')) { this.path = path; this.writes = Promise.resolve(); }
  async read() {
    try {
      const doc = parse(await readFile(this.path, 'utf8'), { unsafeKeyBehaviour: 'throw' });
      if (doc.config_version !== undefined && doc.config_version !== 1) throw new Error('不支持的配置版本');
      if (doc.providers && (Array.isArray(doc.providers) || typeof doc.providers !== 'object')) throw new Error('providers 必须是 TOML 表');
      for (const [id, provider] of Object.entries(doc.providers || {})) validateProvider({ ...provider, id });
      return doc;
    } catch (error) {
      if (error.code === 'ENOENT') return { config_version: 1, providers: {} };
      throw new Error('config.toml 读取失败，原文件已保留。请检查配置语法和字段。');
    }
  }
  async list() {
    const doc = await this.read();
    return { providers: Object.entries(doc.providers || {}).map(([id, value]) => {
      const { api_key, ...row } = validateProvider({ ...value, id }); return { ...row, has_key: !!api_key };
    }), presets: Object.entries(PROVIDER_PRESETS).map(([id, row]) => ({ id, ...row })), config_path: this.path };
  }
  async mutate(change) {
    const pending = this.writes.then(async () => {
      const doc = await this.read();
      doc.providers ||= {}; doc.config_version = 1; await change(doc);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      // TOML has no null; unknown windows remain absent on disk, null in the API.
      for (const provider of Object.values(doc.providers)) {
        for (const model of provider.models || []) {
          if (model.context_window === null) delete model.context_window;
          if (model.overrides?.context_window === null) delete model.overrides.context_window;
          if (model.defaults?.context_window === null) delete model.defaults.context_window;
        }
      }
      try { await writeFile(temp, stringify(doc), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.path); }
      catch (error) { throw new Error('config.toml 写入失败，原文件已保留。请检查文件权限、占用情况和磁盘空间。', { cause: error }); }
      finally { await rm(temp, { force: true }).catch(() => {}); }
      return this.list();
    });
    this.writes = pending.catch(() => {}); return pending;
  }
  async save(input) {
    return this.mutate(doc => {
      const row = validateProvider(input, doc.providers[input.id]);
      if (!row.models.some(model => model.supports_chat)) throw new Error('至少需要添加一个可用的对话模型');
      if (row.provider !== 'custom' && !row.api_key) throw new Error('请填写 API Key');
      doc.providers[row.id] = row;
    });
  }
  async remove(id) { return this.mutate(doc => { if (!Object.hasOwn(doc.providers, id)) throw new Error('供应商不存在'); delete doc.providers[id]; }); }
  async draft(input) { const doc = await this.read(); return validateProvider(input, doc.providers?.[input.id]); }
  async resolve(ref) {
    if (!ref || !ref.provider_id || !ref.model_id) throw new Error('请选择供应商和模型');
    const doc = await this.read();
    const row = doc.providers?.[ref.provider_id];
    if (!row) throw new Error('所选供应商已删除，请重新选择模型');
    const provider = validateProvider({ ...row, id: ref.provider_id });
    const meta = provider.models.find(model => model.id === ref.model_id);
    if (!meta || !meta.supports_chat) throw new Error('所选模型不可用于当前对话');
    requireModelContext(meta);
    return { ...meta, name: meta.id, provider_id: provider.id, provider: provider.provider,
      protocol: meta.custom_protocol ? meta.protocol : provider.protocol, base_url: provider.base_url, api_key: provider.api_key };
  }
  async discover(input) {
    const draft = await this.draft(input);
    try {
      const headers = { 'content-type': 'application/json' };
      if (draft.api_key) {
        if (draft.protocol === 'anthropic-messages') { headers['x-api-key'] = draft.api_key; }
        else headers.authorization = `Bearer ${draft.api_key}`;
      }
      if (draft.protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
      let next = endpoint(draft.base_url, '/models'), candidates = [], seen = new Set(), cursors = new Set();
      for (let page = 0; next && page < 100; page++) {
        const response = await fetch(next, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）：${(await response.text()).slice(0, 300)}`);
        const data = await response.json();
        if (!Array.isArray(data.data)) throw new Error('模型目录返回格式无效');
        for (const row of data.data) if (!seen.has(row.id)) { candidates.push(normalizeModel(row, draft.provider, draft.protocol)); seen.add(row.id); }
        if (data.has_more && data.last_id) { if (cursors.has(data.last_id)) throw new Error('模型目录分页游标重复'); cursors.add(data.last_id); const url = new URL(endpoint(draft.base_url, '/models')); url.searchParams.set('after_id', data.last_id); next = url.href; }
        else next = null;
      }
      return { models: candidates, source: 'api', error: '' };
    } catch (error) {
      const preset = PROVIDER_PRESETS[draft.provider];
      return { models: preset ? structuredClone(preset.models) : [], source: preset ? 'preset' : 'error',
        source_url: preset?.source_url || '', error: redactError(error, draft.api_key) };
    }
  }
}
