/* Permission preferences are account-scoped; chat choices live in chat drafts. */
(() => {
    'use strict';
    const labels = { confirm_writes: '请求批准', high_risk: '帮我批准', full_access: '完全访问权限' };
    const normalize = value => {
        const mode = ({ always_confirm_changes: 'confirm_writes', high_risk_only: 'high_risk' })[value] || value;
        return Object.hasOwn(labels, mode) ? mode : 'confirm_writes';
    };
    const key = () => 'moonya.default-permission.' + (window.currentUser?.id || window.MoonYaClient?.cachedUser?.()?.id || 'guest');
    window.MoonYaPermissions = {
        labels, normalize,
        defaultMode() { try { return normalize(localStorage.getItem(key())); } catch { return 'confirm_writes'; } },
        setDefault(value) {
            const mode = normalize(value);
            localStorage.setItem(key(), mode);
            window.dispatchEvent(new CustomEvent('moonya:default-permission', { detail: { mode } }));
            return mode;
        }
    };
})();
