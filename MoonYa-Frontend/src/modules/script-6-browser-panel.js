(function () {
    'use strict';

    var BRIDGE_NAME = 'moonYaBrowserPanel';
    var WIDEN_TARGET_WIDTH = 640;
    var MIN_READABLE_WIDTH = 480;
    var DEFAULT_PANEL_WIDTH = 640;  // 仅在量不到面板宽度时的兜底（默认宽度由 script-1d-dom.php 按比例算出）
    // 与 script-1d-dom.php 的 splitLayoutConfig 同口径
    var MIN_CHAT_WIDTH = 520;
    var DIVIDER_WIDTH = 1;
    var VIEW_LABELS = { log: '工作日志', artifacts: '产出物', preview: '预览', browser: '新标签页' };
    // 只能存在一个标签的视图；浏览器（browser）不在此列，可以开多个
    var SINGLE_VIEWS = { log: true, artifacts: true, preview: true };
    var MENU_VIEWS = ['log', 'artifacts', 'preview', 'browser'];
    // 与 css-18-builtin-browser.php 的 --bp-dur-fast / --bp-dur 对齐：JS 定时器只做兜底，
    // 正常路径由 transitionend / animationend 收尾。
    var MENU_EXIT_MS = 110;
    var TAB_EXIT_MS = 160;
    var TAB_ENTER_MS = 200;
    var TITLE_FLASH_MS = 160;
    // 几何同步的硬上限（面板开合是 0.3s，留一点余量）
    var BOUNDS_SYNC_MAX_MS = 420;
    var OVERLAY_HIDE_FALLBACK_MS = 520;

    // 减少动效：实时查询（系统设置可以在不刷新页面的情况下改变）。
    // CSS 侧由 css-06 的 .team-panel * 全局规则兜底，这里决定 JS 要不要加类/等定时器。
    var reduceMotionQuery = null;
    try {
        reduceMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (motionError) {
        reduceMotionQuery = null;
    }

    function prefersReducedMotion() {
        return !!(reduceMotionQuery && reduceMotionQuery.matches);
    }

    var bridge = null;
    var available = false;
    var lastBoundsJson = '';
    var pendingFrame = 0;
    var boundsSyncFrame = 0;
    var overlayHideTimer = 0;
    var lastOverlayShown = false;
    var widenApplied = false;
    var bindAttempts = 0;
    var menuSuspended = false;      // 菜单展开/退场期间覆盖层处于挂起状态
    var openMenuElement = null;
    var closingMenu = null;
    var menuCloseTimer = 0;
    var expandedPanel = false;
    var previousPanelWidth = 0;
    var lastPanelState = null;
    var statePending = false;

    // ── 多标签状态 ─────────────────────────────────────────
    var tabs = [];                  // [{ id, view, url, title }]
    var activeTabId = 0;
    var tabSeq = 0;
    var visualRevision = 0;
    var visualResetGeneration = 0;
    var lastVisualState = '';

    function syncBrowserVisuals() {
        var tab = activeBrowserTab();
        var state = { tab_id: tab ? tab.id : 0, enabled: !!(tab && tab.automationVisuals),
            reset_generation: visualResetGeneration };
        var key = JSON.stringify(state);
        if (key === lastVisualState) return;
        lastVisualState = key;
        state.revision = ++visualRevision;
        state.open_tab_ids = tabs.filter(function (item) { return item.view === 'browser'; }).map(function (item) { return item.id; });
        state.x = tab && tab.pointer ? tab.pointer.x : 0.5;
        state.y = tab && tab.pointer ? tab.pointer.y : 0.5;
        bridgeCallAsync('setVisuals', [JSON.stringify(state)]);
    }

    window.moonyaBrowserPointerState = function (state) {
        if (!state || state.reset_generation !== visualResetGeneration || state.revision !== visualRevision) return;
        var tab = findTab(state.tab_id);
        if (tab && tab.automationVisuals) tab.pointer = { x: state.x, y: state.y };
    };

    window.moonyaResetBrowserVisuals = function (generation, tabId) {
        if (generation < visualResetGeneration) return;
        visualResetGeneration = generation;
        var tab = tabId ? findTab(tabId) : activeBrowserTab();
        if (tab) { tab.automationVisuals = false; tab.pointer = null; }
        lastVisualState = '';
        lastBoundsJson = '';
        lastOverlayShown = false;
        syncBrowserVisuals();
    };
    // activateView 通过点击 [data-team-tab] 锚点触发 script-1e 的视图切换；
    // 该点击会再次进入本模块的点击处理，用这个标记避免递归开标签。
    var activating = false;

    var pane = document.getElementById('teamPaneBrowser');
    var viewport = document.getElementById('teamBrowserViewport');
    var placeholder = document.getElementById('teamBrowserPlaceholder');
    var addressInput = document.getElementById('teamBrowserAddress');
    var goButton = document.getElementById('teamBrowserGo');
    var backButton = document.getElementById('teamBrowserBack');
    var forwardButton = document.getElementById('teamBrowserForward');
    var reloadButton = document.getElementById('teamBrowserReload');
    var browserViewItem = document.getElementById('teamTabBrowser');
    var homeBrowserEntry = document.getElementById('homeBrowserEntry');
    var tabStrip = document.getElementById('panelTabStrip');
    var viewMenuButton = document.getElementById('panelViewMenuBtn');
    var viewMenu = document.getElementById('panelViewMenu');
    var browserMenuButton = document.getElementById('teamBrowserMenuBtn');
    var browserMenu = document.getElementById('teamBrowserMenu');
    var handoffCompleteButton = document.getElementById('teamBrowserHandoffComplete');
    var expandButton = document.getElementById('teamBrowserExpand');
    var collapseButton = document.getElementById('panelCollapseBtn');
    var zoomHint = document.getElementById('teamBrowserZoomHint');

    if (!pane || !viewport) return;

    function bridgeCall(method, args) {
        if (!bridge || typeof bridge[method] !== 'function') return null;
        try {
            return bridge[method].apply(bridge, args || []);
        } catch (error) {
            return null;
        }
    }

    // CefSharp 的 JS 桥统一以 Promise 返回结果：需要返回值时用这个包装（失败按 null 处理）
    function bridgeCallAsync(method, args) {
        return Promise.resolve(bridgeCall(method, args)).catch(function () { return null; });
    }

    function parseJson(text) {
        try { return text ? JSON.parse(text) : null; } catch (error) { return null; }
    }

    // 只在真正变化时写 hidden：面板子树被 MutationObserver 观察（attributeFilter 含 hidden），
    // 而给同值再赋一次 hidden 仍会产生一条 attributes 记录 → reportBounds → 再赋值，
    // 会和观察者形成死循环（渲染主线程 100% CPU，页面假死）。
    function setHidden(element, hidden) {
        if (!element || element.hidden === hidden) return;
        element.hidden = hidden;
    }

    function isPanelOpen() {
        var panel = document.getElementById('detailPanel');
        return !!panel && panel.classList.contains('open');
    }

    // 当前视图：由 script-1e 的 activateTeamTab 维护 [data-team-tab].selected
    function activePanelView() {
        var selected = document.querySelector('[data-team-tab].selected');
        return selected && selected.dataset ? (selected.dataset.teamTab || 'log') : 'log';
    }

    function isBrowserViewActive() {
        return !!pane && !pane.hidden && isPanelOpen();
    }

    // ── 标签模型 ───────────────────────────────────────────
    function findTab(id) {
        for (var i = 0; i < tabs.length; i += 1) {
            if (tabs[i].id === id) return tabs[i];
        }
        return null;
    }

    function findTabIndex(id) {
        for (var i = 0; i < tabs.length; i += 1) {
            if (tabs[i].id === id) return i;
        }
        return -1;
    }

    function findViewTab(view) {
        for (var i = 0; i < tabs.length; i += 1) {
            if (tabs[i].view === view) return tabs[i];
        }
        return null;
    }

    function activeTab() {
        return findTab(activeTabId);
    }

    function activeBrowserTab() {
        var tab = activeTab();
        return tab && tab.view === 'browser' ? tab : null;
    }

    function tabTitle(tab) {
        if (tab.view !== 'browser') return VIEW_LABELS[tab.view] || tab.view;
        return tab.title || VIEW_LABELS.browser;
    }

    // 「+」菜单里的视图锚点（同时也是 script-1e 的视图入口）
    function menuItemFor(view) {
        return document.querySelector('#panelViewMenu [data-team-tab="' + view + '"]');
    }

    // 切换视图＝点击锚点，让 script-1e 的 activateTeamTab 去改 [data-team-tab]/.selected 与 pane
    function activateView(view) {
        var item = menuItemFor(view) || document.querySelector('[data-team-tab="' + view + '"]');
        if (!item) return;
        activating = true;
        try {
            item.click();
        } finally {
            activating = false;
        }
    }

    function goHome() {
        var marker = document.getElementById('teamTabHome');
        if (marker) marker.click();
        scheduleBounds();
    }

    function openTab(view) {
        if (!view) return;
        if (view === 'browser' && !available) return;
        if (SINGLE_VIEWS[view]) {
            var existing = findViewTab(view);
            if (existing) {
                activateTab(existing.id);
                return;
            }
        }
        tabSeq += 1;
        var tab = { id: tabSeq, view: view, url: '', title: '', automationVisuals: false, pointer: null };
        if (view === 'browser') {
            // 新浏览器标签＝新标签页：内核会切到起始页；其它浏览器标签各自记住原地址
            tab.url = '';
            tab.title = '';
        }
        tabs.push(tab);
        activateTab(tab.id);
    }

    function closeTab(id) {
        var index = findTabIndex(id);
        if (index < 0) return;
        var node = tabStrip ? tabStrip.querySelector('[data-panel-tab="' + id + '"]') : null;
        var wasActive = tabs[index].id === activeTabId;
        tabs.splice(index, 1);
        syncBrowserVisuals();
        playTabExit(node);
        if (!tabs.length) {
            activeTabId = 0;
            renderTabs();
            syncPanelChrome();
            goHome();
            return;
        }
        if (wasActive) {
            activeTabId = 0;
            activateTab(tabs[Math.min(index, tabs.length - 1)].id);
            return;
        }
        renderTabs();
        syncPanelChrome();
        scheduleBounds();
    }

    // 标签退场：先把宽度固定住再收到 0，后面的标签顺势平移；
    // 节点在动画结束后自行移除（renderTabs 会跳过带 is-closing 的节点）。
    function playTabExit(node) {
        if (!node || prefersReducedMotion()) {
            if (node) node.remove();
            return;
        }
        node.classList.remove('is-entering');    // 新标签立刻关掉时，别让入场动画的填充态打架
        node.classList.add('is-closing');
        node.style.width = node.offsetWidth + 'px';
        window.requestAnimationFrame(function () {
            node.classList.add('is-closing-active');
        });
        window.setTimeout(function () {
            if (node.parentNode) node.remove();
            syncPanelChrome();
        }, TAB_EXIT_MS + 40);
    }

    function hasClosingTabNode() {
        return !!(tabStrip && tabStrip.querySelector('.bp-tab.is-closing'));
    }

    function activateTab(id) {
        var tab = findTab(id);
        if (!tab) return;
        activeTabId = tab.id;
        syncBrowserVisuals();
        if (activePanelView() !== tab.view) activateView(tab.view);
        if (tab.view === 'browser') syncBrowserTab(tab);
        renderTabs();
        syncPanelChrome();
        revealActiveTab();
        scheduleBounds();
    }

    // 让内核显示该浏览器标签记住的地址（共用一个内核，切标签＝加载该标签的地址）
    function syncBrowserTab(tab) {
        if (!available || !tab || tab.view !== 'browser') return;
        if (!lastPanelState) {
            // 状态还没到手：先取一次再决定，避免拿旧地址做判断
            if (statePending) return;
            statePending = true;
            bridgeCallAsync('state', []).then(function (raw) {
                statePending = false;
                var state = parseJson(raw);
                if (!state) return;
                lastPanelState = state;
                applyBrowserState(state);
                syncBrowserTab(tab);
            });
            return;
        }
        var current = lastPanelState.is_start_page ? '' : (lastPanelState.url || '');
        var target = tab.url || '';
        if (target === current) return;
        if (!target) {
            bridgeCallAsync('action', ['home']);
            if (addressInput) addressInput.value = '';
            return;
        }
        bridgeCallAsync('navigate', [target]);
        if (addressInput) addressInput.value = target;
    }

    // ── 标签渲染 ───────────────────────────────────────────
    function viewIconNode(view) {
        var source = document.querySelector('#panelViewMenu [data-team-tab="' + view + '"] .bp-menu-icon');
        if (!source) return null;
        var icon = source.cloneNode(true);
        icon.classList.remove('bp-menu-icon');
        icon.classList.add('bp-tab-icon');
        icon.setAttribute('width', '15');
        icon.setAttribute('height', '15');
        return icon;
    }

    function createTabNode(tab) {
        var node = document.createElement('div');
        node.className = 'bp-tab';
        node.dataset.panelTab = String(tab.id);
        node.setAttribute('role', 'tab');
        node.setAttribute('tabindex', '0');

        var icon = viewIconNode(tab.view);
        if (icon) node.appendChild(icon);

        var title = document.createElement('span');
        title.className = 'bp-tab-title';
        node.appendChild(title);

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'bp-tab-close';
        close.dataset.panelTabClose = String(tab.id);
        close.dataset.tooltip = '关闭标签页';
        close.setAttribute('aria-label', '关闭标签页');
        close.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"'
            + ' stroke-width="1.8" stroke-linecap="round" aria-hidden="true">'
            + '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>';
        node.appendChild(close);

        return node;
    }

    // 结构变化（开/关/换序）才同步节点：按 tabs 顺序复用同 id 节点，
    // 只有新增的标签播入场动画——整条重建会让"切换标签"把所有入场动画重放一遍，反而更生硬。
    function renderTabs() {
        if (!tabStrip) return;
        var existing = {};
        Array.prototype.forEach.call(tabStrip.querySelectorAll('.bp-tab'), function (node) {
            var id = node.dataset ? node.dataset.panelTab : '';
            if (id) existing[id] = node;
        });

        // 退场中的节点留在原位（宽度已收到 0），排布时跳过它们，
        // 否则新顺序会把正在缩小的标签"挤"到别处，出现跳动。
        var skipClosing = function (node) {
            var current = node;
            while (current && current.nodeType === 1 && current.classList
                && current.classList.contains('is-closing')) {
                current = current.nextSibling;
            }
            return current;
        };

        var reference = skipClosing(tabStrip.firstChild);
        tabs.forEach(function (tab) {
            var key = String(tab.id);
            var node = existing[key];
            if (node) {
                delete existing[key];
            } else {
                node = createTabNode(tab);
                if (!prefersReducedMotion()) {
                    node.classList.add('is-entering');
                    // 兜底：动画事件万一没来（被隐藏/被抢占），也要把类摘掉
                    (function (entering) {
                        window.setTimeout(function () { finishTabEnter(entering); }, TAB_ENTER_MS + 60);
                    })(node);
                }
            }
            // 只在位置不对时搬动，避免无谓的重排（也会打断过渡）
            if (node !== reference) tabStrip.insertBefore(node, reference);
            reference = skipClosing(node.nextSibling);
        });

        Object.keys(existing).forEach(function (key) {
            var node = existing[key];
            if (node.classList.contains('is-closing')) return;   // 正在退场，交给它自己的定时器
            node.remove();
        });

        updateTabNodes();
        syncPanelChrome();
    }

    // 入场动画结束：摘掉类并重算滚动（新标签从 0 宽长出来，滚动位置要用最终宽度）
    function finishTabEnter(node) {
        if (!node || !node.classList) return;
        node.classList.remove('is-entering');
        revealActiveTab();
    }

    function updateTabNodes() {
        if (!tabStrip) return;
        tabs.forEach(function (tab) {
            var node = tabStrip.querySelector('[data-panel-tab="' + tab.id + '"]');
            if (!node) return;
            var isActive = tab.id === activeTabId;
            node.classList.toggle('active', isActive);
            node.setAttribute('aria-selected', isActive ? 'true' : 'false');
            var label = tabTitle(tab);
            var title = node.querySelector('.bp-tab-title');
            if (title && title.textContent !== label) {
                title.textContent = label;
                flashTabTitle(node);
            }
            if (node.dataset.tooltip !== label) node.dataset.tooltip = label;
        });
    }

    // 标题真的变了才轻微淡一下（只在上面那个分支里调用，不会逐帧触发）
    function flashTabTitle(node) {
        if (prefersReducedMotion() || !node || !node.classList) return;
        node.classList.add('is-title-updating');
        window.setTimeout(function () {
            node.classList.remove('is-title-updating');
        }, TITLE_FLASH_MS);
    }

    // 标签多了要横向滚动：把当前标签滚进可见区域（只改 scrollLeft，不产生 DOM 变更）
    function revealActiveTab() {
        if (!tabStrip) return;
        var node = tabStrip.querySelector('[data-panel-tab="' + activeTabId + '"]');
        if (!node) return;
        var left = node.offsetLeft - tabStrip.offsetLeft;
        var right = left + node.offsetWidth;
        var target = null;
        if (left < tabStrip.scrollLeft) target = left;
        else if (right > tabStrip.scrollLeft + tabStrip.clientWidth) {
            target = right - tabStrip.clientWidth;
        }
        if (target === null) return;
        if (prefersReducedMotion()) {
            tabStrip.scrollLeft = target;      // 减少动效时直接跳过去
            return;
        }
        try {
            tabStrip.scrollTo({ left: target, behavior: 'smooth' });
        } catch (scrollError) {
            tabStrip.scrollLeft = target;
        }
    }

    // 「+」菜单：已打开的视图（除浏览器）隐藏；浏览器入口只在桥可用时出现
    function syncViewMenuItems() {
        MENU_VIEWS.forEach(function (view) {
            var item = menuItemFor(view);
            if (!item) return;
            if (view === 'browser') {
                setHidden(item, !available);
                return;
            }
            setHidden(item, !!findViewTab(view));
        });
        setHidden(browserViewItem, !available);
        setHidden(homeBrowserEntry, !available);
    }

    // 标签条与「+」：没有任何标签时＝首页空状态，标签与「+」都不显示（视图列表由首页承担）。
    // 关掉最后一个标签时，退场节点还在动画里，标签条要留到它消失为止，否则动画被吞掉。
    function syncPanelChrome() {
        var hasTabs = tabs.length > 0 || hasClosingTabNode();
        setHidden(tabStrip, !hasTabs);
        setHidden(viewMenuButton, !hasTabs);
        if (collapseButton) {
            collapseButton.setAttribute('aria-expanded', isPanelOpen() ? 'true' : 'false');
        }
        updateTabNodes();
        syncViewMenuItems();
    }

    // 面板正在播放过渡（0.3s 的开合/宽度动画）时，覆盖层要跟着走而不是提前消失
    function panelTransitionRunning() {
        var panel = document.getElementById('detailPanel');
        if (!panel || typeof panel.getAnimations !== 'function') return false;
        try {
            return panel.getAnimations({ subtree: true }).some(function (animation) {
                return animation.playState === 'running';
            });
        } catch (animationError) {
            return false;
        }
    }

    function overlayShouldShow() {
        if (menuSuspended || window.MoonYaAttachmentPreview?.isOpen()) return false;
        if (!pane || pane.hidden) return false;
        if (isPanelOpen()) return true;
        // 面板正在收起：继续跟随最后一程，等过渡结束再隐藏
        return lastOverlayShown && panelTransitionRunning();
    }

    function hideOverlay() {
        lastOverlayShown = false;
        lastBoundsJson = '';
        if (overlayHideTimer) {
            window.clearTimeout(overlayHideTimer);
            overlayHideTimer = 0;
        }
        bridgeCallAsync('setVisible', [false]);
    }

    // ── 视口矩形上报（视口比例，避免 DPI/缩放特判）──────────
    function reportBounds() {
        syncPanelChrome();
        if (!available) return;
        syncBrowserVisuals();

        // 菜单展开/退场期间保持覆盖层隐藏，避免菜单被网页视图盖住
        if (menuSuspended || window.MoonYaAttachmentPreview?.isOpen()) {
            bridgeCallAsync('setVisible', [false]);
            return;
        }

        if (!overlayShouldShow()) {
            if (lastOverlayShown || lastBoundsJson) hideOverlay();
            return;
        }

        var rect = viewport.getBoundingClientRect();
        var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
        if (!rect || rect.width < 40 || rect.height < 40) {
            hideOverlay();
            return;
        }

        // The native CEF view is a sibling of the main WebView: DOM top layers
        // cannot cover it. Suspend only when a notification actually overlaps it,
        // using the same visibility bridge as the browser's existing menus.
        if (window.MoonYaNotifications?.overlaps(rect)) {
            if (lastOverlayShown || lastBoundsJson) hideOverlay();
            return;
        }

        var payload = {
            left: rect.left / viewportWidth,
            top: rect.top / viewportHeight,
            width: rect.width / viewportWidth,
            height: rect.height / viewportHeight,
            visible: true
        };
        lastOverlayShown = true;
        // 面板还在收起的过渡里：兜底定时器保证覆盖层最终一定隐藏
        if (!isPanelOpen()) {
            if (!overlayHideTimer) {
                overlayHideTimer = window.setTimeout(function () {
                    overlayHideTimer = 0;
                    if (!overlayShouldShow()) hideOverlay();
                }, OVERLAY_HIDE_FALLBACK_MS);
            }
        } else if (overlayHideTimer) {
            window.clearTimeout(overlayHideTimer);
            overlayHideTimer = 0;
        }
        var json = JSON.stringify(payload);
        if (json === lastBoundsJson) return;
        lastBoundsJson = json;
        bridgeCallAsync('setBounds', [json]);
    }

    window.addEventListener('moonya:notifications', function () { scheduleBounds(); syncBoundsWhileAnimating(); });

    // 过渡/关键帧播放期间逐帧同步矩形：transform 引起的位移不会触发 ResizeObserver，
    // 不主动跟帧的话，面板滑动时网页会"留在原地"。
    function syncBoundsWhileAnimating() {
        if (prefersReducedMotion() || boundsSyncFrame) return;
        var started = 0;
        var lastKey = '';
        var stableFrames = 0;
        var step = function () {
            boundsSyncFrame = window.requestAnimationFrame(function () {
                boundsSyncFrame = 0;
                reportBounds();
                var rect = viewport.getBoundingClientRect();
                var key = Math.round(rect.left) + ',' + Math.round(rect.top) + ','
                    + Math.round(rect.width) + ',' + Math.round(rect.height);
                stableFrames = key === lastKey ? stableFrames + 1 : 0;
                lastKey = key;
                var elapsed = window.performance && window.performance.now
                    ? window.performance.now() - started
                    : BOUNDS_SYNC_MAX_MS;
                if (elapsed >= BOUNDS_SYNC_MAX_MS) return;
                if (stableFrames >= 3 && !panelTransitionRunning()) return;
                step();
            });
        };
        started = window.performance && window.performance.now ? window.performance.now() : 0;
        step();
    }

    function scheduleBounds() {
        if (pendingFrame) return;
        pendingFrame = window.requestAnimationFrame(function () {
            pendingFrame = 0;
            reportBounds();
        });
    }

    // ── 下拉菜单 + 覆盖层挂起 ───────────────────────────────
    // 入场：is-open 播 keyframes；退场：is-closing 播完再置 hidden。
    // 覆盖层挂起要一直持续到退场结束，否则网页会盖住正在淡出的菜单（"啪"地一下）。
    function endMenuClose(menu, resume) {
        if (!menu) return;
        if (closingMenu === menu) {
            if (menuCloseTimer) {
                window.clearTimeout(menuCloseTimer);
                menuCloseTimer = 0;
            }
            closingMenu = null;
        }
        menu.classList.remove('is-open', 'is-closing');
        setHidden(menu, true);
        // 只有确实没有菜单在显示时才恢复覆盖层，否则会把新开的菜单盖住
        if (resume && !openMenuElement && menuSuspended) {
            menuSuspended = false;
            lastBoundsJson = '';
            scheduleBounds();
            syncBoundsWhileAnimating();
        }
    }

    function closeMenu() {
        var menu = openMenuElement;
        if (!menu) return;
        var trigger = menu === viewMenu ? viewMenuButton
            : (menu === browserMenu ? browserMenuButton : null);
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        openMenuElement = null;                 // 立刻允许开新菜单；挂起状态保持到退场结束
        if (prefersReducedMotion()) {
            endMenuClose(menu, true);
            return;
        }
        menu.classList.remove('is-open');
        menu.classList.add('is-closing');
        closingMenu = menu;
        var finished = false;
        var finish = function () {
            if (finished) return;
            finished = true;
            menu.removeEventListener('animationend', onAnimationEnd);
            endMenuClose(menu, true);
        };
        var onAnimationEnd = function (event) {
            if (event.target === menu) finish();
        };
        menu.addEventListener('animationend', onAnimationEnd);
        if (menuCloseTimer) window.clearTimeout(menuCloseTimer);
        menuCloseTimer = window.setTimeout(finish, MENU_EXIT_MS + 40);
    }

    function openMenu(menu, trigger) {
        if (!menu) return;
        if (openMenuElement === menu) { closeMenu(); return; }
        // 正在退场的旧菜单立即收尾（但不恢复覆盖层），避免它的定时器把覆盖层提前放出来
        if (closingMenu && closingMenu !== menu) endMenuClose(closingMenu, false);
        // 快速"关→开"同一个菜单：撤掉退场动画继续用
        if (closingMenu === menu) {
            if (menuCloseTimer) {
                window.clearTimeout(menuCloseTimer);
                menuCloseTimer = 0;
            }
            closingMenu = null;
            menu.classList.remove('is-closing');
        }
        menuSuspended = true;
        setHidden(menu, false);
        menu.classList.add('is-open');
        openMenuElement = menu;
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
        // 视图菜单挂在「+」下面（标签数量可变，位置只能算）
        if (menu === viewMenu && trigger) positionViewMenu(trigger);
        // 立即挂起覆盖层，菜单条目才不会被网页盖住
        bridgeCallAsync('setVisible', [false]);
        var firstItem = menu.querySelector('.bp-menu-item:not([hidden])');
        if (firstItem) firstItem.focus();
    }

    function positionViewMenu(trigger) {
        var tabbar = document.getElementById('panelTabbar');
        if (!tabbar || !viewMenu) return;
        var maxLeft = Math.max(8, tabbar.clientWidth - viewMenu.offsetWidth - 8);
        var left = Math.min(Math.max(8, trigger.offsetLeft), maxLeft);
        viewMenu.style.left = left + 'px';
    }

    function focusMenuItem(menu, offset) {
        var items = Array.prototype.slice.call(menu.querySelectorAll('.bp-menu-item'))
            .filter(function (item) { return !item.hidden; });
        if (!items.length) return;
        var index = items.indexOf(document.activeElement);
        var next = index < 0 ? 0 : (index + offset + items.length) % items.length;
        items[next].focus();
    }

    function wireMenus() {
        if (viewMenuButton && viewMenu) {
            viewMenuButton.addEventListener('click', function (event) {
                event.stopPropagation();
                openMenu(viewMenu, viewMenuButton);
            });
        }
        if (browserMenuButton && browserMenu) {
            browserMenuButton.addEventListener('click', function (event) {
                event.stopPropagation();
                openMenu(browserMenu, browserMenuButton);
            });
        }

        [viewMenu, browserMenu].forEach(function (menu) {
            if (!menu) return;
            menu.addEventListener('click', function (event) { event.stopPropagation(); });
            menu.addEventListener('keydown', function (event) {
                if (event.key === 'ArrowDown') { event.preventDefault(); focusMenuItem(menu, 1); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); focusMenuItem(menu, -1); }
                else if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMenu();
                    if (viewMenuButton) viewMenuButton.focus();
                }
            });
            menu.querySelectorAll('.bp-menu-item').forEach(function (item, index) {
                // 菜单项错峰入场的下标（只写一次；style 不在 MutationObserver 的过滤里）
                item.style.setProperty('--i', String(index));
                item.addEventListener('click', function () {
                    var action = item.dataset.bpAction || '';
                    var view = item.dataset.teamTab || '';
                    closeMenu();                 // 先恢复覆盖层，再执行动作
                    // activateView 触发的重复点击：视图已经由 script-1e 切好了，不再开标签
                    if (activating) return;
                    if (view) openTab(view);
                    else if (action) runBrowserAction(action);
                    window.setTimeout(scheduleBounds, 60);
                });
            });
        });

        // 首页列表就是"没有标签时"的视图入口
        var homePane = document.getElementById('teamPaneHome');
        if (homePane) {
            homePane.addEventListener('click', function (event) {
                if (activating) return;
                var item = event.target.closest ? event.target.closest('[data-team-tab]') : null;
                if (!item) return;
                closeMenu();
                openTab(item.dataset.teamTab || '');
            });
        }

        document.addEventListener('pointerdown', function (event) {
            if (!openMenuElement) return;
            if (openMenuElement.contains(event.target)) return;
            if (event.target === viewMenuButton || event.target === browserMenuButton) return;
            closeMenu();
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && openMenuElement) {
                event.preventDefault();
                closeMenu();
            }
        });
    }

    // ── 标签条交互 ─────────────────────────────────────────
    function wireTabs() {
        if (!tabStrip) return;
        tabStrip.addEventListener('click', function (event) {
            var closer = event.target.closest ? event.target.closest('[data-panel-tab-close]') : null;
            if (closer) {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                closeTab(Number(closer.dataset.panelTabClose));
                return;
            }
            var node = event.target.closest ? event.target.closest('[data-panel-tab]') : null;
            if (!node) return;
            closeMenu();
            activateTab(Number(node.dataset.panelTab));
        });
        tabStrip.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            var node = event.target.closest ? event.target.closest('[data-panel-tab]') : null;
            if (!node) return;
            event.preventDefault();
            activateTab(Number(node.dataset.panelTab));
        });
        // 中键关闭（浏览器习惯）
        tabStrip.addEventListener('auxclick', function (event) {
            if (event.button !== 1) return;
            var node = event.target.closest ? event.target.closest('[data-panel-tab]') : null;
            if (!node) return;
            event.preventDefault();
            closeTab(Number(node.dataset.panelTab));
        });
        // 入场动画收尾（摘类 + 用最终宽度重算滚动位置）
        tabStrip.addEventListener('animationend', function (event) {
            if (event.animationName !== 'bp-tab-in') return;
            finishTabEnter(event.target);
        });
    }

    // ── 浏览器动作（⋮ 菜单与快捷键共用）───────────────────
    function runBrowserAction(action) {
        switch (action) {
            case 'new-tab':
                openTab('browser');
                break;
            case 'reload':
                bridgeCallAsync('action', ['reload']);
                break;
            case 'copy-url':
                bridgeCallAsync('copyUrl', []);
                break;
            case 'open-external':
                bridgeCallAsync('state', []).then(function (stateRaw) {
                    var state = parseJson(stateRaw);
                    var target = state && state.url ? state.url : '';
                    if (target) bridgeCallAsync('openExternal', [target]);
                });
                break;
            case 'close-panel':
                closePanel();
                break;
            case 'clear-log':
                clickById('detailPanelClear');
                break;
            case 'zoom-in':
            case 'zoom-out':
            case 'zoom-reset':
                bridgeCallAsync('action', [action]);
                break;
            default:
                break;
        }
    }

    // 关闭工作面板 / 清空日志：复用首页列表里的既有按钮 id（script-1e 已绑定监听器）
    function clickById(id) {
        var element = document.getElementById(id);
        if (element) element.click();
    }

    function closePanel() {
        clickById('detailPanelClose');
    }

    // ── 面板宽度展开 / 折叠 ────────────────────────────────
    function currentPanelWidth() {
        var panel = document.getElementById('detailPanel');
        if (!panel) return 0;
        var inline = parseFloat(panel.style.getPropertyValue('--team-panel-width'));
        if (isFinite(inline) && inline > 0) return inline;
        var measured = panel.getBoundingClientRect().width;
        return isFinite(measured) && measured > 0 ? measured : 0;
    }

    // 左侧边栏当前占用的宽度（折叠时为 0）。script-1d 的布局在空间不足时会自动折叠侧边栏，
    // 而右侧「展开面板」不该顺手收起用户的侧边栏，所以上限要按侧边栏当前状态扣除。
    function expandedSidebarWidth() {
        var sidebar = document.getElementById('sidebar');
        if (!sidebar || sidebar.classList.contains('collapsed')) return 0;
        var width = Math.round(sidebar.getBoundingClientRect().width);
        return isFinite(width) && width > 0 ? Math.max(240, width) : 0;
    }

    function maximumPanelWidth() {
        var container = document.querySelector('.container');
        if (!container) return 0;
        return Math.max(360, container.clientWidth - (document.querySelector('.app-rail')?.getBoundingClientRect().width || 0) - DIVIDER_WIDTH - MIN_CHAT_WIDTH - expandedSidebarWidth());
    }

    function toggleExpandPanel() {
        var layout = window.moonyaSplitLayout;
        if (!layout || typeof layout.setPanelWidth !== 'function') return;
        var target = maximumPanelWidth();
        var width = currentPanelWidth();
        // 侧边栏展开时"上限"可能就是当前宽度：这时第一次点击改为收回到默认宽度，
        // 否则按钮看起来像"点了没反应"（且永远不会去动左侧边栏）。
        if (!expandedPanel && width >= target - 4) {
            previousPanelWidth = width;
            layout.setPanelWidth(DEFAULT_PANEL_WIDTH, true);
            expandedPanel = false;
        } else if (!expandedPanel) {
            previousPanelWidth = width;
            layout.setPanelWidth(target, true);
            expandedPanel = true;
        } else {
            layout.setPanelWidth(previousPanelWidth || DEFAULT_PANEL_WIDTH, true);
            expandedPanel = false;
        }
        if (expandButton) {
            expandButton.setAttribute('aria-pressed', expandedPanel ? 'true' : 'false');
            expandButton.dataset.tooltip = expandedPanel ? '还原面板宽度' : '展开面板';
        }
        scheduleBounds();
    }

    // ── C# 推送的面板状态 ──────────────────────────────────
    function applyBrowserState(state) {
        if (addressInput && document.activeElement !== addressInput) {
            addressInput.value = state.is_start_page ? '' : (state.url || '');
        }
        if (backButton) backButton.disabled = !state.can_go_back;
        if (forwardButton) forwardButton.disabled = !state.can_go_forward;

        var loading = !!state.is_loading;
        if (reloadButton) {
            reloadButton.classList.toggle('is-loading', loading);
            reloadButton.dataset.tooltip = loading ? '停止加载' : '刷新';
            reloadButton.setAttribute('aria-label', loading ? '停止加载' : '刷新');
        }
        if (zoomHint) {
            var zoomText = (state.zoom_percent || 100) + '%';
            if (zoomHint.textContent !== zoomText) zoomHint.textContent = zoomText;
        }

        // 当前活动的浏览器标签跟随内核（用户/Agent 在网页里跳转时标签标题也要更新）
        var tab = activeBrowserTab();
        if (tab) {
            tab.url = state.is_start_page ? '' : (state.url || '');
            tab.title = state.is_start_page ? '' : (state.title || state.url || '');
        }
        syncPanelChrome();
    }

    window.moonyaBrowserPanelState = function (state) {
        if (!state) return;
        lastPanelState = state;
        applyBrowserState(state);
    };

    // ── 地址栏输入规则：URL 直连，其余交给搜索引擎 ─────────
    function normalizeAddress(raw) {
        var value = (raw || '').trim();
        if (!value) return '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
        if (/\s/.test(value) || value.indexOf('.') === -1) {
            return 'https://www.bing.com/search?q=' + encodeURIComponent(value);
        }
        return 'https://' + value;
    }

    function submitAddress() {
        var entered = addressInput ? addressInput.value.trim() : '';
        if (!entered) return;
        var url = normalizeAddress(entered);
        if (!url) return;
        // 输入与原地址相同也照常导航（等价于刷新），避免点击箭头像"没反应"
        var tab = activeBrowserTab();
        if (tab) {
            tab.url = url;
            tab.title = '';
            updateTabNodes();
        }
        bridgeCallAsync('navigate', [url]);
    }

    function wireToolbar() {
        if (backButton) backButton.addEventListener('click', function () { bridgeCallAsync('action', ['back']); });
        if (forwardButton) forwardButton.addEventListener('click', function () { bridgeCallAsync('action', ['forward']); });
        if (reloadButton) {
            reloadButton.addEventListener('click', function () {
                var stopped = reloadButton.classList.contains('is-loading');
                bridgeCallAsync('action', [stopped ? 'stop' : 'reload']);
            });
        }
        if (goButton) goButton.addEventListener('click', submitAddress);
        if (handoffCompleteButton) {
            handoffCompleteButton.addEventListener('click', function () {
                if (handoffCompleteButton.disabled || typeof window.moonyaCompleteUserAction !== 'function') return;
                handoffCompleteButton.disabled = true;
                handoffCompleteButton.textContent = '处理中…';
                Promise.resolve(window.moonyaCompleteUserAction()).then(function (ok) {
                    if (ok === false && window.__moonyaBrowserHandoff) applyBrowserHandoff(window.__moonyaBrowserHandoff);
                });
            });
        }
        if (expandButton) expandButton.addEventListener('click', toggleExpandPanel);
        if (collapseButton) {
            collapseButton.addEventListener('click', function () {
                closeMenu();
                // 折叠整个工作面板；再展开走顶栏的「操作详情」按钮
                closePanel();
            });
        }
        if (addressInput) {
            addressInput.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                submitAddress();
            });
            addressInput.addEventListener('focus', function () { addressInput.select(); });
        }
    }

    // ── 快捷键 ─────────────────────────────────────────────
    // 视图/标签切换不绑定快捷键（按需求）；只保留浏览器标签的 Ctrl 组合键，且都在浏览器视图才生效。
    function wireShortcuts() {
        document.addEventListener('keydown', function (event) {
            if (!event.ctrlKey || event.altKey || event.metaKey) return;
            if (!isPanelOpen()) return;
            if (openMenuElement && event.key === 'Escape') return;
            if (!isBrowserViewActive()) return;

            var key = (event.key || '').toLowerCase();
            var action = '';
            if (key === 't') action = 'new-tab';
            else if (key === 'r') action = 'reload';
            else if (key === 'w') action = 'close-panel';
            else if (key === '=' || key === '+') action = 'zoom-in';
            else if (key === '-') action = 'zoom-out';
            else if (key === '0') action = 'zoom-reset';
            if (!action) return;

            event.preventDefault();
            closeMenu();
            runBrowserAction(action);
        });
    }

    function wireTeamEvents() {
        // 多 Agent 团队事件协议已移除。
    }

    // ── 页面布局变化 → 重新上报矩形 ────────────────────────
    function observeLayout() {
        var detailPanel = document.getElementById('detailPanel');
        if (detailPanel && typeof MutationObserver === 'function') {
            // 只有"视图切换"才收起菜单：菜单自身的显隐也落在这个被观察的子树里，
            // 若无条件 closeMenu()，点开「+」的同一帧就会被观察者关掉（表现为"点了没反应"）。
            var lastObservedView = activePanelView();
            var observer = new MutationObserver(function () {
                var view = activePanelView();
                if (view !== lastObservedView) {
                    lastObservedView = view;
                    closeMenu();
                }
                if (!isBrowserViewActive()) {
                    reportBounds();
                    // 面板正在收起时继续让覆盖层跟随最后一程
                    syncBoundsWhileAnimating();
                    return;
                }
                scheduleBounds();
            });
            observer.observe(detailPanel, {
                attributes: true,
                attributeFilter: ['class', 'hidden'],
                subtree: true,
                childList: true
            });
        }

        if (typeof ResizeObserver === 'function') {
            var resizeObserver = new ResizeObserver(function () {
                if (isBrowserViewActive()) scheduleBounds();
            });
            resizeObserver.observe(viewport);
            if (detailPanel) resizeObserver.observe(detailPanel);
        }

        window.addEventListener('resize', function () {
            if (isBrowserViewActive()) scheduleBounds();
        });
        // 页面缩放/滚动同样会改变矩形
        window.addEventListener('scroll', function () {
            if (isBrowserViewActive()) scheduleBounds();
        }, true);
    }

    // 过渡/关键帧开始 → 逐帧几何同步。面板的 0.3s 开合用 transform 位移，
    // 不会触发 ResizeObserver，必须主动跟帧，否则网页会"留在原地"。
    function wireMotionSync() {
        var panel = document.getElementById('detailPanel');
        if (!panel) return;
        var geometryProps = [
            'transform', 'width', 'max-width', 'min-width', 'padding',
            'padding-left', 'padding-right', 'flex-basis', 'left', 'top', 'margin', 'margin-right'
        ];
        panel.addEventListener('transitionstart', function (event) {
            if (event.propertyName && geometryProps.indexOf(event.propertyName) === -1) return;
            syncBoundsWhileAnimating();
        });
        panel.addEventListener('animationstart', function () {
            syncBoundsWhileAnimating();
        });
        // 面板自身的过渡收尾后再校准一次可见性（收起结束=覆盖层该隐藏了）
        panel.addEventListener('transitionend', function (event) {
            if (event.target !== panel) return;
            scheduleBounds();
        });
    }

    function ensureReadableWidth() {
        if (widenApplied) return;
        widenApplied = true;
        var panel = document.getElementById('detailPanel');
        if (!panel) return;
        var width = panel.getBoundingClientRect().width;
        if (width >= MIN_READABLE_WIDTH) return;
        // 上限按侧边栏当前状态扣除：宁可网页窄一点，也不替用户收起左侧边栏
        var target = Math.min(WIDEN_TARGET_WIDTH, maximumPanelWidth());
        if (!(target > width)) return;
        if (window.moonyaSplitLayout && typeof window.moonyaSplitLayout.setPanelWidth === 'function') {
            try { window.moonyaSplitLayout.setPanelWidth(target, true); } catch (error) {}
        }
    }

    // ── 供 C# 调用的入口（Agent 启动浏览器会话时自动展开面板）──
    window.moonyaOpenBrowserPanel = function (options) {
        if (!available) return false;
        if (options && options.visual_generation !== undefined && options.visual_generation !== visualResetGeneration) return false;
        if (!isPanelOpen()) {
            // #detailToggleContainer 已随顶部工具栏改造从页面移除，
            // 优先走 setDetailPanelOpen 的全局导出，旧入口仅作兜底。
            if (typeof window.moonyaSetDetailPanelOpen === 'function') {
                window.moonyaSetDetailPanelOpen(true);
            } else {
                var legacyToggle = document.getElementById('detailToggleContainer');
                if (legacyToggle) legacyToggle.click();
            }
        }
        var existing = activeBrowserTab() || findViewTab('browser');
        if (existing) activateTab(existing.id);
        else openTab('browser');
        var tab = activeBrowserTab();
        if (tab && options && (options.source === 'automation' || options.source === 'handoff')) {
            tab.automationVisuals = true;
            syncBrowserVisuals();
        }
        ensureReadableWidth();
        window.setTimeout(function () { scheduleBounds(); }, 80);
        return true;
    };

    function applyBrowserHandoff(pending) {
        if (!handoffCompleteButton) return;
        handoffCompleteButton.hidden = !pending;
        handoffCompleteButton.disabled = !!(pending && pending.deciding);
        handoffCompleteButton.textContent = pending && pending.deciding ? '处理中…' : '确认完成';
        if (!pending?.deciding) handoffCompleteButton.insertAdjacentHTML('afterbegin', window.MoonYaIcons.icon('check'));
    }

    window.moonyaSetBrowserHandoff = applyBrowserHandoff;
    applyBrowserHandoff(window.__moonyaBrowserHandoff || null);

    function markUnavailable() {
        available = false;
        var hadBrowserTab = !!findViewTab('browser');
        tabs = tabs.filter(function (tab) { return tab.view !== 'browser'; });
        if (hadBrowserTab) {
            // 内核不可用时不能停在浏览器标签上
            if (tabs.length) {
                activeTabId = 0;
                activateTab(tabs[tabs.length - 1].id);
            } else {
                activeTabId = 0;
                goHome();
            }
        }
        setHidden(placeholder, false);
        renderTabs();
        syncPanelChrome();
    }

    window.addEventListener('moonya:attachment-preview', event => {
        if (event.detail.open) hideOverlay(); else reportBounds();
    });

    function onBridgeReady() {
        bridgeCallAsync('info', []).then(function (infoRaw) {
            var info = parseJson(infoRaw);
            if (!info || !info.available) {
                markUnavailable();
                return;
            }
            available = true;
            lastVisualState = '';
            syncBrowserVisuals();
            setHidden(placeholder, true);
            syncPanelChrome();

            bridgeCallAsync('state', []).then(function (stateRaw) {
                var state = parseJson(stateRaw);
                if (state) {
                    lastPanelState = state;
                    applyBrowserState(state);
                }
            });
            reportBounds();
        });
    }

    function bindBridge() {
        if (bridge) return;
        if (typeof CefSharp === 'undefined' || !CefSharp.BindObjectAsync) {
            markUnavailable();
            return;
        }
        bindAttempts += 1;
        CefSharp.BindObjectAsync(BRIDGE_NAME).then(function () {
            bridge = window[BRIDGE_NAME];
            if (!bridge) {
                // 绑定尚未生效，稍后重试（页面早期加载时常见）
                bridge = null;
                if (bindAttempts < 12) window.setTimeout(bindBridge, 400);
                return;
            }
            onBridgeReady();
        }).catch(function () {
            bridge = null;
            if (bindAttempts < 12) window.setTimeout(bindBridge, 400);
            else markUnavailable();
        });
    }

    // ── 初始化 ─────────────────────────────────────────────
    // 首页标记（#teamTabHome）在标记里带 selected：onload 时"没有标签"即首页空状态
    activeTabId = 0;
    renderTabs();
    wireTabs();
    wireToolbar();
    wireMenus();
    wireShortcuts();
    wireTeamEvents();
    wireMotionSync();
    observeLayout();
    syncPanelChrome();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindBridge);
    } else {
        bindBridge();
    }
    // 兜底重试：确保桥在 CefSharp 初始化完成后仍能绑定
    window.setTimeout(bindBridge, 1200);
    window.setTimeout(bindBridge, 3000);
})();
