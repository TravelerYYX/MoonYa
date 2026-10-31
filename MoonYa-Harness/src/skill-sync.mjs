import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath } from './data-paths.mjs';

const pending = new Map();
export function validateRuntimeSkills(value) {
  if (!Array.isArray(value)) throw new Error('技能目录格式无效');
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item.name !== 'string' || !/^[a-z0-9-]{1,63}$/.test(item.name) || seen.has(item.name)
      || typeof item.description !== 'string' || !item.description.trim()
      || typeof item.body !== 'string' || !item.body.trim() || item.enabled === false) throw new Error('技能正文格式无效');
    seen.add(item.name);
    const resources = {};
    if (item.resources !== undefined && (!item.resources || typeof item.resources !== 'object' || Array.isArray(item.resources))) throw new Error('技能资源格式无效');
    for (const [path, content] of Object.entries(item.resources || {})) {
      if (!path || path.startsWith('/') || /[:\x00-\x1f\\]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')
        || !/\.md$/i.test(path) || typeof content !== 'string' || !content.trim()) throw new Error('技能资源路径或正文无效');
      resources[path] = content;
    }
    return { name:item.name, display_name:String(item.display_name || item.name), description:item.description, enabled:true, body:item.body, resources };
  });
}

// Share in-flight refreshes only. Each new turn revalidates against the server.
export async function syncSkills({ user, backend = process.env.MOONYA_BACKEND_URL, frontend = process.env.MOONYA_FRONTEND_URL,
  secret = process.env.MOONYA_FRONTEND_SECRET, cacheRoot = dataPath('agent-runtime', 'skill-cache'), fetcher = fetch, packaged }) {
  if (!backend || !frontend || !secret) throw new Error('技能同步配置缺失');
  const namespace = new URL(backend).href.replace(/\/+$/, '') + '|user:' + user;
  const key = createHash('sha256').update(namespace).digest('hex');
  const flightKey = cacheRoot + '|' + key;
  if (pending.has(flightKey)) return structuredClone(await pending.get(flightKey));
  const promise = (async () => {
    const file = join(cacheRoot, key + '.json');
    let result;
    try {
      const response = await fetcher(frontend.replace(/\/$/, '') + '/gateway/model/' + user + '/skills', {
        headers:{ Authorization:'Bearer ' + secret }, signal:AbortSignal.timeout(10000)
      });
      if (response.status === 401 || response.status === 403) {
        const error = new Error('登录已失效，请重新登录后使用技能'); error.code = 'AUTH_REQUIRED'; error.status = 401; throw error;
      }
      if (!response.ok) throw new Error('技能服务暂不可用');
      const payload = await response.json();
      if (!payload.success || payload.data?.version !== 1) throw new Error('技能服务返回无效目录');
      result = { version:1, namespace, skills:validateRuntimeSkills(payload.data.skills), synced_at:new Date().toISOString() };
    } catch (error) {
      if (error.code === 'AUTH_REQUIRED') throw error;
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        if (saved.version !== 1 || saved.namespace !== namespace || typeof saved.synced_at !== 'string') throw new Error('缓存无效');
        return {skills:validateRuntimeSkills(saved.skills), source:'cache', synced_at:saved.synced_at};
      } catch {
        return {skills:validateRuntimeSkills(await packaged()), source:'packaged', synced_at:null};
      }
    }
    // A cache write failure must not discard a successfully fetched current directory.
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await mkdir(cacheRoot,{recursive:true}); await writeFile(temporary,JSON.stringify(result),'utf8'); await rename(temporary,file); }
    catch { await unlink(temporary).catch(()=>{}); }
    return {skills:result.skills, source:'server', synced_at:result.synced_at};
  })();
  pending.set(flightKey,promise);
  try { return structuredClone(await promise); } finally { if(pending.get(flightKey)===promise)pending.delete(flightKey); }
}
