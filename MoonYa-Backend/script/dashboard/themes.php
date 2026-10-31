<div id="themesSection" class="content-section">
    <style>
        #themesSection {
            --bt-primary: #2563eb;
            --bt-border: #e2e8f0;
            --bt-muted: #64748b;
        }
        #themesSection .bt-wrap { display: flex; flex-direction: column; gap: 20px; }
        #themesSection .bt-card {
            background: #ffffff;
            border: 1px solid rgba(226, 232, 240, 0.85);
            border-radius: 20px;
            padding: 24px;
            box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.03);
        }
        #themesSection .bt-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 20px;
            flex-wrap: wrap;
            margin-bottom: 16px;
        }
        #themesSection .bt-head-left {
            display: flex;
            align-items: flex-start;
            gap: 16px;
            flex: 1;
            min-width: 280px;
        }
        #themesSection .bt-head-icon {
            width: 44px;
            height: 44px;
            border-radius: 12px;
            background: #eff6ff;
            color: #2563eb;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 2px;
        }
        #themesSection .bt-title {
            margin: 0 0 6px;
            font-size: 18px;
            font-weight: 700;
            color: #0f172a;
            letter-spacing: -0.01em;
        }
        #themesSection .bt-sub {
            margin: 0;
            color: #64748b;
            font-size: 13px;
            line-height: 1.65;
        }
        #themesSection .bt-sub code {
            background: #f1f5f9;
            color: #2563eb;
            padding: 2px 6px;
            border-radius: 6px;
            font-size: 12px;
            font-family: inherit;
        }
        #themesSection .bt-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
        #themesSection .btn-bt-primary {
            background: #2563eb !important;
            color: #ffffff !important;
            border: 1px solid #2563eb !important;
            border-radius: 10px !important;
            padding: 9px 18px !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            cursor: pointer !important;
            transition: background-color 0.15s ease, border-color 0.15s ease !important;
        }
        #themesSection .btn-bt-primary:hover {
            background: #1d4ed8 !important;
            border-color: #1d4ed8 !important;
        }
        #themesSection .btn-bt-outline {
            background: #ffffff !important;
            color: #334155 !important;
            border: 1px solid #cbd5e1 !important;
            border-radius: 10px !important;
            padding: 9px 16px !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            cursor: pointer !important;
            transition: all 0.15s ease !important;
        }
        #themesSection .btn-bt-outline:hover {
            background: #f8fafc !important;
            border-color: #94a3b8 !important;
            color: #0f172a !important;
        }
        #themesSection .bt-hint-bar {
            display: flex;
            align-items: center;
            gap: 10px;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 12px 16px;
            font-size: 12.5px;
            color: #475569;
            line-height: 1.5;
        }
        #themesSection .bt-hint-bar code {
            background: #e2e8f0;
            color: #1e293b;
            padding: 2px 6px;
            border-radius: 6px;
            font-size: 11.5px;
            font-family: inherit;
        }
        #themesSection .bt-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
            gap: 18px;
        }
        #themesSection .bt-item {
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            overflow: hidden;
            background: #ffffff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
            transition: all 0.2s ease;
            display: flex;
            flex-direction: column;
        }
        #themesSection .bt-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 24px -4px rgba(0, 0, 0, 0.08);
            border-color: #cbd5e1;
        }
        #themesSection .bt-thumb {
            height: 136px;
            background: #f8fafc center/cover no-repeat;
            display: grid;
            place-items: center;
            color: #94a3b8;
            font-size: 12px;
            position: relative;
            border-bottom: 1px solid #f1f5f9;
        }
        #themesSection .bt-meta {
            padding: 14px 16px 8px;
            flex: 1;
        }
        #themesSection .bt-name {
            font-size: 15px;
            font-weight: 700;
            color: #0f172a;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        #themesSection .bt-slug {
            color: #64748b;
            font-size: 12px;
            margin-top: 4px;
        }
        #themesSection .bt-swatches {
            display: flex;
            gap: 6px;
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px dashed #f1f5f9;
        }
        #themesSection .bt-swatch {
            width: 16px;
            height: 16px;
            border-radius: 5px;
            border: 1px solid rgba(0, 0, 0, 0.1);
            display: inline-block;
        }
        #themesSection .bt-btns {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
            padding: 10px 16px 14px;
            border-top: 1px solid #f8fafc;
            background: #fcfdfe;
        }
        #themesSection .bt-btns .btn-sm {
            padding: 5px 12px;
            font-size: 12px;
            border-radius: 8px;
            font-weight: 600;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            color: #334155;
            cursor: pointer;
            transition: all 0.15s;
        }
        #themesSection .bt-btns .btn-sm:hover {
            background: #f8fafc;
            border-color: #cbd5e1;
            color: #0f172a;
        }
        #themesSection .bt-btns .clean-btn-danger {
            background: #fee2e2 !important;
            border-color: #fecaca !important;
            color: #ef4444 !important;
        }
        #themesSection .bt-btns .clean-btn-danger:hover {
            background: #ef4444 !important;
            color: #ffffff !important;
        }
        /* 排序改为卡片内联输入，不再弹原生 prompt */
        #themesSection .bt-sort {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            margin-left: auto;
            font-size: 11.5px;
            font-weight: 600;
            color: #64748b;
        }
        #themesSection .bt-sort input {
            width: 56px;
            padding: 4px 6px;
            border: 1px solid #e2e8f0;
            border-radius: 7px;
            background: #ffffff;
            color: #0f172a;
            font: inherit;
            font-size: 12px;
            text-align: center;
            font-variant-numeric: tabular-nums;
        }
        #themesSection .bt-sort input:focus {
            outline: none;
            border-color: #2563eb;
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
        }
        #themesSection .bt-empty {
            padding: 60px 24px;
            text-align: center;
            color: #64748b;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }
        #themesSection .bt-flag {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 99px;
            font-size: 11px;
            font-weight: 600;
            margin-left: 6px;
        }
        #themesSection .bt-flag.on { background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
        #themesSection .bt-flag.off { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }

    </style>
    <div class="bt-wrap">
        <div class="bt-card">
            <div class="bt-head">
                <div class="bt-head-left">
                    <div class="bt-head-icon">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
                            <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
                            <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
                            <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
                            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
                        </svg>
                    </div>
                    <div>
                        <h2 class="bt-title">内置主题</h2>
                        <p class="bt-sub">
                            这里配置的主题会下发给所有客户端，出现在「设置 → 外观 → 全部主题」里。<br>
                            客户端首次使用某个主题时会下载背景图到本地 <code>.moonya/appearance/themes/</code>，之后完全离线可用。
                        </p>
                    </div>
                </div>
                <div class="bt-actions">
                    <button class="btn-bt-primary" title="在新标签页打开可视化编辑器（带实时预览）" onclick="window.builtinThemes.openEditor(null)">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        新增主题
                    </button>
                    <button class="btn-bt-outline" onclick="window.builtinThemes.exportConfig()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        导出到配置文件
                    </button>
                    <button class="btn-bt-outline" onclick="window.builtinThemes.importConfig()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                        从配置文件导入
                    </button>
                </div>
            </div>
            <div class="bt-hint-bar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>快捷修改：可直接编辑服务器上的 <code>config/builtin_themes.json</code>，其中 <code>updated_at</code> 晚于数据库（或留空）的条目会覆盖同名主题，无需重启。</span>
            </div>
        </div>
        <div class="bt-card">
            <div class="bt-grid" id="btGrid"></div>
            <div class="bt-empty" id="btEmpty" hidden>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>
                </svg>
                <div style="font-size:15px;font-weight:600;color:#0f172a;margin-top:4px">暂无内置主题</div>
                <div style="font-size:13px;color:#94a3b8">点击右上角「新增主题」开始定制您的第一款客户端外观主题</div>
            </div>
        </div>
    </div>
</div>

<script>
(function () {
    'use strict';
    const DEFAULT_COLORS = { appBackground: '#f1eff4', sidebar: '#fbfafd', surface: '#ffffff', accent: '#3b82f6', textPrimary: '#26272b' };
    let themes = [];

    function api(action, body) {
        const options = { method: body == null ? 'GET' : 'POST', headers: { 'Authorization': 'Bearer ' + token } };
        if (body != null) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        return fetch('api/builtin_themes.php?action=' + action, options).then(async response => {
            const payload = await response.json().catch(() => ({ success: false, error: '响应解析失败' }));
            if (!payload.success) throw new Error(payload.error || '请求失败');
            return payload.data;
        });
    }
    const esc = value => escapeHtml(String(value == null ? '' : value));
    const notifyError = error => showAlert('error', error.message || '操作失败');

    function swatches(colors) {
        return ['appBackground', 'sidebar', 'surface', 'accent'].map(key => {
            const value = (colors && colors[key]) || DEFAULT_COLORS[key] || '#ffffff';
            return '<i class="bt-swatch" style="background:' + esc(value) + '"></i>';
        }).join('');
    }

    function render() {
        const grid = document.getElementById('btGrid');
        const empty = document.getElementById('btEmpty');
        if (!grid) return;
        grid.innerHTML = themes.map(theme => {
            const thumb = theme.backgroundKey
                ? '<div class="bt-thumb" style="background-image:url(\'' + esc((theme.backgroundKind === 'image' ? thumbUrl(theme) : '')) + '\')">' + (theme.backgroundKind === 'video' ? '视频背景' : '') + '</div>'
                : '<div class="bt-thumb">未上传背景</div>';
            const flag = theme.enabled ? '<span class="bt-flag on">已上架</span>' : '<span class="bt-flag off">已下架</span>';
            return '<div class="bt-item">' + thumb +
                '<div class="bt-meta"><div class="bt-name">' + esc(theme.name) + flag + '</div>' +
                '<div class="bt-slug">' + esc(theme.slug) + ' · 排序 ' + theme.sortOrder + (theme.assetBytes ? ' · ' + Math.round(theme.assetBytes / 1024) + ' KB' : '') + '</div>' +
                '<div class="bt-swatches">' + swatches(theme.colors) + '</div></div>' +
                '<div class="bt-btns">' +
                '<button class="btn btn-sm" title="在新标签页打开可视化编辑器" onclick="window.builtinThemes.openEditor(' + theme.id + ')">编辑</button>' +
                '<button class="btn btn-sm" onclick="window.builtinThemes.toggle(' + theme.id + ',' + (theme.enabled ? 'false' : 'true') + ')">' + (theme.enabled ? '下架' : '上架') + '</button>' +
                '<label class="bt-sort" title="排序（越小越靠前），改完回车或失焦即生效">排序' +
                '<input type="number" step="1" value="' + Number(theme.sortOrder) + '" onchange="window.builtinThemes.setSort(' + theme.id + ', this)"></label>' +
                '<button class="btn btn-sm clean-btn-danger" onclick="window.builtinThemes.remove(' + theme.id + ',\'' + esc(theme.name).replace(/'/g, "\\'") + '\')">删除</button>' +
                '</div></div>';
        }).join('');
        empty.hidden = themes.length > 0;
    }

    function thumbUrl(theme) {
        // 后台是后端同源，直接用相对路径预览缩略图。
        if (theme.thumbKey) return '../uploads/themes/' + theme.thumbKey;
        return '../uploads/themes/' + theme.backgroundKey;
    }

    /**
     * 编辑/新增走独立的全页编辑器（带实时预览），新标签页打开——
     * 弹窗里改完才看到效果，是这次改版要解决的问题。
     * 保存后编辑器会写 localStorage 的 rev，本页靠 storage 事件自动刷新。
     */
    function openEditor(id) {
        const url = 'theme_editor.php' + (id == null ? '?id=new' : '?id=' + encodeURIComponent(id));
        const opened = window.open(url, '_blank', 'noopener');
        if (!opened) showAlert('error', '浏览器拦截了新标签页，请允许弹出窗口后重试');
    }

    async function load() {
        try {
            const data = await api('list', null);
            themes = data.themes || [];
            render();
        } catch (error) { notifyError(error); }
    }

    async function toggle(id, enabled) {
        try { await api(enabled ? 'publish' : 'unpublish', { id }); await load(); }
        catch (error) { notifyError(error); }
    }

    /** 卡片内联排序：即改即存，不再弹原生 prompt。 */
    function setSort(id, input) {
        const next = Number(input.value);
        const theme = themes.find(item => item.id === id);
        if (Number.isNaN(next) || !theme || next === theme.sortOrder) {
            if (theme) input.value = theme.sortOrder;
            return;
        }
        input.disabled = true;
        void api('sort', { id, sortOrder: next }).then(load).catch(error => {
            input.disabled = false;
            input.value = theme.sortOrder;
            notifyError(error);
        });
    }

    function remove(id, name) {
        const html = '<div class="clean-dialog confirm-dialog">' +
            '<div class="clean-dialog-header">' +
            '  <div class="confirm-header-main">' +
            '    <div class="confirm-header-icon confirm-badge-danger">' +
            '      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' +
            '      </svg>' +
            '    </div>' +
            '    <div><h3 class="confirm-header-title">删除主题</h3><p class="confirm-header-sub">此操作将移除该主题</p></div>' +
            '  </div>' +
            '  <button type="button" class="clean-dialog-close" onclick="hideModal()" aria-label="关闭">' +
            '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '  </button>' +
            '</div>' +
            '<div class="confirm-dialog-body">' +
            '  确定删除主题「<strong>' + esc(name) + '</strong>」？客户端已下载的本地缓存不会被清理，但主题会从列表消失。' +
            '  <div class="confirm-callout confirm-callout-danger">' +
            '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' +
            '    </svg>' +
            '    <div><strong>警告：</strong>此操作不可撤销。主题将从展示列表中移除。</div>' +
            '  </div>' +
            '</div>' +
            '<div class="clean-dialog-footer">' +
            '  <button type="button" class="confirm-btn-cancel" onclick="hideModal()">取消</button>' +
            '  <button type="button" class="confirm-btn-danger" id="btDelOk">' +
            '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '    确认删除' +
            '  </button>' +
            '</div></div>';
        showModal(html, { cleanDialog: true });
        const btn = document.getElementById('btDelOk');
        if (btn) {
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = '删除中...';
                try {
                    await api('delete', { id });
                    hideModal();
                    await load();
                    showAlert('success', '已删除');
                } catch (error) {
                    hideModal();
                    notifyError(error);
                }
            };
        }
    }

    function exportConfig() {
        const html = '<div class="clean-dialog confirm-dialog">' +
            '<div class="clean-dialog-header">' +
            '  <div class="confirm-header-main">' +
            '    <div class="confirm-header-icon confirm-badge-success">' +
            '      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' +
            '      </svg>' +
            '    </div>' +
            '    <div><h3 class="confirm-header-title">导出到配置文件</h3><p class="confirm-header-sub">将当前数据库主题导出到服务器配置</p></div>' +
            '  </div>' +
            '  <button type="button" class="clean-dialog-close" onclick="hideModal()" aria-label="关闭">' +
            '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '  </button>' +
            '</div>' +
            '<div class="confirm-dialog-body">' +
            '  将当前数据库中的所有内置主题全量导出并写入服务器 <code>config/builtin_themes.json</code> 快照。' +
            '  <div class="confirm-callout confirm-callout-info">' +
            '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' +
            '    </svg>' +
            '    <div>写出后，服务器配置文件将被覆盖为最新版本，可随时使用「从配置文件导入」重新同步或恢复。</div>' +
            '  </div>' +
            '</div>' +
            '<div class="clean-dialog-footer">' +
            '  <button type="button" class="confirm-btn-cancel" onclick="hideModal()">取消</button>' +
            '  <button type="button" class="confirm-btn-primary" id="btExpOk">' +
            '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
            '    确认导出' +
            '  </button>' +
            '</div></div>';
        showModal(html, { cleanDialog: true });
        const btn = document.getElementById('btExpOk');
        if (btn) {
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = '导出中...';
                try {
                    const result = await api('export_config', {});
                    hideModal();
                    showAlert('success', '已成功导出 ' + result.written + ' 个主题到 ' + result.path);
                } catch (error) {
                    hideModal();
                    notifyError(error);
                }
            };
        }
    }

    function importConfig() {
        const html = '<div class="clean-dialog confirm-dialog">' +
            '<div class="clean-dialog-header">' +
            '  <div class="confirm-header-main">' +
            '    <div class="confirm-header-icon confirm-badge-info">' +
            '      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>' +
            '      </svg>' +
            '    </div>' +
            '    <div><h3 class="confirm-header-title">从配置文件导入</h3><p class="confirm-header-sub">将配置文件主题同步回数据库</p></div>' +
            '  </div>' +
            '  <button type="button" class="clean-dialog-close" onclick="hideModal()" aria-label="关闭">' +
            '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '  </button>' +
            '</div>' +
            '<div class="confirm-dialog-body">' +
            '  将读取服务器上的 <code>config/builtin_themes.json</code> 的内容写回数据库。' +
            '  <div class="confirm-callout confirm-callout-warning">' +
            '    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' +
            '    </svg>' +
            '    <div><strong>注意：</strong>会覆盖数据库中同标识（slug）的主题配置。数据库中未导出的修改可能会丢失。</div>' +
            '  </div>' +
            '</div>' +
            '<div class="clean-dialog-footer">' +
            '  <button type="button" class="confirm-btn-cancel" onclick="hideModal()">取消</button>' +
            '  <button type="button" class="confirm-btn-primary" id="btImpOk">' +
            '    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
            '    确认导入' +
            '  </button>' +
            '</div></div>';
        showModal(html, { cleanDialog: true });
        const btn = document.getElementById('btImpOk');
        if (btn) {
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = '导入中...';
                try {
                    const result = await api('import_config', {});
                    hideModal();
                    await load();
                    showAlert('success', '已导入 ' + result.imported + ' 个主题');
                } catch (error) {
                    hideModal();
                    notifyError(error);
                }
            };
        }
    }

    /**
     * 编辑器在另一个标签页里改数据，本页不会自己知道。
     * storage 事件天然只在「其它标签页」触发，正好命中这个场景；
     * focus 兜底（部分浏览器对同源 storage 事件的派发时机不一致）。
     */
    function refreshIfActive() {
        const section = document.getElementById('themesSection');
        if (section && section.classList.contains('active')) void load();
    }
    window.addEventListener('storage', event => {
        if (event.key === 'moonya.builtinThemes.rev') refreshIfActive();
    });
    window.addEventListener('focus', refreshIfActive);

    window.builtinThemes = { load, openEditor, toggle, setSort, remove, exportConfig, importConfig };
})();
</script>
