using System;
using System.Threading.Tasks;
using System.Text.Json;
using System.Net.Http;
using System.Diagnostics;
using CefSharp;
using MoonYa.Services;

namespace MoonYa;

public partial class MainWindow
{
    private bool _desktopBridgeRegistered;
    private VirtualScreenWindow? _virtualScreenWindow;
    private void RegisterDesktopBridgeOnce()
    {
        if (_desktopBridgeRegistered) return;
        WebView.JavascriptObjectRepository.Register("moonYaDesktop", new DesktopPreviewBridge(this), BindingOptions.DefaultBinder);
        _desktopBridgeRegistered = true;
        Closing += (_, _) => _virtualScreenWindow?.Close();
    }
    internal async Task OpenVirtualScreenAsync(string sessionId)
    {
        var info = await DesktopAutomationService.Current.PreviewAsync(sessionId, App.FileServiceBaseAddress?.Port ?? 58900);
        using (var descriptor = JsonDocument.Parse(info)) {
            if (!descriptor.RootElement.GetProperty("success").GetBoolean())
                throw new InvalidOperationException(descriptor.RootElement.TryGetProperty("error", out var error) ? error.GetString() : "实体桌面会话不可用。");
        }
        await RunOnUiAsync(() => {
            if (_virtualScreenWindow?.SessionId == sessionId && _virtualScreenWindow.IsConnected) { _virtualScreenWindow.Show(); _virtualScreenWindow.Activate(); return; }
            _virtualScreenWindow?.Close();
            _virtualScreenWindow = new VirtualScreenWindow(sessionId, info) { Owner = this, WindowState = System.Windows.WindowState.Normal, Topmost = false };
            var openedWindow = _virtualScreenWindow;
            openedWindow.Closed += (_, _) => { if (ReferenceEquals(_virtualScreenWindow, openedWindow)) _virtualScreenWindow = null; };
            _virtualScreenWindow.Resumed += () => {
                if (IsBuiltinBrowserBridgeTrusted()) _ = WebView.EvaluateScriptAsync($"window.moonyaCompleteDesktopAction?.({JsonSerializer.Serialize(sessionId)})");
            };
            _virtualScreenWindow.Stopped += async () => {
                if (IsBuiltinBrowserBridgeTrusted()) _ = WebView.EvaluateScriptAsync($"window.moonyaSkipDesktopAction?.({JsonSerializer.Serialize(sessionId)})");
                try {
                    if (App.AgentRuntimeBaseAddress == null) return;
                    using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                    using var response = await client.PostAsync(new Uri(App.AgentRuntimeBaseAddress, $"v1/sessions/{Uri.EscapeDataString(sessionId)}/cancel"), new StringContent("{}"));
                    response.EnsureSuccessStatusCode();
                } catch (Exception error) { Debug.WriteLine("Physical-desktop task cancellation: " + error.Message); }
            };
            _virtualScreenWindow.Show();
        });
    }
}
public sealed class DesktopPreviewBridge
{
    private readonly MainWindow _window;
    public DesktopPreviewBridge(MainWindow window) { _window = window; }
    public async Task<string> Preview(string sessionId)
    {
        if (!await _window.RunOnUiAsync(_window.IsBuiltinBrowserBridgeTrusted)) throw new UnauthorizedAccessException();
        return await DesktopAutomationService.Current.PreviewAsync(sessionId, App.FileServiceBaseAddress?.Port ?? 58900);
    }
    public async Task Open(string sessionId)
    {
        if (!await _window.RunOnUiAsync(_window.IsBuiltinBrowserBridgeTrusted)) throw new UnauthorizedAccessException();
        await _window.OpenVirtualScreenAsync(sessionId);
    }
}
