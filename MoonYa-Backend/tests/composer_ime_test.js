'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modules = path.join(__dirname, '../../MoonYa-Frontend/src/modules');
const composerSource = fs.readFileSync(path.join(modules, 'script-1d-dom.js'), 'utf8');
const composer = composerSource.slice(composerSource.indexOf('        // 输入框回车发送'),
    composerSource.indexOf('        // 输入框自动调整高度和字数限制'));
const pttSource = fs.readFileSync(path.join(modules, 'script-3-push-to-talk.js'), 'utf8');
const ptt = pttSource.slice(pttSource.indexOf('    function isSpaceKey(e)'), pttSource.indexOf('    function onKeyUp(e)'));

function fixture() {
    const input = new EventTarget();
    Object.assign(input, { value: '你好', selectionStart: 0, selectionEnd: 0 });
    const calls = { send: 0, stop: 0, skills: 0, voiceSend: 0, voiceCancel: 0, record: 0 };
    const scope = {
        messageInput: input, selectedSkills: ['skill'], uploadedImages: [], localPathSelections: [], currentAbortController: null,
        MoonYaAttachments: { canSend: (text, uploads, paths) => !!(text.trim() || uploads.length || paths.length) },
        window: { isSendingMessage: false, stopCurrentMoonYaResponse: () => calls.stop++ },
        document: { querySelectorAll: () => [], getElementById: () => null,
            querySelector: () => ({ style: {} }) },
        renderSelectedSkills: () => calls.skills++, sendMessage: () => calls.send++,
        console: { debug() {}, log() {}, warn() {} }, Date,
        enabled: true, isIMEActive: false, pttCooldownUntil: 0, _inputFocused: true,
        PTT_STATE: { CONFIRMING: 'confirming', IDLE: 'idle', RECORDING: 'recording' },
        PTT_MODE: { TOGGLE: 'toggle' }, mode: 'toggle', state: 'confirming',
        getMessageInput: () => input, onConfirmSend: () => calls.voiceSend++,
        onCancel: () => calls.voiceCancel++, startRecording: () => calls.record++
    };
    vm.createContext(scope);
    vm.runInContext(composer, scope);
    vm.runInContext(ptt, scope);
    function key(properties, voice = false) {
        const event = new Event('keydown', { cancelable: true });
        Object.assign(event, { key: 'Enter', shiftKey: false, ctrlKey: false, keyCode: 13, isComposing: false }, properties);
        if (voice) scope.onKeyDown(event);
        else input.dispatchEvent(event);
        return event;
    }
    return { input, scope, calls, key };
}

test('composition Enter does not send or stop a response, ordinary Enter still works', () => {
    for (const properties of [{ isComposing: true }, { keyCode: 229 }, {}]) {
        const f = fixture();
        if (Object.keys(properties).length === 0) f.input.dispatchEvent(new Event('compositionstart'));
        assert.equal(f.key(properties).defaultPrevented, false);
        assert.equal(f.calls.send, 0);
        f.scope.window.isSendingMessage = true;
        assert.equal(f.key(properties).defaultPrevented, false);
        assert.equal(f.calls.stop, 0);
        f.input.dispatchEvent(new Event('compositionend'));
        f.scope.window.isSendingMessage = false;
        assert.equal(f.key({}).defaultPrevented, true);
        assert.equal(f.calls.send, 1);
        f.scope.window.isSendingMessage = true;
        f.key({});
        assert.equal(f.calls.stop, 1);
    }
});

test('composition owns candidate navigation and Backspace; blur clears stale composition state', () => {
    const f = fixture();
    f.input.dispatchEvent(new Event('compositionstart'));
    f.input.value = '/';
    f.scope.document.getElementById = () => ({ classList: { contains: () => true } });
    assert.equal(f.key({ key: 'ArrowDown' }).defaultPrevented, false);
    assert.equal(f.key({ key: 'ArrowUp' }).defaultPrevented, false);
    f.input.value = '';
    assert.equal(f.key({ key: 'Backspace' }).defaultPrevented, false);
    assert.equal(f.scope.selectedSkills.length, 1);
    f.input.dispatchEvent(new Event('blur'));
    f.key({ key: 'Backspace' });
    assert.equal(f.scope.selectedSkills.length, 0);
    assert.equal(f.calls.skills, 1);
});

test('voice confirmation and cooldown do not consume IME keys', () => {
    for (const properties of [{ isComposing: true }, { keyCode: 229 }, {}]) {
        const f = fixture();
        if (Object.keys(properties).length === 0) f.scope.isIMEActive = true;
        assert.equal(f.key(properties, true).defaultPrevented, false);
        assert.equal(f.calls.voiceSend, 0);
        assert.equal(f.key({ ...properties, key: 'Escape' }, true).defaultPrevented, false);
        assert.equal(f.calls.voiceCancel, 0);
        f.scope.pttCooldownUntil = Date.now() + 3000;
        assert.equal(f.key({ ...properties, key: ' ', code: 'Space', ctrlKey: true }, true).defaultPrevented, false);
        f.scope.isIMEActive = false;
        assert.equal(f.key({}, true).defaultPrevented, true);
        assert.equal(f.calls.voiceSend, 1);
    }
});
