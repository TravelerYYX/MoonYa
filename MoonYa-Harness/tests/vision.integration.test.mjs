import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
const root = new URL('..', import.meta.url);

test('parallel desktop and browser observations reach the model, survive save and runtime restart', { timeout: 20000 }, async () => {
  let round = 0;
  const requests = [];
  const model = await serve(async body => {
    requests.push(body);
    const message = round++ === 0
      ? { role: 'assistant', content: '', tool_calls: [
        { id: 'desktop', type: 'function', function: { name: 'computer_observe', arguments: '{"goal":"describe window"}' } },
        { id: 'browser', type: 'function', function: { name: 'browser_automation_control', arguments: '{"action":"inspect","save_screenshot_to":"saved.png"}' } },
      ] }
      : { role: 'assistant', content: 'Observed both actual images.' };
    return { choices: [{ message }] };
  });
  const desktop = await serve(async () => {
    await new Promise(resolve => setTimeout(resolve, 60)); // deliberately completes after the browser
    return { success: true, image: png, snapshot_version: 'desktop-v1', window: { title: 'window' }, accessibility: { nodes: [] } };
  });
  const browser = await serve(async () => ({ success: true, screenshot: png, action: 'inspect', page_version: 7, page_url: 'https://example.invalid/' }));
  const directory = await mkdtemp(join(tmpdir(), 'moonya-vision-'));
  const socket = await serve(async () => ({}));
  const port = socket.address().port;
  await stop(socket);
  let child;
  const start = async () => {
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: root,
      env: { ...process.env, MOONYA_HARNESS_PORT: String(port), MOONYA_HARNESS_DATA: directory,
        MOONYA_LOCAL_SERVICE_URL: `http://127.0.0.1:${desktop.address().port}`,
        MOONYA_BROWSER_SERVICE_URL: `http://127.0.0.1:${browser.address().port}`, MOONYA_BROWSER_TIMEOUT_MS: '5000' },
      stdio: 'ignore',
    });
    await poll(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok);
  };
  const api = async (route, body) => (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })).json();
  try {
    await start();
    const session = await api('/v1/sessions', { workspace: directory });
    const input = { content: 'Describe the current screen and browser', image_detail: 'low',
      model: { base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'stub', name: 'deepseek-flash' } };
    await api(`/v1/sessions/${session.id}/messages`, input);
    await poll(async () => (await api(`/v1/sessions/${session.id}`)).status === 'completed');
    const actual = requests[1].messages;
    assert.deepEqual(actual.slice(-3).map(message => message.role), ['tool', 'tool', 'user']);
    assert.deepEqual(actual.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['desktop', 'browser']);
    const imageMessage = actual.at(-1);
    const images = imageMessage.content.filter(part => part.type === 'image_url');
    assert.equal(images.length, 2);
    assert.ok(images.every(part => part.image_url.url === `data:image/png;base64,${png}` && part.image_url.detail === 'low'));
    assert.ok(actual.filter(message => message.role === 'tool').every(message => !message.content.includes(png)));
    assert.ok(imageMessage.content[0].text.includes('desktop-v1'));
    assert.ok(imageMessage.content[2].text.includes('https://example.invalid/'));
    assert.equal(imageMessage._origin, undefined, 'internal provenance must not leak into the provider schema');
    assert.deepEqual(await readFile(join(directory, 'saved.png')), Buffer.from(png, 'base64'));
    const events = (await api(`/v1/sessions/${session.id}`)).events;
    assert.equal(events.filter(event => event.event === 'tool.images').length, 1);
    assert.ok(events.findIndex(event => event.event === 'tool.images') > events.findLastIndex(event => event.event === 'tool.completed'));
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    await start();
    await api(`/v1/sessions/${session.id}/messages`, { ...input, content: 'Continue with the same visual evidence', image_detail: 'high' });
    await poll(async () => (await api(`/v1/sessions/${session.id}`)).status === 'completed');
    const replayImages = requests[2].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url');
    assert.deepEqual(replayImages, images, 'restarting must preserve the exact bytes and original detail');
    const rejected = await api(`/v1/sessions/${session.id}/messages`, { ...input, image_detail: 'invalid' });
    assert.equal(rejected.error, 'image_detail_must_be_low_or_high');
  } finally {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    await Promise.all([stop(model), stop(desktop), stop(browser)]);
    await rm(directory, { recursive: true, force: true });
  }
});

async function serve(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(await handler(body)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function poll(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* runtime is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Vision runtime integration timed out');
}
