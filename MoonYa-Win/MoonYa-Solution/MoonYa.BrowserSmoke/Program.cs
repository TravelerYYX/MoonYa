using System.Text;
using System.Text.Json;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Diagnostics;
using MoonYa.Services;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

// 测试页统一用本地 file:// 页面：
// 内置浏览器（CEF 面板）在内核层面不支持 data: URL 导航（会让渲染进程触发断言崩溃），
// 而 file:// 与真实站点走同一条导航路径，更贴近生产场景。
var pageFileIndex = 0;
string DataPage(string html)
{
    var directory = Path.Combine(Path.GetTempPath(), "moonya-browser-smoke");
    Directory.CreateDirectory(directory);
    var path = Path.Combine(directory, "page-" + (++pageFileIndex) + "-" + Guid.NewGuid().ToString("N") + ".html");
    File.WriteAllText(path, html, new UTF8Encoding(false));
    return new Uri(path).AbsoluteUri;
}

static (string ElementId, string Selector) FindElement(string elementsJson, string selector)
{
    using var document = JsonDocument.Parse(elementsJson);
    var observedSelectors = new List<string>();
    foreach (var item in document.RootElement.GetProperty("elements").EnumerateArray())
    {
        observedSelectors.Add(item.GetProperty("css_selector").GetString() ?? "<empty>");
        if (string.Equals(item.GetProperty("css_selector").GetString(), selector, StringComparison.Ordinal))
        {
            return (
                item.GetProperty("element_id").GetString() ?? throw new InvalidOperationException("element_id missing"),
                selector
            );
        }
    }
    throw new InvalidOperationException($"semantic element not found: {selector}; observed: {string.Join(", ", observedSelectors)}");
}

// 参数： [launcher_config.json] | --connect <CEF 远程调试端口> [launcher_config.json]
var connectPort = 0;
var connectTargetFilter = string.Empty;
var externalBrowser = "chrome";
var positionalArgs = new List<string>();
for (var argumentIndex = 0; argumentIndex < args.Length; argumentIndex++)
{
    if (args[argumentIndex] == "--connect"
        && argumentIndex + 1 < args.Length
        && int.TryParse(args[argumentIndex + 1], out var parsedPort))
    {
        connectPort = parsedPort;
        argumentIndex++;
        continue;
    }
    if (args[argumentIndex] == "--target-url" && argumentIndex + 1 < args.Length)
    {
        connectTargetFilter = args[argumentIndex + 1];
        argumentIndex++;
        continue;
    }
    if (args[argumentIndex] == "--external-browser" && argumentIndex + 1 < args.Length) { externalBrowser = args[++argumentIndex]; continue; }
    if (args[argumentIndex] is not ("--contracts-only" or "--serve-connected")) positionalArgs.Add(args[argumentIndex]);
}

var configPath = positionalArgs.Count > 0
    ? Path.GetFullPath(positionalArgs[0])
    : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "MoonYa", "launcher_config.json"));
using var configDocument = JsonDocument.Parse(File.ReadAllText(configPath));
var browserConfig = JsonSerializer.Deserialize<BrowserAutomationConfig>(
    configDocument.RootElement.GetProperty("browser_automation").GetRawText(),
    new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower })
    ?? throw new InvalidOperationException("browser_automation configuration could not be loaded");
Require(
    browserConfig.FrameCollectionTimeoutMs > 0
    && browserConfig.OperationTimeoutMs >= browserConfig.FrameCollectionTimeoutMs
    && browserConfig.RelayTimeoutMs > browserConfig.OperationTimeoutMs
    && browserConfig.BuiltinConnectRetryCount > 0
    && browserConfig.BuiltinConnectRetryDelayMs >= 0,
    "browser timing configuration is missing or inconsistent");

// ── 内置浏览器纯逻辑契约（不需要浏览器/窗口即可运行）──
static void RequireBuiltin(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException("builtin contract failed: " + message);
}

var matcherProbes = new List<BuiltinTargetProbe>
{
    new() { TargetId = "app-1", WindowName = "", Address = "http://localhost/" },
    new() { TargetId = "panel-2", WindowName = BuiltinTargetMatcher.WindowNameMarker, Address = "file:///x/browser_start.html" },
};
RequireBuiltin(
    BuiltinTargetMatcher.FindPanelIndex(matcherProbes, new BuiltinPanelTarget { TargetId = "panel-2" }) == 1,
    "target id signal failed");
RequireBuiltin(
    BuiltinTargetMatcher.FindPanelIndex(matcherProbes, null) == 1,
    "window.name marker signal failed");
var ambiguousProbes = new List<BuiltinTargetProbe>
{
    new() { WindowName = BuiltinTargetMatcher.WindowNameMarker },
    new() { WindowName = BuiltinTargetMatcher.WindowNameMarker },
};
RequireBuiltin(
    BuiltinTargetMatcher.FindPanelIndex(ambiguousProbes, null) == -1,
    "ambiguous panel match must be rejected");
var addressProbes = new List<BuiltinTargetProbe>
{
    new() { TargetId = "a", Address = "http://localhost/" },
    new() { TargetId = "b", Address = "https://example.com/" },
};
RequireBuiltin(
    BuiltinTargetMatcher.FindPanelIndex(addressProbes, new BuiltinPanelTarget { Address = "https://example.com/" }) == 1,
    "address fallback signal failed");
RequireBuiltin(
    BuiltinTargetMatcher.FindPanelIndex(addressProbes, new BuiltinPanelTarget { Address = "https://nope.invalid/" }) == -1,
    "unknown address must not match any target");

var builtinOptions = JsonSerializer.Deserialize<BuiltinBrowserOptions>(
    "{\"enabled\":true,\"prefer\":false,\"remote_debugging_port\":58909,\"connect_timeout_ms\":5000,"
    + "\"isolate_profile\":true,\"cache_path\":\"%LOCALAPPDATA%\\\\MoonYa\\\\CefBrowserPanel\"}",
    new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower })
    ?? throw new InvalidOperationException("builtin options could not be deserialized");
RequireBuiltin(
    builtinOptions.Enabled && !builtinOptions.Prefer && builtinOptions.RemoteDebuggingPort == 58909,
    "builtin option mapping drifted");
builtinOptions.Validate();
RequireBuiltin(
    builtinOptions.ResolveCachePath().Length > 0 && !builtinOptions.ResolveCachePath().Contains('%'),
    "builtin cache path was not expanded");
try
{
    new BuiltinBrowserOptions { Enabled = true, RemoteDebuggingPort = 80 }.Validate();
    throw new InvalidOperationException("invalid builtin port was accepted");
}
catch (InvalidOperationException error) when (error.Message.Contains("builtin", StringComparison.Ordinal))
{
}

Console.WriteLine("builtin contract assertions OK");

var outputDirectory = Path.Combine(Path.GetTempPath(), "moonya-browser-smoke", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(outputDirectory);
browserConfig.Headless = true;
browserConfig.AutoDownloadChromium = false;
browserConfig.DownloadDirectory = outputDirectory;
browserConfig.DiagnosticsFile = Path.Combine(outputDirectory, "diagnostics.log");

var gate = new BrowserSecurityGate(browserConfig);
var siteChallenge = await gate.CheckAsync(
    "http://example.invalid/form", "none", "", "user-one", "session-one", 4, BrowserProtocol.Actions.Navigate);
Require(siteChallenge.ErrorCode == BrowserProtocol.Errors.ApprovalRequired && siteChallenge.ApprovalKind == "site", "first-site challenge missing");
Require(siteChallenge.ExpiresAt.HasValue, "approval expiry metadata missing");
var approvalLifetime = siteChallenge.ExpiresAt!.Value - DateTimeOffset.UtcNow;
Require(
    approvalLifetime > TimeSpan.Zero && approvalLifetime <= TimeSpan.FromMilliseconds(browserConfig.ApprovalTimeoutMs),
    "approval expiry does not follow browser_automation.approval_timeout_ms");
var mismatchedDecision = gate.Decide(
    siteChallenge.ApprovalToken, "allow_once", "user-two", "session-one", 4, BrowserProtocol.Actions.Navigate);
Require(mismatchedDecision.Denied, "approval token accepted for a different user");
var siteDecision = gate.Decide(
    siteChallenge.ApprovalToken, "allow_once", "user-one", "session-one", 4, BrowserProtocol.Actions.Navigate);
Require(siteDecision.Allowed, "site approval was not accepted");
var sensitiveChallenge = await gate.CheckAsync(
    "http://example.invalid/form", "delete_data", "", "user-one", "session-one", 5, BrowserProtocol.Actions.Click);
Require(sensitiveChallenge.ApprovalKind == "sensitive", "sensitive action challenge missing");
var sensitiveDecision = gate.Decide(
    sensitiveChallenge.ApprovalToken, "allow_once", "user-one", "session-one", 5, BrowserProtocol.Actions.Click);
Require(sensitiveDecision.Allowed && sensitiveDecision.ApprovalToken != "", "sensitive approval token missing");
var wrongPageReplay = await gate.CheckAsync(
    "http://example.invalid/form", "delete_data", sensitiveDecision.ApprovalToken,
    "user-one", "session-one", 6, BrowserProtocol.Actions.Click);
Require(!wrongPageReplay.Allowed, "sensitive approval token accepted for a different page version");
var exactReplay = await gate.CheckAsync(
    "http://example.invalid/form", "delete_data", sensitiveDecision.ApprovalToken,
    "user-one", "session-one", 5, BrowserProtocol.Actions.Click);
Require(exactReplay.Allowed, "bound sensitive approval token was rejected");
gate.ClearSession();
var clearedChallenge = await gate.CheckAsync(
    "http://example.invalid/form", "none", "", "user-one", "session-two", 0, BrowserProtocol.Actions.Navigate);
Require(clearedChallenge.ApprovalKind == "site", "site session permission survived session cleanup");

const string redirectedUrl = "https://redirect.invalid/secure";
const string redirectedFingerprint = "aabbccddeeff";
gate.ReportCertificateFailure(redirectedUrl, redirectedFingerprint, "redirect certificate rejected");
var redirectedChallenge = gate.TakeTransportCertificateChallenge(
    "user-one", "session-two", 1, BrowserProtocol.Actions.Navigate);
Require(
    redirectedChallenge?.ApprovalKind == "tls"
    && redirectedChallenge.CertificateFingerprint == redirectedFingerprint
    && redirectedChallenge.ExpiresAt.HasValue,
    "redirected TLS failure did not create a bound challenge");
var redirectedDecision = gate.Decide(
    redirectedChallenge!.ApprovalToken, "allow_once", "user-one", "session-two", 1, BrowserProtocol.Actions.Navigate);
Require(redirectedDecision.Allowed, "redirected TLS approval was rejected");
Require(gate.IsCertificateTrusted(redirectedUrl, redirectedFingerprint), "approved domain and certificate fingerprint were not trusted");
Require(!gate.IsCertificateTrusted(redirectedUrl, "different-fingerprint"), "certificate trust was not fingerprint-specific");
Require(!gate.IsCertificateTrusted("https://another.invalid/secure", redirectedFingerprint), "certificate trust was not domain-specific");

await BrowserRegressionTests.RunAsync(browserConfig, outputDirectory);
if (args.Contains("--contracts-only")) return;

if (args.Contains("--serve-connected"))
{
    Require(connectPort > 0, "--serve-connected requires --connect and a panel target");
    browserConfig.Headless = false;
    using var coldBrowser = new BrowserAutomationService(browserConfig, new ConnectedBuiltinDiscovery(connectPort, "about:blank", connectTargetFilter));
    var probe = new TcpListener(IPAddress.Loopback, 0); probe.Start(); var port = ((IPEndPoint)probe.LocalEndpoint).Port; probe.Stop();
    var coldApi = new BrowserApiServer(coldBrowser, new BrowserSecurityGate(browserConfig), "127.0.0.1", port,
        new BrowserPreferences(Path.Combine(outputDirectory, "live-preferences.json")));
    await coldApi.StartAsync();
    Console.WriteLine(JsonSerializer.Serialize(new { browser_service_url = "http://127.0.0.1:" + port, cold_session_id = coldBrowser.SessionId }));
    try { await Console.In.ReadLineAsync(); } finally { await coldApi.StopAsync(); }
    return;
}

var firstPage = DataPage("""
<!doctype html><html><head><meta charset="utf-8"><title>Browser smoke one</title></head>
<body style="min-height:2200px">
  <label for="name">Name</label><input id="name" autocomplete="name">
  <select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>
  <label><input id="agree" type="checkbox">Agree</label>
  <button id="commit" aria-label="Commit" onclick="document.querySelector('#status').textContent=document.querySelector('#name').value+'|'+document.querySelector('#choice').value+'|'+document.querySelector('#agree').checked">Commit</button>
  <button id="hover" onmouseenter="document.querySelector('#status').textContent='hovered'">Hover</button>
  <a id="download" download="artifact.txt" href="data:text/plain,download-ok">Download</a>
  <div id="editable" contenteditable="true" aria-label="Editable"></div>
  <div id="generic" role="button" tabindex="0" aria-label="Generic action" onclick="status.textContent='generic'">Generic</div>
  <dialog open aria-label="Dialog"><button id="dialog-action">Dialog action</button></dialog>
  <div id="shadow-host"></div>
  <iframe id="frame" title="Frame" srcdoc="<button id='frame-action' aria-label='Frame action'>Frame action</button>"></iframe>
  <iframe title="Delayed frame" srcdoc="<script>setTimeout(function(){var b=document.createElement('button');b.id='delayed-frame-action';b.textContent='Delayed frame action';document.body.appendChild(b)},350)</script>"></iframe>
  <iframe title="Empty frame 1" srcdoc="<p>empty</p>"></iframe>
  <iframe title="Empty frame 2" srcdoc="<p>empty</p>"></iframe>
  <iframe title="Empty frame 3" srcdoc="<p>empty</p>"></iframe>
  <iframe title="Empty frame 4" srcdoc="<p>empty</p>"></iframe>
  <iframe title="Empty frame 5" srcdoc="<p>empty</p>"></iframe>
  <iframe title="Empty frame 6" srcdoc="<p>empty</p>"></iframe>
  <div id="status" aria-live="polite">ready</div>
  <script>
    const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
    const button = document.createElement('button');
    button.id = 'shadow-action'; button.setAttribute('aria-label','Shadow action'); button.textContent='Shadow action';
    button.onclick = () => document.querySelector('#status').textContent = 'shadow'; root.append(button);
  </script>
</body></html>
""");
var secondPage = DataPage("<!doctype html><title>Browser smoke two</title><p>second-page</p>");

if (connectPort > 0)
{
    // ── 内置浏览器（右侧栏 CEF 面板）CDP 连接冒烟 ──
    // 前置条件：MoonYa 桌面端正在运行，且面板浏览器已创建
    //（打开过"浏览器"页签，或以 MOONYA_BUILTIN_BROWSER_EAGER=1 启动桌面端）。
    // 同时清空外部浏览器候选路径：这正是"未安装 Google Chrome 的电脑"场景，
    // 内置链路若失败就没有回退，错误信息会直接暴露原因。
    browserConfig.Headless = false;
    browserConfig.ChromiumExecutablePath = string.Empty;
    browserConfig.ChromiumCandidatePaths.Clear();
    browserConfig.AutoDownloadChromium = false;
    var discovery = new ConnectedBuiltinDiscovery(connectPort, "about:blank", connectTargetFilter);
    using var builtinBrowser = new BrowserAutomationService(browserConfig, discovery);
    try
    {
        await builtinBrowser.StartAsync(firstPage);

        var builtinElements = await builtinBrowser.GetElementsAsync();
        var builtinName = FindElement(builtinElements, "#name");
        var builtinCommit = FindElement(builtinElements, "#commit");
        _ = FindElement(builtinElements, "#frame-action");

        await builtinBrowser.FillAsync(builtinBrowser.ResolveElementTarget(builtinName.ElementId, null), "panel");
        await builtinBrowser.ClickAsync(builtinBrowser.ResolveElementTarget(builtinCommit.ElementId, null));
        await builtinBrowser.WaitForConditionAsync("text", 5000, null, "panel|a|false", null, null);
        Require(await builtinBrowser.GetTextAsync("#status") == "panel|a|false", "builtin form result was not verified");

        var builtinStatus = JsonSerializer.Serialize(await builtinBrowser.GetStatusAsync());
        Require(
            builtinStatus.Contains("\"mode\":\"builtin\"", StringComparison.Ordinal),
            "builtin engine was not reported by status: " + builtinStatus);

        byte[] builtinShot;
        try
        {
            builtinShot = Convert.FromBase64String(await builtinBrowser.ScreenshotBase64Async());
        }
        catch (Exception error)
        {
            throw new InvalidOperationException(
                "内置浏览器 CDP 截图不可用（应用侧会退回 OSR 帧兜底，请确认该兜底路径可用）: " + error.Message, error);
        }
        Require(builtinShot.Length > 8 && builtinShot[0] == 0x89 && builtinShot[1] == 0x50, "builtin screenshot is not a PNG image");

        var panelTabId = builtinBrowser.CurrentTabId;
        Require(
            await builtinBrowser.NewTabAsync(secondPage) == panelTabId,
            "builtin new_tab must reuse the single panel tab");
        Require(builtinBrowser.CurrentUrl == secondPage, "builtin new_tab did not navigate the panel");
        Require((await builtinBrowser.ListTabsAsync()).Length == 1, "builtin list_tabs must report a single tab");
        await builtinBrowser.SwitchTabAsync(panelTabId);
        await builtinBrowser.CloseTabAsync(panelTabId);
        Require(builtinBrowser.CurrentUrl != secondPage, "builtin close_tab must return to the start page");

        Console.WriteLine("builtin browser smoke test OK (CDP connect on port " + connectPort + ")");
    }
    finally
    {
        await builtinBrowser.StopAsync();
    }
    return;
}

var browser = new BrowserAutomationService(browserConfig, browser: externalBrowser);
BrowserApiServer? apiServer = null;
try
{
    await browser.StartAsync(firstPage);
    var frameCollectionTimer = Stopwatch.StartNew();
    var firstInspection = await browser.GetElementsAsync();
    frameCollectionTimer.Stop();
    _ = FindElement(firstInspection, "#frame-action");
    _ = FindElement(firstInspection, "#delayed-frame-action");
    Require(
        frameCollectionTimer.ElapsedMilliseconds <= browserConfig.FrameCollectionTimeoutMs + 2000,
        $"frame collection exceeded its global budget: {frameCollectionTimer.ElapsedMilliseconds}ms");
    Console.WriteLine($"frame collection budget test OK ({frameCollectionTimer.ElapsedMilliseconds}ms)");
    var loopbackAddress = IPAddress.Parse(browserConfig.LoopbackHost);
    var portProbe = new TcpListener(loopbackAddress, 0);
    portProbe.Start();
    var apiPort = ((IPEndPoint)portProbe.LocalEndpoint).Port;
    portProbe.Stop();
    apiServer = new BrowserApiServer(browser, new BrowserSecurityGate(browserConfig), browserConfig.LoopbackHost, apiPort);
    await apiServer.StartAsync();
    Require(apiServer.IsRunning, "browser API server did not start");
    using (var client = new HttpClient { BaseAddress = new UriBuilder(Uri.UriSchemeHttp, browserConfig.LoopbackHost, apiPort).Uri })
    {
        var manifest = await client.GetFromJsonAsync<JsonElement>(BrowserProtocol.ServiceManifestRoute);
        Require(manifest.GetProperty("success").GetBoolean(), "browser manifest route failed");
        var statusResponse = await client.PostAsJsonAsync(BrowserProtocol.ExecuteRoute, new { action = BrowserProtocol.Actions.Status });
        var statusResult = await statusResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(statusResult.GetProperty("success").GetBoolean() && statusResult.TryGetProperty("browser", out _), "unified status route failed");
        var legacyInspection = await client.GetFromJsonAsync<JsonElement>(BrowserProtocol.LegacyInspectRoute);
        Require(legacyInspection.GetProperty("success").GetBoolean(), "legacy inspect compatibility route failed");
        var observedVersion = legacyInspection.GetProperty("page_version").GetInt64();
        var observedElementId = legacyInspection.GetProperty("dom_elements")[0].GetProperty("element_id").GetString()
            ?? throw new InvalidOperationException("inspect element id missing");
        var scrollResponse = await client.PostAsJsonAsync(BrowserProtocol.ExecuteRoute, new
        {
            action = BrowserProtocol.Actions.Scroll,
            direction = "down",
            amount = browserConfig.DefaultScrollAmount,
        });
        var scrollResult = await scrollResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(scrollResult.GetProperty("success").GetBoolean(), "fast write action failed");
        Require(scrollResult.GetProperty("observation_required").GetBoolean(), "write action did not require a fresh inspect");
        Require(scrollResult.GetProperty("dom_elements").GetArrayLength() == 0, "write action performed a full DOM inspection");
        Require(scrollResult.GetProperty("page_text").GetString() == string.Empty, "write action returned full page text");
        Require(scrollResult.GetProperty("page_version").GetInt64() > observedVersion, "write action did not advance page version");
        try
        {
            _ = browser.ResolveElementTarget(observedElementId, null);
            throw new InvalidOperationException("write action left a stale element usable");
        }
        catch (InvalidOperationException error) when (error.Message.Contains("stale_element", StringComparison.Ordinal))
        {
        }
        var refreshedInspectionResponse = await client.PostAsJsonAsync(
            BrowserProtocol.ExecuteRoute, new { action = BrowserProtocol.Actions.Inspect });
        var refreshedInspection = await refreshedInspectionResponse.Content.ReadFromJsonAsync<JsonElement>();
        var refreshedVersion = refreshedInspection.GetProperty("page_version").GetInt64();
        Require(refreshedInspection.GetProperty("dom_elements").GetArrayLength() > 0, "explicit inspect did not return DOM elements");
        var repeatedInspectionResponse = await client.PostAsJsonAsync(
            BrowserProtocol.ExecuteRoute, new { action = BrowserProtocol.Actions.Inspect });
        var repeatedInspection = await repeatedInspectionResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(repeatedInspection.GetProperty("page_version").GetInt64() == refreshedVersion, "read-only inspect advanced page version");

        var normalOperationTimeout = browserConfig.OperationTimeoutMs;
        var normalFrameTimeout = browserConfig.FrameCollectionTimeoutMs;
        browserConfig.FrameCollectionTimeoutMs = 100;
        browserConfig.OperationTimeoutMs = 200;
        var timedOutResponse = await client.PostAsJsonAsync(BrowserProtocol.ExecuteRoute, new
        {
            action = BrowserProtocol.Actions.Wait,
            condition = "time",
            ms = 2000,
        });
        var timedOutResult = await timedOutResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(timedOutResult.GetProperty("error_code").GetString() == BrowserProtocol.Errors.Timeout, "operation deadline did not return timeout");
        browserConfig.OperationTimeoutMs = normalOperationTimeout;
        browserConfig.FrameCollectionTimeoutMs = normalFrameTimeout;
        var queueReleaseTimer = Stopwatch.StartNew();
        var afterTimeoutResponse = await client.PostAsJsonAsync(
            BrowserProtocol.ExecuteRoute, new { action = BrowserProtocol.Actions.Status });
        queueReleaseTimer.Stop();
        var afterTimeoutResult = await afterTimeoutResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(afterTimeoutResult.GetProperty("success").GetBoolean(), "request after timeout did not execute");
        Require(queueReleaseTimer.ElapsedMilliseconds < 1000, "timed-out request kept the execution lock");
        Console.WriteLine($"operation timeout queue-release test OK ({queueReleaseTimer.ElapsedMilliseconds}ms)");

        var unknownResponse = await client.PostAsJsonAsync(BrowserProtocol.ExecuteRoute, new { action = "unknown_for_contract_test" });
        var unknownResult = await unknownResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(unknownResult.GetProperty("error_code").GetString() == BrowserProtocol.Errors.UnknownAction, "unknown action error code drifted");
        var internalRouteResponse = await client.PostAsJsonAsync(BrowserProtocol.RoutePrefix + "/evaluate", new { js_code = "document.title" });
        var internalRouteResult = await internalRouteResponse.Content.ReadFromJsonAsync<JsonElement>();
        Require(!internalRouteResult.GetProperty("success").GetBoolean(), "internal JavaScript evaluation route is publicly callable");
    }
    var freshBrowser = browser.CreateFresh();
    browser.Dispose();
    browser = freshBrowser;
    await browser.StartAsync(firstPage);
    var elements = await browser.GetElementsAsync();
    var name = FindElement(elements, "#name");
    var choice = FindElement(elements, "#choice");
    var agree = FindElement(elements, "#agree");
    var commit = FindElement(elements, "#commit");
    var hover = FindElement(elements, "#hover");
    var download = FindElement(elements, "#download[href*=\"text\"]");
    _ = FindElement(elements, "#dialog-action");
    _ = FindElement(elements, "#frame-action");

    var shadow = FindElement(elements, "#shadow-action");
    await browser.FillAsync(browser.ResolveElementTarget(name.ElementId, null), "hello");
    await browser.PressAsync(browser.ResolveElementTarget(name.ElementId, null), "End");
    await browser.SelectAsync(browser.ResolveElementTarget(choice.ElementId, null), ["b"]);
    await browser.SetCheckedAsync(browser.ResolveElementTarget(agree.ElementId, null), true);
    await browser.ClickAsync(browser.ResolveElementTarget(commit.ElementId, null));
    await browser.WaitForConditionAsync("text", 3000, null, "hello|b|true", null, null);
    Require(await browser.GetTextAsync("#status") == "hello|b|true", "form result was not verified");

    await browser.HoverAsync(browser.ResolveElementTarget(hover.ElementId, null));
    await browser.WaitForConditionAsync("text", 3000, null, "hovered", null, null);
    await browser.ClickAsync(browser.ResolveElementTarget(shadow.ElementId, null));
    Require(await browser.GetTextAsync("#status") == "shadow", "shadow DOM action failed");
    await browser.SetCheckedAsync(browser.ResolveElementTarget(agree.ElementId, null), false);
    await browser.ScrollAsync("down", browser.DefaultScrollAmount);
    await browser.WaitForConditionAsync("dom_stable", 3000, null, null, null, null);

    var screenshot = Convert.FromBase64String(await browser.ScreenshotBase64Async());
    Require(screenshot.Length > 8 && screenshot[0] == 0x89 && screenshot[1] == 0x50, "screenshot is not a PNG image");

    await browser.ClickAsync(browser.ResolveElementTarget(download.ElementId, null));
    await browser.WaitAsync(1000);
    var downloads = await browser.ListDownloadsAsync();
    Require(downloads.Length > 0, "download artifact was not reported");

    var originalTab = browser.CurrentTabId;
    var newTab = await browser.NewTabAsync(secondPage);
    Require((await browser.ListTabsAsync()).Length >= 2, "new tab was not listed");
    await browser.SwitchTabAsync(originalTab);
    await browser.CloseTabAsync(newTab);
    Require(browser.CurrentTabId == originalTab && browser.CurrentUrl == firstPage, "closing a background tab changed the active tab");

    var oldElementId = name.ElementId;
    await browser.NavigateAsync(secondPage);
    await browser.GetElementsAsync();
    try
    {
        _ = browser.ResolveElementTarget(oldElementId, null);
        throw new InvalidOperationException("stale element was accepted");
    }
    catch (InvalidOperationException error) when (error.Message.Contains("stale_element", StringComparison.Ordinal))
    {
    }

    await browser.BackAsync();
    Require(browser.CurrentUrl == firstPage, "back navigation failed");
    await browser.ForwardAsync();
    Require(browser.CurrentUrl == secondPage, "forward navigation failed");
    await browser.ReloadAsync();
    Require((await browser.GetStatusAsync()) is not null, "status was not returned");

    Console.WriteLine("browser smoke test OK");
}
finally
{
    if (apiServer != null) await apiServer.StopAsync();
    await browser.StopAsync();
    browser.Dispose();
}

/// <summary>
/// 指向"已在运行的应用"的发现桩：不驱动任何窗口，只声明内置浏览器可用与调试端口，
/// 目标页面由服务自身的 CDP 探测（window.name 标记 / 地址）确定。
/// </summary>
internal sealed class ConnectedBuiltinDiscovery : IBuiltinBrowserDiscovery
{
    private readonly int _port;
    private readonly string _startPage;
    private readonly string _targetUrlFilter;

    public ConnectedBuiltinDiscovery(int port, string startPage, string targetUrlFilter = "")
    {
        _port = port;
        _startPage = startPage;
        _targetUrlFilter = targetUrlFilter;
    }

    public bool Enabled => true;

    public bool Prefer => true;

    public int RemoteDebuggingPort => _port;

    public string StartPageAddress => _startPage;

    public Task<BuiltinPanelTarget?> EnsurePanelAsync(
        string? url,
        bool autoOpen,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        // 与宿主 BuiltinBrowserHost 相同的做法：从 CEF 的 /json/list 解析面板页面端点。
        // CEF 浏览器级 target 发现不保证枚举到面板（独立 RequestContext），必须走页面级端点。
        // 面板可能刚创建：做几次短重试。
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var resolved = ResolvePanelTargetAsync(cancellationToken).GetAwaiter().GetResult();
            if (resolved != null) return Task.FromResult<BuiltinPanelTarget?>(resolved);
            Thread.Sleep(300);
        }
        return Task.FromResult<BuiltinPanelTarget?>(null);
    }

    private async Task<BuiltinPanelTarget?> ResolvePanelTargetAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            var json = await client.GetStringAsync(
                "http://localhost:" + _port.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/json/list",
                cancellationToken);
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Array) return null;

            foreach (var entry in document.RootElement.EnumerateArray())
            {
                var type = entry.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                    ? typeElement.GetString() ?? string.Empty
                    : string.Empty;
                if (!string.Equals(type, "page", StringComparison.OrdinalIgnoreCase)) continue;

                var entryUrl = entry.TryGetProperty("url", out var urlElement) && urlElement.ValueKind == JsonValueKind.String
                    ? urlElement.GetString() ?? string.Empty
                    : string.Empty;
                // 面板页面判定：优先显式过滤串；默认排除带缓存时间戳的 MoonYa 主界面页面（?_t=xxx）
                var matches = string.IsNullOrWhiteSpace(_targetUrlFilter)
                    ? !entryUrl.Contains("_t=", StringComparison.Ordinal)
                    : entryUrl.Contains(_targetUrlFilter, StringComparison.OrdinalIgnoreCase);
                if (!matches) continue;

                return new BuiltinPanelTarget
                {
                    TargetId = entry.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String
                        ? idElement.GetString() ?? string.Empty
                        : string.Empty,
                    Address = entryUrl,
                    WindowName = BuiltinTargetMatcher.WindowNameMarker,
                    WebSocketDebuggerUrl = entry.TryGetProperty("webSocketDebuggerUrl", out var wsElement) && wsElement.ValueKind == JsonValueKind.String
                        ? wsElement.GetString() ?? string.Empty
                        : string.Empty,
                };
            }
        }
        catch (Exception error)
        {
            // 解析失败则退回浏览器级端点探测（打印原因便于诊断）
            Console.Error.WriteLine("smoke discovery failed: " + error.GetType().Name + ": " + error.Message);
        }
        return null;
    }

    public void OnSessionStarted() { }

    public void OnSessionStopped() { }

    public void ResetPanel() { }

    public Task<byte[]?> CapturePanelScreenshotAsync(int timeoutMs) => Task.FromResult<byte[]?>(null);
}
