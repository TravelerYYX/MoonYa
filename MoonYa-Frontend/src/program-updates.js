(function () {
    'use strict';
    const button = document.getElementById('programUpdateButton');
    if (!button || !window.MoonYaHost?.gatewayToken) return;
    const percent = button.querySelector('.program-update-percent');
    const arc = button.querySelector('.program-update-arc');
    const circumference = 2 * Math.PI * 10;
    let status = null, busy = false, timer;
    let modalKey = '';
    window.MoonYaUpdateRequired = false;
    window.MoonYaCanStartTask = () => !window.MoonYaUpdateRequired;
    async function request(action, method = 'GET') {
        const response = await fetch('/gateway/updates/' + action, {method, headers:{'X-MoonYa-Gateway':MoonYaHost.gatewayToken}});
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || '更新服务暂时不可用');
        return result.data;
    }
    function render(value) {
        status = value;
        const required = !!value.update_required;
        const changed = window.MoonYaUpdateRequired !== required;
        window.MoonYaUpdateRequired = required;
        const dialog = window.MoonYaSystemDialog;
        if (required && value.release) {
            const key = JSON.stringify([value.state,value.percent,value.release,value.error,busy]);
            if (key !== modalKey || dialog.kind !== 'update') {
                modalKey = key;
                dialog.show('update','需要更新 MoonYa',host => {
                    const copy = document.createElement('p'); copy.textContent = '当前版本 ' + value.current_version + '，请升级到 ' + value.release.version + ' 后继续使用。\n\n' + value.release.notes;
                    const progress = document.createElement('progress'); progress.className = 'system-update-progress'; progress.max = 100; progress.value = value.percent; progress.setAttribute('aria-label','更新下载进度');
                    host.append(copy,progress);
                },[{text:value.state === 'ready' ? '安装更新' : value.state === 'error' ? '重试下载' : value.state === 'installing' ? '正在准备安装' : value.state === 'verifying' ? '正在校验安装程序' : '正在下载 ' + value.percent + '%',disabled:busy || !['ready','error'].includes(value.state),run:performAction}]);
                if (value.error) dialog.setStatus(value.error);
            }
        } else if (dialog.kind === 'update') { modalKey = ''; dialog.hide(); }
        if (changed) window.dispatchEvent(new Event('moonya:update-required'));
        button.hidden = !value.release;
        if (!value.release) return;
        const ready = value.state === 'ready';
        const text = ready ? '安装更新' : value.state === 'verifying' ? '正在校验安装程序' : value.state === 'installing' ? '正在准备安装' : value.state === 'error' ? '点击重试下载' : '正在下载更新';
        button.dataset.state = value.state;
        percent.textContent = Math.min(99, Math.max(0, value.percent)) + '%';
        arc.style.strokeDashoffset = String(circumference * (1 - Math.min(100, Math.max(0, value.percent)) / 100));
        button.setAttribute('aria-label', text + ' ' + value.release.version + (ready ? '' : '，' + percent.textContent));
        button.dataset.tooltip = text + ' · ' + value.release.version + '\n' + value.release.notes + (value.error ? '\n' + value.error : '');
        button.disabled = busy || value.state === 'installing';
    }
    async function poll() {
        try { render(await request('status')); } catch (_) { /* Startup/offline transient: retain the last durable state. */ }
    }
    async function performAction() {
        if (busy || !status || !['ready','error'].includes(status.state)) return;
        busy = true; render(status);
        try { await request(status.state === 'ready' ? 'install' : 'retry', 'POST'); }
        catch (error) { if (window.MoonYaUpdateRequired) window.MoonYaSystemDialog.setStatus(error.message); else window.MoonYaNotifications?.show(error.message, {duration:6000}); button.dataset.tooltip = error.message; }
        finally { busy = false; await poll(); }
    }
    button.addEventListener('click', performAction);
    poll(); timer = setInterval(poll, 1000);
    window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
    window.addEventListener('pageshow', event => { if (event.persisted) { poll(); timer = setInterval(poll, 1000); } });
})();
