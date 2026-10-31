// PanelChromiumWebBrowser — 右侧栏内置浏览器控件（CEF OSR，进程内 Chromium）。
//
// 与主界面 WebView 的差异（两处，均为内置浏览器语义所需）：
//   1. 会话进行中面板被收起（Visibility 隐藏）时仍保持 CEF 渲染。
//      CefSharp.Wpf 默认在控件隐藏时调用 WasHidden(true)，CEF 随即停止出帧，
//      Agent 的截图与视觉分析会拿到空白帧；这里在需要时跳过隐藏通知。
//   2. 保留最近一次 OSR 帧的像素，作为 CDP Page.captureScreenshot 不可用时的兜底截图。
//
// 注意：控件始终留在可视树中（用 Visibility 控制显隐），避免 Unloaded 触发
// CefSharp 的浏览器释放逻辑，从而让面板页面的登录态与历史在收起后仍然保留。

using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using CefSharp;
using CefSharp.Structs;
using CefSharp.Wpf;

namespace MoonYa
{
    /// <summary>右侧栏内置浏览器控件。</summary>
    public class PanelChromiumWebBrowser : CustomChromiumWebBrowser
    {
        private readonly object _captureLock = new object();
        private TaskCompletionSource<CapturedFrame>? _pendingCapture;
        private int _lastFrameWidth;
        private int _lastFrameHeight;
        private int _suppressedPaintFailures;

        /// <summary>为 true 时，面板被隐藏也保持渲染（Agent 会话期间使用）。</summary>
        public bool KeepRenderingWhenHidden { get; set; }

        public bool ShowAutomationCursor { get; set; }

        protected override void OnCursorChange(IntPtr handle, CefSharp.Enums.CursorType type, CursorInfo customCursorInfo)
        {
            if (ShowAutomationCursor) return;
            base.OnCursorChange(handle, type, customCursorInfo);
        }

        /// <summary>onPaint 回调到达的总帧数（诊断用）。</summary>
        public long PaintedFrameCount { get; private set; }

        protected override void OnBrowserWasHidden(bool hidden)
        {
            if (hidden && KeepRenderingWhenHidden)
            {
                // 会话进行中：面板可能被用户收起或被日志页签覆盖，但 CEF 仍需持续出帧。
                return;
            }
            base.OnBrowserWasHidden(hidden);
        }

        protected override void OnPaint(bool isPopup, Rect dirtyRect, IntPtr buffer, int width, int height)
        {
            // 先取帧再交给基类渲染：基类在控件尚未应用模板（隐藏/未布局）时会抛
            // NullReferenceException（Image 为空），不能因此丢掉 Agent 需要的 OSR 帧。
            if (!isPopup && buffer != IntPtr.Zero && width > 0 && height > 0)
            {
                PaintedFrameCount++;
                try
                {
                    CompletePendingCapture(buffer, width, height);
                }
                catch (Exception ex)
                {
                    FailPendingCapture(ex);
                }
            }

            try
            {
                base.OnPaint(isPopup, dirtyRect, buffer, width, height);
            }
            catch (Exception ex)
            {
                // 控件被隐藏/尚未布局时 CefSharp 的渲染处理器可能未就绪；
                // 该帧无法上屏不影响功能，丢弃即可（会话期间面板通常可见）。
                Interlocked.Increment(ref _suppressedPaintFailures);
                if (_suppressedPaintFailures <= 3)
                {
                    System.Diagnostics.Debug.WriteLine("[BuiltinBrowser] OnPaint 基类渲染失败(已忽略): " + ex.Message);
                }
            }
        }

        private void CompletePendingCapture(IntPtr buffer, int width, int height)
        {
            TaskCompletionSource<CapturedFrame>? pending;
            lock (_captureLock)
            {
                pending = _pendingCapture;
                _pendingCapture = null;
                _lastFrameWidth = width;
                _lastFrameHeight = height;
            }
            if (pending == null) return;

            var stride = width * 4;
            var bytes = new byte[stride * height];
            System.Runtime.InteropServices.Marshal.Copy(buffer, bytes, 0, bytes.Length);
            pending.TrySetResult(new CapturedFrame(bytes, width, height, stride));
        }

        private void FailPendingCapture(Exception error)
        {
            TaskCompletionSource<CapturedFrame>? pending;
            lock (_captureLock)
            {
                pending = _pendingCapture;
                _pendingCapture = null;
            }
            pending?.TrySetException(error);
        }

        /// <summary>
        /// 请求下一帧 OSR 位图。面板被隐藏且 KeepRenderingWhenHidden 为 false 时，
        /// CEF 不再出帧，将在超时后返回 null。
        /// </summary>
        public async Task<CapturedFrame?> CaptureFrameAsync(int timeoutMs)
        {
            var completion = new TaskCompletionSource<CapturedFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_captureLock)
            {
                _pendingCapture = completion;
            }

            try
            {
                // 主动请求重绘，避免等到下一次内容变化才出帧。
                var host = GetBrowser()?.GetHost();
                host?.Invalidate(PaintElementType.View);
            }
            catch (Exception)
            {
                // 浏览器尚未初始化时忽略：等待帧超时即可
            }

            var timeout = TimeSpan.FromMilliseconds(Math.Max(200, timeoutMs));
            var completed = await Task.WhenAny(completion.Task, Task.Delay(timeout)).ConfigureAwait(false);
            if (!ReferenceEquals(completed, completion.Task))
            {
                lock (_captureLock)
                {
                    if (ReferenceEquals(_pendingCapture, completion)) _pendingCapture = null;
                }
                return null;
            }

            return await completion.Task.ConfigureAwait(false);
        }

        /// <summary>把 OSR 帧编码为 PNG。CEF OSR 位图为预乘 BGRA，对应 Pbgra32。</summary>
        public static byte[] EncodePng(CapturedFrame frame)
        {
            var bitmap = BitmapSource.Create(
                frame.Width,
                frame.Height,
                96,
                96,
                PixelFormats.Pbgra32,
                null,
                frame.Pixels,
                frame.Stride);
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var stream = new System.IO.MemoryStream();
            encoder.Save(stream);
            return stream.ToArray();
        }

        public readonly struct CapturedFrame
        {
            public CapturedFrame(byte[] pixels, int width, int height, int stride)
            {
                Pixels = pixels;
                Width = width;
                Height = height;
                Stride = stride;
            }

            public byte[] Pixels { get; }
            public int Width { get; }
            public int Height { get; }
            public int Stride { get; }
        }
    }
}
