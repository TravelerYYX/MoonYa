<div id="skillsSection" class="content-section">
    <div class="card skill-explorer-card" id="skillDropZone" style="padding:0;background:transparent;border:none;box-shadow:none;">
        
        <!-- 顶部技能卡片 Header -->
        <div class="skills-header-card">
            <div class="skills-header-left">
                <div class="skills-header-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                </div>
                <div>
                    <h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:0">技能</h2>
                    <p style="font-size:13px;color:#64748b;margin:3px 0 0">管理技能和 Markdown 提示词</p>
                </div>
            </div>

            <!-- 中间 3D 磨砂玻璃文件夹插画 -->
            <img src="assets/images/skills-header-3d.png" alt="Skills Art" class="skills-hero-3d">

            <!-- 顶部操作按钮排 -->
            <div class="skills-header-actions skill-actions">
                <button class="btn-skill-primary" type="button" id="skillCreateButton" onclick="openSkillCreate()">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    新建技能
                </button>
                <button class="btn-skill-outline" type="button" id="skillFolderButton" onclick="document.getElementById('skillUploadFolder').click()">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    导入技能文件夹
                </button>
                <button class="btn-skill-outline" type="button" id="skillDirectoryButton" onclick="openSkillDirectory()" hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    新建目录
                </button>
                <button class="btn-skill-primary" type="button" id="skillUploadButton" onclick="document.getElementById('skillUploadFiles').click()" hidden>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 9 10 11"/><polyline points="12 9 14 11"/></svg>
                    上传提示词
                </button>
                <button class="btn-skill-outline" type="button" id="skillExplorerUp" onclick="skillGoUp()" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                    返回上级
                </button>
            </div>

            <input id="skillUploadFiles" type="file" accept=".md" multiple hidden onchange="uploadSkillFiles(this)">
            <input id="skillUploadFolder" type="file" webkitdirectory multiple hidden onchange="uploadSkillFolder(this)">
        </div>

        <!-- 技能路径面包屑导航 -->
        <nav class="skill-breadcrumb" id="skillBreadcrumb" aria-label="技能文件路径"></nav>

        <!-- 状态和进度条 -->
        <div class="skill-upload-status" id="skillUploadStatus" hidden aria-live="polite">
            <p id="skillUploadMessage"></p>
            <progress id="skillUploadProgress" max="100" aria-label="技能上传进度"></progress>
            <details id="skillUploadSkipped" hidden>
                <summary id="skillUploadSkippedSummary"></summary>
                <ul id="skillUploadSkippedList"></ul>
            </details>
        </div>

        <!-- 主表格卡片 -->
        <div class="skills-table-card">
            <div style="overflow-x:auto;">
                <table class="skills-table">
                    <thead>
                        <tr>
                            <th style="width: 24%">技能名称 <span style="color:#94a3b8;font-size:11px;">⇅</span></th>
                            <th style="width: 12%">类型</th>
                            <th style="width: 26%">路径</th>
                            <th style="width: 24%">说明</th>
                            <th style="width: 14%; text-align:right;">操作</th>
                        </tr>
                    </thead>
                    <tbody id="skillFileList" role="listbox" aria-label="技能文件">
                        <tr><td colspan="5" class="skill-file-empty" style="text-align:center;padding:48px;color:#94a3b8;">加载中...</td></tr>
                    </tbody>
                </table>
            </div>

            <!-- 底部提示信息栏 -->
            <div class="skills-bottom-hint">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span id="skillDropHint">可拖入含 SKILL.md 的完整技能文件夹；不支持的文件会跳过并提示。双击技能文件夹进入。</span>
            </div>
        </div>
    </div>
</div>

<!-- 新建技能弹窗 -->
<div id="skillCreateModal" class="modal">
    <div class="modal-content" style="max-width:620px;border-radius:18px;">
        <div class="modal-header">
            <h3>新建技能</h3>
            <button class="btn-ghost" type="button" onclick="closeSkillCreate()">✕</button>
        </div>
        <form onsubmit="event.preventDefault(); createSkill(this)">
            <div class="modal-body">
                <div class="form-group">
                    <label>技能标识（小写字母、数字、连字符） <span style="color:#ef4444">*</span></label>
                    <input class="form-input" id="newSkillName" required pattern="[a-z0-9-]{1,63}" maxlength="63" placeholder="例如: browser-assistant">
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input class="form-input" id="newSkillDisplayName" placeholder="例如: 浏览器操作助手">
                </div>
                <div class="form-group">
                    <label>用途说明 <span style="color:#ef4444">*</span></label>
                    <input class="form-input" id="newSkillDescription" required placeholder="简要说明此技能解决的问题">
                </div>
                <div class="form-group">
                    <label>主提示词 <span style="color:#ef4444">*</span></label>
                    <textarea class="form-textarea" id="newSkillBody" required rows="8" placeholder="描述技能的操作步骤；需要读取子文件时写明相对路径。"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" type="button" onclick="closeSkillCreate()">取消</button>
                <button class="btn-primary" type="submit">创建技能</button>
            </div>
        </form>
    </div>
</div>

<!-- 新建目录弹窗 -->
<div id="skillDirectoryModal" class="modal">
    <div class="modal-content" style="max-width:500px;border-radius:18px;">
        <div class="modal-header">
            <h3>新建目录</h3>
            <button class="btn-ghost" type="button" onclick="closeSkillDirectory()">✕</button>
        </div>
        <form onsubmit="event.preventDefault(); createSkillDirectory(this)">
            <div class="modal-body">
                <div class="form-group">
                    <label>目录名称 <span style="color:#ef4444">*</span></label>
                    <input class="form-input" id="newSkillDirectory" required placeholder="请输入目录英文/中文名">
                </div>
                <p class="text-secondary" id="skillDirectoryParent" style="font-size:12px;margin:4px 0 0;"></p>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" type="button" onclick="closeSkillDirectory()">取消</button>
                <button class="btn-primary" type="submit">创建目录</button>
            </div>
        </form>
    </div>
</div>

<!-- 编辑技能信息弹窗 -->
<div id="skillInfoModal" class="modal">
    <div class="modal-content" style="max-width:640px;border-radius:18px;">
        <div class="modal-header">
            <h3>编辑技能信息</h3>
            <button class="btn-ghost" type="button" onclick="closeSkillInfo()">✕</button>
        </div>
        <form onsubmit="event.preventDefault(); saveSkillInfo(this)">
            <div class="modal-body">
                <div class="form-group">
                    <label>技能标识</label>
                    <input class="form-input" id="editSkillName" readonly style="background:#f1f5f9;cursor:not-allowed;">
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input class="form-input" id="editSkillDisplayName">
                </div>
                <div class="form-group">
                    <label>用途说明 <span style="color:#ef4444">*</span></label>
                    <input class="form-input" id="editSkillDescription" required>
                </div>
                <div class="form-group">
                    <label>主提示词 <span style="color:#ef4444">*</span></label>
                    <textarea class="form-textarea" id="editSkillBody" required rows="9"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" type="button" onclick="closeSkillInfo()">取消</button>
                <button class="btn-primary" type="submit">保存信息</button>
            </div>
        </form>
    </div>
</div>

<!-- 删除技能弹窗 -->
<div id="skillDeleteModal" class="modal">
    <div class="modal-content" style="max-width:480px;border-radius:18px;">
        <div class="modal-header">
            <h3>删除技能</h3>
            <button class="btn-ghost" type="button" onclick="closeSkillDelete()">✕</button>
        </div>
        <form onsubmit="event.preventDefault(); deleteSkill(this)">
            <div class="modal-body">
                <input type="hidden" id="deleteSkillName">
                <p id="skillDeleteDescription" style="font-size:14px;font-weight:600;color:#0f172a;margin:0 0 8px;"></p>
                <p style="color:#ef4444;font-size:13px;margin:0;">此操作将永久删除整个技能目录及全部子文件，无法恢复。</p>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" type="button" onclick="closeSkillDelete()">取消</button>
                <button class="btn-danger" type="submit">确认删除</button>
            </div>
        </form>
    </div>
</div>

<!-- 文件在线编辑器弹窗 -->
<div id="skillModal" class="modal modal-169">
    <div class="modal-content modal-169-content" style="border-radius:18px;">
        <div class="modal-header">
            <h3 id="skillModalTitle">编辑技能文件</h3>
            <button class="btn-ghost" type="button" onclick="closeSkillModal()">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;min-height:0;padding:20px 24px;">
            <input type="hidden" id="skillName"><input type="hidden" id="skillPath">
            <p class="text-secondary" id="skillEditorPath" style="font-size:13px;margin:0 0 10px;"></p>
            <textarea id="skillRaw" class="form-textarea" spellcheck="false" style="flex:1;min-height:420px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;border-radius:12px;padding:14px 16px;"></textarea>
        </div>
        <div class="modal-footer">
            <button class="btn-secondary" type="button" onclick="closeSkillModal()">取消</button>
            <button class="btn-primary" type="button" onclick="saveSkill()">保存</button>
        </div>
    </div>
</div>

<script>
let adminSkills = [];
let skillExplorer = { name: '', path: '' };

function skillEsc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function parseSkillApiResponse(response) {
    const text = await response.text();
    if (!text.trim()) throw new Error('技能接口返回了空响应（HTTP ' + response.status + '）');
    try { return JSON.parse(text); }
    catch (error) { throw new Error('技能接口返回了无效 JSON（HTTP ' + response.status + '）'); }
}

async function skillApi(query, options) {
    const response = await fetch('api/skills.php' + query, Object.assign({headers:{Authorization:'Bearer ' + token},cache:'no-store'}, options || {}));
    const result = await parseSkillApiResponse(response);
    if (!response.ok || !result.success) throw new Error(result.error || result.message || '技能操作失败');
    return result.data || {};
}

async function loadSkills() {
    const list = document.getElementById('skillFileList');
    try {
        const data = await skillApi('?action=list');
        adminSkills = data.skills || [];
        skillExplorer = { name: '', path: '' };
        renderSkillRoot();
    } catch (error) {
        list.innerHTML = `<tr><td colspan="5" class="skill-file-empty" style="text-align:center;padding:48px;color:#ef4444;">${skillEsc(error.message)}</td></tr>`;
    }
}

function renderSkillRoot() {
    skillExplorer = { name: '', path: '' };
    renderSkillBreadcrumb();
    renderSkillEntries(adminSkills.map(function(skill) {
        return { name: skill.name, path: skill.name, type: 'directory', display_name: skill.display_name, description: skill.description, can_edit_info: skill.can_edit_info, can_delete: skill.can_delete };
    }), true);
}

async function browseSkill(name, path) {
    const list = document.getElementById('skillFileList');
    list.innerHTML = `<tr><td colspan="5" class="skill-file-empty" style="text-align:center;padding:48px;color:#94a3b8;">加载中...</td></tr>`;
    try {
        const query = '?action=browse&name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(path || '');
        const data = await skillApi(query);
        skillExplorer = { name: name, path: data.directory.path || '' };
        renderSkillBreadcrumb();
        renderSkillEntries(data.directory.entries || [], false);
    } catch (error) {
        list.innerHTML = `<tr><td colspan="5" class="skill-file-empty" style="text-align:center;padding:48px;color:#ef4444;">${skillEsc(error.message)}</td></tr>`;
    }
}

function renderSkillBreadcrumb() {
    document.getElementById('skillCreateButton').hidden = !!skillExplorer.name;
    document.getElementById('skillDirectoryButton').hidden = !skillExplorer.name;
    document.getElementById('skillUploadButton').hidden = !skillExplorer.name;
    document.getElementById('skillFolderButton').textContent = skillExplorer.name ? '上传文件夹' : '导入技能文件夹';
    document.getElementById('skillDropHint').textContent = skillExplorer.name
        ? '可拖入 Markdown 文件或资料文件夹，保留子目录；不支持的文件会跳过并提示。双击文件可编辑。'
        : '可拖入含 SKILL.md 的完整技能文件夹；不支持的文件会跳过并提示。双击技能文件夹进入。';
    const breadcrumb = document.getElementById('skillBreadcrumb');
    breadcrumb.textContent = '';
    breadcrumb.style.display = skillExplorer.name ? 'inline-flex' : 'none';
    if (!skillExplorer.name) {
        document.getElementById('skillExplorerUp').disabled = true;
        return;
    }

    const homeIcon = document.createElement('span');
    homeIcon.className = 'skill-breadcrumb-home-icon';
    homeIcon.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
    breadcrumb.appendChild(homeIcon);

    const root = document.createElement('button');
    root.type = 'button';
    root.textContent = '技能';
    root.disabled = !skillExplorer.name;
    root.onclick = renderSkillRoot;
    breadcrumb.appendChild(root);

    const pieces = [skillExplorer.name].concat(skillExplorer.path ? skillExplorer.path.split('/') : []);
    pieces.forEach(function(piece, index) {
        const separator = document.createElement('span');
        separator.className = 'skill-breadcrumb-separator';
        separator.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
        breadcrumb.appendChild(separator);

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = piece;
        const relativeIndex = index - 1;
        button.disabled = index === pieces.length - 1;
        button.onclick = function() {
            browseSkill(skillExplorer.name, relativeIndex < 0 ? '' : pieces.slice(1, index + 1).join('/'));
        };
        breadcrumb.appendChild(button);
    });
    document.getElementById('skillExplorerUp').disabled = !skillExplorer.name;
}

window.copySkillPath = function(event, path) {
    event.stopPropagation();
    navigator.clipboard.writeText(path).then(() => {
        showAlert('success', '路径已复制到剪贴板: ' + path);
    }).catch(() => {
        showAlert('error', '复制失败');
    });
};

function renderSkillEntries(entries, root) {
    const list = document.getElementById('skillFileList');
    list.innerHTML = '';
    if (!entries.length) {
        list.innerHTML = `<tr><td colspan="5" class="skill-file-empty" style="text-align:center;padding:48px;color:#94a3b8;">此文件夹为空</td></tr>`;
        return;
    }
    entries.forEach(function(entry) {
        const tr = document.createElement('tr');
        tr.className = 'skill-file-row skill-row-tr';
        tr.tabIndex = 0;
        tr.setAttribute('role', 'option');
        if (entry.description) tr.classList.add('has-desc');
        if (root) tr.classList.add('skill-root-row');

        const isDir = entry.type === 'directory';
        const displayName = entry.display_name || entry.name;
        const fullRelPath = (root ? 'skills / ' + entry.name : (skillExplorer.name + (skillExplorer.path ? '/' + skillExplorer.path : '') + '/' + entry.name));

        // 1. 技能名称
        const nameTd = document.createElement('td');
        const folderSvg = `
            <svg class="skill-folder-svg" width="22" height="22" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>`;
        const fileSvg = `
            <svg class="skill-file-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>`;
        nameTd.innerHTML = `
            <div class="skill-name-cell">
                ${isDir ? folderSvg : fileSvg}
                <span class="skill-file-name" style="font-weight:600;color:#0f172a;">${skillEsc(displayName)}</span>
            </div>`;
        tr.appendChild(nameTd);

        // 2. 类型
        const kindTd = document.createElement('td');
        kindTd.innerHTML = `
            <span class="skill-kind-badge">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span class="skill-file-kind">${isDir ? '文件夹' : 'Markdown'}</span>
            </span>`;
        tr.appendChild(kindTd);

        // 3. 路径
        const pathTd = document.createElement('td');
        const pathSegments = fullRelPath.split(/[\/\\]+/).map(s => s.trim()).filter(Boolean);
        let pathHtml = `
            <div class="skill-path-capsule">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                <span style="color:#94a3b8;font-size:11px;">/</span>`;
        pathSegments.forEach((seg, idx) => {
            if (idx > 0) pathHtml += `<span style="color:#cbd5e1;font-size:10px;">&gt;</span>`;
            pathHtml += `<span class="skill-path-part">${skillEsc(seg)}</span>`;
        });
        pathHtml += `
                <button type="button" class="skill-path-copy-btn" title="复制路径" onclick="copySkillPath(event, '${skillEsc(fullRelPath.replace(/ \/ /g, '/'))}')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                </button>
            </div>`;
        pathTd.innerHTML = pathHtml;
        tr.appendChild(pathTd);

        // 4. 说明
        const descTd = document.createElement('td');
        const descText = entry.size == null ? (entry.description || '—') : formatSkillSize(entry.size);
        descTd.innerHTML = `<div class="skill-desc-cell skill-file-size ${entry.size == null && entry.description ? 'skill-file-desc' : ''}" title="${skillEsc(descText)}">${skillEsc(descText)}</div>`;
        tr.appendChild(descTd);

        // 5. 操作
        const actionsTd = document.createElement('td');
        actionsTd.style.textAlign = 'right';
        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'skill-actions-cell skill-row-actions';

        if (root) {
            if (entry.can_edit_info) {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'btn-skill-edit btn-secondary';
                editBtn.innerHTML = `
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    编辑信息`;
                editBtn.onclick = function(e) { e.stopPropagation(); openSkillInfo(entry.name); };
                editBtn.ondblclick = function(e) { e.stopPropagation(); };
                actionsWrap.appendChild(editBtn);
            }
            if (entry.can_delete) {
                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn-skill-delete btn-danger';
                delBtn.innerHTML = `
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    删除`;
                delBtn.onclick = function(e) { e.stopPropagation(); openSkillDelete(entry); };
                delBtn.ondblclick = function(e) { e.stopPropagation(); };
                actionsWrap.appendChild(delBtn);
            }
        }
        actionsTd.appendChild(actionsWrap);
        tr.appendChild(actionsTd);

        const open = function() {
            if (skillUploadBusy) return;
            if (root) browseSkill(entry.name, '');
            else if (entry.type === 'directory') browseSkill(skillExplorer.name, entry.path);
            else openSkillFile(skillExplorer.name, entry.path);
        };
        tr.addEventListener('dblclick', open);
        tr.addEventListener('keydown', function(event) { if (event.key === 'Enter') open(); });
        list.appendChild(tr);
    });
}

function formatSkillSize(bytes) { return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB'; }

function skillGoUp() {
    if (!skillExplorer.name) return;
    if (!skillExplorer.path) { skillExplorer = {name:'',path:''}; renderSkillRoot(); return; }
    const parts = skillExplorer.path.split('/'); parts.pop(); browseSkill(skillExplorer.name, parts.join('/'));
}

async function openSkillFile(name, path) {
    try {
        const data = await skillApi('?action=read&name=' + encodeURIComponent(name) + '&path=' + encodeURIComponent(path));
        const file = data.file;
        document.getElementById('skillName').value = name;
        document.getElementById('skillPath').value = file.path;
        document.getElementById('skillRaw').value = file.raw || '';
        document.getElementById('skillEditorPath').textContent = name + '/' + file.path;
        document.getElementById('skillModalTitle').textContent = '编辑 ' + file.path.split('/').pop();
        document.getElementById('skillModal').classList.add('show');
    } catch (error) { showAlert('error', error.message); }
}

function closeSkillModal() { document.getElementById('skillModal').classList.remove('show'); }

function openSkillCreate() { document.querySelector('#skillCreateModal form').reset(); document.getElementById('skillCreateModal').classList.add('show'); document.getElementById('newSkillName').focus(); }
function closeSkillCreate() { document.getElementById('skillCreateModal').classList.remove('show'); }
function openSkillDirectory() { document.querySelector('#skillDirectoryModal form').reset(); document.getElementById('skillDirectoryParent').textContent = skillExplorer.name + '/' + skillExplorer.path; document.getElementById('skillDirectoryModal').classList.add('show'); document.getElementById('newSkillDirectory').focus(); }
function closeSkillDirectory() { document.getElementById('skillDirectoryModal').classList.remove('show'); }
async function skillPost(input) { return skillApi('', {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token},body:JSON.stringify(input)}); }
async function refreshSkillList(location) {
    const data = await skillApi('?action=list'); adminSkills = data.skills || [];
    if (location && location.name && adminSkills.some(skill => skill.name === location.name)) await browseSkill(location.name, location.path);
    else renderSkillRoot();
}
async function openSkillInfo(name) {
    try {
        const data = await skillApi('?action=detail&name=' + encodeURIComponent(name)), skill = data.skill;
        document.getElementById('editSkillName').value = skill.name;
        document.getElementById('editSkillDisplayName').value = skill.display_name;
        document.getElementById('editSkillDescription').value = skill.description;
        document.getElementById('editSkillBody').value = skill.body;
        document.getElementById('skillInfoModal').classList.add('show'); document.getElementById('editSkillDisplayName').focus();
    } catch (error) { showAlert('error', error.message); }
}
function closeSkillInfo() { if (!document.querySelector('#skillInfoModal [type=submit]').disabled) document.getElementById('skillInfoModal').classList.remove('show'); }
async function saveSkillInfo(form) {
    const button = form.querySelector('[type=submit]'), location = Object.assign({}, skillExplorer); button.disabled = true;
    try {
        await skillPost({action:'update_info',name:document.getElementById('editSkillName').value,display_name:document.getElementById('editSkillDisplayName').value.trim(),description:document.getElementById('editSkillDescription').value.trim(),body:document.getElementById('editSkillBody').value});
        document.getElementById('skillInfoModal').classList.remove('show'); await refreshSkillList(location); showAlert('success', '技能信息已更新');
    } catch (error) { showAlert('error', error.message); } finally { button.disabled = false; }
}
function openSkillDelete(skill) {
    document.getElementById('deleteSkillName').value = skill.name;
    document.getElementById('skillDeleteDescription').textContent = '确定删除“' + (skill.display_name || skill.name) + '”（' + skill.name + '）吗？';
    document.getElementById('skillDeleteModal').classList.add('show');
}
function closeSkillDelete() { if (!document.querySelector('#skillDeleteModal [type=submit]').disabled) document.getElementById('skillDeleteModal').classList.remove('show'); }
async function deleteSkill(form) {
    const button = form.querySelector('[type=submit]'), location = Object.assign({}, skillExplorer); button.disabled = true;
    try {
        await skillPost({action:'delete',name:document.getElementById('deleteSkillName').value});
        document.getElementById('skillDeleteModal').classList.remove('show'); await refreshSkillList(location); showAlert('success', '技能及全部子文件已删除');
    } catch (error) { showAlert('error', error.message); await refreshSkillList(location).catch(function() {}); } finally { button.disabled = false; }
}
async function createSkill(form) {
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    try {
        const data = await skillPost({action:'create',name:document.getElementById('newSkillName').value.trim(),display_name:document.getElementById('newSkillDisplayName').value.trim(),description:document.getElementById('newSkillDescription').value.trim(),body:document.getElementById('newSkillBody').value});
        closeSkillCreate(); await loadSkills(); await browseSkill(data.skill.name, ''); showAlert('success', '技能已创建，可上传 Markdown 提示词');
    } catch (error) { showAlert('error', error.message); } finally { button.disabled = false; }
}
async function createSkillDirectory(form) {
    const button = form.querySelector('[type=submit]'); button.disabled = true;
    const location = Object.assign({}, skillExplorer), leaf = document.getElementById('newSkillDirectory').value.trim();
    try {
        if (!leaf || /[\\/]/.test(leaf)) throw new Error('请输入单个目录名称');
        await skillPost({action:'mkdir',name:location.name,path:(location.path ? location.path + '/' : '') + leaf});
        closeSkillDirectory(); await browseSkill(location.name, location.path); showAlert('success', '目录已创建');
    } catch (error) { showAlert('error', error.message); } finally { button.disabled = false; }
}
async function saveSkill() {
    const button = document.querySelector('#skillModal .btn-primary'), location = Object.assign({}, skillExplorer); button.disabled = true;
    try {
        const response = await fetch('api/skills.php', {method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token}, body:JSON.stringify({action:'save',name:document.getElementById('skillName').value,path:document.getElementById('skillPath').value,raw:document.getElementById('skillRaw').value})});
        const result = await parseSkillApiResponse(response);
        if (!response.ok || !result.success) throw new Error(result.error || result.message || '保存失败');
        closeSkillModal(); await refreshSkillList(location); showAlert('success', '技能文件已保存');
    } catch (error) { showAlert('error', error.message); } finally { button.disabled = false; }
}
</script>
<script src="assets/skills-upload.js"></script>
