<?php
declare(strict_types=1);

/**
 * 内置主题编辑器（独立全页）。
 *
 * 为什么是独立页而不是弹窗：主题有 11 项配色 + 视觉参数 + 背景资源，弹窗里改完要保存才知道效果。
 * 这里左表单右预览，任何改动即时可见；从 dashboard 的「新增主题 / 编辑」用 window.open 打开。
 *
 * 鉴权：与 dashboard.php 同构——页面级只在客户端检查 localStorage.adminToken（缺了跳 login.php），
 * 真正的权限校验在 admin/api/builtin_themes.php（Bearer + edit_users）。本页不读 $_SESSION。
 */

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$moonyaAsset = static function (string $file): string {
    $path = __DIR__ . '/assets/' . $file;
    $stamp = is_file($path) ? (string)filemtime($path) : (string)time();
    return 'assets/' . $file . '?v=' . $stamp;
};
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>主题编辑器 · MoonYa 管理后台</title>
    <link rel="stylesheet" href="<?= htmlspecialchars($moonyaAsset('admin-ui.css'), ENT_QUOTES) ?>">
    <link rel="stylesheet" href="<?= htmlspecialchars($moonyaAsset('theme-editor.css'), ENT_QUOTES) ?>">
    <!-- 明暗基底变量块由 theme-editor.js 依据 theme-editor-base.js 的 BASE 表注入（单一数据源） -->
    <style id="teBaseStyle"></style>
</head>
<body class="admin-body te-body">
    <div id="teAlert" class="alert" role="status" aria-live="polite"></div>

    <header class="te-topbar">
        <div class="te-topbar-left">
            <button type="button" class="te-icon-btn" id="teBack" title="返回主题列表" aria-label="返回主题列表">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>
                </svg>
            </button>
            <div class="te-topbar-text">
                <h1 class="te-title" id="teTitle">新增主题</h1>
                <p class="te-subtitle" id="teSubtitle">改动会即时出现在右侧预览中</p>
            </div>
        </div>
        <div class="te-topbar-right">
            <span class="te-dirty" id="teDirty" hidden>有未保存的改动</span>
            <button type="button" class="btn-secondary" id="teReturn">返回列表</button>
            <button type="button" class="btn-primary" id="teSave">保存主题</button>
        </div>
    </header>

    <main class="te-layout">
        <!-- ── 左：表单 ─────────────────────────────────────── -->
        <div class="te-form" id="teForm">
            <section class="te-card">
                <h2 class="te-card-title">基本信息</h2>
                <p class="te-card-sub">标识用于客户端本地缓存目录（<code>.moonya/appearance/themes/&lt;slug&gt;/</code>），创建后不再可变</p>
                <div class="te-grid">
                    <div class="te-field">
                        <label for="teSlug">主题标识 slug</label>
                        <input class="form-input" id="teSlug" type="text" placeholder="如 ys-muou" maxlength="64" spellcheck="false" autocomplete="off">
                        <span class="te-field-hint" id="teSlugHint">小写字母 / 数字 / - / _</span>
                    </div>
                    <div class="te-field">
                        <label for="teName">主题名称</label>
                        <input class="form-input" id="teName" type="text" placeholder="如 原神木偶" maxlength="64">
                        <span class="te-field-hint">1-64 个字符，客户端「全部主题」里显示这个名字</span>
                    </div>
                    <div class="te-field te-field-full">
                        <label for="teSummary">说明</label>
                        <input class="form-input" id="teSummary" type="text" placeholder="简要说明此主题的设计风格…" maxlength="200">
                    </div>
                    <div class="te-field">
                        <label for="teSort">排序</label>
                        <input class="form-input" id="teSort" type="number" step="1">
                        <span class="te-field-hint">越小越靠前</span>
                    </div>
                    <div class="te-field">
                        <label for="teEnabled">上架状态</label>
                        <label class="te-switch">
                            <input type="checkbox" id="teEnabled">
                            <span class="te-switch-track"><span class="te-switch-thumb"></span></span>
                            <span class="te-switch-text" id="teEnabledText">已上架</span>
                        </label>
                        <span class="te-field-hint">下架后客户端目录里不再出现，已下载的本地缓存不清理</span>
                    </div>
                </div>
            </section>

            <section class="te-card">
                <h2 class="te-card-title">外观参数</h2>
                <p class="te-card-sub">拖动即时生效，可直接对照右侧预览</p>
                <div class="te-slider-row">
                    <label class="te-slider-label" for="teBlur">毛玻璃模糊</label>
                    <input type="range" class="te-range" id="teBlur" min="0" max="60" step="1">
                    <span class="te-range-value" id="teBlurValue">0px</span>
                </div>
                <div class="te-slider-row">
                    <label class="te-slider-label" for="teOpacity">界面不透明度</label>
                    <input type="range" class="te-range" id="teOpacity" min="0.2" max="1" step="0.05">
                    <span class="te-range-value" id="teOpacityValue">0.85</span>
                </div>
                <p class="te-note">不透明度只在设置了背景资源时看得见：数值越低，界面越透出背景。</p>
            </section>

            <section class="te-card">
                <h2 class="te-card-title">背景资源</h2>
                <p class="te-card-sub">图片或视频，最大 64MB；更换资源会让客户端重新下载</p>
                <div class="te-grid">
                    <div class="te-field">
                        <label>背景类型</label>
                        <div class="te-seg" role="group" aria-label="背景类型" data-field="kind">
                            <button type="button" class="te-seg-btn" data-kind="image">图片</button>
                            <button type="button" class="te-seg-btn" data-kind="video">视频</button>
                        </div>
                    </div>
                    <div class="te-field">
                        <label>填充方式</label>
                        <div class="te-seg" role="group" aria-label="填充方式" data-field="fill">
                            <button type="button" class="te-seg-btn" data-fill="cover">cover</button>
                            <button type="button" class="te-seg-btn" data-fill="contain">contain</button>
                            <button type="button" class="te-seg-btn" data-fill="fill">fill</button>
                        </div>
                    </div>
                </div>
                <div class="te-drop" id="teDrop">
                    <input type="file" id="teFile" accept="image/*,video/*" hidden>
                    <div class="te-drop-inner">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="17 8 12 3 7 8"></polyline>
                            <line x1="12" y1="3" x2="12" y2="15"></line>
                        </svg>
                        <div class="te-drop-text">
                            <strong>拖拽文件到此处</strong>
                            <span>或 <button type="button" class="te-link" id="tePick">选择本地文件</button>（未上传前也能在预览里看到效果）</span>
                        </div>
                    </div>
                    <div class="te-progress" id="teProgress" hidden><i id="teBar"></i></div>
                </div>
                <p class="te-asset-status" id="teAssetStatus">尚未上传背景资源</p>
            </section>

            <section class="te-card">
                <div class="te-card-head">
                    <div>
                        <h2 class="te-card-title">配色方案</h2>
                        <p class="te-card-sub">留空的项跟随客户端明暗基底；填了就固定成这个颜色（明暗切换时不变）</p>
                    </div>
                    <div class="te-scheme-actions">
                        <button type="button" class="btn-secondary te-btn-sm" id="teSchemeLight">应用浅色</button>
                        <button type="button" class="btn-secondary te-btn-sm" id="teSchemeDark">应用深色</button>
                        <button type="button" class="btn-secondary te-btn-sm" id="teSchemeClear">全部跟随基底</button>
                    </div>
                </div>
                <div class="te-color-groups" id="teColorGroups"></div>
            </section>

            <section class="te-card te-card-quiet">
                <h2 class="te-card-title">保存后什么时候能看到</h2>
                <ul class="te-list">
                    <li>配色与视觉参数：客户端<b>下次启动</b>拉取主题目录时生效。</li>
                    <li>更换背景资源：资源版本号 <code>+1</code>，客户端会重新下载新资源。</li>
                    <li>已下载过的旧资源留在客户端本地，删除主题不会清理它。</li>
                </ul>
            </section>
        </div>

        <!-- ── 右：预览 ─────────────────────────────────────── -->
        <aside class="te-preview-panel">
            <div class="te-preview-head">
                <div>
                    <h2 class="te-preview-title">实时预览</h2>
                    <p class="te-preview-sub">与客户端同一套 CSS 变量的渲染规则</p>
                </div>
                <div class="te-seg" role="group" aria-label="预览基底">
                    <button type="button" class="te-seg-btn" data-base-view="light">浅色基底</button>
                    <button type="button" class="te-seg-btn" data-base-view="dark">深色基底</button>
                </div>
            </div>

            <div class="tp-preview" id="tePreview" data-base="light">
                <div class="tp-media-layer" id="teMediaLayer"></div>
                <div class="tp-app-shell">
                    <div class="tp-rail">
                        <span class="tp-rail-logo"></span>
                        <span class="tp-rail-dot is-active"></span>
                        <span class="tp-rail-dot"></span>
                        <span class="tp-rail-dot"></span>
                    </div>
                    <div class="tp-sidebar">
                        <div class="tp-sidebar-head">
                            <span class="tp-sidebar-title">会话</span>
                            <span class="tp-sidebar-add">+</span>
                        </div>
                        <div class="tp-conv is-active"><span class="tp-conv-dot"></span><span class="tp-conv-text">浅海幽蓝</span></div>
                        <div class="tp-conv"><span class="tp-conv-dot"></span><span class="tp-conv-text">原神木偶</span></div>
                        <div class="tp-conv"><span class="tp-conv-dot"></span><span class="tp-conv-text">深色极简</span></div>
                    </div>
                    <div class="tp-main">
                        <div class="tp-topbar">
                            <span class="tp-topbar-title">浅海幽蓝</span>
                            <span class="tp-topbar-tools"><i></i><i></i><i></i></span>
                        </div>
                        <div class="tp-thread">
                            <div class="tp-msg tp-msg-ai"><div class="tp-bubble">正文文字在主气泡里，次要说明跟在后面。</div></div>
                            <div class="tp-msg tp-msg-user"><div class="tp-bubble">强调色气泡</div></div>
                            <div class="tp-card">
                                <div class="tp-card-head"><span class="tp-card-title">卡片 / 面板</span><span class="tp-card-tag">surface</span></div>
                                <div class="tp-card-line"></div>
                                <div class="tp-card-line is-short"></div>
                            </div>
                        </div>
                        <div class="tp-composer">
                            <div class="tp-input-wrapper">
                                <span class="tp-input">输入消息…</span>
                                <span class="tp-send" aria-hidden="true">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                                        <line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>
                                    </svg>
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <p class="te-preview-note" id="tePreviewNote">未设置背景资源，界面按不透明渲染（与客户端一致）。</p>
        </aside>
    </main>

    <script src="<?= htmlspecialchars($moonyaAsset('theme-editor-base.js'), ENT_QUOTES) ?>"></script>
    <script src="<?= htmlspecialchars($moonyaAsset('theme-editor.js'), ENT_QUOTES) ?>"></script>
</body>
</html>
