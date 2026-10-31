import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=', 'base64');
const references = await Promise.all(['ONE', 'TWO'].map(async key => process.env['MOONYA_ATTACHMENT_REFERENCE_' + key]
    ? readFile(process.env['MOONYA_ATTACHMENT_REFERENCE_' + key]) : png));
const artifacts = join(root, 'MoonYa-Frontend/artifacts/attachments');
const attachmentConfig = JSON.parse(await readFile(join(root, 'MoonYa-Frontend/src/defaults.json'), 'utf8')).attachments;

async function fixture({ fail = false, granted = [], persistent = false } = {}) {
    const sends = [], errors = [], uploads = [], deleted = [], cloudMessages = [];
    function answer(res) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [{ type: 'runtime_event', source: 'harness', event: 'desktop.message.accepted', session_id: 'fixture-attachment-session' },
            { type: 'content', content: '附件已收到' }, { type: 'done', harness_session_id: 'fixture-attachment-session' }]) res.write('data: ' + JSON.stringify(event) + '\n\n');
        res.end();
    }
    const backend = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (req.url.startsWith('/api.php') && req.method === 'POST') { sends.push(JSON.parse(body)); return answer(res); }
        res.setHeader('content-type', 'application/json');
        if (req.url.includes('check_session')) return res.end(JSON.stringify({ success: true, data: { logged_in: true, user: { id: 41, username: '附件测试' } } }));
        if (req.url.includes('login')) return res.end(JSON.stringify({ success: true, data: { token: 'attachments-token', user: { id: 41, username: '附件测试' } } }));
        if (req.url.includes('updates.php')) return res.end(JSON.stringify({ success: false }));
        if (req.url.includes('attachment_upload.php')) {
            if (req.url.includes('action=config')) return res.end(JSON.stringify({ success: true, config: attachmentConfig }));
            if (req.url.includes('action=delete')) { deleted.push(JSON.parse(body).attachment_id); return res.end('{"success":true}'); }
            const id = '00000000-0000-4000-8000-' + String(uploads.length + 1).padStart(12, '0');
            uploads.push({ id, name: body.match(/filename="([^"]+)"/)?.[1] });
            return res.end(JSON.stringify({ success: true, attachment_id: id, extracted_text: '合同内容' }));
        }
        if (req.url.includes('conversation_api.php')) {
            if (req.url.includes('action=create')) return res.end('{"success":true,"data":{"conversation_id":7}}');
            if (req.url.includes('action=get')) return res.end(JSON.stringify({ success: true, data: { messages: cloudMessages } }));
            if (req.url.includes('action=save_message')) {
                const message = JSON.parse(body); message.id = cloudMessages.length + 1; message.created_at = '2026-10-05T12:00:00Z'; cloudMessages.push(message);
                return res.end(JSON.stringify({ success: true, data: { message_id: message.id } }));
            }
        }
        res.end(JSON.stringify({ success: true, data: {} }));
    });
    const runtime = createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        if (!req.url.includes('harness_api.php')) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"success":false,"error":"fixture has no model catalog"}'); }
        sends.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (fail) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"success":false,"error":"fixture runtime unavailable"}'); }
        answer(res);
    });
    for (const server of [backend, runtime]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = server => 'http://127.0.0.1:' + server.address().port + '/';
    const data = await mkdtemp(join(tmpdir(), 'moonya-attachments-'));
    const hostProcess = spawn('dotnet', [join(root, 'MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll'),
        join(root, 'MoonYa-Frontend/dist'), url(backend), url(runtime)], { env: { ...process.env, MOONYA_SMOKE_DATA: data, MOONYA_SMOKE_GRANTED_FILES: JSON.stringify(granted) }, windowsHide: true });
    let stderr = ''; hostProcess.stderr.on('data', chunk => stderr += chunk);
    const host = await new Promise((resolve, reject) => {
        createInterface({ input: hostProcess.stdout }).once('line', line => resolve(JSON.parse(line)));
        hostProcess.once('exit', code => reject(new Error('Smoke host exited ' + code + ': ' + stderr)));
    });
    let browser, context;
    const contextOptions = { userAgent: 'MoonYaDesktop/1.0', viewport: { width: 1277, height: 818 } };
    async function launch() {
        if (persistent) {
            context = await chromium.launchPersistentContext(join(data, 'profile'), { channel: 'chrome', headless: true, ...contextOptions });
            browser = { close: () => context.close() };
        } else {
            browser = await chromium.launch({ channel: 'chrome', headless: true }); context = await browser.newContext(contextOptions);
        }
    }
    await launch();
    let page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.url); await page.waitForFunction(() => !!window.MoonYaWorkspace);
    await page.evaluate(async () => {
        const result = await (await fetch('user_auth.php?action=login', { method: 'POST', body: '{}' })).json();
        localStorage.setItem('api_token', result.data.token); renderAuthState(result.data.user);
        await initializeChatHistory(); await switchMoonYaConversationMode('work');
        await createNewChat({ reuse: false });
    });
    return { get page() { return page; }, get context() { return context; }, sends, errors, uploads, deleted, cloudMessages,
        async restartBrowser() {
            assert.ok(persistent); await browser.close(); await launch();
            page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
            await page.goto(host.url); await page.waitForFunction(() => !!MoonYaWorkspace);
        }, async stop() {
        await browser.close();
        await new Promise(resolve => { hostProcess.once('exit', resolve); hostProcess.stdin.end('\n'); });
        for (const server of [backend, runtime]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}
async function idle(page) { await page.waitForFunction(() => !MoonYaConversationRuntime.current().preparing && !MoonYaConversationRuntime.current().running); }
async function submit(page, trigger = 'click') {
    const response = page.waitForResponse(res => /\/(harness_api|api)\.php$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST');
    if (trigger === 'click') await page.locator('#sendBtn').click();
    else { await page.locator('.message-input').focus(); await page.keyboard.press('Enter'); }
    await response; await idle(page);
}
async function stage(page, names = ['参考图一.png', '参考图二.png']) {
    await page.locator('#fileInput').setInputFiles(names.map((name, index) => ({ name, mimeType: name.endsWith('.png') ? 'image/png' : 'text/plain',
        buffer: name.endsWith('.png') ? references[index % 2] : Buffer.from('文件正文') })));
    await page.waitForFunction(count => uploadedImages.length === count && pendingWebUploadBatches === 0, names.length);
}

test('yax.png uses the real authorized local-media route and original cache after refresh', async () => {
    const path = join(root, 'MoonYa-Frontend/public/image/yax.png');
    const f = await fixture({ granted: [path], persistent: true });
    try {
        const status = await f.page.evaluate(async path => {
            const url = MoonYaAttachments.mediaUrl(path);
            return [(await fetch(url, { method: 'HEAD' })).status, (await fetch(MoonYaAttachments.mediaUrl(path + '.missing'))).status,
                (await fetch(url.replace(/t=[^&]+/, 't=invalid'))).status];
        }, path);
        assert.deepEqual(status, [200, 403, 403]);
        await f.page.evaluate(async path => {
            window.moonYaFileOps = { pickLocalFiles: async () => ({ success: true, items: [{ path, name: 'yax.png', kind: 'file', size: 1056177 }] }) };
            await pickLocalPathViaBridge('file');
        }, path);
        await f.page.waitForFunction(() => document.querySelector('#uploadContainer .attachment-card')?.dataset.loadState === 'ready');
        const card = f.page.locator('#uploadContainer .attachment-card'); await card.focus(); await f.page.keyboard.press('Enter');
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-image img')?.naturalWidth === 941);
        const viewer = f.page.locator('.attachment-preview-overlay');
        await viewer.locator('select').selectOption('200');
        assert.match(await viewer.locator('img').evaluate(el => el.style.transform), /scale\(2\)/);
        const bounds = await viewer.locator('img').boundingBox();
        await f.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await f.page.mouse.down(); await f.page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 25); await f.page.mouse.up();
        assert.match(await viewer.locator('img').evaluate(el => el.style.transform), /translate\(30px,\s*25px\)/);
        await viewer.getByRole('button', { name: '复位', exact: true }).click();
        assert.match(await viewer.locator('img').evaluate(el => el.style.transform), /translate\(0px,\s*0px\)/);
        await mkdir(artifacts, { recursive: true }); await viewer.screenshot({ path: join(artifacts, 'preview-yax-light.png') });
        const downloaded = f.page.waitForEvent('download'); await viewer.getByRole('button', { name: '下载', exact: true }).click();
        assert.equal((await downloaded).suggestedFilename(), 'yax.png');
        await f.page.keyboard.press('Escape'); assert.equal(await viewer.count(), 0);
        assert.equal(await card.evaluate(el => document.activeElement === el), true);
        await submit(f.page);
        const id = await f.page.evaluate(() => currentChatId);
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace); await f.page.evaluate(id => loadChat(id), id);
        await f.page.locator('.message.user .attachment-card').click();
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-image img')?.naturalWidth === 941);
        await f.page.evaluate(() => document.documentElement.dataset.theme = 'dark');
        await f.page.locator('.attachment-preview-overlay').screenshot({ path: join(artifacts, 'preview-yax-dark.png') });
        await f.page.keyboard.press('Escape'); assert.deepEqual(f.errors, []);
        await f.restartBrowser();
        let unavailableSourceReads = 0;
        await f.page.route('**/local-media?**', route => { unavailableSourceReads++; return route.fulfill({ status: 403 }); });
        await f.page.evaluate(id => loadChat(id), id);
        await f.page.locator('.message.user .attachment-card').click();
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-image img')?.naturalWidth === 941);
        assert.equal(unavailableSourceReads, 0, 'Restarted history must use the original cache without requiring fresh file authorization');
        await f.page.keyboard.press('Escape'); assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('slow loading, read/decode/timeouts and cache failures have distinct recoverable states', async () => {
    const f = await fixture();
    try {
        let release; const gate = new Promise(resolve => release = resolve);
        const yax = await readFile(join(root, 'MoonYa-Frontend/public/image/yax.png'));
        await f.page.route('**/local-media?**', async route => { await gate; await route.fulfill({ contentType: 'image/png', body: yax }); });
        await f.page.evaluate(async () => {
            window.moonYaFileOps = { pickLocalFiles: async () => ({ success: true, items: [{ path: 'D:\\Fixture\\yax.png', name: 'yax.png', kind: 'file' }] }) };
            await pickLocalPathViaBridge('file');
        });
        assert.equal(await f.page.locator('#uploadContainer .attachment-skeleton').count(), 1);
        assert.equal(await f.page.locator('#uploadContainer .attachment-file').count(), 0);
        release(); await f.page.waitForFunction(() => document.querySelector('#uploadContainer .attachment-card')?.dataset.loadState === 'ready');
        await f.page.unroute('**/local-media?**');
        await f.page.route('**/local-media?**', route => route.fulfill({ status: 403 }));
        await f.page.evaluate(() => {
            const selection = localPathSelections[0]; delete selection.source_ref; delete selection.preview_ref; delete selection.preview_url;
            document.querySelector('.local-path-item').remove(); renderLocalPathSelections();
        });
        await f.page.waitForFunction(() => document.querySelector('#uploadContainer .attachment-card')?.dataset.loadState === 'failed');
        assert.match(await f.page.locator('.attachment-failed').innerText(), /本机读取失败/);
        await f.page.unroute('**/local-media?**');
        await f.page.route('**/local-media?**', route => route.fulfill({ contentType: 'image/png', body: 'invalid png' }));
        await f.page.getByRole('button', { name: '重试', exact: true }).click();
        await f.page.waitForFunction(() => localPathSelections[0].preview_error === '图片解码失败');
        assert.match(await f.page.locator('.attachment-failed').innerText(), /图片解码失败/);
        await f.page.unroute('**/local-media?**');
        await f.page.route('**/local-media?**', route => route.fulfill({ contentType: 'image/png', body: yax }));
        await f.page.evaluate(() => { window.savedCacheWrite = MoonYaHistoryStore.saveAttachment; MoonYaHistoryStore.saveAttachment = async () => false; });
        await f.page.getByRole('button', { name: '重试', exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('#uploadContainer .attachment-card')?.dataset.loadState === 'ready');
        assert.match(await f.page.evaluate(() => localPathSelections[0].cache_error), /缓存写入失败/);
        assert.equal(await f.page.locator('.attachment-file').count(), 0);
        const timeout = await f.page.evaluate(async () => {
            MoonYaHistoryStore.saveAttachment = window.savedCacheWrite;
            const nativeFetch = window.fetch;
            window.fetch = async () => { throw new DOMException('Timed out', 'TimeoutError'); };
            const selection = { path: 'D:\\Fixture\\timeout.png', name: 'timeout.png', kind: 'file' };
            await MoonYaAttachments.localPreview(selection, MoonYaConversationRuntime.current()); window.fetch = nativeFetch;
            return selection.preview_error;
        });
        assert.equal(timeout, '本机读取超时'); assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

function twoPagePdf() {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>'];
    let result = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(result); result += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    result += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return result;
}

test('PDF pages, safe text, media, unsupported formats and missing old sources preview correctly', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(async pdf => {
            const runtime = MoonYaConversationRuntime.current();
            const inputs = [['两页.pdf', pdf, 'application/pdf'], ['文本.txt', '<script>danger()</script>\n纯文本', 'text/plain'],
                ['演示.docx', 'office bytes', 'application/octet-stream'], ['大文本.txt', 'a'.repeat(2 * 1024 * 1024 + 1), 'text/plain']];
            const host = document.createElement('div'); host.id = 'preview-test-files'; document.querySelector('.main-content').append(host);
            for (const [name, data, mime] of inputs) {
                const file = new Blob([data], { type: mime }); const sourceRef = await MoonYaAttachments.cacheFile(file, runtime);
                host.append(MoonYaAttachments.card({ id: name, name, category: 'document', size: file.size, sourceRef }));
            }
        }, twoPagePdf());
        const cards = f.page.locator('#preview-test-files .attachment-card');
        await cards.nth(0).click(); await f.page.waitForFunction(() => document.querySelectorAll('.attachment-preview-pdf canvas').length === 2);
        assert.equal(await f.page.locator('.attachment-preview-pdf canvas').nth(1).getAttribute('aria-label'), '第 2 页');
        await f.page.locator('.attachment-preview-toolbar select').selectOption('150');
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-pdf canvas')?.style.width === '450px');
        await f.page.keyboard.press('Escape');
        await cards.nth(1).click(); await f.page.waitForFunction(() => !!document.querySelector('.attachment-preview-stage pre'));
        assert.equal(await f.page.locator('.attachment-preview-stage script').count(), 0);
        assert.equal(await f.page.locator('.attachment-preview-stage pre').innerText(), '<script>danger()</script>\n纯文本');
        await f.page.keyboard.press('Escape'); await cards.nth(2).click();
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-info')?.textContent.includes('不支持直接预览'));
        assert.equal(await f.page.getByRole('button', { name: '下载', exact: true }).isEnabled(), true);
        await f.page.evaluate(async () => {
            window.CefSharp = {};
            window.moonYaFileOps = { openCachedAttachment: async (name, base64) => { window.systemOpened = { name, content: atob(base64) }; return { success: true }; } };
            await MoonYaAttachmentPreview.open(document.querySelectorAll('#preview-test-files .attachment-card')[2]._attachment);
        });
        await f.page.getByRole('button', { name: '用系统应用打开', exact: true }).click();
        await f.page.waitForFunction(() => !!window.systemOpened);
        assert.deepEqual(await f.page.evaluate(() => window.systemOpened), { name: '演示.docx', content: 'office bytes' });
        await f.page.setViewportSize({ width: 360, height: 720 });
        assert.equal(await f.page.locator('.attachment-preview-overlay').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        await f.page.setViewportSize({ width: 1277, height: 818 });
        await f.page.evaluate(() => { delete window.CefSharp; delete window.moonYaFileOps; });
        await f.page.keyboard.press('Escape'); await cards.nth(3).click();
        await f.page.waitForFunction(() => document.querySelector('.attachment-preview-info')?.textContent.includes('超过 2MB'));
        await f.page.keyboard.press('Escape');
        await f.page.evaluate(async () => {
            await MoonYaAttachmentPreview.open({ name: '旧文档.docx', category: 'document' });
        });
        assert.match(await f.page.locator('.attachment-preview-info').innerText(), /没有可用的原文件缓存/);
        await f.page.keyboard.press('Escape');
        for (const category of ['audio', 'video']) {
            await f.page.evaluate(async category => {
                const runtime = MoonYaConversationRuntime.current();
                const ref = await MoonYaAttachments.cacheFile(new Blob(['media fixture'], { type: category + '/webm' }), runtime);
                window.revocations = []; const revoke = URL.revokeObjectURL; URL.revokeObjectURL = url => { window.revocations.push(url); revoke(url); };
                await MoonYaAttachmentPreview.open({ name: category + '.webm', category, sourceRef: ref });
            }, category);
            assert.equal(await f.page.locator('.attachment-preview-stage ' + category).getAttribute('controls'), '');
            await f.page.keyboard.press('Escape'); assert.ok(await f.page.evaluate(() => window.revocations.length > 0));
        }
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('chat drop boundaries and native handoff preserve order, deduplicate and reject changed conversations', async () => {
    const f = await fixture();
    try {
        const checks = await f.page.evaluate(async () => {
            const main = document.querySelector('.main-content').getBoundingClientRect(), side = document.querySelector('#sidebar').getBoundingClientRect();
            const hit = rect => moonyaAttachmentDragAt((rect.left + rect.width / 2) / innerWidth, (rect.top + rect.height / 2) / innerHeight);
            const context = hit(main); const sidebar = hit(side);
            const payload = { id: 'native-once', context, items: [{ path: 'D:\\Fixture\\first.txt', name: 'first.txt', kind: 'file' }, { path: 'D:\\Fixture\\second.txt', name: 'second.txt', kind: 'file' }] };
            await moonyaReceiveNativeDrop(payload); await moonyaReceiveNativeDrop(payload);
            const paths = localPathSelections.map(item => item.name);
            await createNewChat({ reuse: false });
            const rejected = await moonyaReceiveNativeDrop({ ...payload, id: 'native-changed' });
            await MoonYaAttachmentPreview.open({ name: 'missing.docx', category: 'document' });
            const modal = hit(main); MoonYaAttachmentPreview.close();
            document.body.classList.add('plugins-active'); const plugins = hit(main); document.body.classList.remove('plugins-active');
            return { sidebar, paths, rejected, modal, plugins };
        });
        assert.equal(checks.sidebar, null); assert.deepEqual(checks.paths, ['first.txt', 'second.txt']);
        assert.deepEqual(checks.rejected, []); assert.equal(checks.modal, null); assert.equal(checks.plugins, null);
        assert.equal(f.sends.length, 0);
    } finally { await f.stop(); }
});

test('cached audio/video actually play, stop on close and original cache respects the 20MB boundary', async () => {
    const f = await fixture();
    try {
        const result = await f.page.evaluate(async () => {
            const runtime = MoonYaConversationRuntime.current();
            const tooLarge = new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]);
            const limit = await MoonYaAttachments.cacheFile(tooLarge, runtime);
            const pcm = new Uint8Array(44 + 8000 * 2); const header = new DataView(pcm.buffer);
            const chars = (offset, text) => [...text].forEach((char, index) => header.setUint8(offset + index, char.charCodeAt(0)));
            chars(0, 'RIFF'); header.setUint32(4, pcm.length - 8, true); chars(8, 'WAVE'); chars(12, 'fmt ');
            header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true);
            header.setUint32(24, 8000, true); header.setUint32(28, 16000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
            chars(36, 'data'); header.setUint32(40, pcm.length - 44, true);
            const sourceRef = await MoonYaAttachments.cacheFile(new Blob([pcm], { type: 'audio/wav' }), runtime);
            await MoonYaAttachmentPreview.open({ name: '播放.wav', category: 'audio', sourceRef });
            window.previewMedia = document.querySelector('.attachment-preview-stage audio');
            return limit;
        });
        assert.equal(result, null);
        await f.page.locator('.attachment-preview-stage audio').evaluate(async media => { media.muted = true; await media.play(); });
        await f.page.waitForFunction(() => window.previewMedia.currentTime > 0);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.evaluate(() => window.previewMedia.paused && !window.previewMedia.hasAttribute('src')), true);
        await f.page.evaluate(async () => {
            const encoded = [];
            const encoder = new VideoEncoder({ output: chunk => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); encoded.push(bytes); }, error: error => { throw error; } });
            encoder.configure({ codec: 'vp8', width: 160, height: 90, bitrate: 100000, framerate: 10, hardwareAcceleration: 'prefer-software' });
            for (let frame = 0; frame < 4; frame++) {
                const pixels = new Uint8Array(160 * 90 * 4); pixels.fill(120 + frame * 20);
                const source = new VideoFrame(pixels, { format: 'RGBA', codedWidth: 160, codedHeight: 90, timestamp: frame * 100000 });
                encoder.encode(source, { keyFrame: true }); source.close();
            }
            await encoder.flush(); encoder.close();
            const join = (...arrays) => { const out = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0)); let at = 0; arrays.forEach(value => { out.set(value, at); at += value.length; }); return out; };
            const bytes = hex => new Uint8Array(hex.match(/../g).map(value => parseInt(value, 16)));
            const element = (id, data) => {
                let width = 1; while (data.length >= 2 ** (7 * width) - 1) width++;
                let size = data.length; const length = new Uint8Array(width);
                for (let index = width - 1; index >= 0; index--) { length[index] = size & 255; size = Math.floor(size / 256); } length[0] |= 1 << (8 - width);
                return join(bytes(id), length, data);
            };
            const integer = (id, value) => element(id, bytes(value.toString(16).padStart(value.toString(16).length + value.toString(16).length % 2, '0')));
            const text = (id, value) => element(id, new TextEncoder().encode(value));
            const header = element('1a45dfa3', join(integer('4286',1), integer('42f7',1), integer('42f2',4), integer('42f3',8), text('4282','webm'), integer('4287',2), integer('4285',2)));
            const duration = new Uint8Array(8); new DataView(duration.buffer).setFloat64(0, 1000);
            const info = element('1549a966', join(integer('2ad7b1',1000000), element('4489',duration), text('4d80','MoonYa test'), text('5741','MoonYa test')));
            const track = element('1654ae6b', element('ae', join(integer('d7',1), integer('73c5',1), integer('83',1), text('86','V_VP8'), element('e0',join(integer('b0',160),integer('ba',90))))));
            const cluster = element('1f43b675', join(integer('e7',0), ...encoded.map((data,index) => element('a3', join(new Uint8Array([0x81,(index*100)>>8,(index*100)&255,0x80]),data)))));
            const sourceRef = await MoonYaAttachments.cacheFile(new Blob([header,element('18538067',join(info,track,cluster))], { type: 'video/webm' }), MoonYaConversationRuntime.current());
            await MoonYaAttachmentPreview.open({ name: '播放.webm', category: 'video', sourceRef });
            window.previewMedia = document.querySelector('.attachment-preview-stage video');
        });
        await f.page.locator('.attachment-preview-stage video').evaluate(async media => { media.muted = true; await media.play(); });
        await f.page.waitForFunction(() => window.previewMedia.currentTime > 0);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.evaluate(() => window.previewMedia.paused && !window.previewMedia.hasAttribute('src')), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('cross-row and consecutive removals retain nodes, update drafts immediately and honor reduced motion', async () => {
    const f = await fixture();
    try {
        await f.page.setViewportSize({ width: 610, height: 760 });
        await stage(f.page, ['1.png', '2.png', '3.png', '4.png', '5.png']);
        const result = await f.page.evaluate(() => {
            const cards = [...document.querySelectorAll('#uploadContainer .attachment-card')]; const survivor = cards[4];
            cards[0].querySelector('.attachment-remove').click();
            const immediate = uploadedImages.length;
            cards[1].querySelector('.attachment-remove').click();
            const preserved = document.querySelector('#uploadContainer .attachment-card:last-child') === survivor;
            const animations = survivor.getAnimations().map(animation => animation.effect.getTiming().duration);
            return { immediate, preserved, animations, count: uploadedImages.length };
        });
        assert.equal(result.immediate, 4); assert.equal(result.count, 3); assert.equal(result.preserved, true); assert.ok(result.animations.includes(220));
        await f.page.waitForFunction(() => !document.querySelector('.attachment-removal-ghost'));
        assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 3);
        await f.page.emulateMedia({ reducedMotion: 'reduce' });
        const last = await f.page.evaluate(() => {
            for (const button of [...document.querySelectorAll('#uploadContainer .attachment-remove')]) button.click();
            return { count: uploadedImages.length, ghosts: document.querySelectorAll('.attachment-removal-ghost').length };
        });
        assert.deepEqual(last, { count: 0, ghosts: 0 });
        const runtime = await f.page.evaluate(async () => { const rt = MoonYaConversationRuntime.current(); await MoonYaHistoryStore.retry(CHAT_HISTORY_KEY); return { id: rt.chatId, draft: await MoonYaHistoryStore.loadDraft(CHAT_HISTORY_KEY, rt.chatId) }; });
        assert.equal(runtime.draft.uploadedImages.length, 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('reference cards, hover removal, file-only sends and history remain identical after reload', async () => {
    const f = await fixture();
    try {
        await mkdir(artifacts, { recursive: true });
        await stage(f.page);
        const first = f.page.locator('#uploadContainer .attachment-card').first();
        const geometry = await first.boundingBox(); assert.equal(geometry.width, 122); assert.equal(geometry.height, 122);
        assert.deepEqual(await first.evaluate(card => {
            const button = getComputedStyle(card.querySelector('.attachment-remove'));
            return [getComputedStyle(card).borderRadius, getComputedStyle(card.parentElement).gap, button.width, button.height, button.top, button.right];
        }), ['8px', '12px', '18px', '18px', '-3px', '-3px']);
        assert.equal(await f.page.locator('.input-wrapper > #uploadContainer').count(), 1);
        assert.equal(await first.locator('.attachment-remove').isVisible(), false);
        await f.page.locator('.input-container-wrapper').screenshot({ path: join(artifacts, 'composer.png') });
        await first.hover(); assert.equal(await first.locator('.attachment-remove').isVisible(), true);
        await f.page.locator('.input-container-wrapper').screenshot({ path: join(artifacts, 'composer-hover.png') });
        const draftId = await f.page.evaluate(async () => {
            const id = currentChatId; await createNewChat({ reuse: false }); return id;
        });
        assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 0);
        await f.page.evaluate(id => loadChat(id), draftId);
        assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 2);
        await submit(f.page);
        assert.equal(f.sends.length, 1); assert.equal(f.sends[0].message, ''); assert.equal(f.sends[0].local_attachments.length, 2);
        const user = f.page.locator('.message.user').last();
        assert.equal(await user.locator('.attachment-card').count(), 2); assert.equal(await user.locator('.user-message-bubble').count(), 0);
        assert.equal(await user.locator('.attachment-remove').count(), 0);
        const sent = await user.locator('.attachment-card').first().boundingBox(); assert.equal(sent.width, 80); assert.equal(sent.height, 80);
        await user.screenshot({ path: join(artifacts, 'sent-files-only.png') });
        const id = await f.page.evaluate(() => currentChatId);
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace);
        await f.page.evaluate(id => loadChat(id), id);
        assert.equal(await f.page.locator('.message.user .attachment-card').count(), 2);
        assert.equal(await f.page.locator('.message.user .user-message-bubble').count(), 0);
        const saved = await f.page.evaluate(async id => (await MoonYaHistoryStore.hydrate(CHAT_HISTORY_KEY, id)).messages.find(m => m.type === 'user'), id);
        assert.equal(saved.content, ''); assert.deepEqual(saved.attachments.map(a => a.name), ['参考图一.png', '参考图二.png']);
        assert.equal(saved.images.length, 2); assert.ok(saved.images.every(img => img.startsWith('data:')));
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('native file-only button/Enter sends, cached image previews and failure drafts keep their metadata', async () => {
    for (const [trigger, fail] of [['click', false], ['enter', true]]) {
        const f = await fixture({ fail });
        try {
            let mediaReads = 0;
            await f.page.route('**/local-media?**', route => { mediaReads++; return route.fulfill({ contentType: 'image/png', body: references[0] }); });
            await f.page.evaluate(async () => {
                window.revoked = [];
                window.moonYaFileOps = {
                    pickLocalFiles: async () => ({ success: true, items: [{ path: 'D:\\Fixture\\原图.png', name: '原图.png', kind: 'file' }, { path: 'D:\\Fixture\\报告.pdf', name: '报告.pdf', kind: 'file' }] }),
                    pickLocalFolders: async () => ({ success: true, items: [{ path: 'D:\\Fixture\\文件夹', name: '文件夹', kind: 'folder' }] }),
                    revokeLocalPath: async path => { window.revoked.push(path); return { success: true }; }
                };
                await pickLocalPathViaBridge('file');
            });
            await f.page.waitForFunction(() => localPathSelections[0].preview_url?.startsWith('data:'));
            await f.page.evaluate(() => pickLocalPathViaBridge('folder'));
            assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 3);
            const folder = f.page.locator('#uploadContainer .attachment-card').last(); await folder.hover();
            await folder.locator('.attachment-remove').click();
            await f.page.waitForFunction(() => window.revoked.length === 1);
            assert.deepEqual(await f.page.evaluate(() => window.revoked), ['D:\\Fixture\\文件夹']);
            const chatId = await f.page.evaluate(() => currentChatId);
            await submit(f.page, trigger); assert.equal(f.sends.length, 1);
            assert.equal(f.sends[0].message, ''); assert.equal(f.sends[0].local_paths.length, 2);
            assert.equal(f.sends[0].local_paths[0].preview_url, undefined);
            assert.deepEqual(await f.page.locator('.message.user .attachment-name').allTextContents(), ['报告.pdf']);
            assert.equal(await f.page.locator('.message.user .user-message-bubble').count(), 0);
            await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace);
            await f.page.evaluate(id => loadChat(id), chatId);
            assert.equal(await f.page.locator('.message.user .attachment-card').count(), 2);
            assert.equal(await f.page.locator('.message.user img').count(), 1);
            if (fail) {
                assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 2);
                assert.equal(await f.page.locator('#uploadContainer img').count(), 1);
            }
            assert.equal(mediaReads, 2); assert.deepEqual(f.errors, []);
        } finally { await f.stop(); }
    }
});

test('mixed types have safe names, separate text bubbles, ordered history and bounded layouts', async () => {
    const f = await fixture();
    try {
        const result = await f.page.evaluate(async image => {
            const names = ['<img src=x onerror=alert(1)>.pdf', '资料.docx', '数据.xlsx', '幻灯片.pptx', '代码.js', '包.zip', '声音.mp3', '视频.mp4', '文件夹'];
            const items = names.map((name, index) => ({ id: 'file-' + index, name,
                category: MoonYaAttachments.category(name, index === names.length - 1 ? 'folder' : 'file'), order: index + 1, preview: '' }));
            items.unshift({ id: 'image', name: '参考图片.png', category: 'image', order: 0, preview: image });
            const projection = MoonYaAttachments.serialize(items);
            addMessage('user', '123', projection.images, [], '', null, [], items);
            await saveCurrentChat();
            return { id: currentChatId, kinds: items.map(a => a.category) };
        }, 'data:image/png;base64,' + references[0].toString('base64'));
        assert.ok(result.kinds.includes('archive')); assert.ok(result.kinds.includes('audio')); assert.ok(result.kinds.includes('folder'));
        assert.equal(await f.page.locator('.message.user .user-message-bubble').textContent(), '123');
        assert.equal(await f.page.locator('.user-message-bubble').evaluate(bubble => getComputedStyle(bubble).backgroundColor), 'rgb(232, 243, 254)');
        assert.equal(await f.page.locator('.message.user img').count(), 1);
        await f.page.locator('.message.user').screenshot({ path: join(artifacts, 'sent-mixed.png') });
        await f.page.evaluate(id => loadChat(id), result.id);
        assert.equal(await f.page.locator('.message.user .attachment-card').count(), 10);
        assert.equal(await f.page.locator('.message.user .user-message-bubble').textContent(), '123');
        for (const width of [1277, 460, 320]) {
            await f.page.setViewportSize({ width, height: 818 });
            const geometry = await f.page.evaluate(() => {
                const stack = document.querySelector('.user-message-stack'), gallery = stack.querySelector('.sent-attachments');
                return { overflow: document.documentElement.scrollWidth > innerWidth, right: gallery.getBoundingClientRect().right,
                    stackRight: stack.getBoundingClientRect().right, count: gallery.children.length };
            });
            assert.equal(geometry.overflow, false); assert.equal(geometry.right, geometry.stackRight); assert.equal(geometry.count, 10);
        }
        await f.page.emulateMedia({ colorScheme: 'dark' });
        await f.page.screenshot({ path: join(artifacts, 'narrow-dark.png') });
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('paste/drop share staging; removal persists and processing guards never leave a stop button', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(async () => {
            const target = document.querySelector('.input-wrapper');
            const clipboard = new DataTransfer(); clipboard.items.add(new File(['剪贴板文件'], '粘贴.txt', { type: 'text/plain' }));
            target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        });
        await f.page.waitForFunction(() => uploadedImages.length === 1 && pendingWebUploadBatches === 0);
        await f.page.evaluate(() => {
            const transfer = new DataTransfer(); transfer.items.add(new File(['拖拽文件'], '拖拽.txt', { type: 'text/plain' }));
            document.querySelector('.input-wrapper').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
        });
        await f.page.waitForFunction(() => uploadedImages.length === 2 && pendingWebUploadBatches === 0);
        await f.page.evaluate(() => { pendingWebUploadBatches = 1; });
        await f.page.locator('#sendBtn').click();
        assert.equal(f.sends.length, 0); assert.notEqual(await f.page.locator('#sendBtn').getAttribute('data-state'), 'stop');
        await f.page.locator('.message-input').focus(); await f.page.keyboard.press('Enter');
        assert.equal(f.sends.length, 0); assert.notEqual(await f.page.locator('#sendBtn').getAttribute('data-state'), 'stop');
        await f.page.evaluate(() => { pendingWebUploadBatches = 0; });
        const first = f.page.locator('#uploadContainer .attachment-card').first(); await first.focus();
        assert.equal(await first.locator('.attachment-remove').isVisible(), true);
        await first.locator('.attachment-remove').click();
        assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 1);
        const remaining = f.page.locator('#uploadContainer .attachment-card').first(); await remaining.hover(); await remaining.locator('.attachment-remove').click();
        await f.page.locator('#sendBtn').click(); assert.equal(f.sends.length, 0);
        const id = await f.page.evaluate(() => currentChatId);
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace); await f.page.evaluate(id => loadChat(id), id);
        assert.equal(await f.page.locator('#uploadContainer .attachment-card').count(), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('Chat cloud uploads send only attachment IDs, delete staged files and replay the metadata envelope', async () => {
    const f = await fixture();
    try {
        await f.page.evaluate(async () => { await switchMoonYaConversationMode('chat'); await createNewChat({ reuse: false, mode: 'chat' }); });
        await stage(f.page, ['图片.png', '合同.pdf']);
        assert.equal(f.uploads.length, 2);
        const document = f.page.locator('#uploadContainer .attachment-card').last();
        await document.hover(); await document.locator('.attachment-remove').click();
        await f.page.waitForFunction(() => uploadedImages.length === 1);
        await f.page.locator('#fileInput').setInputFiles({ name: '合同.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture PDF') });
        await f.page.waitForFunction(() => uploadedImages.length === 2 && pendingWebUploadBatches === 0);
        await submit(f.page, 'enter');
        assert.equal(f.sends.length, 1, JSON.stringify(await f.page.evaluate(() => ({
            mode: currentConversationMode(), loggedIn: isLoggedIn, toast: document.getElementById('toast').textContent,
            notifications: document.querySelector('#moonyaNotificationStack')?.textContent, preparing: MoonYaConversationRuntime.current().preparing,
            running: MoonYaConversationRuntime.current().running, uploads: uploadedImages.length
        })))); assert.equal(f.sends[0].message, ''); assert.equal(f.sends[0].attachment_ids.length, 2);
        assert.deepEqual(f.deleted, [f.uploads[1].id]);
        assert.equal(await f.page.locator('.message.user .attachment-card').count(), 2);
        assert.equal(await f.page.locator('.message.user .user-message-bubble').count(), 0);
        const id = await f.page.evaluate(() => currentChatId);
        const user = f.cloudMessages.find(message => message.role === 'user');
        assert.equal(user.content, ''); assert.equal(user.images.length, 2);
        assert.deepEqual(user.statuses.find(status => status.kind === 'attachment_presentation_v1').attachments.map(a => a.name), ['图片.png', '合同.pdf']);
        await f.page.reload(); await f.page.waitForFunction(() => !!MoonYaWorkspace); await f.page.evaluate(id => loadChat(id), id);
        assert.equal(await f.page.locator('.message.user .attachment-card').count(), 2);
        assert.equal(await f.page.locator('.message.user img').count(), 1);
        assert.equal(await f.page.locator('.message.user .attachment-name').textContent(), '合同.pdf');
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});

test('legacy document markers and saved badges replay as cards without consuming real text', async () => {
    const f = await fixture();
    try {
        const id = await f.page.evaluate(async image => {
            const chat = getChatHistory().find(chat => chat.id === currentChatId);
            chat.messages = [{ type: 'user', clientMessageId: 'legacy', images: [image, 'pdf://old.pdf', 'videothumb://' + image],
                content: '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><div style="display:inline-flex"><svg></svg><span>old.pdf</span></div><div style="display:inline-flex"><svg></svg><span>notes.txt</span></div></div><div>原来的正文</div>' }];
            chat.messagesLoaded = true; await MoonYaHistoryStore.save(CHAT_HISTORY_KEY, getChatHistory());
            MoonYaConversationRuntime.current().container.innerHTML = ''; await loadChat(chat.id); await saveCurrentChat();
            return chat.id;
        }, 'data:image/png;base64,' + png.toString('base64'));
        assert.equal(await f.page.locator('.message.user .attachment-card').count(), 4);
        assert.equal(await f.page.locator('.message.user .user-message-bubble').textContent(), '原来的正文');
        assert.deepEqual(await f.page.locator('.message.user .attachment-name').allTextContents(), ['old.pdf', '视频文件', 'notes.txt']);
        const saved = await f.page.evaluate(async id => (await MoonYaHistoryStore.hydrate(CHAT_HISTORY_KEY, id)).messages[0], id);
        assert.equal(saved.images.length, 4); assert.ok(!saved.content.includes('old.pdf')); assert.ok(saved.content.includes('原来的正文'));
        assert.deepEqual(f.errors, []);
    } finally { await f.stop(); }
});
