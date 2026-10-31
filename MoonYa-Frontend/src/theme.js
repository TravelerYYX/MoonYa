/* Loaded in <head> so the cached theme is applied before the first paint. */
(function () {
    'use strict';
    const key = 'moonya.theme.v1';
    const valid = value => ['light', 'dark', 'system'].includes(value);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let preference = 'system', nativeTheme = null, bridge = null, revision = 0;
    let writes = Promise.resolve();
    try { const saved = localStorage.getItem(key); if (valid(saved)) preference = saved; } catch (_) {}
    function cache() { try { localStorage.setItem(key, preference); } catch (_) {} }
    function systemFromState(state) {
        return ['light', 'dark'].includes(state.systemTheme) ? state.systemTheme :
            state.preference === 'system' ? state.resolved : (media.matches ? 'dark' : 'light');
    }
    function apply() {
        const resolved = preference === 'system' ? (nativeTheme || (media.matches ? 'dark' : 'light')) : preference;
        const root = document.documentElement;
        root.dataset.theme = resolved;
        root.dataset.themePreference = preference;
        root.style.colorScheme = resolved;
        window.dispatchEvent(new CustomEvent('moonya:theme-change', { detail: { preference, resolved } }));
    }
    function acceptNative(state) {
        if (!state || !valid(state.preference) || !['light', 'dark'].includes(state.resolved)) return;
        preference = state.preference;
        nativeTheme = systemFromState(state);
        cache(); apply();
    }
    function persistNative(value) {
        const target = bridge;
        // Serialize writes: rapid clicks must finish in the same order as the UI.
        writes = writes.then(() => target.setPreference(value)).catch(error => {
            console.warn('MoonYa theme preference could not be saved:', error);
            if (typeof window.showToast === 'function') window.showToast('主题已切换，客户端偏好保存失败');
        });
    }
    window.MoonYaTheme = Object.freeze({
        getPreference: () => preference,
        getResolvedTheme: () => document.documentElement.dataset.theme,
        setPreference(value) {
            if (!valid(value)) return false;
            revision++; preference = value; cache(); apply();
            if (bridge) persistNative(value);
            return true;
        },
        // Called by the trusted native host when the Windows appearance changes.
        acceptNativeSystemTheme(value) {
            if (!['light', 'dark'].includes(value)) return;
            nativeTheme = value;
            if (preference === 'system') apply();
        }
    });
    media.addEventListener('change', () => { if (preference === 'system' && !bridge) apply(); });
    window.addEventListener('storage', event => {
        if (event.key !== key || bridge) return;
        preference = valid(event.newValue) ? event.newValue : 'system'; apply();
    });
    apply();
    async function connect() {
        if (!window.CefSharp?.BindObjectAsync) return;
        const initialRevision = revision;
        try {
            await window.CefSharp.BindObjectAsync('moonYaTheme');
            const target = window.moonYaTheme;
            if (!target) return;
            const state = JSON.parse(await target.getState());
            bridge = target;
            if (initialRevision === revision) acceptNative(state);
            else {
                nativeTheme = systemFromState(state);
                apply(); persistNative(preference);
            }
        } catch (error) { console.warn('MoonYa native theme connection unavailable:', error); }
    }
    // CEF bindings become available after the main document has been created.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect, { once: true });
    else void connect();
})();
