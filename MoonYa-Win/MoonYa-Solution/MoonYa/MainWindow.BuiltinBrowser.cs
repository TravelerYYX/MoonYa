// MainWindow.BuiltinBrowser — 右侧栏内置浏览器面板的窗口级实现。
//
// 布局约定：XAML 中覆盖整个窗口的 BuiltinBrowserLayer（Canvas）与主 WebView 占据同一个
// 单元格，坐标原点一致。页面把面板视口矩形按"比例"上报（left/top/width/height ÷ 视口尺寸），
// C# 侧乘以 WebView 的 DIP 尺寸后定位 CEF 控件，因此 DPI、页面缩放、侧栏折叠都无需特判。
//
// 控件生命周期：懒创建 → 显式 CreateBrowser(size)（控件未进可视树也能加载）
// → 始终留在可视树中，只用 Canvas 的 Visibility 控制显隐，避免 Unloaded 释放浏览器。

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using CefSharp;
using MoonYa.Services;

namespace MoonYa
{
    public partial class MainWindow
    {
        private PanelChromiumWebBrowser? _builtinBrowser;
        private BuiltinBrowserBridge? _builtinBrowserBridge;
        private bool _builtinBrowserBridgeRegistered;
        private bool _builtinSessionActive;

        // 页面上报的面板视口矩形（视口比例，0-1）
        private double _builtinPanelLeft;
        private double _builtinPanelTop;
        private double _builtinPanelWidth;
        private double _builtinPanelHeight;
        private bool _builtinPanelVisible;

        // 主 WebView 当前地址（桥接线程不能直接读依赖属性）
        private string _builtinMainAddress = string.Empty;

        private BuiltinBrowserOptions BuiltinOptions => App.BuiltinBrowser?.Options ?? new BuiltinBrowserOptions();

        private void InitializeBuiltinBrowserPanel()
        {
            SizeChanged += (_, _) => UpdateBuiltinBrowserLayout();
            StateChanged += (_, _) => UpdateBuiltinBrowserLayout();
            WebView.AddressChanged += OnMainWebViewAddressChanged;
            WebView.IsBrowserInitializedChanged += (_, _) =>
            {
                if (WebView.IsBrowserInitialized) RegisterBuiltinBrowserBridgeOnce();
            };
            Closing += (_, _) => DisposeBuiltinBrowserPanel();
            try { App.BuiltinBrowser?.Attach(this); } catch (Exception) { }
        }

        private void OnMainWebViewAddressChanged(object? sender, DependencyPropertyChangedEventArgs e)
        {
            _builtinMainAddress = e.NewValue as string ?? string.Empty;
            // 主页面自身重新导航：面板内容与页面布局都已失效，先隐藏覆盖层，
            // 等新页面通过 moonYaBrowserPanel.setBounds 重新上报矩形。
            SetBuiltinBrowserVisible(false);
            _builtinVisualEpoch++;
            _builtinVisualRevision = 0;
            _builtinVisualResetGeneration = 0;
            _builtinPointerPositions.Clear();
            _builtinVisualsEnabled = false;
            _builtinPointerOperation = false;
            UpdateBuiltinCursor();
            UpdateBuiltinVisualLayout();
        }

        // ── 对外（BuiltinBrowserHost）────────────────────────

        /// <summary>确保面板浏览器存在；openPanel 为 true 时展开右侧栏浏览器页签。</summary>
        public void EnsureBuiltinBrowserPanel(bool openPanel, string? url)
        {
            if (!BuiltinOptions.Enabled) return;
            var browser = EnsureBuiltinBrowserInstance();
            if (browser == null) return;
            if (!string.IsNullOrWhiteSpace(url)) NavigateBuiltinBrowserPanel(url);
            if (openPanel) RequestBuiltinPanelReveal();
        }

        /// <summary>读取面板在 CDP 上的可识别特征（含页面级端点，供自动化引擎连接）。</summary>
        public async Task<BuiltinPanelTarget?> ReadBuiltinPanelTargetAsync(CancellationToken cancellationToken = default)
        {
            var browser = _builtinBrowser;
            var core = browser?.GetBrowser();
            if (browser == null || core == null) return null;

            var address = browser.Address ?? string.Empty;
            var target = new BuiltinPanelTarget
            {
                TargetId = core.Identifier.ToString(CultureInfo.InvariantCulture),
                WindowName = BuiltinTargetMatcher.WindowNameMarker,
                Address = address,
                BrowserIdentifier = core.Identifier,
            };

            var endpoint = await ResolveBuiltinPanelCdpEndpointAsync(address, cancellationToken);
            if (endpoint.HasValue)
            {
                if (!string.IsNullOrWhiteSpace(endpoint.Value.TargetId)) target.TargetId = endpoint.Value.TargetId;
                target.WebSocketDebuggerUrl = endpoint.Value.WebSocketDebuggerUrl;
            }
            return target;
        }

        /// <summary>
        /// 从 CEF 的 /json/list 解析面板页面的 target id 与页面级 WebSocket 端点。
        /// 必须由宿主提供：只有宿主确切知道面板当前地址，能够可靠区分面板与主界面页面。
        /// </summary>
        private async Task<(string TargetId, string WebSocketDebuggerUrl)?> ResolveBuiltinPanelCdpEndpointAsync(string address, CancellationToken cancellationToken)
        {
            var port = App.BuiltinBrowser?.RemoteDebuggingPort ?? 0;
            if (port <= 0) return null;
            try
            {
                using var document = await BuiltinBrowserConnection.ReadDiscoveryAsync(port, "json/list", cancellationToken);
                if (document.RootElement.ValueKind != JsonValueKind.Array) return null;

                (string TargetId, string WebSocketDebuggerUrl)? match = null;
                foreach (var entry in document.RootElement.EnumerateArray())
                {
                    var type = entry.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                        ? typeElement.GetString() ?? string.Empty
                        : string.Empty;
                    if (!string.Equals(type, "page", StringComparison.OrdinalIgnoreCase)) continue;

                    var entryUrl = entry.TryGetProperty("url", out var urlElement) && urlElement.ValueKind == JsonValueKind.String
                        ? urlElement.GetString() ?? string.Empty
                        : string.Empty;
                    var id = entry.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String
                        ? idElement.GetString() ?? string.Empty
                        : string.Empty;
                    var endpoint = entry.TryGetProperty("webSocketDebuggerUrl", out var wsElement) && wsElement.ValueKind == JsonValueKind.String
                        ? wsElement.GetString() ?? string.Empty
                        : string.Empty;

                    if (!string.IsNullOrWhiteSpace(entryUrl) && !string.IsNullOrWhiteSpace(address)
                        && string.Equals(entryUrl, address, StringComparison.OrdinalIgnoreCase))
                    {
                        if (match.HasValue) throw new InvalidOperationException("内置面板地址匹配到多个 CDP 页面: " + address);
                        if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(endpoint)) match = (id, endpoint);
                    }
                }

                return match;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] 解析面板 CDP 端点失败: " + ex.Message);
                throw;
            }
        }

        /// <summary>会话开始/结束时切换隐藏渲染策略。</summary>
        public void SetBuiltinSessionActive(bool active)
        {
            _builtinSessionActive = active;
            if (!active)
            {
                _builtinVisualEpoch++;
                _builtinPointerOperation = false;
            }
            var options = BuiltinOptions;
            var browser = _builtinBrowser;
            if (browser != null)
            {
                // 会话期间无论配置如何都必须保持渲染（截图是 Agent 的观察手段）
                browser.KeepRenderingWhenHidden = active || options.KeepRenderingWhenHidden;
            }
            if (active) RequestBuiltinPanelReveal();
        }

        /// <summary>回到新标签页并隐藏覆盖层（stop / 关闭标签语义）。</summary>
        public void ResetBuiltinBrowserPanel()
        {
            RunOnUi(() =>
            {
                ResetBuiltinBrowserVisuals();
                var browser = _builtinBrowser;
                if (browser != null)
                {
                    try { browser.Load(GetBuiltinStartPageAddress()); }
                    catch (Exception ex) { Debug.WriteLine("[BuiltinBrowser] 复位失败: " + ex.Message); }
                    // 会话结束一并复位缩放，避免下次会话带着上次的缩放比例
                    try { browser.ZoomLevel = 0d; }
                    catch (Exception ex) { Debug.WriteLine("[BuiltinBrowser] 缩放复位失败: " + ex.Message); }
                }
                SetBuiltinBrowserVisible(false);
                PushBuiltinPanelState();
            });
        }

        /// <summary>取面板最近一帧 OSR 位图并编码为 PNG（CDP 截图兜底）。</summary>
        public async Task<byte[]?> CaptureBuiltinPanelScreenshotAsync(int timeoutMs)
        {
            var browser = _builtinBrowser;
            if (browser == null) return null;
            var frame = await browser.CaptureFrameAsync(timeoutMs).ConfigureAwait(true);
            return frame == null ? null : PanelChromiumWebBrowser.EncodePng(frame.Value);
        }

        // ── 面板控件生命周期 ────────────────────────────────

        private PanelChromiumWebBrowser? EnsureBuiltinBrowserInstance()
        {
            if (_builtinBrowser != null) return _builtinBrowser;

            var options = BuiltinOptions;
            var downloadDirectory = ResolveBuiltinDownloadDirectory();
            var browser = new PanelChromiumWebBrowser
            {
                // 面板浏览器一旦创建即保持渲染：CEF 在"隐藏"状态停止出帧，
                // 会让 Agent 的截图与视觉分析拿到空白帧（面板通常被日志页签覆盖）。
                KeepRenderingWhenHidden = options.KeepRenderingWhenHidden,
                Focusable = true,
                IsTabStop = true,
            };

            if (options.IsolateProfile)
            {
                try
                {
                    var cachePath = options.ResolveCachePath();
                    Directory.CreateDirectory(cachePath);
                    browser.RequestContext = new RequestContext(new RequestContextSettings
                    {
                        CachePath = cachePath,
                        PersistSessionCookies = true,
                    });
                }
                catch (Exception ex)
                {
                    Debug.WriteLine("[BuiltinBrowser] 独立 profile 初始化失败，改用默认上下文: " + ex.Message);
                }
            }

            browser.RequestHandler = new PanelRequestHandler();
            browser.JsDialogHandler = new PanelJsDialogHandler();
            browser.LifeSpanHandler = new PanelLifeSpanHandler(browser);
            browser.DownloadHandler = new PanelDownloadHandler(downloadDirectory);
            browser.GotKeyboardFocus += (_, _) => SetInputFocusState(false);

            browser.IsBrowserInitializedChanged += (_, _) =>
            {
                if (!browser.IsBrowserInitialized) return;
                try
                {
                    var host = browser.GetBrowser()?.GetHost();
                    if (host != null) host.WindowlessFrameRate = 60;
                }
                catch (Exception ex)
                {
                    Debug.WriteLine("[BuiltinBrowser] 帧率设置失败: " + ex.Message);
                }
                RegisterBuiltinBrowserBridgeOnce();
                RunOnUi(() =>
                {
                    StampBuiltinPanelWindowName();
                    PushBuiltinPanelState();
                });
            };
            browser.AddressChanged += (_, _) => RunOnUi(PushBuiltinPanelState);
            browser.TitleChanged += (_, _) => RunOnUi(PushBuiltinPanelState);
            browser.LoadingStateChanged += (_, _) => RunOnUi(PushBuiltinPanelState);
            browser.LoadError += (_, _) => RunOnUi(PushBuiltinPanelState);
            browser.FrameLoadEnd += (_, e) =>
            {
                if (e.Frame == null || !e.Frame.IsMain) return;
                RunOnUi(() =>
                {
                    SyncBuiltinStartPageTheme();
                    StampBuiltinPanelWindowName();
                    PushBuiltinPanelState();
                });
            };

            BuiltinBrowserLayer.Children.Add(browser);
            _builtinBrowser = browser;
            InitializeBuiltinVisuals(browser);
            UpdateBuiltinCursor();

            // 不在此处显式 CreateBrowser：CEF 在控件尚未布局（尺寸为 0）时创建/出帧会导致
            // 渲染进程断言崩溃（libcef STATUS_BREAKPOINT）。
            // 控件由 UpdateBuiltinBrowserLayout 赋予真实尺寸并显示后，CefSharp 会按常规路径
            // 在获得非零尺寸时创建底层浏览器。

            try { browser.Address = GetBuiltinStartPageAddress(); }
            catch (Exception ex) { Debug.WriteLine("[BuiltinBrowser] 起始页加载失败: " + ex.Message); }

            return browser;
        }

        private void DisposeBuiltinBrowserPanel()
        {
            try { App.BuiltinBrowser?.Detach(this); } catch (Exception) { }
            var browser = _builtinBrowser;
            _builtinBrowser = null;
            _builtinVisualEpoch++;
            if (_builtinVisuals != null) BuiltinBrowserLayer.Children.Remove(_builtinVisuals);
            _builtinVisuals = null;
            if (browser == null) return;
            try { BuiltinBrowserLayer.Children.Remove(browser); } catch (Exception) { }
            try { browser.Dispose(); } catch (Exception) { }
        }

        private string GetBuiltinStartPageAddress()
        {
            return WithBuiltinStartPageTheme(App.BuiltinBrowser?.StartPageAddress ?? "about:blank");
        }

        private string ResolveBuiltinDownloadDirectory()
        {
            var configured = App.BrowserAutomation?.DownloadDirectory ?? string.Empty;
            if (string.IsNullOrWhiteSpace(configured)) return string.Empty;
            try { return BrowserAutomationService.ResolveConfiguredPath(configured); }
            catch (Exception) { return string.Empty; }
        }

        // ── 布局（比例矩形 → DIP）────────────────────────────

        /// <summary>页面上报面板视口矩形（视口比例），由 JS 桥调用。</summary>
        public void ApplyBuiltinBrowserBounds(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            try
            {
                using var document = JsonDocument.Parse(json);
                var root = document.RootElement;
                var left = ReadRatio(root, "left");
                var top = ReadRatio(root, "top");
                var width = ReadRatio(root, "width");
                var height = ReadRatio(root, "height");
                if (width <= 0 || height <= 0) return;
                _builtinPanelLeft = Math.Max(0, Math.Min(1, left));
                _builtinPanelTop = Math.Max(0, Math.Min(1, top));
                _builtinPanelWidth = Math.Max(0, Math.Min(1, width));
                _builtinPanelHeight = Math.Max(0, Math.Min(1, height));
                if (root.TryGetProperty("visible", out var visible) &&
                    (visible.ValueKind == JsonValueKind.True || visible.ValueKind == JsonValueKind.False))
                {
                    _builtinPanelVisible = visible.GetBoolean();
                }

                // 页面首次上报可见矩形 = 用户/Agent 真的要看浏览器了：按需创建实例
                if (_builtinPanelVisible && _builtinBrowser == null) EnsureBuiltinBrowserInstance();
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] setBounds 解析失败: " + ex.Message);
            }
            UpdateBuiltinBrowserLayout();
        }

        private static double ReadRatio(JsonElement root, string name)
        {
            if (!root.TryGetProperty(name, out var value)) return 0;
            return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) ? number : 0;
        }

        /// <summary>显示/隐藏面板覆盖层（不改动 CEF 浏览器实例，页面状态保留）。</summary>
        public void SetBuiltinBrowserVisible(bool visible)
        {
            RunOnUi(() =>
            {
                _builtinPanelVisible = visible;
                UpdateBuiltinBrowserLayout();
            });
        }

        private void UpdateBuiltinBrowserLayout()
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.BeginInvoke(new Action(UpdateBuiltinBrowserLayout));
                return;
            }

            var browser = _builtinBrowser;
            if (browser == null) return;

            var hostWidth = WebView.ActualWidth;
            var hostHeight = WebView.ActualHeight;
            if (!_builtinPanelVisible || _builtinPanelWidth <= 0 || _builtinPanelHeight <= 0 ||
                hostWidth <= 1 || hostHeight <= 1)
            {
                BuiltinBrowserLayer.Visibility = Visibility.Collapsed;
                return;
            }

            var width = Math.Round(_builtinPanelWidth * hostWidth);
            var height = Math.Round(_builtinPanelHeight * hostHeight);
            if (width < 40 || height < 40)
            {
                BuiltinBrowserLayer.Visibility = Visibility.Collapsed;
                return;
            }

            Canvas.SetLeft(browser, Math.Round(_builtinPanelLeft * hostWidth));
            Canvas.SetTop(browser, Math.Round(_builtinPanelTop * hostHeight));
            browser.Width = width;
            browser.Height = height;
            UpdateBuiltinVisualLayout();
            BuiltinBrowserLayer.Visibility = Visibility.Visible;
        }

        // ── 工具栏动作与状态 ────────────────────────────────

        public void NavigateBuiltinBrowserPanel(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            RunOnUi(() =>
            {
                var browser = EnsureBuiltinBrowserInstance();
                if (browser == null) return;
                try { browser.Load(url); }
                catch (Exception ex) { Debug.WriteLine("[BuiltinBrowser] 导航失败: " + ex.Message); }
            });
        }

        public void RunBuiltinBrowserPanelAction(string name)
        {
            RunOnUi(() =>
            {
                var browser = _builtinBrowser;
                if (browser == null) return;
                var core = browser.GetBrowser();
                try
                {
                    switch ((name ?? string.Empty).Trim().ToLowerInvariant())
                    {
                        case "back":
                            if (core != null && core.CanGoBack) core.GoBack();
                            break;
                        case "forward":
                            if (core != null && core.CanGoForward) core.GoForward();
                            break;
                        case "reload":
                            browser.Reload();
                            break;
                        case "stop":
                            browser.Stop();
                            break;
                        case "home":
                            browser.Load(GetBuiltinStartPageAddress());
                            break;
                        case "focus":
                            browser.Focus();
                            break;
                        case "zoom-in":
                            SetBuiltinPanelZoom(browser, browser.ZoomLevel + ResolveZoomIncrement(browser));
                            break;
                        case "zoom-out":
                            SetBuiltinPanelZoom(browser, browser.ZoomLevel - ResolveZoomIncrement(browser));
                            break;
                        case "zoom-reset":
                            SetBuiltinPanelZoom(browser, 0d);
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine("[BuiltinBrowser] 面板动作失败: " + ex.Message);
                }
            });
        }

        // 面板缩放：CEF 的 ZoomLevel 是按宿主实例保存的，夹紧到 ±3（≈ 0.58x ~ 1.73x）避免放大到不可用
        private static double ResolveZoomIncrement(PanelChromiumWebBrowser browser)
        {
            var increment = browser.ZoomLevelIncrement;
            return increment > 0 ? increment : 0.2d;
        }

        private void SetBuiltinPanelZoom(PanelChromiumWebBrowser browser, double zoomLevel)
        {
            var clamped = Math.Max(-3d, Math.Min(3d, zoomLevel));
            try
            {
                browser.ZoomLevel = clamped;
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] 缩放设置失败: " + ex.Message);
            }
            PushBuiltinPanelState();
        }

        /// <summary>复制面板当前地址到剪贴板（⋮ 菜单「复制网址」）。</summary>
        public void CopyBuiltinPanelUrl()
        {
            RunOnUi(() =>
            {
                var address = _builtinBrowser?.Address ?? string.Empty;
                if (string.IsNullOrWhiteSpace(address)) return;
                // 剪贴板可能被其他进程短暂占用，重试一次即可，失败不影响其它功能
                for (var attempt = 0; attempt < 2; attempt++)
                {
                    try
                    {
                        Clipboard.SetText(address);
                        return;
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine("[BuiltinBrowser] 复制网址失败(" + attempt + "): " + ex.Message);
                    }
                }
            });
        }

        public void OpenBuiltinPanelUrlExternally(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;
            try
            {
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] 系统浏览器打开失败: " + ex.Message);
            }
        }

        /// <summary>通知页面展开右侧栏浏览器页签（幂等；页面未加载该模块时静默忽略）。</summary>
        private void RequestBuiltinPanelReveal()
        {
            ExecuteScriptOnMainWebView("window.moonyaOpenBrowserPanel&&window.moonyaOpenBrowserPanel({source:'automation',visual_generation:"
                + _builtinVisualResetGeneration + "});");
        }

        private void StampBuiltinPanelWindowName()
        {
            var browser = _builtinBrowser;
            if (browser == null || !browser.IsBrowserInitialized) return;
            try
            {
                browser.ExecuteScriptAsync(
                    "try{window.name=" + JsonSerializer.Serialize(BuiltinTargetMatcher.WindowNameMarker) + ";}catch(e){}");
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] window.name 标记失败: " + ex.Message);
            }
        }

        public string GetBuiltinPanelStateJson()
        {
            var browser = _builtinBrowser;
            if (browser == null)
            {
                return JsonSerializer.Serialize(new { available = false, enabled = BuiltinOptions.Enabled });
            }

            var address = browser.Address ?? string.Empty;
            var startPage = GetBuiltinStartPageAddress();
            var isStartPage = string.IsNullOrWhiteSpace(address)
                || address.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)
                || string.Equals(address.Split('#')[0], startPage.Split('#')[0], StringComparison.OrdinalIgnoreCase);

            var canGoBack = false;
            var canGoForward = false;
            try
            {
                var core = browser.GetBrowser();
                if (core != null)
                {
                    canGoBack = core.CanGoBack;
                    canGoForward = core.CanGoForward;
                }
            }
            catch (Exception) { }

            return JsonSerializer.Serialize(new
            {
                available = true,
                enabled = true,
                url = isStartPage ? string.Empty : address,
                raw_url = address,
                title = browser.Title ?? string.Empty,
                is_start_page = isStartPage,
                can_go_back = canGoBack,
                can_go_forward = canGoForward,
                is_loading = browser.IsLoading,
                engine = "builtin",
                session_active = _builtinSessionActive,
                visible = _builtinPanelVisible,
                // CEF ZoomLevel → 百分比（CEF 的缩放因子为 1.2^level）
                zoom_percent = (int)Math.Round(Math.Pow(1.2d, browser.ZoomLevel) * 100d),
            });
        }

        private void PushBuiltinPanelState()
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.BeginInvoke(new Action(PushBuiltinPanelState));
                return;
            }
            ExecuteScriptOnMainWebView(
                "window.moonyaBrowserPanelState&&window.moonyaBrowserPanelState(" + GetBuiltinPanelStateJson() + ");");
        }

        private void ExecuteScriptOnMainWebView(string script)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.BeginInvoke(new Action(() => ExecuteScriptOnMainWebView(script)));
                return;
            }
            try
            {
                if (!WebView.IsBrowserInitialized) return;
                WebView.ExecuteScriptAsync(script);
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] 脚本注入失败: " + ex.Message);
            }
        }

        private void RunOnUi(Action action)
        {
            if (Dispatcher.CheckAccess()) action();
            else Dispatcher.BeginInvoke(action);
        }

        /// <summary>供 JS 桥使用：把操作切到 WPF 线程并等待完成（CEF 调用线程不能访问依赖属性）。</summary>
        internal Task RunOnUiAsync(Action action)
        {
            if (Dispatcher.CheckAccess())
            {
                action();
                return Task.CompletedTask;
            }
            return Dispatcher.InvokeAsync(action).Task;
        }

        /// <summary>供 JS 桥使用：在 WPF 线程取值并返回。</summary>
        internal Task<T> RunOnUiAsync<T>(Func<T> func)
        {
            return Dispatcher.CheckAccess()
                ? Task.FromResult(func())
                : Dispatcher.InvokeAsync(func).Task;
        }

        // ── JS 桥 ──────────────────────────────────────────

        private void RegisterBuiltinBrowserBridgeOnce()
        {
            if (_builtinBrowserBridgeRegistered) return;
            try
            {
                _builtinBrowserBridge = new BuiltinBrowserBridge(this);
                WebView.JavascriptObjectRepository.Register(
                    "moonYaBrowserPanel",
                    _builtinBrowserBridge,
                    BindingOptions.DefaultBinder);
                _builtinBrowserBridgeRegistered = true;
                Debug.WriteLine("[BuiltinBrowser] JS bridge moonYaBrowserPanel 已注册");
            }
            catch (ArgumentException ex) when (ex.Message.Contains("already", StringComparison.OrdinalIgnoreCase))
            {
                _builtinBrowserBridgeRegistered = true;
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[BuiltinBrowser] JS bridge 注册延后: " + ex.Message);
            }
        }

        /// <summary>主 WebView 页面是否属于可信来源（与 moonYaFileOps 同一判定口径）。</summary>
        internal bool IsBuiltinBrowserBridgeTrusted()
        {
            var allowed = App.FrontendBaseAddress;
            if (allowed == null || string.IsNullOrWhiteSpace(_builtinMainAddress)) return false;
            if (!Uri.TryCreate(_builtinMainAddress, UriKind.Absolute, out var current)) return false;
            return string.Equals(current.Scheme, allowed.Scheme, StringComparison.OrdinalIgnoreCase)
                && string.Equals(current.Host, allowed.Host, StringComparison.OrdinalIgnoreCase)
                && current.Port == allowed.Port;
        }
    }

    /// <summary>
    /// JS 桥：右侧栏内置浏览器的视图矩形上报、显隐、导航与状态同步。
    /// 只注册在主 WebView 上；面板浏览器本身不具备任何 MoonYa 桥（浏览外部站点时无本机能力）。
    ///
    /// 注意：桥方法由 CEF 线程调用，且 CefSharp 统一以 Promise 返回，
    /// 因此所有涉及依赖属性的操作都切回 WPF 线程执行并返回 Task。
    /// </summary>
    public class BuiltinBrowserBridge
    {
        private readonly MainWindow _window;

        public BuiltinBrowserBridge(MainWindow window)
        {
            _window = window;
        }

        /// <summary>桥可用性与引擎信息；前端据此决定是否显示"浏览器"页签。</summary>
        public Task<string> info()
        {
            if (!IsTrusted()) return Task.FromResult(Denied());
            var options = App.BuiltinBrowser?.Options ?? new BuiltinBrowserOptions();
            var payload = JsonSerializer.Serialize(new
            {
                available = options.Enabled,
                enabled = options.Enabled,
                engine = "builtin",
                start_page = App.BuiltinBrowser?.StartPageAddress ?? string.Empty,
            });
            return Task.FromResult(payload);
        }

        /// <summary>面板视口矩形（视口比例 0-1）。</summary>
        public Task setBounds(string json)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.ApplyBuiltinBrowserBounds(json));
        }

        public Task setVisible(bool visible)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.SetBuiltinBrowserVisible(visible));
        }

        public Task setVisuals(string json)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.ApplyBuiltinBrowserVisuals(json));
        }

        public Task navigate(string url)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.NavigateBuiltinBrowserPanel(url));
        }

        public Task action(string name)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.RunBuiltinBrowserPanelAction(name));
        }

        public Task openExternal(string url)
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(() => _window.OpenBuiltinPanelUrlExternally(url));
        }

        /// <summary>复制面板当前地址（⋮ 菜单「复制网址」）。</summary>
        public Task copyUrl()
        {
            if (!IsTrusted()) return Task.CompletedTask;
            return _window.RunOnUiAsync(_window.CopyBuiltinPanelUrl);
        }

        public Task<string> state()
        {
            if (!IsTrusted()) return Task.FromResult(Denied());
            return _window.RunOnUiAsync(_window.GetBuiltinPanelStateJson);
        }

        private bool IsTrusted() => _window.IsBuiltinBrowserBridgeTrusted();

        private static string Denied() =>
            JsonSerializer.Serialize(new { available = false, error = "origin_denied" });
    }
}
