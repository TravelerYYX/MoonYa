import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const { transformESMtoCJS } = require('../foundation/node_modules/@yao-pkg/pkg/lib-es5/esm-transformer.js');

async function packagedModule(name) {
  const filename = fileURLToPath(new URL(`../src/${name}`, import.meta.url));
  const transformed = transformESMtoCJS(await readFile(filename, 'utf8'), filename);
  assert.equal(transformed.isTransformed, true);
  const module = { exports: {} };
  // Match pkg's bytecode loader: a CommonJS wrapper without an import callback.
  const wrapper = new Script(`(function(exports, require, module, __filename, __dirname) {\n${transformed.code}\n})`, { filename }).runInThisContext();
  wrapper(module.exports, createRequire(filename), module, filename, dirname(filename));
  return module.exports;
}

test('packaged atomicWrite creates and replaces JSON without a VM import callback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-packaged-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { atomicWrite } = await packagedModule('workspace-files.mjs');
  const target = join(directory, 'nested', 'record.json');
  await atomicWrite(target, { revision: 1, content: '工作区快照' });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { revision: 1, content: '工作区快照' });
  await atomicWrite(target, { revision: 2 });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { revision: 2 });
  assert.deepEqual(await readdir(dirname(target)), ['record.json']);
});

test('packaged browser saves screenshot bytes without a VM import callback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moonya-packaged-screenshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WAAAAABJRU5ErkJggg==', 'base64');
  const screenshot = bytes.toString('base64');
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* Drain the fixture request. */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, screenshot }));
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previous = Object.fromEntries(['MOONYA_BROWSER_SERVICE_URL', 'MOONYA_BROWSER_TIMEOUT_MS'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.MOONYA_BROWSER_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MOONYA_BROWSER_TIMEOUT_MS = '5000';
  const { executeBrowser } = await packagedModule('browser.mjs');
  const target = join(directory, 'nested', 'shot.png');
  const result = await executeBrowser({ action: 'screenshot', save_screenshot_to: target });
  assert.equal(result.success, true);
  assert.equal(result.screenshot_saved_to, target);
  assert.equal(result.screenshot_save_error, undefined);
  assert.equal(result.screenshot, screenshot);
  assert.deepEqual(await readFile(target), bytes);
});
