using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using CefSharp;
using CefSharp.Wpf;
using MoonYa.Services;

internal static class Program
{
    [DllImport("kernel32", CharSet = CharSet.Unicode)] private static extern bool SetDllDirectory(string path);
    [STAThread] private static void Main(string[] args)
    {
        SetDllDirectory(Path.GetFullPath(args[1])); Run(args);
    }
    [MethodImpl(MethodImplOptions.NoInlining)] private static void Run(string[] args)
    {
        var directory = Path.Combine(Path.GetTempPath(), "moonya-attachment-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var config = Path.Combine(directory, "files.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { file_operations = new {
            allowed_roots = new[] { Path.Combine(directory, "unused-root") }, blocked_paths = Array.Empty<string>(), max_file_size_mb = 64, enable_delete = false } }));
        var files = new FileOperationService(config);
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        var origin = new Uri("http://127.0.0.1:" + port + "/");
        using var server = new HttpListener(); server.Prefixes.Add(origin.AbsoluteUri); server.Start();
        _ = Serve(server);
        var native = Path.GetFullPath(args[1]);
        Check(Cef.Initialize(new CefSettings {
            CachePath = Path.Combine(directory, "cef"), RootCachePath = Path.Combine(directory, "cef"),
            BrowserSubprocessPath = Path.Combine(native, "CefSharp.BrowserSubprocess.exe"), ResourcesDirPath = native,
            LocalesDirPath = Path.Combine(native, "locales"), LogFile = Path.Combine(directory, "cef.log"), LogSeverity = LogSeverity.Error
        }, performDependencyCheck: false, browserProcessHandler: null), "CEF initialization failed");
        var application = new Application();
        using var browser = new ChromiumWebBrowser(origin.AbsoluteUri);
        var window = new Window { Content = browser, Width = 700, Height = 500, ShowInTaskbar = false, Opacity = 0, WindowStyle = WindowStyle.None };
        _ = new AttachmentDropController(browser, files, origin);
        window.Loaded += async (_, _) => {
            try {
                await Wait(async () => await Bool(browser, "!!window.moonyaReceiveNativeDrop"));
                var yax = Path.GetFullPath(args[0]);
                var text = Path.Combine(directory, "ordered.txt"); File.WriteAllText(text, "native drag attachment");
                var denied = Path.Combine(directory, "denied.txt"); File.WriteAllText(denied, "no grant");
                Drop(browser, yax, text);
                await Wait(async () => await Bool(browser, "window.received.length === 1"));
                Check(files.IsLocallyGrantedFile(yax) && files.IsLocallyGrantedFile(text), "FileDrop did not grant real exact paths");
                var result = await browser.EvaluateScriptAsync("JSON.stringify(window.received[0].items.map(item=>[item.name,item.size]))");
                using var items = JsonDocument.Parse((string)result.Result);
                Check(items.RootElement[0][0].GetString() == "yax.png" && items.RootElement[1][0].GetString() == "ordered.txt", "FileDrop order changed");
                Check(items.RootElement[0][1].GetInt64() == new FileInfo(yax).Length, "Native file metadata lost size");
                await browser.EvaluateScriptAsync("window.accept=false");
                Drop(browser, denied); await Task.Delay(150);
                Check(!files.IsLocallyGrantedFile(denied), "Rejected chat surface received file grant");
                await browser.EvaluateScriptAsync("window.accept=true; window.rejectHandoff=true");
                Drop(browser, denied); await Wait(async () => await Bool(browser, "window.received.length === 2")); await Task.Delay(100);
                Check(!files.IsLocallyGrantedFile(denied), "Rejected conversation handoff retained authorization");
                // A rejected second handoff must preserve the existing file grant.
                Drop(browser, yax); await Wait(async () => await Bool(browser, "window.received.length === 3")); await Task.Delay(100);
                Check(files.IsLocallyGrantedFile(yax), "Rejected duplicate drop revoked an existing selection");
                browser.Load("about:blank"); await Wait(() => Task.FromResult(browser.Address == "about:blank"));
                Drop(browser, denied); await Task.Delay(100); Check(!files.IsLocallyGrantedFile(denied), "Untrusted origin received file grant");
                files.RevokeLocalPath(yax); Check(!files.IsLocallyGrantedFile(yax), "Remove failed to revoke exact authorization");
                Console.WriteLine("PASS native WPF FileDrop: exact paths, sizes, order, single handoff, rejected surfaces/conversations/origin, duplicate grants and revocation");
            } catch (Exception error) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
            finally { window.Close(); }
        };
        application.Run(window); server.Stop(); browser.Dispose(); Cef.Shutdown();
    }
    private static void Drop(ChromiumWebBrowser browser, params string[] paths)
    {
        var data = new DataObject(DataFormats.FileDrop, paths);
        var constructor = typeof(DragEventArgs).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).Single(c => c.GetParameters().Length == 5);
        var args = (DragEventArgs)constructor.Invoke(new object[] { data, DragDropKeyStates.None, DragDropEffects.Copy, browser, new Point(300, 200) });
        args.RoutedEvent = UIElement.PreviewDropEvent; args.Source = browser;
        browser.RaiseEvent(args); Check(args.Handled, "CEF default navigation was not intercepted");
    }
    private static async Task<bool> Bool(ChromiumWebBrowser browser, string script)
    {
        if (!browser.IsBrowserInitialized || !browser.CanExecuteJavascriptInMainFrame) return false;
        var result = await browser.EvaluateScriptAsync(script); return result.Success && result.Result is true;
    }
    private static async Task Wait(Func<Task<bool>> condition)
    {
        for (var index = 0; index < 150; index++) { if (await condition()) return; await Task.Delay(50); }
        throw new TimeoutException("Native attachment check timed out");
    }
    private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    private static async Task Serve(HttpListener server)
    {
        while (server.IsListening) {
            HttpListenerContext context; try { context = await server.GetContextAsync(); } catch { return; }
            var bytes = Encoding.UTF8.GetBytes("<script>window.accept=true;window.received=[];window.moonyaAttachmentDragAt=()=>window.accept?{chatId:'native',historyScope:'test',mode:'work'}:null;window.moonyaReceiveNativeDrop=async payload=>{window.received.push(payload);return window.rejectHandoff?[]:payload.items.map(item=>item.path)};</script>");
            context.Response.ContentType = "text/html"; await context.Response.OutputStream.WriteAsync(bytes); context.Response.Close();
        }
    }
}
