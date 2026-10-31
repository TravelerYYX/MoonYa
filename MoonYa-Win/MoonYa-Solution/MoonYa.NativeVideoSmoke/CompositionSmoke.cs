using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using CefSharp;
using CefSharp.Wpf;
using Rectangle = System.Windows.Shapes.Rectangle;

internal static class CompositionSmoke
{
    [DllImport("kernel32", CharSet = CharSet.Unicode)]
    private static extern bool SetDllDirectory(string directory);

    internal static Task VerifyAsync(Rectangle video, string videoPath)
    {
        var native = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../MoonYa/bin/x64/Debug/net8.0-windows10.0.19041.0"));
        SetDllDirectory(native);
        return VerifyCoreAsync(video, videoPath, native);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static async Task VerifyCoreAsync(Rectangle video, string videoPath, string native)
    {
        var initialized = Cef.Initialize(new CefSettings
        {
            BrowserSubprocessPath = Path.Combine(native, "CefSharp.BrowserSubprocess.exe"),
            ResourcesDirPath = native, LocalesDirPath = Path.Combine(native, "locales"),
            LogSeverity = LogSeverity.Disable
        }, performDependencyCheck: false, browserProcessHandler: null);
        if (!initialized) throw new InvalidOperationException("CEF did not initialize");
        var browser = new MoonYa.CustomChromiumWebBrowser
        {
            BrowserSettings = new BrowserSettings { BackgroundColor = 0 },
            Width = 640, Height = 360
        };
        var grid = new Grid { Width = 640, Height = 360, Background = Brushes.Black };
        grid.Children.Add(video);
        grid.Children.Add(browser);
        var window = new Window { Content = grid, SizeToContent = SizeToContent.WidthAndHeight,
            ShowActivated = false, ShowInTaskbar = false, WindowStyle = WindowStyle.None };
        try
        {
            window.Show();
            var workspace = new DirectoryInfo(AppContext.BaseDirectory);
            while (workspace != null && !Directory.Exists(Path.Combine(workspace.FullName, "MoonYa-Frontend"))) workspace = workspace.Parent;
            if (workspace == null) throw new InvalidOperationException("Workspace not found");
            var frontend = Path.Combine(workspace.FullName, "MoonYa-Frontend");
            using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(frontend, "src", "manifest.json")));
            var css = string.Join("\n", manifest.RootElement.GetProperty("styles").EnumerateArray().Select(name =>
            {
                var source = Path.Combine(frontend, "src", "styles", name.GetString()!);
                return File.ReadAllText(File.Exists(source) ? source : Path.Combine(workspace.FullName, "MoonYa-Backend", "admin", "assets", name.GetString()!));
            }));
            var snapshot = JsonSerializer.Serialize(new { version = 1, working = new {
                background = new { type = "video", path = videoPath, fill = "cover" }, shellOpacity = 0.85, blur = 0 } });
            var script = File.ReadAllText(Path.Combine(frontend, "src", "appearance.js"));
            browser.LoadHtml("<!doctype html><html><head><style>" + css + "</style>" +
                "<script>window.MoonYaHost={nativeVideo:true,mediaToken:'smoke'};localStorage.setItem('moonya.appearance.v1'," + JsonSerializer.Serialize(snapshot) + ");</script>" +
                "</head><body class='app-shell work-mode'><div class='container'><nav class='app-rail'></nav><aside class='sidebar'></aside><div class='main-content'></div></div>" +
                "<script>" + script + "</script></body></html>", "http://moonya-video-smoke.test/");
            var deadline = DateTime.UtcNow.AddSeconds(15);
            var ready = false;
            while (DateTime.UtcNow < deadline)
            {
                if (browser.CanExecuteJavascriptInMainFrame)
                {
                    var check = await browser.EvaluateScriptAsync("document.body.classList.contains('moonya-native-video')");
                    if (check.Success && check.Result is true) { ready = true; break; }
                }
                await Task.Delay(100);
            }
            if (!ready) throw new InvalidOperationException("Native video page did not initialize");
            await Task.Delay(600);
            var visible = Capture(grid);
            video.Visibility = Visibility.Hidden;
            await Task.Delay(200);
            var covered = Capture(grid);
            var differentPixels = 0;
            for (var i = 0; i < visible.Length; i += 4)
                if (Math.Abs(visible[i] - covered[i]) + Math.Abs(visible[i + 1] - covered[i + 1]) + Math.Abs(visible[i + 2] - covered[i + 2]) > 8) differentPixels++;
            if (differentPixels < 1000) throw new InvalidOperationException("WebView hides the video: changed pixels=" + differentPixels);
            Console.WriteLine("PASS: native MP4 is visible through the real CEF page and appearance styles (" + differentPixels + " pixels)");
            video.Visibility = Visibility.Visible;
        }
        finally
        {
            grid.Children.Remove(video);
            browser.Dispose();
            window.Close();
            Cef.Shutdown();
        }
    }

    private static byte[] Capture(Grid grid)
    {
        var bitmap = new RenderTargetBitmap(640, 360, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(grid);
        var bytes = new byte[640 * 360 * 4];
        bitmap.CopyPixels(bytes, 640 * 4, 0);
        return bytes;
    }
}
