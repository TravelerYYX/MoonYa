using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services
{
    /// <summary>
    /// Owns the local MoonYa Node agent runtime process and verifies that its
    /// HTTP protocol is ready before the UI starts using coding sessions.
    /// </summary>
    public sealed class AgentRuntimeService : IDisposable
    {
        private const string ProductName = "MoonYa Agent Runtime";
        private const int RuntimeCapabilityVersion = 2;
        private static readonly string[] RequiredCapabilities = {
            "desktop-python-v1", "atomic-tool-compaction-v1", "tool-history-validation-v1", "subagent-office-v1", "custom-models-v1", "unified-storage-v1", "desktop-gateway-v1", "permission-modes-v1", "workspace-changes-v1", "default-workspaces-v1"
        };

        private readonly string _host;
        private readonly int _port;
        private readonly int _lspPort;
        private readonly int _searchPort;
        private readonly string _scriptPath;
        private readonly string _nodePath;
        private readonly string? _executablePath;
        private readonly string _dataPath;
        private readonly string _browserServiceUrl;
        private readonly int _approvalTimeoutMs;
        private readonly int _browserTimeoutMs;
        private readonly Action<string> _diagnostics;
        private readonly KillOnCloseJob _job;
        private Process? _process;
        private CancellationTokenSource? _lifetime;
        private Task? _monitor;

        public Uri BaseAddress => new UriBuilder(Uri.UriSchemeHttp, _host, _port).Uri;
        public bool IsRunning => _process is { HasExited: false };
        public string? StartupError { get; private set; }

        public AgentRuntimeService(string launcherConfigPath, Action<string>? diagnostics = null)
        {
            _diagnostics = diagnostics ?? (message => Debug.WriteLine(message));
            using var document = JsonDocument.Parse(File.ReadAllText(launcherConfigPath));
            if (!document.RootElement.TryGetProperty("agent_runtime", out var config))
                throw new InvalidOperationException("launcher_config.json 缺少 agent_runtime 配置段");

            _host = RequiredString(config, "host");
            _port = RequiredPort(config, "port");
            _lspPort = document.RootElement.TryGetProperty("lsp_port", out var lspPort) && lspPort.TryGetInt32(out var parsedLspPort)
                ? parsedLspPort
                : 58906;
            _searchPort = document.RootElement.TryGetProperty("crawler_port", out var searchPort) && searchPort.TryGetInt32(out var parsedSearchPort)
                ? parsedSearchPort
                : 58901;
            _executablePath = FindCandidate(config, "executable_candidate_paths", launcherConfigPath);
            _scriptPath = _executablePath == null
                ? ResolveCandidate(config, "script_candidate_paths", launcherConfigPath, requireExisting: true)
                : string.Empty;
            _nodePath = _executablePath == null ? ResolveNode(config, launcherConfigPath) : string.Empty;
            _dataPath = AppDataPaths.DirectoryFor("agent-runtime");
            if (!document.RootElement.TryGetProperty("browser_automation", out var browserConfig)
                || browserConfig.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("launcher_config.json 缺少 browser_automation 配置段");
            var browserHost = RequiredString(browserConfig, "loopback_host");
            var browserPort = RequiredPort(browserConfig, "port");
            _approvalTimeoutMs = RequiredPositiveInt(browserConfig, "approval_timeout_ms");
            _browserTimeoutMs = RequiredPositiveInt(browserConfig, "relay_timeout_ms");
            _browserServiceUrl = new UriBuilder(Uri.UriSchemeHttp, browserHost, browserPort).Uri.ToString().TrimEnd('/');
            _job = new KillOnCloseJob("MoonYaAgentRuntime", _diagnostics);
        }

        public async Task StartAsync(CancellationToken cancellationToken = default)
        {
            if (IsRunning) return;
            StartupError = null;
            Directory.CreateDirectory(_dataPath);
            _process?.Dispose();
            _process = null;
            if (_lifetime == null || _lifetime.IsCancellationRequested)
            {
                _lifetime?.Dispose();
                _lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            }
            try
            {
                await EnsurePortAvailableAsync(cancellationToken).ConfigureAwait(false);
                LaunchProcess();
                await WaitUntilHealthyAsync(_process!, cancellationToken).ConfigureAwait(false);
                _monitor = MonitorAsync(_process!, _lifetime.Token);
            }
            catch
            {
                try
                {
                    if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
                }
                catch { }
                _process?.Dispose();
                _process = null;
                throw;
            }
        }

        /// <summary>
        /// 启动前确保端口可用。
        ///
        /// 背景：如果上一次 MoonYa 异常退出（崩溃 / 被任务管理器结束），Node 运行时
        /// 会变成孤儿进程继续占用端口，新的实例随后启动时 Node 直接
        /// `EADDRINUSE` 崩溃，父进程又会把孤儿实例误判为“健康的自己人”。
        /// 这里在启动前主动探测端口：
        ///   - 端口空闲 → 直接启动；
        ///   - 端口被本产品（MoonYa Agent Runtime）占用 → 请求其退出并等待端口释放
        ///     （旧版本运行时没有该端点，此时给出可执行的错误提示）；
        ///   - 端口被其他程序占用 → 立即失败，绝不静默接管别人的服务。
        /// </summary>
        private async Task EnsurePortAvailableAsync(CancellationToken cancellationToken)
        {
            if (!await IsPortOccupiedAsync(cancellationToken).ConfigureAwait(false)) return;

            var probe = await ProbeHealthAsync(cancellationToken).ConfigureAwait(false);
            if (probe.Status != HealthStatus.Healthy)
            {
                throw new InvalidOperationException(
                    $"Agent Runtime 端口 {_host}:{_port} 已被其他程序占用。" +
                    "请关闭占用该端口的进程后重试（可用 netstat -ano | findstr " + _port + " 查看）。");
            }

            _diagnostics($"[AgentRuntime] 端口 {_port} 上存在上一次运行遗留的运行时实例，正在请求其退出");
            try
            {
                using var client = new HttpClient { BaseAddress = BaseAddress, Timeout = TimeSpan.FromSeconds(3) };
                using var request = new HttpRequestMessage(HttpMethod.Post, "v1/runtime/shutdown");
                request.Headers.Add("x-moonya-runtime", "shutdown");
                using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _diagnostics($"[AgentRuntime] 请求遗留实例退出失败: {ex.Message}");
            }

            if (!await WaitForPortReleaseAsync(TimeSpan.FromSeconds(8), cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException(
                    $"端口 {_host}:{_port} 上遗留的 Agent Runtime（可能是旧版本进程）拒绝退出，" +
                    "请手动结束后重试（任务管理器结束 node.exe / moonya-agent-runtime.exe）。");
            }
        }

        private async Task<bool> IsPortOccupiedAsync(CancellationToken cancellationToken)
        {
            using var client = new TcpClient();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromMilliseconds(600));
            try
            {
                await client.ConnectAsync(_host, _port, timeout.Token).ConfigureAwait(false);
                return true;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return false;
            }
            catch (SocketException)
            {
                return false;
            }
        }

        private async Task<bool> WaitForPortReleaseAsync(TimeSpan timeout, CancellationToken cancellationToken)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
            {
                if (!await IsPortOccupiedAsync(cancellationToken).ConfigureAwait(false)) return true;
                try { await Task.Delay(200, cancellationToken).ConfigureAwait(false); }
                catch (OperationCanceledException) { return false; }
            }
            return !await IsPortOccupiedAsync(cancellationToken).ConfigureAwait(false);
        }

        private void LaunchProcess()
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = _executablePath ?? _nodePath,
                Arguments = _executablePath == null ? $"\"{_scriptPath}\"" : string.Empty,
                WorkingDirectory = _executablePath == null ? Path.GetDirectoryName(_scriptPath)! : Path.GetDirectoryName(_executablePath)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.Environment["MOONYA_FRONTEND_SECRET"] = App.FrontendService?.RuntimeSecret ?? "";
            startInfo.Environment["MOONYA_FRONTEND_URL"] = App.FrontendBaseAddress?.AbsoluteUri.TrimEnd('/') ?? "";
            startInfo.Environment["MOONYA_BACKEND_URL"] = App.BackendBaseAddress?.AbsoluteUri ?? "";
            startInfo.Environment["MOONYA_FRONTEND_DEFAULTS"] = Path.Combine(AppContext.BaseDirectory, "frontend", "defaults.json");
            startInfo.Environment["MOONYA_SKILLS_ROOT"] = Path.Combine(AppContext.BaseDirectory, "agent_runtime", "skills");
            startInfo.Environment["MOONYA_HARNESS_HOST"] = _host;
            startInfo.Environment["MOONYA_HARNESS_PORT"] = _port.ToString();
            startInfo.Environment["MOONYA_HARNESS_DATA"] = _dataPath;
            startInfo.Environment["MOONYA_DATA_ROOT"] = AppDataPaths.Root;
            startInfo.Environment["MOONYA_LOCAL_SERVICE_URL"] = $"http://{_host}:{App.FileServiceBaseAddress?.Port ?? 58900}";
            startInfo.Environment["MOONYA_DESKTOP_HOST_TOKEN"] = DesktopAutomationService.Current.HostToken;
            startInfo.Environment["MOONYA_DESKTOP_PYTHON"] = Path.Combine(AppContext.BaseDirectory, "python", "python.exe");
            // Python cannot open pkg's virtual snapshot; use the shipped physical script.
            startInfo.Environment["MOONYA_DOCUMENT_EXTRACTOR"] = Path.Combine(AppContext.BaseDirectory, "agent_runtime", "src", "extract_document.py");
            startInfo.Environment["MOONYA_DESKTOP_RUNNER"] = Path.Combine(AppContext.BaseDirectory, "agent_runtime", "src", "computer_python", "runner.py");
            startInfo.Environment["MOONYA_LSP_SERVICE_URL"] = $"http://{_host}:{_lspPort}";
            startInfo.Environment["MOONYA_SEARCH_SERVICE_URL"] = $"http://{_host}:{_searchPort}";
            startInfo.Environment["MOONYA_BROWSER_SERVICE_URL"] = _browserServiceUrl;
            startInfo.Environment["MOONYA_APPROVAL_TIMEOUT_MS"] = _approvalTimeoutMs.ToString();
            startInfo.Environment["MOONYA_BROWSER_TIMEOUT_MS"] = _browserTimeoutMs.ToString();

            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _process.OutputDataReceived += (_, eventArgs) => { if (!string.IsNullOrWhiteSpace(eventArgs.Data)) _diagnostics($"[AgentRuntime] {eventArgs.Data}"); };
            _process.ErrorDataReceived += (_, eventArgs) => { if (!string.IsNullOrWhiteSpace(eventArgs.Data)) _diagnostics($"[AgentRuntime:error] {eventArgs.Data}"); };
            if (!_process.Start()) throw new InvalidOperationException("MoonYa Agent Runtime 进程启动失败");
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
            // 让内核在 MoonYa 异常退出时回收运行时，避免孤儿进程占住端口
            _job.Attach(_process);
        }

        private enum HealthStatus { Healthy, Foreign, Unavailable, Incompatible }

        private readonly struct HealthProbe
        {
            public HealthProbe(HealthStatus status, string? detail)
            {
                Status = status;
                Detail = detail;
            }

            public HealthStatus Status { get; }
            public string? Detail { get; }
        }

        /// <summary>
        /// 探测 /health，并要求应答方确实自称 MoonYa Agent Runtime。
        /// 只判断 HTTP 200 会把别的本地服务误当成运行时（进而 "接管" 别人的端口）。
        /// </summary>
        private async Task<HealthProbe> ProbeHealthAsync(CancellationToken cancellationToken, bool requireCapabilities = false)
        {
            try
            {
                using var client = new HttpClient { BaseAddress = BaseAddress, Timeout = TimeSpan.FromSeconds(2) };
                using var response = await client.GetAsync("health", cancellationToken).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                    return new HealthProbe(HealthStatus.Unavailable, $"HTTP {(int)response.StatusCode}");
                var payload = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                using var document = JsonDocument.Parse(payload);
                if (document.RootElement.TryGetProperty("product", out var product) &&
                    string.Equals(product.GetString(), ProductName, StringComparison.Ordinal))
                {
                    // Port reclamation recognizes older MoonYa instances, but
                    // newly launched processes must satisfy this client's contract.
                    if (requireCapabilities && !HasRequiredCapabilities(document.RootElement))
                        return new HealthProbe(HealthStatus.Incompatible,
                            "Agent Runtime 组件版本不兼容：缺少新版虚拟屏幕或工具历史校验能力，请重新构建并更新客户端和运行时。");
                    return new HealthProbe(HealthStatus.Healthy, null);
                }
                return new HealthProbe(HealthStatus.Foreign, "端口应答方不是 MoonYa Agent Runtime");
            }
            catch (Exception ex)
            {
                return new HealthProbe(HealthStatus.Unavailable, ex.Message);
            }
        }

        public static bool HasRequiredCapabilities(JsonElement health)
        {
            if (health.ValueKind != JsonValueKind.Object
                || !health.TryGetProperty("runtime_capability_version", out var version)
                || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var value) || value != RuntimeCapabilityVersion
                || !health.TryGetProperty("capabilities", out var capabilities)
                || capabilities.ValueKind != JsonValueKind.Array) return false;
            var supplied = new HashSet<string>(capabilities.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!));
            return RequiredCapabilities.All(supplied.Contains);
        }

        private async Task WaitUntilHealthyAsync(Process process, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            string? lastError = null;
            while (!timeout.IsCancellationRequested)
            {
                if (process.HasExited)
                    throw new InvalidOperationException($"MoonYa Agent Runtime 提前退出，退出码 {process.ExitCode}");
                var probe = await ProbeHealthAsync(timeout.Token, requireCapabilities: true).ConfigureAwait(false);
                if (probe.Status == HealthStatus.Healthy) return;
                if (probe.Status == HealthStatus.Incompatible)
                    throw new InvalidOperationException(probe.Detail);
                if (probe.Status == HealthStatus.Foreign)
                    throw new InvalidOperationException($"端口 {_host}:{_port} 被非 MoonYa 服务占用: {probe.Detail}");
                lastError = probe.Detail;
                try { await Task.Delay(250, timeout.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
            throw new InvalidOperationException($"MoonYa Agent Runtime 健康检查超时（{_host}:{_port}: {lastError ?? "无响应"}）");
        }

        private async Task MonitorAsync(Process process, CancellationToken cancellationToken)
        {
            try
            {
                await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
                if (cancellationToken.IsCancellationRequested) return;
                await DesktopAutomationService.Current.EndSessionAsync().ConfigureAwait(false);
                StartupError = $"MoonYa Agent Runtime 意外退出，退出码 {process.ExitCode}";
                _diagnostics(StartupError);
                if (ReferenceEquals(_process, process)) _process = null;
                process.Dispose();

                // A bounded restart loop recovers transient runtime crashes while
                // keeping a permanent failure visible in diagnostics.
                for (var attempt = 1; attempt <= 3 && !cancellationToken.IsCancellationRequested; attempt++)
                {
                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken).ConfigureAwait(false);
                        await StartAsync(cancellationToken).ConfigureAwait(false);
                        _diagnostics($"[AgentRuntime] 第 {attempt} 次自动重启成功");
                        return;
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
                    catch (Exception ex)
                    {
                        StartupError = $"MoonYa Agent Runtime 第 {attempt} 次自动重启失败: {ex.Message}";
                        _diagnostics(StartupError);
                    }
                }
            }
            catch (OperationCanceledException) { }
        }

        public void Stop()
        {
            _lifetime?.Cancel();
            _ = DesktopAutomationService.Current.EndSessionAsync();
            var process = _process;
            if (process == null)
            {
                _job.Dispose();
                return;
            }
            try
            {
                if (!process.HasExited)
                {
                    // 先礼貌请运行时自己退出（让它有机会关闭监听与在途会话），
                    // 超时后再强杀，避免每次退出都留下半关闭的连接。
                    if (!TryRequestShutdownAsync(process).GetAwaiter().GetResult())
                    {
                        process.Kill(entireProcessTree: true);
                        process.WaitForExit(3000);
                    }
                }
            }
            catch (Exception ex) { _diagnostics($"[AgentRuntime] 停止失败: {ex.Message}"); }
            finally { process.Dispose(); _process = null; _job.Dispose(); }
        }

        /// <summary>请求运行时优雅退出，返回 false 表示超时未退出（调用方应强杀）。</summary>
        private async Task<bool> TryRequestShutdownAsync(Process process)
        {
            try
            {
                using var client = new HttpClient { BaseAddress = BaseAddress, Timeout = TimeSpan.FromSeconds(2) };
                using var request = new HttpRequestMessage(HttpMethod.Post, "v1/runtime/shutdown");
                request.Headers.Add("x-moonya-runtime", "shutdown");
                using var response = await client.SendAsync(request).ConfigureAwait(false);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
                return true;
            }
            catch
            {
                return process.HasExited;
            }
        }

        public void Dispose()
        {
            Stop();
            _lifetime?.Dispose();
            _job.Dispose();
        }

        private static string RequiredString(JsonElement config, string key)
        {
            var value = config.TryGetProperty(key, out var item) ? item.GetString()?.Trim() : null;
            return string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"agent_runtime.{key} 不能为空") : value;
        }

        private static int RequiredPort(JsonElement config, string key)
        {
            if (!config.TryGetProperty(key, out var item) || !item.TryGetInt32(out var value) || value is < 1 or > 65535)
                throw new InvalidOperationException($"agent_runtime.{key} 不是有效端口");
            return value;
        }

        private static int RequiredPositiveInt(JsonElement config, string key)
        {
            if (!config.TryGetProperty(key, out var item) || !item.TryGetInt32(out var value) || value <= 0)
                throw new InvalidOperationException($"browser_automation.{key} 必须是正整数");
            return value;
        }

        private static string ResolveNode(JsonElement config, string configPath)
        {
            var explicitNode = Environment.GetEnvironmentVariable("MOONYA_NODE_EXECUTABLE");
            if (!string.IsNullOrWhiteSpace(explicitNode)) return explicitNode;
            return ResolveCandidate(config, "node_candidate_paths", configPath, requireExisting: false);
        }

        private static string? FindCandidate(JsonElement config, string key, string configPath)
        {
            if (!config.TryGetProperty(key, out var values) || values.ValueKind != JsonValueKind.Array) return null;
            var roots = new[] { AppDomain.CurrentDomain.BaseDirectory, Path.GetDirectoryName(configPath)!, Directory.GetCurrentDirectory() };
            foreach (var raw in values.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)))
            {
                var expanded = ExpandPath(raw!);
                if (Path.IsPathRooted(expanded) && File.Exists(expanded)) return expanded;
                foreach (var root in roots)
                {
                    var candidate = Path.GetFullPath(Path.Combine(root, expanded));
                    if (File.Exists(candidate)) return candidate;
                }
            }
            return null;
        }

        private static string ResolveCandidate(JsonElement config, string key, string configPath, bool requireExisting)
        {
            if (!config.TryGetProperty(key, out var values) || values.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException($"agent_runtime.{key} 必须是数组");
            var roots = new[] { AppDomain.CurrentDomain.BaseDirectory, Path.GetDirectoryName(configPath)!, Directory.GetCurrentDirectory() };
            foreach (var raw in values.EnumerateArray().Select(value => value.GetString()).Where(value => !string.IsNullOrWhiteSpace(value)))
            {
                var expanded = ExpandPath(raw!);
                if (Path.IsPathRooted(expanded) && File.Exists(expanded)) return expanded;
                foreach (var root in roots)
                {
                    var candidate = Path.GetFullPath(Path.Combine(root, expanded));
                    if (File.Exists(candidate)) return candidate;
                }
                if (!requireExisting && !expanded.Contains(Path.DirectorySeparatorChar) && !expanded.Contains(Path.AltDirectorySeparatorChar))
                    return expanded;
            }
            throw new FileNotFoundException($"找不到 agent_runtime.{key} 配置的运行文件");
        }

        private static string ExpandPath(string value) => Environment.ExpandEnvironmentVariables(value);
    }
}
