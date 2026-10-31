import { readFile, writeFile, mkdir, cp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('.', import.meta.url));
const src = join(root, 'src'), out = join(root, 'dist');
if (resolve(out) !== resolve(root, 'dist')) throw new Error('Invalid frontend build directory');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
async function expand(name) {
  let text = await readFile(join(src, name), 'utf8');
  for (const match of text.matchAll(/<!-- include:([\w/.-]+) -->/g)) text = text.replace(match[0], await expand(match[1]));
  if (text.includes('<?php')) throw new Error('PHP in frontend: ' + name);
  return text;
}
const defaults = JSON.parse(await readFile(join(src, 'defaults.json'), 'utf8'));
let html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MoonYa</title><link rel="icon" href="/icon.png">';
html += '<link rel="stylesheet" href="/vendor/highlight.min.css"><script src="/vendor/highlight.min.js"></script><script src="/vendor/mammoth.browser.min.js"></script><script src="/vendor/pdf.min.js"></script>';
html += manifest.bootstrap.map(name => `<script src="/${name}"></script>`).join('\n');
html += `<script>window.MoonYaDefaults=${JSON.stringify(defaults).replaceAll('<', '\\u003c')};</script><script src="/runtime-config.js"></script><script src="/client.js"></script>`;
html += manifest.styles.map(name => `<link rel="stylesheet" href="/styles/${name}">`).join('\n');
for (const name of manifest.layouts.filter(name => name !== 'video-player.html')) html += await expand('layouts/' + name);
html += '<script>MoonYaClient.renderConfiguration();</script>';
html += manifest.before.map(name => `<script src="/${name}"></script>`).join('\n');
html += manifest.modules.map(name => `<script src="/modules/${name}"></script>`).join('\n');
html += manifest.after.map(name => `<script src="/${name}"></script>`).join('\n');
html += await expand('layouts/video-player.html');
html += '<script src="/migration-import.js"></script></body></html>';
await writeFile(join(out, 'index.html'), html);
await cp(src, out, { recursive: true });
// Shared payment/system modal skin and safe notice renderer also power admin previews.
await cp(join(root, '../MoonYa-Backend/admin/assets/system-dialog.css'), join(out, 'styles/system-dialog.css'));
await cp(join(root, '../MoonYa-Backend/admin/assets/announcement-content.js'), join(out, 'announcement-content.js'));
await cp(join(root, 'public'), out, { recursive: true });
// A deterministic manifest verifies every shipped resource, including workers/fonts.
async function inventory(dir, prefix = '') {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await inventory(join(dir, entry.name), name + '/'));
    else if (name !== 'asset-manifest.json') files[name] = createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex');
  }
  return files;
}
await writeFile(join(out, 'asset-manifest.json'), JSON.stringify(await inventory(out), null, 2));
console.log('MoonYa static frontend built. No PHP or remote assets needed at startup.');
