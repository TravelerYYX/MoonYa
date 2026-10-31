(function (global) {
    'use strict';
    let active;
    const textLimit = 2 * 1024 * 1024;
    const textNames = /\.(txt|md|csv|log|json|ya?ml|xml|ini|conf|html?|css|[cm]?js|tsx?|py3?|go|h|c|cpp|cxx|cc|cs|java|jsp|php|asp|sh|sql)$/i;
    const icons = {
        download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
        close: '<path d="m6 6 12 12M6 18 18 6"/>',
        reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'
    };
    function button(label, icon, action) {
        const el = document.createElement('button'); el.type = 'button'; el.setAttribute('aria-label', label); el.dataset.tooltip = label;
        el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[icon] + '</svg>'; el.onclick = action; return el;
    }
    function close() {
        const view = active; if (!view) return; active = null;
        view.abort.abort();
        view.root.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
        const destroy = view.pdf ? view.pdf.destroy() : view.task?.destroy(); destroy?.catch(() => {});
        view.urls.forEach(url => URL.revokeObjectURL(url));
        document.removeEventListener('keydown', view.keydown, true);
        view.background.forEach(([el, value]) => { el.inert = value; });
        view.root.remove(); document.body.style.overflow = view.overflow;
        global.dispatchEvent(new CustomEvent('moonya:attachment-preview', { detail: { open: false } }));
        if (view.origin?.isConnected) view.origin.focus();
    }
    async function fileBridge() {
        if (!global.moonYaFileOps && global.CefSharp?.BindObjectAsync) await global.CefSharp.BindObjectAsync('moonYaFileOps');
        return global.moonYaFileOps;
    }
    async function source(item, view) {
        let archive;
        try { archive = await MoonYaAttachments.cached(item.sourceRef || item.previewRef); }
        catch (error) { view.notice.textContent = '缓存读取失败：' + error.message; }
        if (active !== view) throw new DOMException('预览已关闭', 'AbortError');
        if (archive?.file instanceof Blob) {
            const url = URL.createObjectURL(archive.file); view.urls.push(url);
            return { url, blob: archive.file };
        }
        if (item.path && item.category !== 'folder') {
            const url = MoonYaAttachments.mediaUrl(item.path);
            const response = await fetch(url, { method: 'HEAD', signal: view.abort.signal });
            if (response.ok) return { url };
            // Images from older history can still be inspected at thumbnail resolution.
            if (!item.preview && !archive?.dataUrl) throw new Error('原文件来源已失效，请重新选择文件');
        }
        if (item.category === 'image' && (item.preview || archive?.dataUrl)) {
            view.notice.textContent = (view.notice.textContent ? view.notice.textContent + ' · ' : '') + '仅有已保存的图片预览';
            return { url: item.preview || archive.dataUrl, thumbnailOnly: true };
        }
        if (item.text && textNames.test(item.name) && new Blob([item.text]).size <= textLimit) return { blob: new Blob([item.text], { type: 'text/plain' }) };
        throw new Error('此附件没有可用的原文件缓存，请重新选择文件');
    }
    function metadata(view, item, reason = '') {
        view.stage.classList.add('attachment-preview-info');
        const name = document.createElement('strong'); name.textContent = item.name;
        const detail = document.createElement('p');
        const extension = item.name.split('.').pop().toUpperCase();
        detail.textContent = (item.category === 'folder' ? '文件夹' : extension + ' 文件') + (Number.isFinite(item.size) ? ' · ' + (item.size / 1024 / 1024).toFixed(2) + ' MB' : ' · 大小未知');
        const note = document.createElement('p'); note.textContent = reason || '此格式不支持直接预览，可下载后打开。';
        view.stage.replaceChildren(name, detail, note);
    }
    function image(view, url) {
        return new Promise((resolve, reject) => {
            const img = new Image(); img.alt = view.item.name; img.draggable = false;
            img.onload = () => {
                if (active !== view) return resolve();
                view.stage.replaceChildren(img); view.stage.classList.add('attachment-preview-image');
                let scale = 1, x = 0, y = 0, drag;
                const fit = () => Math.min(1, (view.stage.clientWidth - 32) / img.naturalWidth, (view.stage.clientHeight - 32) / img.naturalHeight);
                const paint = () => {
                    img.style.width = img.naturalWidth + 'px'; img.style.height = img.naturalHeight + 'px';
                    img.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
                    view.zoom.value = String(Math.round(scale * 100));
                    view.zoom.querySelector('.attachment-zoom-current').textContent = Math.round(scale * 100) + '%';
                    view.zoom.querySelector('.attachment-zoom-current').value = String(Math.round(scale * 100));
                    view.zoom.value = String(Math.round(scale * 100));
                };
                const zoom = value => { scale = Math.min(8, Math.max(.05, value)); paint(); };
                view.zoom.onchange = () => { if (view.zoom.value === 'fit') { x = y = 0; zoom(fit()); } else zoom(Number(view.zoom.value) / 100); };
                view.reset.onclick = () => { x = y = 0; zoom(fit()); };
                view.stage.onwheel = event => { event.preventDefault(); zoom(scale * Math.exp(-event.deltaY * .0015)); };
                view.stage.onpointerdown = event => {
                    if (event.button !== 0 || scale <= fit() + .001) return;
                    view.dragged = true;
                    drag = { x: event.clientX - x, y: event.clientY - y }; view.stage.setPointerCapture(event.pointerId);
                };
                view.stage.onpointermove = event => { if (drag) { x = event.clientX - drag.x; y = event.clientY - drag.y; paint(); } };
                view.stage.onpointerup = view.stage.onpointercancel = () => { drag = null; };
                view.resize = () => { x = y = 0; zoom(fit()); };
                const observer = new ResizeObserver(view.resize); observer.observe(view.stage);
                view.abort.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
                view.resize(); resolve();
            };
            img.onerror = () => reject(new Error('图片解码失败，请重试或重新选择文件')); img.src = url;
        });
    }
    async function pdf(view, content) {
        if (!global.pdfjsLib) throw new Error('PDF 预览组件未就绪');
        pdfjsLib.GlobalWorkerOptions.workerSrc ||= global.WEB_RUNTIME_CONFIG?.pdfWorkerUrl || '/vendor/pdf.worker.min.js';
        const blob = content.blob || await (await fetch(content.url, { signal: view.abort.signal })).blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (active !== view) return;
        view.task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
        view.pdf = await view.task.promise; if (active !== view) { await view.pdf.destroy(); return; }
        view.stage.classList.add('attachment-preview-pdf');
        let generation = 0;
        const renders = new Set();
        const render = async scale => {
            const current = ++generation;
            renders.forEach(task => task.cancel()); renders.clear(); view.stage.replaceChildren();
            for (let index = 1; index <= view.pdf.numPages; index++) {
                if (active !== view || generation !== current) return;
                const page = await view.pdf.getPage(index);
                if (active !== view || generation !== current) return;
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', '第 ' + index + ' 页');
                const ratio = Math.min(devicePixelRatio || 1, 2);
                canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
                canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px'; view.stage.append(canvas);
                const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] }); renders.add(task);
                try { await task.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; } finally { renders.delete(task); }
            }
        };
        const first = await view.pdf.getPage(1);
        const fit = () => Math.min(1, (view.stage.clientWidth - 40) / first.getViewport({ scale: 1 }).width);
        const setZoom = async value => {
            const scale = value === 'fit' ? fit() : Number(value) / 100;
            const current = view.zoom.querySelector('.attachment-zoom-current'); current.value = String(Math.round(scale * 100)); current.textContent = Math.round(scale * 100) + '%';
            view.zoom.value = current.value;
            await render(scale);
        };
        view.zoom.onchange = () => void setZoom(view.zoom.value).catch(error => { if (active === view) view.notice.textContent = error.message; });
        view.reset.onclick = () => void setZoom('fit').catch(error => { if (active === view) view.notice.textContent = error.message; }); await setZoom('fit');
    }
    async function open(item, origin) {
        close();
        const root = document.createElement('div'); root.className = 'attachment-preview-overlay';
        root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '附件预览：' + item.name);
        const toolbar = document.createElement('div'); toolbar.className = 'attachment-preview-toolbar';
        const title = document.createElement('span'); title.className = 'attachment-preview-name'; title.textContent = item.name; title.dataset.tooltip = item.name;
        const zoom = document.createElement('select'); zoom.setAttribute('aria-label', '缩放比例');
        for (const [value, label] of [['fit', '适应窗口'], ['25','25%'], ['50','50%'], ['100','100%'], ['150','150%'], ['200','200%'], ['400','400%']]) {
            const option = document.createElement('option'); option.value = value; option.textContent = label; zoom.append(option);
        }
        const current = document.createElement('option'); current.className = 'attachment-zoom-current'; current.value = '100'; current.textContent = '100%'; zoom.prepend(current);
        const stage = document.createElement('div'); stage.className = 'attachment-preview-stage'; stage.tabIndex = 0;
        const notice = document.createElement('div'); notice.className = 'attachment-preview-notice'; notice.setAttribute('role', 'status');
        notice.textContent = item.cacheError || '';
        const view = active = { root, stage, notice, zoom, item, origin, urls: [], abort: new AbortController(), overflow: document.body.style.overflow,
            background: [...document.body.children].map(el => [el, el.inert]) };
        view.reset = button('复位', 'reset', () => {});
        const download = button('下载', 'download', () => {
            if (!view.content) return;
            let url = view.content.url;
            if (!url && view.content.blob) { url = URL.createObjectURL(view.content.blob); view.urls.push(url); }
            const link = document.createElement('a'); link.href = url; link.download = item.name; link.click();
        }); download.disabled = true;
        const system = document.createElement('button'); system.type = 'button'; system.textContent = '用系统应用打开'; system.hidden = true;
        system.onclick = async () => {
            try {
                const bridge = await fileBridge(); let result;
                if (item.path) result = await bridge.openFolder(item.path);
                else if (view.content?.blob && typeof bridge?.openCachedAttachment === 'function') {
                    const encoded = await new Promise((resolve, reject) => {
                        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('附件读取失败'));
                        reader.readAsDataURL(view.content.blob);
                    });
                    if (active !== view) return;
                    result = await bridge.openCachedAttachment(item.name, encoded);
                } else throw new Error('系统应用打开暂不可用，请下载后查看');
                if (result?.success === false) throw new Error(result.message);
            }
            catch (error) { notice.textContent = error.message || '无法打开文件'; }
        };
        toolbar.append(title, zoom, view.reset, system, download, button('关闭', 'close', close));
        root.append(toolbar, stage, notice); document.body.append(root); document.body.style.overflow = 'hidden';
        view.background.forEach(([el]) => { el.inert = true; });
        global.dispatchEvent(new CustomEvent('moonya:attachment-preview', { detail: { open: true } }));
        root.onclick = event => {
            if (view.dragged) { view.dragged = false; return; }
            if (event.target === root || event.target === stage) close();
        };
        view.keydown = event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
            if (event.key === 'Tab') {
                const targets = [...root.querySelectorAll('button:not([disabled]),select:not([disabled]),[tabindex="0"],audio,video')].filter(el => !el.hidden && el.getClientRects().length);
                const index = targets.indexOf(document.activeElement);
                const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length;
                event.preventDefault(); targets[next]?.focus();
            }
        };
        document.addEventListener('keydown', view.keydown, true); toolbar.lastChild.focus();
        stage.textContent = '正在加载预览…';
        try {
            if (item.category === 'folder') { metadata(view, item, '文件夹可用系统应用打开。'); zoom.hidden = view.reset.hidden = true; system.hidden = !item.path; return; }
            const content = view.content = await source(item, view); if (active !== view) return;
            download.disabled = false;
            if (item.category === 'image') await image(view, content.url);
            else if (/\.pdf$/i.test(item.name)) await pdf(view, content);
            else {
                zoom.hidden = view.reset.hidden = true;
                if (['audio', 'video'].includes(item.category)) {
                    const media = document.createElement(item.category); media.controls = true; media.preload = 'metadata'; media.src = content.url;
                    media.onerror = () => { if (active === view) notice.textContent = '媒体无法播放，格式不支持或来源已失效，请下载或重新选择'; };
                    stage.replaceChildren(media);
                } else if (textNames.test(item.name)) {
                    if (item.size > textLimit || content.blob?.size > textLimit) metadata(view, item, '文本超过 2MB，请下载后查看。');
                    else {
                        const response = content.blob ? null : await fetch(content.url, { signal: view.abort.signal });
                        if (response && !response.ok) throw new Error('文本读取失败');
                        if (Number(response?.headers.get('content-length')) > textLimit) { await response.body?.cancel(); metadata(view, item, '文本超过 2MB，请下载后查看。'); }
                        else {
                            const blob = content.blob || await response.blob();
                            if (blob.size > textLimit) metadata(view, item, '文本超过 2MB，请下载后查看。');
                            else { const pre = document.createElement('pre'); pre.textContent = await blob.text(); if (active === view) stage.replaceChildren(pre); }
                        }
                    }
                } else metadata(view, item);
                if (global.CefSharp && (item.path || content.blob)) system.hidden = false;
            }
        } catch (error) {
            if (active !== view) return;
            zoom.hidden = view.reset.hidden = true; metadata(view, item, error.message);
            const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => open(item, origin); stage.append(retry);
        }
    }
    global.MoonYaAttachmentPreview = { open, close, isOpen: () => !!active };
})(window);
