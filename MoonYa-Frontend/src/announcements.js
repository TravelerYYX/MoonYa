(function () {
    'use strict';
    if (!window.MoonYaHost?.gatewayToken) return;
    let feed = [], read = {}, current = null, fetching = false, acknowledging = false, stopped = false, timer, waiting;
    const dialog = window.MoonYaSystemDialog;
    async function request(action, body) {
        const response = await fetch('/gateway/announcements/' + action, {method:body ? 'POST' : 'GET', headers:{'X-MoonYa-Gateway':MoonYaHost.gatewayToken,'Content-Type':'application/json'},body:body ? JSON.stringify(body) : undefined});
        const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error || '公告暂时不可用'); return result.data;
    }
    function advance() {
        clearTimeout(waiting);
        if (stopped || window.MoonYaUpdateRequired || dialog.kind === 'update' || acknowledging) return;
        if (current && !feed.some(item => item.id === current.id && item.revision === current.revision)) { current = null; if (dialog.kind === 'announcement') dialog.hide(); }
        if (dialog.kind === 'announcement' && current) return;
        if (dialog.kind || [...document.querySelectorAll('.membership-overlay, [role=dialog]')].some(node => node.getClientRects().length)) { waiting = setTimeout(advance, 500); return; }
        current = feed.find(item => (read[item.id] || 0) < item.revision) || null;
        if (!current) return;
        dialog.show('announcement',current.title,host => MoonYaAnnouncementContent(host,current.blocks,MoonYaHost.backendUrl),[{text:'我知道了',run:acknowledge}],acknowledge);
    }
    async function acknowledge() {
        if (!current || acknowledging || window.MoonYaUpdateRequired) return;
        acknowledging = true; const item = current;
        try {
            await request('read',{id:item.id,revision:item.revision}); read[item.id] = Math.max(read[item.id] || 0,item.revision);
            if (current === item) { current = null; if (dialog.kind === 'announcement') dialog.hide(); }
        } catch (_) { if (dialog.kind === 'announcement') dialog.setStatus('已读记录保存失败，请重试。'); }
        finally { acknowledging = false; advance(); }
    }
    async function poll() {
        if (fetching || stopped) return; fetching = true;
        try { const data = await request('feed'); feed = data.announcements; for (const [id,revision] of Object.entries(data.read)) read[id] = Math.max(read[id] || 0,revision); advance(); }
        catch (_) { /* Keep the last successful feed; retry on the next check. */ }
        finally { fetching = false; }
    }
    window.addEventListener('moonya:update-required', () => { if (window.MoonYaUpdateRequired) current = null; else advance(); });
    window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); clearTimeout(waiting); });
    window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; poll(); timer = setInterval(poll,300000); } });
    poll(); timer = setInterval(poll,300000);
})();
