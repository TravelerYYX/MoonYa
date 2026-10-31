using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using MoonYa.Services;

internal static class BrowserRegressionTests
{
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static int Port() { var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop(); return port; }
    private static BrowserAutomationConfig Copy(BrowserAutomationConfig config) => JsonSerializer.Deserialize<BrowserAutomationConfig>(JsonSerializer.Serialize(config))!;
    private static async Task<JsonElement> Post(HttpClient client, string route, object body) =>
        await (await client.PostAsJsonAsync(route, body)).Content.ReadFromJsonAsync<JsonElement>();

    internal static async Task RunAsync(BrowserAutomationConfig original, string output)
    {
        var preferred = Port();
        Check(BuiltinBrowserConnection.SelectDebuggingPort(preferred) == preferred, "free configured CDP port was replaced");
        Check(BuiltinBrowserConnection.SelectDebuggingPort(preferred, preferred) != preferred, "CDP selected a reserved application port");
        var occupied = new TcpListener(IPAddress.Loopback, 0);
        occupied.Server.ExclusiveAddressUse = true;
        occupied.Start();
        try
        {
            var occupiedPort = ((IPEndPoint)occupied.LocalEndpoint).Port;
            var selectedPort = BuiltinBrowserConnection.SelectDebuggingPort(occupiedPort);
            Check(selectedPort != occupiedPort, "occupied configured CDP port was reused");
            var selected = new TcpListener(IPAddress.Loopback, selectedPort);
            selected.Server.ExclusiveAddressUse = true;
            try { selected.Start(); }
            finally { selected.Stop(); }
            Check(occupied.Server.IsBound, "port selection interfered with the existing listener");
        }
        finally { occupied.Stop(); }

        var config = Copy(original);
        config.Headless = false;
        config.OperationTimeoutMs = 180;
        config.FrameCollectionTimeoutMs = 50;
        config.Builtin.ConnectTimeoutMs = 1000;
        config.RelayTimeoutMs = 3000;
        config.DiagnosticsFile = Path.Combine(output, "startup.log");
        var preferencesFile = Path.Combine(output, "preferences.json");
        var preferences = new BrowserPreferences(preferencesFile);
        Check(!preferences.Allows("chrome") && !preferences.Allows("edge"), "external defaults are not disabled");
        await preferences.SaveAsync(true, false);
        var loaded = new BrowserPreferences(preferencesFile);
        Check(loaded.Allows("chrome") && !loaded.Allows("edge"), "independent preferences did not persist");
        await preferences.SaveAsync(false, false);
        var expiryConfig = Copy(config);
        expiryConfig.ApprovalTimeoutMs = 1;
        var expiringGate = new BrowserSecurityGate(expiryConfig);
        var expiring = await expiringGate.CheckAsync("http://expiry.invalid", "none", "", "user:test", "cold-expiry", 0, "navigate");
        await Task.Delay(15);
        Check(!expiringGate.Decide(expiring.ApprovalToken, "allow_once", "user:test", "cold-expiry", 0, "navigate").Allowed, "expired cold approval was accepted");

        var discovery = new DelayedDiscovery();
        using var browser = new BrowserAutomationService(config, discovery);
        Check(browser.SessionId.Length > 0, "cold session has no authorization identity");
        var originalSession = browser.SessionId;
        await browser.StopAsync();
        Check(browser.SessionId != originalSession && browser.SessionId.Length > 0, "stop did not rotate cold identity");
        var api = new BrowserApiServer(browser, new BrowserSecurityGate(config), "127.0.0.1", Port(), preferences);
        await api.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:" + api.Port), Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            var cold = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "navigate", url = "http://example.invalid", user_context = "user:regression" });
            Check(cold.GetProperty("approval_required").GetBoolean(), "cold navigation did not return site challenge");
            var identity = cold.GetProperty("browser").GetProperty("session_id").GetString();
            var token = cold.GetProperty("approval_token").GetString();
            Check(!string.IsNullOrWhiteSpace(identity) && !string.IsNullOrWhiteSpace(token), "cold challenge is missing identity/token");
            var wrong = await Post(client, BrowserProtocol.AuthorizeRoute, new { approval_token = token, decision = "allow_once", session_id = "other", page_version = 0, action = "navigate", user_context = "user:regression" });
            Check(!wrong.GetProperty("success").GetBoolean(), "wrong session accepted");
            var allowed = await Post(client, BrowserProtocol.AuthorizeRoute, new { approval_token = token, decision = "allow_once", session_id = identity, page_version = 0, action = "navigate", user_context = "user:regression" });
            Check(allowed.GetProperty("success").GetBoolean(), "cold challenge cannot be approved");
            var timer = Stopwatch.StartNew();
            var timedOut = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "navigate", url = "http://example.invalid", user_context = "user:regression" });
            Check(timedOut.GetProperty("error_code").GetString() == "timeout", "panel stall did not hit operation deadline");
            Check(timer.ElapsedMilliseconds < 1800, "panel stall exceeded budget");
            var status = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "status" });
            Check(status.GetProperty("success").GetBoolean() && status.GetProperty("browser").GetProperty("mode").GetString() == "idle", "request after timeout did not execute");
            var nextIdentity = status.GetProperty("browser").GetProperty("session_id").GetString();
            Check(nextIdentity != identity, "timed-out session was reused");

            var previousAttempts = discovery.Attempts;
            var cancelledStartup = Post(client, BrowserProtocol.ExecuteRoute, new { action = "start", operation_id = "cancel-running", user_context = "user:regression" });
            var cancellationTimer = Stopwatch.StartNew();
            while (discovery.Attempts == previousAttempts && cancellationTimer.ElapsedMilliseconds < 1000) await Task.Delay(1);
            Check(discovery.Attempts > previousAttempts, "cancellation test did not reach panel creation");
            await Post(client, BrowserProtocol.CancelRoute, new { operation_id = "cancel-running", user_context = "user:regression" });
            var cancellationResult = await cancelledStartup;
            Check(cancellationResult.GetProperty("error_code").GetString() == "timeout", "active cancellation did not settle once");
            var recovered = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "status" });
            nextIdentity = recovered.GetProperty("browser").GetProperty("session_id").GetString();
            discovery.Complete();
            await Task.Delay(100);
            var late = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "status" });
            Check(late.GetProperty("browser").GetProperty("session_id").GetString() == nextIdentity && !late.GetProperty("browser").GetProperty("running").GetBoolean(), "late discovery resurrected a session");

            foreach (var name in new[] { "chrome", "edge" })
            {
                var disabled = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "start", browser = name });
                Check(disabled.GetProperty("error_code").GetString() == "browser_plugin_disabled", "disabled plugin allowed " + name);
            }
            await api.SavePreferencesAsync(true, false);
            var external = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "navigate", browser = "chrome", url = "http://other.invalid", user_context = "user:regression" });
            Check(external.GetProperty("browser").GetProperty("session_id").GetString() != nextIdentity, "backends share an identity");
            var cross = await Post(client, BrowserProtocol.AuthorizeRoute, new { approval_token = external.GetProperty("approval_token").GetString(), session_id = external.GetProperty("browser").GetProperty("session_id").GetString(), action = "navigate", decision = "allow_once", user_context = "user:regression" });
            Check(!cross.GetProperty("success").GetBoolean(), "external token accepted by builtin gate");
            await api.SavePreferencesAsync(false, false);

            // Cancellation received before the action must also prevent startup.
            await Post(client, BrowserProtocol.CancelRoute, new { operation_id = "cancel-before", user_context = "user:regression" });
            var cancelled = await Post(client, BrowserProtocol.ExecuteRoute, new { action = "start", operation_id = "cancel-before", user_context = "user:regression" });
            Check(cancelled.GetProperty("error_code").GetString() == "timeout", "pre-cancelled action ran");
            var noInstall = Copy(config);
            noInstall.ChromiumExecutablePath = "";
            noInstall.ChromiumCandidatePaths.Clear();
            using var missing = new BrowserAutomationService(noInstall, browser: "edge");
            try { await missing.StartAsync(""); throw new Exception("missing Edge was accepted"); }
            catch (InvalidOperationException error) { Check(error.Message.Contains("Microsoft Edge"), "missing browser error has no actionable browser name"); }
        }
        finally { await api.StopAsync(); }

        // A CDP WebSocket that accepts commands but never answers must not hang startup.
        var debugPort = Port();
        using var listener = new HttpListener();
        listener.Prefixes.Add("http://127.0.0.1:" + debugPort + "/"); listener.Start();
        var transport = Task.Run(async () =>
        {
            try
            {
                while (listener.IsListening)
                {
                    var context = await listener.GetContextAsync();
                    if (context.Request.IsWebSocketRequest) { var socket = await context.AcceptWebSocketAsync(null); _ = socket.WebSocket; }
                    else {
                        var bytes = System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { webSocketDebuggerUrl = "ws://127.0.0.1:" + debugPort + "/devtools/browser/stall" }));
                        context.Response.ContentLength64 = bytes.Length;
                        await context.Response.OutputStream.WriteAsync(bytes); context.Response.Close();
                    }
                }
            }
            catch (HttpListenerException) { } catch (ObjectDisposedException) { }
        });
        config.OperationTimeoutMs = 3000;
        config.RelayTimeoutMs = 4000;
        config.Builtin.ConnectTimeoutMs = 250;
        using var stalled = new BrowserAutomationService(config, new DelayedDiscovery(debugPort, immediate: true));
        var startTimer = Stopwatch.StartNew();
        try { await stalled.StartAsync(""); throw new InvalidOperationException("CDP stall was accepted"); }
        catch (TimeoutException) { }
        Check(startTimer.ElapsedMilliseconds < 1500 && !stalled.IsRunning, "CDP stall exceeded connection budget or published session");
        listener.Stop(); await transport;
        Console.WriteLine("browser cold authorization, isolation, preferences, late completion, cancellation and CDP stall regressions OK");
    }

    private sealed class DelayedDiscovery : IBuiltinBrowserDiscovery
    {
        private readonly TaskCompletionSource<BuiltinPanelTarget?> _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public DelayedDiscovery(int port = 1, bool immediate = false) { RemoteDebuggingPort = port; if (immediate) Complete(); }
        public void Complete() => _ready.TrySetResult(new BuiltinPanelTarget { TargetId = "regression-panel", Address = "about:blank" });
        public bool Enabled => true;
        public bool Prefer => true;
        public int RemoteDebuggingPort { get; }
        public string StartPageAddress => "about:blank";
        private int _attempts;
        public int Attempts => Volatile.Read(ref _attempts);
        public Task<BuiltinPanelTarget?> EnsurePanelAsync(string? url, bool autoOpen, int timeoutMs, CancellationToken cancellationToken) { Interlocked.Increment(ref _attempts); return _ready.Task; }
        public void OnSessionStarted() { }
        public void OnSessionStopped() { }
        public void ResetPanel() { }
        public Task<byte[]?> CapturePanelScreenshotAsync(int timeoutMs) => Task.FromResult<byte[]?>(null);
    }
}
