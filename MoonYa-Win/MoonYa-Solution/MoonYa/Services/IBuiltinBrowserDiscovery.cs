// IBuiltinBrowserDiscovery — 内置浏览器面板与自动化引擎之间的窄接口。
// BrowserAutomationService 只依赖该接口，不直接引用 WPF 窗口，
// 因此可以脱离 UI 做契约测试（MoonYa.BrowserSmoke --connect）。

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace MoonYa.Services
{
    public sealed class BuiltinPointerState
    {
        public long Epoch { get; init; }
        public double X { get; init; } = 0.5;
        public double Y { get; init; } = 0.5;
    }

    /// <summary>内置浏览器面板在 CDP 上的可识别特征。</summary>
    public sealed class BuiltinPanelTarget
    {
        /// <summary>底层 CEF 浏览器标识（CDP target id 的首选匹配信号）。</summary>
        public string TargetId { get; set; } = string.Empty;

        /// <summary>C# 在每次加载完成后写入的 window.name 标记。</summary>
        public string WindowName { get; set; } = string.Empty;

        /// <summary>面板当前地址。</summary>
        public string Address { get; set; } = string.Empty;

        /// <summary>
        /// 面板页面的页面级 CDP WebSocket 端点（由宿主从 CEF /json/list 解析）。
        /// 宿主从该端点同时获取准确 target id，自动化通过浏览器级连接匹配该 target。
        /// </summary>
        public string WebSocketDebuggerUrl { get; set; } = string.Empty;

        /// <summary>CEF 浏览器标识（诊断用）。</summary>
        public int BrowserIdentifier { get; set; }

        public string Describe() =>
            "target_id=" + (string.IsNullOrEmpty(TargetId) ? "-" : TargetId)
            + ", address=" + (string.IsNullOrEmpty(Address) ? "-" : Address)
            + ", page_endpoint=" + (string.IsNullOrEmpty(WebSocketDebuggerUrl) ? "-" : "yes");
    }

    /// <summary>一个 CDP 目标的探测结果（用于纯逻辑匹配，可脱 UI 测试）。</summary>
    public sealed class BuiltinTargetProbe
    {
        public string TargetId { get; set; } = string.Empty;
        public string WindowName { get; set; } = string.Empty;
        public string Address { get; set; } = string.Empty;
    }

    /// <summary>内置浏览器面板的发现/生命周期接口。</summary>
    public interface IBuiltinBrowserDiscovery
    {
        /// <summary>是否启用内置浏览器。</summary>
        bool Enabled { get; }

        /// <summary>内置浏览器是否优先于外部 Chrome。</summary>
        bool Prefer { get; }

        /// <summary>CEF 远程调试端口。</summary>
        int RemoteDebuggingPort { get; }

        /// <summary>最近一次面板发现状态，超时时用于区分控件与 CDP 端点问题。</summary>
        string DiscoveryStatus => string.Empty;

        /// <summary>面板新标签页地址（关闭标签时回到这里）。</summary>
        string StartPageAddress { get; }

        /// <summary>
        /// 确保面板浏览器存在（必要时创建），按配置决定是否展开右侧栏页签，
        /// 并等待底层 CEF 浏览器就绪。窗口不可用时返回 null。
        /// </summary>
        Task<BuiltinPanelTarget?> EnsurePanelAsync(string? url, bool autoOpen, int timeoutMs, CancellationToken cancellationToken);

        /// <summary>会话开始：保持隐藏渲染并在需要时展开面板。</summary>
        void OnSessionStarted();

        /// <summary>会话结束：恢复默认的隐藏行为。</summary>
        void OnSessionStopped();

        /// <summary>把面板恢复到新标签页并隐藏覆盖层（stop/关闭标签语义）。</summary>
        void ResetPanel();

        /// <summary>
        /// 直接取面板最近一帧 OSR 位图并编码为 PNG（CDP 截图不可用时的兜底）。
        /// 无法取帧时返回 null。
        /// </summary>
        Task<byte[]?> CapturePanelScreenshotAsync(int timeoutMs);

        // Optional visual capability; headless discovery implementations remain compatible.
        Task<BuiltinPointerState?> BeginPointerOperationAsync() => Task.FromResult<BuiltinPointerState?>(null);
        Task<bool> UpdatePointerAsync(long epoch, double x, double y) => Task.FromResult(true);
        Task EndPointerOperationAsync(long epoch) => Task.CompletedTask;
        void ResetVisuals() { }
    }

    /// <summary>
    /// 面板目标匹配：按信号强度依次尝试
    ///   1) CDP target id 精确匹配（最强）
    ///   2) window.name 标记（面板由 C# 在每次加载完成后写入）
    ///   3) 面板地址匹配（最弱）
    /// 同级信号出现多处命中视为歧义并返回 -1，避免驱动到错误页面。
    /// </summary>
    public static class BuiltinTargetMatcher
    {
        /// <summary>面板浏览器专用 window.name 标记（CDP 可见、跨导航保留）。</summary>
        public const string WindowNameMarker = "moonya-builtin-panel";

        public static int FindPanelIndex(IReadOnlyList<BuiltinTargetProbe> probes, BuiltinPanelTarget? expected)
        {
            if (probes == null || probes.Count == 0) return -1;

            if (expected != null && !string.IsNullOrWhiteSpace(expected.TargetId))
            {
                var idMatches = Match(probes, probe =>
                    string.Equals(probe.TargetId, expected.TargetId, StringComparison.Ordinal));
                if (idMatches.Count == 1) return idMatches[0];
                if (idMatches.Count > 1) return -1;
            }

            var nameMatches = Match(probes, probe =>
                string.Equals(probe.WindowName, WindowNameMarker, StringComparison.Ordinal));
            if (nameMatches.Count == 1) return nameMatches[0];
            if (nameMatches.Count > 1) return -1;

            if (expected != null && !string.IsNullOrWhiteSpace(expected.Address))
            {
                var addressMatches = Match(probes, probe =>
                    string.Equals(probe.Address, expected.Address, StringComparison.Ordinal));
                if (addressMatches.Count == 1) return addressMatches[0];
            }

            return -1;
        }

        private static List<int> Match(IReadOnlyList<BuiltinTargetProbe> probes, Func<BuiltinTargetProbe, bool> predicate)
        {
            var matches = new List<int>();
            for (var index = 0; index < probes.Count; index++)
            {
                var probe = probes[index];
                if (probe == null) continue;
                try
                {
                    if (predicate(probe)) matches.Add(index);
                }
                catch (Exception)
                {
                    // 单条探测异常不影响其余目标判定
                }
            }
            return matches;
        }
    }
}
