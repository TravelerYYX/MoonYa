using System.Diagnostics;
using System.IO;
using CefSharp.Wpf;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using CefSharp;
using MoonYa;
using MoonYa.Services;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--mutex-probe")
        {
            using var guard = new SingleInstanceGuard(args[1]);
            return guard.IsOwner ? 0 : 2;
        }
        var mutexName = @"Local\MoonYa.Smoke." + Guid.NewGuid();
        using (var guard = new SingleInstanceGuard(mutexName))
        {
            Require(guard.IsOwner, "first process owns lock");
            Require(ProbeMutex(mutexName) == 2, "second process cannot use shared cache");
        }
        Require(ProbeMutex(mutexName) == 0, "lock is released on exit");
        var clientExe = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, "bin", "x64", "Release", "net8.0-windows10.0.19041.0", "FarSide.exe");
        using (var clientGuard = new SingleInstanceGuard())
        {
            Require(clientGuard.IsOwner, "fixture owns client lock");
            Require(RunClient(clientExe) == 0, "duplicate client exits before creating CEF/window");
        }
        Require(RunClient(clientExe, "moonya:invalid") == 0, "invalid activation exits without startup window");
        var pipeName = "MoonYa.Smoke." + Guid.NewGuid();
        var received = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using (var activation = new PaymentActivationService(pipeName))
        {
            activation.Start(received.Enqueue);
            var order = "MYfixture0000000001";
            Require(Task.Run(() => PaymentActivationService.TrySend(PaymentActivationService.ShowCommand, pipeName)).Result, "show command acknowledged");
            Require(Task.Run(() => PaymentActivationService.TrySend("moonya://payment/return?order_no=" + order, pipeName)).Result, "payment command acknowledged");
            Require(received.SequenceEqual(new[] { PaymentActivationService.ShowCommand, order }), "activation commands keep their meaning");
            Require(PaymentActivationService.OrderFromUri(PaymentActivationService.ShowCommand) == null, "show command is not a payment order");
        }

        // Test the real main window without starting App.OnStartup, local servers or tasks.
        System.Threading.SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext());
        var application = new Application();
        var xaml = System.Xml.Linq.XDocument.Load(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[0]))!, "App.xaml"));
        var resources = xaml.Descendants().First(element => element.Name.LocalName == "ResourceDictionary");
        resources.SetAttributeValue(System.Xml.Linq.XNamespace.Xmlns + "x", "http://schemas.microsoft.com/winfx/2006/xaml");
        resources.SetAttributeValue(System.Xml.Linq.XNamespace.Xmlns + "sys", "clr-namespace:System;assembly=System.Runtime");
        application.Resources = (ResourceDictionary)System.Windows.Markup.XamlReader.Parse(resources.ToString());
        application.ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var cef = false;
        MoonYa.MainWindow? window = null;
        try
        {
            cef = Cef.Initialize(new CefSettings { LogSeverity = LogSeverity.Disable, LocalesDirPath = Path.Combine(AppContext.BaseDirectory, "runtimes", "win-x64", "native", "locales") }, performDependencyCheck: true, browserProcessHandler: null);
            Require(cef, "isolated CEF initializes");
            typeof(MoonYa.App).GetField("_fileService", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null,
                new FileOperationService(Path.GetFullPath(args[0])));
            window = new MoonYa.MainWindow { ShowActivated = false, ShowInTaskbar = false };
            typeof(MoonYa.MainWindow).GetField("_initialized", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(window, true);
            window.Show();
            Pump();
            for (var i = 0; i < 8; i++)
            {
                // Reproduce an interrupted old fade with a visible, transparent HWND.
                window.BeginAnimation(Window.OpacityProperty, new DoubleAnimation(0, TimeSpan.Zero));
                Call(window, "ShowWindow");
                Require(window.IsVisible && window.Opacity == 1, "activation repairs stale opacity");
                Call(window, "Close_Click", null!, new RoutedEventArgs());
                Require(!window.IsVisible && window.Opacity == 1, "tray hide leaves no invisible input blocker");
                Call(window, "ShowWindow");
                Require(window.IsVisible && window.Opacity == 1, "tray restore is visible");
            }
            window.WindowState = WindowState.Minimized;
            Call(window, "ShowWindow");
            Pump();
            Require(window.WindowState != WindowState.Minimized && window.Opacity == 1, "minimized window restores");
            var handlerType = typeof(MoonYa.MainWindow).Assembly.GetType("MoonYa.FrontendNavigationHandler")!;
            Action<CefTerminationStatus, int, string> callback = (status, code, error) => Call(window, "ShowRendererFailure", status, code, error);
            var handler = (IRequestHandler)Activator.CreateInstance(handlerType, BindingFlags.Instance | BindingFlags.NonPublic,
                null, new object[] { callback }, null)!;
            var browser = (CustomChromiumWebBrowser)window.FindName("WebView");
            Require(Task.Run(() => handler.OnRenderProcessTerminated(browser, null!, CefTerminationStatus.ProcessCrashed, -1, "smoke fixture")).Wait(2000),
                "CEF termination callback does not block on WPF dispatcher");
            Pump();
            var errorPanel = (StackPanel)window.FindName("FrontendStartupError");
            Require(errorPanel.Visibility == Visibility.Visible, "renderer failure exposes recovery UI");
            Console.WriteLine("PASS: cross-process lock, activation/payment pipe, repeated hide/show, stale opacity, minimized restore, renderer recovery UI");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            window?.Close();
            if (cef) Cef.Shutdown();
        }
    }
    private static void Call(object target, string name, params object[] args)
        => target.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, args);
    private static void Pump()
    {
        var frame = new DispatcherFrame();
        Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => frame.Continue = false));
        Dispatcher.PushFrame(frame);
    }
    private static int RunClient(string path, params string[] args)
    {
        var start = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var child = Process.Start(start)!;
        if (!child.WaitForExit(10000)) { child.Kill(); throw new Exception("client startup probe timed out"); }
        return child.ExitCode;
    }
    private static int ProbeMutex(string name)
    {
        var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("--mutex-probe"); start.ArgumentList.Add(name);
        using var child = Process.Start(start)!;
        if (!child.WaitForExit(5000)) { child.Kill(); throw new Exception("mutex probe timed out"); }
        return child.ExitCode;
    }
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
