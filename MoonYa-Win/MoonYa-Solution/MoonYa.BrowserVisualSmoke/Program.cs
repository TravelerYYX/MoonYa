using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;
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
    private static void Main(string[] args)
    {
        SetDllDirectory(Path.GetFullPath(args[1]));
        Console.WriteLine("Initializing isolated CEF visual smoke");
        Run(args);
    }

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectory(string directory);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run(string[] args)
    {
        var root = Path.GetFullPath(args[0]);
        var native = Path.GetFullPath(args[1]);
        var output = Path.Combine(root, "artifacts", "browser-visuals", "verification");
        Directory.CreateDirectory(output);
        var port = FreePort();
        // 重现配置端口被占用；生产选择器必须避开它，并共享实际端口。
        var occupiedDebuggingPort = new TcpListener(IPAddress.Loopback, 0);
        occupiedDebuggingPort.Server.ExclusiveAddressUse = true;
        occupiedDebuggingPort.Start();
        var configuredDebuggingPort = ((IPEndPoint)occupiedDebuggingPort.LocalEndpoint).Port;
        var debugPort = BuiltinBrowserConnection.SelectDebuggingPort(configuredDebuggingPort);
        Check(debugPort != configuredDebuggingPort, "native startup reused occupied debugging port");
        var origin = new Uri("http://127.0.0.1:" + port + "/");
        using var server = new HttpListener(); server.Prefixes.Add(origin.AbsoluteUri); server.Start();
        _ = ServeAsync(server, origin);
        using var configuration = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "MoonYa-Win/MoonYa-Solution/MoonYa/launcher_config.json")));
        App.BrowserAutomation = JsonSerializer.Deserialize<BrowserAutomationConfig>(configuration.RootElement.GetProperty("browser_automation").GetRawText(),
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower })!;
        App.BrowserAutomation.Builtin.Enabled = true;
        App.BrowserAutomation.Builtin.Prefer = true;
        App.BrowserAutomation.Builtin.IsolateProfile = true;
        App.BrowserAutomation.Builtin.CachePath = Path.Combine(output, "cef-profile", "BrowserPanel");
        App.BrowserAutomation.Builtin.RemoteDebuggingPort = debugPort;
        App.BuiltinBrowser = new BuiltinBrowserHost(App.BrowserAutomation.Builtin);
        App.FrontendBaseAddress = origin;
        CefSharpSettings.ConcurrentTaskExecution = true;
        Console.WriteLine("Initializing CEF runtime");
        var initialized = Cef.Initialize(new CefSettings {
            RemoteDebuggingPort = debugPort,
            CachePath = Path.Combine(output, "cef-profile"),
            RootCachePath = Path.Combine(output, "cef-profile"),
            BrowserSubprocessPath = Path.Combine(native, "CefSharp.BrowserSubprocess.exe"),
            ResourcesDirPath = native, LocalesDirPath = Path.Combine(native, "locales"),
            LogFile = Path.Combine(output, "cef.log"), LogSeverity = LogSeverity.Error,
        }, performDependencyCheck: false, browserProcessHandler: null);
        if (!initialized) throw new InvalidOperationException("CEF initialization failed");
        Console.WriteLine("Creating native test window");
        var application = new System.Windows.Application();
        var window = new MoonYa.MainWindow();
        window.Loaded += async (_, _) => {
            try {
                await VerifyAsync(window, origin, output, args.Contains("--hold"));
                Console.WriteLine("PASS native CEF cursor, actions, iframe, scaling, tab ownership, cancellation, screenshots and shared PTT resources");
            } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
            finally { window.Close(); }
        };
        application.Run(window);
        server.Stop();
        Cef.Shutdown();
        occupiedDebuggingPort.Stop();
    }

    private static async Task VerifyAsync(MoonYa.MainWindow window, Uri origin, string output, bool hold)
    {
        await WaitAsync(async () => await window.ScriptBoolAsync("!!window.moonyaOpenBrowserPanel"));
        Check(window.PanelBrowser == null, "cold startup fixture already created the panel");
        using var service = new BrowserAutomationService(App.BrowserAutomation!, App.BuiltinBrowser);
        await service.StartAsync(new Uri(origin, "target").AbsoluteUri);
        Check(window.PanelBrowser?.IsBrowserInitialized == true, "automatic cold startup did not create CEF panel");
        Check(service.IsRunning && service.CurrentUrl == new Uri(origin, "target").AbsoluteUri, "occupied-port cold startup did not connect and navigate");
        var target = await App.BuiltinBrowser!.EnsurePanelAsync(null, false, App.BrowserAutomation!.Builtin.ConnectTimeoutMs, default);
        Check(target != null && !string.IsNullOrWhiteSpace(target.WebSocketDebuggerUrl), "host lost endpoint after navigation away from start page");
        await WaitAsync(() => Task.FromResult(window.VisualsEnabled));
        await service.ClickAsync("#target");
        Check(JsonSerializer.Deserialize<string>(await service.EvaluateAsync("document.body.dataset.clicks")) == "1", "target did not receive click");
        var pointer = window.Visuals!;
        var x = pointer.PointerX; var y = pointer.PointerY;
        Check(x > 0 && x < 1 && y > 0 && y < 1, "pointer outside viewport");
        await service.FillAsync("#field", "test input");
        Check(JsonSerializer.Deserialize<string>(await service.EvaluateAsync("document.querySelector('#field').value")) == "test input", "fill failed");
        await service.HoverAsync("#target");
        Check(JsonSerializer.Deserialize<string>(await service.EvaluateAsync("document.body.dataset.hovered")) == "yes", "hover did not use actual mouse events");
        await service.SetCheckedAsync("#check", true);
        await service.SelectAsync("#select", new[] { "b" });
        await service.ClickAsync("#frameButton");
        Check(JsonSerializer.Deserialize<string>(await service.EvaluateAsync("document.querySelector('iframe').contentDocument.body.dataset.clicked")) == "yes", "iframe click failed");
        await service.ClickAsync("#below");
        Check(JsonSerializer.Deserialize<string>(await service.EvaluateAsync("document.body.dataset.below")) == "yes", "offscreen target failed");
        await service.ScrollAsync("up", 2000);
        await service.HoverAsync("#target");
        await Task.Delay(100);
        Save(window, Path.Combine(output, "native-browser.png"));
        var screenshot = Convert.FromBase64String(await service.ScreenshotBase64Async());
        File.WriteAllBytes(Path.Combine(output, "raw-cdp.png"), screenshot);
        var fallback = await App.BuiltinBrowser!.CapturePanelScreenshotAsync(2000);
        Check(fallback != null, "OSR screenshot unavailable");
        File.WriteAllBytes(Path.Combine(output, "raw-osr.png"), fallback!);
        Check(WhiteCorner(screenshot) && WhiteCorner(fallback!), "host glow leaked into raw screenshot");
        var savedX = pointer.PointerX; var savedY = pointer.PointerY;
        var before = await App.BuiltinBrowser.BeginPointerOperationAsync();
        await window.ScriptAsync("document.getElementById('teamTabBrowser').click()");
        await WaitAsync(() => Task.FromResult(!window.VisualsEnabled));
        Check(!await App.BuiltinBrowser.UpdatePointerAsync(before!.Epoch, 0.9, 0.9), "old pointer survived tab switch");
        await window.ScriptAsync("document.querySelector('[data-panel-tab]').click()");
        await WaitAsync(() => Task.FromResult(window.VisualsEnabled));
        Check(Math.Abs(window.Visuals!.PointerX - savedX) < 0.001 && Math.Abs(window.Visuals.PointerY - savedY) < 0.001, "pointer not restored");
        await window.ScriptAsync("moonyaSetBrowserHandoff({}); moonyaOpenBrowserPanel({source:'handoff'})");
        Check(window.VisualsEnabled, "handoff removed effects");
        await window.ScriptAsync("moonyaSetDetailPanelOpen(false)");
        await Task.Delay(600);
        Check(window.BrowserLayer.Visibility == Visibility.Collapsed, "collapsed panel remained visible");
        await window.ScriptAsync("moonyaOpenBrowserPanel()");
        await WaitAsync(() => Task.FromResult(window.BrowserLayer.Visibility == Visibility.Visible));
        Check(window.VisualsEnabled, "manual reopen removed existing AI effects");
        App.BuiltinBrowser.OnSessionStopped();
        await Task.Delay(50);
        Check(window.VisualsEnabled, "session completion removed effects");
        App.BuiltinBrowser.OnSessionStarted();
        await Task.Delay(100);
        await window.ScriptAsync("document.querySelector('[data-panel-tab-close]').click()");
        await WaitAsync(() => Task.FromResult(!window.VisualsEnabled));
        await window.ScriptAsync("moonyaOpenBrowserPanel({source:'automation'})");
        await WaitAsync(() => Task.FromResult(window.VisualsEnabled));
        window.Width = 900; window.Height = 650;
        await Task.Delay(250);
        Check(Math.Abs(window.Visuals!.ActualWidth - window.PanelBrowser!.ActualWidth) < 1, "resized overlay not aligned");
        window.PanelBrowser.ZoomLevel = 1;
        await service.NavigateAsync(new Uri(origin, "target").AbsoluteUri);
        await service.HoverAsync("#target");
        Check(((Image)window.Visuals.FindName("Arrow")).Width == 22 / VisualTreeHelper.GetDpi(window.Visuals).DpiScaleX, "web zoom resized pointer");
        var epoch = (await App.BuiltinBrowser.BeginPointerOperationAsync())!.Epoch;
        window.ResetBuiltinBrowserPanel();
        await Task.Delay(100);
        Check(!window.VisualsEnabled && !await App.BuiltinBrowser.UpdatePointerAsync(epoch, 0.8, 0.8), "reset resurrected pointer");
        var voice = new PttGlowOverlay();
        Check(voice.FindResource("TopGlowBrush") is LinearGradientBrush, "shared PTT brush unavailable");
        voice.SetVoiceChatMode("listening"); await Task.Delay(100); voice.SetVoiceChatMode("off"); await Task.Delay(450); voice.Close();
        // Leave a useful native preview for manual mouse verification.
        await window.ScriptAsync("moonyaOpenBrowserPanel({source:'handoff'})");
        window.NavigateBuiltinBrowserPanel(new Uri(origin, "target").AbsoluteUri);
        await Task.Delay(150);
        await WaitAsync(() => Task.FromResult(window.BrowserLayer.Visibility == Visibility.Visible));
        if (hold) {
            Console.WriteLine("READY for native mouse inspection (90 seconds)");
            await Task.Delay(90000);
            Check(window.Visuals!.PointerX > 0 && window.Visuals.PointerY > 0, "native mouse pointer invalid");
            Save(window, Path.Combine(output, "native-handoff.png"));
        }
    }

    private static bool WhiteCorner(byte[] png)
    {
        using var stream = new MemoryStream(png);
        var bitmap = BitmapFrame.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        var bgra = new FormatConvertedBitmap(bitmap, PixelFormats.Bgra32, null, 0);
        var pixel = new byte[4]; bgra.CopyPixels(new Int32Rect(3,3,1,1), pixel, 4, 0);
        return pixel[0] > 250 && pixel[1] > 250 && pixel[2] > 250;
    }
    private static void Save(FrameworkElement element, string path)
    {
        var bitmap = new RenderTargetBitmap((int)element.ActualWidth, (int)element.ActualHeight, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(element); var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var stream = File.Create(path); encoder.Save(stream);
    }
    private static async Task WaitAsync(Func<Task<bool>> condition)
    {
        for (var i = 0; i < 400; i++) { if (await condition()) return; await Task.Delay(25); }
        throw new TimeoutException("native visual smoke condition");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static int FreePort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port=((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    private static async Task ServeAsync(HttpListener server, Uri origin)
    {
        try {
            while (server.IsListening) {
                var context = await server.GetContextAsync();
                var route = context.Request.Url!.AbsolutePath;
                string content;
                if (route == "/target") content = """
                    <html><style>body{margin:0;background:white;font:16px 'Segoe UI'}button,input,select{margin:20px;padding:10px}iframe{display:block;width:350px;height:120px}#below{margin-top:1500px}</style>
                    <body data-clicks="0"><button id="target" onmouseover="document.body.dataset.hovered='yes'" onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks)+1)">Test click and hover</button>
                    <input id="field"><input id="check" type="checkbox"><select id="select"><option value="a">A</option><option value="b">B</option></select>
                    <iframe srcdoc="<body><button id='frameButton' onclick='document.body.dataset.clicked=&quot;yes&quot;'>Frame button</button></body>"></iframe>
                    <button id="below" onclick="document.body.dataset.below='yes'">Offscreen target</button></body></html>
                    """;
                else if (route.EndsWith(".js")) content = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, route.TrimStart('/')));
                else content = File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"fixture.html")) + "<script src='/ui-icons.js'></script><script src='/browser-panel.js'></script>";
                context.Response.ContentType=route.EndsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
                var bytes=Encoding.UTF8.GetBytes(content); await context.Response.OutputStream.WriteAsync(bytes); context.Response.Close();
            }
        } catch (HttpListenerException) { } catch (ObjectDisposedException) { }
    }
}

namespace MoonYa
{
    internal static class App
    {
        internal static Uri? FrontendBaseAddress { get; set; }
        internal static BuiltinBrowserHost? BuiltinBrowser { get; set; }
        internal static BrowserAutomationConfig? BrowserAutomation { get; set; }
        internal static BrowserSecurityGate? BrowserSecurityGate => null;
    }
    public partial class MainWindow : Window
    {
        internal readonly CustomChromiumWebBrowser WebView = new();
        internal readonly Canvas BuiltinBrowserLayer = new();
        internal PanelChromiumWebBrowser? PanelBrowser => _builtinBrowser;
        internal BuiltinBrowserVisuals? Visuals => _builtinVisuals;
        internal bool VisualsEnabled => _builtinVisualsEnabled;
        internal Canvas BrowserLayer => BuiltinBrowserLayer;
        public MainWindow()
        {
            Title="MoonYa browser visual smoke"; Width=1200; Height=850;
            var grid=new Grid(); grid.Children.Add(WebView); grid.Children.Add(BuiltinBrowserLayer); Content=grid;
            WebView.JavascriptObjectRepository.NameConverter=new CefSharp.JavascriptBinding.CamelCaseJavascriptNameConverter();
            WebView.ConsoleMessage += (_, e) => Console.WriteLine("CEF: " + e.Message);
            InitializeBuiltinBrowserPanel(); WebView.Address=App.FrontendBaseAddress!.AbsoluteUri;
        }
        private void SetInputFocusState(bool focused) { }
        internal async Task ScriptAsync(string script)
        {
            var result=await WebView.EvaluateScriptAsync(script); if (!result.Success) throw new Exception(result.Message);
        }
        internal async Task<bool> ScriptBoolAsync(string expression)
        {
            if (!WebView.IsBrowserInitialized || !WebView.CanExecuteJavascriptInMainFrame) return false;
            var result=await WebView.EvaluateScriptAsync(expression); return result.Success && result.Result is true;
        }
    }
}
