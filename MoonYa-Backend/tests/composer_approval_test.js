const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', '..');
const playwrightPath = process.env.PLAYWRIGHT_MODULE || path.join(root, '.workbuddy/pwtest/node_modules/playwright-core');
const { chromium } = require(playwrightPath);
const source = fs.readFileSync(path.join(root, 'MoonYa-Frontend/src/modules/script-1e-rest.js'), 'utf8');
const controller = source.slice(source.indexOf('        let composerApprovalTimer = null;'), source.indexOf('        function artifactSvgMarkup('));
const logRenderer = source.slice(source.indexOf('        function renderTeamApprovalLog('), source.indexOf('        const userActionUiState'));
const cssSource = fs.readFileSync(path.join(root, 'MoonYa-Frontend/src/styles/css-16-agent-experience.css'), 'utf8');
const css = cssSource.slice(cssSource.indexOf('        .composer-approval-host[hidden]'), cssSource.indexOf('        .user-action-card {'));
const setup = `
window.currentChatId = 'chat-a'; window.currentDbConversationId = null;
window.teamUiState = { approvals: new Map() };
window.testNow = Date.now(); Date.now = () => window.testNow;
window.serverEvents = []; window.serverStatus = 'running'; window.serverSeq = 0; window.posts = []; window.sharedEvents = [];
window.contexts = { 'chat-a': { chatId: 'chat-a', dbConversationId: null, mode: 'work' }, 'chat-b': { chatId: 'chat-b', dbConversationId: null, mode: 'work' } };
window.getConversationRuntime = id => contexts[id || currentChatId];
window.getChatHistory = () => [{ id: 'chat-a', mode: 'work', runtimeSessions: { '__default__': 'session-a' } }, { id: 'chat-b', mode: 'work' }];
window.renderTeamPlainText = (node, text) => node.textContent = text;
window.getAuthHeaders = () => ({});
window.ensureStopButtonVisible = () => {};
window.resetSendButton = () => {};
window.browserPermissionRequest = () => Promise.resolve({});
window.MoonYaSharedRuntime = { streamEvent: event => { sharedEvents.push(event); return Promise.resolve(); }, request: () => Promise.resolve() };
window.ensureTeamLogNode = (event, key) => {
  let node = document.getElementById(key);
  if (!node) { node = document.createElement('article'); node.id = key;
    node.innerHTML = '<span class="team-event-kind"></span><div class="team-event-summary"></div>';
    document.getElementById('detailPanelContent').appendChild(node); }
  return node;
};
window.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    const body = JSON.parse(options.body); posts.push(body);
    if (window.failDecision) return { json: async () => ({ success: false, error: '暂时失败，请重试' }) };
    const status = body.decision.startsWith('allow') ? 'allowed' : 'denied';
    serverEvents.push({ event: 'approval.decided', payload: { approval_id: body.approval_id, status } });
    return { json: async () => ({ success: true, status }) };
  }
  return { json: async () => ({ success: true, data: { events: serverEvents, status: serverStatus, seq: serverSeq } }) };
};
window.addApproval = (id, seconds = 600, overrides = {}) => {
  const event = Object.assign({ source: 'harness', run_id: 'session-a', conversation_id: null, chat_id: 'chat-a', project_path: '',
    event: 'approval.required', timestamp: new Date(testNow).toISOString(), payload: { id, status: 'pending', tool_key: 'execute_command',
    expires_at: new Date(testNow + seconds * 1000).toISOString(), allowed_decisions: ['allow_once', 'deny'],
    reason: '这是演示命令，用来触发授权；不会修改任何文件。', arguments: { intent: '展示授权申请', command: 'Write-Output "演示命令"' } } }, overrides);
  if (!serverEvents.some(e => e.payload.id === id)) serverEvents.push(event);
  handleTeamApproval(event); return event;
};
`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
    await page.route('http://approval.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>
      body{margin:24px;font-family:"Microsoft YaHei",sans-serif}.input-container-wrapper{max-width:1000px;margin:auto}.messages-container{min-height:10px}
      .input-container{border:1px solid #ddd;border-radius:22px;padding:20px}#detailPanelContent{margin-top:24px;color:#555;font-size:12px}article{padding:8px;border-bottom:1px solid #eee}
      ${css}</style><div class="messages-container"></div><div class="input-container-wrapper"><div class="work-project-bar">工作目录</div>
      <section id="composerApprovalHost" hidden></section><section class="user-action-card" hidden></section>
      <div class="input-container"><textarea id="draft">尚未发送的草稿</textarea><div id="uploadContainer">附件保留</div></div></div><div id="detailPanelContent"></div>` }));
    await page.goto('http://approval.test/');
    await page.addScriptTag({ content: setup + logRenderer + controller });
    await page.evaluate(() => addApproval('first'));
    assert.equal(await page.locator('#composerApprovalHost .composer-approval-card').count(), 1);
    assert.equal(await page.locator('.input-container').isVisible(), false);
    assert.equal(await page.locator('.composer-approval-countdown').isVisible(), false);
    assert.equal(await page.locator('.messages-container').innerText(), '');
    const screenshotDir = path.join(root, 'artifacts', 'approval-fix');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'desktop.png') });
    await page.evaluate(() => { addApproval('second'); addApproval('first'); testNow += 540000; syncComposerApproval(); });
    assert.equal(await page.locator('#composerApprovalHost .composer-approval-card').count(), 1);
    assert.equal(await page.locator('.composer-approval-countdown').innerText(), '60秒');
    await page.evaluate(() => { testNow += 17000; syncComposerApproval(); });
    assert.equal(await page.locator('.composer-approval-countdown').innerText(), '43秒');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(screenshotDir, 'mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'narrow screen must not overflow');
    await page.evaluate(() => { window.failDecision = true; });
    await page.locator('[data-decision="allow_once"]').click();
    await page.waitForFunction(() => document.querySelector('.composer-approval-error').textContent.includes('暂时失败'));
    assert.match(await page.locator('.composer-approval-reason').innerText(), /不会修改任何文件/);
    assert.equal(await page.locator('[data-decision="allow_once"]').isEnabled(), true);
    await page.evaluate(() => { window.failDecision = false;
      const button = document.querySelector('[data-decision="allow_once"]'); button.click(); button.click(); });
    await page.waitForFunction(() => document.querySelector('#composerApproval-second'));
    assert.equal(await page.evaluate(() => posts.length), 2, 'double-click must send only one retry');
    await page.locator('[data-decision="deny"]').click();
    await page.waitForFunction(() => document.getElementById('composerApprovalHost').hidden);
    assert.equal(await page.locator('.input-container').isVisible(), true);
    assert.equal(await page.locator('#draft').inputValue(), '尚未发送的草稿');
    assert.equal(await page.locator('#uploadContainer').innerText(), '附件保留');
    assert.match(await page.locator('#detailPanelContent').innerText(), /已允许本次调用/);
    assert.match(await page.locator('#detailPanelContent').innerText(), /已拒绝本次调用/);
    assert.equal(await page.locator('.messages-container .composer-approval-card').count(), 0);
    // Conversation switches hide the old card, restore the original absolute deadline.
    await page.evaluate(() => { addApproval('switch'); currentChatId = 'chat-b'; currentDbConversationId = null; syncComposerApproval(); });
    assert.equal(await page.locator('#composerApprovalHost').isVisible(), false);
    await page.evaluate(() => { currentChatId = 'chat-a'; currentDbConversationId = null; syncComposerApproval(); });
    assert.equal(await page.locator('#composerApproval-switch').isVisible(), true);
    await page.evaluate(() => { settleComposerApprovals('session-a', 'cancelled'); });
    assert.equal(await page.locator('#composerApprovalHost').isVisible(), false);
    assert.equal(await page.evaluate(() => composerApprovalTimer), null);
    // Simulate reload: discard local records, recover pending from a server snapshot.
    await page.evaluate(async () => {
      serverEvents = []; addApproval('restored', 45); teamUiState.approvals.clear(); syncComposerApproval();
      await refreshComposerApprovals();
    });
    assert.equal(await page.locator('#composerApproval-restored').isVisible(), true);
    assert.equal(await page.locator('.composer-approval-countdown').innerText(), '45秒');
    await page.evaluate(() => { testNow += 45000; syncComposerApproval(); });
    assert.equal(await page.locator('[data-decision="allow_once"]').isEnabled(), false);
    await page.evaluate(async () => {
      serverEvents.push({ event: 'approval.decided', payload: { approval_id: 'restored', status: 'expired' } });
      await refreshComposerApprovals();
    });
    assert.equal(await page.locator('#composerApprovalHost').isVisible(), false);
    assert.equal(await page.evaluate(() => composerApprovalTimer), null);
    // A late HTTP snapshot must not discard a newer SSE approval.
    await page.evaluate(async () => {
      serverEvents = []; addApproval('newer-sse', 600, { seq: 50 });
      serverEvents = []; serverSeq = 49;
      await refreshComposerApprovals();
    });
    assert.equal(await page.locator('#composerApproval-newer-sse').isVisible(), true, 'stale snapshot must not expire a newer approval');
    await page.evaluate(() => settleComposerApprovals('session-a', 'cancelled'));
    assert.equal(await page.evaluate(() => approvalStatePoll), null, 'settlement must clear the polling timer');
    assert.equal(await page.evaluate(() => sharedEvents.length), 0, 'Work approvals must remain local');
    // A root snapshot carries child identity so refresh submits the decision to the employee.
    await page.evaluate(async () => {
      serverEvents = []; serverSeq = 100;
      addApproval('child-restored', 600, { run_id: 'child-session', root_run_id: 'session-a', seq: 100 });
      teamUiState.approvals.clear(); syncComposerApproval(); await refreshComposerApprovals();
    });
    assert.equal(await page.locator('#composerApproval-child-restored').isVisible(), true);
    await page.locator('[data-decision="deny"]').click();
    await page.waitForFunction(() => document.getElementById('composerApprovalHost').hidden);
    assert.equal(await page.evaluate(() => posts.at(-1).session_id), 'child-session');
    await page.evaluate(() => { addApproval('child-stop', 600, { run_id: 'child-session', root_run_id: 'session-a' }); settleComposerApprovals('session-a', 'cancelled'); });
    assert.equal(await page.locator('#composerApprovalHost').isVisible(), false);
    console.log('composer approval browser tests: PASS (queue, countdown, failure/retry, duplicate, drafts, switch, reload, expiry, desktop/mobile)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
