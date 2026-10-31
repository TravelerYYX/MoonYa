// BuiltinBrowserOptions — 内置浏览器（进程内 CEF/Chromium 右侧栏面板）配置
// 由 launcher_config.json 的 browser_automation.builtin 段读取后注入。
// 外部 Chrome/Edge 由独立插件授权控制；内置失败不自动回退。

using System;
using System.Collections.Generic;
using System.IO;

namespace MoonYa.Services
{
    /// <summary>内置浏览器配置。</summary>
    public sealed class BuiltinBrowserOptions
    {
        /// <summary>lacuncher_config 缺省端口：与既有本地服务端口（58900-58907）不冲突。</summary>
        public const int DefaultRemoteDebuggingPort = 58909;

        /// <summary>是否启用内置浏览器。</summary>
        public bool Enabled { get; set; }

        /// <summary>内置浏览器可用时是否优先于外部 Chrome。</summary>
        public bool Prefer { get; set; } = true;

        /// <summary>CEF 远程调试端口（仅回环）。PuppeteerSharp 通过它驱动本进程内的浏览器。</summary>
        public int RemoteDebuggingPort { get; set; } = DefaultRemoteDebuggingPort;

        /// <summary>Agent 启动浏览器会话时是否自动展开右侧栏浏览器页签。</summary>
        public bool OpenPanelOnStart { get; set; } = true;

        /// <summary>会话进行中面板被收起时是否保持 CEF 渲染（保证截图仍然有效）。</summary>
        public bool KeepRenderingWhenHidden { get; set; } = true;

        /// <summary>是否使用独立 RequestContext（隔离 cookie/缓存，不污染主界面会话）。</summary>
        public bool IsolateProfile { get; set; } = true;

        /// <summary>独立 profile 缓存目录（IsolateProfile 为 true 时生效）。</summary>
        public string CachePath { get; set; } = string.Empty;

        /// <summary>内置浏览器新标签页路径（相对程序目录或绝对路径）。</summary>
        public string StartPage { get; set; } = string.Empty;

        /// <summary>等待面板浏览器就绪的超时（毫秒）。</summary>
        public int ConnectTimeoutMs { get; set; } = 8000;

        /// <summary>仅当 Enabled 时校验，避免未启用时把可选配置当成缺失。</summary>
        public void Validate()
        {
            var missing = new List<string>();
            if (RemoteDebuggingPort < 1024 || RemoteDebuggingPort > 65535) missing.Add("remote_debugging_port");
            if (ConnectTimeoutMs <= 0) missing.Add("connect_timeout_ms");
            if (IsolateProfile && string.IsNullOrWhiteSpace(CachePath)) missing.Add("cache_path");
            if (missing.Count > 0)
            {
                throw new InvalidOperationException(
                    "browser_automation.builtin 配置缺失或无效: " + string.Join(", ", missing));
            }
        }

        /// <summary>解析缓存目录（支持 %LOCALAPPDATA% 等环境变量）。</summary>
        /// <remarks>
        /// CEF 要求 RequestContext 的 cache_path 必须是根 cache_path 的子目录
        /// （见 cef/browser/context.cc: "not a child of the root_cache_path directory"），
        /// 因此默认值派生自主缓存目录 %USERPROFILE%\.MoonYa\CefCache。
        /// </remarks>
        public string ResolveCachePath()
        {
            var configured = string.IsNullOrWhiteSpace(CachePath)
                ? AppDataPaths.PathFor("CefCache", "BrowserPanel")
                : CachePath;
            var expanded = Environment.ExpandEnvironmentVariables(configured.Trim());
            try
            {
                return Path.GetFullPath(Path.IsPathRooted(expanded)
                    ? expanded
                    : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, expanded));
            }
            catch (Exception)
            {
                return expanded;
            }
        }
    }
}
