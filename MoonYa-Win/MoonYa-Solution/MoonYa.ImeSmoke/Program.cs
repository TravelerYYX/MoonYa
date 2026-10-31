using System;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Windows;
using System.Windows.Input;
using CefSharp;
using CefSharp.Wpf;
using CefSharp.Wpf.Experimental;
using MoonYa;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var languages = InputLanguageManager.Current;
        var originalLanguage = languages.CurrentInputLanguage;
        CustomChromiumWebBrowser? browser = null;
        Window? window = null;
        var cefInitialized = false;
        try
        {
            var installed = languages.AvailableInputLanguages.Cast<CultureInfo>().ToArray();
            var english = installed.FirstOrDefault(language => language.TwoLetterISOLanguageName == "en");
            if (english != null) languages.CurrentInputLanguage = english;
            Console.WriteLine("Startup input language: " + languages.CurrentInputLanguage.Name);

            cefInitialized = Cef.Initialize(new CefSettings { LogSeverity = LogSeverity.Disable }, performDependencyCheck: true, browserProcessHandler: null);
            Require(cefInitialized, "CEF must initialize");
            browser = new CustomChromiumWebBrowser();
            Require(browser.WpfKeyboardHandler is WpfImeKeyboardHandler, "IME handler must exist even at English startup");
            var handler = browser.WpfKeyboardHandler;

            // 使用不可见窗口验证实际 HwndSource 接入，不连接后端、不发送聊天消息。
            window = new Window { Content = browser, Width = 320, Height = 200,
                Opacity = 0, ShowInTaskbar = false, ShowActivated = false };
            window.Show();
            Require(GetHandlerFlag(handler, "isSetup"), "IME handler must be connected to the window");
            window.Focus();
            browser.Focus();
            Require(GetHandlerFlag(handler, "isActive"), "IME handler must activate on focus");
            Require(InputMethod.GetIsInputMethodEnabled(browser), "native IME must be enabled");
            Require(InputMethod.GetIsInputMethodSuspended(browser), "WPF composition must yield to native IME");

            var chinese = installed.FirstOrDefault(language => language.TwoLetterISOLanguageName == "zh");
            if (chinese != null)
            {
                languages.CurrentInputLanguage = chinese;
                Require(ReferenceEquals(handler, browser.WpfKeyboardHandler), "language switching must retain the connected handler");
                Require(GetHandlerFlag(handler, "isSetup"), "IME handler must remain connected after switching to Chinese");
                languages.CurrentInputLanguage = english ?? originalLanguage;
                Require(ReferenceEquals(handler, browser.WpfKeyboardHandler), "switching back must retain the handler");
            }
            else
            {
                Console.WriteLine("SKIP: Chinese input language is not installed");
            }

            browser.Dispose();
            Require(!GetHandlerFlag(handler, "isSetup"), "disposing the browser must remove IME hooks");
            Console.WriteLine("PASS: startup handler, window hookup, focus activation and disposal");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
        finally
        {
            browser?.Dispose();
            window?.Close();
            languages.CurrentInputLanguage = originalLanguage;
            if (cefInitialized) Cef.Shutdown();
        }
    }

    private static bool GetHandlerFlag(IWpfKeyboardHandler handler, string name)
        => (bool)typeof(WpfImeKeyboardHandler).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(handler)!;

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
