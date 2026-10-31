using System.Windows.Input;
using CefSharp.Wpf;
using CefSharp.Wpf.Experimental;

namespace MoonYa
{
    /// <summary>
    /// 继承 ChromiumWebBrowser，覆盖 OnLostMouseCapture 以阻止
    /// SendCaptureLostEvent() 在 mouseup 后清空文字选区。
    /// 根因：CefSharp.Wpf 的 OnMouseUp 在发送 mouseup 给 CEF 后调用
    /// ReleaseMouseCapture()，触发 OnLostMouseCapture → SendCaptureLostEvent()，
    /// CEF 收到捕获丢失信号后会清空 Blink 选区。
    ///
    /// ★ IME（中文输入）说明：
    ///   曾在此手动订阅 TextCompositionManager 的 PreviewTextInputStart/Update/End，
    ///   转调 host.ImeSetComposition / ImeCommitText。该 hack 与 CefSharp 147
    ///   内置的 WpfImeKeyboardHandler（窗口消息层处理 WM_IME_*）双重转发、互相覆盖，
    ///   合成状态被打乱。统一使用内置 IME 处理器，且在创建控件时就初始化，
    ///   避免英文键盘启动后切换中文时新处理器未接入当前 HwndSource。
    /// </summary>
    public class CustomChromiumWebBrowser : ChromiumWebBrowser
    {
        protected override void SetupWpfKeyboardHandler()
        {
            // CefSharp 147 的语言切换路径只替换处理器，没有调用 Setup(source)。
            // 提前创建后，由基类的 PresentationSourceChangedHandler 完成窗口消息接入。
            // 此处理器也支持普通英文按键，不需要随输入语言反复替换。
            WpfKeyboardHandler = new WpfImeKeyboardHandler(this);
        }

        protected override void OnLostMouseCapture(MouseEventArgs e)
        {
            e.Handled = true;
            base.OnLostMouseCapture(e);
        }
    }
}
