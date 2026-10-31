<div id="announcementsSection" class="content-section">
    <div class="announcement-wrap">
        <!-- 顶部卡片：公告管理与列表 -->
        <div class="announcement-card announcement-top-card">
            <div class="announcement-header">
                <div class="announcement-header-left">
                    <div class="announcement-icon-badge">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                        </svg>
                    </div>
                    <div>
                        <h2 class="announcement-title">公告管理</h2>
                        <p class="announcement-subtitle">管理全端弹窗公告与系统推送，支持图文混排与草稿修订机制。</p>
                    </div>
                </div>
                <div class="announcement-header-actions">
                    <button type="button" class="btn-an-primary" id="announcementNew">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        新增公告
                    </button>
                    <button type="button" class="btn-an-secondary" id="announcementReload">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                        刷新列表
                    </button>
                </div>
            </div>

            <div class="announcement-tip-bar">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <span>保存仅更新草稿，点击「保存并发布」后客户端才会收到弹窗提醒。拖动图文块左侧手柄调整顺序。</span>
            </div>

            <!-- 公告列表 -->
            <div id="announcementList" class="announcement-list-container"></div>
        </div>

        <!-- 底部卡片：公告图文编辑器 -->
        <div class="announcement-card announcement-editor-card">
            <form id="announcementEditor" class="announcement-editor-form">
                <div class="announcement-editor-header">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <div class="announcement-editor-icon-badge">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </div>
                        <div>
                            <h3 id="announcementEditorHeading" class="announcement-editor-title">新增公告</h3>
                            <p class="announcement-editor-sub">编辑公告标题与正文图文块，完成后可实时预览或发布</p>
                        </div>
                    </div>
                    <p id="announcementEditorStatus" role="status" class="announcement-status-badge"></p>
                </div>

                <div class="announcement-form-group">
                    <label class="announcement-form-label">公告标题 <span class="req-star">*</span></label>
                    <input id="announcementTitle" class="announcement-title-input" maxlength="200" placeholder="请输入公告标题..." required>
                </div>

                <div class="announcement-form-group">
                    <label class="announcement-form-label">图文内容块</label>
                    <div id="announcementBlocks" class="announcement-blocks-container"></div>
                </div>

                <div class="announcement-toolbar">
                    <div class="announcement-tools-left">
                        <button type="button" id="announcementAddText" class="btn-an-tool">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            添加文字
                        </button>
                        <label class="announcement-upload btn-an-tool">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                                <circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                            </svg>
                            添加图片
                            <input id="announcementImage" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" hidden>
                        </label>
                    </div>
                    <div class="announcement-tools-right">
                        <button type="button" id="announcementPreview" class="btn-an-preview">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                            </svg>
                            预览草稿
                        </button>
                        <button type="submit" class="btn-an-save">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                                <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                            </svg>
                            保存草稿
                        </button>
                        <button type="button" id="announcementPublish" class="btn-an-publish">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                            </svg>
                            保存并发布
                        </button>
                    </div>
                </div>
            </form>
        </div>
    </div>
</div>
<div id="announcementAdminPreview" class="membership-dialog-overlay" hidden>
    <section class="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="announcementPreviewTitle" tabindex="-1">
        <button type="button" class="membership-dialog-close" aria-label="关闭预览">×</button>
        <h2 id="announcementPreviewTitle"></h2><div class="announcement-content"></div>
        <div class="membership-dialog-actions"><button type="button" class="membership-dialog-primary">我知道了</button></div>
    </section>
</div>
<link rel="stylesheet" href="assets/system-dialog.css">
<link rel="stylesheet" href="assets/announcements.css">
<script src="assets/announcement-content.js"></script>
<script src="assets/announcements.js"></script>
