using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using CefSharp;
using CefSharp.Wpf;
using MoonYa.Services;

namespace MoonYa
{
    public partial class App : Application
    {
        private static FileOperationApiServer? _apiServer;
        private static FileOperationService? _fileService;
        private static ExecutionApiServer? _executionServer;
        private static AgentRuntimeService? _agentRuntimeService;
        private PaymentActivationService? _paymentActivation;
        private SingleInstanceGuard? _singleInstance;
        internal string? PendingPaymentOrder { get; set; }
        private static readonly System.Threading.CancellationTokenSource RuntimeStartupCancellation = new();
        internal static DesktopFrontendService? FrontendService { get; private set; }
        internal static ProgramUpdateService? Updates { get; private set; }
        internal static Uri? FrontendBaseAddress => FrontendService?.BaseAddress;
        private static WebCrawlerService? _crawlerService;
        private static ComputerUseService? _cuService;
        // Browser automation service configured by launcher_config.json.
        private static BrowserAutomationService? _browserService;
        internal static BrowserSecurityGate? BrowserSecurityGate { get; private set; }
        private static BrowserApiServer? _browserApiServer;
        internal static BrowserApiServer? BrowserApi => _browserApiServer;
        internal static Uri? FileServiceBaseAddress { get; private set; }
        internal static Uri? ExecutionServiceBaseAddress { get; private set; }
        internal static Uri? AgentRuntimeBaseAddress { get; private set; }
        internal static Uri? BackendBaseAddress { get; private set; }
        internal static int ExecutionRelayTimeoutMs { get; private set; }
        internal static Uri? BrowserServiceBaseAddress { get; private set; }
        internal static int BrowserRelayTimeoutMs { get; private set; }
        // 内置浏览器（右侧栏 CEF 面板）：宿主与配置，供窗口与自动化引擎共享。
        internal static BuiltinBrowserHost? BuiltinBrowser { get; private set; }
        internal static BrowserAutomationConfig? BrowserAutomation { get; private set; }
        // LSP 服务管理：管理 PHP/Python/JS-TS 三种语言的 LSP 进程
        // LSP 服务使用运行时服务清单中的独立端点。
        private static LspServiceManager? _lspManager;
        private static LspApiServer? _lspApiServer;
        private static readonly McpClientManager _mcpClientManager = new();
        private static readonly ArtifactPreviewService _artifactPreviewService = new();
        private static System.Windows.Forms.NotifyIcon? _notifyIcon;
        // 由本地 /cu-op 服务在真实输入开始/结束时维护，而不是由网页端的思考事件驱动。
        // 计数支持同一操作链中嵌套的 UIA → SendInput 回退，避免过早熄灭光效。
        private static int _computerUseVisualOperationCount;
        private static readonly object ComputerUseLeaseLock = new();
        private static readonly Dictionary<string, DateTimeOffset> ComputerUseLeases = new(StringComparer.Ordinal);
        private static readonly Timer ComputerUseLeaseTimer = new(_ => SweepComputerUseLeases(), null, 2000, 2000);
        // Covers the longest configured CU model decision (including one retry)
        // while explicit leave still clears normal completion immediately.
        internal const int ComputerUseLeaseSeconds = 75;
        internal static System.Windows.Forms.NotifyIcon? TrayIcon => _notifyIcon;
        internal static FileOperationService? LocalFileService => _fileService;

        // 外观配置（背景媒体 / 模糊 / 配色 / 主题库）。惰性初始化：前端桥与本地媒体路由
        // 共用同一实例 —— 媒体路由跑在 HttpListener 线程上，所以初始化必须加锁，
        // 否则短暂出现两个实例会让白名单读到过期快照、刚选好的背景被判 403。
        private static readonly object AppearanceLock = new();
        private static AppearancePreferences? _appearancePreferences;
        internal static AppearancePreferences AppearancePreferences
        {
            get
            {
                if (_appearancePreferences == null)
                {
                    lock (AppearanceLock)
                    {
                        _appearancePreferences ??= new AppearancePreferences(AppDataPaths.PathFor("frontend", "appearance.json"));
                    }
                }
                return _appearancePreferences!;
            }
        }

        internal static Task<string> ExecuteFileOpAsync(string body)
        {
            if (_apiServer == null)
            {
                return Task.FromResult(JsonSerializer.Serialize(
                    new { success = false, message = "本地文件操作服务尚未初始化" }));
            }

            return _apiServer.ExecuteFileOpAsync(body);
        }

        internal static Task<string> ExecuteMcpOpAsync(string body) =>
            _mcpClientManager.ExecuteAsync(body);

        internal static string PreviewArtifact(string path, string allowedRootsJson)
        {
            string[]? roots = null;
            if (!string.IsNullOrWhiteSpace(allowedRootsJson))
            {
                try
                {
                    roots = JsonSerializer.Deserialize<string[]>(allowedRootsJson);
                }
                catch (JsonException)
                {
                    roots = null;
                }
            }
            return _artifactPreviewService.Preview(path, roots);
        }

        // ── 桌宠桌面覆盖窗口（透明置顶，独立于主窗口）──
        internal static PetWindow? PetWindow { get; private set; }

        /// <summary>
        /// 标记一次真实的 Computer Use 输入开始。只由本机 /cu-op 路由调用，
        /// 不应由模型思考、截图或 SSE 状态调用。
        /// </summary>
        internal static void BeginComputerUseVisualOperation()
        {
            if (Interlocked.Increment(ref _computerUseVisualOperationCount) == 1)
            {
                SetComputerUseVisualState("active");
            }
        }

        /// <summary>
        /// 标记一次真实的 Computer Use 输入结束。对应的 finally 中调用，确保异常时也会收尾。
        /// </summary>
        internal static void EndComputerUseVisualOperation()
        {
            var remaining = Interlocked.Decrement(ref _computerUseVisualOperationCount);
            if (remaining <= 0)
            {
                Interlocked.Exchange(ref _computerUseVisualOperationCount, 0);
                SetComputerUseVisualState("off");
            }
        }

        /// <summary>
        /// Maintains a run-scoped desktop lease. API/tool/browser phases do not
        /// enter this state; cancellation, disconnect and timeout all converge on
        /// leave/lease expiry so the CU glow cannot remain stuck.
        /// </summary>
        internal static void UpdateComputerUseDesktopSession(string runId, string state)
        {
            if (string.IsNullOrWhiteSpace(runId)) return;
            bool active;
            lock (ComputerUseLeaseLock)
            {
                if (state == "leave")
                {
                    ComputerUseLeases.Remove(runId);
                }
                else if (state is "enter" or "heartbeat")
                {
                    ComputerUseLeases[runId] = DateTimeOffset.UtcNow.AddSeconds(ComputerUseLeaseSeconds);
                }
                active = ComputerUseLeases.Count > 0;
            }
            SetComputerUseVisualState(active ? "active" : "off");
        }

        private static void SweepComputerUseLeases()
        {
            bool changed = false;
            bool active;
            lock (ComputerUseLeaseLock)
            {
                var now = DateTimeOffset.UtcNow;
                foreach (var runId in ComputerUseLeases.Where(entry => entry.Value <= now).Select(entry => entry.Key).ToArray())
                {
                    changed |= ComputerUseLeases.Remove(runId);
                }
                active = ComputerUseLeases.Count > 0;
            }
            if (changed) SetComputerUseVisualState(active ? "active" : "off");
        }

        private static void SetComputerUseVisualState(string mode)
        {
            try
            {
                var dispatcher = Current?.Dispatcher;
                if (dispatcher == null || dispatcher.HasShutdownStarted || dispatcher.HasShutdownFinished)
                {
                    return;
                }

                void Apply()
                {
                    (Current?.MainWindow as MainWindow)?.SetPttGlowCuMode(mode);
                }

                if (dispatcher.CheckAccess())
                {
                    Apply();
                }
                else
                {
                    // 同步切换保证 active 在输入注入前生效，off 在该输入结束后才执行。
                    dispatcher.Invoke(Apply);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"Computer Use visual state update failed: {ex.Message}");
            }
        }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            if (e.Args.Length > 0 && e.Args[0].StartsWith("moonya:", StringComparison.OrdinalIgnoreCase))
            {
                PendingPaymentOrder = PaymentActivationService.OrderFromUri(e.Args[0]);
                if (PendingPaymentOrder == null || PaymentActivationService.TryForward(PendingPaymentOrder))
                {
                    Shutdown();
                    return;
                }
            }
            // Acquire before starting services or touching the shared CEF cache.
            _singleInstance = new SingleInstanceGuard();
            if (!_singleInstance.IsOwner)
            {
                PaymentActivationService.TryShowExisting();
                _singleInstance.Dispose();
                Shutdown();
                return;
            }
            PaymentActivationService.RegisterProtocol();
            _paymentActivation = new PaymentActivationService();
            _paymentActivation.Start(order => Dispatcher.BeginInvoke(new Action(() =>
            {
                if (order == PaymentActivationService.ShowCommand)
                    (MainWindow as MainWindow)?.ShowWindow();
                else
                {
                    PendingPaymentOrder = order;
                    (MainWindow as MainWindow)?.ActivatePaymentReturn();
                }
            })));
            Exit += (_, _) => _paymentActivation.Dispose();

            // ── 设置爬虫数据目录环境变量（PHP config.php 读取）──
            AppDataPaths.Initialize();

            // ── Read launcher config for API port ─────────
            var configPath = ResolveLauncherConfigPath();
            var launcherConfig = LoadLauncherConfig(configPath);
            var localServiceHost = RequiredString(launcherConfig, "host", "MOONYA_LOCAL_SERVICE_HOST");
            BackendBaseAddress = RequiredAbsoluteHttpUri(launcherConfig, "backend_url", "MOONYA_BACKEND_URL");
            var apiPort = RequiredPort(launcherConfig, "api_port", "MOONYA_FILE_SERVICE_PORT");
            var crawlerPort = RequiredPort(launcherConfig, "crawler_port", "MOONYA_PYTHON_SERVICE_PORT");
            var executionPort = RequiredPort(launcherConfig, "execution_port", "MOONYA_EXECUTION_SERVICE_PORT");
            var lspPort = RequiredPort(launcherConfig, "lsp_port", "MOONYA_LSP_SERVICE_PORT");
            ExecutionRelayTimeoutMs = RequiredPositiveInt(launcherConfig, "execution_relay_timeout_ms", "MOONYA_EXECUTION_RELAY_TIMEOUT_MS");
            if (!launcherConfig.TryGetProperty("execution_tools", out var executionTools) ||
                !executionTools.TryGetProperty("sandbox", out var executionSandbox))
                throw new InvalidOperationException("launcher_config.json 缺少 execution_tools.sandbox 配置段");
            var commandTimeoutSec = RequiredPositiveInt(executionSandbox, "command_timeout_sec", "MOONYA_COMMAND_TIMEOUT_SEC");
            var grepConfig = LoadGrepConfig(launcherConfig);
            FileServiceBaseAddress = new UriBuilder(Uri.UriSchemeHttp, localServiceHost, apiPort).Uri;
            ExecutionServiceBaseAddress = new UriBuilder(Uri.UriSchemeHttp, localServiceHost, executionPort).Uri;

            // ── Start file operation HTTP API ─────────────
            var fileService = _fileService = new FileOperationService(configPath);
            _cuService = new ComputerUseService();
            // UiAutomationService 作为单例：依赖 cuService 提供 UIA 失败时的鼠标/键盘 fallback
            var uiaService = new UiAutomationService(_cuService);
            // LSP 服务管理器：构造时注入到 FileOperationApiServer，使其能直接分发 get_diagnostics 等 action
            _lspManager = new LspServiceManager();
            _apiServer = new FileOperationApiServer(
                fileService, _cuService, uiaService, _lspManager,
                localServiceHost, apiPort, commandTimeoutSec, grepConfig);
            _apiServer.Start();

            // ── Start LSP API server ───────────────────────
            // PHP/Python/JS-TS 三种语言的 LSP 服务管理
            try
            {
                _lspApiServer = new LspApiServer(_lspManager, localServiceHost, lspPort);
                _lspApiServer.Start();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"LspApiServer 启动失败: {ex.Message}");
            }

            // ── Start Python unified backend service (main.py: crawl + search) ──
            try
            {
                _crawlerService = new WebCrawlerService(crawlerPort, configPath);
                _crawlerService.Start();
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"MoonYa Python 爬虫/搜索服务启动失败: {ex}");
                try { File.AppendAllText(AppDataPaths.PathFor("logs", "python_backend.log"), $"[{DateTimeOffset.Now:O}] [ERROR] {ex}\n"); } catch { }
            }

            // ── Start Execution API server (Python + CLI execution tools) ──
            _executionServer = new ExecutionApiServer(localServiceHost, executionPort, configPath);
            _executionServer.Start();

            // Static UI starts independently of the optional Agent Runtime.
            var frontendPort = launcherConfig.TryGetProperty("frontend_port", out var fp) ? fp.GetInt32() : 58908;
            var frontendOverride = Environment.GetEnvironmentVariable("MOONYA_FRONTEND_PORT");
            if (!string.IsNullOrWhiteSpace(frontendOverride)) frontendPort = int.Parse(frontendOverride);
            if (frontendPort < 1 || frontendPort > 65535) throw new InvalidOperationException("frontend_port 无效");
            var runtimeConfig = launcherConfig.GetProperty("agent_runtime");
            FrontendService = new DesktopFrontendService(frontendPort, BackendBaseAddress,
                new UriBuilder("http", runtimeConfig.GetProperty("host").GetString()!, runtimeConfig.GetProperty("port").GetInt32()).Uri);
            FrontendService.Start();
            Updates = new ProgramUpdateService(BackendBaseAddress!);
            Updates.ShutdownRequested = () => Dispatcher.BeginInvoke(new Action(() => {
                if (MainWindow is MainWindow window) window.ExitApplication(); else Shutdown();
            }));
            FrontendService.Updates = Updates;
            Updates.Start();

            // ── Start durable coding-agent runtime ─────────────────────────
            // The runtime is deliberately started after file/execution/LSP services,
            // because its tools delegate to those existing MoonYa capabilities.
            // Start after returning to the dispatcher so rendering never waits for runtime health.
            Dispatcher.BeginInvoke(new Action(async () => {
                try {
                    RuntimeStartupCancellation.Token.ThrowIfCancellationRequested();
                    _agentRuntimeService = new AgentRuntimeService(configPath);
                    await _agentRuntimeService.StartAsync(RuntimeStartupCancellation.Token);
                    AgentRuntimeBaseAddress = _agentRuntimeService.BaseAddress;
                } catch (Exception ex) {
                    Debug.WriteLine($"MoonYa Agent Runtime 启动失败: {ex}");
                    try { File.AppendAllText(AppDataPaths.PathFor("logs", "agent-runtime-startup.log"), $"[{DateTimeOffset.Now:O}] {ex}\n"); } catch { }
                }
            }));

            // ── CefSharp settings ─────────────────────────
            // 缓存根目录：默认 %USERPROFILE%\.MoonYa\CefCache；
            // 允许用 MOONYA_CEF_CACHE_PATH 覆盖（便携部署 / 隔离测试 / 受限目录环境）。
            var cachePathOverride = Environment.GetEnvironmentVariable("MOONYA_CEF_CACHE_PATH");
            var cachePath = !string.IsNullOrWhiteSpace(cachePathOverride)
                ? Path.GetFullPath(Environment.ExpandEnvironmentVariables(cachePathOverride.Trim()))
                : AppDataPaths.PathFor("CefCache");

            // ── 定位 CEF 原生资源目录 ──
            // Debug 模式下位于 runtimes/{rid}/native/，自包含发布后可能展开到根目录
            var baseDir = AppDomain.CurrentDomain.BaseDirectory;
            var rid = Environment.Is64BitProcess ? "win-x64" : "win-x86";
            var nativeDir = Path.Combine(baseDir, "runtimes", rid, "native");
            if (!Directory.Exists(nativeDir))
                nativeDir = baseDir;   // 自包含发布：原生文件直接输出到根目录

            // 检查 BrowserSubprocess 是否存在，若 runtimes 目录不存在则使用根目录
            var subprocessPath = Path.Combine(nativeDir, "CefSharp.BrowserSubprocess.exe");
            if (!File.Exists(subprocessPath) && nativeDir != baseDir)
            {
                nativeDir = baseDir;
                subprocessPath = Path.Combine(baseDir, "CefSharp.BrowserSubprocess.exe");
            }

            // locales 目录可能在根目录或 locales 子目录
            var localesDir = Path.Combine(nativeDir, "locales");
            if (!Directory.Exists(localesDir))
                localesDir = nativeDir;

            // ── 浏览器自动化配置（含内置浏览器）：必须在 Cef.Initialize 之前解析，
            //    内置浏览器的远程调试端口是 CEF 启动参数，运行期无法再开启。 ──
            BrowserAutomationConfig baConfig;
            try
            {
                baConfig = LoadBrowserAutomationConfig(configPath);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("browser_automation 启动失败: " + ex.Message, ex);
            }
            BrowserAutomation = baConfig;
            BuiltinBrowser = new BuiltinBrowserHost(baConfig.Builtin);

            var settings = new CefSettings
            {
                CachePath = cachePath,
                UserAgent = "MoonYaDesktop/1.0",
                LogSeverity = LogSeverity.Verbose,
                LogFile = AppDataPaths.PathFor("logs", "cef.log"),
                ResourcesDirPath = nativeDir,
                LocalesDirPath = localesDir,
                BrowserSubprocessPath = subprocessPath,
            };

            // Respect Chromium's GPU compatibility checks and software fallback.
            // Forcing blocked drivers into OSR rendering can leave a black surface.

            // ── 允许 HTTPS 页面向本地 HTTP API 发起请求（Mixed Content + PNA）──
            settings.CefCommandLineArgs.Add("allow-running-insecure-content", "1");
            // ★ 禁用 Tracking Prevention（阻止 localStorage 等 Web API 访问）+ 私有网络请求限制
            settings.CefCommandLineArgs.Add("disable-features", "BlockInsecurePrivateNetworkRequests,BlockInsecurePrivateNetworkRequestsForOtherOrigin,TrackingProtection,PrivacySandboxAdsAPIS,PrivacySandboxCookies,PrivacySandboxFirstPartySets");

            // ── 自动授予麦克风和摄像头权限（无需弹窗授权）──
            settings.CefCommandLineArgs.Add("enable-media-stream", "1");
            // ★ 禁用站点隔离（避免 CefSharp OSR 模式下的渲染问题）
            settings.CefCommandLineArgs.Add("disable-site-isolation-trials", "1");

            // ── 放宽自动播放策略：允许无需用户手势即可播放音频 ──
            //   根因：Ctrl+空格由 C# 全局键盘 Hook 捕获后通过 ExecuteScriptAsync 注入 JS，
            //   该调用不在 Chromium 的"用户手势"上下文中，导致首次创建的 AudioContext
            //   处于 suspended 状态且 resume() 无法激活，PTT 开始/结束提示音丢失。
            //   桌面应用的所有 JS 调用均由 C# 注入，不存在浏览器原生用户手势，
            //   因此必须放开自动播放策略才能让 AudioContext 首次即处于 running。
            settings.CefCommandLineArgs.Add("autoplay-policy", "no-user-gesture-required");

            // ── 内置浏览器远程调试端口（仅回环）──
            //   PuppeteerSharp 通过该端口用 CDP 驱动进程内 CEF 面板，
            //   使浏览器自动化在未安装 Google Chrome 的电脑上同样可用。
            if (baConfig.Builtin.Enabled && baConfig.Builtin.RemoteDebuggingPort > 0)
            {
                var configuredDebuggingPort = baConfig.Builtin.RemoteDebuggingPort;
                baConfig.Builtin.RemoteDebuggingPort = BuiltinBrowserConnection.SelectDebuggingPort(configuredDebuggingPort, frontendPort, baConfig.Port);
                settings.RemoteDebuggingPort = baConfig.Builtin.RemoteDebuggingPort;
                // 在 CEF 初始化前选择可用端口，宿主和自动化服务共享更新后的运行时配置。
                // 不修改随包配置，也不连接占用配置端口的其他进程。
                settings.CefCommandLineArgs.Add("remote-allow-origins", "*");
                var endpointMessage = $"[BuiltinBrowser] configured_port={configuredDebuggingPort} endpoint={BuiltinBrowserConnection.DebuggingAddress(baConfig.Builtin.RemoteDebuggingPort)}";
                Debug.WriteLine(endpointMessage);
                try
                {
                    var diagnosticsFile = BrowserAutomationService.ResolveConfiguredPath(baConfig.DiagnosticsFile);
                    if (!string.IsNullOrWhiteSpace(diagnosticsFile))
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(diagnosticsFile)!);
                        File.AppendAllText(diagnosticsFile, $"[{DateTimeOffset.Now:O}] {endpointMessage}\n");
                    }
                }
                catch (Exception error) { Debug.WriteLine("[BuiltinBrowser] 端点诊断日志写入失败: " + error.Message); }
            }

            // Ensure child processes exit when parent closes
            CefSharpSettings.SubprocessExitIfParentProcessClosed = true;

            // Enable Task-returning async methods in JS bridge
            CefSharpSettings.ConcurrentTaskExecution = true;

            // 标记 shutdown on exit 释放 CEF 资源
            CefSharpSettings.ShutdownOnExit = true;

            // Never kill CEF processes by name: another client/application may own them.
            // SubprocessExitIfParentProcessClosed handles this instance's children.

            // ★ 启动时仅清理 CefSharp 的 HTTP/JS 缓存目录，保留 LocalStorage、Cookies、Session Storage
            //   等持久化数据，避免用户每次启动都需要重新登录。
            //   单实例锁保证不会与仍在运行的客户端争用缓存。
            try
            {
                if (Directory.Exists(cachePath))
                {
                    // 清理每个 Profile 下的 HTTP 缓存、JS 代码缓存、GPU 缓存即可；
                    // Local Storage / Session Storage / Cookies / Login Data 等保留。
                    var cacheDirsToClear = new[] { "Cache", "Code Cache", "GPUCache" };
                    foreach (var profileDir in Directory.GetDirectories(cachePath))
                    {
                        foreach (var dirName in cacheDirsToClear)
                        {
                            var dirPath = Path.Combine(profileDir, dirName);
                            if (!Directory.Exists(dirPath)) continue;
                            try
                            {
                                foreach (var file in Directory.GetFiles(dirPath, "*", SearchOption.AllDirectories))
                                {
                                    try { File.SetAttributes(file, FileAttributes.Normal); } catch { }
                                }
                                Directory.Delete(dirPath, recursive: true);
                                Debug.WriteLine($"[CefCache] 已清理缓存目录: {dirPath}");
                            }
                            catch (Exception dirEx)
                            {
                                Debug.WriteLine($"[CefCache] 清理目录失败 {dirPath}: {dirEx.Message}");
                            }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[CefCache] 清理缓存失败（可能目录被占用）: {ex.Message}");
            }

            // Initialize CEF (must happen before any browser instance)
            var success = Cef.Initialize(settings, performDependencyCheck: false, browserProcessHandler: null);
            if (!success)
            {
                // 记录详细错误信息到日志文件
                var errorLog = AppDataPaths.PathFor("logs", "cef_error.log");
                try
                {
                    File.WriteAllText(errorLog,
                        $"CEF Initialize failed at {DateTime.Now:yyyy-MM-dd HH:mm:ss}\r\n" +
                        $"BaseDir: {AppDomain.CurrentDomain.BaseDirectory}\r\n" +
                        $"CachePath: {cachePath}\r\n" +
                        $"NativeDir: {nativeDir}\r\n" +
                        $"LocalesDir: {localesDir}\r\n" +
                        $"SubprocessPath: {subprocessPath}\r\n" +
                        $"SubprocessExists: {File.Exists(subprocessPath)}\r\n" +
                        $"OS: {Environment.OSVersion}\r\n" +
                        $"Is64Bit: {Environment.Is64BitProcess}\r\n" +
                        $"CurrentDirectory: {Environment.CurrentDirectory}\r\n");
                }
                catch { }
                throw new InvalidOperationException("CefSharp initialization failed. 查看 cef.log 或 cef_error.log 了解详情。");
            }

            // ── Start Browser Automation API server (PuppeteerSharp-based browser control) ──
            try
            {
                BrowserServiceBaseAddress = new UriBuilder(Uri.UriSchemeHttp, baConfig.LoopbackHost, baConfig.Port).Uri;
                BrowserRelayTimeoutMs = baConfig.RelayTimeoutMs;
                // 注入内置浏览器宿主：驱动右侧栏 CEF 面板，不自动切换外部浏览器。
                _browserService = new BrowserAutomationService(baConfig, BuiltinBrowser);
                BrowserSecurityGate = new BrowserSecurityGate(baConfig);
                _browserApiServer = new BrowserApiServer(_browserService, BrowserSecurityGate, baConfig.LoopbackHost, baConfig.Port);
                // 后台启动监听，不阻塞 UI；StartAsync 内部已用 Task.Run 包裹监听循环
                _ = _browserApiServer.StartAsync();
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("browser_automation 启动失败: " + ex.Message, ex);
            }

            // ── System tray icon ──────────────────────────
            var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "yax_rounded.ico");
            _notifyIcon = new System.Windows.Forms.NotifyIcon
            {
                Icon = File.Exists(iconPath) ? new Icon(iconPath) : System.Drawing.SystemIcons.Application,
                Text = "MoonYa",
                Visible = false
            };

            // ── 创建桌宠窗口（桌面透明覆盖，独立于主窗口）──
            //   根据 %AppData%\MoonYa\pet_settings.json 中的 enabled 字段决定是否默认显示。
            //   后续由 user_xinxi.php 中的开关通过 CefSharp JS 桥 petController.setEnabled() 控制。
            try
            {
                PetWindow = new PetWindow(new Uri(BackendBaseAddress!, LocalServiceProtocol.BackendTtsRoute).AbsoluteUri);
                if (LoadPetEnabledFromSettings())
                {
                    // ★ 延迟到主窗口完成首次渲染、消息队列空闲后再显示桌宠。
                    //   在 OnStartup 阶段直接 Show 一个 AllowsTransparency 置顶窗口，
                    //   其 HWND/合成管线尚未就绪，可能出现窗口已创建但不渲染（看不见），
                    //   必须隐藏再显示（即用户重新拨动开关）才出现的问题。
                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        try { PetWindow?.ShowPet(); }
                        catch (Exception ex) { Debug.WriteLine($"[Pet] 延迟显示桌宠失败: {ex.Message}"); }
                    }), System.Windows.Threading.DispatcherPriority.ApplicationIdle);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[Pet] PetWindow 初始化失败: {ex.Message}");
            }

            // Cleanup on exit
            Exit += (_, _) =>
            {
                // 0. 关闭桌宠窗口并保存设置
                try { PetWindow?.Close(); } catch { }
                _notifyIcon?.Dispose();
                _notifyIcon = null;

                // 1. 停止各本地 HTTP API 和后台服务
                try { _apiServer?.Stop(); } catch { }
                RuntimeStartupCancellation.Cancel();
                try { _agentRuntimeService?.Stop(); } catch { }
                try { FrontendService?.Dispose(); } catch { }
                try { Updates?.Dispose(); } catch { }
                try { _executionServer?.Stop(); } catch { }
                try { _crawlerService?.Stop(); } catch { }
                // 停止 LSP API server + 所有 LSP 子进程（PHP Intelephense / Python Pyright / tsserver）
                // LspApiServer.Stop 内部会调用 _lspManager.StopAll() 释放所有 LSP 进程
                try { _lspApiServer?.Stop(); } catch { }
                try
                {
                    var mcpDispose = _mcpClientManager.DisposeAsync().AsTask();
                    mcpDispose.Wait(TimeSpan.FromSeconds(5));
                }
                catch { }

                // 2. 停止浏览器自动化：先停 HTTP 监听，再释放 PuppeteerSharp 浏览器
                // 带硬超时，避免 Dispose 内部 Wait 15秒导致主进程无法退出
                try
                {
                    var browserApiStop = _browserApiServer?.StopAsync();
                    browserApiStop?.Wait(TimeSpan.FromSeconds(3));
                }
                catch { }
                try
                {
                    var browserServiceStop = _browserService?.StopAsync();
                    browserServiceStop?.Wait(TimeSpan.FromSeconds(5));
                }
                catch { }

                // CEF must shut down on the same UI thread that initialized it.
                // Do not terminate unrelated clients' browser subprocesses.
                try { Cef.Shutdown(); }
                catch (Exception error) { Debug.WriteLine("CEF shutdown failed: " + error); }

                // 5. 确保主进程自身退出，避免后台线程/隐藏窗口导致残留
                _singleInstance?.Dispose();
                Environment.Exit(0);
            };

            // Only the owning instance creates a window, after CEF initialization.
            MainWindow = new MainWindow();
            MainWindow.Show();
        }

        // ── 读取 pet_settings.json 的 enabled 字段（决定启动时是否默认显示桌宠）──
        private static bool LoadPetEnabledFromSettings()
        {
            try
            {
                var path = AppDataPaths.PathFor("pet_settings.json");
                if (!File.Exists(path)) return true; // 首次启动默认开启桌宠
                var json = File.ReadAllText(path);
                var doc = JsonSerializer.Deserialize<JsonElement>(json);
                return !doc.TryGetProperty("enabled", out var en) ||
                       en.ValueKind == JsonValueKind.True;
            }
            catch { return true; }
        }

        private static string ResolveLauncherConfigPath()
        {
            var adjacent = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher_config.json");
            var development = Path.GetFullPath(Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", "launcher_config.json"));

            // A failed/incremental debug build can update MoonYa.dll before it
            // reaches the content-copy target, leaving an older adjacent config.
            // Prefer whichever real config file was updated most recently. A
            // published installation has no development candidate and therefore
            // continues to require the config deployed beside the executable.
            var hasAdjacent = File.Exists(adjacent);
            var hasDevelopment = File.Exists(development);
            if (hasAdjacent && hasDevelopment)
            {
                return File.GetLastWriteTimeUtc(development) > File.GetLastWriteTimeUtc(adjacent)
                    ? development
                    : adjacent;
            }
            if (hasAdjacent) return adjacent;
            if (hasDevelopment) return development;
            throw new FileNotFoundException("缺少必填组件配置 launcher_config.json", adjacent);
        }

        private static JsonElement LoadLauncherConfig(string configPath)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(configPath));
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("launcher_config.json 根节点必须是对象");
            return document.RootElement.Clone();
        }

        private static string RequiredString(JsonElement config, string key, string environmentKey)
        {
            var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
            var value = !string.IsNullOrWhiteSpace(fromEnvironment)
                ? fromEnvironment
                : config.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String
                    ? property.GetString()
                    : null;
            if (string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException($"缺少必填配置字段 {key}（环境变量 {environmentKey} 可覆盖）");
            if (!IPAddress.TryParse(value, out var address) || !IPAddress.IsLoopback(address))
                throw new InvalidOperationException($"配置字段 {key} 必须是回环地址");
            return value;
        }

        private static int RequiredPort(JsonElement config, string key, string environmentKey)
        {
            var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
            var parsed = int.TryParse(fromEnvironment, out var environmentPort)
                ? environmentPort
                : config.TryGetProperty(key, out var property) && property.TryGetInt32(out var configuredPort)
                    ? configuredPort
                    : 0;
            if (parsed is < 1 or > 65535)
                throw new InvalidOperationException($"缺少或无效的必填配置字段 {key}（环境变量 {environmentKey} 可覆盖）");
            return parsed;
        }

        private static int RequiredPositiveInt(JsonElement config, string key, string environmentKey)
        {
            var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
            var parsed = int.TryParse(fromEnvironment, out var environmentValue)
                ? environmentValue
                : config.TryGetProperty(key, out var property) && property.TryGetInt32(out var configuredValue)
                    ? configuredValue
                    : 0;
            if (parsed < 1)
                throw new InvalidOperationException($"缺少或无效的必填配置字段 {key}（环境变量 {environmentKey} 可覆盖）");
            return parsed;
        }

        private static Uri RequiredAbsoluteHttpUri(JsonElement config, string key, string environmentKey)
        {
            var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
            var raw = !string.IsNullOrWhiteSpace(fromEnvironment)
                ? fromEnvironment
                : config.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String
                    ? property.GetString()
                    : null;
            if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException($"缺少或无效的必填 HTTP 配置字段 {key}（环境变量 {environmentKey} 可覆盖）");
            return uri;
        }

        private static GrepServiceConfig LoadGrepConfig(JsonElement root)
        {
            if (!root.TryGetProperty("grep", out var grep) || grep.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("launcher_config.json 缺少 grep 配置段");

            string RequiredNestedString(string key, string environmentKey)
            {
                var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
                var value = !string.IsNullOrWhiteSpace(fromEnvironment)
                    ? fromEnvironment
                    : grep.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String
                        ? property.GetString()
                        : null;
                if (string.IsNullOrWhiteSpace(value))
                    throw new InvalidOperationException($"缺少必填配置字段 grep.{key}（环境变量 {environmentKey} 可覆盖）");
                return value;
            }

            int RequiredNestedInt(string key, string environmentKey)
            {
                var fromEnvironment = Environment.GetEnvironmentVariable(environmentKey);
                var value = int.TryParse(fromEnvironment, out var environmentValue)
                    ? environmentValue
                    : grep.TryGetProperty(key, out var property) && property.TryGetInt32(out var configuredValue)
                        ? configuredValue
                        : 0;
                if (value < 1)
                    throw new InvalidOperationException($"缺少或无效的必填配置字段 grep.{key}（环境变量 {environmentKey} 可覆盖）");
                return value;
            }

            var candidateOverride = Environment.GetEnvironmentVariable("MOONYA_RIPGREP_EXECUTABLE_CANDIDATES");
            var candidates = !string.IsNullOrWhiteSpace(candidateOverride)
                ? candidateOverride.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList()
                : grep.TryGetProperty("executable_candidate_paths", out var configuredCandidates) && configuredCandidates.ValueKind == JsonValueKind.Array
                    ? configuredCandidates.EnumerateArray()
                        .Where(item => item.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(item.GetString()))
                        .Select(item => item.GetString()!)
                        .ToList()
                    : new List<string>();
            if (candidates.Count == 0)
                throw new InvalidOperationException("缺少必填配置字段 grep.executable_candidate_paths（环境变量 MOONYA_RIPGREP_EXECUTABLE_CANDIDATES 可覆盖）");

            return new GrepServiceConfig
            {
                DownloadDirectory = RequiredNestedString("download_directory", "MOONYA_RIPGREP_DOWNLOAD_DIRECTORY"),
                DownloadUrl = RequiredNestedString("download_url", "MOONYA_RIPGREP_DOWNLOAD_URL"),
                DownloadTimeoutSeconds = RequiredNestedInt("download_timeout_seconds", "MOONYA_RIPGREP_DOWNLOAD_TIMEOUT_SECONDS"),
                ExecutionTimeoutSeconds = RequiredNestedInt("execution_timeout_seconds", "MOONYA_RIPGREP_EXECUTION_TIMEOUT_SECONDS"),
                ExecutableCandidatePaths = candidates,
            };
        }

        // Read and validate the browser component configuration. Environment
        // variables override file values so production deployment data never
        // needs to be embedded in executable code.
        private static BrowserAutomationConfig LoadBrowserAutomationConfig(string configPath)
        {
            if (!File.Exists(configPath)) throw new FileNotFoundException("launcher_config.json 不存在", configPath);
            using var document = JsonDocument.Parse(File.ReadAllText(configPath));
            var root = document.RootElement;
            if (!root.TryGetProperty("browser_automation", out var ba) || ba.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("launcher_config.json 缺少 browser_automation 配置段");

            string StringValue(string name, string envName = "")
            {
                var envValue = envName.Length == 0 ? null : Environment.GetEnvironmentVariable(envName);
                if (!string.IsNullOrWhiteSpace(envValue)) return envValue;
                return ba.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
                    ? value.GetString() ?? string.Empty
                    : string.Empty;
            }
            int IntValue(string name, string envName = "")
            {
                var envValue = envName.Length == 0 ? null : Environment.GetEnvironmentVariable(envName);
                if (int.TryParse(envValue, out var envInt)) return envInt;
                return ba.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;
            }
            bool BoolValue(string name, string envName = "")
            {
                var envValue = envName.Length == 0 ? null : Environment.GetEnvironmentVariable(envName);
                if (bool.TryParse(envValue, out var envBool)) return envBool;
                return ba.TryGetProperty(name, out var value)
                    && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
                    && value.GetBoolean();
            }
            List<string> StringArray(string name)
            {
                if (!ba.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array) return new List<string>();
                return value.EnumerateArray()
                    .Where(item => item.ValueKind == JsonValueKind.String)
                    .Select(item => item.GetString() ?? string.Empty)
                    .Where(item => !string.IsNullOrWhiteSpace(item))
                    .ToList();
            }

            // 内置浏览器（右侧栏 CEF 面板）：独立子对象，未配置时视为未启用。
            var builtin = new BuiltinBrowserOptions();
            if (ba.TryGetProperty("builtin", out var builtinElement) && builtinElement.ValueKind == JsonValueKind.Object)
            {
                builtin = JsonSerializer.Deserialize<BuiltinBrowserOptions>(
                    builtinElement.GetRawText(),
                    new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower })
                    ?? new BuiltinBrowserOptions();
            }
            // 环境变量覆盖：生产部署无需改动随包配置文件。
            var builtinEnabledEnv = Environment.GetEnvironmentVariable("MOONYA_BUILTIN_BROWSER_ENABLED");
            if (bool.TryParse(builtinEnabledEnv, out var builtinEnabled)) builtin.Enabled = builtinEnabled;
            var builtinPortEnv = Environment.GetEnvironmentVariable("MOONYA_BUILTIN_BROWSER_PORT");
            if (int.TryParse(builtinPortEnv, out var builtinPort)) builtin.RemoteDebuggingPort = builtinPort;
            if (builtin.Enabled) builtin.Validate();

            return new BrowserAutomationConfig
            {
                LoopbackHost = StringValue("loopback_host", "MOONYA_BROWSER_HOST"),
                Port = IntValue("port", "MOONYA_BROWSER_PORT"),
                TrustedDomains = StringArray("trusted_domains"),
                BlockedDomains = StringArray("blocked_domains"),
                ChromiumExecutablePath = StringValue("chromium_executable_path", "MOONYA_BROWSER_EXECUTABLE"),
                ChromiumCandidatePaths = StringArray("chromium_candidate_paths"),
                Headless = BoolValue("headless", "MOONYA_BROWSER_HEADLESS"),
                AutoDownloadChromium = BoolValue("auto_download_chromium", "MOONYA_BROWSER_AUTO_DOWNLOAD"),
                DefaultTimeoutMs = IntValue("default_timeout_ms"),
                ApprovalTimeoutMs = IntValue("approval_timeout_ms"),
                ElementTimeoutMs = IntValue("element_timeout_ms"),
                ViewportWidth = IntValue("viewport_width"),
                ViewportHeight = IntValue("viewport_height"),
                ClickInitialDelayMs = IntValue("click_initial_delay_ms"),
                NetworkIdleTimeoutMs = IntValue("network_idle_timeout_ms"),
                NetworkIdleTimeMs = IntValue("network_idle_time_ms"),
                DomStableMaxWaitMs = IntValue("dom_stable_max_wait_ms"),
                DomStableThresholdMs = IntValue("dom_stable_threshold_ms"),
                DomStablePollMs = IntValue("dom_stable_poll_ms"),
                MutationStableMs = IntValue("mutation_stable_ms"),
                MutationTimeoutMs = IntValue("mutation_timeout_ms"),
                FrameStableMs = IntValue("frame_stable_ms"),
                FrameStableMaxWaitMs = IntValue("frame_stable_max_wait_ms"),
                FrameRetryCount = IntValue("frame_retry_count"),
                FrameCollectionTimeoutMs = IntValue("frame_collection_timeout_ms"),
                OperationTimeoutMs = IntValue("operation_timeout_ms"),
                BuiltinConnectRetryCount = IntValue("builtin_connect_retry_count"),
                BuiltinConnectRetryDelayMs = IntValue("builtin_connect_retry_delay_ms"),
                PerDocumentElementLimit = IntValue("per_document_element_limit"),
                MaxReturnedElements = IntValue("max_returned_elements"),
                PageTextLimit = IntValue("page_text_limit"),
                DefaultWaitMs = IntValue("default_wait_ms"),
                DefaultScrollAmount = IntValue("default_scroll_amount"),
                RelayTimeoutMs = IntValue("relay_timeout_ms"),
                ShutdownTimeoutMs = IntValue("shutdown_timeout_ms"),
                CleanupDelayMs = IntValue("cleanup_delay_ms"),
                DownloadDirectory = StringValue("download_directory", "MOONYA_BROWSER_DOWNLOAD_DIRECTORY"),
                DiagnosticsFile = StringValue("diagnostics_file", "MOONYA_BROWSER_DIAGNOSTICS_FILE"),
                Builtin = builtin,
            };
        }
    }
}
