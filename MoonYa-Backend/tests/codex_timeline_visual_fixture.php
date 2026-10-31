<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Codex Timeline Visual Fixture</title>
    <style>
<?php require dirname(__DIR__) . '/script/MoonYa-index/styles/css-01-base.php'; ?>
<?php require dirname(__DIR__) . '/script/MoonYa-index/styles/css-06-main.php'; ?>
<?php require dirname(__DIR__) . '/script/MoonYa-index/styles/css-16-agent-experience.php'; ?>
        body { background: #fff; }
        .messages-container { width: min(900px, 100%); margin: 0 auto; padding: 28px 0 80px; overflow: visible; }
        .fixture-title { padding: 0 20px 18px; color: #999; font: 12px/20px system-ui, sans-serif; }
    </style>
</head>
<body>
<main class="messages-container">
    <div class="fixture-title">Codex 时间线视觉回归</div>
    <div class="message user"><div class="message-content">请完成评论系统实现，并运行验证。</div></div>
    <div class="turn-process codex-turn-trace is-complete" data-open="1">
        <button type="button" class="turn-process-header codex-turn-header" data-open="1" aria-expanded="true">
            <span class="turn-process-label">用时 51分56秒</span>
            <span class="turn-process-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
        </button>
        <div class="turn-process-body codex-trace-body">
            <p class="codex-commentary">我开始按确认后的方案实施。先落后端数据模型、权限和接口，再接管理面板与 APP 评论区，最后跑三端类型检查、构建和后端集成验证。</p>
            <section class="codex-activity-group" data-open="1">
                <button type="button" class="codex-activity-header" aria-expanded="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h16M6 16l10-10 2 2L8 18l-3 1z"/></svg>
                    <span class="codex-activity-label">编辑了 7 文件 运行了 3 命令</span>
                    <span class="codex-activity-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
                </button>
                <div class="codex-activity-list">
                    <div class="tool-row" data-state="success"><div class="codex-tool-main"><span class="tool-row-leading">✎</span><span class="tool-row-title">已编辑</span><span class="tool-row-summary codex-file-link">CommentServiceImpl.java +42 -8</span><span class="codex-tool-chevron"></span></div></div>
                    <div class="tool-row has-detail" data-state="success" data-open="1"><div class="codex-tool-main" role="button" tabindex="0" aria-expanded="true"><span class="tool-row-leading">⌘</span><span class="tool-row-title">已运行</span><span class="tool-row-summary">npm run typecheck</span><span class="codex-tool-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span></div><div class="codex-tool-detail"><div class="codex-tool-detail-title">Shell</div><pre class="codex-command">$ npm run typecheck</pre><pre class="codex-command-output">&gt; moonya@1.0.0 typecheck&#10;&gt; vue-tsc --noEmit -p tsconfig.json</pre><div class="codex-tool-detail-status">✓ 成功 · exit 0</div></div></div>
                </div>
            </section>
            <div class="codex-system-activity"><span class="codex-system-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m4 17 5-5 4 4 2-2 5 4"/></svg></span><span>已查看 1 张图像</span></div>
            <div class="codex-system-activity"><span class="codex-system-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg></span><span>上下文已自动压缩</span></div>
        </div>
    </div>
    <div class="message ai codex-final-answer"><div class="message-content"><p>已完成评论系统开发，覆盖评论、回复、图片、赞踩互斥和两种删除策略。类型检查与集成验证均已通过。</p></div></div>
    <article class="team-agent-message team-presentation-message is-complete">
        <button type="button" class="turn-process-header codex-turn-header" aria-expanded="false"><span class="turn-process-label">用时 8秒</span><span class="turn-process-chevron"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span></button>
        <div class="team-main-head"><span class="team-main-agent">Code Agent</span></div>
        <div class="team-main-bubble team-presentation-bubble"><p>Agent 模式最终答复同样采用连续文档式排版。</p></div>
    </article>
</main>
<script>
document.addEventListener('click', function (event) {
    const header = event.target.closest('.codex-turn-header');
    if (!header) return;
    const process = header.closest('.turn-process');
    const open = process.hasAttribute('data-open');
    process.toggleAttribute('data-open', !open);
    header.toggleAttribute('data-open', !open);
    header.setAttribute('aria-expanded', open ? 'false' : 'true');
});
</script>
</body>
</html>
