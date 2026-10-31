using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Forms = System.Windows.Forms;
using Point = System.Drawing.Point;

namespace MoonYa.Services;

/// <summary>The physical primary display and one input owner across all chats.</summary>
public sealed class DesktopAutomationService : IDisposable
{
    public static DesktopAutomationService Current { get; } = new();
    public string HostToken { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ComputerUseService _input = new();
    private readonly Dictionary<string, AppEntry> _apps = new(StringComparer.Ordinal);
    private readonly Dictionary<IntPtr, uint> _captureAffinities = new();
    private readonly Dictionary<string, object> _operations = new();
    private readonly HashSet<string> _unverifiedLaunches = new(StringComparer.Ordinal);
    private readonly HashSet<string> _heldKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _heldButtons = new(StringComparer.Ordinal);
    private readonly object _heldInputLock = new();
    private PhysicalMonitorCapture? _capture;
    private string? _owner;
    private string _viewToken = "";
    private string _deviceName = "";
    private Rectangle _bounds;
    private string _layout = "";
    private uint _dpiX, _dpiY;
    private IntPtr _observedForeground;
    private Rectangle _observedWindow;
    private DateTime _observedAt;
    private DateTime _lastFrame;
    private DateTime _lastActivity;
    private volatile bool _human;
    private volatile bool _stopped;
    private bool _resumeNeedsObservation;
    private double _cursorX, _cursorY;
    private long _cursorSequence;
    private string _cursorAction = "hover";
    private long _cursorTimestamp;
    private readonly System.Threading.Timer _watchdog;
    private DesktopAutomationService()
    {
        _watchdog = new System.Threading.Timer(_ => {
            if (_owner != null && DateTime.UtcNow - _lastActivity > TimeSpan.FromMinutes(15))
                _ = StopAsync(_owner);
        }, null, 10000, 10000);
    }

    public async Task<bool> HandleAsync(HttpListenerContext context)
    {
        var path = context.Request.Url!.AbsolutePath;
        if (!path.StartsWith("/desktop/", StringComparison.Ordinal)) return false;
        if (!IPAddress.IsLoopback(context.Request.RemoteEndPoint!.Address)) { await Reply(context, 403, Failure("local_only", "只允许本机访问。")); return true; }
        try
        {
            if (path == "/desktop/stream") { await StreamAsync(context); return true; }
            if (context.Request.HttpMethod != "POST" || context.Request.Headers["Origin"] != null
                || !SecretEquals(context.Request.Headers["x-moonya-host-token"], HostToken))
            { await Reply(context, 403, Failure("desktop_auth_required", "桌面服务鉴权失败。")); return true; }
            using var reader = new StreamReader(context.Request.InputStream);
            var body = await reader.ReadToEndAsync();
            if (body.Length > 1024 * 1024) throw new InvalidOperationException("请求过大。");
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var id = root.GetProperty("session_id").GetString() ?? "";
            object result = path switch
            {
                "/desktop/start" => await StartAsync(id),
                "/desktop/rpc" => await RpcAsync(id, root.GetProperty("method").GetString() ?? "", root.GetProperty("args"), false, Text(root, "operation_id")),
                "/desktop/control" => await ControlAsync(id, Text(root, "command")),
                "/desktop/release" => await ReleaseAsync(id),
                "/desktop/stop" => await StopAsync(id),
                _ => Failure("unknown_desktop_route", "未知桌面接口。")
            };
            await Reply(context, 200, result);
        }
        catch (Exception ex) { await Reply(context, 200, Failure("desktop_unavailable", ex.Message)); }
        return true;
    }

    public async Task<object> StartAsync(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 128) throw new InvalidOperationException("无效桌面会话。");
        await _gate.WaitAsync();
        try
        {
            if (_owner != null && _owner != id) return Failure("desktop_busy", "另一个聊天正在使用实体桌面，请先结束该桌面会话。");
            if (_owner == id) { ValidateDisplay(); return Descriptor(); }
            using var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "launcher_config.json")));
            if (!config.RootElement.TryGetProperty("desktop_automation", out var section) || Text(section, "provider") != "physical")
                throw new InvalidOperationException("实体桌面未启用；旧虚拟桌面后端已停用。");
            RequireInputDesktop();
            var screen = Forms.Screen.PrimaryScreen ?? throw new InvalidOperationException("没有实体主屏幕。");
            _deviceName = screen.DeviceName; _bounds = screen.Bounds;
            _layout = DisplayLayout();
            ReadDpi(_bounds, out _dpiX, out _dpiY);
            ExcludeMoonYaWindows();
            _capture = new PhysicalMonitorCapture(_deviceName);
            CaptureFrame(true, out _, out _);
            WriteDisplayDiagnostics(new { at = DateTime.UtcNow, event_name = "acquired", provider = "physical", device = _deviceName, bounds = _bounds, dpi_x = _dpiX, dpi_y = _dpiY });
            _owner = id; _viewToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            _human = false; _stopped = false; _observedAt = default; _lastFrame = _lastActivity = DateTime.UtcNow;
            return Descriptor();
        }
        catch { Cleanup(); throw; }
        finally { _gate.Release(); }
    }

    private object Descriptor() => new { success = true, session_id = _owner, display = new { provider = "physical", device = _deviceName, width = _bounds.Width, height = _bounds.Height }, state = _stopped ? "stopped" : _human ? "human" : "ai" };
    public async Task<string> PreviewAsync(string id, int port)
    {
        await _gate.WaitAsync();
        try { RequireOwner(id); return JsonSerializer.Serialize(new { success = true, session_id = id, url = $"ws://127.0.0.1:{port}/desktop/stream?session_id={Uri.EscapeDataString(id)}&token={_viewToken}", width = _bounds.Width, height = _bounds.Height }); }
        catch (Exception ex) { return JsonSerializer.Serialize(Failure("desktop_unavailable", ex.Message)); }
        finally { _gate.Release(); }
    }

    public async Task<object> RpcAsync(string id, string method, JsonElement args, bool human, string operationId = "")
    {
        var generation = _viewToken;
        while (!human && _owner == id && _viewToken == generation && _human && !_stopped) await Task.Delay(100);
        await _gate.WaitAsync();
        try
        {
            RequireOwner(id); ValidateDisplay(); _lastActivity = DateTime.UtcNow;
            if (human) throw new InvalidOperationException("请直接操作实体桌面；预览不转发鼠标键盘输入。");
            if (_viewToken != generation) throw new InvalidOperationException("屏幕会话已重新连接，请重新观察，不能继续旧动作。");
            if (_stopped) throw new InvalidOperationException("屏幕会话已停止。");
            if (_human != human && method != "screenshot") throw new InvalidOperationException("输入控制权已改变。");
            if (!human && _resumeNeedsObservation && method != "screenshot")
                throw new InvalidOperationException("用户已交回控制，请先重新截图观察，再决定后续动作。");
            if (operationId.Length > 0 && _operations.TryGetValue(operationId, out var cached)) return cached;
            // Cache an unknown result before any input. A lost response cannot cause a duplicate side effect.
            if (operationId.Length > 0) _operations[operationId] = Failure("execution_state_unknown", "执行状态未知，请重新观察，不能重放。");
            object result;
            if (method == "screenshot")
            {
                _observedAt = default;
                var foreground = GetForegroundWindow();
                var foregroundBounds = WindowRect(foreground);
                var image = CaptureFrame(true, out var width, out var height);
                if (foreground != GetForegroundWindow() || foregroundBounds != WindowRect(foreground))
                    throw new InvalidOperationException("截图期间窗口状态改变，请重新观察。");
                _lastFrame = _observedAt = DateTime.UtcNow;
                _resumeNeedsObservation = false;
                _observedForeground = foreground; _observedWindow = foregroundBounds;
                result = new { success = true, image = Convert.ToBase64String(image), width, height, display = _deviceName };
            }
            else if (method == "list_apps") result = await DiscoverAppsAsync();
            else if (method == "launch_app") result = await LaunchAsync(Text(args, "name"));
            else if (method == "wait")
            {
                double seconds = args.GetProperty("seconds").GetDouble();
                if (!double.IsFinite(seconds) || seconds < 0 || seconds > 180) throw new InvalidOperationException("等待时间必须为 0–180 秒。");
                // The gate is released during waits so takeover is immediate.
                result = new { success = true, wait_ms = (int)(seconds * 1000) };
            }
            else if (method is "get_clipboard" or "set_clipboard")
            {
                result = await Application.Current.Dispatcher.InvokeAsync<object>(() => {
                    if (method == "set_clipboard") { var text = Text(args, "text"); if (text.Length == 0) Clipboard.Clear(); else Clipboard.SetText(text); return new { success = true }; }
                    return new { success = true, text = Clipboard.ContainsText() ? Clipboard.GetText() : "" };
                });
            }
            else
            {
                if (DateTime.UtcNow - _lastFrame > TimeSpan.FromSeconds(5))
                {
                    // Explicit screenshots also keep a headless task observable.
                    CaptureFrame(false, out _, out _); _lastFrame = DateTime.UtcNow;
                }
                RequireInputDesktop();
                if (!human) RequireObservation();
                result = Input(method, args, human);
                // Give the actual foreground application time to consume queued input.
                if (method != "hover") await Task.Delay(80);
                if (operationId.Length > 0 && _operations.Count > 4096) throw new InvalidOperationException("屏幕动作上限已达到，请结束会话。");
            }
            if (operationId.Length > 0) _operations[operationId] = result;
            return result;
        }
        finally {
            _gate.Release();
        }
    }

    private object Input(string method, JsonElement args, bool human)
    {
        RequireAiInput();
        if (method is "hover" or "click" or "drag" or "scroll" or "pointer_down" or "pointer_up")
        {
            var x = Coordinate(args, "x"); var y = Coordinate(args, "y");
            var p = MapPoint(_bounds, x, y);
            if (method != "hover" && GetWindowThreadProcessId(GetAncestor(WindowFromPoint(p), 2), out var targetPid) != 0
                && targetPid == Environment.ProcessId) throw new InvalidOperationException("目标位置是 MoonYa，不能向自身发送桌面输入。");
            _cursorX = x; _cursorY = y; _cursorAction = method; _cursorSequence++; _cursorTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (method == "hover") { lock (_heldInputLock) { RequireAiInput(); RequireObservation(); return Checked(_input.MouseMove(p.X, p.Y)); } }
            if (method == "click")
            {
                var count = args.GetProperty("count").GetInt32(); var button = Text(args, "button");
                if (count < 1 || count > 3 || !new[] { "left", "right" }.Contains(button)) throw new InvalidOperationException("无效点击参数。");
                lock (_heldInputLock) {
                    RequireAiInput();
                    RequireObservation();
                    _heldButtons.Add(button);
                    for (int i = 0; i < count; i++) Checked(_input.MouseClick(p.X, p.Y, button));
                    _heldButtons.Remove(button);
                }
                return new { success = true };
            }
            if (method == "drag")
            {
                var x2 = Coordinate(args, "x2"); var y2 = Coordinate(args, "y2");
                var end = MapPoint(_bounds, x2, y2);
                lock (_heldInputLock) {
                    RequireAiInput(); RequireObservation(); Checked(_input.MouseMove(p.X, p.Y));
                    _heldButtons.Add("left"); SendMouseButton("left", false);
                }
                try {
                    for (int step = 1; step <= 25; step++) {
                        var next = new Point(p.X + (end.X - p.X) * step / 25, p.Y + (end.Y - p.Y) * step / 25);
                        lock (_heldInputLock) { RequireAiInput(); RequireExternalPoint(next); Checked(_input.MouseMove(next.X, next.Y)); }
                        Thread.Sleep(10);
                    }
                } finally { lock (_heldInputLock) { if (_heldButtons.Remove("left")) SendMouseButton("left", true); } }
                _cursorX = x2; _cursorY = y2; _cursorSequence++;
                return new { success = true };
            }
            if (method is "pointer_down" or "pointer_up")
            {
                object result;
                var button = Text(args, "button");
                lock (_heldInputLock) {
                    RequireAiInput();
                    RequireObservation();
                    Checked(_input.MouseMove(p.X, p.Y));
                    if (method == "pointer_down") _heldButtons.Add(button);
                    result = SendMouseButton(button, method == "pointer_up");
                    if (method == "pointer_up") _heldButtons.Remove(button);
                }
                return result;
            }
            lock (_heldInputLock) {
                RequireAiInput();
                RequireObservation();
                var delta = args.GetProperty("delta");
                if (delta.ValueKind == JsonValueKind.String) {
                    var direction = delta.GetString();
                    if (direction is not ("up" or "down" or "left" or "right")) throw new InvalidOperationException("无效滚动方向。");
                    Checked(_input.MouseMove(p.X, p.Y));
                    return direction switch {
                        "up" => Checked(_input.MouseScroll(120)), "down" => Checked(_input.MouseScroll(-120)),
                        "left" => SendWheel(-120, true), _ => SendWheel(120, true) };
                }
                var amount = delta.GetInt32();
                if (amount == 0 || Math.Abs((long)amount) > 10) throw new InvalidOperationException("滚动量必须为 -10–10 的非零整数。");
                Checked(_input.MouseMove(p.X, p.Y));
                return Checked(_input.MouseScroll(amount * 120));
            }
        }
        var foreground = GetForegroundWindow();
        GetWindowThreadProcessId(foreground, out var foregroundPid);
        if (foregroundPid == Environment.ProcessId) throw new InvalidOperationException("不能向 MoonYa 自身发送桌面输入，请先激活目标应用。");
        if (!WindowOnMonitor(foreground)) throw new InvalidOperationException("目标窗口不在实体主屏幕，请重新观察。");
        if (method == "type")
        {
            var text = Text(args, "text");
            foreach (var ch in text.Replace("\r\n", "\n")) {
                lock (_heldInputLock) {
                    RequireAiInput();
                    RequireObservation();
                    if (GetForegroundWindow() != foreground) throw new InvalidOperationException("输入期间焦点改变，请重新观察。");
                    if (ch == '\n') Checked(_input.KeyPress("enter")); else Checked(_input.KeyboardType(ch.ToString()));
                }
            }
            return new { success = true };
        }
        if (method == "hotkey")
        {
            var keys = args.GetProperty("keys").EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
            if (keys.Length == 0 || keys.Any(k => k.Length == 0 || k.Contains('+'))) throw new InvalidOperationException("每个按键必须单独传入。");
            // Keep uncertain key-down results releasable instead of blindly replaying a shortcut.
            var codes = keys.Select(KeyCode).ToArray();
            lock (_heldInputLock) {
                RequireAiInput();
                RequireObservation();
                foreach (var key in keys) _heldKeys.Add(key);
                foreach (var code in codes) SendKey(code, false);
                for (int i = keys.Length - 1; i >= 0; i--) { SendKey(codes[i], true); _heldKeys.Remove(keys[i]); }
            }
            return new { success = true };
        }
        if (method is "key_down" or "key_up")
        {
            var key = Text(args, "key"); var vk = KeyCode(key);
            lock (_heldInputLock) {
                RequireAiInput();
                RequireObservation();
                if (method == "key_down") _heldKeys.Add(key);
                var result = SendKey(vk, method == "key_up");
                if (method == "key_up") _heldKeys.Remove(key);
                return result;
            }
        }
        throw new InvalidOperationException("未知桌面方法: " + method);
    }

    public async Task<object> ControlAsync(string id, string command)
    {
        // Interrupt long typing/drag/launch before waiting for the RPC gate.
        if (_owner == id && (command is "takeover" or "stop")) {
            lock (_heldInputLock) {
                if (_owner == id) {
                    if (command == "takeover") _human = true; else _stopped = true;
                    ReleaseInputs();
                }
            }
        }
        await _gate.WaitAsync();
        try
        {
            RequireOwner(id);
            if (command == "takeover") { _human = true; ReleaseInputs(); }
            else if (command == "resume") {
                ValidateDisplay(); ReleaseInputs();
                _human = false; _observedAt = default; _resumeNeedsObservation = true;
            }
            else if (command == "stop") {
                var descriptor = new { success = true, session_id = id, state = "stopped" };
                Cleanup();
                return descriptor;
            }
            else throw new InvalidOperationException("未知控制操作。");
            _lastActivity = DateTime.UtcNow;
            return Descriptor();
        }
        finally { _gate.Release(); }
    }
    public async Task<object> ReleaseAsync(string id)
    {
        await _gate.WaitAsync(); try { if (_owner == id) ReleaseInputs(); return new { success = true }; } finally { _gate.Release(); }
    }
    public async Task<object> StopAsync(string id)
    {
        if (_owner == id) { _stopped = true; ReleaseInputs(); }
        await _gate.WaitAsync(); try { if (_owner == id) Cleanup(); return new { success = true }; } finally { _gate.Release(); }
    }
    public async Task EndSessionAsync()
    {
        await _gate.WaitAsync();
        try { if (_owner != null) Cleanup(); }
        finally { _gate.Release(); }
    }
    private void RequireOwner(string id) { if (_owner != id || _owner == null) throw new InvalidOperationException("实体桌面会话不存在或已结束。"); }
    private void ValidateDisplay()
    {
        try { ValidateDisplayCore(); }
        catch { Cleanup(); throw; }
    }
    private void ValidateDisplayCore()
    {
        var screen = Forms.Screen.AllScreens.SingleOrDefault(s => s.DeviceName == _deviceName);
        var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
        var active = EnumDisplaySettings(_deviceName, -1, ref mode);
        var currentBounds = new Rectangle(mode.dmPositionX, mode.dmPositionY, mode.dmPelsWidth, mode.dmPelsHeight);
        ReadDpi(_bounds, out var dpiX, out var dpiY);
        if (!active || currentBounds != _bounds || screen == null || screen.Bounds != _bounds || !screen.Primary || DisplayLayout() != _layout || dpiX != _dpiX || dpiY != _dpiY)
        {
            WriteDisplayDiagnostics(new { at = DateTime.UtcNow, event_name = "invalidated", provider = "physical", device = _deviceName, expected = _bounds, actual = currentBounds, dpiX, dpiY });
            Cleanup(); throw new InvalidOperationException("实体主屏幕、布局或 DPI 已改变，输入已停止，请重新建立桌面会话。");
        }
        try { RequireInputDesktop(); ExcludeMoonYaWindows(); }
        catch { Cleanup(); throw; }
    }
    private static void WriteDisplayDiagnostics(object record)
    {
        try {
            var directory = AppDataPaths.PathFor("logs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "desktop-display.jsonl"), JsonSerializer.Serialize(record) + Environment.NewLine);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Debug.WriteLine("Desktop display diagnostics: " + error.Message); }
    }
    private void RequireObservation()
    {
        var target = GetForegroundWindow();
        if (!DesktopObservationMatches(_observedAt, DateTime.UtcNow, _observedForeground, _observedWindow, target, WindowRect(target)))
            throw new InvalidOperationException("观察已过期或窗口状态改变，请先截图。");
    }
    public static bool DesktopObservationMatches(DateTime observedAt, DateTime now, IntPtr observedTarget, Rectangle observedBounds, IntPtr currentTarget, Rectangle currentBounds)
        => now - observedAt <= TimeSpan.FromSeconds(30) && observedAt != default && observedTarget == currentTarget && observedBounds == currentBounds;
    private bool WindowOnMonitor(IntPtr hwnd) => hwnd != IntPtr.Zero && _bounds.Contains(Center(WindowRect(hwnd)));
    private void RequireAiInput() {
        if (_owner == null || _human || _stopped) throw new InvalidOperationException("桌面输入已暂停或停止，请重新观察。");
    }
    private static void RequireExternalPoint(Point point) {
        GetWindowThreadProcessId(GetAncestor(WindowFromPoint(point), 2), out var pid);
        if (pid == Environment.ProcessId) throw new InvalidOperationException("不能向 MoonYa 自身发送桌面输入。");
    }
    private static Point Center(Rectangle r) => new(r.Left + r.Width / 2, r.Top + r.Height / 2);
    public static Point MapPoint(Rectangle bounds, double x, double y) => new(bounds.Left + (int)Math.Round(x / 1000 * (bounds.Width - 1)), bounds.Top + (int)Math.Round(y / 1000 * (bounds.Height - 1)));
    private static double Coordinate(JsonElement args, string name) { var value = args.GetProperty(name).GetDouble(); if (!double.IsFinite(value) || value < 0 || value > 1000) throw new InvalidOperationException("坐标必须在 0–1000。"); return value; }
    private static string Text(JsonElement root, string name) => root.TryGetProperty(name, out var value) ? value.GetString() ?? "" : "";
    private static object Checked(object result) { var value = JsonSerializer.SerializeToElement(result); if (value.TryGetProperty("success", out var ok) && !ok.GetBoolean()) throw new InvalidOperationException(value.ToString()); return result; }
    private static object Failure(string code, string error) => new { success = false, error_code = code, error };
    private static bool SecretEquals(string? a, string b) => a != null && a.Length == b.Length && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));

    private async Task<object> DiscoverAppsAsync()
    {
        var script = "$ErrorActionPreference='Stop';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress";
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8 };
        start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-EncodedCommand"); start.ArgumentList.Add(Convert.ToBase64String(Encoding.Unicode.GetBytes(script)));
        using var process = Process.Start(start) ?? throw new InvalidOperationException("无法读取应用目录。");
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15)); } catch { process.Kill(true); throw; }
        if (process.ExitCode != 0) throw new InvalidOperationException(await stderr);
        using var doc = JsonDocument.Parse(await stdout);
        var rows = doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.EnumerateArray().ToArray() : new[] { doc.RootElement };
        var entries = rows.Select(e => new AppEntry(Text(e, "Name"), Text(e, "AppID"), "", "", "", "")).Where(e => e.Name.Length > 0 && e.Id.Contains('!')).Distinct().ToList();
        await Application.Current.Dispatcher.InvokeAsync(() => {
            var type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows 快捷方式服务不可用。");
            dynamic shell = Activator.CreateInstance(type)!;
            try {
                foreach (var menu in new[] { Environment.GetFolderPath(Environment.SpecialFolder.Programs), Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms) }.Distinct()) {
                    foreach (var file in Directory.EnumerateFiles(menu, "*.lnk", SearchOption.AllDirectories)) {
                        try {
                            dynamic link = shell.CreateShortcut(file);
                            string target = link.TargetPath, arguments = link.Arguments, directory = link.WorkingDirectory;
                            if (File.Exists(target) && Path.GetExtension(target).Equals(".exe", StringComparison.OrdinalIgnoreCase))
                                entries.Add(new AppEntry(Path.GetFileNameWithoutExtension(file), file, target, arguments, directory, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)))));
                            Marshal.FinalReleaseComObject(link);
                        } catch (Exception) { /* Invalid links are not runnable catalog entries. */ }
                    }
                }
            } finally { Marshal.FinalReleaseComObject(shell); }
        });
        _apps.Clear();
        foreach (var group in entries.Distinct().GroupBy(e => e.Name, StringComparer.OrdinalIgnoreCase))
        {
            var ordered = group.OrderBy(e => e.Id, StringComparer.Ordinal).ToArray();
            for (int i = 0; i < ordered.Length; i++)
            {
                var name = ordered.Length == 1 ? ordered[i].Name : $"{ordered[i].Name} ({i + 1})";
                while (_apps.Keys.Any(k => k.Equals(name, StringComparison.OrdinalIgnoreCase))) name += " (App)";
                _apps.Add(name, ordered[i]);
            }
        }
        return new { success = true, apps = _apps.Keys.Select(name => new { name }).ToArray() };
    }
    private async Task<object> LaunchAsync(string name)
    {
        if (!_apps.TryGetValue(name, out var app)) throw new InvalidOperationException("应用名称未绑定到当前目录，请重新列出应用并精确匹配。");
        if (_unverifiedLaunches.Contains(app.Id)) throw new InvalidOperationException("此前启动已接受但未确认；请观察并等待，不能重复启动。");
        var before = TopWindows();
        if (app.Target.Length > 0) {
            if (!File.Exists(app.Id) || Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(app.Id))) != app.Fingerprint)
                throw new InvalidOperationException("应用描述已变化，请重新列出应用。");
            Process.Start(new ProcessStartInfo(app.Target, app.Arguments) { UseShellExecute = true, WorkingDirectory = app.Directory });
        } else await Application.Current.Dispatcher.InvokeAsync(() => {
            var type = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("Windows Shell 不可用。");
            dynamic shell = Activator.CreateInstance(type)!;
            try
            {
                dynamic folder = shell.NameSpace("shell:AppsFolder"); dynamic item = folder.ParseName(app.Id);
                if (item is null) throw new InvalidOperationException("应用描述已变化，请重新列出应用。");
                if (!string.Equals((string)item.Name, app.Name, StringComparison.Ordinal)) throw new InvalidOperationException("应用描述已变化，请重新列出应用。");
                item.InvokeVerb();
            }
            finally { Marshal.FinalReleaseComObject(shell); }
        });
        _unverifiedLaunches.Add(app.Id);
        _observedAt = default;
        IntPtr previousCandidate = IntPtr.Zero;
        var stableSamples = 0;
        for (int i = 0; i < 50; i++)
        {
            RequireAiInput();
            var windows = TopWindows();
            var matches = windows.Where(h => MatchesApp(h, app) && (app.Target.Length > 0 || WindowClass(h) != "Windows.UI.Core.CoreWindow")).ToArray();
            var newMatches = matches.Where(h => !before.Contains(h)).ToArray();
            var hwnd = newMatches.Length == 1 ? newMatches[0] : matches.Length == 1 ? matches[0] : IntPtr.Zero;
            stableSamples = hwnd != IntPtr.Zero && hwnd == previousCandidate ? stableSamples + 1 : 0;
            previousCandidate = hwnd;
            if (hwnd != IntPtr.Zero && stableSamples >= 3)
            {
                GetWindowThreadProcessId(hwnd, out var pid);
                if (pid != Environment.ProcessId)
                {
                    if (!WindowOnMonitor(hwnd)) throw new InvalidOperationException("应用已启动，但窗口不在主屏幕；请用户将其移到主屏幕，不要重复启动。");
                    ValidateDisplay();
                    if (_human || _stopped) throw new InvalidOperationException("控制权已改变，请重新观察。");
                    Checked(await Application.Current.Dispatcher.InvokeAsync(() => _input.FocusWindow(hwnd.ToInt64())));
                    _unverifiedLaunches.Remove(app.Id);
                    return new { success = true, status = "ready", window = hwnd.ToInt64(), name };
                }
            }
            await Task.Delay(100);
        }
        return new { success = true, status = "accepted_unverified", name };
    }
    private record AppEntry(string Name, string Id, string Target, string Arguments, string Directory, string Fingerprint);
    private static bool MatchesApp(IntPtr hwnd, AppEntry app)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == Environment.ProcessId) return false;
        try {
            if (app.Target.Length > 0) {
                using var process = Process.GetProcessById((int)pid);
                return string.Equals(process.MainModule?.FileName, app.Target, StringComparison.OrdinalIgnoreCase);
            }
            if (ProcessHasAppId(pid, app.Id)) return true;
            // UWP apps render inside an ApplicationFrameHost top-level window.
            // Resolve its app child; never focus the transient CoreWindow splash.
            var matched = false;
            EnumChildWindows(hwnd, (child, _) => { GetWindowThreadProcessId(child, out var childPid); if (childPid != Environment.ProcessId && ProcessHasAppId(childPid, app.Id)) matched = true; return !matched; }, IntPtr.Zero);
            return matched;
        } catch { return false; }
    }
    private static bool ProcessHasAppId(uint pid, string appId)
    {
        var handle = OpenProcess(0x1000, false, pid);
        if (handle == IntPtr.Zero) return false;
        try { uint length = 0; GetApplicationUserModelId(handle, ref length, null); var name = new StringBuilder((int)length); return length > 0 && GetApplicationUserModelId(handle, ref length, name) == 0 && name.ToString() == appId; }
        finally { CloseHandle(handle); }
    }
    private static string WindowClass(IntPtr hwnd) { var name = new StringBuilder(256); GetClassName(hwnd, name, name.Capacity); return name.ToString(); }
    private static HashSet<IntPtr> TopWindows() { var windows = new HashSet<IntPtr>(); EnumWindows((h, _) => { if (IsWindowVisible(h) && DwmGetWindowAttribute(h, 14, out var cloaked, sizeof(int)) == 0 && cloaked == 0 && WindowRect(h).Width > 0) windows.Add(h); return true; }, IntPtr.Zero); return windows; }
    private static Rectangle WindowRect(IntPtr hwnd) { GetWindowRect(hwnd, out var r); return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom); }
    private static string DisplayLayout()
    {
        return string.Join(";", Forms.Screen.AllScreens.OrderBy(s => s.DeviceName).Select(s => {
            var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
            if (!EnumDisplaySettings(s.DeviceName, -1, ref mode)) throw new InvalidOperationException("无法读取实体屏幕布局。");
            return $"{s.DeviceName}:{s.Primary}:{mode.dmPositionX}:{mode.dmPositionY}:{mode.dmPelsWidth}:{mode.dmPelsHeight}:{mode.dmDisplayOrientation}";
        }));
    }
    private static void ReadDpi(Rectangle bounds, out uint x, out uint y)
    {
        var monitor = MonitorFromPoint(Center(bounds), 0);
        if (monitor == IntPtr.Zero || GetDpiForMonitor(monitor, 0, out x, out y) != 0)
            throw new InvalidOperationException("无法读取实体主屏幕 DPI，请重新建立会话。");
    }
    private void ExcludeMoonYaWindows()
    {
        Application.Current.Dispatcher.Invoke(() => {
            foreach (Window window in Application.Current.Windows) {
                var handle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
                if (handle == IntPtr.Zero || _captureAffinities.ContainsKey(handle)) continue;
                if (!GetWindowDisplayAffinity(handle, out var original) || !SetWindowDisplayAffinity(handle, 0x11))
                    throw new InvalidOperationException("无法将 MoonYa 窗口排除在桌面捕获之外。");
                _captureAffinities.Add(handle, original);
            }
        });
    }
    private byte[] CaptureFrame(bool png, out int width, out int height)
    {
        try {
            var image = _capture!.Capture(png, out width, out height);
            if (width != _bounds.Width || height != _bounds.Height)
                throw new InvalidOperationException("实体屏幕捕获尺寸已改变。");
            return image;
        } catch { Cleanup(); throw; }
    }

    private async Task StreamAsync(HttpListenerContext context)
    {
        var id = context.Request.QueryString["session_id"] ?? "";
        var token = context.Request.QueryString["token"] ?? "";
        if (!context.Request.IsWebSocketRequest || _owner != id || !SecretEquals(context.Request.QueryString["token"], _viewToken))
        { await Reply(context, 403, Failure("invalid_preview_token", "预览令牌已失效。")); return; }
        var upgrade = await context.AcceptWebSocketAsync(null);
        using var socket = upgrade.WebSocket;
        using var lifetime = new CancellationTokenSource();
        var receive = ReceivePreviewControlsAsync(socket, id, token, lifetime);
        try
        {
            while (socket.State == WebSocketState.Open && _owner == id && SecretEquals(token, _viewToken) && !lifetime.IsCancellationRequested)
            {
                byte[] image; object state;
                await _gate.WaitAsync(lifetime.Token);
                try { RequireOwner(id); if (!SecretEquals(token, _viewToken)) break; ValidateDisplay(); image = CaptureFrame(false, out _, out _); _lastFrame = DateTime.UtcNow;
                    state = new { kind = "state", state = _stopped ? "stopped" : _human ? "human" : "ai", x = _cursorX, y = _cursorY, action = _cursorAction, sequence = _cursorSequence, timestamp = _cursorTimestamp, frame_timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }; }
                finally { _gate.Release(); }
                using var sendTimeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); sendTimeout.CancelAfter(2000);
                await socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(state)), WebSocketMessageType.Text, true, sendTimeout.Token);
                await socket.SendAsync(image, WebSocketMessageType.Binary, true, sendTimeout.Token);
                await Task.Delay(67, lifetime.Token);
            }
        }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }
        catch (Exception) { if (_owner == id && SecretEquals(token, _viewToken)) await ControlAsync(id, "stop").ConfigureAwait(false); }
        finally { lifetime.Cancel(); socket.Abort(); try { await receive; } catch { } }
    }
    private async Task ReceivePreviewControlsAsync(WebSocket socket, string id, string token, CancellationTokenSource lifetime)
    {
        try { await ReceiveControlsAsync(socket, id, token, lifetime.Token); }
        finally {
            // A disconnected viewer never resumes AI. Release held human input while retaining takeover.
            lifetime.Cancel();
            await _gate.WaitAsync();
            try { if (_owner == id && SecretEquals(token, _viewToken) && _human) ReleaseInputs(); }
            finally { _gate.Release(); }
        }
    }
    private async Task ReceiveControlsAsync(WebSocket socket, string id, string token, CancellationToken ct)
    {
        var buffer = new byte[65536];
        while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var message = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
            if (message.MessageType == WebSocketMessageType.Close) return;
            if (_owner != id || !SecretEquals(token, _viewToken)) return;
            if (!message.EndOfMessage || message.MessageType != WebSocketMessageType.Text) throw new InvalidOperationException("无效预览控制消息。");
            using var doc = JsonDocument.Parse(buffer.AsMemory(0, message.Count)); var root = doc.RootElement;
            if (Text(root, "kind") == "control") await ControlAsync(id, Text(root, "command"));
            else if (Text(root, "kind") == "release") await ReleaseAsync(id);
            else if (Text(root, "kind") == "input") throw new InvalidOperationException("请直接操作实体桌面，预览仅用于观察与控制会话。");
        }
    }
    private void Cleanup()
    {
        ReleaseInputs();
        foreach (var pair in _captureAffinities)
            if (IsWindow(pair.Key) && !SetWindowDisplayAffinity(pair.Key, pair.Value))
                Debug.WriteLine("Unable to restore MoonYa capture affinity: " + pair.Key);
        _captureAffinities.Clear(); _apps.Clear(); _operations.Clear(); _unverifiedLaunches.Clear(); _capture?.Dispose(); _capture = null;
        _owner = null; _viewToken = ""; _deviceName = ""; _human = false; _stopped = false; _resumeNeedsObservation = false;
    }
    private void ReleaseInputs()
    {
        lock (_heldInputLock) {
            foreach (var key in _heldKeys.ToArray()) { try { SendKey(KeyCode(key), true); } catch { } }
            _heldKeys.Clear();
            foreach (var button in _heldButtons.ToArray()) { try { SendMouseButton(button, true); } catch { } }
            _heldButtons.Clear();
        }
    }
    private static ushort KeyCode(string name)
    {
        var aliases = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { ["ctrl"] = 17, ["control"] = 17, ["shift"] = 16, ["alt"] = 18, ["win"] = 91, ["enter"] = 13, ["tab"] = 9, ["escape"] = 27, ["esc"] = 27, ["backspace"] = 8, ["space"] = 32, ["delete"] = 46, ["left"] = 37, ["up"] = 38, ["right"] = 39, ["down"] = 40, ["home"] = 36, ["end"] = 35, ["pageup"] = 33, ["pagedown"] = 34 };
        if (aliases.TryGetValue(name, out var vk)) return (ushort)vk;
        if (name.Length == 1 && char.IsAsciiLetterOrDigit(name[0])) return char.ToUpperInvariant(name[0]);
        if (name.StartsWith("f", StringComparison.OrdinalIgnoreCase) && int.TryParse(name[1..], out var f) && f is >= 1 and <= 24) return (ushort)(111 + f);
        throw new InvalidOperationException("不支持的按键: " + name);
    }
    private static object SendKey(ushort key, bool up) => Send(new INPUT { type = 1, data = new INPUT_UNION { keyboard = new KEYBDINPUT { vk = key, flags = up ? 2u : 0 } } });
    private static object SendMouseButton(string button, bool up) => Send(new INPUT { type = 0, data = new INPUT_UNION { mouse = new MOUSEINPUT { flags = button switch { "left" => up ? 4u : 2u, "right" => up ? 16u : 8u, "middle" => up ? 64u : 32u, _ => throw new InvalidOperationException("无效鼠标按钮。") } } } });
    private static object SendWheel(int amount, bool horizontal) => Send(new INPUT { data = new INPUT_UNION { mouse = new MOUSEINPUT { data = unchecked((uint)amount), flags = horizontal ? 0x1000u : 0x800u } } });
    private static object Send(INPUT input) { if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) != 1) throw new InvalidOperationException("Windows 拒绝输入，执行状态可能未知。"); return new { success = true }; }
    private static void RequireInputDesktop()
    {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) throw new InvalidOperationException("当前界面需要用户接管。");
        try {
            var name = new StringBuilder(256);
            if (!GetUserObjectInformation(desktop, 2, name, 512, out _) || !name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("当前安全桌面需要用户接管。");
        } finally { CloseDesktop(desktop); }
    }
    private static async Task Reply(HttpListenerContext c, int status, object result) { var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(result)); c.Response.StatusCode = status; c.Response.ContentType = "application/json; charset=utf-8"; c.Response.ContentLength64 = bytes.Length; await c.Response.OutputStream.WriteAsync(bytes); c.Response.Close(); }
    public void Dispose()
    {
        _watchdog.Dispose();
        // Never block the WPF dispatcher while an in-flight clipboard/app discovery awaits it.
        if (Application.Current?.Dispatcher.CheckAccess() == true) {
            ReleaseInputs();
            _ = Task.Run(async () => { await _gate.WaitAsync(); try { Cleanup(); } finally { _gate.Release(); } });
        } else { _gate.Wait(); try { Cleanup(); } finally { _gate.Release(); } }
    }

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName; public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput; public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUT_UNION data; }
    [StructLayout(LayoutKind.Explicit)] private struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int x, y; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
    private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(Point point, uint flags);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc proc, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc proc, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE settings);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder? name);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int length, out int needed);
}
