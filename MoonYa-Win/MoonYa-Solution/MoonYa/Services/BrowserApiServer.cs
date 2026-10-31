using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services
{
    /// <summary>Loopback-only HTTP adapter for the versioned browser contract.</summary>
    public sealed class BrowserApiServer
    {
        private BrowserAutomationService _service;
        private readonly BrowserSecurityGate _securityGate;
        private readonly Dictionary<string, BrowserApiServer> _backends = new(StringComparer.Ordinal);
        private readonly BrowserPreferences _preferences;
        private readonly string _backend;
        private readonly SemaphoreSlim _settingsLock = new(1, 1);
        private CancellationTokenSource? _activeOperation;
        private readonly ConcurrentDictionary<string, (CancellationTokenSource Source, string User)> _operations = new();
        private readonly ConcurrentDictionary<string, DateTimeOffset> _cancelledOperations = new();
        private readonly string _loopbackHost;
        private readonly int _port;
        private HttpListener? _listener;
        private CancellationTokenSource? _cts;
        private Task? _listenTask;
        private int _screenshotIndex;
        private readonly SemaphoreSlim _executionLock = new(1, 1);

        public int Port => _port;
        public bool IsRunning => _listener?.IsListening ?? false;

        public BrowserApiServer(
            BrowserAutomationService service,
            BrowserSecurityGate securityGate,
            string loopbackHost,
            int port, BrowserPreferences? preferences = null, string backend = "builtin")
        {
            _backend = backend;
            _preferences = preferences ?? new BrowserPreferences(AppDataPaths.PathFor("browser-preferences.json"));
            _service = service ?? throw new ArgumentNullException(nameof(service));
            _securityGate = securityGate ?? throw new ArgumentNullException(nameof(securityGate));
            _loopbackHost = string.IsNullOrWhiteSpace(loopbackHost)
                ? throw new ArgumentException("loopbackHost 不能为空", nameof(loopbackHost))
                : loopbackHost;
            _port = port > 0 ? port : throw new ArgumentOutOfRangeException(nameof(port));
            if (backend == "builtin")
                foreach (var name in new[] { "chrome", "edge" })
                    _backends[name] = new BrowserApiServer(new BrowserAutomationService(service.Configuration, browser: name),
                        new BrowserSecurityGate(service.Configuration), loopbackHost, port, _preferences, name);
        }

        public Task StartAsync()
        {
            if (IsRunning) return Task.CompletedTask;
            _cts = new CancellationTokenSource();
            foreach (var worker in _backends.Values) worker._cts = _cts;
            _listener = new HttpListener();
            _listener.Prefixes.Add($"http://{_loopbackHost}:{_port}/");
            try
            {
                _listener.Start();
            }
            catch (HttpListenerException ex)
            {
                System.Diagnostics.Debug.WriteLine($"BrowserApiServer start failed: {ex.Message}");
                return Task.CompletedTask;
            }
            _listenTask = Task.Run(() => ListenLoop(_cts.Token));
            return Task.CompletedTask;
        }

        public async Task StopAsync()
        {
            _cts?.Cancel();
            CancelActiveOperation();
            foreach (var worker in _backends.Values) await worker.StopAsync();
            await _executionLock.WaitAsync();
            try { await _service.StopAsync(); _securityGate.ClearSession(); }
            finally { _executionLock.Release(); }
            try { _listener?.Stop(); } catch (Exception) { }
            try { _listener?.Close(); } catch (Exception) { }
            if (_listenTask != null)
            {
                try { await _listenTask; } catch (Exception) { }
            }
        }

        private async Task ListenLoop(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested && _listener?.IsListening == true)
            {
                try
                {
                    var contextTask = _listener.GetContextAsync();
                    var completed = await Task.WhenAny(contextTask, Task.Delay(Timeout.Infinite, cancellationToken));
                    if (completed != contextTask || cancellationToken.IsCancellationRequested) break;
                    var context = await contextTask;
                    _ = Task.Run(() => HandleRequest(context), cancellationToken);
                }
                catch (OperationCanceledException) { break; }
                catch (HttpListenerException) { break; }
                catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"BrowserApiServer: {ex.Message}"); }
            }
        }

        private async Task HandleRequest(HttpListenerContext context)
        {
            var request = context.Request;
            var response = context.Response;
            try
            {
                if (request.HttpMethod == "OPTIONS")
                {
                    response.StatusCode = 204;
                    response.Close();
                    return;
                }
                var remote = request.RemoteEndPoint?.Address;
                if (remote == null || (!IPAddress.IsLoopback(remote)))
                {
                    await Respond(response, Error(BrowserProtocol.Errors.InvalidRequest, "只允许本地访问"));
                    return;
                }

                var body = string.Empty;
                if (request.HasEntityBody)
                {
                    using var reader = new StreamReader(request.InputStream, request.ContentEncoding);
                    body = await reader.ReadToEndAsync();
                }
                var path = request.Url?.AbsolutePath ?? string.Empty;
                var method = request.HttpMethod;

                var input = ParseBody(body);
                var backend = DefaultString(GetString(input, "browser"), "builtin");
                if (method == "GET") backend = DefaultString(request.QueryString["browser"] ?? "", backend);
                var worker = backend == "builtin" ? this : _backends.GetValueOrDefault(backend);
                if (worker == null) { await Respond(response, Error(BrowserProtocol.Errors.InvalidRequest, "未知浏览器: " + backend)); return; }
                await worker.ProcessBrowserRequest(response, path, method, body);
            }
            catch (Exception ex)
            {
                await Respond(response, Error(ErrorCode(ex), CleanError(ex.Message)));
            }
        }

        public object PreferencesSnapshot() => _preferences.Snapshot();

        private void CancelActiveOperation()
        {
            try { _activeOperation?.Cancel(); } catch (ObjectDisposedException) { }
        }

        public async Task<object> SavePreferencesAsync(bool chrome, bool edge)
        {
            await _settingsLock.WaitAsync();
            try
            {
                await _preferences.SaveAsync(chrome, edge);
                foreach (var worker in _backends.Values)
                {
                    if (_preferences.Allows(worker._backend)) continue;
                    worker.CancelActiveOperation();
                    await worker._executionLock.WaitAsync();
                    try { await worker._service.StopAsync(); worker._securityGate.ClearSession(); }
                    finally { worker._executionLock.Release(); }
                }
                return _preferences.Snapshot();
            }
            finally { _settingsLock.Release(); }
        }

        private async Task ProcessBrowserRequest(HttpListenerResponse response, string path, string method, string body)
        {
            if (!_preferences.Allows(_backend))
            {
                await Respond(response, Error("browser_plugin_disabled", "请先在插件页面开启 " + (_backend == "chrome" ? "Google Chrome" : "Microsoft Edge") + " 操控权限。"));
                return;
            }
            try
            {
                if (path == BrowserProtocol.CancelRoute && method == "POST")
                {
                    var input = ParseBody(body);
                    var id = GetString(input, "operation_id");
                    var user = GetString(input, "user_context");
                    Require(id, "operation_id");
                    foreach (var expired in _cancelledOperations.Where(item => item.Value < DateTimeOffset.UtcNow)) _cancelledOperations.TryRemove(expired.Key, out _);
                    _cancelledOperations[user + "\n" + id] = DateTimeOffset.UtcNow.AddMilliseconds(_service.OperationTimeoutMs);
                    if (_operations.TryGetValue(id, out var operation) && operation.User == user)
                        try { operation.Source.Cancel(); } catch (ObjectDisposedException) { }
                    await Respond(response, new { success = true });
                    return;
                }
                if (path == BrowserProtocol.ServiceManifestRoute && (method == "GET" || method == "POST"))
                {
                    await Respond(response, new
                    {
                        success = true,
                        base_route = BrowserProtocol.RoutePrefix,
                        execute_route = BrowserProtocol.ExecuteRoute,
                        authorize_route = BrowserProtocol.AuthorizeRoute,
                        actions = BrowserProtocol.Actions.Public.OrderBy(value => value).ToArray(),
                    });
                    return;
                }
                if (path == BrowserProtocol.AuthorizeRoute && method == "POST")
                {
                    var requestBody = ParseBody(body);
                    var operation = GetString(requestBody, "operation");
                    if (operation == "list_permissions")
                    {
                        await Respond(response, new { success = true, permissions = _securityGate.ListPersistentPermissions() });
                        return;
                    }
                    if (operation == "revoke_permission")
                    {
                        var revoked = _securityGate.RevokeSessionPermission(
                            GetString(requestBody, "domain"),
                            GetString(requestBody, "user_context"));
                        await Respond(response, new
                        {
                            success = revoked,
                            error_code = revoked ? null : BrowserProtocol.Errors.InvalidRequest,
                            error = revoked ? null : "站点权限不存在或无法撤销。",
                        });
                        return;
                    }
                    var result = _securityGate.Decide(
                        GetString(requestBody, "approval_token"),
                        GetString(requestBody, "decision"),
                        GetString(requestBody, "user_context"),
                        GetString(requestBody, "session_id"),
                        GetLong(requestBody, "page_version"),
                        GetString(requestBody, "action"));
                    await Respond(response, AuthorizationResponse(result));
                    return;
                }
                if (path == BrowserProtocol.ExecuteRoute && method == "POST")
                {
                    await Execute(response, ParseBody(body));
                    return;
                }

                var legacyAction = LegacyAction(path);
                if (legacyAction != null && (method == "GET" || method == "POST"))
                {
                    var legacyBody = ParseBody(body);
                    using var doc = JsonDocument.Parse(MergeAction(legacyBody, legacyAction));
                    await Execute(response, doc.RootElement);
                    return;
                }
                await Respond(response, Error(BrowserProtocol.Errors.InvalidRequest, $"未知路由: {method} {path}"));
            }
            catch (Exception error) { await Respond(response, Error(ErrorCode(error), CleanError(error.Message))); }
        }

        private async Task Execute(HttpListenerResponse response, JsonElement request)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_cts?.Token ?? CancellationToken.None);
            timeout.CancelAfter(_service.OperationTimeoutMs);
            var entered = false;
            Task<object>? execution = null;
            var service = _service;
            var gate = _securityGate;
            var operationId = GetString(request, "operation_id");
            var user = GetString(request, "user_context");
            if (!string.IsNullOrEmpty(operationId))
            {
                if (!_operations.TryAdd(operationId, (timeout, user))) { await Respond(response, Error(BrowserProtocol.Errors.InvalidRequest, "重复的浏览器操作 ID")); return; }
                if (_cancelledOperations.TryRemove(user + "\n" + operationId, out _)) timeout.Cancel();
            }
            var timer = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                await _executionLock.WaitAsync(timeout.Token);
                entered = true;
                service = _service;
                gate = _securityGate;
                _activeOperation = timeout;
                if (!_preferences.Allows(_backend))
                {
                    await Respond(response, Error("browser_plugin_disabled", "外部浏览器插件已关闭。"));
                    return;
                }
                execution = ExecuteCore(request, service, gate, timeout.Token);
                var result = await execution.WaitAsync(timeout.Token);
                await Respond(response, result);
            }
            catch (OperationCanceledException) when (timeout.IsCancellationRequested)
            {
                if (entered)
                {
                    // Retire the entire service object. Late continuations can only
                    // affect this retired session, never a subsequent request.
                    _service = service.CreateFresh();
                    gate.ClearSession();
                    await service.AbortAsync();
                    if (execution != null)
                        _ = execution.ContinueWith(async task => { _ = task.Exception; await service.AbortAsync(); }, TaskScheduler.Default).Unwrap();
                }
                service.LogStage("operation", timer.ElapsedMilliseconds, "timeout/cancelled");
                await Respond(response, Error(BrowserProtocol.Errors.Timeout,
                    $"浏览器操作超过配置的总期限或已取消（{service.OperationTimeoutMs}ms）"));
            }
            finally
            {
                if (!string.IsNullOrEmpty(operationId)) _operations.TryRemove(operationId, out _);
                if (entered) { _activeOperation = null; _executionLock.Release(); }
            }
        }

        private async Task<object> ExecuteCore(JsonElement request, BrowserAutomationService service, BrowserSecurityGate securityGate, CancellationToken cancellationToken)
        {
            var action = GetString(request, "action").Trim().ToLowerInvariant();
            if (!BrowserProtocol.Actions.Public.Contains(action))
            {
                return Error(BrowserProtocol.Errors.UnknownAction, "未知浏览器动作: " + action, service);
            }

            var url = GetString(request, "url");
            var riskCategory = GetString(request, "risk_category");
            var approvalToken = GetString(request, "approval_token");
            var userContext = GetString(request, "user_context");
            var selector = string.Empty;
            var hasElementTarget = !string.IsNullOrWhiteSpace(GetString(request, "element_id"))
                || !string.IsNullOrWhiteSpace(GetString(request, "selector"));
            if (RequiresElement(action) || (action == BrowserProtocol.Actions.Press && hasElementTarget))
            {
                selector = service.ResolveElementTarget(GetString(request, "element_id"), GetString(request, "selector"));
                var inferredRisk = await service.ClassifySensitiveActionAsync(
                    selector, action, GetString(request, "key"));
                cancellationToken.ThrowIfCancellationRequested();
                if (!string.Equals(inferredRisk, "none", StringComparison.Ordinal))
                {
                    riskCategory = inferredRisk;
                }
            }
            var authorizationUrl = action is BrowserProtocol.Actions.Start or BrowserProtocol.Actions.Navigate or BrowserProtocol.Actions.NewTab
                ? url
                : service.CurrentUrl;
            if (!string.IsNullOrWhiteSpace(authorizationUrl)
                && (action is BrowserProtocol.Actions.Start
                    or BrowserProtocol.Actions.Navigate
                    or BrowserProtocol.Actions.NewTab
                    or BrowserProtocol.Actions.Click
                    or BrowserProtocol.Actions.Press
                    or BrowserProtocol.Actions.Check
                    or BrowserProtocol.Actions.Uncheck))
            {
                var authorization = await securityGate.CheckAsync(
                    authorizationUrl,
                    riskCategory,
                    approvalToken,
                    userContext,
                    service.SessionId,
                    service.PageVersion,
                    action,
                    cancellationToken);
                if (!authorization.Allowed)
                {
                    return AuthorizationResponse(authorization, service);
                }
            }

            var beforeUrl = service.CurrentUrl;
            var beforePageVersion = service.PageVersion;
            var beforeFactsFingerprint = service.IsRunning
                ? await service.GetPageFactsFingerprintAsync()
                : string.Empty;
            var screenshot = string.Empty;
            object? actionData = null;

            cancellationToken.ThrowIfCancellationRequested();
            securityGate.ClearTransportCertificateFailures();
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                switch (action)
                {
                case BrowserProtocol.Actions.Start:
                    await service.StartAsync(url, cancellationToken);
                    break;
                case BrowserProtocol.Actions.Status:
                    break;
                case BrowserProtocol.Actions.Stop:
                    await service.StopAsync();
                    securityGate.ClearSession();
                    break;
                case BrowserProtocol.Actions.Navigate:
                    Require(url, "url");
                    await service.NavigateAsync(url, cancellationToken);
                    break;
                case BrowserProtocol.Actions.Back:
                    await service.BackAsync();
                    break;
                case BrowserProtocol.Actions.Forward:
                    await service.ForwardAsync();
                    break;
                case BrowserProtocol.Actions.Reload:
                    await service.ReloadAsync();
                    break;
                case BrowserProtocol.Actions.Inspect:
                    break;
                case BrowserProtocol.Actions.Screenshot:
                    break;
                case BrowserProtocol.Actions.Click:
                    await service.ClickAsync(selector);
                    break;
                case BrowserProtocol.Actions.Fill:
                    await service.FillAsync(selector, GetString(request, "text"));
                    break;
                case BrowserProtocol.Actions.Hover:
                    await service.HoverAsync(selector);
                    break;
                case BrowserProtocol.Actions.Press:
                    var key = GetString(request, "key");
                    Require(key, "key");
                    await service.PressAsync(string.IsNullOrWhiteSpace(selector) ? null : selector, key);
                    break;
                case BrowserProtocol.Actions.Select:
                    actionData = new { selected_values = await service.SelectAsync(selector, GetStringArray(request, "values")) };
                    break;
                case BrowserProtocol.Actions.Check:
                    await service.SetCheckedAsync(selector, true);
                    break;
                case BrowserProtocol.Actions.Uncheck:
                    await service.SetCheckedAsync(selector, false);
                    break;
                case BrowserProtocol.Actions.Scroll:
                    await service.ScrollAsync(DefaultString(GetString(request, "direction"), "down"), GetInt(request, "amount", service.DefaultScrollAmount));
                    break;
                case BrowserProtocol.Actions.Wait:
                    var waitSelector = string.Empty;
                    if (!string.IsNullOrWhiteSpace(GetString(request, "element_id")) || !string.IsNullOrWhiteSpace(GetString(request, "selector")))
                    {
                        waitSelector = service.ResolveElementTarget(GetString(request, "element_id"), GetString(request, "selector"));
                    }
                    await service.WaitForConditionAsync(
                        DefaultString(GetString(request, "condition"), "time"),
                        GetInt(request, "ms", service.DefaultWaitMs),
                        waitSelector,
                        GetString(request, "text"),
                        GetString(request, "url"),
                        GetString(request, "state"));
                    break;
                case BrowserProtocol.Actions.NewTab:
                    if (!service.IsRunning)
                    {
                        await service.StartAsync(url, cancellationToken);
                        actionData = new { tab_id = service.CurrentTabId };
                    }
                    else actionData = new { tab_id = await service.NewTabAsync(url).WaitAsync(cancellationToken) };
                    break;
                case BrowserProtocol.Actions.ListTabs:
                    actionData = new { tabs = await service.ListTabsAsync() };
                    break;
                case BrowserProtocol.Actions.SwitchTab:
                    var switchId = GetString(request, "tab_id");
                    Require(switchId, "tab_id");
                    await service.SwitchTabAsync(switchId);
                    break;
                case BrowserProtocol.Actions.CloseTab:
                    await service.CloseTabAsync(GetString(request, "tab_id"));
                    break;
                case BrowserProtocol.Actions.ListDownloads:
                    actionData = new { downloads = await service.ListDownloadsAsync() };
                    break;
                }
                if (InvalidatesObservation(action)) service.InvalidateObservation();
                cancellationToken.ThrowIfCancellationRequested();
            }
            catch
            {
                cancellationToken.ThrowIfCancellationRequested();
                var transportChallenge = securityGate.TakeTransportCertificateChallenge(
                    userContext, service.SessionId, service.PageVersion, action);
                if (transportChallenge != null)
                {
                    return AuthorizationResponse(transportChallenge, service);
                }
                throw;
            }

            var completedTransportChallenge = securityGate.TakeTransportCertificateChallenge(
                userContext, service.SessionId, service.PageVersion, action);
            if (completedTransportChallenge != null)
            {
                return AuthorizationResponse(completedTransportChallenge, service);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var browserStatus = await service.GetStatusAsync();
            var pageText = string.Empty;
            var pageVersion = service.PageVersion;
            object[] elements = Array.Empty<object>();
            object? focusedElement = null;
            if (service.IsRunning && action == BrowserProtocol.Actions.Inspect)
            {
                await service.PrepareInspectionAsync(cancellationToken);
                var inspectionJson = await service.GetElementsAsync(cancellationToken);
                using var inspectionDoc = JsonDocument.Parse(inspectionJson);
                var inspection = inspectionDoc.RootElement;
                pageText = GetString(inspection, "page_text");
                pageVersion = GetLong(inspection, "page_version");
                elements = inspection.TryGetProperty("elements", out var elementArray)
                    ? elementArray.EnumerateArray().Select(item => (object)item.Clone()).ToArray()
                    : Array.Empty<object>();
                foreach (var item in elements.OfType<JsonElement>())
                {
                    if (!item.TryGetProperty("focused", out var focused) || focused.ValueKind != JsonValueKind.True) continue;
                    focusedElement = item;
                    break;
                }
            }

            if (service.IsRunning && ShouldScreenshot(action))
            {
                cancellationToken.ThrowIfCancellationRequested();
                screenshot = await service.ScreenshotBase64Async();
                cancellationToken.ThrowIfCancellationRequested();
                _screenshotIndex++;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var currentUrl = service.CurrentUrl;
            var afterFactsFingerprint = service.IsRunning
                ? await service.GetPageFactsFingerprintAsync()
                : string.Empty;
            cancellationToken.ThrowIfCancellationRequested();
            var pageChanged = !string.Equals(beforeUrl, currentUrl, StringComparison.Ordinal)
                || (!string.IsNullOrEmpty(beforeFactsFingerprint)
                    && !string.Equals(beforeFactsFingerprint, afterFactsFingerprint, StringComparison.Ordinal));
            var pageTitle = await CurrentTitleAsync(service);
            cancellationToken.ThrowIfCancellationRequested();
            return new
            {
                success = true,
                error_code = (string?)null,
                action,
                browser = browserStatus,
                page_url = currentUrl,
                page_title = pageTitle,
                page_version = pageVersion,
                page_text = pageText,
                dom_elements = elements,
                focused_element = focusedElement,
                page_changed = pageChanged,
                observation_required = service.IsRunning && InvalidatesObservation(action),
                change_hint = ChangeHint(beforeUrl, currentUrl, action),
                change_evidence = new
                {
                    before_url = beforeUrl,
                    after_url = currentUrl,
                    before_page_version = beforePageVersion,
                    after_page_version = pageVersion,
                    facts_changed = pageChanged,
                    before_fingerprint = string.IsNullOrEmpty(beforeFactsFingerprint) ? null : beforeFactsFingerprint,
                    after_fingerprint = string.IsNullOrEmpty(afterFactsFingerprint) ? null : afterFactsFingerprint,
                },
                screenshot = string.IsNullOrWhiteSpace(screenshot) ? null : screenshot,
                index = string.IsNullOrWhiteSpace(screenshot) ? (int?)null : _screenshotIndex,
                data = actionData,
            };
        }

        private async Task<string> CurrentTitleAsync(BrowserAutomationService service)
        {
            if (!service.IsRunning) return string.Empty;
            var statusJson = JsonSerializer.Serialize(await service.GetStatusAsync());
            using var doc = JsonDocument.Parse(statusJson);
            return GetString(doc.RootElement, "title");
        }

        private static bool RequiresElement(string action) => action is
            BrowserProtocol.Actions.Click or BrowserProtocol.Actions.Fill or BrowserProtocol.Actions.Hover
            or BrowserProtocol.Actions.Select or BrowserProtocol.Actions.Check or BrowserProtocol.Actions.Uncheck;

        private static bool ShouldScreenshot(string action) => action is not
            BrowserProtocol.Actions.Status and not BrowserProtocol.Actions.Stop and not BrowserProtocol.Actions.ListTabs
            and not BrowserProtocol.Actions.ListDownloads and not BrowserProtocol.Actions.Wait;

        private static bool InvalidatesObservation(string action) => action is
            BrowserProtocol.Actions.Start or BrowserProtocol.Actions.Navigate or BrowserProtocol.Actions.Back
            or BrowserProtocol.Actions.Forward or BrowserProtocol.Actions.Reload or BrowserProtocol.Actions.Click
            or BrowserProtocol.Actions.Fill or BrowserProtocol.Actions.Hover or BrowserProtocol.Actions.Press
            or BrowserProtocol.Actions.Select or BrowserProtocol.Actions.Check or BrowserProtocol.Actions.Uncheck
            or BrowserProtocol.Actions.Scroll or BrowserProtocol.Actions.NewTab or BrowserProtocol.Actions.SwitchTab
            or BrowserProtocol.Actions.CloseTab;

        private static string? LegacyAction(string path)
        {
            if (string.Equals(path, BrowserProtocol.LegacyInspectRoute, StringComparison.Ordinal))
            {
                return BrowserProtocol.Actions.Inspect;
            }
            return BrowserProtocol.Actions.Public.FirstOrDefault(action =>
                string.Equals(path, BrowserProtocol.LegacyRoute(action), StringComparison.Ordinal));
        }

        private object AuthorizationResponse(BrowserAuthorizationChallenge result, BrowserAutomationService? service = null) => new
        {
            success = result.Allowed,
            error_code = result.Allowed ? null : result.ErrorCode,
            error = result.Allowed ? null : result.Reason,
            approval_required = !result.Allowed && !result.Denied,
            approval_token = result.ApprovalToken,
            approval_kind = result.ApprovalKind,
            url = result.Url,
            domain = result.Domain,
            reason = result.Reason,
            certificate_fingerprint = result.CertificateFingerprint,
            risk_category = result.RiskCategory,
            action = result.Action,
            page_version = result.PageVersion,
            expires_at = result.ExpiresAt,
            browser = BrowserState(service),
            page_url = (service ?? _service).CurrentUrl,
            authorize_route = BrowserProtocol.AuthorizeRoute,
        };

        private object Error(string errorCode, string message, BrowserAutomationService? service = null) => new
        {
            success = false,
            error_code = errorCode,
            error = message,
            browser = BrowserState(service),
            page_url = (service ?? _service).CurrentUrl,
            page_version = (service ?? _service).PageVersion,
        };

        private object BrowserState(BrowserAutomationService? service = null) => new
        {
            backend = _backend,
            mode = (service ?? _service).IsRunning ? _backend : "idle",
            running = (service ?? _service).IsRunning,
            session_id = (service ?? _service).SessionId,
            page_version = (service ?? _service).PageVersion,
            tab_id = (service ?? _service).CurrentTabId,
        };

        private static string ErrorCode(Exception exception)
        {
            var message = exception.Message ?? string.Empty;
            if (message.StartsWith(BrowserProtocol.Errors.StaleElement + ":", StringComparison.Ordinal)) return BrowserProtocol.Errors.StaleElement;
            if (message.StartsWith(BrowserProtocol.Errors.ElementNotFound + ":", StringComparison.Ordinal)) return BrowserProtocol.Errors.ElementNotFound;
            if (message.StartsWith(BrowserProtocol.Errors.BrowserLaunchFailed + ":", StringComparison.Ordinal)) return BrowserProtocol.Errors.BrowserLaunchFailed;
            if (exception is TimeoutException) return BrowserProtocol.Errors.Timeout;
            if (exception is ArgumentException or JsonException) return BrowserProtocol.Errors.InvalidRequest;
            if (message.Contains("浏览器未启动", StringComparison.Ordinal)) return BrowserProtocol.Errors.BrowserNotStarted;
            if (message.Contains("元素", StringComparison.Ordinal) && message.Contains("未找到", StringComparison.Ordinal)) return BrowserProtocol.Errors.ElementNotFound;
            return BrowserProtocol.Errors.InternalError;
        }

        private static string CleanError(string message)
        {
            var separator = message.IndexOf(':');
            return separator > 0 && separator < 32 ? message[(separator + 1)..].Trim() : message;
        }

        private static string ChangeHint(string beforeUrl, string afterUrl, string action)
        {
            if (!string.Equals(beforeUrl, afterUrl, StringComparison.Ordinal)) return "页面地址已变化";
            return action switch
            {
                BrowserProtocol.Actions.Inspect => "已刷新页面观察结果",
                BrowserProtocol.Actions.Screenshot => "已截取当前视口并同步页面观察结果",
                BrowserProtocol.Actions.Status => "已读取浏览器状态",
                _ => "操作完成；请根据新的页面版本和元素状态验证结果",
            };
        }

        private static JsonElement ParseBody(string body)
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            return document.RootElement.Clone();
        }

        private static string MergeAction(JsonElement request, string action)
        {
            var values = request.ValueKind == JsonValueKind.Object
                ? request.EnumerateObject().ToDictionary(property => property.Name, property => (object)property.Value.Clone(), StringComparer.Ordinal)
                : new Dictionary<string, object>(StringComparer.Ordinal);
            values["action"] = action;
            return JsonSerializer.Serialize(values);
        }

        private static string GetString(JsonElement element, string name)
        {
            if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property))
            {
                return property.ValueKind == JsonValueKind.String ? property.GetString() ?? string.Empty : property.ToString();
            }
            return string.Empty;
        }

        private static int GetInt(JsonElement element, string name, int fallback)
        {
            return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property) && property.TryGetInt32(out var value)
                ? value
                : fallback;
        }

        private static long GetLong(JsonElement element, string name)
        {
            return element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var property) && property.TryGetInt64(out var value)
                ? value
                : 0L;
        }

        private static string[] GetStringArray(JsonElement element, string name)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array)
            {
                return Array.Empty<string>();
            }
            return property.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString() ?? string.Empty).ToArray();
        }

        private static string DefaultString(string value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;

        private static void Require(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException("缺少 " + name + " 参数");
        }

        private static async Task Respond(HttpListenerResponse response, object body)
        {
            var json = JsonSerializer.Serialize(body, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            var bytes = Encoding.UTF8.GetBytes(json);
            response.StatusCode = 200;
            response.ContentType = "application/json; charset=utf-8";
            response.ContentLength64 = bytes.Length;
            await response.OutputStream.WriteAsync(bytes);
            response.OutputStream.Close();
        }

    }
}
