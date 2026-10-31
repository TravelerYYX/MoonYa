'use strict';

/**
 * 认证界面契约测试。
 *
 * 回归目标：修复「点击登录 → 登录成功、对话已出现，但侧边栏登录区仍显示未登录」。
 *
 * 根因（2026-09-14 线上 cef.log / webconsole.log 实证）：
 *   finishAuthentication() 的 try 块第一句是
 *       if (window.MoonYaOffice) window.MoonYaOffice.setAuthenticated(true);
 *   而 window.MoonYaOffice 由 script-5-office.php 定义为 {open, close, isOpen, layout}，
 *   并不存在 setAuthenticated。于是抛 TypeError: setAuthenticated is not a function，
 *   try 块内后续所有界面更新（userName / userQQ / qqLoginBtn / closeAuthModal）全部被跳过，
 *   而 showToast 与 refreshChatAfterAuthentication 在 try 之外仍然执行 ——
 *   正好表现为「提示登录成功、对话出来了，但登录区仍显示未登录」。
 *   checkUserSession() 同样受影响：会话校验明明成功，却走进 catch 分支把 isLoggedIn 置回 false。
 *
 * 本测试用最小 DOM 桩加载真实源码中的 renderAuthState / finishAuthentication / syncOfficeAuthState，
 * 覆盖：旧桥接缺方法、桥接抛异常、未登录渲染、桥接存在时的正常调用。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function makeEl(id) {
    return {
        id,
        textContent: id === 'userName' ? '未登录' : '',
        src: '/icon.png',
        style: { display: '' },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        querySelectorAll() { return []; },
        setAttribute() {},
        dataset: {}
    };
}

// 从源码中按名字截取一个函数声明（含嵌套大括号），避免把整个脚本块拖进 vm 执行。
// 保留 async 前缀，否则 async 函数的 await 会在 vm 中报语法错误。
function grabFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert(start !== -1, 'function not found in source: ' + name);
    const asyncPrefix = source.slice(Math.max(0, start - 6), start) === 'async '
        ? start - 6
        : start;
    let depth = 0;
    let index = source.indexOf('{', start);
    for (; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) break;
        }
    }
    return source.slice(asyncPrefix, index + 1);
}

function buildHarness(officeBridgeFactory) {
    const els = {
        userName: makeEl('userName'),
        userQQ: makeEl('userQQ'),
        qqLoginBtn: makeEl('qqLoginBtn'),
        userAvatar: makeEl('userAvatar'),
        avatarPlaceholder: makeEl('avatarPlaceholder')
    };
    const storage = {};
    const sandbox = {
        console,
        document: {
            getElementById: (id) => els[id] || null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            createElement: () => makeEl('tmp'),
            // classList.toggle 是 renderAuthState → applyGuestCapabilityState 会用到的最小能力。
            body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
            readyState: 'complete'
        },
        // renderAuthState 结尾会派发 moonya:auth-state 事件；最小桩保证契约测试可执行。
        Event: class { constructor(type) { this.type = type; } },
        window: { dispatchEvent() {} },
        localStorage: {
            getItem: (key) => (key in storage ? storage[key] : null),
            setItem: (key, value) => { storage[key] = String(value); },
            removeItem: (key) => { delete storage[key]; }
        },
        fetch: () => Promise.reject(new Error('network disabled in contract test')),
        setTimeout, clearTimeout, setInterval, clearInterval
    };
    sandbox.globalThis = sandbox;
    // 桥接故意保持与线上一致：只有办公视图方法，没有 setAuthenticated。
    sandbox.window.MoonYaOffice = officeBridgeFactory();

    const sourcePath = path.join(__dirname, '../../MoonYa-Frontend/src', 'modules', 'script-1d-dom.js');
    const source = fs.readFileSync(sourcePath, 'utf8');

    const exposed = { current: null };
    sandbox.__expose = (value) => { exposed.current = value; };

    const bootstrap = [
        'let isLoggedIn = false;',
        'let currentUser = null;',
        'let CHAT_HISTORY_KEY = "chat_history";',
        'const userName = document.getElementById("userName");',
        'const userQQ = document.getElementById("userQQ");',
        'const qqLoginBtn = document.getElementById("qqLoginBtn");',
        'const userAvatar = document.getElementById("userAvatar");',
        'const avatarPlaceholder = document.getElementById("avatarPlaceholder");',
        'let closeAuthModalCalls = 0;',
        'function closeAuthModal() { closeAuthModalCalls += 1; }',
        'const toastMessages = [];',
        'function showToast(message) { toastMessages.push(message); }',
        'function refreshChatAfterAuthentication() {}',
        grabFunction(source, 'syncOfficeAuthState'),
        // renderAuthState 会同步未登录能力态（内置模型 / 语音播报置灰）。
        grabFunction(source, 'applyGuestCapabilityState'),
        grabFunction(source, 'renderAuthState'),
        grabFunction(source, 'finishAuthentication'),
        grabFunction(source, 'checkUserSession'),
        '__expose({',
        '  finishAuthentication: finishAuthentication,',
        '  renderAuthState: renderAuthState,',
        '  checkUserSession: checkUserSession,',
        '  els: document.__els,',
        '  get isLoggedIn() { return isLoggedIn; },',
        '  get currentUser() { return currentUser; },',
        '  get chatHistoryKey() { return CHAT_HISTORY_KEY; },',
        '  get closeCalls() { return closeAuthModalCalls; },',
        '  get toasts() { return toastMessages; }',
        '});'
    ].join('\n');

    sandbox.document.__els = els;
    vm.createContext(sandbox);
    vm.runInContext(bootstrap, sandbox, { filename: sourcePath });

    // 保留 vm 内的活对象（含 getter），不要解构复制，否则会冻结瞬时值。
    return { exposed: exposed.current, els, storage, sandbox };
}

// ── 用例 1：旧桥接（无 setAuthenticated）下登录成功，侧边栏必须立即反映登录态 ──
{
    const harness = buildHarness(() => ({
        open() {}, close() {}, isOpen() { return false; }, layout() {}
    }));
    const t = harness.exposed;

    t.finishAuthentication(
        { token: 'token-abc', expires_in: 1296000, user: { id: 7, username: 'tao', real_name: '陶渊明' } },
        '登录成功',
        () => {}
    );

    assert(t.els.userName.textContent === '陶渊明', '登录后侧边栏用户名应更新为 real_name');
    assert(t.els.userQQ.textContent === '账号: tao', '登录后应显示账号');
    assert(t.els.qqLoginBtn.style.display === 'none', '登录后「登陆」按钮应隐藏');
    assert(t.isLoggedIn === true, '登录后 isLoggedIn 应为 true');
    assert(t.currentUser && t.currentUser.id === 7, '登录后 currentUser 应写入');
    // 本地历史整机共享：登录不再把 scope 切到用户维度（2026-10-03 起）。
    assert(t.chatHistoryKey === 'chat_history', '登录后对话历史 key 应保持全局共享，不随账号变化');
    assert(t.closeCalls === 1, '登录成功后应关闭登录弹窗');
    assert(harness.storage.api_token === 'token-abc', '登录成功后应持久化 api_token');
    assert(t.toasts.includes('登录成功'), '应提示登录成功');
}

// ── 用例 2：未登录渲染应回到初始文案 ──
{
    const harness = buildHarness(() => ({ open() {}, close() {}, isOpen() { return false; }, layout() {} }));
    const t = harness.exposed;
    t.renderAuthState(null);
    assert(t.els.userName.textContent === '未登录', '未登录时用户名应为「未登录」');
    assert(t.els.qqLoginBtn.style.display === '', '未登录时「登陆」按钮应可见');
    assert(t.isLoggedIn === false, '未登录时 isLoggedIn 应为 false');
    assert(t.currentUser === null, '未登录时 currentUser 应为 null');
    assert(t.chatHistoryKey === 'chat_history', '未登录时对话历史 key 仍为全局共享 scope');
}

// ── 用例 3：桥接提供 setAuthenticated 时应被正确调用 ──
{
    const calls = [];
    const harness = buildHarness(() => ({
        open() {}, close() {}, isOpen() { return false; }, layout() {},
        setAuthenticated(value) { calls.push(value); }
    }));
    const t = harness.exposed;
    t.renderAuthState({ id: 9, username: 'u9' });
    t.renderAuthState(null);
    assert(calls.length === 2 && calls[0] === true && calls[1] === false,
        '桥接存在时应按登录态收到 true 后 false，实际: ' + JSON.stringify(calls));
}

// ── 用例 4：桥接抛异常不得影响登录界面渲染（防止同类问题再次中断 UI 更新） ──
{
    const harness = buildHarness(() => ({
        open() {}, close() {}, isOpen() { return false; }, layout() {},
        setAuthenticated() { throw new Error('bridge failure'); }
    }));
    const t = harness.exposed;
    t.finishAuthentication(
        { token: 'x', expires_in: 1, user: { id: 3, username: 'u3', real_name: 'U3' } },
        '登录成功',
        () => {}
    );
    assert(t.els.userName.textContent === 'U3', '桥接抛错时用户名仍应更新');
    assert(t.els.qqLoginBtn.style.display === 'none', '桥接抛错时「登陆」按钮仍应隐藏');
}

// ── 用例 5：会话校验请求失败不得擦除已有登录态（刷新抖动防护） ──
{
    const harness = buildHarness(() => ({ open() {}, close() {}, isOpen() { return false; }, layout() {} }));
    const t = harness.exposed;
    // 先建立登录态（fetch 在测试桩里始终 reject，模拟网络抖动）
    t.renderAuthState({ id: 11, username: 'u11', real_name: 'U11' });
    assert(t.isLoggedIn === true, '前置：应为已登录');

    return Promise.resolve(t.checkUserSession()).then(() => {
        assert(t.isLoggedIn === true, '会话校验请求失败时不应把登录态擦成未登录');
        assert(t.els.userName.textContent === 'U11', '会话校验失败时侧边栏应保留用户名');

        // 用例 6：确认未登录时仍能正确回退
        t.renderAuthState(null);
        return t.checkUserSession();
    }).then(() => {
        assert(t.isLoggedIn === false, '未登录且校验失败时应保持未登录');
        assert(t.els.userName.textContent === '未登录', '未登录时侧边栏应为「未登录」');

        // ── 用例 7：源码静态约束 —— 登录界面渲染不得再被裸调用的桥接方法挡住 ──
        const sourcePath = path.join(__dirname, '../../MoonYa-Frontend/src', 'modules', 'script-1d-dom.js');
        const source = fs.readFileSync(sourcePath, 'utf8');
        assert(!/if \(window\.MoonYaOffice\) window\.MoonYaOffice\.setAuthenticated\(/.test(source),
            '不应再使用未做类型检查的 setAuthenticated 裸调用');
        assert(/typeof window\.MoonYaOffice\.setAuthenticated === 'function'/.test(source),
            'syncOfficeAuthState 应显式做方法存在性检查');
        assert(/function renderAuthState\(/.test(source),
            '应存在统一的 renderAuthState 供会话校验与登录回执共用');

        const officePath = path.join(__dirname, '../../MoonYa-Frontend/src', 'modules', 'script-5-office.js');
        const officeSource = fs.readFileSync(officePath, 'utf8');
        assert(/setAuthenticated:\s*setAuthenticated/.test(officeSource),
            '办公视图桥接应导出 setAuthenticated，与调用方契约保持一致');
        assert(/window\.closeOfficeMode\s*=\s*close/.test(officeSource),
            '办公视图应导出 closeOfficeMode（script-1c-save 加载历史时依赖）');

        process.stdout.write('auth ui contract: PASS\n');
    }).catch((error) => {
        process.stderr.write('auth ui contract: FAIL - ' + error.message + '\n');
        process.exitCode = 1;
    });
}
