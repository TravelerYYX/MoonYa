'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const source = path.join(__dirname, '../../MoonYa-Frontend/src/history-store.js');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

test('real IndexedDB retains large histories, migrates without loss and isolates users/devices', { timeout: 30000 }, async () => {
    const server = http.createServer((req, res) => res.end('<!doctype html><title>local history fixture</title>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ path: source });
        const result = await page.evaluate(async () => {
            const scope = 'chat_history_2';
            const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
            const old = [
                { id: 'work-old', title: 'work', dbConversationId: 1, messages: [{ type: 'ai', content: '<pre>full tool</pre>', images: [png], statuses: [{ html: '<b>raw trace</b>' }] }] },
                { id: 'unknown-old', title: 'unknown', dbConversationId: 2, messages: [{ type: 'user', content: 'untagged' }] }
            ];
            localStorage.setItem(scope, JSON.stringify(old));
            localStorage.setItem('moonya.harness.session.work-old.project', 'session-id');
            await MoonYaHistoryStore.initialize(scope);
            const work = await MoonYaHistoryStore.hydrate(scope, 'work-old');
            const unknown = await MoonYaHistoryStore.hydrate(scope, 'unknown-old');
            const migrated = JSON.stringify(work.messages) === JSON.stringify(old[0].messages)
                && JSON.stringify(unknown.messages) === JSON.stringify(old[1].messages);
            const large = { id: 'large-work', mode: 'work', storage: 'local', title: 'large', messagesLoaded: true,
                messages: [{ type: 'ai', content: 'full tool '.repeat(900000), images: [png] }] };
            const quotaExceeded = (() => {
                try { localStorage.setItem('quota-probe', large.messages[0].content); return false; }
                catch (error) { return error.name === 'QuotaExceededError'; }
            })();
            // A broken localStorage writer cannot affect new history persistence.
            Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
            await MoonYaHistoryStore.save(scope, [...MoonYaHistoryStore.list(scope), large]);
            const event = { run_id: 'session-id', seq: 1, event: 'tool.completed', payload: { output: large.messages[0].content } };
            await MoonYaHistoryStore.appendEvent(scope, large.id, event);
            await MoonYaHistoryStore.appendEvent(scope, large.id, event);
            await MoonYaHistoryStore.saveDraft(scope, large.id, { draft: 'local draft', mode: 'work' });
            return { scope, migrated, quotaExceeded, removed: localStorage.getItem(scope) === null,
                binding: work.runtimeSessions.project, workMode: work.mode, workDbId: work.dbConversationId || null, unknownMode: unknown.mode, unknownReadOnly: unknown.readOnly };
        });
        assert.deepEqual(result, { scope: 'chat_history_2', migrated: true, quotaExceeded: true, removed: true,
            binding: 'session-id', workMode: 'work', workDbId: null, unknownMode: 'legacy', unknownReadOnly: true });
        await page.reload();
        await page.addScriptTag({ path: source });
        const restored = await page.evaluate(async () => {
            await MoonYaHistoryStore.initialize('chat_history_2');
            const lazy = MoonYaHistoryStore.list('chat_history_2').every(chat => chat.messagesLoaded === false && chat.messages.length === 0);
            const chat = await MoonYaHistoryStore.hydrate('chat_history_2', 'large-work');
            const events = await MoonYaHistoryStore.events('chat_history_2', 'large-work');
            await MoonYaHistoryStore.initialize('chat_history_7');
            return { lazy, chars: chat.messages[0].content.length, image: chat.messages[0].images[0].startsWith('data:image/png'),
                events: events.length, eventChars: events[0].payload.output.length,
                draft: (await MoonYaHistoryStore.loadDraft('chat_history_2', 'large-work')).draft,
                otherUser: MoonYaHistoryStore.list('chat_history_7').length };
        });
        assert.deepEqual(restored, { lazy: true, chars: 9000000, image: true, events: 1, eventChars: 9000000, draft: 'local draft', otherUser: 0 });
        const device = await browser.newContext();
        const otherPage = await device.newPage();
        await otherPage.goto(page.url());
        await otherPage.addScriptTag({ path: source });
        assert.equal(await otherPage.evaluate(async () => {
            await MoonYaHistoryStore.initialize('chat_history_2');
            return MoonYaHistoryStore.list('chat_history_2').length;
        }), 0);
        await device.close();

        const recovery = await page.evaluate(async () => {
            const scope = 'chat_history_2';
            const original = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function(names, mode) {
                const tx = original.call(this, names, mode);
                if (mode === 'readwrite') queueMicrotask(() => tx.abort());
                return tx;
            };
            const history = MoonYaHistoryStore.list(scope);
            const chat = history.find(chat => chat.id === 'large-work');
            chat.title = 'retained during failed transaction';
            const saved = await MoonYaHistoryStore.save(scope, history.filter(item => item.id !== 'unknown-old')); 
            const memoryRetained = MoonYaHistoryStore.list(scope).find(item => item.id === chat.id).title === chat.title;
            IDBDatabase.prototype.transaction = original;
            const retried = await MoonYaHistoryStore.retry(scope);
            return { saved, memoryRetained, retried, unsaved: !!chat.unsaved };
        });
        assert.deepEqual(recovery, { saved: false, memoryRetained: true, retried: true, unsaved: false });
        await page.reload();
        await page.addScriptTag({ path: source });
        assert.equal(await page.evaluate(async () => {
            await MoonYaHistoryStore.initialize('chat_history_2');
            return MoonYaHistoryStore.list('chat_history_2').some(chat => chat.id === 'unknown-old');
        }), false, 'a failed deletion must be retried instead of reappearing after reload');
        await context.close();
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('interrupted migration keeps the source and can be retried idempotently', { timeout: 15000 }, async () => {
    const server = http.createServer((req, res) => res.end('<!doctype html><title>migration fixture</title>'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
        const page = await browser.newPage();
        if (process.env.MOONYA_TEST_DEBUG) page.on('console', message => console.log(message.type(), message.text()));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.addScriptTag({ path: source });
        const first = await page.evaluate(async () => {
            localStorage.setItem('chat_history_2', JSON.stringify([{ id: 'old', messages: [{ content: 'preserve me' }] }]));
            Storage.prototype.removeItem = () => { throw new Error('simulated interruption'); };
            await MoonYaHistoryStore.initialize('chat_history_2');
            return { kept: localStorage.getItem('chat_history_2') !== null, memory: MoonYaHistoryStore.list('chat_history_2')[0].messages[0].content };
        });
        assert.deepEqual(first, { kept: true, memory: 'preserve me' });
        await page.reload();
        await page.addScriptTag({ path: source });
        const second = await page.evaluate(async () => {
            await MoonYaHistoryStore.initialize('chat_history_2');
            return { removed: localStorage.getItem('chat_history_2') === null, count: MoonYaHistoryStore.list('chat_history_2').length,
                content: (await MoonYaHistoryStore.hydrate('chat_history_2', 'old')).messages[0].content };
        });
        assert.deepEqual(second, { removed: true, count: 1, content: 'preserve me' });
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('actual page keeps detached Work local while Chat sends and mode drafts stay independent', { timeout: 30000 }, async () => {
    const backend = path.join(__dirname, '..');
    const frontend = path.resolve(backend, '../MoonYa-Frontend/dist');
    execFileSync(process.execPath, [path.join(frontend,'../build.mjs')]);
    const html = readFileSync(path.join(frontend,'index.html'));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://fixture');
        if(url.pathname==='/runtime-config.js'){res.setHeader('content-type','text/javascript');return res.end('window.MoonYaHost={backendUrl:"http://fixture/",gatewayToken:"fixture"};');}
        if(url.pathname==='/gateway/migration'){res.setHeader('content-type','application/json');return res.end('null');}
        if(url.pathname!=='/'){
            const file=path.resolve(frontend,'.'+url.pathname);
            if(file.startsWith(frontend+path.sep)&&require('node:fs').existsSync(file)){
                res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');return res.end(readFileSync(file));
            }
        }
        if (url.pathname === '/script/MoonYa-index/history-store.js') {
            res.setHeader('content-type', 'application/javascript');
            return res.end(readFileSync(source));
        }
        res.setHeader('content-type', 'text/html');
        res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.MOONYA_TEST_BROWSER_CHANNEL || 'chrome', headless: true });
    let releaseWork;
    try {
        const page = await browser.newPage();
        const errors = [];
        if(process.env.MOONYA_TEST_DEBUG){page.on('console',m=>console.log(m.type(),m.text()));page.on('pageerror',e=>console.log('PAGEERROR',e.message));page.on('request',r=>console.log('REQUEST',r.url()));}
        page.on('pageerror', error => errors.push(error.message));
        const cloudWrites = [];
        let workRequest;
        let nextCloudId = 1;
        let notifyWorkAdmission;
        await page.addInitScript(() => {
            window.SharedWorker = undefined;
            window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; } };
        });
        await page.route('**/*', async route => {
            const request = route.request();
            const url = new URL(request.url());
            const action = url.searchParams.get('action');
            if (url.pathname === '/' || !url.pathname.endsWith('.php')) return route.continue();
            if (url.pathname.endsWith('/user_auth.php')) return route.fulfill({ json: { success: true, data: { logged_in: true, user: { id: 2, username: 'fixture' } } } });
            if (url.pathname.endsWith('/model_api.php')) return route.fulfill({ json: { success: true, data: { providers: [], presets: [] } } });
            if (url.pathname.endsWith('/work_projects.php') && request.method() !== 'GET') cloudWrites.push({ action: 'project_cloud_write', body: request.postDataJSON() });
            if (url.pathname.endsWith('/conversation_api.php')) {
                if (request.method() !== 'GET') cloudWrites.push({ action, body: request.postDataJSON() });
                if (action === 'create') return route.fulfill({ json: { success: true, data: { conversation_id: nextCloudId++ } } });
                if (action === 'save_message') return route.fulfill({ json: { success: true, data: { message_id: 1 } } });
                return route.fulfill({ json: { success: true, data: { conversations: [], messages: [] } } });
            }
            if (url.pathname.endsWith('/harness_api.php') && request.method() === 'POST' && !action) {
                workRequest = request.postDataJSON();
                const held = new Promise(resolve => { releaseWork = resolve; });
                if (notifyWorkAdmission) { notifyWorkAdmission(); notifyWorkAdmission = null; }
                await held;
                const frames = [
                    { type: 'harness_session', session_id: 'work-fixture' },
                    { type: 'runtime_event', source: 'harness', run_id: 'work-fixture', seq: 1, turn: 1, step: 1, event: 'agent.turn.started', payload: {} },
                    { type: 'content', content: 'local Work result' },
                    { type: 'runtime_event', source: 'harness', run_id: 'work-fixture', seq: 2, turn: 1, step: 1, event: 'agent.turn.completed', payload: { content: 'local Work result' } },
                    { type: 'done', harness_session_id: 'work-fixture' }
                ];
                return route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') });
            }
            if (url.pathname.endsWith('/api.php') && request.method() === 'POST') {
                cloudWrites.push({ action: 'chat_inference', body: request.postDataJSON() });
                return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"content","content":"cloud Chat result"}\n\ndata: {"type":"done"}\n\n' });
            }
            if (request.resourceType() === 'script') return route.fulfill({ contentType: 'application/javascript', body: 'window.hljs={highlight:(text)=>({value:text}),highlightAuto:(text)=>({value:text}),highlightElement(){},configure(){}};' });
            if (request.resourceType() === 'stylesheet' || request.resourceType() === 'image') return route.fulfill({ body: '' });
            return route.fulfill({ json: { success: true, data: {}, config: { categories: { image: ['png'], document: ['txt'] }, limits: { max_files: 10, max_images: 600, max_file_size: 100000, max_image_size: 100000 } } } });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => isLoggedIn && typeof window.switchMoonYaConversationMode === 'function');
        if(process.env.MOONYA_TEST_DEBUG) console.log('TEST logged in');
        await page.evaluate(async () => {
            await initializeChatHistory();
            localStorage.setItem('api_token', 'fixture');
            isVoiceBroadcastEnabled = false;
            const project = await callPhpApi('create', 'POST', { name: 'local fixture', path: 'D:\\Fixture' });
            if (!project.success) throw new Error('local project creation failed');
            const file = new File(['full local attachment'], 'fixture.txt', { type: 'text/plain' });
            await stageWorkAttachment(file, file.name, 'document', MoonYaConversationRuntime.current());
            messageInput.value = 'Work task should stay local';
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            void sendMessage();
        });
        if(process.env.MOONYA_TEST_DEBUG) console.log('TEST submitted',await page.evaluate(()=>({id:currentChatId,mode:currentConversationMode(),contexts:[...MoonYaConversationRuntime.contexts.values()].map(r=>({id:r.chatId,key:r.harnessSessionKey,running:r.running}))})));
        await page.waitForFunction(() => window.MoonYaConversationRuntime.current().running);
        if(process.env.MOONYA_TEST_DEBUG) console.log('TEST running',await page.evaluate(()=>({id:currentChatId,mode:currentConversationMode(),contexts:[...MoonYaConversationRuntime.contexts.values()].map(r=>({id:r.chatId,key:r.harnessSessionKey,running:r.running}))})));
        await page.waitForFunction(() => window.MoonYaConversationRuntime.current().harnessSessionKey);
        assert.ok(workRequest, 'the Work request must reach its runtime gateway');
        assert.equal(workRequest.conversation_id, undefined);
        assert.equal(workRequest.local_attachments[0].text, 'full local attachment');
        assert.equal(cloudWrites.length, 0, 'starting Work must not create or save a cloud conversation');
        if(process.env.MOONYA_TEST_DEBUG) console.log('TEST switching');
        const workId = await page.evaluate(() => currentChatId);
        await page.evaluate(async () => {
            messageInput.value = 'Work-only draft';
            await switchMoonYaConversationMode('chat');
            messageInput.value = 'Chat-only draft';
        });
        releaseWork();
        await page.waitForFunction(id => !MoonYaConversationRuntime.contexts.get(id).running, workId);
        assert.equal(cloudWrites.length, 0, 'detached Work completion must not upload its history or snapshot');
        assert.equal(await page.evaluate(() => currentConversationMode()), 'chat');
        await page.evaluate(() => { messageInput.value = 'Chat task'; void sendMessage(); });
        await page.waitForFunction(() => getChatHistory().some(chat => chat.mode === 'chat' && chat.dbConversationId));
        await page.waitForFunction(() => !MoonYaConversationRuntime.current().running);
        assert.ok(cloudWrites.some(write => write.action === 'create' && write.body.mode === 'chat'));
        assert.ok(cloudWrites.some(write => write.action === 'chat_inference'));
        assert.ok(cloudWrites.every(write => !JSON.stringify(write.body).includes('Work task should stay local')
            && !JSON.stringify(write.body).includes('local Work result') && !JSON.stringify(write.body).includes('Work-only draft')));
        await page.evaluate(async () => { await switchMoonYaConversationMode('work'); });
        assert.equal(await page.evaluate(() => messageInput.value), 'Work-only draft');
        assert.equal(await page.evaluate(() => currentChatId), workId);
        const persistedWork = await page.evaluate(async id => {
            await saveCurrentChat(MoonYaConversationRuntime.contexts.get(id));
            const chat = await MoonYaHistoryStore.hydrate(CHAT_HISTORY_KEY, id);
            const attachment = await MoonYaHistoryStore.loadAttachment(CHAT_HISTORY_KEY, id, chat.attachments[0].id);
            return { mode: chat.mode, storage: chat.storage, dbId: chat.dbConversationId || null, messages: chat.messages.length,
                attachmentText: await attachment.file.text(), projects: (await callPhpApi('list', 'GET')).data.projects.length };
        }, workId);
        assert.equal(persistedWork.mode, 'work');
        assert.equal(persistedWork.storage, 'local');
        assert.equal(persistedWork.dbId, null);
        assert.ok(persistedWork.messages > 0);
        assert.equal(persistedWork.attachmentText, 'full local attachment');
        assert.equal(persistedWork.projects, 1);
        // An IndexedDB save may yield before admission. Switching modes during that wait
        // must not change the original send's mode, workspace, draft or UI owner.
        await page.evaluate(() => {
            currentChatId = null; currentDbConversationId = null;
            activateConversationRuntime(null);
            const originalSave = MoonYaHistoryStore.save;
            let intercepted = false;
            MoonYaHistoryStore.save = async function(scope, chats) {
                if (!intercepted && chats.some(chat => chat.mode === 'work' && chat.messageCount === 0)) {
                    intercepted = true;
                    await new Promise(resolve => { window.releaseDelayedHistorySave = resolve; });
                    MoonYaHistoryStore.save = originalSave;
                }
                return originalSave(scope, chats);
            };
            messageInput.value = 'Work task delayed by persistence';
            void sendMessage();
        });
        await page.waitForFunction(() => !!window.releaseDelayedHistorySave);
        await page.evaluate(async () => {
            await switchMoonYaConversationMode('chat');
            messageInput.value = 'Chat draft during delayed Work admission';
            messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            releaseDelayedHistorySave();
        });
        await page.waitForFunction(id => Array.from(MoonYaConversationRuntime.contexts.values())
            .some(runtime => runtime.mode === 'work' && runtime.chatId !== id && runtime.harnessSessionKey), workId);
        assert.equal(workRequest.message, 'Work task delayed by persistence');
        releaseWork();
        await page.waitForFunction(() => Array.from(MoonYaConversationRuntime.contexts.values()).every(runtime => !runtime.running));
        assert.equal(await page.evaluate(() => currentConversationMode()), 'chat');
        assert.equal(await page.evaluate(() => messageInput.value), 'Chat draft during delayed Work admission');
        assert.ok(cloudWrites.every(write => !JSON.stringify(write.body).includes('Work task delayed by persistence')));
        const quotaAdmission = new Promise(resolve => { notifyWorkAdmission = resolve; });
        await page.evaluate(async () => {
            await switchMoonYaConversationMode('work');
            const originalTransaction = IDBDatabase.prototype.transaction;
            const originalSetItem = Storage.prototype.setItem;
            IDBDatabase.prototype.transaction = function(names, mode) {
                const tx = originalTransaction.call(this, names, mode);
                if (mode === 'readwrite') queueMicrotask(() => tx.abort());
                return tx;
            };
            Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
            window.restoreStorageWriters = () => { IDBDatabase.prototype.transaction = originalTransaction; Storage.prototype.setItem = originalSetItem; };
            messageInput.value = 'Work sends despite local cache failure';
            void sendMessage();
        });
        await quotaAdmission;
        assert.equal(workRequest.message, 'Work sends despite local cache failure');
        releaseWork();
        await page.waitForFunction(() => !MoonYaConversationRuntime.current().running);
        assert.equal(await page.evaluate(() => !!document.getElementById('historySaveWarning')), true);
        assert.equal(await page.evaluate(async () => { restoreStorageWriters(); return MoonYaHistoryStore.retry(CHAT_HISTORY_KEY); }), true);
        assert.ok(cloudWrites.every(write => !JSON.stringify(write.body).includes('Work sends despite local cache failure')));
        assert.deepEqual(errors, []);
    } finally {
        if (releaseWork) releaseWork();
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
