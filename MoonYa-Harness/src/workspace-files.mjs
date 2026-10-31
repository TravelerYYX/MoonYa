// Raw-byte snapshots complement the DeepSeek workspace-changes turn recorder.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, lstat, rename, rm, chmod, rmdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, relative, join, dirname, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore from 'ignore';
const run = promisify(execFile);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export function inside(root, target) {
  const p = relative(resolve(root), resolve(target));
  return !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep);
}
export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(value), 'utf8'); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function jsonFile(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
// Reject junctions, symlinks and traversal, including parents of absent files.
export async function safePath(root, name = '') {
  const base = resolve(root), target = resolve(base, name);
  if (!inside(base, target)) throw new Error('workspace_path_escape');
  let current = target;
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('workspace_symlink_not_supported'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}
const omitted = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache', '.pnpm-store', 'dist', 'build', 'coverage']);
export async function enumerate(root, { all = false, directories, excludedRoots = [] } = {}) {
  await safePath(root);
  if (excludedRoots.some(excluded => inside(excluded, root))) return [];
  try { if (!(await lstat(root)).isDirectory()) throw new Error('workspace_not_directory'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!all) {
    try {
      await run('git', ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 30000 });
      const { stdout } = await run('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
        { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
      return [...new Set(stdout.split('\0').filter(Boolean))].sort();
    } catch (error) {
      if (error.code !== 'ENOENT' && !/not a git repository/i.test(error.stderr || '')) throw error;
    }
  }
  const files = [];
  async function visit(dir, prefix, rules) {
    const own = ignore();
    if (!all) { try { own.add(await readFile(join(dir, '.gitignore'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const next = [...rules, { prefix, rules: own }];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, directory = entry.isDirectory();
      if (excludedRoots.some(excluded => inside(excluded, join(root, name)))) continue;
      if (!all && directory && omitted.has(entry.name)) continue;
      if (!all && next.reduce((excluded, rule) => {
        const result = rule.rules.test(name.slice(rule.prefix.length) + (directory ? '/' : ''));
        return result.ignored ? true : result.unignored ? false : excluded;
      }, false)) continue;
      if (entry.isSymbolicLink()) { if (all) throw new Error('workspace_symlink_not_supported: ' + name); continue; }
      if (directory) { directories?.push(name); await visit(join(dir, entry.name), name + '/', next); }
      else if (entry.isFile()) files.push(name);
    }
  }
  await visit(root, '', []);
  return files.sort();
}
export async function capture(path, blobs) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('workspace_not_regular_file: ' + path);
  const hash = createHash('sha256');
  let temporary;
  if (blobs) { await mkdir(blobs, { recursive: true }); temporary = join(blobs, randomUUID() + '.tmp'); }
  try {
    const meter = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } });
    if (temporary) await pipeline(createReadStream(path), meter, createWriteStream(temporary, { flags: 'wx' }));
    else { meter.resume(); await pipeline(createReadStream(path), meter); }
    const end = await lstat(path);
    if (info.size !== end.size || info.mtimeMs !== end.mtimeMs || info.ino !== end.ino) throw new Error('workspace_file_changed_during_snapshot: ' + path);
    const id = hash.digest('hex');
    if (temporary) {
      const destination = join(blobs, id);
      // A concurrent recorder may have stored the same immutable bytes.
      if (!await jsonExists(destination)) await rename(temporary, destination).catch(async error => { if (!await jsonExists(destination)) throw error; });
    }
    return { hash: id, size: info.size, mode: info.mode & 0o777 };
  } finally { if (temporary) await rm(temporary, { force: true }); }
}
async function jsonExists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function snapshot(root, blobs, options) {
  const files = {};
  const directories = options?.all ? [] : undefined;
  for (const name of await enumerate(root, { ...options, directories })) {
    if (options?.excludedRoots?.some(excluded => inside(excluded, resolve(root, name)))) continue;
    let path;
    try { path = await safePath(root, name); } catch (error) { if (error.message === 'workspace_symlink_not_supported' && !options?.all) continue; throw error; }
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info || info.isDirectory()) continue; // gitlinks are not files
    const file = await capture(path, blobs);
    if (file) files[name] = file;
  }
  return { files, ...(directories ? { directories: directories.sort() } : {}) };
}
// Only remove captured files that still match, then remove empty directories.
// Files added/edited externally during migration are left in place.
export async function removeCapturedTree(root, captured) {
  await safePath(root);
  for (const [name, file] of Object.entries(captured.files)) {
    const path = await safePath(root, name);
    try {
      if (equalFile(await capture(path), file)) {
        if (process.platform === 'win32' && !(file.mode & 0o200)) await chmod(path, file.mode | 0o200);
        await rm(path);
      }
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const directories = new Set(captured.directories || []);
  for (const name of Object.keys(captured.files)) {
    let parent = dirname(name);
    while (parent !== '.') { directories.add(parent); const next = dirname(parent); if (next === parent) break; parent = next; }
  }
  for (const name of [...directories].sort((a, b) => b.length - a.length).concat('')) {
    const dir = await safePath(root, name);
    await rmdir(dir).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
  }
  return !await jsonExists(root);
}
export const equalFile = (a, b) => (a?.hash || null) === (b?.hash || null) && (a?.mode ?? null) === (b?.mode ?? null);
export async function restore(root, name, file, blobs) {
  const path = await safePath(root, name);
  const original = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const readOnly = process.platform === 'win32' && original && !(original.mode & 0o200);
  if (!file) {
    if (readOnly) await chmod(path, original.mode | 0o200);
    try { await rm(path, { force: true }); }
    catch (error) { if (readOnly) await chmod(path, original.mode); throw error; }
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.moonya-restore';
  try {
    await pipeline(createReadStream(join(blobs, file.hash)), createWriteStream(temporary, { flags: 'wx' }));
    await chmod(temporary, file.mode);
    if ((await capture(temporary)).hash !== file.hash) throw new Error('workspace_snapshot_corrupt');
    await safePath(root, name);
    if (readOnly) await chmod(path, original.mode | 0o200);
    try { await rename(temporary, path); }
    catch (error) { if (readOnly) await chmod(path, original.mode); throw error; }
  } finally { await rm(temporary, { force: true }); }
}
