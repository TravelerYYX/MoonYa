(function (global) {
    'use strict';
    const cards = new Map();
    async function bridge() {
        if (!global.CefSharp) throw new Error('实时实体桌面需要 MoonYa Windows 客户端。');
        await CefSharp.BindObjectAsync('moonYaDesktop');
        if (!global.moonYaDesktop) throw new Error('实体桌面服务未连接。');
        return global.moonYaDesktop;
    }
    function renderCursor(canvas, state, trail) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!state || state.state === 'human') return;
        const point = { x: state.x / 1000 * canvas.width, y: state.y / 1000 * canvas.height, time: Date.now() };
        if (!trail.length || trail.at(-1).x !== point.x || trail.at(-1).y !== point.y) trail.push(point);
        while (trail.length && Date.now() - trail[0].time > 650) trail.shift();
        ctx.strokeStyle = '#64a5ff88'; ctx.lineWidth = 3;
        ctx.beginPath(); trail.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
        ctx.save(); ctx.translate(point.x, point.y);
        if (state.action === 'click' && Date.now() - state.timestamp < 450) {
            ctx.strokeStyle = '#408fff'; ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.shadowColor = '#1f5fc766'; ctx.shadowBlur = 5;
        ctx.fillStyle = '#428eff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(7, 23); ctx.lineTo(12, 14); ctx.lineTo(22, 10); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    async function show(payload, parent) {
        const id = String(payload.session_id || '');
        if (!id) return;
        if (cards.has(id)) return;
        const card = document.createElement('section'); card.className = 'moonya-desktop-preview';
        card.style.cssText = 'width:min(100%,360px);margin:14px 0 14px auto;border:1px solid #dce2eb;border-radius:14px;overflow:hidden;background: var(--theme-accent-soft, #f6f8fc);color: var(--theme-text, #27354a);';
        const heading = document.createElement('button'); heading.type = 'button'; heading.textContent = 'MoonYa 实体桌面 · 点击放大';
        heading.style.cssText = 'display:block;width:100%;padding:10px 12px;border:0;background:transparent;text-align:left;cursor:pointer;font:inherit;';
        const viewport = document.createElement('div'); viewport.style.cssText = 'position:relative;aspect-ratio:16/9;background: var(--theme-accent-soft, #e8edf5);';
        const img = document.createElement('img'); img.alt = '实体桌面实时画面'; img.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;';
        const cursor = document.createElement('canvas'); cursor.width = 1920; cursor.height = 1080; cursor.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
        const status = document.createElement('div'); status.style.cssText = 'padding:8px 12px;font-size:12px;'; status.textContent = '正在连接实时画面…';
        viewport.append(img, cursor); card.append(heading, viewport, status);
        (parent || document.querySelector('.messages-container') || document.body).append(card);
        const entry = { card, socket: null, url: '', disposed: false }; cards.set(id, entry);
        try {
            const host = await bridge(); const info = JSON.parse(await host.preview(id));
            if (!info.success) throw new Error(info.error || '实体桌面不可用。');
            cursor.width = info.width; cursor.height = info.height; viewport.style.aspectRatio = `${info.width}/${info.height}`;
            const openWindow = async event => {
                event?.preventDefault(); event?.stopPropagation();
                try { await host.open(id); }
                catch (error) { status.textContent = error.message || '无法打开实体桌面窗口。'; }
            };
            heading.onclick = openWindow; viewport.onclick = openWindow;
            const socket = entry.socket = new WebSocket(info.url); socket.binaryType = 'blob';
            let state; const trail = [];
            socket.onmessage = event => {
                if (typeof event.data === 'string') {
                    state = JSON.parse(event.data); renderCursor(cursor, state, trail);
                    status.textContent = state.state === 'human' ? '用户正在接管 · AI 已暂停' : state.state === 'stopped' ? '操作已停止' : '实时画面 · AI 操作中';
                } else {
                    if (entry.url) URL.revokeObjectURL(entry.url);
                    entry.url = URL.createObjectURL(event.data); img.src = entry.url;
                }
            };
            socket.onclose = () => {
                status.textContent = '屏幕会话已结束或连接断开';
                if (cards.get(id) === entry) cards.delete(id);
                if (entry.url) { URL.revokeObjectURL(entry.url); entry.url = ''; }
            };
            socket.onerror = () => { status.textContent = '实时连接不可用，输入将由宿主检查'; };
        } catch (error) { status.textContent = error.message; if (cards.get(id) === entry) cards.delete(id); }
    }
    async function open(id) { return (await bridge()).open(String(id)); }
    function disconnect(id) {
        const entry = cards.get(id); if (!entry) return;
        entry.disposed = true; entry.socket?.close(); if (entry.url) URL.revokeObjectURL(entry.url); cards.delete(id);
    }
    global.moonyaDesktopPreview = { show, open, disconnect, renderCursor };
    global.addEventListener('beforeunload', () => [...cards.keys()].forEach(disconnect));
})(window);
