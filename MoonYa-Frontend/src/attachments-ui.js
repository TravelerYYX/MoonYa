(function (global) {
    'use strict';
    const previewTasks = new Map();
    const sourceTasks = new Map();
    const originalLimit = 20 * 1024 * 1024;
    let lastSelectionOrder = 0;
    function nextOrder() { return lastSelectionOrder = Math.max(Date.now(), lastSelectionOrder + 1); }
    const imageExtension = /\.(png|jpe?g|gif|webp|bmp|svg|avif|apng|ico|tiff?)$/i;
    const shapes = {
        document: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
        folder: '<path d="M3 7V5h6l2 3h10v12H3zM3 8h18"/>',
        video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>',
        audio: '<path d="M9 18V5l11-2v13M9 5l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
        archive: '<path d="M4 3h16v18H4zM11 3v3h2V3m-2 3v3h2V6m-2 3v3h2V9m-2 6h2v3h-2z"/>'
    };
    function category(name, kind) {
        if (kind === 'folder') return 'folder';
        if (imageExtension.test(name)) return 'image';
        if (/\.(mp4|mpeg|mov|avi|mpg|webm|wmv|3gpp)$/i.test(name)) return 'video';
        if (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(name)) return 'audio';
        if (/\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(name)) return 'archive';
        return 'document';
    }
    function uploaded(item) {
        const name = item.filename || '附件';
        const kind = item.category && item.category !== 'document' ? item.category : item.is_image ? 'image' : category(name);
        return { id: item.file_id || item.attachment_id || '', name, category: kind,
            order: Number(item.selection_order || 0),
            preview: kind === 'image' ? item.thumbnail_url || item.base64_url || item.preview_url || '' : '',
            sourceRef: item.source_ref || (item.cache_chat_id && item.size <= originalLimit ? { chatId: item.cache_chat_id, id: item.file_id } : null),
            mime: item.mime || '', size: item.size, text: item.file_text || '', path: item.path, cacheError: item.cache_error };
    }
    function legacy(images, metadata = []) {
        metadata = Array.isArray(metadata) ? metadata : [];
        return (images || []).map((url, index) => {
            const meta = metadata[index] || {};
            const marker = typeof url === 'string' && url.match(/^(pdf|doc|txt|video|videothumb|audio|archive|folder|attachment):\/\/(.*)$/s);
            let kind = 'image', name = '图片', preview = typeof url === 'string' ? url : '';
            if (marker) {
                kind = ['video', 'videothumb'].includes(marker[1]) ? 'video'
                    : ['audio', 'archive', 'folder'].includes(marker[1]) ? marker[1] : category(marker[2]);
                if (kind === 'image') kind = 'document';
                name = marker[1] === 'videothumb' ? '视频文件' : marker[2]; preview = '';
            }
            return { ...meta, id: meta.id || '', name: meta.name || name, category: meta.category || kind,
                order: meta.order ?? index, preview };
        });
    }
    function legacyContent(html) {
        const shell = document.createElement('div'); shell.innerHTML = html || '';
        const files = [];
        // Older saves retained document badges and empty image wrappers in the body.
        // Recognize only the old attachment row, not arbitrary user HTML or code blocks.
        for (const row of shell.querySelectorAll('div')) {
            if (row.style.display !== 'flex' || row.style.flexWrap !== 'wrap'
                || row.style.gap !== '8px' || row.style.marginBottom !== '8px') continue;
            for (const badge of row.children) {
                const label = badge.querySelector('svg + span');
                if (!label || badge.style.display !== 'inline-flex') continue;
                const name = label.textContent;
                files.push({ id: '', name, category: category(name), order: files.length, preview: '' });
            }
            if (!row.querySelector('img')) row.remove();
        }
        return { content: shell.innerHTML, files };
    }
    function serialize(items) {
        return {
            images: items.map(item => item.category === 'image' && item.preview ? item.preview
                : (['audio', 'video', 'archive', 'folder'].includes(item.category) ? item.category : 'attachment') + '://' + item.name),
            attachments: items.map(({ preview, retry, ...meta }) => meta)
        };
    }
    function fileBody(item) {
        const body = document.createElement('div'); body.className = 'attachment-body attachment-file';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = shapes[item.category] || shapes[category(item.name)] || shapes.document;
        const label = document.createElement('span'); label.className = 'attachment-name'; label.textContent = item.name;
        body.append(svg, label); return body;
    }
    function setBody(card, item) {
        card._bodyCleanup?.();
        card._attachment = item;
        card.querySelector('.attachment-body')?.remove();
        if (item.category !== 'image') { card.prepend(fileBody(item)); return; }
        const body = document.createElement('div'); body.className = 'attachment-body';
        card.prepend(body);
        let timeout;
        card._bodyCleanup = () => clearTimeout(timeout);
        const failed = reason => {
            clearTimeout(timeout);
            body.replaceChildren(); body.className = 'attachment-body attachment-failed';
            card.dataset.loadState = 'failed';
            const label = document.createElement('span'); label.textContent = '图片加载失败';
            const error = document.createElement('small'); error.textContent = reason || '图片解码失败';
            body.dataset.tooltip = (item.path || item.name) + '\n' + (reason || '图片解码失败');
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
            retry.onclick = event => { event.stopPropagation(); if (item.retry) item.retry(); else void retryImage(card, item); };
            body.append(label, error, retry);
        };
        if (item.error && !item.preview) { failed(item.error); return; }
        card.dataset.loadState = 'loading'; body.classList.add('attachment-skeleton');
        body.setAttribute('aria-label', '图片加载中');
        if (!item.preview) return;
        const img = document.createElement('img'); img.alt = item.name;
        img.onload = () => {
            clearTimeout(timeout);
            if (!body.isConnected) return;
            body.classList.remove('attachment-skeleton'); body.removeAttribute('aria-label');
            card.dataset.loadState = 'ready'; body.append(img);
        };
        img.onerror = () => failed('图片解码失败'); img.src = item.preview;
        timeout = setTimeout(() => { if (body.isConnected && card.dataset.loadState === 'loading') failed('图片读取超时'); }, 8000);
    }
    function card(item, { onRemove, className = '' } = {}) {
        const el = document.createElement('div'); el.className = 'attachment-card ' + className;
        el.dataset.fileId = item.id || ''; el.dataset.tooltip = item.path || item.name;
        el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', '预览 ' + item.name);
        el.onclick = event => { if (!event.target.closest('button')) global.MoonYaAttachmentPreview?.open(el._attachment, el); };
        el.onkeydown = event => {
            if (event.target === el && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault(); global.MoonYaAttachmentPreview?.open(el._attachment, el);
            }
        };
        setBody(el, item);
        if (!onRemove && item.category === 'image' && !item.preview && !item.error) void retryImage(el, item);
        if (onRemove) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'attachment-remove';
            button.setAttribute('aria-label', '移除 ' + item.name);
            button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6m-6 0 6-6"/></svg>';
            button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (el.isConnected) onRemove(); });
            el.append(button);
        }
        return el;
    }
    function gallery(host, items) {
        if (!items.length) return;
        const row = document.createElement('div'); row.className = 'sent-attachments'; row.dataset.imagesContainer = 'true';
        for (const item of items) row.append(card(item));
        host.append(row);
    }
    function finishUser(message, content, items) {
        message._moonyaAttachments = items;
        content.classList.add('user-message-stack');
        const bubble = document.createElement('div'); bubble.className = 'user-message-bubble';
        for (const child of Array.from(content.childNodes)) {
            if (!(child.nodeType === 1 && child.classList.contains('sent-attachments'))) bubble.append(child);
        }
        if (bubble.textContent.trim() || bubble.querySelector('img, svg, .sent-selected-skill')) content.append(bubble);
    }
    function canSend(text, uploads, paths) { return !!(String(text || '').trim() || uploads.length || paths.length); }
    async function thumbnail(url) {
        const img = new Image(); img.src = url;
        let timeout;
        try {
            await Promise.race([img.decode(), new Promise((_, reject) => {
                timeout = setTimeout(() => { img.src = ''; reject(new Error('preview_timeout')); }, 8000);
            })]);
        } finally { clearTimeout(timeout); }
        const scale = Math.min(1, 244 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png');
    }
    async function retryImage(card, item) {
        setBody(card, { ...item, error: '', preview: '' });
        try {
            const archive = await cached(item.sourceRef || item.previewRef);
            if (archive?.dataUrl) item.preview = archive.dataUrl;
            else if (archive?.file) {
                const url = URL.createObjectURL(archive.file);
                try { item.preview = await thumbnail(url); } finally { URL.revokeObjectURL(url); }
            } else if (item.path) {
                item.preview = await thumbnail(mediaUrl(item.path));
            } else if (!item.preview) throw new Error('图片来源已失效，请重新选择文件');
            delete item.error;
        } catch (error) { item.error = error.message === 'preview_timeout' ? '图片解码超时' : error.message; }
        if (card.isConnected) setBody(card, item);
    }
    function mediaUrl(path) {
        const token = global.MoonYaHost?.mediaToken;
        if (!token) throw new Error('本机读取失败：媒体授权不可用，请重新选择文件');
        return '/local-media?t=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(path);
    }
    function scope() { return global.MoonYaConversationRuntime?.current()?.historyScope || (typeof CHAT_HISTORY_KEY === 'undefined' ? '' : CHAT_HISTORY_KEY); }
    async function cached(ref, runtime) {
        return ref ? global.MoonYaHistoryStore.loadAttachment(runtime?.historyScope || scope(), ref.chatId, ref.id) : null;
    }
    async function cacheFile(file, runtime, id = global.crypto.randomUUID(), extra = {}) {
        if (file.size > originalLimit) return null;
        if (await global.MoonYaHistoryStore.saveAttachment(runtime.historyScope, runtime.chatId, id, { ...extra, file }) === false) throw new Error('本地存储写入失败');
        return { chatId: runtime.chatId, id };
    }
    function localCacheInfo(selection) {
        return Object.fromEntries(['source_ref', 'preview_ref', 'preview_error', 'cache_error', 'size', 'mime']
            .filter(key => selection[key] !== undefined).map(key => [key, selection[key]]));
    }
    async function readLocal(selection, runtime) {
        const key = JSON.stringify([runtime.historyScope, runtime.chatId, selection.path]);
        if (!sourceTasks.has(key)) sourceTasks.set(key, (async () => {
            let archive;
            try { archive = await cached(selection.source_ref || selection.preview_ref, runtime); }
            catch (error) { selection.cache_error = '缓存读取失败：' + error.message; }
            if (archive?.file) { selection.size = archive.file.size; selection.mime = archive.file.type; return archive.file; }
            const url = mediaUrl(selection.path);
            if (selection.size > originalLimit && category(selection.name) !== 'image') return null;
            let response;
            try { response = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
            catch (error) { throw new Error(error.name === 'TimeoutError' ? '本机读取超时' : '本机读取失败：' + error.message); }
            if (!response.ok) throw new Error('本机读取失败（' + response.status + '），请重新选择文件');
            selection.size = Number(response.headers.get('content-length')) || selection.size;
            if (selection.size > originalLimit && category(selection.name) !== 'image') { await response.body?.cancel(); return null; }
            let file;
            try { file = await response.blob(); }
            catch (error) { throw new Error(error.name === 'TimeoutError' ? '本机读取超时' : '本机读取失败：' + error.message); }
            selection.size = file.size; selection.mime = file.type;
            if (file.size <= originalLimit) {
                try {
                    selection.source_ref = await cacheFile(file, runtime, selection.source_ref?.id || selection.preview_ref?.id, archive || {});
                } catch (error) { selection.cache_error = '缓存写入失败：' + error.message; }
            }
            return file;
        })().then(file => ({ file, info: localCacheInfo(selection) })));
        const task = sourceTasks.get(key);
        try { const result = await task; Object.assign(selection, result.info); return result.file; }
        finally { if (sourceTasks.get(key) === task) sourceTasks.delete(key); }
    }
    async function localPreview(selection, runtime) {
        if (selection.kind === 'folder' || category(selection.name || selection.path) !== 'image') return '';
        if (selection.preview_url?.startsWith('data:')) return selection.preview_url;
        const ref = selection.preview_ref;
        const key = JSON.stringify([runtime.historyScope, ref?.chatId || runtime.chatId, selection.path]);
        if (!previewTasks.has(key)) previewTasks.set(key, (async () => {
            try {
                if (ref) {
                    try {
                        const cached = await global.MoonYaHistoryStore.loadAttachment(runtime.historyScope, ref.chatId, ref.id);
                        if (cached?.dataUrl) return cached.dataUrl;
                    } catch (error) { selection.cache_error = '缓存读取失败：' + error.message; }
                }
                const file = await readLocal(selection, runtime);
                const url = URL.createObjectURL(file);
                let dataUrl;
                try { dataUrl = await thumbnail(url); }
                catch (error) { throw new Error(error.message === 'preview_timeout' ? '图片解码超时' : '图片解码失败'); }
                finally { URL.revokeObjectURL(url); }
                selection.preview_url = dataUrl; delete selection.preview_error;
                const id = selection.source_ref?.id || selection.preview_ref?.id || global.crypto.randomUUID();
                try {
                    if (await global.MoonYaHistoryStore.saveAttachment(runtime.historyScope, runtime.chatId, id,
                        { dataUrl, ...(file.size <= originalLimit ? { file } : {}) }) === false) throw new Error('本地存储写入失败');
                    selection.preview_ref = { chatId: runtime.chatId, id };
                    if (file.size <= originalLimit) selection.source_ref = selection.preview_ref;
                } catch (error) { selection.cache_error = '缓存写入失败：' + error.message; }
                return dataUrl;
            } catch (error) { selection.preview_error = error.message; return ''; }
        })().then(preview => ({ preview, info: localCacheInfo(selection) })));
        const task = previewTasks.get(key);
        const { preview, info } = await task;
        Object.assign(selection, info);
        if (preview) { selection.preview_url = preview; delete selection.preview_error; }
        if (previewTasks.get(key) === task) previewTasks.delete(key);
        return preview;
    }
    async function local(selection, runtime) {
        if (selection.kind !== 'folder' && category(selection.name || selection.path) !== 'image') {
            try { await readLocal(selection, runtime); } catch (error) { selection.source_error = error.message; }
        }
        const preview = await localPreview(selection, runtime);
        return { id: selection.path, path: selection.path, name: selection.name || selection.path.split(/[\\/]/).pop(),
            category: category(selection.name || selection.path, selection.kind), order: Number(selection.selection_order || 0),
            preview, sourceRef: selection.source_ref, previewRef: selection.preview_ref, mime: selection.mime, size: selection.size,
            error: selection.preview_error, cacheError: selection.cache_error };
    }
    function removeAnimated(node, update) {
        const tray = node?.parentElement;
        if (!tray) { update(); return; }
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
            tray.getAnimations().forEach(animation => animation.cancel());
            tray.querySelectorAll('.attachment-card').forEach(el => el.getAnimations().forEach(animation => animation.cancel()));
            document.querySelectorAll('.attachment-removal-ghost').forEach(el => el.remove());
            update(); return;
        }
        const nodes = [...tray.querySelectorAll('.attachment-card')];
        const before = new Map(nodes.map(el => [el, el.getBoundingClientRect()]));
        const height = tray.getBoundingClientRect().height;
        const rect = before.get(node);
        const ghost = node.cloneNode(true); ghost.classList.add('attachment-removal-ghost');
        ghost.removeAttribute('tabindex'); ghost.setAttribute('aria-hidden', 'true');
        ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:999;pointer-events:none`;
        document.body.append(ghost);
        for (const el of nodes) el.getAnimations().forEach(animation => animation.cancel());
        tray.getAnimations().forEach(animation => animation.cancel()); tray.style.height = '';
        update();
        ghost.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.8)' }], { duration: 160, easing: 'ease-out' }).finished.then(() => ghost.remove(), () => ghost.remove());
        for (const el of nodes) {
            if (!el.isConnected) continue;
            const after = el.getBoundingClientRect(), first = before.get(el);
            el.animate([{ transform: `translate(${first.left - after.left}px,${first.top - after.top}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' });
        }
        const afterHeight = tray.getBoundingClientRect().height;
        tray.animate([{ height: height + 'px', display: 'flex' }, { height: afterHeight + 'px', display: 'flex' }], { duration: 220, easing: 'ease-out' });
    }
    global.MoonYaAttachments = { category, nextOrder, uploaded, legacy, legacyContent, serialize, card, setBody, gallery, finishUser, canSend, local, localPreview,
        mediaUrl, cached, cacheFile, readLocal, removeAnimated, originalLimit, thumbnail };
    const tray = document.getElementById('uploadContainer');
    if (tray) new ResizeObserver(() => {
        tray.parentElement.style.setProperty('--attachment-tray-height', tray.getBoundingClientRect().height + 'px');
    }).observe(tray);
})(window);
