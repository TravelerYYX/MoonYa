// BrowserAutomationService — 基于 PuppeteerSharp 的浏览器操控引擎
// 独立于 CU 组件（不调用 ComputerUseService / UiAutomationService / Graphics.CopyFromScreen）
// 失败直接抛异常，不降级到坐标点击 / 键盘 / CU 兜底；不自动重试

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PuppeteerSharp;
using PuppeteerSharp.Input;

namespace MoonYa.Services
{
    /// <summary>浏览器自动化配置（由调用方从 launcher_config.json 的 browser_automation 段读取后注入）</summary>
    public class BrowserAutomationConfig
    {
        public string LoopbackHost { get; set; } = string.Empty;
        public int Port { get; set; }
        public System.Collections.Generic.List<string> TrustedDomains { get; set; } = new();
        public System.Collections.Generic.List<string> BlockedDomains { get; set; } = new();
        public string ChromiumExecutablePath { get; set; } = string.Empty;
        public System.Collections.Generic.List<string> ChromiumCandidatePaths { get; set; } = new();
        public bool Headless { get; set; } = false;
        public bool AutoDownloadChromium { get; set; }
        public int DefaultTimeoutMs { get; set; }
        public int ApprovalTimeoutMs { get; set; }
        public int ElementTimeoutMs { get; set; }
        public int ViewportWidth { get; set; }
        public int ViewportHeight { get; set; }
        public int ClickInitialDelayMs { get; set; }
        public int NetworkIdleTimeoutMs { get; set; }
        public int NetworkIdleTimeMs { get; set; }
        public int DomStableMaxWaitMs { get; set; }
        public int DomStableThresholdMs { get; set; }
        public int DomStablePollMs { get; set; }
        public int MutationStableMs { get; set; }
        public int MutationTimeoutMs { get; set; }
        public int FrameStableMs { get; set; }
        public int FrameStableMaxWaitMs { get; set; }
        public int FrameRetryCount { get; set; }
        public int FrameCollectionTimeoutMs { get; set; }
        public int OperationTimeoutMs { get; set; }
        public int BuiltinConnectRetryCount { get; set; }
        public int BuiltinConnectRetryDelayMs { get; set; }
        public int PerDocumentElementLimit { get; set; }
        public int MaxReturnedElements { get; set; }
        public int PageTextLimit { get; set; }
        public int DefaultWaitMs { get; set; }
        public int DefaultScrollAmount { get; set; }
        public int RelayTimeoutMs { get; set; }
        public int ShutdownTimeoutMs { get; set; }
        public int CleanupDelayMs { get; set; }
        public string DownloadDirectory { get; set; } = string.Empty;
        public string DiagnosticsFile { get; set; } = string.Empty;
        /// <summary>内置浏览器（右侧栏 CEF 面板）配置，缺省为未启用。</summary>
        public BuiltinBrowserOptions Builtin { get; set; } = new();
    }

    public class BrowserAutomationService : IDisposable
    {
        private readonly BrowserAutomationConfig _config;
        private readonly IBuiltinBrowserDiscovery? _builtin;
        private IBrowser? _browser;
        private IPage? _page;
        private bool _disposed;
        private bool _builtinSession;
        private long _pageVersion;
        private string _sessionId = Guid.NewGuid().ToString("N");
        public string BrowserName { get; }
        internal BrowserAutomationConfig Configuration => _config;
        private int _sessionGeneration;
        private bool _retired;
        private readonly Dictionary<string, (long Version, string Selector, string FrameUrl, string FrameName, string RuntimeId)> _elementRegistry = new(StringComparer.Ordinal);
        private int _launchedBrowserProcessId;

        public bool IsRunning => _browser != null && !_browser.IsClosed && _page != null;
        public string CurrentUrl => _page?.Url ?? string.Empty;
        public string SessionId => _sessionId;
        public long PageVersion => _pageVersion;
        public string CurrentTabId => IsRunning ? GetPageTargetId(_page) : string.Empty;
        public int DefaultWaitMs => _config.DefaultWaitMs;
        public int DefaultScrollAmount => _config.DefaultScrollAmount;
        public int OperationTimeoutMs => _config.OperationTimeoutMs;

        internal BrowserAutomationService CreateFresh() => new(_config, _builtin, BrowserName);

        internal async Task AbortAsync()
        {
            if (!_retired && BrowserName == "builtin") _builtin?.OnSessionStopped();
            _retired = true;
            _sessionGeneration++;
            var browser = _browser;
            var builtin = _builtinSession;
            _browser = null;
            _page = null;
            _sessionId = Guid.NewGuid().ToString("N");
            _pageVersion = 0;
            _elementRegistry.Clear();
            _builtinSession = false;
            await ReleaseBrowserAsync(browser, builtin);
        }

        /// <summary>Invalidate element ids after a successful state-changing public action.</summary>
        public void InvalidateObservation()
        {
            _pageVersion++;
            _elementRegistry.Clear();
        }

        /// <summary>Settle the page once before the explicit full inspection.</summary>
        public Task PrepareInspectionAsync(CancellationToken cancellationToken = default) =>
            WaitForPageSettledAsync(cancellationToken);

        // ★ 跨 frame 元素采集脚本：在主 document 和每个 iframe 内执行
        //   注意：不再遍历 iframe.contentDocument（同源限制），改为由 C# 端调用 page.Frames 分别执行
        private static readonly string CollectElementsJsTemplate = @"() => {
            const elements = [];
            const interactiveTags = new Set(['input', 'button', 'a', 'select', 'textarea', 'summary', 'option']);
            const interactiveRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox', 'textbox', 'slider', 'spinbutton', 'treeitem']);
            // ★ 判断元素是否可见
            function isVisible(el) {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const style = (el.ownerDocument && el.ownerDocument.defaultView)
                    ? el.ownerDocument.defaultView.getComputedStyle(el)
                    : window.getComputedStyle(el);
                return !(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
            }

            function isInteractive(el) {
                if (!el || !el.tagName) return false;
                const tag = el.tagName.toLowerCase();
                if (interactiveTags.has(tag)) return tag !== 'input' || (el.type || '').toLowerCase() !== 'hidden';
                if (tag === 'label' && el.htmlFor) return true;
                const role = (el.getAttribute('role') || '').toLowerCase();
                if (interactiveRoles.has(role)) return true;
                if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
                const tabindex = el.getAttribute('tabindex');
                if (tabindex !== null && Number(tabindex) >= 0) return true;
                if (typeof el.onclick === 'function' || el.hasAttribute('onclick')) return true;
                try { return window.getComputedStyle(el).cursor === 'pointer'; } catch (e) { return false; }
            }

            function isModalContainer(el) {
                if (!el || !el.matches) return false;
                const tag = (el.tagName || '').toLowerCase();
                if (tag === 'dialog' && (el.open || el.hasAttribute('open'))) return true;
                if ((el.getAttribute('role') || '').toLowerCase() === 'dialog') return true;
                if ((el.getAttribute('aria-modal') || '').toLowerCase() === 'true') return true;
                try { if (el.matches(':modal') || el.matches(':popover-open')) return true; } catch (e) { }
                return false;
            }

            // Determine modal ownership from platform semantics rather than vendor classes.
            function isInModal(el, doc) {
                let node = el;
                while (node && node !== doc.body) {
                    if (isModalContainer(node)) return true;
                    node = node.parentElement;
                }
                return false;
            }

            // ★ 过滤框架生成的动态 ID
            function isStableId(id) {
                if (!id) return false;
                if (/^\d+$/.test(id)) return false;
                if (id.length < 2) return false;
                if (id.length > 96) return false;
                if (/^[a-f0-9-]{24,}$/i.test(id)) return false;
                return true;
            }

            // ★ 生成 CSS 选择器：优先稳定可靠的属性
            function buildSelector(el) {
                const tagLower = el.tagName.toLowerCase();
                // 表单元素优先 name 属性
                if ((tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select') && el.name) {
                    return tagLower + '[name=""' + CSS.escape(el.name) + '""]';                }
                if (isStableId(el.id)) {
                    return '#' + CSS.escape(el.id);
                }
                if (el.name) {
                    return tagLower + '[name=""' + CSS.escape(el.name) + '""]';                }
                if (el.getAttribute('data-testid')) {
                    return '[data-testid=""' + CSS.escape(el.getAttribute('data-testid')) + '""]';                }
                if (el.placeholder && (tagLower === 'input' || tagLower === 'textarea')) {
                    return tagLower + '[placeholder=""' + CSS.escape(el.placeholder) + '""]';                }
                if (el.className && typeof el.className === 'string' && el.className.trim()) {
                    const classes = el.className.trim().split(/\s+/);
                    const meaningful = classes.filter(c =>
                        c.length >= 2 &&
                        c.length <= 64 &&
                        !/^\d+$/.test(c) &&
                        !/^[a-f0-9_-]{20,}$/i.test(c)
                    ).slice(0, 2);
                    if (meaningful.length > 0) {
                        return tagLower + meaningful.map(c => '.' + CSS.escape(c)).join('');
                    }
                }
                // ★ 兜底：用父元素+标签路径
                const parent = el.parentNode;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
                    if (siblings.length > 1) {
                        return tagLower + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
                    }
                }
                return tagLower;
            }

            // ★ 唯一性验证：生成 selector 后若 querySelectorAll().length > 1，
            //   逐级添加父元素路径 + :nth-of-type() 直到唯一（最多 5 级，避免选择器过长）
                // This prevents a non-unique selector from clicking the first sibling by accident.
            function makeUnique(el, baseSelector, doc) {
                try {
                    if (doc.querySelectorAll(baseSelector).length === 1) return baseSelector;
                } catch (e) { return baseSelector; }

                // First distinguish same-tag siblings, then add ancestor context.
                let effectiveBase = baseSelector;
                const selfParent = el.parentElement;
                if (selfParent) {
                    const selfSiblings = Array.from(selfParent.children).filter(s => s.tagName === el.tagName);
                    if (selfSiblings.length > 1) {
                        const selfIdx = selfSiblings.indexOf(el);
                        if (selfIdx >= 0) {
                            effectiveBase = baseSelector + ':nth-of-type(' + (selfIdx + 1) + ')';
                            try {
                                if (doc.querySelectorAll(effectiveBase).length === 1) return effectiveBase;
                            } catch (e) { /* nth-of-type 不适用，回退到原 base 继续加祖先 */ }
                        }
                    }
                }

                const parts = [effectiveBase];
                let node = el.parentElement;
                let depth = 0;
                const maxDepth = 5;

                while (node && depth < maxDepth) {
                    depth++;
                    const parentTag = node.tagName ? node.tagName.toLowerCase() : '';
                    if (!parentTag || parentTag === 'html' || parentTag === 'body') break;

                    // 父元素在同标签兄弟中的位置
                    const grandParent = node.parentElement;
                    let parentPart;
                    if (grandParent) {
                        const parentSiblings = Array.from(grandParent.children).filter(s => s.tagName === node.tagName);
                        const parentIdx = parentSiblings.indexOf(node);
                        if (parentSiblings.length > 1 && parentIdx >= 0) {
                            parentPart = parentTag + ':nth-of-type(' + (parentIdx + 1) + ')';
                        } else {
                            parentPart = parentTag;
                        }
                    } else {
                        parentPart = parentTag;
                    }

                    parts.unshift(parentPart);
                    const candidate = parts.join(' > ');
                    try {
                        if (doc.querySelectorAll(candidate).length === 1) return candidate;
                    } catch (e) { break; }
                    node = node.parentElement;
                }
                // 仍未唯一，返回最深路径（比原 base 更精确）
                return parts.join(' > ');
            }

            function collectFromDoc(doc) {
                const nodes = Array.from(doc.querySelectorAll('*')).filter(isInteractive);
                // ★ 两遍收集：先弹窗内元素，后弹窗外元素
                const modalEls = [];
                const otherEls = [];
                nodes.forEach((el) => {
                    if (!isVisible(el)) return;
                    if (isInModal(el, doc)) {
                        modalEls.push(el);
                    } else {
                        otherEls.push(el);
                    }
                });

                // 处理单个元素
                function processEl(el) {
                    if (elements.length >= __ELEMENT_LIMIT__) return;
                    const rect = el.getBoundingClientRect();
                    const tagLower = el.tagName.toLowerCase();
                    let runtimeId = el.getAttribute('data-moonya-runtime-id');
                    if (!runtimeId) {
                        window.__moonyaRuntimeElementCounter = (window.__moonyaRuntimeElementCounter || 0) + 1;
                        runtimeId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
                            ? globalThis.crypto.randomUUID()
                            : [Date.now(), Math.random(), window.__moonyaRuntimeElementCounter].join('-');
                        el.setAttribute('data-moonya-runtime-id', runtimeId);
                    }
                    let cssSelector = buildSelector(el);

                    // ★ 对 <a> 标签，用 pathname 关键词增强选择器
                    if (tagLower === 'a' && el.href && el.href !== '#' && !el.href.startsWith('javascript:')) {
                        try {
                            var hrefPath = new URL(el.href).pathname;
                            var seg = hrefPath.split('/').filter(function(s) { return s.length >= 2; })[0];
                            if (seg) {
                                cssSelector += '[href*=""' + seg + '""]';
                            }
                        } catch (e) { }
                    }

                    // Verify uniqueness in the current document before exposing the selector.
                    cssSelector = makeUnique(el, cssSelector, doc);

                    // ★ 提取元素文本：优先 innerText，回退到 value/placeholder/aria-label/title/关联 label
                    let text = '';
                    if (el.innerText && el.innerText.trim()) {
                        text = el.innerText.trim();
                    } else if (el.textContent && el.textContent.trim()) {
                        text = el.textContent.trim();
                    } else {
                        text = (el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim();
                    }
                    // 如果是输入框且没有文本，尝试找关联 label
                    if (!text && (tagLower === 'input' || tagLower === 'textarea' || tagLower === 'select')) {
                        // aria-labelledby
                        const labelledBy = el.getAttribute('aria-labelledby');
                        if (labelledBy) {
                            const labelEl = doc.getElementById(labelledBy);
                            if (labelEl) text = (labelEl.innerText || labelEl.textContent || '').trim();
                        }
                        // 找 for=id 的 label
                        if (!text && el.id) {
                            const labels = doc.querySelectorAll('label[for=""' + CSS.escape(el.id) + '""]');
                            if (labels.length > 0) text = (labels[0].innerText || labels[0].textContent || '').trim();
                        }
                        // 找相邻 label
                        if (!text) {
                            const prevLabel = el.parentElement && el.parentElement.tagName.toLowerCase() === 'label' ? el.parentElement : null;
                            if (prevLabel) text = (prevLabel.innerText || prevLabel.textContent || '').trim();
                        }
                    }

                    elements.push({
                        tag: tagLower,
                        type: el.type || '',
                        role: el.getAttribute('role') || '',
                        accessible_name: el.getAttribute('aria-label') || text,
                        runtime_id: runtimeId,
                        css_selector: cssSelector,
                        text: text.slice(0, 120),
                        name: el.name || '',
                        id: el.id || '',
                        placeholder: el.placeholder || '',
                        href: el.href || '',
                        value: (el.value || '').toString().slice(0, 80),
                        position: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                        disabled: el.disabled || false,
                        checked: typeof el.checked === 'boolean' ? el.checked : null,
                        selected: typeof el.selected === 'boolean' ? el.selected : null,
                        focused: doc.activeElement === el,
                        visible: true,
                        in_modal: isInModal(el, doc),
                        in_iframe: false
                    });
                }
                // 先处理弹窗内元素（确保不被数量限制截断）
                modalEls.forEach(processEl);
                // 再处理弹窗外元素
                otherEls.forEach(processEl);
            }

            // 主文档
            collectFromDoc(document);

            // 穿透 shadow DOM
            try {
                function walkShadow(node) {
                    if (!node || !node.querySelectorAll) return;
                    node.querySelectorAll('*').forEach((el) => {
                        if (el.shadowRoot) {
                            try {
                                collectFromDoc(el.shadowRoot);
                                walkShadow(el.shadowRoot);
                            } catch (e) { }
                        }
                    });
                }
                walkShadow(document);
            } catch (e) { }

            // ★ 兜底：从主文档 JS 直接访问同源 iframe 的 contentDocument
            //    C# 端虽有 _page.Frames 遍历，但某些场景下 iframe 可能不在 Frames 集合中
            //    或 frames 遍历时 iframe 内容尚未就绪。此处作为兜底，确保同源 iframe 内元素必被捕获
            try {
                var iframes = document.querySelectorAll('iframe, frame');
                iframes.forEach(function(ifr) {
                    try {
                        var ifrDoc = ifr.contentDocument || (ifr.contentWindow ? ifr.contentWindow.document : null);
                        if (ifrDoc && ifrDoc !== document && ifrDoc.body && ifrDoc.body.querySelectorAll) {
                            collectFromDoc(ifrDoc);
                        }
                    } catch (e) { }
                });
            } catch (e) { }

            // 提取全页面可见文本
            const pageText = (function() {
                try {
                    const body = document.body;
                    if (!body) return '';
                    const results = [];
                    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
                        acceptNode: function(node) {
                            if (!node.parentElement) return NodeFilter.FILTER_REJECT;
                            const tag = node.parentElement.tagName || '';
                            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG' || tag === 'IFRAME') return NodeFilter.FILTER_REJECT;
                            const style = window.getComputedStyle(node.parentElement);
                            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                            const text = node.textContent.trim();
                            if (!text) return NodeFilter.FILTER_REJECT;
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    }, false);
                    let node;
                    while ((node = walker.nextNode())) {
                        const t = node.textContent.trim();
                        if (t) results.push(t);
                    }
                    const unique = [];
                    for (const r of results) {
                        if (unique.length === 0 || r !== unique[unique.length - 1]) unique.push(r);
                    }
                    return unique.join(' ').replace(/\s{2,}/g, ' ').slice(0, __PAGE_TEXT_LIMIT__);
                } catch (e) { return ''; }
            })();

            return JSON.stringify({elements: elements, page_text: pageText});
        }";

        private readonly string _collectElementsJs;

        // Standards-based visible interactive element check used for frame readiness.
        private static readonly string VisibleInteractiveCheckJs = @"() => {
            const tags = new Set(['input','button','textarea','select','a','summary','option']);
            const roles = new Set(['button','link','checkbox','radio','switch','tab','menuitem','option','combobox','textbox','slider','spinbutton','treeitem']);
            return Array.from(document.querySelectorAll('*')).some(function(el){
                const tag = (el.tagName || '').toLowerCase();
                const role = (el.getAttribute('role') || '').toLowerCase();
                const tabindex = el.getAttribute('tabindex');
                const interactive = tags.has(tag) || roles.has(role) || el.isContentEditable ||
                    (tabindex !== null && Number(tabindex) >= 0) || typeof el.onclick === 'function' ||
                    el.hasAttribute('onclick') || getComputedStyle(el).cursor === 'pointer';
                if (!interactive || (tag === 'input' && (el.type || '').toLowerCase() === 'hidden')) return false;
                var rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                var cs = getComputedStyle(el);
                return cs.display !== 'none' && cs.visibility !== 'hidden';
            });
        }";

        public BrowserAutomationService(BrowserAutomationConfig config, IBuiltinBrowserDiscovery? builtin = null, string browser = "builtin")
        {
            if (browser is not ("builtin" or "chrome" or "edge")) throw new ArgumentException("未知浏览器", nameof(browser));
            BrowserName = browser;
            _config = config ?? throw new ArgumentNullException(nameof(config));
            _builtin = builtin;
            ValidateConfig(_config);
            _collectElementsJs = CollectElementsJsTemplate
                .Replace("__ELEMENT_LIMIT__", _config.PerDocumentElementLimit.ToString(System.Globalization.CultureInfo.InvariantCulture))
                .Replace("__PAGE_TEXT_LIMIT__", _config.PageTextLimit.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        // Each backend owns its session. No implicit external fallback.
        public async Task<bool> StartAsync(string url, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_retired) throw new InvalidOperationException("浏览器会话已取消，请使用新会话");
            if (IsRunning)
            {
                if (!string.IsNullOrWhiteSpace(url)) await NavigateAsync(url, cancellationToken);
                return true;
            }
            var generation = _sessionGeneration;
            var timer = Stopwatch.StartNew();
            try
            {
                if (BrowserName == "builtin")
                {
                    if (_config.Headless || _builtin?.Enabled != true)
                        throw new InvalidOperationException("内置浏览器不可用，请检查内置浏览器设置");
                    await ConnectBuiltinAsync(url, generation, cancellationToken);
                }
                else
                {
                    var executable = ResolveBrowserExecutablePath();
                    if (string.IsNullOrWhiteSpace(executable))
                        throw new InvalidOperationException("未安装或未找到 " + (BrowserName == "chrome" ? "Google Chrome" : "Microsoft Edge"));
                    await LaunchExternalAsync(url, executable, generation, cancellationToken);
                }
                LogStage("start", timer.ElapsedMilliseconds, "ready");
                return true;
            }
            catch (OperationCanceledException)
            {
                LogStage("start", timer.ElapsedMilliseconds, "cancelled");
                throw;
            }
            catch (TimeoutException error)
            {
                LogStage("start", timer.ElapsedMilliseconds, error.Message);
                throw;
            }
            catch (Exception error)
            {
                LogStage("start", timer.ElapsedMilliseconds, error.Message);
                throw new InvalidOperationException(BrowserProtocol.Errors.BrowserLaunchFailed + ": " + error.Message, error);
            }
        }

        internal void LogStage(string stage, long elapsedMs, string result)
        {
            try
            {
                var file = ResolveConfiguredPath(_config.DiagnosticsFile);
                if (string.IsNullOrWhiteSpace(file)) return;
                Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                lock (_config) File.AppendAllText(file, $"[{DateTimeOffset.Now:O}] browser={BrowserName} session={_sessionId} stage={stage} elapsed_ms={elapsedMs} {result.Replace("\n", " ").Replace("\r", " ")}\n");
            }
            catch (Exception) { }
        }

        // Puppeteer does not accept cancellation for every CDP operation. Dispose
        // a connection that completes after cancellation, without publishing it.
        private static async Task<IBrowser> AcquireBrowserAsync(Task<IBrowser> pending, bool builtin, CancellationToken token)
        {
            try { return await pending.WaitAsync(token); }
            catch
            {
                _ = pending.ContinueWith(async completed =>
                {
                    if (completed.IsCompletedSuccessfully) await ReleaseBrowserAsync(completed.Result, builtin);
                    else _ = completed.Exception;
                }, TaskScheduler.Default).Unwrap();
                throw;
            }
        }

        private static async Task ReleaseBrowserAsync(IBrowser? browser, bool builtin)
        {
            if (browser == null) return;
            if (builtin) { try { browser.Disconnect(); } catch { } return; }
            var process = browser.Process;
            try { await browser.CloseAsync().WaitAsync(TimeSpan.FromSeconds(2)); } catch { }
            try { browser.Dispose(); } catch { }
            try { if (process != null && !process.HasExited) process.Kill(entireProcessTree: true); } catch { }
        }

        private async Task PublishSessionAsync(IBrowser browser, IPage page, bool builtin, string url, int generation, CancellationToken token)
        {
            page.DefaultTimeout = _config.DefaultTimeoutMs;
            page.DefaultNavigationTimeout = _config.DefaultTimeoutMs;
            var downloads = ResolveConfiguredPath(_config.DownloadDirectory);
            if (!string.IsNullOrWhiteSpace(downloads))
            {
                Directory.CreateDirectory(downloads);
                try
                {
                    var session = await page.CreateCDPSessionAsync().WaitAsync(token);
                    await session.SendAsync("Browser.setDownloadBehavior", new { behavior = "allow", downloadPath = downloads, eventsEnabled = true }).WaitAsync(token);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception error) { LogStage("downloads", 0, error.Message); }
            }
            if (!string.IsNullOrWhiteSpace(url))
            {
                var timer = Stopwatch.StartNew();
                try
                {
                    await page.GoToAsync(url, new NavigationOptions { Timeout = _config.DefaultTimeoutMs,
                        ReferrerPolicy = BrowserProtocol.NavigationReferrerPolicy, WaitUntil = new[] { WaitUntilNavigation.Load } }).WaitAsync(token);
                    LogStage("navigation", timer.ElapsedMilliseconds, "ready");
                }
                catch (Exception error) { LogStage("navigation", timer.ElapsedMilliseconds, error.Message); throw; }
            }
            token.ThrowIfCancellationRequested();
            if (generation != _sessionGeneration) throw new OperationCanceledException("浏览器会话已更新");
            _browser = browser;
            _page = page;
            _builtinSession = builtin;
            _launchedBrowserProcessId = builtin ? 0 : browser.Process?.Id ?? 0;
            _elementRegistry.Clear();
        }

        // 启动外部 Chromium/Chrome（改造前的既有链路，行为保持一致）
        private async Task LaunchExternalAsync(string url, string executablePath, int generation, CancellationToken token)
        {
            IBrowser? browser = null;
            var timer = Stopwatch.StartNew();
            try
            {
                browser = await AcquireBrowserAsync(Puppeteer.LaunchAsync(new LaunchOptions
                {
                    ExecutablePath = executablePath, Headless = _config.Headless, AcceptInsecureCerts = false,
                    // Keep Edge in the owned process instead of its compatibility
                    // relaunch, which exits the launcher before CDP is ready.
                    Args = BrowserName == "edge" ? new[] { "--edge-skip-compat-layer-relaunch" } : Array.Empty<string>(),
                    Timeout = _config.Builtin.ConnectTimeoutMs, ProtocolTimeout = _config.DefaultTimeoutMs,
                    DefaultViewport = new ViewPortOptions { Width = _config.ViewportWidth, Height = _config.ViewportHeight },
                }), false, token);
                LogStage("external-launch", timer.ElapsedMilliseconds, "connected");
                var pages = await browser.PagesAsync().WaitAsync(token);
                var page = pages.FirstOrDefault() ?? await browser.NewPageAsync().WaitAsync(token);
                await PublishSessionAsync(browser, page, false, url, generation, token);
            }
            catch { await ReleaseBrowserAsync(browser, false); throw; }
        }

        // ── 内置浏览器（右侧栏 CEF 面板）────────────────────

        /// <summary>
        /// 请求宿主创建面板并返回 target id，通过浏览器级 CDP 连接只选择该面板。
        /// 面板发现和连接共享连接期限；导航继续受操作总期限约束。
        /// </summary>
        private async Task ConnectBuiltinAsync(string url, int generation, CancellationToken token)
        {
            var discovery = _builtin!;
            discovery.OnSessionStarted();
            IBrowser? browser = null;
            var timer = Stopwatch.StartNew();
            var stage = "panel-discovery";
            var stageTimer = Stopwatch.StartNew();
            try
            {
                using var connection = CancellationTokenSource.CreateLinkedTokenSource(token);
                connection.CancelAfter(_config.Builtin.ConnectTimeoutMs);
                BuiltinPanelTarget? target = null;
                Exception? lastError = null;
                for (var attempt = 1; attempt <= _config.BuiltinConnectRetryCount; attempt++)
                {
                    connection.Token.ThrowIfCancellationRequested();
                    try
                    {
                        target = await discovery.EnsurePanelAsync(null, true, _config.Builtin.ConnectTimeoutMs, connection.Token).WaitAsync(connection.Token);
                        if (target == null) throw new InvalidOperationException("内置浏览器面板未就绪");
                        break;
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception error)
                    {
                        lastError = error;
                        if (attempt < _config.BuiltinConnectRetryCount)
                            await Task.Delay(_config.BuiltinConnectRetryDelayMs * attempt, connection.Token);
                    }
                }
                if (target == null) throw lastError ?? new InvalidOperationException("内置浏览器面板未就绪");
                LogStage(stage, stageTimer.ElapsedMilliseconds, target.Describe());
                stage = "cdp-connect";
                stageTimer.Restart();
                (browser, var page) = await ConnectViaBrowserEndpointAsync(target, connection.Token);
                LogStage(stage, stageTimer.ElapsedMilliseconds, "connected");
                stage = "session-setup";
                stageTimer.Restart();
                await PublishSessionAsync(browser, page, true, url, generation, token);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                LogStage(stage, stageTimer.ElapsedMilliseconds, "connection deadline exceeded; endpoint="
                    + BuiltinBrowserConnection.DebuggingAddress(discovery.RemoteDebuggingPort) + "; " + discovery.DiscoveryStatus);
                await ReleaseBrowserAsync(browser, true);
                if (!_retired) discovery.OnSessionStopped();
                throw new TimeoutException("内置浏览器 " + stage + " 超过连接期限（" + _config.Builtin.ConnectTimeoutMs + "ms）；"
                    + "端点=" + BuiltinBrowserConnection.DebuggingAddress(discovery.RemoteDebuggingPort)
                    + (string.IsNullOrWhiteSpace(discovery.DiscoveryStatus) ? string.Empty : "；" + discovery.DiscoveryStatus));
            }
            catch (Exception error)
            {
                LogStage(stage, stageTimer.ElapsedMilliseconds, DescribeException(error));
                await ReleaseBrowserAsync(browser, true);
                if (!_retired) discovery.OnSessionStopped();
                throw;
            }
        }

        // 连接 CEF 的浏览器级 CDP 端点，并按 target id / window.name / 地址多路信号选中面板页面。
        //
        // 为什么不用页面级端点：PuppeteerSharp 建连时会调用 Target.getBrowserContexts 等
        // 浏览器域命令，而 CEF 在页面会话里拒绝浏览器域命令（"Protocol error
        // (Target.getBrowserContexts): Not allowed"），页面级端点无法用于 puppeteer 连接。
        private async Task<(IBrowser Browser, IPage Page)> ConnectViaBrowserEndpointAsync(BuiltinPanelTarget? target, CancellationToken token)
        {
            var port = _builtin!.RemoteDebuggingPort;
            var browserUrl = BuiltinBrowserConnection.DebuggingAddress(port);

            IBrowser browser;
            try
            {
                var browserEndpoint = await BuiltinBrowserConnection.ReadBrowserWebSocketAsync(port, token);
                browser = await AcquireBrowserAsync(Puppeteer.ConnectAsync(new ConnectOptions
                {
                    BrowserWSEndpoint = browserEndpoint,
                    DefaultViewport = null,
                    ProtocolTimeout = _config.Builtin.ConnectTimeoutMs,
                    TargetFilter = targetInfo => string.IsNullOrWhiteSpace(target?.TargetId) || targetInfo.TargetId == target.TargetId,
                }), true, token);
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "连接内置浏览器调试端点失败 (" + browserUrl + "): " + DescribeException(ex), ex);
            }

            try
            {
                var probe = await FindPanelPageAsync(browser, target).WaitAsync(token);
                if (probe.Page == null)
                {
                    throw new InvalidOperationException(
                        "未在 CDP 目标中找到面板页面（面板 " + (target?.Describe() ?? "不可用")
                        + "；已探测: " + (string.IsNullOrWhiteSpace(probe.Summary) ? "无" : probe.Summary) + "）");
                }
                await VerifyPanelPageAsync(probe.Page).WaitAsync(token);
                return (browser, probe.Page);
            }
            catch (Exception)
            {
                // 连接模式：Disconnect（绝不 Dispose，避免 Browser.close 关掉宿主浏览器）
                try { browser.Disconnect(); } catch (Exception) { }
                throw;
            }
        }

        // 遍历 CDP 页面目标并按多路信号匹配面板页面，同时返回探测摘要用于诊断
        private static async Task<(IPage? Page, string Summary)> FindPanelPageAsync(IBrowser browser, BuiltinPanelTarget? target)
        {
            var pages = await browser.PagesAsync();
            if (pages == null || pages.Length == 0)
            {
                return (null, "无页面目标");
            }

            if (!string.IsNullOrWhiteSpace(target?.TargetId))
            {
                var exact = pages.FirstOrDefault(page => GetPageTargetId(page) == target.TargetId);
                return (exact, exact == null ? "面板 target 未出现: " + target.TargetId : target.TargetId);
            }
            var probes = new List<BuiltinTargetProbe>();
            var summary = new List<string>();
            foreach (var page in pages)
            {
                var probe = new BuiltinTargetProbe
                {
                    TargetId = GetPageTargetId(page),
                    Address = page.Url ?? string.Empty,
                };
                try
                {
                    // window.name 由宿主在每次加载完成后写入，跨导航保留且 CDP 可见
                    probe.WindowName = await page.EvaluateExpressionAsync<string>("window.name") ?? string.Empty;
                }
                catch (Exception ex)
                {
                    probe.WindowName = "<err:" + ex.GetType().Name + ">";
                }
                probes.Add(probe);
                summary.Add("[" + probe.TargetId + " name=" + probe.WindowName + " url=" + probe.Address + "]");
            }

            var summaryText = string.Join(" ", summary);
            var index = BuiltinTargetMatcher.FindPanelIndex(probes, target);
            return (index >= 0 && index < pages.Length ? pages[index] : null, summaryText);
        }

        // 把异常链拼成可读文本（CDP 连接失败的原因常在内层异常里）
        private static string DescribeException(Exception error)
        {
            var messages = new List<string>();
            for (var current = error; current != null && messages.Count < 4; current = current.InnerException)
            {
                messages.Add(current.GetType().Name + ": " + current.Message);
            }
            return string.Join(" <- ", messages);
        }

        /// <summary>
        /// 取页面的 CDP target id（标签页 API、内置浏览器单标签语义、状态上报都依赖它）。
        /// PuppeteerSharp 20 将 <c>IPage.Target</c> 标记为过时，但 target id 仍只能由 Target 取得，
        /// 因此集中在此处取用并局部抑制过时警告，避免警告散落到各调用点。
        /// </summary>
        private static string GetPageTargetId(IPage? page)
        {
#pragma warning disable CS0618 // IPage.Target 已过时（PuppeteerSharp 20）
            return page?.Target?.TargetId ?? string.Empty;
#pragma warning restore CS0618
        }

        // 连接后必须能在页面里执行脚本才算可用，避免驱动到不可用目标
        private static async Task VerifyPanelPageAsync(IPage page)
        {
            var probe = await page.EvaluateExpressionAsync<int>("1");
            if (probe != 1)
            {
                throw new InvalidOperationException("内置浏览器页面无法执行脚本");
            }
        }

        public async Task BackAsync()
        {
            EnsureStarted();
            await _page!.GoBackAsync(new NavigationOptions { Timeout = _config.DefaultTimeoutMs, WaitUntil = new[] { WaitUntilNavigation.Load } });
        }

        public async Task ForwardAsync()
        {
            EnsureStarted();
            await _page!.GoForwardAsync(new NavigationOptions { Timeout = _config.DefaultTimeoutMs, WaitUntil = new[] { WaitUntilNavigation.Load } });
        }

        public async Task ReloadAsync()
        {
            EnsureStarted();
            await _page!.ReloadAsync(new NavigationOptions { Timeout = _config.DefaultTimeoutMs, WaitUntil = new[] { WaitUntilNavigation.Load } });
        }

        // 导航到新 url（超时由 default_timeout_ms 控制）
        public async Task<bool> NavigateAsync(string url, CancellationToken cancellationToken = default)
        {
            if (!IsRunning) return await StartAsync(url, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            await _page!.GoToAsync(url, new NavigationOptions
            {
                Timeout = _config.DefaultTimeoutMs,
                ReferrerPolicy = BrowserProtocol.NavigationReferrerPolicy,
                WaitUntil = new[] { WaitUntilNavigation.Load },
            }).WaitAsync(cancellationToken);
            return true;
        }

        // 点击 CSS 选择器元素；元素未找到抛 InvalidOperationException
        public async Task ClickAsync(string selector)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            await RunPointerActionAsync(element, () => element.ClickAsync());
            // Let the event and the first render mutation run. Full settling and
            // frame discovery belong to the following explicit inspect call.
            await Task.WhenAll(
                Task.Delay(_config.ClickInitialDelayMs),
                WaitForDomStableMutationAsync());
        }

        // Fill native form controls and contenteditable targets, then emit standard events.
        public async Task FillAsync(string selector, string text)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            await RunPointerActionAsync(element, async () =>
            {
                await element.FocusAsync();

                await element.EvaluateFunctionAsync(@"(el, val) => {
                    if (el.isContentEditable) {
                        el.textContent = val;
                    } else {
                        const prototype = Object.getPrototypeOf(el);
                        const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
                        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, val);
                        else el.value = val;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }", text ?? string.Empty);
            });
        }

        public async Task HoverAsync(string selector)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            await RunPointerActionAsync(element, () => element.HoverAsync());
            await WaitForDomStableMutationAsync();
        }

        public async Task PressAsync(string? selector, string key)
        {
            EnsureStarted();
            if (!string.IsNullOrWhiteSpace(selector))
            {
                var element = await WaitForSelectorSafe(selector);
                await element.PressAsync(key);
            }
            else
            {
                await _page!.Keyboard.PressAsync(key);
            }
            await WaitForDomStableMutationAsync();
        }

        public async Task<string[]> SelectAsync(string selector, string[] values)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            var selected = await RunPointerActionAsync(element, () => element.SelectAsync(values ?? Array.Empty<string>()));
            await WaitForDomStableMutationAsync();
            return selected;
        }

        public async Task SetCheckedAsync(string selector, bool isChecked)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            var current = await element.EvaluateFunctionAsync<bool>("el => !!el.checked");
            if (current != isChecked)
            {
                await RunPointerActionAsync(element, () => element.ClickAsync());
                await WaitForDomStableMutationAsync();
            }
        }

        private async Task RunPointerActionAsync(IElementHandle element, Func<Task> action)
        {
            await RunPointerActionAsync(element, async () => { await action(); return true; });
        }

        private async Task<T> RunPointerActionAsync<T>(IElementHandle element, Func<Task<T>> action)
        {
            if (!_builtinSession || _builtin == null) return await action();
            var generation = _sessionGeneration;
            var page = _page!;
            var pointer = await _builtin.BeginPointerOperationAsync();
            try
            {
                CheckPointerSession();
                await element.ScrollIntoViewAsync();
                var point = await element.ClickablePointAsync();
                var viewport = await page.EvaluateFunctionAsync<double[]>("() => [innerWidth, innerHeight]");
                var width = Math.Max(1, viewport[0]);
                var height = Math.Max(1, viewport[1]);
                var startX = (pointer?.X ?? 0.5) * width;
                var startY = (pointer?.Y ?? 0.5) * height;
                var timer = Stopwatch.StartNew();
                const int steps = 10;
                for (var step = 1; step <= steps; step++)
                {
                    CheckPointerSession();
                    var t = (double)step / steps;
                    var x = startX + ((double)point.X - startX) * t;
                    var y = startY + ((double)point.Y - startY) * t;
                    if (pointer != null && !await _builtin.UpdatePointerAsync(pointer.Epoch, x / width, y / height))
                        throw new OperationCanceledException("浏览器标签已切换或关闭");
                    await page.Mouse.MoveAsync((decimal)x, (decimal)y);
                    var remaining = step * 160 / steps - (int)timer.ElapsedMilliseconds;
                    if (remaining > 0) await Task.Delay(remaining);
                }
                CheckPointerSession();
                // A hover can change layout. Use the fresh operation point for the final frame.
                point = await element.ClickablePointAsync();
                if (pointer != null && !await _builtin.UpdatePointerAsync(pointer.Epoch, (double)point.X / width, (double)point.Y / height))
                    throw new OperationCanceledException("浏览器标签已切换或关闭");
                await page.Mouse.MoveAsync(point.X, point.Y);
                CheckPointerSession();
                return await action();
            }
            finally
            {
                if (pointer != null) await _builtin.EndPointerOperationAsync(pointer.Epoch);
            }

            void CheckPointerSession()
            {
                if (_retired || generation != _sessionGeneration || !ReferenceEquals(page, _page))
                    throw new OperationCanceledException("浏览器会话已取消");
            }
        }

        // 核心方法：仅截视口（FullPage=false），返回 base64 字符串供调用方包装为 data URL
        public async Task<string> ScreenshotBase64Async()
        {
            EnsureStarted();
            var bytes = await CaptureScreenshotBytesAsync();
            return Convert.ToBase64String(bytes);
        }

        // 截图：优先走 CDP（与外部 Chrome 完全同一条路径）；
        // 内置浏览器在 CEF OSR 下若 CDP 截图不可用，退回面板最近一帧 OSR 位图编码的 PNG。
        private async Task<byte[]> CaptureScreenshotBytesAsync()
        {
            Exception? cdpError = null;
            try
            {
                // PuppeteerSharp 20.0 中 ScreenshotAsync 仅支持写入文件路径；如需 byte[] 须改用 ScreenshotDataAsync
                var bytes = await _page!.ScreenshotDataAsync(new ScreenshotOptions
                {
                    Type = ScreenshotType.Png,
                    FullPage = false,
                });
                if (bytes != null && bytes.Length > 0) return bytes;
            }
            catch (Exception ex)
            {
                cdpError = ex;
                if (!_builtinSession) throw;
                Debug.WriteLine("CDP screenshot failed in builtin mode: " + ex.Message);
            }

            if (_builtinSession && _builtin != null)
            {
                var frame = await _builtin.CapturePanelScreenshotAsync(Math.Max(1500, _config.ElementTimeoutMs));
                if (frame != null && frame.Length > 0) return frame;
            }

            throw new InvalidOperationException(
                "screenshot_unavailable: 内置浏览器截图失败"
                + (cdpError != null ? "（CDP: " + cdpError.Message + "）" : "（CDP 返回空帧）"),
                cdpError);
        }

        // 通过 window.scrollBy 实现 up/down 滚动，避免依赖元素滚动 API
        public async Task ScrollAsync(string direction, int amount)
        {
            EnsureStarted();
            var dir = (direction ?? string.Empty).ToLowerInvariant();
            int dy = dir == "up" ? -Math.Abs(amount) : Math.Abs(amount);
            await _page!.EvaluateExpressionAsync($"window.scrollBy(0, {dy})");
            await WaitForDomStableMutationAsync();
        }

        public async Task WaitForConditionAsync(string condition, int ms, string? selector, string? text, string? url, string? state)
        {
            EnsureStarted();
            var normalized = (condition ?? string.Empty).Trim().ToLowerInvariant();
            if (normalized == "time" || normalized == "delay" || normalized == string.Empty)
            {
                await WaitAsync(ms);
                return;
            }
            if (normalized == "dom_stable")
            {
                await WaitForDomStableMutationAsync();
                await WaitForDomStableAsync();
                return;
            }
            if (normalized == "navigation")
            {
                await WaitForPageSettledAsync();
                return;
            }
            if (normalized == "element")
            {
                if (string.IsNullOrWhiteSpace(selector)) throw new ArgumentException("等待元素时缺少目标");
                var hidden = string.Equals(state, "hidden", StringComparison.OrdinalIgnoreCase);
                if (!hidden)
                {
                    await WaitForSelectorSafe(selector, ms);
                    return;
                }

                var hiddenDeadline = DateTime.UtcNow.AddMilliseconds(ms);
                while (DateTime.UtcNow < hiddenDeadline)
                {
                    try
                    {
                        await WaitForSelectorSafe(selector, Math.Min(_config.DomStablePollMs, 250));
                    }
                    catch (InvalidOperationException)
                    {
                        return;
                    }
                    await Task.Delay(_config.DomStablePollMs);
                }
                throw new TimeoutException("等待元素隐藏超时");
            }

            var deadline = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < deadline)
            {
                if (normalized == "text" && !string.IsNullOrEmpty(text))
                {
                    var content = await _page!.EvaluateExpressionAsync<string>("document.body ? document.body.innerText : ''");
                    if ((content ?? string.Empty).Contains(text, StringComparison.Ordinal)) return;
                }
                else if (normalized == "url" && !string.IsNullOrEmpty(url) && (_page!.Url ?? string.Empty).Contains(url, StringComparison.Ordinal))
                {
                    return;
                }
                await Task.Delay(_config.DomStablePollMs);
            }
            throw new TimeoutException($"等待条件 {normalized} 超时");
        }

        public async Task<object[]> ListTabsAsync()
        {
            EnsureStarted();
            if (_builtinSession)
            {
                var title = string.Empty;
                try { title = await _page!.GetTitleAsync(); } catch (Exception) { }
                return new object[]
                {
                    new
                    {
                        tab_id = GetPageTargetId(_page),
                        url = _page!.Url ?? string.Empty,
                        title,
                        active = true,
                    },
                };
            }
            var pages = await _browser!.PagesAsync();
            var tabs = new List<object>();
            foreach (var page in pages)
            {
                var title = string.Empty;
                try { title = await page.GetTitleAsync(); } catch (Exception) { }
                tabs.Add(new
                {
                    tab_id = GetPageTargetId(page),
                    url = page.Url ?? string.Empty,
                    title,
                    active = ReferenceEquals(page, _page),
                });
            }
            return tabs.ToArray();
        }

        public async Task<string> NewTabAsync(string? url)
        {
            EnsureStarted();
            if (_builtinSession)
            {
                // 内置浏览器为单标签：CEF 不支持 CDP Target.createTarget，
                // new_tab 语义退化为"在当前标签打开"，返回的 tab_id 保持不变。
                if (!string.IsNullOrWhiteSpace(url)) await NavigateAsync(url);
                return GetPageTargetId(_page);
            }
            var page = await _browser!.NewPageAsync();
            page.DefaultTimeout = _config.DefaultTimeoutMs;
            page.DefaultNavigationTimeout = _config.DefaultTimeoutMs;
            _page = page;
            if (!string.IsNullOrWhiteSpace(url)) await NavigateAsync(url);
            return GetPageTargetId(page);
        }

        public async Task SwitchTabAsync(string tabId)
        {
            EnsureStarted();
            if (_builtinSession)
            {
                if (string.Equals(tabId, GetPageTargetId(_page), StringComparison.Ordinal)) return;
                throw new InvalidOperationException(BrowserProtocol.Errors.ElementNotFound + ": 标签页不存在（内置浏览器为单标签）");
            }
            var pages = await _browser!.PagesAsync();
            var target = pages.FirstOrDefault(page => string.Equals(GetPageTargetId(page), tabId, StringComparison.Ordinal));
            if (target == null) throw new InvalidOperationException("element_not_found: 标签页不存在");
            _page = target;
            await _page.BringToFrontAsync();
            _elementRegistry.Clear();
        }

        public async Task CloseTabAsync(string? tabId)
        {
            EnsureStarted();
            if (_builtinSession)
            {
                _builtin?.ResetVisuals();
                var currentBuiltinTabId = GetPageTargetId(_page);
                if (!string.IsNullOrWhiteSpace(tabId)
                    && !string.Equals(tabId, currentBuiltinTabId, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(BrowserProtocol.Errors.ElementNotFound + ": 标签页不存在（内置浏览器为单标签）");
                }
                // 关闭当前标签 == 回到新标签页（面板浏览器实例保留，不销毁宿主浏览器）
                var startPage = _builtin?.StartPageAddress;
                await NavigateAsync(string.IsNullOrWhiteSpace(startPage) ? "about:blank" : startPage);
                return;
            }
            var pages = await _browser!.PagesAsync();
            var currentPage = _page!;
            var currentTabId = GetPageTargetId(currentPage);
            var target = string.IsNullOrWhiteSpace(tabId)
                ? _page
                : pages.FirstOrDefault(page => string.Equals(GetPageTargetId(page), tabId, StringComparison.Ordinal));
            if (target == null) throw new InvalidOperationException("element_not_found: 标签页不存在");
            var closingCurrentPage = string.Equals(GetPageTargetId(target), currentTabId, StringComparison.Ordinal);
            await target.CloseAsync();
            var remaining = await _browser.PagesAsync();
            _page = closingCurrentPage
                ? remaining.LastOrDefault()
                : remaining.FirstOrDefault(page => string.Equals(GetPageTargetId(page), currentTabId, StringComparison.Ordinal));
            _page ??= remaining.LastOrDefault();
            _elementRegistry.Clear();
            if (_page != null) await _page.BringToFrontAsync();
        }

        public Task<object[]> ListDownloadsAsync()
        {
            var directory = ResolveConfiguredPath(_config.DownloadDirectory);
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return Task.FromResult(Array.Empty<object>());
            var files = Directory.EnumerateFiles(directory)
                .Select(path => new FileInfo(path))
                .OrderByDescending(info => info.LastWriteTimeUtc)
                .Take(_config.MaxReturnedElements)
                .Select(info => (object)new
                {
                    name = info.Name,
                    path = info.FullName,
                    size = info.Length,
                    modified_at = info.LastWriteTimeUtc,
                })
                .ToArray();
            return Task.FromResult(files);
        }

        // 获取元素 innerText（未找到抛 InvalidOperationException）
        public async Task<string> GetTextAsync(string selector)
        {
            EnsureStarted();
            var element = await WaitForSelectorSafe(selector);
            var text = await element.EvaluateFunctionAsync<string>("el => el.innerText");
            return text ?? string.Empty;
        }

        public async Task<string> ClassifySensitiveActionAsync(string selector, string action, string key)
        {
            if (string.IsNullOrWhiteSpace(selector) ||
                action is not (BrowserProtocol.Actions.Click or BrowserProtocol.Actions.Press))
            {
                return "none";
            }

            var element = await WaitForSelectorSafe(selector);
            return await element.EvaluateFunctionAsync<string>(@"(element, action, key) => {
                const allowed = new Set(['submit_personal_data', 'purchase', 'change_permissions', 'delete_data']);
                const declaredHost = element.closest('[data-browser-risk]');
                const declared = (declaredHost && declaredHost.getAttribute('data-browser-risk') || '').trim();
                if (allowed.has(declared)) return declared;

                const form = element.form || element.closest('form');
                if (!form) return 'none';
                const type = (element.getAttribute('type') || '').toLowerCase();
                const role = (element.getAttribute('role') || '').toLowerCase();
                const submits = (element.tagName === 'BUTTON' && (type === '' || type === 'submit'))
                    || (element.tagName === 'INPUT' && (type === 'submit' || type === 'image'))
                    || role === 'button'
                    || (action === 'press' && key === 'Enter');
                if (!submits) return 'none';

                const personalTypes = new Set(['email', 'tel', 'password']);
                const personalAutocomplete = new Set([
                    'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name',
                    'email', 'tel', 'street-address', 'address-line1', 'address-line2',
                    'postal-code', 'country', 'cc-name', 'cc-number', 'cc-exp', 'cc-csc'
                ]);
                for (const control of form.elements || []) {
                    const controlType = (control.getAttribute && control.getAttribute('type') || '').toLowerCase();
                    const autocomplete = (control.getAttribute && control.getAttribute('autocomplete') || '')
                        .trim().toLowerCase().split(/\s+/).pop();
                    if (personalTypes.has(controlType) || personalAutocomplete.has(autocomplete)) {
                        return 'submit_personal_data';
                    }
                }
                return 'none';
            }", action, key);
        }

        // 获取页面所有可交互元素的 DOM 信息（100% 准确的 CSS 选择器，不依赖视觉猜测）
        // ★ 关键改进：遍历 page.Frames，采集跨域 iframe 内元素，标记 frame_url/frame_name；
        //   跨域/未就绪 iframe 兜底：提取 iframe.src 在新页面中采集
        public async Task<string> GetElementsAsync(CancellationToken cancellationToken = default)
        {
            EnsureStarted();
            var allElements = new List<Dictionary<string, object>>();
            var pageTextParts = new List<string>();
            var diagLog = new List<string>();  // 诊断日志

            // 0. 从主文档提取所有 <iframe> 的 src/id（用于诊断 + 兜底）
            var iframesInDom = new List<(string src, string id)>();
            try
            {
                var iframeJson = await _page!.EvaluateExpressionAsync<string>(@"
                    JSON.stringify(Array.from(document.querySelectorAll('iframe, frame')).map(function(f) {
                        return { src: f.src || '', id: f.id || '' };
                    }))
                ");
                if (!string.IsNullOrWhiteSpace(iframeJson) && iframeJson != "null" && iframeJson != "[]")
                {
                    var parsed = JsonSerializer.Deserialize<List<Dictionary<string, string>>>(iframeJson);
                    if (parsed != null)
                    {
                        foreach (var p in parsed)
                        {
                            p.TryGetValue("src", out var src);
                            p.TryGetValue("id", out var id);
                            if (!string.IsNullOrWhiteSpace(src) && src != "about:blank")
                                iframesInDom.Add((src ?? "", id ?? ""));
                        }
                    }
                }
            }
            catch (Exception) { }

            // 1. 主 frame
            var mainResult = await _page!.EvaluateFunctionAsync<string>(_collectElementsJs);
            ParseElementsResult(mainResult, allElements, pageTextParts, isFrame: false, frameUrl: string.Empty, frameName: string.Empty);

            // 2. Give newly-created frames one bounded stabilization window.
            // The complete frame inspection, including all retries, shares one
            // deadline so pages with many empty frames cannot multiply latency.
            var frameCollectionDeadline = DateTime.UtcNow.AddMilliseconds(_config.FrameCollectionTimeoutMs);
            int lastFrameCount = _page.Frames.Length;
            var frameStableSince = DateTime.UtcNow;
            var frameStableDeadline = DateTime.UtcNow.AddMilliseconds(
                Math.Min(_config.FrameStableMaxWaitMs, _config.FrameCollectionTimeoutMs));
            while (DateTime.UtcNow < frameStableDeadline)
            {
                await Task.Delay(_config.DomStablePollMs, cancellationToken);
                int nowFrameCount;
                try { nowFrameCount = _page.Frames.Length; }
                catch (Exception) { continue; }
                if (nowFrameCount == lastFrameCount)
                {
                    if ((DateTime.UtcNow - frameStableSince).TotalMilliseconds >= _config.FrameStableMs) break;
                }
                else
                {
                    diagLog.Add($"FrameStabilize: FrameCount {lastFrameCount} -> {nowFrameCount}, waiting for render");
                    lastFrameCount = nowFrameCount;
                    frameStableSince = DateTime.UtcNow;
                    await Task.Delay(_config.DomStablePollMs, cancellationToken);
                }
            }

            // 3. Collect every frame in parallel. Empty or not-yet-ready frames
            // alone are retried; successful frames are never duplicated.
            int frameRetryCount = 0;
            bool collectedFromAnyFrame = false;
            var collectedFrameUrls = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var completedFrames = new HashSet<IFrame>();
            var pendingFrames = _page.Frames.Where(frame => frame != _page.MainFrame).ToList();

            while (pendingFrames.Count > 0
                && frameRetryCount < _config.FrameRetryCount
                && DateTime.UtcNow < frameCollectionDeadline)
            {
                frameRetryCount++;
                var tasks = pendingFrames.Select(async frame =>
                {
                    var frameUrl = frame.Url ?? string.Empty;
                    try
                    {
                        var remaining = frameCollectionDeadline - DateTime.UtcNow;
                        if (remaining <= TimeSpan.Zero) return (Frame: frame, Url: frameUrl, Name: string.Empty, Result: string.Empty, Error: "frame collection deadline reached");
                        var frameResult = await frame.EvaluateFunctionAsync<string>(_collectElementsJs)
                            .WaitAsync(remaining, cancellationToken);
#pragma warning disable CS0618
                        var frameName = frame.Name ?? string.Empty;
#pragma warning restore CS0618
                        return (Frame: frame, Url: frameUrl, Name: frameName, Result: frameResult ?? string.Empty, Error: string.Empty);
                    }
                    catch (Exception ex)
                    {
                        return (Frame: frame, Url: frameUrl, Name: string.Empty, Result: string.Empty,
                            Error: ex.GetType().Name + ": " + ex.Message);
                    }
                }).ToArray();
                var results = await Task.WhenAll(tasks);
                var nextPending = new List<IFrame>();
                foreach (var result in results)
                {
                    if (!string.IsNullOrWhiteSpace(result.Error))
                    {
                        diagLog.Add($"Frame[{result.Url}] attempt#{frameRetryCount}: {result.Error}");
                        nextPending.Add(result.Frame);
                        continue;
                    }
                    var beforeCount = allElements.Count;
                    ParseElementsResult(result.Result, allElements, pageTextParts,
                        isFrame: true, frameUrl: result.Url, frameName: result.Name);
                    if (allElements.Count > beforeCount)
                    {
                        collectedFromAnyFrame = true;
                        completedFrames.Add(result.Frame);
                        if (!string.IsNullOrWhiteSpace(result.Url)) collectedFrameUrls.Add(result.Url);
                    }
                    else
                    {
                        nextPending.Add(result.Frame);
                    }
                }
                foreach (var frame in _page.Frames.Where(frame => frame != _page.MainFrame))
                {
                    if (!completedFrames.Contains(frame) && !nextPending.Contains(frame)) nextPending.Add(frame);
                }
                pendingFrames = nextPending;
                if (pendingFrames.Count > 0 && frameRetryCount < _config.FrameRetryCount
                    && DateTime.UtcNow < frameCollectionDeadline)
                    await Task.Delay(_config.FrameStableMs, cancellationToken);
            }

            // ★ 4. 跨域 iframe 兜底已移除（原 L729-786）
            //   原因：兜底在新 page 采集后立即释放（using var newPage），css_selector 属于新 page 上下文，
            //         ClickAsync→WaitForSelectorSafe 只搜 _page.MainFrame + _page.Frames，无法搜已释放的新 page，
            //         导致兜底采集的元素 100% 无法 click，反而误导 AI 反复点击失败。
            //         且每个跨域 iframe 兜底耗时 20s（15s GoTo + 5s networkidle），严重拖慢速度。
            //   正确做法：跨域 iframe 内容由 AI 调用 vls_analyze_browser 获取视觉描述（仅用文字理解，不用其 css_selector）。
            if (iframesInDom.Count > 0)
            {
                var uncapturedIframes = iframesInDom
                    .Where(ifr => !collectedFrameUrls.Contains(ifr.src) && !string.IsNullOrWhiteSpace(ifr.src))
                    .ToList();
                if (uncapturedIframes.Count > 0)
                {
                    diagLog.Add($"CrossOriginIframe: {uncapturedIframes.Count} 个跨域 iframe 已跳过采集（兜底已移除，元素无法 click）");
                }
            }

            // ★ 5. 增强诊断：采集页面级指标（Body HTML 长度、DOM 元素总数、交互元素数、弹窗数、ShadowRoot 数）
            //    任何网站出问题基本一眼定位是“元素被截断 / 弹窗未渲染 / frame 未创建 / shadow 未穿透”
            int bodyHtmlLength = 0, totalDomCount = 0, interactiveCount = 0, modalCount = 0, shadowRootCount = 0;
            try
            {
                var metricsJson = await _page!.EvaluateExpressionAsync<string>(@"
                    JSON.stringify((function(){
                        var body = document.body;
                        var bodyLen = body ? body.innerHTML.length : 0;
                        var totalDom = document.querySelectorAll('*').length;
                        var roles = new Set(['button','link','checkbox','radio','switch','tab','menuitem','option','combobox','textbox','slider','spinbutton','treeitem']);
                        var tags = new Set(['input','button','textarea','select','a','summary','option']);
                        var interactive = Array.from(document.querySelectorAll('*')).filter(function(el){
                            var tag=(el.tagName||'').toLowerCase();
                            var role=(el.getAttribute('role')||'').toLowerCase();
                            var tabindex=el.getAttribute('tabindex');
                            return tags.has(tag)||roles.has(role)||el.isContentEditable||
                                (tabindex!==null&&Number(tabindex)>=0)||typeof el.onclick==='function'||
                                el.hasAttribute('onclick')||getComputedStyle(el).cursor==='pointer';
                        }).length;
                        var modals = Array.from(document.querySelectorAll('dialog,[role=""dialog""],[aria-modal=""true""]')).filter(function(el){
                            return el.getAttribute('aria-modal')==='true'||el.getAttribute('role')==='dialog'||el.open;
                        }).length;
                        var shadow = 0;
                        document.querySelectorAll('*').forEach(function(el){ if(el.shadowRoot) shadow++; });
                        return {bodyLen:bodyLen,totalDom:totalDom,interactive:interactive,modals:modals,shadow:shadow};
                    })())
                ");
                if (!string.IsNullOrWhiteSpace(metricsJson) && metricsJson != "null")
                {
                    var metrics = JsonSerializer.Deserialize<Dictionary<string, object>>(metricsJson);
                    if (metrics != null)
                    {
                        bodyHtmlLength = GetInt(metrics, "bodyLen");
                        totalDomCount = GetInt(metrics, "totalDom");
                        interactiveCount = GetInt(metrics, "interactive");
                        modalCount = GetInt(metrics, "modals");
                        shadowRootCount = GetInt(metrics, "shadow");
                    }
                }
            }
            catch (Exception) { }

            // ★ 6. 诊断日志写入文件（每次追加最新状态）
            try
            {
                var diagPath = ResolveConfiguredPath(_config.DiagnosticsFile);
                // 确保路径存在
                var diagDir = Path.GetDirectoryName(diagPath);
                if (!string.IsNullOrWhiteSpace(diagDir) && !Directory.Exists(diagDir))
                    Directory.CreateDirectory(diagDir);

                var timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
                var diagLines = new List<string>
                {
                    $"=== [{timestamp}] GetElementsAsync diag ===",
                    $"PageURL: {_page.Url ?? ""}",
                    $"FrameCount (excl main): {_page.Frames.Count(f => f != _page.MainFrame)}",
                    $"FrameURLs: {string.Join(" | ", _page.Frames.Where(f => f != _page.MainFrame).Select(f => f.Url ?? ""))}",
                    $"BodyHtmlLength: {bodyHtmlLength}",
                    $"TotalDomCount: {totalDomCount}",
                    $"InteractiveElementCount (page): {interactiveCount}",
                    $"ModalCount (page): {modalCount}",
                    $"ShadowRootCount: {shadowRootCount}",
                    $"IframesInDOM: {iframesInDom.Count}",
                    $"IframesInDOM details: {string.Join("; ", iframesInDom.Select(i => $"{i.id}={i.src}"))}",
                    $"CollectedFrameURLs: {string.Join("; ", collectedFrameUrls)}",
                    $"CollectedFromAnyFrame: {collectedFromAnyFrame}",
                    $"FrameRetryCount: {frameRetryCount}",
                    $"TotalElements before sorting: {allElements.Count}",
                    $"InModal: {allElements.Count(e => GetBool(e, "in_modal"))}",
                    $"InFrame: {allElements.Count(e => GetBool(e, "in_frame"))}",
                    $"PerDocumentLimit: {_config.PerDocumentElementLimit}",
                    $"MaxReturnedElements: {_config.MaxReturnedElements}",
                };
                diagLines.AddRange(diagLog.Select(l => "  " + l));
                diagLines.Add($"=== end ===");

                File.AppendAllLines(diagPath, diagLines, System.Text.Encoding.UTF8);
            }
            catch (Exception) { }

            // 6. 全局排序：弹窗内元素 > iframe 内元素 > 普通元素
            var sortedElements = allElements
                .OrderByDescending(el => GetBool(el, "in_modal"))
                .ThenByDescending(el => GetBool(el, "in_frame"))
                .Take(_config.MaxReturnedElements)
                .ToList();

            _elementRegistry.Clear();
            for (var index = 0; index < sortedElements.Count; index++)
            {
                var element = sortedElements[index];
                var elementId = $"{_sessionId}:{_pageVersion}:{index + 1}";
                var selector = GetString(element, "css_selector");
                var frameUrl = GetString(element, "frame_url");
                var frameName = GetString(element, "frame_name");
                var runtimeId = GetString(element, "runtime_id");
                element["element_id"] = elementId;
                element["page_version"] = _pageVersion;
                _elementRegistry[elementId] = (_pageVersion, selector, frameUrl, frameName, runtimeId);
            }

            var combinedPageText = string.Join(" ", pageTextParts).Replace("  ", " ").Trim();
            if (combinedPageText.Length > _config.PageTextLimit) combinedPageText = combinedPageText.Substring(0, _config.PageTextLimit);

            return JsonSerializer.Serialize(new { page_version = _pageVersion, elements = sortedElements, page_text = combinedPageText });
        }

        public string ResolveElementTarget(string? elementId, string? selector)
        {
            if (!string.IsNullOrWhiteSpace(elementId))
            {
                if (!_elementRegistry.TryGetValue(elementId, out var target) || target.Version != _pageVersion)
                {
                    throw new InvalidOperationException("stale_element: 元素快照已过期，请重新 inspect");
                }
                if (string.IsNullOrWhiteSpace(target.Selector))
                {
                    throw new InvalidOperationException("element_not_found: 元素没有可执行定位信息");
                }
                if (!string.IsNullOrWhiteSpace(target.RuntimeId))
                {
                    return $"[data-moonya-runtime-id=\"{target.RuntimeId.Replace("\"", "\\\"")}\"]";
                }
                return target.Selector;
            }
            if (!string.IsNullOrWhiteSpace(selector)) return selector;
            throw new ArgumentException("缺少 element_id 或 selector 参数");
        }

        // 解析单 frame 的采集结果并合并到全局列表
        private void ParseElementsResult(string json, List<Dictionary<string, object>> allElements, List<string> pageTextParts, bool isFrame, string frameUrl, string frameName)
        {
            if (string.IsNullOrWhiteSpace(json)) return;
            try
            {
                var data = JsonSerializer.Deserialize<Dictionary<string, object>>(json);
                if (data == null) return;

                if (data.TryGetValue("page_text", out var pageTextObj) && pageTextObj is JsonElement pageTextJson && pageTextJson.ValueKind == JsonValueKind.String)
                {
                    var framePageText = pageTextJson.GetString() ?? string.Empty;
                    if (!string.IsNullOrWhiteSpace(framePageText))
                    {
                        // 主文档直接追加；iframe 文档加标记，便于 AI 识别弹窗/frame 上下文
                        if (isFrame)
                        {
                            pageTextParts.Add($"[FRAME {frameUrl}] {framePageText}");
                        }
                        else
                        {
                            pageTextParts.Add(framePageText);
                        }
                    }
                }

                if (data.TryGetValue("elements", out var elementsObj) && elementsObj is JsonElement elementsJson && elementsJson.ValueKind == JsonValueKind.Array)
                {
                    foreach (var el in elementsJson.EnumerateArray())
                    {
                        var elDict = el.Deserialize<Dictionary<string, object>>();
                        if (elDict == null) continue;
                        elDict["in_frame"] = isFrame;
                        elDict["frame_url"] = frameUrl;
                        elDict["frame_name"] = frameName;
                        // 只要是通过 frame API 采集的，统一标记为 in_iframe=true
                        if (isFrame) elDict["in_iframe"] = true;
                        allElements.Add(elDict);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"ParseElementsResult failed: {ex.Message}");
            }
        }

        // 在浏览器执行任意 JS 表达式并返回 JSON 序列化结果
        public async Task<string> EvaluateAsync(string jsCode)
        {
            EnsureStarted();
            var result = await _page!.EvaluateExpressionAsync<object>(jsCode);
            if (result == null) return "null";
            // 直接 Serialize object 可能丢失原始结构，这里包装为 JsonElement 再序列化以保留运行时类型
            if (result is JsonElement je)
            {
                return je.ValueKind == JsonValueKind.Null ? "null" : je.GetRawText();
            }
            return JsonSerializer.Serialize(result);
        }

        // 单纯延迟，不做任何浏览器操作
        public async Task WaitAsync(int ms)
        {
            await Task.Delay(ms);
        }

        // 关闭浏览器并释放资源
        public async Task StopAsync()
        {
            _sessionGeneration++;
            _sessionId = Guid.NewGuid().ToString("N");
            _pageVersion = 0;
            _elementRegistry.Clear();
            if (_builtinSession)
            {
                // 内置浏览器属于宿主进程：只断开 CDP 连接并复位面板，绝不关闭浏览器/杀进程。
                try { _browser?.Disconnect(); } catch (Exception) { }
                _browser = null;
                _page = null;

                _pageVersion = 0;
                _elementRegistry.Clear();
                _builtinSession = false;
                try { _builtin?.OnSessionStopped(); } catch (Exception) { }
                try { _builtin?.ResetPanel(); } catch (Exception) { }
                return;
            }

            if (_browser != null)
            {
                if (!_browser.IsClosed)
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(_config.ShutdownTimeoutMs));
                    try
                    {
                        var closeTask = _browser.CloseAsync();
                        await Task.WhenAny(closeTask, Task.Delay(-1, cts.Token));
                    }
                    catch (Exception) { }
                }
                try { _browser.Dispose(); } catch (Exception) { }
                _browser = null;
                _page = null;

                _pageVersion = 0;
                _elementRegistry.Clear();

                await Task.Delay(_config.CleanupDelayMs);
                KillLaunchedBrowserProcess();
            }
        }

        private void KillLaunchedBrowserProcess()
        {
            if (_launchedBrowserProcessId <= 0) return;
            try
            {
                using var process = Process.GetProcessById(_launchedBrowserProcessId);
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(_config.ShutdownTimeoutMs);
                }
            }
            catch { }
            finally { _launchedBrowserProcessId = 0; }
        }

        // 返回当前运行状态对象
        public async Task<object> GetStatusAsync()
        {
            bool running = IsRunning;
            string url = string.Empty;
            string title = string.Empty;

            if (running && _page != null)
            {
                try
                {
                    url = _page.Url ?? string.Empty;
                    title = await _page.GetTitleAsync();
                }
                catch (Exception) { }
            }

            return new
            {
                running,
                mode = running ? BrowserName : "idle",
                backend = BrowserName,
                session_id = _sessionId,
                page_version = _pageVersion,
                tab_id = running && _page != null ? GetPageTargetId(_page) : string.Empty,
                url,
                title,
            };
        }

        public async Task<string> GetPageFactsFingerprintAsync()
        {
            if (!IsRunning) return string.Empty;
            var facts = await _page!.EvaluateExpressionAsync<string>($@"
                JSON.stringify({{
                    url: location.href,
                    title: document.title,
                    text: (document.body ? document.body.innerText : '').slice(0, {_config.PageTextLimit}),
                    dom: (document.documentElement ? document.documentElement.innerHTML : '').slice(0, {_config.PageTextLimit}),
                    active: document.activeElement ? {{
                        tag: document.activeElement.tagName,
                        value: document.activeElement.value || '',
                        checked: document.activeElement.checked === true
                    }} : null
                }})");
            var input = (facts ?? string.Empty) + "|frames=" + _page.Frames.Length;
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                // 同步等待，但带超时避免死锁；若超时则强制清理进程
                var stopTask = StopAsync();
                if (!stopTask.Wait(TimeSpan.FromMilliseconds(_config.ShutdownTimeoutMs + _config.CleanupDelayMs)))
                {
                    KillLaunchedBrowserProcess();
                }
            }
            catch (Exception) { }
        }

        // ── 内部辅助 ───────────────────────────────────────

        private void EnsureStarted()
        {
            if (_browser == null || _browser.IsClosed || _page == null)
            {
                throw new InvalidOperationException("浏览器未启动或已关闭，请先调用 StartAsync");
            }
        }

        private static void ValidateConfig(BrowserAutomationConfig config)
        {
            var missing = new List<string>();
            if (string.IsNullOrWhiteSpace(config.LoopbackHost)) missing.Add("loopback_host");
            if (config.Port <= 0) missing.Add("port");
            if (config.DefaultTimeoutMs <= 0) missing.Add("default_timeout_ms");
            if (config.ApprovalTimeoutMs <= 0) missing.Add("approval_timeout_ms");
            if (config.ElementTimeoutMs <= 0) missing.Add("element_timeout_ms");
            if (config.ViewportWidth <= 0) missing.Add("viewport_width");
            if (config.ViewportHeight <= 0) missing.Add("viewport_height");
            if (config.ClickInitialDelayMs < 0) missing.Add("click_initial_delay_ms");
            if (config.NetworkIdleTimeoutMs <= 0) missing.Add("network_idle_timeout_ms");
            if (config.NetworkIdleTimeMs <= 0) missing.Add("network_idle_time_ms");
            if (config.DomStableMaxWaitMs <= 0) missing.Add("dom_stable_max_wait_ms");
            if (config.DomStableThresholdMs <= 0) missing.Add("dom_stable_threshold_ms");
            if (config.DomStablePollMs <= 0) missing.Add("dom_stable_poll_ms");
            if (config.MutationStableMs <= 0) missing.Add("mutation_stable_ms");
            if (config.MutationTimeoutMs <= 0) missing.Add("mutation_timeout_ms");
            if (config.FrameStableMs <= 0) missing.Add("frame_stable_ms");
            if (config.FrameStableMaxWaitMs <= 0) missing.Add("frame_stable_max_wait_ms");
            if (config.FrameRetryCount <= 0) missing.Add("frame_retry_count");
            if (config.FrameCollectionTimeoutMs <= 0) missing.Add("frame_collection_timeout_ms");
            if (config.OperationTimeoutMs <= 0) missing.Add("operation_timeout_ms");
            if (config.BuiltinConnectRetryCount <= 0) missing.Add("builtin_connect_retry_count");
            if (config.BuiltinConnectRetryDelayMs < 0) missing.Add("builtin_connect_retry_delay_ms");
            if (config.PerDocumentElementLimit <= 0) missing.Add("per_document_element_limit");
            if (config.MaxReturnedElements <= 0) missing.Add("max_returned_elements");
            if (config.PageTextLimit <= 0) missing.Add("page_text_limit");
            if (config.DefaultWaitMs <= 0) missing.Add("default_wait_ms");
            if (config.DefaultScrollAmount <= 0) missing.Add("default_scroll_amount");
            if (config.RelayTimeoutMs <= 0) missing.Add("relay_timeout_ms");
            if (config.ShutdownTimeoutMs <= 0) missing.Add("shutdown_timeout_ms");
            if (config.CleanupDelayMs < 0) missing.Add("cleanup_delay_ms");
            if (missing.Count > 0)
            {
                throw new InvalidOperationException("browser_automation 配置缺失或无效: " + string.Join(", ", missing));
            }
            if (config.FrameCollectionTimeoutMs > config.OperationTimeoutMs)
                throw new InvalidOperationException("browser_automation.frame_collection_timeout_ms 不能大于 operation_timeout_ms");
            if (config.RelayTimeoutMs <= config.OperationTimeoutMs)
                throw new InvalidOperationException("browser_automation.relay_timeout_ms 必须大于 operation_timeout_ms");
        }

        private string ResolveBrowserExecutablePath()
        {
            var expected = BrowserName == "edge" ? "msedge.exe" : "chrome.exe";
            foreach (var candidate in new[] { _config.ChromiumExecutablePath }.Concat(_config.ChromiumCandidatePaths))
            {
                var resolved = ResolveConfiguredPath(candidate);
                if (File.Exists(resolved) && string.Equals(Path.GetFileName(resolved), expected, StringComparison.OrdinalIgnoreCase)) return resolved;
            }
            return string.Empty;
        }

        internal static string ResolveConfiguredPath(string configuredPath)
        {
            if (string.IsNullOrWhiteSpace(configuredPath)) return string.Empty;
            var expanded = Environment.ExpandEnvironmentVariables(configuredPath.Trim());
            return Path.GetFullPath(Path.IsPathRooted(expanded)
                ? expanded
                : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, expanded));
        }

        private async Task WaitForPageSettledAsync(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.WhenAll(
                WaitForNetworkIdleSafeAsync(),
                WaitForDomStableMutationAsync(),
                WaitForDomStableAsync());
            cancellationToken.ThrowIfCancellationRequested();
        }

        // 从 Dictionary 中安全读取 bool 值（兼容 JsonElement true / C# bool）
        private static bool GetBool(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.TryGetValue(key, out var obj)) return false;
            if (obj is bool b) return b;
            if (obj is JsonElement je)
            {
                return je.ValueKind == JsonValueKind.True;
            }
            return false;
        }

        // ★ 从 Dictionary 中安全读取 int 值（兼容 JsonElement number / C# int/long）
        private static int GetInt(Dictionary<string, object> dict, string key)
        {
            if (dict == null || !dict.TryGetValue(key, out var obj)) return 0;
            if (obj is int i) return i;
            if (obj is long l) return (int)l;
            if (obj is double d) return (int)d;
            if (obj is JsonElement je)
            {
                if (je.ValueKind == JsonValueKind.Number)
                {
                    return je.TryGetInt32(out var iv) ? iv : (int)je.GetDouble();
                }
            }
            return 0;
        }

        private static string GetString(Dictionary<string, object> dict, string key)
        {
            if (!dict.TryGetValue(key, out var value) || value == null) return string.Empty;
            if (value is string text) return text;
            if (value is JsonElement json && json.ValueKind == JsonValueKind.String) return json.GetString() ?? string.Empty;
            return value.ToString() ?? string.Empty;
        }

        // Network-idle is advisory because streaming and polling pages may never become idle.
        private async Task WaitForNetworkIdleSafeAsync()
        {
            try
            {
                await _page!.WaitForNetworkIdleAsync(new WaitForNetworkIdleOptions
                {
                    Timeout = _config.NetworkIdleTimeoutMs,
                    IdleTime = _config.NetworkIdleTimeMs,
                });
            }
            catch (Exception)
            {
                // 超时或页面导航中，忽略，继续后续 DOM 稳定检测
            }
        }

        // ★ 等待 DOM 稳定：轮询 document.querySelectorAll('*').length，
        //   元素数量在 DomStableThresholdMs 内无变化视为渲染完成。
        //   适配 SPA 路由切换（pushState 不触发 navigation）、传统页面导航、弹窗 AJAX 渲染三种场景。
        //   导航过程中 DOM 可能短暂不可访问（EvaluateExpressionAsync 抛异常），捕获后继续轮询。
        private async Task WaitForDomStableAsync()
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(_config.DomStableMaxWaitMs);
            int lastCount = -1;
            var lastChange = DateTime.UtcNow;

            while (DateTime.UtcNow < deadline)
            {
                int currentCount;
                try
                {
                    currentCount = await _page!.EvaluateExpressionAsync<int>("document.querySelectorAll('*').length");
                }
                catch (Exception)
                {
                    // 页面导航中 DOM 短暂不可访问，重置基准继续等待
                    await Task.Delay(_config.DomStablePollMs);
                    lastChange = DateTime.UtcNow;
                    continue;
                }

                if (currentCount == lastCount)
                {
                    if ((DateTime.UtcNow - lastChange).TotalMilliseconds >= _config.DomStableThresholdMs)
                    {
                        return; // 元素数量稳定，视为渲染完成
                    }
                }
                else
                {
                    lastCount = currentCount;
                    lastChange = DateTime.UtcNow;
                }

                await Task.Delay(_config.DomStablePollMs);
            }
            // 超过最大等待时长仍未稳定，直接返回（避免无限阻塞）
        }

        // ★ 基于 MutationObserver 的 DOM 稳定等待：监听 body 子树变化，300ms 内无 mutation 视为稳定
        //   比固定轮询 querySelectorAll('*').length 更精准：能捕获属性/文本变化（元素数量可能不变但内容在变）
        //   带兜底超时（5s），防止长轮询页面永久阻塞；立即触发一次，若 DOM 已稳定 300ms 后自动结束
        private async Task WaitForDomStableMutationAsync()
        {
            try
            {
                await _page!.EvaluateFunctionAsync(@"(stableMs, timeoutMs) => new Promise(resolve => {
                    let settled = false;
                    let observer;
                    const finish = () => {
                        if (settled) return;
                        settled = true;
                        try { if (observer) observer.disconnect(); } catch(e){}
                        clearTimeout(window.__baMutationTimer);
                        resolve();
                    };
                    try {
                        observer = new MutationObserver(() => {
                            clearTimeout(window.__baMutationTimer);
                            window.__baMutationTimer = setTimeout(finish, stableMs);
                        });
                        observer.observe(document.body, { childList: true, subtree: true });
                    } catch(e) {
                        // body 不存在或不可观察，立即返回
                        finish();
                        return;
                    }
                    // 兜底超时：最多等待 5 秒
                    setTimeout(finish, timeoutMs);
                    // 立即触发一次：若 DOM 已稳定，300ms 后自动结束
                    clearTimeout(window.__baMutationTimer);
                    window.__baMutationTimer = setTimeout(finish, stableMs);
                })", _config.MutationStableMs, _config.MutationTimeoutMs);
            }
            catch (Exception)
            {
                // 页面导航中或 body 不可访问时忽略，回退到轮询方式
            }
        }

        // Detect standards-based modal state and wait for its contents without vendor selectors.
        private async Task WaitForModalContentAsync()
        {
            try
            {
                var hasModal = await _page!.EvaluateExpressionAsync<bool>(@"
                    !!document.querySelector('dialog[open], [role=""dialog""], [aria-modal=""true""]')
                ");
                if (hasModal)
                {
                    // ★ 弹窗容器已出现—主等待：让内部表单/iframe 完成渲染和动画
                    //   MutationObserver 精准等待 mutation 停止（5s 兜底）+ 轮询 DOM 稳定兜底
                    await WaitForDomStableMutationAsync();
                    await WaitForDomStableAsync();

                    // ★ 二次稳定检查：弹窗内 input/select/textarea < 2 时再等一次 MutationObserver
                    //   （原 sleep + DomStable 改为仅 MutationObserver，节省 ~3s）
                    try
                    {
                        var modalInputCount = await _page!.EvaluateExpressionAsync<int>(@"
                            (function() {
                                var container = document.querySelector('dialog[open], [role=""dialog""], [aria-modal=""true""]');
                                if (!container) return 0;
                                return container.querySelectorAll('input, select, textarea, button').length;
                            })()
                        ");
                        if (modalInputCount < 2)
                        {
                            await WaitForDomStableMutationAsync();
                        }
                    }
                    catch (Exception)
                    {
                        // 二次检查失败不阻断
                    }

                    // Wait for interactive content in any frame owned by the modal navigation.
                    try
                    {
                        foreach (var frame in _page.Frames)
                        {
                            if (frame == _page.MainFrame) continue;
                            try
                            {
                                await frame.WaitForFunctionAsync(
                                    VisibleInteractiveCheckJs,
                                    new WaitForFunctionOptions { Timeout = _config.FrameStableMaxWaitMs, PollingInterval = _config.DomStablePollMs }
                                );
                            }
                            catch (Exception)
                            {
                                // 超时不阻断：frame 内可能确实无交互元素
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // frame 遍历失败不阻断
                    }
                }
            }
            catch (Exception)
            {
                // 页面导航中或 DOM 不可访问时忽略，不阻断主流程
            }
        }

        // Standard CSS compatibility path. element_id targets resolve to a runtime-id selector.
        private async Task<IElementHandle> WaitForSelectorSafe(string selector, int? timeoutMs = null)
        {
            var effectiveTimeout = Math.Max(1, timeoutMs ?? _config.ElementTimeoutMs);
            var deadline = DateTime.UtcNow.AddMilliseconds(effectiveTimeout);
            do
            {
                try
                {
                    var remaining = Math.Max(1, (int)(deadline - DateTime.UtcNow).TotalMilliseconds);
                    var perFrameTimeout = Math.Min(remaining, Math.Max(50, _config.DomStablePollMs));
                    var mainElement = await TryWaitForSelectorInFrameAsync(_page!.MainFrame, selector, perFrameTimeout);
                    if (mainElement != null) return mainElement;

                    foreach (var frame in _page.Frames)
                    {
                        if (ReferenceEquals(frame, _page.MainFrame)) continue;
                        var frameElement = await TryWaitForSelectorInFrameAsync(frame, selector, perFrameTimeout);
                        if (frameElement != null) return frameElement;
                    }
                }
                catch (Exception ex) when (ex is TimeoutException || ex.GetType().Name.Contains("WaitTask"))
                {
                    // Retry until the shared deadline so one slow frame cannot consume the whole wait.
                }
                if (DateTime.UtcNow < deadline) await Task.Delay(Math.Min(_config.DomStablePollMs, 100));
            }
            while (DateTime.UtcNow < deadline);

            throw new InvalidOperationException($"element_not_found: 元素 {selector} 未找到");
        }

        // 在单个 frame 中尝试查找元素；返回 null 表示未找到（不抛异常，便于跨 frame 重试）
        private async Task<IElementHandle?> TryWaitForSelectorInFrameAsync(IFrame frame, string selector, int timeoutMs)
        {
            try
            {
                if (selector.StartsWith("[data-moonya-runtime-id=\"", StringComparison.Ordinal))
                {
                    var firstQuote = selector.IndexOf('\"');
                    var lastQuote = selector.LastIndexOf('\"');
                    var runtimeId = firstQuote >= 0 && lastQuote > firstQuote
                        ? selector.Substring(firstQuote + 1, lastQuote - firstQuote - 1)
                        : string.Empty;
                    if (runtimeId.Length > 0)
                    {
                        var handle = await frame.EvaluateFunctionHandleAsync(@"runtimeId => {
                            const find = root => {
                                if (!root || !root.querySelectorAll) return null;
                                const direct = root.querySelector('[data-moonya-runtime-id=""' + CSS.escape(runtimeId) + '""]');
                                if (direct) return direct;
                                for (const node of root.querySelectorAll('*')) {
                                    if (node.shadowRoot) {
                                        const nested = find(node.shadowRoot);
                                        if (nested) return nested;
                                    }
                                }
                                return null;
                            };
                            return find(document);
                        }", runtimeId);
                        if (handle is IElementHandle elementHandle) return elementHandle;
                        await handle.DisposeAsync();
                        return null;
                    }
                }

                // 标准 CSS 选择器：走 PuppeteerSharp 原生 WaitForSelectorAsync
                return await frame.WaitForSelectorAsync(selector, new WaitForSelectorOptions
                {
                    Timeout = timeoutMs,
                    Visible = true,
                });
            }
            catch
            {
                // 当前 frame 未找到或执行失败，返回 null 让上层尝试其他 frame
                return null;
            }
        }
    }
}
