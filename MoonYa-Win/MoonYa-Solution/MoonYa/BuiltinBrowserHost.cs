// BuiltinBrowserHost — 内置浏览器宿主（App 级单例）。
//
// 职责：
//   · 把 BrowserAutomationService 的"确保面板存在/会话开始结束/复位/兜底截图"请求
//     转发到 MainWindow 中的 CEF 面板控件（全部经 WPF Dispatcher）。
//   · 提供面板的 CDP 可识别特征（target id / window.name 标记 / 地址）。
//
// 该类型只依赖 IBuiltinBrowserDiscovery 接口暴露的能力，BrowserAutomationService
// 因此不引用任何 WPF 类型，可直接在控制台冒烟测试中被替换/绕过。

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;
using MoonYa.Services;

namespace MoonYa
{
    /// <summary>内置浏览器面板宿主。</summary>
    public sealed class BuiltinBrowserHost : IBuiltinBrowserDiscovery
    {
        private readonly BuiltinBrowserOptions _options;
        private MainWindow? _window;
        private int _sessionActive;
        private string _discoveryStatus = string.Empty;

        public BuiltinBrowserHost(BuiltinBrowserOptions options)
        {
            _options = options ?? new BuiltinBrowserOptions();
        }

        public BuiltinBrowserOptions Options => _options;

        public bool Enabled => _options.Enabled;

        public bool Prefer => _options.Prefer;

        public int RemoteDebuggingPort => _options.RemoteDebuggingPort;

        public string DiscoveryStatus => Volatile.Read(ref _discoveryStatus);

        public bool IsSessionActive => Volatile.Read(ref _sessionActive) == 1;

        /// <summary>面板新标签页地址；缺少资源文件时退回内联提示页（仍可自动化，只是没有起始页）。</summary>
        public string StartPageAddress
        {
            get
            {
                var path = ResolveStartPagePath(_options);
                if (File.Exists(path))
                {
                    try { return new Uri(path).AbsoluteUri; } catch (Exception) { }
                }
                const string fallback = "<!doctype html><meta charset=\"utf-8\"><title>新标签页</title>"
                    + "<body style=\"font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#6b6b6b;display:flex;"
                    + "align-items:center;justify-content:center;height:100vh;margin:0\">"
                    + "<div>内置浏览器已就绪：缺少 Assets/browser_start.html</div></body>";
                return "data:text/html;charset=utf-8," + Uri.EscapeDataString(fallback);
            }
        }

        /// <summary>把宿主窗口与面板绑定（主窗口构造时调用）。</summary>
        public void Attach(MainWindow window)
        {
            Interlocked.Exchange(ref _window, window);
        }

        /// <summary>解绑宿主窗口（主窗口关闭时调用）。</summary>
        public void Detach(MainWindow window)
        {
            Interlocked.CompareExchange(ref _window, null, window);
        }

        public async Task<BuiltinPanelTarget?> EnsurePanelAsync(
            string? url,
            bool autoOpen,
            int timeoutMs,
            CancellationToken cancellationToken)
        {
            var window = _window;
            Volatile.Write(ref _discoveryStatus, window == null ? "宿主窗口未绑定" : "等待宿主创建面板");
            if (window == null) return null;
            cancellationToken.ThrowIfCancellationRequested();

            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(timeoutMs);
            var token = deadline.Token;

            var openPanel = autoOpen && _options.OpenPanelOnStart;
            try
            {
                await InvokeAsync(window, () => window.EnsureBuiltinBrowserPanel(openPanel, url), token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[BuiltinBrowser] 创建面板失败: " + ex.Message);
                Volatile.Write(ref _discoveryStatus, "创建面板失败: " + ex.Message);
                return null;
            }

            Volatile.Write(ref _discoveryStatus, "读取面板及 CDP target 列表: " + BuiltinBrowserConnection.DebuggingAddress(RemoteDebuggingPort));
            while (true)
            {
                BuiltinPanelTarget? target = null;
                try
                {
                    token.ThrowIfCancellationRequested();
                    target = await InvokeFuncAsync(window, () => window.ReadBuiltinPanelTargetAsync(token), token).WaitAsync(token).ConfigureAwait(false);
                    Volatile.Write(ref _discoveryStatus, target == null ? "面板 CEF 控件尚未创建" : target.Describe());
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception error)
                {
                    Volatile.Write(ref _discoveryStatus, error.GetType().Name + ": " + error.Message);
                }

                if (target != null)
                {
                    // 只有拿到页面级 CDP 端点才算真正就绪：
                    // 面板 CEF 浏览器创建、起始页加载、target 出现在 /json/list 都需要时间，
                    // 过早返回会让自动化侧白白消耗重试次数。
                    if (!string.IsNullOrWhiteSpace(target.WebSocketDebuggerUrl)) return target;
                }

                await Task.Delay(App.BrowserAutomation!.BuiltinConnectRetryDelayMs, token).ConfigureAwait(false);
            }
        }

        public void OnSessionStarted()
        {
            Interlocked.Exchange(ref _sessionActive, 1);
            var window = _window;
            if (window == null) return;
            _ = InvokeAsync(window, () => window.SetBuiltinSessionActive(true));
        }

        public void OnSessionStopped()
        {
            Interlocked.Exchange(ref _sessionActive, 0);
            var window = _window;
            if (window == null) return;
            _ = InvokeAsync(window, () => window.SetBuiltinSessionActive(false));
        }

        public void ResetPanel()
        {
            var window = _window;
            if (window == null) return;
            _ = InvokeAsync(window, window.ResetBuiltinBrowserPanel);
        }

        public async Task<BuiltinPointerState?> BeginPointerOperationAsync()
        {
            var window = _window;
            if (window == null) return null;
            return await InvokeFuncAsync(window, window.BeginBuiltinPointerOperationAsync).ConfigureAwait(false);
        }

        public Task<bool> UpdatePointerAsync(long epoch, double x, double y)
        {
            var window = _window;
            return window == null ? Task.FromResult(false)
                : InvokeAsync(window, () => window.UpdateBuiltinPointer(epoch, x, y));
        }

        public Task EndPointerOperationAsync(long epoch)
        {
            var window = _window;
            return window == null ? Task.CompletedTask
                : InvokeAsync(window, () => window.EndBuiltinPointerOperation(epoch));
        }

        public void ResetVisuals()
        {
            var window = _window;
            if (window != null) _ = InvokeAsync(window, window.ResetBuiltinBrowserVisuals);
        }

        public async Task<byte[]?> CapturePanelScreenshotAsync(int timeoutMs)
        {
            var window = _window;
            if (window == null) return null;
            try
            {
                return await InvokeFuncAsync(window, () => window.CaptureBuiltinPanelScreenshotAsync(timeoutMs))
                    .ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine("[BuiltinBrowser] OSR 兜底截图失败: " + ex.Message);
                return null;
            }
        }

        /// <summary>解析新标签页资源路径（相对程序目录或绝对路径）。</summary>
        public static string ResolveStartPagePath(BuiltinBrowserOptions options)
        {
            var configured = options?.StartPage ?? string.Empty;
            if (string.IsNullOrWhiteSpace(configured))
            {
                return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "browser_start.html");
            }
            var expanded = Environment.ExpandEnvironmentVariables(configured.Trim());
            return Path.IsPathRooted(expanded)
                ? expanded
                : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, expanded);
        }

        private static Task InvokeAsync(MainWindow window, Action action, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (window.Dispatcher.CheckAccess())
            {
                action();
                return Task.CompletedTask;
            }
            return window.Dispatcher.InvokeAsync(action, DispatcherPriority.Normal, cancellationToken).Task;
        }

        private static Task<T> InvokeAsync<T>(MainWindow window, Func<T> func)
        {
            return window.Dispatcher.CheckAccess()
                ? Task.FromResult(func())
                : window.Dispatcher.InvokeAsync(func).Task;
        }

        private static async Task<T> InvokeFuncAsync<T>(MainWindow window, Func<Task<T>> func, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (window.Dispatcher.CheckAccess()) return await func().ConfigureAwait(false);
            return await (await window.Dispatcher.InvokeAsync(func, DispatcherPriority.Normal, cancellationToken).Task.ConfigureAwait(false)).ConfigureAwait(false);
        }
    }
}
