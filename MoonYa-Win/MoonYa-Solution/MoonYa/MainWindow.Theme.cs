using System;
using System.Threading.Tasks;
using System.IO;
using System.Text.Json;
using CefSharp;
using Microsoft.Win32;
using MoonYa.Services;

namespace MoonYa;

public partial class MainWindow
{
    private readonly ThemePreferences _themePreferences = new(AppDataPaths.PathFor("frontend", "theme.json"));
    private bool _themeClosed;
    private void InitializeTheme()
    {
        _themePreferences.ApplyResources(System.Windows.Application.Current.Resources);
        WebView.JavascriptObjectRepository.Register("moonYaTheme", new ThemeBridge(this), BindingOptions.DefaultBinder);
        SystemEvents.UserPreferenceChanged += OnThemeSystemChanged;
    }
    private void OnThemeSystemChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        if (_themeClosed || Dispatcher.HasShutdownStarted) return;
        Dispatcher.BeginInvoke(new Action(() =>
        {
            if (_themeClosed) return;
            ApplyThemeTitleBar();
            if (_themePreferences.Preference == "system")
                _themePreferences.ApplyResources(System.Windows.Application.Current.Resources);
            SyncBuiltinStartPageTheme();
            if (WebView.IsBrowserInitialized && WebView.CanExecuteJavascriptInMainFrame)
                WebView.ExecuteScriptAsync($"window.MoonYaTheme?.acceptNativeSystemTheme('{ThemePreferences.SystemTheme()}');");
        }));
    }
    private void DisposeTheme()
    {
        _themeClosed = true;
        SystemEvents.UserPreferenceChanged -= OnThemeSystemChanged;
    }
    private static bool IsOwnedBuiltinStartPage(string? address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || !uri.IsFile) return false;
        return string.Equals(Path.GetFullPath(uri.LocalPath),
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "browser_start.html"), StringComparison.OrdinalIgnoreCase);
    }
    private string WithBuiltinStartPageTheme(string address)
    {
        return IsOwnedBuiltinStartPage(address)
            ? new UriBuilder(address) { Fragment = "moonya-theme=" + _themePreferences.Resolved }.Uri.AbsoluteUri
            : address;
    }
    private void SyncBuiltinStartPageTheme()
    {
        var browser = _builtinBrowser;
        if (browser == null || !browser.IsBrowserInitialized || !browser.CanExecuteJavascriptInMainFrame || !IsOwnedBuiltinStartPage(browser.Address)) return;
        // Check the URL again in the renderer: navigation may occur after the dispatcher check.
        var expected = JsonSerializer.Serialize(new Uri(browser.Address).AbsoluteUri.Split('#')[0]);
        browser.ExecuteScriptAsync($"if(location.href.split('#')[0]==={expected}) document.documentElement.dataset.theme='{_themePreferences.Resolved}';");
    }
    private sealed class ThemeBridge(MainWindow window)
    {
        public async Task<string> GetState() => await window.RunOnUiAsync(() =>
        {
            if (!window.IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
            return window._themePreferences.Snapshot();
        });
        public async Task SetPreference(string preference) => await window.RunOnUiAsync(() =>
        {
            if (!window.IsBuiltinBrowserBridgeTrusted()) throw new UnauthorizedAccessException();
            if (!ThemePreferences.IsValid(preference)) throw new ArgumentException("Invalid theme preference.");
            try { window._themePreferences.Save(preference); }
            finally
            {
                // An unwritable preference file must not prevent a session-local switch.
                window._themePreferences.ApplyResources(System.Windows.Application.Current.Resources);
                window.ApplyThemeTitleBar();
                window.SyncBuiltinStartPageTheme();
                window.WebView.ExecuteScriptAsync($"window.MoonYaTheme?.acceptNativeSystemTheme('{ThemePreferences.SystemTheme()}');");
            }
        });
    }
}
