<div id="updatesSection" class="content-section">
    <div class="updates-wrap">
        <!-- 顶部更新发布卡片 -->
        <div class="updates-top-card">
            <div class="updates-header-row">
                <div class="updates-header-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </div>
                <div class="updates-header-texts">
                    <h2 class="updates-title">更新程序</h2>
                    <p class="updates-subtitle">上传安装包并发布新版本，让用户获得更好的使用体验。</p>
                </div>
            </div>

            <!-- 右侧 3D 悬浮主视觉插画 -->
            <img src="assets/images/updates-banner-3d.png" alt="Update Art" class="updates-hero-3d">

            <form id="programUpdateForm" class="update-modern-form">
                <!-- 版本号 -->
                <div class="update-field-group">
                    <label class="update-field-label" for="programUpdateVersion">版本号 <span class="req-star">*</span></label>
                    <input class="update-modern-input" id="programUpdateVersion" placeholder="1.0.1" pattern="(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})" required value="1.0.1">
                </div>

                <!-- 版本更新内容 -->
                <div class="update-field-group">
                    <label class="update-field-label" for="programUpdateNotes">版本更新内容 <span class="req-star">*</span></label>
                    <div class="update-textarea-wrap">
                        <textarea class="update-modern-textarea" id="programUpdateNotes" rows="4" maxlength="500" placeholder="请输入本次版本的更新内容..." required oninput="document.getElementById('notesCharCount').textContent = this.value.length + '/500'"></textarea>
                        <span class="update-char-count" id="notesCharCount">0/500</span>
                    </div>
                </div>

                <label><input type="checkbox" id="programUpdateForce"> 强制更新（低于此版本的用户必须升级）</label>
                <!-- 安装程序拖拽区 -->
                <div class="update-field-group">
                    <label class="update-field-label">安装程序 <span class="req-star">*</span></label>
                    <div class="update-dropzone-box" id="programUpdateDropzone" onclick="document.getElementById('programUpdateFile').click()">
                        <div class="update-dropzone-left">
                            <div class="update-file-icon-badge">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <polyline points="14 2 14 8 20 8"/>
                                    <line x1="16" y1="13" x2="8" y2="13"/>
                                    <line x1="16" y1="17" x2="8" y2="17"/>
                                    <polyline points="10 9 9 9 8 9"/>
                                </svg>
                            </div>
                            <div class="update-dropzone-text">
                                <div class="update-dropzone-title" id="dropzoneTitle">
                                    <span class="link-blue">点击选择文件</span> 或 拖拽文件到此处
                                </div>
                                <div class="update-dropzone-sub" id="dropzoneSub">支持上传 FarSideSetup.exe 安装程序文件</div>
                            </div>
                        </div>
                        <img src="assets/images/dropzone-cloud.png" alt="Cloud Upload" class="update-dropzone-cloud">
                        <input id="programUpdateFile" type="file" accept=".exe" required style="display:none" onchange="handleUpdateFileSelected(this)">
                    </div>
                </div>

                <div class="update-tip-bar">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    <span>请上传支持自动更新的 FarSideSetup.exe，上传校验完成后，点击发布新版本。</span>
                </div>

                <!-- 进度指示 -->
                <div class="update-upload-progress" id="programUpdateProgress" hidden aria-live="polite">
                    <div class="update-upload-ring" role="progressbar" aria-label="安装程序上传进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                        <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="21" class="update-ring-track" fill="none" stroke-width="3.5"/><circle cx="24" cy="24" r="21" class="update-ring-value" fill="none" stroke-width="3.5"/></svg><span>0%</span>
                    </div>
                    <span id="programUpdateStatus" class="update-upload-status"></span>
                </div>

                <!-- 底部操作按钮 -->
                <div class="update-actions-bar">
                    <button class="btn-update-upload" id="programUpdateUpload" type="submit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        上传安装程序
                    </button>
                    <button class="btn-update-publish" id="programUpdatePublish" type="button" disabled>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"/>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                        </svg>
                        发布新版本
                    </button>
                </div>
            </form>
        </div>

        <!-- 底部版本列表卡片 -->
        <div class="updates-bottom-card">
            <div class="updates-list-header">
                <div class="updates-list-header-left">
                    <div class="updates-list-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                            <line x1="12" y1="22.08" x2="12" y2="12"/>
                        </svg>
                    </div>
                    <div>
                        <h3 style="font-size:16px;font-weight:700;color:#0f172a;margin:0">版本列表</h3>
                        <p style="font-size:12px;color:#64748b;margin:0">查看和管理已发布的更新版本</p>
                    </div>
                </div>
                <div class="updates-list-header-actions">
                    <label class="updates-select-all" id="programUpdateSelectAllWrap" hidden>
                        <input type="checkbox" id="programUpdateSelectAll">
                        <span>全选</span>
                    </label>
                    <button class="btn-update-batch-delete" id="programUpdateBatchDelete" type="button" disabled hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        删除所选 (<span id="programUpdateSelectedCount">0</span>)
                    </button>
                    <button class="btn-update-refresh" type="button" onclick="window.programUpdates.load()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                        刷新
                    </button>
                </div>
            </div>

            <div id="programUpdateList">
                <div class="update-empty-wrap">
                    <img src="assets/images/empty-updates-box.png" alt="Empty" class="update-empty-img">
                    <div class="update-empty-title">暂无版本</div>
                    <div class="update-empty-sub">当前还没有已发布的更新版本</div>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
(() => {
    const form = document.getElementById('programUpdateForm'), fileInput = document.getElementById('programUpdateFile');
    const versionInput = document.getElementById('programUpdateVersion'), notesInput = document.getElementById('programUpdateNotes');
    const uploadButton = document.getElementById('programUpdateUpload'), publishButton = document.getElementById('programUpdatePublish');
    const progress = document.getElementById('programUpdateProgress'), ring = progress.querySelector('[role=progressbar]');
    const dropzone = document.getElementById('programUpdateDropzone');
    let release = null, busy = false, maxBytes = 2147483648, lastReleases = [], latestPublishedId = null;

    window.handleUpdateFileSelected = function(input) {
        if (input.files && input.files[0]) {
            const f = input.files[0];
            const sizeMb = (f.size / 1048576).toFixed(1);
            document.getElementById('dropzoneTitle').innerHTML = '<span class="link-blue" style="font-weight:600">' + escapeHtml(f.name) + '</span> (' + sizeMb + ' MB)';
            document.getElementById('dropzoneSub').textContent = '点击可重新选择文件';
        }
    };

    if (dropzone) {
        ['dragenter', 'dragover'].forEach(name => {
            dropzone.addEventListener(name, e => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(name => {
            dropzone.addEventListener(name, e => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('dragover');
            });
        });
        dropzone.addEventListener('drop', e => {
            const dt = e.dataTransfer;
            if (dt && dt.files && dt.files[0]) {
                fileInput.files = dt.files;
                handleUpdateFileSelected(fileInput);
            }
        });
    }

    async function api(action, body) {
        const response = await fetch('api/updates.php?action=' + action, {
            method: body === undefined ? 'GET' : 'POST', headers: {Authorization:'Bearer ' + token, 'Content-Type':'application/json'},
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || '更新操作失败');
        return result.data;
    }
    function setProgress(value, message) {
        progress.hidden = false;
        const percent = Math.min(100, Math.max(0, Math.floor(value)));
        ring.setAttribute('aria-valuenow', String(percent));
        ring.querySelector('span').textContent = percent + '%';
        const ringValue = ring.querySelector('.update-ring-value');
        if (ringValue) {
            const offset = String(131.947 * (1 - percent / 100));
            ringValue.style.strokeDashoffset = offset;
            ringValue.style.setProperty('stroke-dashoffset', offset, 'important');
        }
        document.getElementById('programUpdateStatus').textContent = message;
    }
    function lock(value) {
        busy = value; [uploadButton, fileInput, versionInput, notesInput].forEach(element => element.disabled = value);
        publishButton.disabled = value || !release || release.status === 'published';
        document.querySelectorAll('#programUpdateList button').forEach(button => button.disabled = value);
        document.querySelectorAll('#programUpdateList .update-release-checkbox').forEach(box => box.disabled = value);
        document.getElementById('programUpdateSelectAll').disabled = value;
        document.getElementById('programUpdateBatchDelete').disabled = value || selectedIds().length === 0;
    }
    function chunk(id, offset, bytes, total) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', 'api/updates.php?action=chunk&upload_id=' + encodeURIComponent(id) + '&offset=' + offset);
            xhr.timeout = 120000; xhr.setRequestHeader('Authorization', 'Bearer ' + token); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = event => setProgress((offset + event.loaded) / total * 100, '正在上传安装程序…');
            xhr.onerror = xhr.ontimeout = () => reject(new Error('上传连接中断，请重试'));
            xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); if (xhr.status !== 200 || !result.success) throw new Error(result.error || '上传失败'); resolve(result.data); } catch (error) { reject(error); } };
            xhr.send(bytes);
        });
    }
    async function load() {
        const list = document.getElementById('programUpdateList');
        try {
            const data = await api('list'); maxBytes = data.max_bytes; list.replaceChildren();
            lastReleases = data.releases;
            // 列表按版本降序（与 latest() 同序），第一个已发布项即当前最新已发布版本。
            latestPublishedId = (data.releases.find(item => item.status === 'published') || {}).id ?? null;
            if (!data.releases.length) {
                list.innerHTML = `
                    <div class="update-empty-wrap">
                        <img src="assets/images/empty-updates-box.png" alt="Empty" class="update-empty-img">
                        <div class="update-empty-title">暂无版本</div>
                        <div class="update-empty-sub">当前还没有已发布的更新版本</div>
                    </div>`;
                updateSelectionState();
                return;
            }
            for (const item of data.releases) {
                const card = document.createElement('div'); card.className = 'update-release-card';

                const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'update-release-checkbox';
                check.value = String(item.id); check.setAttribute('aria-label', '选择版本 v' + item.version);
                check.onchange = updateSelectionState; card.append(check);

                const copy = document.createElement('div'); copy.style.cssText = 'flex:1;min-width:0;';
                
                const meta = document.createElement('div'); meta.className = 'update-release-meta';
                const ver = document.createElement('span'); ver.style.cssText = 'font-size:15px;font-weight:700;color:#0f172a;'; ver.textContent = 'v' + item.version;
                const statusTag = document.createElement('span');
                if (item.status === 'published') {
                    statusTag.className = 'update-release-tag-pub'; statusTag.textContent = '已发布';
                } else {
                    statusTag.className = 'update-release-tag-draft'; statusTag.textContent = '待发布';
                }
                meta.append(ver, statusTag);
                const forceLabel = document.createElement('label'), force = document.createElement('input');
                force.type = 'checkbox'; force.checked = item.force_update; force.disabled = busy;
                forceLabel.append(force, ' 强制更新'); meta.append(forceLabel);
                force.onchange = async () => {
                    force.disabled = true;
                    try { await api('set_force', {id:item.id, force_update:force.checked}); await load(); }
                    catch (error) { force.checked = item.force_update; showAlert('error', error.message); }
                    finally { force.disabled = false; }
                };

                const notes = document.createElement('p'); notes.style.cssText = 'margin:6px 0 8px;font-size:13px;color:#475569;white-space:pre-wrap;overflow-wrap:anywhere;'; notes.textContent = item.notes;
                const detail = document.createElement('div'); detail.style.cssText = 'font-size:12px;color:#94a3b8;display:flex;align-items:center;gap:12px;';
                detail.innerHTML = `<span>📁 ${escapeHtml(item.file_name)}</span><span>📦 ${(item.size / 1048576).toFixed(1)} MiB</span>`;
                
                copy.append(meta, notes, detail); card.append(copy);

                const actions = document.createElement('div'); actions.className = 'update-release-actions';
                if (item.status === 'draft') {
                    const btn = document.createElement('button'); btn.className = 'btn-update-publish'; btn.type = 'button';
                    btn.style.cssText = 'padding:8px 18px;font-size:13px;flex-shrink:0;';
                    btn.textContent = '发布新版本';
                    btn.onclick = () => publish(item.id); actions.append(btn);
                }
                const remove = document.createElement('button'); remove.className = 'btn-update-delete'; remove.type = 'button';
                remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>删除';
                remove.onclick = () => removeVersions([item]); actions.append(remove);
                card.append(actions);
                list.append(card);
            }
            updateSelectionState();
        } catch (error) { list.innerHTML = `<div class="alert alert-error" style="display:block;margin:0">${escapeHtml(error.message)}</div>`; }
    }
    async function publish(id) {
        if (busy) return; lock(true);
        try { const item = await api('publish', {id}); if (release?.id === id) release = item; showAlert('success', '版本 ' + item.version + ' 已发布'); await load(); }
        catch (error) { showAlert('error', error.message); }
        finally { lock(false); }
    }
    form.addEventListener('input', () => { release = null; publishButton.disabled = true; });
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy) return;
        const file = fileInput.files[0];
        if (!file || !/\.exe$/i.test(file.name) || file.size > maxBytes) { showAlert('error', '请选择大小在限制内的 EXE 安装程序'); return; }
        release = null; lock(true); setProgress(0, '正在准备上传…');
        try {
            const session = await api('begin', {version:versionInput.value.trim(), notes:notesInput.value.trim(), file_name:file.name, file_size:file.size, force_update:document.getElementById('programUpdateForce').checked});
            for (let offset = 0; offset < file.size; offset += session.chunk_bytes) {
                const bytes = file.slice(offset, offset + session.chunk_bytes);
                for (let attempt = 0;; attempt++) {
                    try { await chunk(session.upload_id, offset, bytes, file.size); break; }
                    catch (error) { if (attempt >= 2) throw error; await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); }
                }
            }
            setProgress(100, '上传完成，正在校验安装程序…');
            release = await api('complete', {upload_id:session.upload_id});
            setProgress(100, '校验通过，可以发布新版本'); await load();
        } catch (error) { setProgress(Number(ring.getAttribute('aria-valuenow')), error.message); showAlert('error', error.message); }
        finally { lock(false); }
    });
    publishButton.onclick = () => release && publish(release.id);

    function selectedIds() {
        return [...document.querySelectorAll('#programUpdateList .update-release-checkbox:checked')].map(box => Number(box.value));
    }
    function updateSelectionState() {
        const boxes = [...document.querySelectorAll('#programUpdateList .update-release-checkbox')];
        const selected = boxes.filter(box => box.checked).length, has = boxes.length > 0;
        const selectAll = document.getElementById('programUpdateSelectAll');
        selectAll.checked = has && selected === boxes.length;
        selectAll.indeterminate = selected > 0 && selected < boxes.length;
        selectAll.disabled = busy || !has;
        document.getElementById('programUpdateSelectedCount').textContent = String(selected);
        document.getElementById('programUpdateSelectAllWrap').hidden = !has;
        const batch = document.getElementById('programUpdateBatchDelete');
        batch.hidden = !has; batch.disabled = busy || selected === 0;
    }
    document.getElementById('programUpdateSelectAll').addEventListener('change', event => {
        document.querySelectorAll('#programUpdateList .update-release-checkbox').forEach(box => { box.checked = event.target.checked; });
        updateSelectionState();
    });
    document.getElementById('programUpdateBatchDelete').addEventListener('click', () => {
        const ids = selectedIds();
        removeVersions(lastReleases.filter(item => ids.includes(item.id)));
    });
    function confirmDialog({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
        return new Promise(resolve => {
            showModal(`
                <div class="clean-dialog confirm-dialog">
                    <div class="clean-dialog-header">
                        <h3 class="clean-dialog-title">${escapeHtml(title)}</h3>
                        <button class="clean-dialog-close" type="button" title="关闭" aria-label="关闭">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                    </div>
                    <div class="confirm-dialog-body">${message}</div>
                    <div class="clean-dialog-footer">
                        <button type="button" class="clean-btn-cancel">${escapeHtml(cancelText)}</button>
                        <button type="button" class="clean-btn-save${danger ? ' clean-btn-danger' : ''}">${escapeHtml(confirmText)}</button>
                    </div>
                </div>`, { cleanDialog: true });
            const root = document.getElementById('modalContent'); let settled = false;
            const finish = value => { if (settled) return; settled = true; hideModal(); resolve(value); };
            root.querySelector('.clean-dialog-close').onclick = () => finish(false);
            root.querySelector('.clean-btn-cancel').onclick = () => finish(false);
            root.querySelector('.clean-btn-save').onclick = () => finish(true);
        });
    }
    async function removeVersions(items) {
        if (busy || !items || !items.length) return;
        const published = items.filter(item => item.status === 'published');
        const removesLatest = items.some(item => item.id === latestPublishedId);
        const parts = [`确定要删除以下 ${items.length} 个版本吗？删除后无法恢复。`];
        parts.push('<ul>' + items.map(item => `<li>v${escapeHtml(item.version)}（${item.status === 'published' ? '已发布' : '待发布'}）</li>`).join('') + '</ul>');
        if (published.length) parts.push('<p class="confirm-dialog-warn">其中包含已发布版本，删除后用户将无法再下载这些安装包。</p>');
        if (removesLatest) parts.push('<p class="confirm-dialog-warn confirm-dialog-danger">你正在删除当前最新的已发布版本：删除后客户端将回退到更低版本；若没有更低的已发布版本，将停止提供更新。</p>');
        const accepted = await confirmDialog({ title: '删除版本', message: parts.join(''), confirmText: '确认删除', danger: true });
        if (!accepted) return;
        lock(true);
        try {
            const result = await api('delete', { ids: items.map(item => item.id) });
            const deleted = (result && result.deleted) || [], failed = (result && result.failed) || [];
            if (deleted.length) showAlert('success', '已删除 ' + deleted.length + ' 个版本');
            if (failed.length) showAlert('error', '有 ' + failed.length + ' 个版本删除失败');
            await load();
        } catch (error) { showAlert('error', error.message); }
        finally { lock(false); updateSelectionState(); }
    }
    window.programUpdates = {load};
})();
</script>
