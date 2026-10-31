/* Shared by the composer, settings and speech confirmation. */
(() => {
    'use strict';
    const key = 'moonya.sendShortcut';
    const enter = 'Enter 发送';
    const ctrlEnter = 'Ctrl + Enter 发送';
    function get() {
        try { return localStorage.getItem(key) === ctrlEnter ? ctrlEnter : enter; }
        catch { return enter; }
    }
    function set(value) {
        localStorage.setItem(key, value === ctrlEnter ? ctrlEnter : enter);
        window.dispatchEvent(new Event('moonya:send-shortcut-change'));
    }
    function matches(event) {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229
            || event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey) return false;
        return get() === ctrlEnter ? event.ctrlKey === true : !event.ctrlKey;
    }
    window.MoonYaSendShortcut = { get, set, matches };
})();
