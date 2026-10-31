// ┌─────────────────────────────────────────────────────────┐
// │  TitleBarStateBridge — CefSharp JS 桥接对象              │
// │  网页切换 Work / Chat 模式后把模式推给原生标题栏          │
// └─────────────────────────────────────────────────────────┘

using System;

namespace MoonYa
{
    /// <summary>
    /// JS 桥：script-1a-vars.php（侧边栏模式 Tab）与 script-1e-rest.php（会话状态恢复）
    /// 在切换模式后调用 moonYaTitlebarHost.setWorkMode(work)。
    /// Work 模式下原生标题栏隐藏「语音播报」开关——该入口只属于 Chat 模式。
    /// </summary>
    public class TitleBarStateBridge
    {
        private readonly MainWindow _window;

        public TitleBarStateBridge(MainWindow window)
        {
            _window = window ?? throw new ArgumentNullException(nameof(window));
        }

        // 由 JS 调用：moonYaTitlebarHost.setWorkMode(true/false)
        //   桥回调可能不在 UI 线程，MainWindow 内部会切回 Dispatcher。
        public void setWorkMode(bool work)
        {
            try
            {
                _window.ApplyWorkModeFromPage(work);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[TitleBar] setWorkMode failed: {ex.Message}");
            }
        }
    }
}
