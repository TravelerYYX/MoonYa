import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { cp, mkdir, readFile, readdir, realpath, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const foundation = join(runtime, 'foundation');
// Normal builds use the pinned import, independent of any local upstream checkout.
const sourceRoot = process.env.MOONYA_SUBAGENT_SOURCE ? resolve(process.env.MOONYA_SUBAGENT_SOURCE) : null;
const baseline = await readFile(join(runtime, 'src', 'subagent-source.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const require = createRequire(join(await realpath(join(foundation, 'node_modules', 'tsx')), 'package.json'));
const { build } = require('esbuild');
const packages = ['subagent', 'subagent-spawn-in-process', 'subagent-in-process-driver', 'tool-subagent', 'tool-subagent-control'];
async function copyPackage(source, destination) {
  await cp(source, destination, { recursive: true, filter: async (from, to) => {
    if (!(await stat(from)).isFile()) return true;
    const existing = await readFile(to).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return !existing || !existing.equals(await readFile(from));
  } });
}
const files = [];
for (const pkg of packages) {
  const folder = join(foundation, 'packages', 'subagent', pkg, 'src');
  for (const file of await readdir(folder, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const copied = await readFile(join(folder, file), 'utf8');
    const sourcePath = `${pkg}/src/${file.replaceAll('\\', '/')}`;
    let original = sourceRoot ? await readFile(join(sourceRoot, 'packages', 'subagent', pkg, 'src', file), 'utf8') : null;
    if (original === null) {
      original = copied.replaceAll('@moonya/harness-', '@deepseek-ai/dsh-').replaceAll('@moonya/harness', '@deepseek-ai/dsh');
      const expected = baseline?.files.find(item => item.path === sourcePath)?.sha256;
      if (!expected || createHash('sha256').update(original).digest('hex') !== expected) throw new Error(`Imported source hash differs: ${sourcePath}`);
    }
    const renamed = original.replaceAll('@deepseek-ai/dsh-', '@moonya/harness-').replaceAll('@deepseek-ai/dsh', '@moonya/harness');
    if (copied !== renamed) throw new Error(`Upstream source differs: ${pkg}/${file}`);
    files.push({ path: sourcePath, sha256: createHash('sha256').update(original).digest('hex') });
  }
}
const bundled = await build({ absWorkingDir: runtime, entryPoints: [join(runtime, 'scripts', 'foundation-host.mjs')], outfile: join(runtime, 'src', 'foundation-subagent.bundle.mjs'), metafile: true,
  bundle: true, format: 'esm', platform: 'node', target: 'node24', tsconfig: join(foundation, 'tsconfig.base.json'),
  nodePaths: [join(foundation, 'node_modules')],
  plugins: [{ name: 'packaged-native-persistence', setup(plugin) {
    plugin.onResolve({ filter: /^koffi$/ }, args => args.namespace === 'moonya-native' ? { path: 'koffi', external: true } : { path: 'koffi', namespace: 'moonya-native' });
    plugin.onLoad({ filter: /.*/, namespace: 'moonya-native' }, () => ({ contents: 'const native = require("koffi"); export default native;', loader: 'js' }));
  } }],
  banner: { js: '// Derived from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT. See THIRD_PARTY_NOTICES.md.\nimport { createRequire as __moonyaRequire } from "node:module"; const require = __moonyaRequire(import.meta.url);' } });
await build({ absWorkingDir: runtime, entryPoints: [join(foundation, 'packages', 'session', 'session-persistence-jsonl', 'src', 'worker.ts')], outfile: join(runtime, 'src', 'worker.cjs'),
  bundle: true, format: 'cjs', platform: 'node', target: 'node24', define: { 'import.meta.url': '__filename' }, tsconfig: join(foundation, 'tsconfig.base.json'), nodePaths: [join(foundation, 'node_modules')] });
await mkdir(join(runtime, 'node_modules'), { recursive: true });
const koffiSource = await realpath(join(foundation, 'packages', 'session', 'session-persistence-jsonl', 'node_modules', 'koffi'));
await copyPackage(koffiSource, join(runtime, 'node_modules', 'koffi'));
const koffiRequire = createRequire(join(koffiSource, 'package.json'));
const koffiPackage = JSON.parse(await readFile(join(koffiSource, 'package.json'), 'utf8'));
for (const dependency of Object.keys(koffiPackage.optionalDependencies || {})) {
  let installed;
  try { installed = dirname(koffiRequire.resolve(`${dependency}/package.json`)); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
  const destination = join(runtime, 'node_modules', dependency);
  if (await realpath(destination).catch(() => '') !== await realpath(installed)) await copyPackage(installed, destination);
}
// Windows packages support both advertised release architectures, even when built on x64.
if (process.platform === 'win32') {
  const dependency = '@koromix/koffi-win32-arm64', destination = join(runtime, 'node_modules', dependency);
  const installed = await readFile(join(destination, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (installed?.version !== '3.1.1') {
    const response = await fetch('https://registry.npmjs.org/@koromix/koffi-win32-arm64/-/koffi-win32-arm64-3.1.1.tgz');
    if (!response.ok) throw new Error(`Cannot fetch ARM64 persistence dependency: ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const integrity = createHash('sha512').update(archive).digest('base64');
    if (integrity !== 'JhqHauEwQvdcWUERxrV5HH/DT9W7hY1A1eU6/o8tB+yck+D3kt5elpRDBt9KjpW6h+vHPy3V0sjDvO0CXyabTA==') throw new Error('ARM64 dependency integrity mismatch');
    const temporary = await mkdtemp(join(tmpdir(), 'moonya-koffi-'));
    try {
      await writeFile(join(temporary, 'native.tgz'), archive);
      await promisify(execFile)('tar', ['-xzf', join(temporary, 'native.tgz'), '-C', temporary], { windowsHide: true });
      await cp(join(temporary, 'package'), destination, { recursive: true });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
await writeFile(join(runtime, 'src', 'subagent-source.json'), JSON.stringify({ source: 'deepseek-harness-master', license: 'MIT', files }, null, 2) + '\n');
const licenses = new Map();
let upstreamLicense = join(sourceRoot || foundation, 'LICENSE');
let upstreamBody = await readFile(upstreamLicense, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (upstreamBody === null) { upstreamLicense = join(foundation, 'LICENSE'); upstreamBody = await readFile(upstreamLicense, 'utf8'); }
licenses.set(upstreamLicense, upstreamBody);
const inspected = new Map();
async function findLicense(directory) {
  if (inspected.has(directory)) return inspected.get(directory);
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'license']) {
    const file = join(directory, name), body = await readFile(file, 'utf8').catch(error => { if (['ENOENT', 'EISDIR'].includes(error.code)) return null; throw error; });
    if (body) { licenses.set(file, body); inspected.set(directory, file); return file; }
  }
  const parent = dirname(directory), found = parent !== directory ? await findLicense(parent) : null;
  inspected.set(directory, found); return found;
}
for (const input of Object.keys(bundled.metafile.inputs)) if (!input.startsWith('moonya-native:')) await findLicense(dirname(resolve(runtime, input)));
await writeFile(join(runtime, 'src', 'subagent-LICENSE.txt'), [...licenses].map(([file, body]) => `${relative(runtime, file).replaceAll('\\', '/')}\n\n${body}`).join('\n\n'));
process.stdout.write(`Bundled DeepSeek subagents (${files.length} verified source files).\n`);
