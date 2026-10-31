/**
 * Ctrl+空格 开启语音输入时的启动音效
 *
 * 来源文件：script-3-push-to-talk.php
 * 原始函数：playStartTone()（在 startRecording() 中调用）
 * 文件位置：d:\Project\Project\MoonYa\MoonYa-Backend\script\MoonYa-index\modules\script-3-push-to-talk.php
 * 行号范围：第 224-266 行（ensureAudioCtx + playStartTone）
 *
 * 实现原理：
 *   使用 Web Audio API 实时合成一个 880Hz → 1200Hz 的上升提示音，
 *   0.4 秒内音量从 0.3 指数衰减到 0.001（自然消失）。
 *   因为是实时合成，所以不需要任何外部音频文件。
 */

// ─────────────────────────────────────────────
// 依赖：AudioContext 单例
// ─────────────────────────────────────────────
let audioCtx = null;

function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    } catch (e) {
        audioCtx = null;
    }
    return audioCtx;
}

// ─────────────────────────────────────────────
// 启动音效：playStartTone()
// ─────────────────────────────────────────────
function playStartTone() {
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    // 异步 resume 后再播放，确保 CefSharp 首次播放不丢失
    const play = () => {
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
        } catch (e) {
            console.warn('[PTT] 播放开始提示音失败:', e);
        }
    };
    try {
        if (ctx.state === 'suspended') {
            ctx.resume().then(play).catch(() => play());
        } else {
            play();
        }
    } catch (e) {
        console.warn('[PTT] playStartTone 异常:', e);
        try { play(); } catch (_e) {}
    }
}

// ─────────────────────────────────────────────
// 使用示例：在按下 Ctrl+Space 开始录音时调用
// ─────────────────────────────────────────────
// playStartTone();
