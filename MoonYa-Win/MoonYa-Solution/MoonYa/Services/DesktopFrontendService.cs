using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services;

/// <summary>Static UI and an explicit desktop/server boundary. Never executes PHP.</summary>
internal sealed class DesktopFrontendService : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly HttpClient _remote = new(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false });
    private readonly HttpClient _runtime = new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });
    private readonly CancellationTokenSource _stop = new();
    private readonly string _root;
    private readonly Uri _backend;
    private readonly AnnouncementReadStore _announcementRead;
    private readonly Uri _runtimeAddress;
    private readonly SemaphoreSlim _authLock = new(1, 1);
    private string? _verifiedToken;
    private int _userId;
    private DateTimeOffset _expires;
    private DateTimeOffset _checked;
    private readonly string _authFile = AppDataPaths.PathFor("frontend", "identity.dat");
    internal Uri BaseAddress { get; }
    internal string GatewayToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    internal string RuntimeSecret { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    /// <summary>本机媒体路由令牌。&lt;img&gt;/&lt;video&gt; 不能携带自定义请求头，只能走 query。</summary>
    internal string MediaToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    internal bool IsRunning => _listener.IsListening;
    internal string? StartupError { get; private set; }
    internal Func<Task>? MigrationRetryAsync { get; set; }
    internal ProgramUpdateService? Updates { get; set; }
    private static readonly HashSet<string> RemoteRoutes = new(StringComparer.Ordinal) {
        "user_auth.php", "user_profile.php", "user_xinxi.php", "conversation_api.php", "api.php", "context_usage.php",
        "attachment_upload.php", "image-backend.php", "ocr_image.php", "music_api.php", "hot_topics_api.php", "webpage_api.php",
        "api/client_config.php", "api/membership.php", "api/client_feature.php", "api/client_link.php", "api/asr.php", "api/tts.php", "api/work_projects.php",
        "api/download.php", "api/download_search.php", "api/download_crawler.php", "api/builtin_themes.php", "admin/api/updates.php"
    };
    internal DesktopFrontendService(int port, Uri backend, Uri runtimeAddress, string? root = null)
    {
        BaseAddress = new Uri($"http://127.0.0.1:{port}/");
        _backend = new Uri(backend.AbsoluteUri.TrimEnd('/') + "/");
        _announcementRead = new AnnouncementReadStore(_backend);
        _runtimeAddress = runtimeAddress;
        _root = Path.GetFullPath(root ?? Path.Combine(AppContext.BaseDirectory, "frontend"));
        _remote.Timeout = _runtime.Timeout = Timeout.InfiniteTimeSpan;
        _listener.Prefixes.Add(BaseAddress.AbsoluteUri);
        try {
            var bytes = ProtectedData.Unprotect(File.ReadAllBytes(_authFile), null, DataProtectionScope.CurrentUser);
            using var data = JsonDocument.Parse(bytes);
            if (!data.RootElement.TryGetProperty("backend", out var savedBackend) || savedBackend.GetString() != _backend.AbsoluteUri) return;
            _verifiedToken = data.RootElement.GetProperty("token").GetString();
            _userId = data.RootElement.GetProperty("id").GetInt32();
            _expires = data.RootElement.GetProperty("expires").GetDateTimeOffset();
        } catch { /* No verified offline identity on a fresh installation. */ }
    }
    internal bool Start()
    {
        if (IsRunning) return true;
        try {
            if (!File.Exists(Path.Combine(_root, "index.html"))) throw new FileNotFoundException("客户端前端资源缺失，请重新安装或构建 MoonYa。");
            _listener.Start(); StartupError = null;
            _ = ListenAsync(); return true;
        } catch (Exception error) { StartupError = $"本地界面服务启动失败（端口 {BaseAddress.Port}）：{error.Message}"; return false; }
    }
    private async Task ListenAsync()
    {
        while (!_stop.IsCancellationRequested) {
            try { var context = await _listener.GetContextAsync(); _ = HandleAsync(context); }
            catch when (_stop.IsCancellationRequested || !_listener.IsListening) { break; }
        }
    }
    private async Task HandleAsync(HttpListenerContext context)
    {
        var req = context.Request; var res = context.Response;
        try {
            if (req.Url == null || req.Url.Authority != BaseAddress.Authority) { res.StatusCode = 403; return; }
            var origin = req.Headers["Origin"];
            if (!string.IsNullOrEmpty(origin) && origin != BaseAddress.GetLeftPart(UriPartial.Authority)) { res.StatusCode = 403; return; }
            res.Headers["X-Content-Type-Options"] = "nosniff";
            res.Headers["Cache-Control"] = "no-store";
            var path = req.Url.AbsolutePath;
            if (path == "/runtime-config.js") {
                if (req.Headers["Sec-Fetch-Site"] == "cross-site") { res.StatusCode = 403; return; }
                res.ContentType = "text/javascript; charset=utf-8";
                await TextAsync(res, "window.MoonYaHost=" + JsonSerializer.Serialize(new {
                    backendUrl = _backend.AbsoluteUri, gatewayToken = GatewayToken, mediaToken = MediaToken, mediaThumbnails = true,
                    titleBarHeight = 32,
                    // 宿主原生视频能力：内嵌 Chromium 不含 H.264/AAC，mp4/mov 只能由 WPF（Media Foundation）播放。
                    // 前端据此把这类文件交给宿主；旧客户端没有这个能力位，会自动退回「页面内探测 + 诚实拒绝」。
                    nativeVideo = true,
                    nativeVideoExtensions = new[] { ".mp4", ".m4v", ".mov" },
                    services = new { launcher_api_url = BaseAddress.AbsoluteUri.TrimEnd('/') + "/gateway/native",
                        execution_api_url = BaseAddress.AbsoluteUri.TrimEnd('/') + "/gateway/native",
                        browser_api_url = BaseAddress.AbsoluteUri.TrimEnd('/') + "/gateway/native" }
                }) + ";"); return;
            }
            if (path.StartsWith("/gateway/model/", StringComparison.Ordinal)) {
                if (req.Headers["Authorization"] != "Bearer " + RuntimeSecret || _verifiedToken == null || _expires <= DateTimeOffset.UtcNow) { res.StatusCode = 403; return; }
                var modelRoute = (path == $"/gateway/model/{_userId}/chat/completions" || path == $"/gateway/model/{_userId}/responses") && req.HttpMethod == "POST" ? "api/model_proxy.php" :
                    path == $"/gateway/model/{_userId}/catalog" && req.HttpMethod == "GET" ? "api/client_config.php" :
                    path == $"/gateway/model/{_userId}/skills" && req.HttpMethod == "GET" ? "api/skills.php" :
                    path == $"/gateway/model/{_userId}/balance" && req.HttpMethod == "GET" ? "api/membership.php" : null;
                if (modelRoute == null) { res.StatusCode = 403; return; }
                await ProxyAsync(req, res, _remote, new Uri(_backend, modelRoute), _verifiedToken); return;
            }
            if (path.StartsWith("/gateway/", StringComparison.Ordinal)) {
                if (req.Headers["X-MoonYa-Gateway"] != GatewayToken) { res.StatusCode = 403; return; }
                if (path == "/gateway/announcements/feed" && req.HttpMethod == "GET") {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                    timeout.CancelAfter(TimeSpan.FromSeconds(30));
                    using var response = await _remote.GetAsync(new Uri(_backend, "admin/api/announcements.php?action=feed"), timeout.Token);
                    response.EnsureSuccessStatusCode();
                    using var data = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
                    if (!data.RootElement.GetProperty("success").GetBoolean()) throw new InvalidOperationException("公告服务暂时不可用");
                    await JsonAsync(res, new { success = true, data = new { announcements = data.RootElement.GetProperty("data").GetProperty("announcements"), read = await _announcementRead.ReadAsync() } }); return;
                }
                if (path == "/gateway/announcements/read" && req.HttpMethod == "POST") {
                    using var data = await JsonDocument.ParseAsync(req.InputStream);
                    await _announcementRead.AcknowledgeAsync(data.RootElement.GetProperty("id").GetInt64(), data.RootElement.GetProperty("revision").GetInt32());
                    await JsonAsync(res, new { success = true }); return;
                }
                if (path.StartsWith("/gateway/updates/", StringComparison.Ordinal)) {
                    if (Updates == null) { res.StatusCode = 503; await JsonAsync(res, new { success = false, error = "更新服务未就绪" }); return; }
                    if (path == "/gateway/updates/status" && req.HttpMethod == "GET") { await JsonAsync(res, new { success = true, data = Updates.Snapshot() }); return; }
                    if (path == "/gateway/updates/retry" && req.HttpMethod == "POST") { Updates.Retry(); await JsonAsync(res, new { success = true }); return; }
                    if (path == "/gateway/updates/install" && req.HttpMethod == "POST") {
                        try { await Updates.InstallAsync(); await JsonAsync(res, new { success = true }); }
                        catch (Exception error) { res.StatusCode = 409; await JsonAsync(res, new { success = false, error = error.Message }); }
                        return;
                    }
                    res.StatusCode = 405; return;
                }
                if (path.StartsWith("/gateway/native/", StringComparison.Ordinal)) {
                    var nativePath = path["/gateway/native".Length..];
                    var id = nativePath is "/browser/manifest" or "/browser/status" ? 0 : await VerifyIdentityAsync(Bearer(req));
                    if (id == 0 && nativePath is not "/browser/manifest" and not "/browser/status") { res.StatusCode = 401; return; }
                    Uri? target = nativePath switch {
                        "/file-op" or "/cu-op" => App.FileServiceBaseAddress,
                        "/execute" => App.ExecutionServiceBaseAddress,
                        _ when BrowserProtocol.IsAllowedRoute(nativePath) => App.BrowserServiceBaseAddress,
                        _ => null
                    };
                    if (nativePath == "/mcp-op" && req.HttpMethod == "POST") {
                        var body = await new StreamReader(req.InputStream).ReadToEndAsync();
                        res.ContentType = "application/json"; await TextAsync(res, await App.ExecuteMcpOpAsync(body)); return;
                    }
                    if (target == null) { res.StatusCode = 404; return; }
                    await ProxyAsync(req, res, _runtime, new Uri(target, nativePath.TrimStart('/') + req.Url.Query), null); return;
                }
                if (path == "/gateway/migration" && req.HttpMethod == "GET") {
                    var file = AppDataPaths.PathFor("frontend", "migration.dat");
                    var text = "null";
                    if (!File.Exists(AppDataPaths.PathFor("frontend", "migration-complete"))) {
                        if (File.Exists(file)) {
                            text = Encoding.UTF8.GetString(ProtectedData.Unprotect(await File.ReadAllBytesAsync(file), null, DataProtectionScope.CurrentUser));
                            using var manifest = JsonDocument.Parse(text);
                            if (manifest.RootElement.TryGetProperty("version", out var version) && version.GetInt32() == 2) {
                                var count = manifest.RootElement.GetProperty("chunks").GetInt32();
                                if (req.QueryString["chunk"] is string requested) {
                                    if (!int.TryParse(requested, out var index) || index < 0 || index >= count) { res.StatusCode = 400; return; }
                                    var name = manifest.RootElement.GetProperty("backupDirectory").GetString()!;
                                    if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^legacy-v2-[A-F0-9]{16}-[a-f0-9]{32}$")) throw new InvalidOperationException("Invalid migration backup directory");
                                    var chunk = AppDataPaths.PathFor("frontend", name, index.ToString("D8") + ".dat");
                                    text = Encoding.UTF8.GetString(ProtectedData.Unprotect(await File.ReadAllBytesAsync(chunk), null, DataProtectionScope.CurrentUser));
                                } else text = JsonSerializer.Serialize(new { version = 2, source = manifest.RootElement.GetProperty("source").GetString(), chunks = count });
                            }
                        }
                        else if (File.Exists(AppDataPaths.PathFor("frontend", "migration-error.json"))) text = await File.ReadAllTextAsync(AppDataPaths.PathFor("frontend", "migration-error.json"));
                    }
                    res.ContentType = "application/json"; await TextAsync(res, text); return;
                }
                if (path == "/gateway/migration" && req.HttpMethod == "DELETE") {
                    File.WriteAllText(AppDataPaths.PathFor("frontend", "migration-complete"), "1");
                    await TextAsync(res, "{}"); return;
                }
                if (path == "/gateway/migration/retry" && req.HttpMethod == "POST") {
                    if (MigrationRetryAsync != null) await MigrationRetryAsync();
                    await JsonAsync(res, new { success = MigrationRetryAsync != null }); return;
                }
                bool local = path.StartsWith("/gateway/local/", StringComparison.Ordinal);
                var prefix = local ? "/gateway/local/" : "/gateway/remote/";
                if (!path.StartsWith(prefix, StringComparison.Ordinal)) { res.StatusCode = 404; return; }
                var route = path[prefix.Length..];
                byte[]? bufferedBody = null;
                // Reject new user turns only. Resume, approvals, event streams and tool calls
                // belonging to an accepted turn must remain available until it completes.
                if (Updates?.IsUpdateRequired == true && req.HttpMethod == "POST" &&
                    (route == "harness_api.php" || route == "api.php") && string.IsNullOrEmpty(req.QueryString["action"])) {
                    using var buffer = new MemoryStream(); await req.InputStream.CopyToAsync(buffer);
                    bufferedBody = buffer.ToArray();
                    using var body = JsonDocument.Parse(bufferedBody);
                    // Runtime verifies that a resume belongs to a previously accepted message.
                    if (!local || !body.RootElement.TryGetProperty("resume", out var resume) || resume.ValueKind != JsonValueKind.Object) {
                        res.StatusCode = 426;
                        await JsonAsync(res, new { success = false, error_code = "update_required", error = "请先安装更新后继续使用" }); return;
                    }
                }
                if (local) {
                    if (!new HashSet<string> { "harness_api.php", "model_api.php", "statistics.php", "context_usage.php", "prepare.php", "api.php", "api/browser_permissions.php", "api/browser_settings.php", "api/skills.php" }.Contains(route)) { res.StatusCode = 404; return; }
                    var token = Bearer(req);
                    var id = await VerifyIdentityAsync(token);
                    if (id <= 0) { res.StatusCode = 401; await JsonAsync(res, new { success = false, error = "请先登录" }); return; }
                    if (route == "api/browser_settings.php") {
                        var api = App.BrowserApi ?? throw new InvalidOperationException("浏览器服务尚未就绪");
                        if (req.HttpMethod == "GET") { await JsonAsync(res, new { success = true, preferences = api.PreferencesSnapshot() }); return; }
                        if (req.HttpMethod != "POST") { res.StatusCode = 405; return; }
                        using var settings = await JsonDocument.ParseAsync(req.InputStream);
                        if (!settings.RootElement.TryGetProperty("chrome", out var chrome) || chrome.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                            !settings.RootElement.TryGetProperty("edge", out var edge) || edge.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) {
                            res.StatusCode = 400; await JsonAsync(res, new { success = false, error = "浏览器设置无效" }); return;
                        }
                        var preferences = await api.SavePreferencesAsync(chrome.GetBoolean(), edge.GetBoolean());
                        await JsonAsync(res, new { success = true, preferences }); return;
                    }
                    if (route == "api/browser_permissions.php") {
                        if (req.HttpMethod == "GET") { await JsonAsync(res, new { success = true, permissions = App.BrowserSecurityGate?.ListPersistentPermissions() ?? Array.Empty<object>() }); return; }
                        using var data = await JsonDocument.ParseAsync(req.InputStream);
                        var host = data.RootElement.GetProperty("host").GetString() ?? "";
                        var revoked = App.BrowserSecurityGate?.RevokeSessionPermission(host, "user:" + id) ?? false;
                        await JsonAsync(res, new { success = revoked }); return;
                    }
                    await ProxyAsync(req, res, _runtime, new Uri(_runtimeAddress, "v1/desktop/" + route + req.Url.Query), null, id, bufferedBody);
                } else {
                    if (!RemoteRoutes.Contains(route)) { res.StatusCode = 404; return; }
                    // Checkout and provider callbacks are server pages, never desktop proxy routes.
                    if (route == "api/membership.php" && req.HttpMethod is not ("GET" or "POST")) { res.StatusCode = 405; return; }
                    // Login/session replies populate a verified offline identity, never an arbitrary frontend user id.
                    if (route == "user_auth.php") { await AuthProxyAsync(req, res); return; }
                    await ProxyAsync(req, res, _remote, new Uri(_backend, route + req.Url.Query), Bearer(req));
                }
                return;
            }
            if (req.HttpMethod != "GET" && req.HttpMethod != "HEAD") { res.StatusCode = 405; return; }
            if (path == "/local-media") { await ServeLocalMediaAsync(req, res); return; }
            if (path == "/" || path == "/index.php" || path == "/office/index.php") path = "/index.html";
            path = Uri.UnescapeDataString(path);
            if (path.StartsWith("/script/MoonYa-index/", StringComparison.Ordinal)) path = path["/script/MoonYa-index".Length..];
            if (path.Contains('\0') || path.Contains('\\')) { res.StatusCode = 400; return; }
            var filePath = Path.GetFullPath(Path.Combine(_root, path.TrimStart('/')));
            if (!filePath.StartsWith(_root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(filePath) || Path.GetExtension(filePath).Equals(".php", StringComparison.OrdinalIgnoreCase) ||
                (File.GetAttributes(filePath) & FileAttributes.ReparsePoint) != 0) { res.StatusCode = 404; return; }
            res.ContentType = Mime(filePath); res.ContentLength64 = new FileInfo(filePath).Length;
            if (req.HttpMethod != "HEAD") { using var stream = File.OpenRead(filePath); await stream.CopyToAsync(res.OutputStream, _stop.Token); }
        } catch (UnauthorizedAccessException) { res.StatusCode = 401; await JsonAsync(res, new { success = false, error = "登录已失效，请重新登录" }); }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException) {
            var localRuntime = req.Url?.AbsolutePath.StartsWith("/gateway/local/", StringComparison.Ordinal) == true;
            res.StatusCode = 503; try { await JsonAsync(res, new { success = false,
                error = localRuntime ? "本地运行时暂不可用，请稍后重试" : "连接不可用，请恢复网络后重试" }); } catch { }
        } catch (Exception error) { System.Diagnostics.Debug.WriteLine("Frontend gateway: " + error.Message); try { res.StatusCode = 500; await JsonAsync(res, new { success = false, error = "本地服务请求失败" }); } catch { } }
        finally { try { res.Close(); } catch { } }
    }
    private static string? Bearer(HttpListenerRequest req) => req.Headers["Authorization"]?.StartsWith("Bearer ", StringComparison.Ordinal) == true ? req.Headers["Authorization"]![7..] : null;
    internal async Task<string> GetRealtimeAsrConfigurationAsync()
    {
        var token = _verifiedToken;
        if (await VerifyIdentityAsync(token) <= 0) throw new UnauthorizedAccessException("请先登录后使用语音识别");
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_backend, "api/asr_key.php"));
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        using var response = await _remote.SendAsync(request, timeout.Token);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(timeout.Token);
    }
    private async Task<int> VerifyIdentityAsync(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return 0;
        await _authLock.WaitAsync();
        try {
            if (token == _verifiedToken && _expires > DateTimeOffset.UtcNow && _checked > DateTimeOffset.UtcNow.AddMinutes(-1)) return _userId;
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(_backend, "user_auth.php?action=check_session"));
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try {
                using var response = await _remote.SendAsync(request, timeout.Token);
                if (response.StatusCode == HttpStatusCode.Unauthorized) { if (token == _verifiedToken) ClearIdentity(); return 0; }
                if ((int)response.StatusCode >= 500) throw new HttpRequestException();
                using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
                var data = json.RootElement.GetProperty("data");
                if (!data.GetProperty("logged_in").GetBoolean()) { if (token == _verifiedToken) ClearIdentity(); return 0; }
                SaveIdentity(token, data.GetProperty("user").GetProperty("id").GetInt32(), data.TryGetProperty("expires_in", out var remaining) ? remaining.GetDouble() : null); return _userId;
            } catch (Exception error) when (error is HttpRequestException or TaskCanceledException) {
                if (token == _verifiedToken && _expires > DateTimeOffset.UtcNow) return _userId;
                throw;
            }
        } finally { _authLock.Release(); }
    }
    private void SaveIdentity(string token, int id, double? expiresIn = null)
    {
        if (expiresIn != null) _expires = DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(expiresIn.Value, 0, 1296000));
        else if (token != _verifiedToken) _expires = DateTimeOffset.UtcNow.AddDays(15);
        _verifiedToken = token; _userId = id; _checked = DateTimeOffset.UtcNow;
        Directory.CreateDirectory(Path.GetDirectoryName(_authFile)!);
        File.WriteAllBytes(_authFile, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(new { token, id, backend = _backend.AbsoluteUri, expires = _expires }), null, DataProtectionScope.CurrentUser));
    }
    private void ClearIdentity() { _verifiedToken = null; _userId = 0; _expires = default; if (File.Exists(_authFile)) File.Delete(_authFile); }
    private HttpRequestMessage CreateRequest(HttpListenerRequest req, Uri target, string? token, byte[]? bufferedBody = null)
    {
        var message = new HttpRequestMessage(new HttpMethod(req.HttpMethod), target);
        if (req.HasEntityBody) {
            message.Content = bufferedBody == null ? new StreamContent(req.InputStream) : new ByteArrayContent(bufferedBody);
            if (req.ContentType != null) message.Content.Headers.TryAddWithoutValidation("Content-Type", req.ContentType);
        }
        if (token != null) message.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        message.Headers.TryAddWithoutValidation("Accept", req.Headers["Accept"] ?? "*/*");
        if (req.Headers["Range"] is string range) message.Headers.TryAddWithoutValidation("Range", range);
        if (req.Headers["If-Range"] is string ifRange) message.Headers.TryAddWithoutValidation("If-Range", ifRange);
        return message;
    }
    private async Task AuthProxyAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        if (req.QueryString["action"] == "logout") ClearIdentity();
        using var message = CreateRequest(req, new Uri(_backend, "user_auth.php" + req.Url!.Query), Bearer(req));
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token); timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var response = await _remote.SendAsync(message, timeout.Token);
        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        if (req.QueryString["action"] == "logout") ClearIdentity();
        if (response.IsSuccessStatusCode) {
            using var json = JsonDocument.Parse(text);
            if (json.RootElement.TryGetProperty("data", out var data)) {
                var remaining = data.TryGetProperty("expires_in", out var expiry) ? (double?)expiry.GetDouble() : null;
                if (data.TryGetProperty("token", out var token)) SaveIdentity(token.GetString()!, data.GetProperty("user").GetProperty("id").GetInt32(), remaining);
                else if (data.TryGetProperty("logged_in", out var logged)) {
                    if (!logged.GetBoolean()) { if (Bearer(req) == _verifiedToken) ClearIdentity(); }
                    else if (Bearer(req) is string bearer) SaveIdentity(bearer, data.GetProperty("user").GetProperty("id").GetInt32(), remaining);
                }
            }
        }
        res.StatusCode = (int)response.StatusCode; res.ContentType = "application/json; charset=utf-8"; await TextAsync(res, text);
    }
    private async Task ProxyAsync(HttpListenerRequest req, HttpListenerResponse res, HttpClient client, Uri target, string? token, int userId = 0, byte[]? bufferedBody = null)
    {
        using var message = CreateRequest(req, target, token, bufferedBody);
        if (userId > 0) { message.Headers.Add("X-MoonYa-Desktop-Secret", RuntimeSecret); message.Headers.Add("X-MoonYa-User", userId.ToString()); }
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        lifetime.CancelAfter(TimeSpan.FromSeconds(req.HasEntityBody ? 120 : 30));
        using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, lifetime.Token);
        lifetime.CancelAfter(Timeout.InfiniteTimeSpan);
        res.StatusCode = (int)response.StatusCode;
        res.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";
        if (response.Content.Headers.ContentDisposition != null) res.Headers["Content-Disposition"] = response.Content.Headers.ContentDisposition.ToString();
        if (response.Content.Headers.ContentRange != null) res.Headers["Content-Range"] = response.Content.Headers.ContentRange.ToString();
        if (response.Headers.ETag != null) res.Headers["ETag"] = response.Headers.ETag.ToString();
        if (response.Headers.AcceptRanges.Count > 0) res.Headers["Accept-Ranges"] = string.Join(",", response.Headers.AcceptRanges);
        if (response.Headers.Location != null) { res.StatusCode = 502; await JsonAsync(res, new { success = false, error = "接口不应重定向到网页" }); return; }
        // Do not buffer SSE; propagate disconnects by disposing the upstream stream.
        using var stream = await response.Content.ReadAsStreamAsync(_stop.Token);
        var buffer = new byte[16384]; int count;
        while ((count = await stream.ReadAsync(buffer, _stop.Token)) > 0) {
            await res.OutputStream.WriteAsync(buffer.AsMemory(0, count), _stop.Token);
            await res.OutputStream.FlushAsync(_stop.Token);
        }
    }
    /// <summary>
    /// 按绝对路径流式读取本机背景媒体（不复制文件）。白名单 = 外观主题库中引用过的路径 ∪ 本次
    /// 启动期间用户从选择器显式授予过的文件。支持 HTTP Range，视频才能拖动进度与流式播放。
    /// </summary>
    private async Task ServeLocalMediaAsync(HttpListenerRequest req, HttpListenerResponse res)
    {
        // <img>/<video> 无法携带自定义请求头，令牌只能走 query；应用本身仅监听回环地址。
        if (req.Headers["Sec-Fetch-Site"] == "cross-site") { res.StatusCode = 403; return; }
        if (!string.Equals(req.QueryString["t"], MediaToken, StringComparison.Ordinal)) { res.StatusCode = 403; return; }
        var raw = req.QueryString["path"];
        if (string.IsNullOrWhiteSpace(raw) || raw.Contains('\0')) { res.StatusCode = 400; return; }
        string full;
        try { full = Path.GetFullPath(raw); } catch { res.StatusCode = 400; return; }
        var allowed = App.AppearancePreferences.IsAllowedMediaPath(full)
            || App.LocalFileService?.IsLocallyGrantedFile(full) == true;
        if (!allowed || !File.Exists(full)) { res.StatusCode = 403; return; }
        var info = new FileInfo(full);
        if (info.Length <= 0 || (info.Attributes & FileAttributes.ReparsePoint) != 0) { res.StatusCode = 403; return; }
        if (info.Length > 4L * 1024 * 1024 * 1024) { res.StatusCode = 413; return; }

        if (req.QueryString["thumbnail"] == "1") {
            try {
                var bytes = await MediaThumbnailAsync(full);
                res.ContentType = "image/png";
                res.Headers["Cache-Control"] = "private, max-age=0";
                res.ContentLength64 = bytes.Length;
                if (req.HttpMethod != "HEAD") await res.OutputStream.WriteAsync(bytes, _stop.Token);
            } catch { res.StatusCode = 422; }
            return;
        }

        long start = 0, end = info.Length - 1;
        var range = req.Headers["Range"];
        if (range != null && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase)) {
            var spec = range!["bytes=".Length..].Split('-', 2);
            var rawStart = spec[0].Trim();
            var rawEnd = spec.Length > 1 ? spec[1].Trim() : string.Empty;
            if (rawStart.Length == 0) {
                if (!long.TryParse(rawEnd, out var suffix) || suffix <= 0) { res.StatusCode = 416; res.Headers["Content-Range"] = $"bytes */{info.Length}"; return; }
                start = Math.Max(0, info.Length - suffix);
                end = info.Length - 1;
            } else {
                if (!long.TryParse(rawStart, out start) || start < 0 || start >= info.Length) { res.StatusCode = 416; res.Headers["Content-Range"] = $"bytes */{info.Length}"; return; }
                end = info.Length - 1;
                if (rawEnd.Length > 0 && (!long.TryParse(rawEnd, out end) || end < start)) { res.StatusCode = 416; res.Headers["Content-Range"] = $"bytes */{info.Length}"; return; }
                end = Math.Min(end, info.Length - 1);
            }
            res.StatusCode = 206;
            res.Headers["Content-Range"] = $"bytes {start}-{end}/{info.Length}";
        }

        res.ContentType = Mime(full);
        res.Headers["Accept-Ranges"] = "bytes";
        res.Headers["Cache-Control"] = "private, max-age=0";
        res.ContentLength64 = end - start + 1;
        if (req.HttpMethod == "HEAD") return;

        using var stream = File.Open(full, FileMode.Open, FileAccess.Read, FileShare.Read);
        stream.Seek(start, SeekOrigin.Begin);
        var buffer = new byte[65536];
        var remaining = end - start + 1;
        while (remaining > 0) {
            var read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), _stop.Token);
            if (read <= 0) break;
            await res.OutputStream.WriteAsync(buffer.AsMemory(0, read), _stop.Token);
            remaining -= read;
        }
    }
    // Decode a representative frame with Media Foundation, independently of Chromium codecs
    // and optional Explorer thumbnail providers. Keep the original aspect ratio.
    private static async Task<byte[]> MediaThumbnailAsync(string path)
    {
        var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
        var clip = await Windows.Media.Editing.MediaClip.CreateFromFileAsync(file);
        var composition = new Windows.Media.Editing.MediaComposition();
        composition.Clips.Add(clip);
        try {
            var at = TimeSpan.FromSeconds(Math.Min(1, clip.OriginalDuration.TotalSeconds / 2));
            using var thumbnail = await composition.GetThumbnailAsync(at, 640, 0,
                Windows.Media.Editing.VideoFramePrecision.NearestFrame);
            using var source = thumbnail.AsStreamForRead();
            using var output = new MemoryStream();
            var frame = System.Windows.Media.Imaging.BitmapFrame.Create(source,
                System.Windows.Media.Imaging.BitmapCreateOptions.None, System.Windows.Media.Imaging.BitmapCacheOption.OnLoad);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
            encoder.Frames.Add(frame);
            encoder.Save(output);
            return output.ToArray();
        } finally { composition.Clips.Clear(); }
    }
    private static string Mime(string file) => Path.GetExtension(file).ToLowerInvariant() switch {
        ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8", ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml", ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", ".gif" => "image/gif",
        ".avif" => "image/avif", ".bmp" => "image/bmp",
        ".mp4" or ".m4v" => "video/mp4", ".webm" => "video/webm", ".mov" => "video/quicktime", ".mkv" => "video/x-matroska",
        ".woff2" => "font/woff2", ".woff" => "font/woff", ".ttf" => "font/ttf", ".otf" => "font/otf", ".mp3" => "audio/mpeg", ".wav" => "audio/wav", _ => "application/octet-stream"
    };
    private static async Task TextAsync(HttpListenerResponse response, string text) => await response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes(text));
    private static Task JsonAsync(HttpListenerResponse response, object value) { response.ContentType = "application/json; charset=utf-8"; return TextAsync(response, JsonSerializer.Serialize(value)); }
    public void Dispose() { _stop.Cancel(); _listener.Close(); _remote.Dispose(); _runtime.Dispose(); _stop.Dispose(); }
}
