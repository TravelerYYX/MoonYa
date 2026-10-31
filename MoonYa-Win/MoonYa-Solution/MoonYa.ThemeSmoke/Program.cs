using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using CefSharp;
using CefSharp.Wpf;
using MoonYa;
using MoonYa.Services;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var root = Path.GetFullPath(args[0]);
        var data = Path.Combine(Path.GetTempPath(), "moonya-theme-native-" + Guid.NewGuid());
        Directory.CreateDirectory(data);
        var savedPath = Path.Combine(data, "theme.json");
        var preferences = new ThemePreferences(savedPath);
        Require(preferences.Preference == "system", "fresh native preference follows system");
        preferences.Save("dark");
        Require(new ThemePreferences(savedPath).Preference == "dark", "native preference survives restart");
        try { preferences.Save("invalid"); throw new Exception("invalid preference accepted"); }
        catch (ArgumentException) { }
        File.WriteAllText(savedPath, "{broken");
        Require(new ThemePreferences(savedPath).Preference == "system", "corrupt native preference falls back to system");
        preferences.Save("system");
        var unwritable = new ThemePreferences(data); // Existing directory cannot be replaced by a preference file.
        try { unwritable.Save("dark"); throw new Exception("unwritable preference file accepted"); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        Require(unwritable.Preference == "dark", "unwritable storage retains the session preference");
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext());
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var xaml = System.Xml.Linq.XDocument.Load(Path.Combine(root, "MoonYa-Win/MoonYa-Solution/MoonYa/App.xaml"));
        var resources = xaml.Descendants().First(element => element.Name.LocalName == "ResourceDictionary");
        resources.SetAttributeValue(System.Xml.Linq.XNamespace.Xmlns + "x", "http://schemas.microsoft.com/winfx/2006/xaml");
        resources.SetAttributeValue(System.Xml.Linq.XNamespace.Xmlns + "sys", "clr-namespace:System;assembly=System.Runtime");
        app.Resources = (ResourceDictionary)System.Windows.Markup.XamlReader.Parse(resources.ToString());
        bool cef = false;
        MainWindow? window = null;
        IDisposable? frontend = null;
        try
        {
            var serviceType = typeof(MainWindow).Assembly.GetType("MoonYa.Services.DesktopFrontendService")!;
            using var portProbe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            portProbe.Start(); var port = ((System.Net.IPEndPoint)portProbe.LocalEndpoint).Port; portProbe.Stop();
            frontend = (IDisposable)Activator.CreateInstance(serviceType, BindingFlags.Instance | BindingFlags.NonPublic, null,
                [port, new Uri("http://127.0.0.1:1/"), new Uri("http://127.0.0.1:2/"), Path.Combine(root, "MoonYa-Frontend/dist")], null)!;
            typeof(MoonYa.App).GetProperty("FrontendService", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null, frontend);
            Require((bool)serviceType.GetMethod("Start", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(frontend, null)!, "isolated frontend starts");
            CefSharpSettings.ConcurrentTaskExecution = true;
            cef = Cef.Initialize(new CefSettings { LogSeverity = LogSeverity.Disable, CachePath = Path.Combine(data, "cef"),
                LocalesDirPath = Path.Combine(AppContext.BaseDirectory, "runtimes", "win-x64", "native", "locales") }, performDependencyCheck: true, browserProcessHandler: null);
            Require(cef, "CEF initializes");
            typeof(MoonYa.App).GetField("_fileService", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null,
                new FileOperationService(Path.Combine(root, "MoonYa-Win/MoonYa-Solution/MoonYa/launcher_config.json")));
            typeof(MoonYa.App).GetProperty("BuiltinBrowser", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null,
                new BuiltinBrowserHost(new BuiltinBrowserOptions { Enabled = true }));
            window = new MainWindow { Left = -30000, Top = -30000, Width = 1100, Height = 800, ShowActivated = false, ShowInTaskbar = false };
            typeof(MainWindow).GetField("_themePreferences", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, preferences);
            typeof(MainWindow).GetField("_initialized", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, true);
            preferences.ApplyResources(app.Resources);
            window.Show();
            var browser = (CustomChromiumWebBrowser)window.FindName("WebView");
            browser.Address = $"http://127.0.0.1:{port}/";
            Until(() => browser.IsBrowserInitialized && browser.CanExecuteJavascriptInMainFrame, "CEF browser ready");
            Until(() => Eval(browser, "!!window.MoonYaTheme && !!window.openSettingsModal") == "True", "application frontend ready");
            // Exercise the real CEF binding, including authority checks and dispatcher calls.
            Eval(browser, "(async()=>{try { await CefSharp.BindObjectAsync('moonYaTheme'); window.themeSmokeState=await moonYaTheme.getState(); }catch(e){window.themeSmokeState='ERROR:'+e;}})(); true");
            Until(() => Eval(browser, "window.themeSmokeState || ''").Length > 0, "native bridge bound");
            var nativeState = Eval(browser, "window.themeSmokeState");
            Require(!nativeState.StartsWith("ERROR:"), nativeState);
            using (var state = JsonDocument.Parse(nativeState))
                Require(state.RootElement.GetProperty("preference").GetString() == "system", "bridge reads native authority");
            foreach (var theme in new[] { "dark", "light", "system" })
            {
                Eval(browser, $"MoonYaTheme.setPreference('{theme}'); openSettingsModal('appearance'); true");
                Until(() => preferences.Preference == theme, "native bridge saves " + theme);
                Require(new ThemePreferences(savedPath).Preference == theme, "saved " + theme);
                var resolved = theme == "system" ? ThemePreferences.SystemTheme() : theme;
                Until(() => Eval(browser, "MoonYaTheme.getResolvedTheme()") == resolved, "frontend resolves " + theme);
                var brush = (SolidColorBrush)app.Resources["BrushTitleBarBg"];
                Require(brush.Color.ToString() == (resolved == "dark" ? "#FF18191D" : "#FFF4F3F5"), "title bar matches " + theme);
                var closeLine = (System.Windows.Shapes.Line)window.FindName("CloseLine1");
                typeof(MainWindow).GetMethod("CloseBtn_MouseLeave", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(window, [window, null]);
                Require(((SolidColorBrush)closeLine.Stroke).Color == ((SolidColorBrush)app.Resources["BrushTitleBarText"]).Color, "close icon follows " + theme);
                ((Grid)window.FindName("LoadingOverlay")).Visibility = Visibility.Visible;
                Capture(window, Path.Combine(root, "MoonYa-Frontend/artifacts/theme/native-loading-" + theme + ".png"));
                ((Grid)window.FindName("LoadingOverlay")).Visibility = Visibility.Collapsed;
                ((Grid)window.FindName("TitleBarGrid")).Visibility = Visibility.Visible;
                Until(() => Eval(browser, "document.getAnimations().every(a=>!(a instanceof CSSTransition))") == "True", "theme transition settles");
                Capture(window, Path.Combine(root, "MoonYa-Frontend/artifacts/theme/native-" + theme + ".png"));
            }
            Eval(browser, "closeSettingsModal(); MoonYaTheme.setPreference('dark'); true");
            Until(() => preferences.Preference == "dark", "dark theme saved before opening the browser");
            window.ApplyBuiltinBrowserBounds("{\"left\":0.42,\"top\":0.08,\"width\":0.56,\"height\":0.88,\"visible\":true}");
            var panel = (PanelChromiumWebBrowser)typeof(MainWindow).GetField("_builtinBrowser", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(window)!;
            Until(() => panel.IsBrowserInitialized && Eval(panel, "document.documentElement.dataset.theme || ''") == "dark", "start page is dark at initial load");
            Require(panel.Address.EndsWith("#moonya-theme=dark"), "start URL supplies explicit theme before rendering");
            var originalStartAddress = panel.Address;
            foreach (var theme in new[] { "light", "dark", "system" })
            {
                Eval(browser, $"MoonYaTheme.setPreference('{theme}'); true");
                Until(() => preferences.Preference == theme && Eval(panel, "document.documentElement.dataset.theme") == preferences.Resolved, "open start page follows " + theme);
                Require(panel.Address == originalStartAddress, "theme changes do not reload the browser");
                using var panelState = JsonDocument.Parse(window.GetBuiltinPanelStateJson());
                Require(panelState.RootElement.GetProperty("is_start_page").GetBoolean(), "start page stays recognized across theme changes");
                Capture(window, Path.Combine(root, "MoonYa-Frontend/artifacts/theme/native-browser-start-" + theme + ".png"));
            }
            var foreignPath = Path.Combine(data, "foreign.html");
            File.WriteAllText(foreignPath, "<!doctype html><html data-theme='original'><body style='background:white'>External content</body></html>");
            panel.Address = new Uri(foreignPath).AbsoluteUri;
            Until(() => Eval(panel, "document.documentElement.dataset.theme || ''") == "original", "foreign page loaded");
            Eval(browser, "MoonYaTheme.setPreference('dark'); true");
            Until(() => preferences.Preference == "dark", "theme switch with foreign page open");
            Require(Eval(panel, "document.documentElement.dataset.theme") == "original", "foreign pages retain their own appearance");
            window.SetBuiltinBrowserVisible(false);
            preferences.Save("light"); preferences.ApplyResources(app.Resources);
            Eval(browser, "localStorage.setItem('moonya.theme.v1','dark'); true");
            browser.Reload();
            Until(() => Eval(browser, "window.MoonYaTheme?.getPreference() || ''") == "light", "automatic binding overrides stale frontend cache");
            Require(Eval(browser, "MoonYaTheme.getResolvedTheme()") == "light", "automatic native resolution wins on reload");
            Eval(browser, "MoonYaTheme.setPreference('system'); true");
            Until(() => preferences.Preference == "system", "system preference is saved again");
            browser.Reload();
            Until(() => Eval(browser, "window.MoonYaTheme?.getPreference() || ''") == "system", "reload restores native system preference");
            typeof(MainWindow).GetMethod("OnThemeSystemChanged", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(window,
                [window, new Microsoft.Win32.UserPreferenceChangedEventArgs(Microsoft.Win32.UserPreferenceCategory.General)]);
            Until(() => Eval(browser, "MoonYaTheme.getResolvedTheme()") == ThemePreferences.SystemTheme(), "system notification synchronizes frontend");
            Console.WriteLine("PASS: native persistence, real CEF bridge, title bar, live browser start-page themes without reload, foreign-page isolation, reload and system notification");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { window?.Close(); frontend?.Dispose(); if (cef) Cef.Shutdown(); }
    }
    private static string Eval(CustomChromiumWebBrowser browser, string script)
    {
        if (!browser.CanExecuteJavascriptInMainFrame) return "";
        var task = browser.EvaluateScriptAsync(script);
        Until(() => task.IsCompleted, "JavaScript result");
        JavascriptResponse result;
        try { result = task.GetAwaiter().GetResult(); }
        catch (TaskCanceledException) { return ""; } // Reload can invalidate a pending old-frame evaluation.
        if (!result.Success) { if (browser.IsLoading) return ""; throw new Exception(result.Message); }
        return result.Result?.ToString() ?? "";
    }
    private static void Until(Func<bool> condition, string label)
    {
        var deadline = Stopwatch.StartNew();
        while (!condition())
        {
            if (deadline.Elapsed.TotalSeconds > 15) throw new TimeoutException(label);
            var frame = new DispatcherFrame();
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => frame.Continue = false));
            Dispatcher.PushFrame(frame); Thread.Sleep(10);
        }
    }
    private static void Capture(MainWindow window, string path)
    {
        window.UpdateLayout();
        var bitmap = new RenderTargetBitmap((int)window.ActualWidth, (int)window.ActualHeight, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(window);
        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = File.Create(path); encoder.Save(stream);
    }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
}
