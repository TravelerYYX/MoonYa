// PanelRequestHandler — 右侧栏内置浏览器的 CEF 处理器集合。
//
// 这些处理器只挂在内置浏览器控件上，不影响主界面 WebView：
//   · PanelRequestHandler        请求级：User-Agent 覆盖 + 证书错误放行
//   · PanelResourceRequestHandler 资源级：实际写入 Chrome UA
//   · PanelLifeSpanHandler        window.open / target=_blank 在原地打开（单标签语义）
//   · PanelJsDialogHandler        JS 对话框按 Puppeteer 语义自动关闭，避免页面卡死
//   · PanelDownloadHandler        下载静默保存到配置目录，供 list_downloads 枚举

using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using CefSharp;
using CefSharp.Handler;

namespace MoonYa
{
    /// <summary>内置浏览器请求处理器。</summary>
    public sealed class PanelRequestHandler : RequestHandler
    {
        /// <summary>
        /// 面板浏览器的 User-Agent。全局 CefSettings.UserAgent 为 "MoonYaDesktop/1.0"，
        /// 前端用它识别桌面运行时（不能改），但真实站点需要标准 Chrome UA 才不会拒绝或降级。
        /// </summary>
        public static string ChromeUserAgent { get; } = BuildChromeUserAgent();

        private static string BuildChromeUserAgent()
        {
            var version = "147";
            try
            {
                var chromiumVersion = Cef.ChromiumVersion ?? string.Empty;
                var major = chromiumVersion.Split('.')[0];
                if (!string.IsNullOrWhiteSpace(major)) version = major;
            }
            catch (Exception)
            {
                // CEF 未初始化时退回默认主版本号
            }
            return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                + version + ".0.0.0 Safari/537.36";
        }

        protected override IResourceRequestHandler? GetResourceRequestHandler(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            bool isNavigation,
            bool isDownload,
            string requestInitiator,
            ref bool disableCache)
        {
            return new PanelResourceRequestHandler();
        }

        // 仅放行 BrowserSecurityGate 已按域名与 SHA-256 指纹确认的证书。
        protected override bool OnCertificateError(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            CefErrorCode errorCode,
            string requestUrl,
            ISslInfo sslInfo,
            IRequestCallback callback)
        {
            var certificate = sslInfo?.X509Certificate;
            var fingerprint = certificate == null
                ? string.Empty
                : certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant();
            var allowed = App.BrowserSecurityGate?.IsCertificateTrusted(requestUrl, fingerprint) == true;
            if (!allowed)
            {
                App.BrowserSecurityGate?.ReportCertificateFailure(requestUrl, fingerprint, "TLS 证书校验失败: " + errorCode);
            }
            if (callback != null && !callback.IsDisposed) callback.Continue(allowed);
            return true;
        }
    }

    /// <summary>资源级请求处理器：写入标准 Chrome User-Agent。</summary>
    internal sealed class PanelResourceRequestHandler : ResourceRequestHandler
    {
        protected override CefReturnValue OnBeforeResourceLoad(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            IRequest request,
            IRequestCallback callback)
        {
            try
            {
                if (request != null && !request.IsReadOnly)
                {
                    request.SetHeaderByName("User-Agent", PanelRequestHandler.ChromeUserAgent, true);
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[PanelUA] User-Agent 覆盖失败: " + ex.Message);
            }
            return CefReturnValue.Continue;
        }
    }

    /// <summary>弹窗处理器：内置浏览器为单标签，window.open 原地导航。</summary>
    public sealed class PanelLifeSpanHandler : ILifeSpanHandler
    {
        private readonly PanelChromiumWebBrowser _browser;

        public PanelLifeSpanHandler(PanelChromiumWebBrowser browser)
        {
            _browser = browser ?? throw new ArgumentNullException(nameof(browser));
        }

        public bool OnBeforePopup(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            IFrame frame,
            string targetUrl,
            string targetFrameName,
            WindowOpenDisposition targetDisposition,
            bool userGesture,
            IPopupFeatures popupFeatures,
            IWindowInfo windowInfo,
            IBrowserSettings browserSettings,
            ref bool noJavascriptAccess,
            out IWebBrowser? newBrowser)
        {
            newBrowser = null;

            if (string.IsNullOrWhiteSpace(targetUrl) || targetUrl == "about:blank") return true;
            if (targetUrl.StartsWith("#", StringComparison.Ordinal)) return false;

            try
            {
                _browser.Dispatcher.BeginInvoke(new Action(() =>
                {
                    try { _browser.Load(targetUrl); }
                    catch (Exception ex) { Debug.WriteLine("[PanelPopup] 原地导航失败: " + ex.Message); }
                }));
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[PanelPopup] 调度失败: " + ex.Message);
            }
            return true;
        }

        public void OnAfterCreated(IWebBrowser chromiumWebBrowser, IBrowser browser) { }

        public bool DoClose(IWebBrowser chromiumWebBrowser, IBrowser browser) => false;

        public void OnBeforeClose(IWebBrowser chromiumWebBrowser, IBrowser browser) { }
    }

    /// <summary>
    /// JS 对话框处理器：外部 Chrome 链路上 Puppeteer 会自动关闭对话框，
    /// 这里保持同等语义（alert 关闭、confirm 取消、prompt 取消），
    /// beforeunload 则放行，避免自动化在导航时挂起。
    /// </summary>
    public sealed class PanelJsDialogHandler : JsDialogHandler
    {
        protected override bool OnJSDialog(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            string originUrl,
            CefJsDialogType dialogType,
            string messageText,
            string defaultPromptText,
            IJsDialogCallback callback,
            ref bool suppressMessage)
        {
            if (callback != null && !callback.IsDisposed) callback.Continue(false);
            return true;
        }

        protected override bool OnBeforeUnloadDialog(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            string messageText,
            bool isReload,
            IJsDialogCallback callback)
        {
            if (callback != null && !callback.IsDisposed) callback.Continue(true);
            return true;
        }
    }

    /// <summary>下载处理器：静默保存到 browser_automation.download_directory。</summary>
    public sealed class PanelDownloadHandler : IDownloadHandler
    {
        private readonly string _directory;

        public PanelDownloadHandler(string directory)
        {
            _directory = directory ?? string.Empty;
        }

        public bool CanDownload(IWebBrowser chromiumWebBrowser, IBrowser browser, string url, string requestMethod) => true;

        public bool OnBeforeDownload(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            DownloadItem downloadItem,
            IBeforeDownloadCallback callback)
        {
            if (callback == null || callback.IsDisposed) return true;

            var name = string.IsNullOrWhiteSpace(downloadItem?.SuggestedFileName)
                ? "download"
                : downloadItem!.SuggestedFileName;
            var path = name;
            if (!string.IsNullOrWhiteSpace(_directory))
            {
                try { Directory.CreateDirectory(_directory); } catch (Exception) { }
                path = Path.Combine(_directory, name);
            }

            try
            {
                callback.Continue(path, showDialog: false);
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[PanelDownload] 保存失败: " + ex.Message);
            }
            return true;
        }

        public void OnDownloadUpdated(
            IWebBrowser chromiumWebBrowser,
            IBrowser browser,
            DownloadItem downloadItem,
            IDownloadItemCallback callback)
        {
            // 静默下载：进度与完成状态由 list_downloads 从磁盘枚举。
        }
    }
}
