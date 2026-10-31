<?php
header('Cache-Control: no-store');
header("Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
$runtimeConfig = require dirname(__DIR__) . '/config.php';
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>用户管理后台</title>
    <link rel="stylesheet" href="assets/admin-ui.css?v=<?= filemtime(__DIR__ . '/assets/admin-ui.css') ?>">
<link rel="stylesheet" href="assets/payment-settings.css?v=<?= filemtime(__DIR__ . '/assets/payment-settings.css') ?>">
</head>

<body class="admin-body">
    <div id="alert" class="alert"></div>

    <div class="main-wrapper">
        <aside class="sidebar">
            <div class="sidebar-brand">
                <svg width="28" height="28" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right:10px;flex-shrink:0;">
                    <defs>
                        <linearGradient id="moonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#3b82f6"/>
                            <stop offset="100%" stop-color="#1d4ed8"/>
                        </linearGradient>
                    </defs>
                    <circle cx="18" cy="18" r="17" fill="url(#moonGrad)"/>
                    <path d="M21 9C15.48 9 11 13.48 11 19c0 5.52 4.48 10 10 10 1.25 0 2.44-.24 3.54-.66-4.64-1.32-8.04-5.55-8.04-10.59 0-4.8 3.12-8.87 7.45-10.36-.62-.24-1.28-.39-1.95-.39z" fill="#ffffff"/>
                    <circle cx="24.5" cy="11.5" r="2" fill="#93c5fd" opacity="0.8"/>
                </svg>
                <span>MoonYa Admin</span>
            </div>
            <nav class="sidebar-nav">
                <a class="nav-item active" data-section="home" href="javascript:void(0)" onclick="switchSection('home')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></span>
                    <span>首页</span>
                </a>
                <a class="nav-item" data-section="membershipPlans" href="javascript:void(0)" onclick="switchSection('membershipPlans')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg></span>
                    <span>会员套餐</span>
                </a>
                <a class="nav-item" data-section="membershipOrders" href="javascript:void(0)" onclick="switchSection('membershipOrders')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="12" x2="12" y2="21"/><path d="m6 3 6 9 6-9"/><line x1="7" y1="14" x2="17" y2="14"/><line x1="7" y1="17" x2="17" y2="17"/></svg></span>
                    <span>会员订单</span>
                </a>
                <a class="nav-item" id="paymentSettingsNav" data-section="paymentSettings" href="javascript:void(0)" onclick="switchSection('paymentSettings')" hidden>
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></span>
                    <span>支付配置</span>
                </a>
                <a class="nav-item" data-section="builtinModels" href="javascript:void(0)" onclick="switchSection('builtinModels')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg></span>
                    <span>内置模型</span>
                </a>
                <a class="nav-item" data-section="users" href="javascript:void(0)" onclick="switchSection('users')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
                    <span>用户</span>
                </a>
                <a class="nav-item" data-section="systemPrompts" href="javascript:void(0)" onclick="switchSection('systemPrompts')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h6"/></svg></span>
                    <span>系统提示词</span>
                </a>
                <a class="nav-item" data-section="skills" href="javascript:void(0)" onclick="switchSection('skills')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
                    <span>技能</span>
                </a>
                <a class="nav-item" data-section="hotTopics" href="javascript:void(0)" onclick="switchSection('hotTopics')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg></span>
                    <span>热点</span>
                </a>
                <a class="nav-item" data-section="siteSettings" href="javascript:void(0)" onclick="switchSection('siteSettings')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
                    <span>搜索设置</span>
                </a>
                <a class="nav-item" data-section="updates" href="javascript:void(0)" onclick="switchSection('updates')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></span>
                    <span>更新程序</span>
                </a>
                <a class="nav-item" data-section="themes" href="javascript:void(0)" onclick="switchSection('themes')">
                    <span class="nav-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="19" cy="17" r="2.5"/><circle cx="6" cy="12" r="2.5"/><path d="M11.6 8.2 7.8 10.6M16.9 15.3l-8.6-2.7"/></svg></span>
                    <span>内置主题</span>
                </a>
                <a class="nav-item" data-section="announcements" href="javascript:void(0)" onclick="switchSection('announcements')"><span class="nav-icon">◇</span><span>公告管理</span></a>
            </nav>
            <div class="sidebar-promo">
                <div class="sidebar-promo-inner">
                    <div class="sidebar-promo-art">
                        <img src="assets/images/promo-sphere.png" alt="MoonYa AI" class="sidebar-promo-img">
                    </div>
                    <div class="sidebar-promo-text">
                        <div class="sidebar-promo-title">MoonYa AI</div>
                        <div class="sidebar-promo-sub">让 AI 更简单高效</div>
                        <div class="sidebar-promo-ver">v1.0.0</div>
                    </div>
                </div>
            </div>
        </aside>

        <div class="content-area" style="flex:1;display:flex;flex-direction:column;min-width:0;">
            <header class="topbar">
                <div class="topbar-left">
                    <button class="btn-ghost sidebar-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    </button>
                    <div class="topbar-search">
                        <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" class="topbar-search-input" placeholder="搜索功能、用户或内容..." id="globalSearchInput" onkeydown="if(event.key==='Enter')handleGlobalSearch(this.value)">
                    </div>
                    <span id="topbarTitle" style="display:none;">Dashboard</span>
                </div>
                <div class="topbar-actions">
                    <button class="topbar-icon-btn" title="通知" type="button">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                        <span class="badge-dot"></span>
                    </button>
                    <div class="user-profile-menu">
                        <div class="user-avatar-circle" id="userAvatarBadge">Y</div>
                        <span class="user-profile-name" id="adminInfo">欢迎，Admin</span>
                        <svg class="dropdown-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        <div class="user-dropdown">
                            <a href="javascript:void(0)" onclick="logout()" class="dropdown-item">退出登录</a>
                        </div>
                    </div>
                </div>
            </header>

            <main class="main-content">
        <?php
        $dashboard_dir = __DIR__ . '/../script/dashboard';
        include $dashboard_dir . '/home.php';
        include $dashboard_dir . '/users.php';
        include $dashboard_dir . '/membership.php';
        include $dashboard_dir . '/payment_settings.php';
        include $dashboard_dir . '/system_prompts.php';
        include $dashboard_dir . '/skills.php';
        include $dashboard_dir . '/hot_topics.php';
        include $dashboard_dir . '/site_settings.php';
        include $dashboard_dir . '/updates.php';
        include $dashboard_dir . '/themes.php';
        include $dashboard_dir . '/announcements.php';
        ?>
            </main>
        </div>
    </div>
<div id="modal" class="modal"><div class="modal-content" id="modalContent"></div></div>

<script>
        let token = localStorage.getItem('adminToken');
        let adminInfo = JSON.parse(localStorage.getItem('adminInfo') || '{}');
        document.getElementById('paymentSettingsNav').hidden = adminInfo.role !== 'super_admin';
        let currentPage = 1;
        let currentFilters = {};
        let currentSection = 'home';
        
        if (!token) {
            window.location.href = 'login.php';
        }
        
        document.getElementById('adminInfo').textContent = `欢迎，${adminInfo.username}`;
        
        function switchSection(section) {
            if(section==='paymentSettings' && adminInfo.role!=='super_admin')section='home';
            if(currentSection==='paymentSettings' && section!=='paymentSettings')window.paymentSettings?.leave();
            if(window.innerWidth<=1024)document.querySelector('.sidebar').classList.remove('open');
            currentSection = section;
            
            // 更新菜单样式
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('active');
            });
            document.querySelector(`.nav-item[data-section="${section}"]`).classList.add('active');
            
            // 显示对应内容
            document.querySelectorAll('.content-section').forEach(sec => {
                sec.classList.remove('active');
            });
            document.getElementById(section + 'Section').classList.add('active');
            const titles = {announcements:'公告管理',updates:'更新程序',themes:'内置主题',paymentSettings:'支付配置',membershipOrders:'会员订单',membershipPlans:'会员套餐',builtinModels:'内置模型',home:'Dashboard',users:'用户管理',systemPrompts:'系统提示词模板',skills:'技能',hotTopics:'热点管理',siteSettings:'通用设置'};
            const topbarTitle = document.getElementById('topbarTitle');
            if(topbarTitle) topbarTitle.textContent = titles[section] || 'Dashboard';
            
            // 加载数据
            if (section === 'announcements') { window.announcements?.load();
            } else if (section === 'updates') { window.programUpdates?.load();
            } else if (section === 'themes') { window.builtinThemes?.load();
            } else if (section === 'paymentSettings') { window.paymentSettings?.load();
            } else if (section === 'membershipPlans') { loadMembershipPlans();
            } else if (section === 'membershipOrders') { loadMembershipOrders();
            } else if (section === 'builtinModels') { loadBuiltinModels();
            } else if (section === 'home') {
                loadStats();
            } else if (section === 'users') {
                loadUsers();
            } else if (section === 'systemPrompts') {
                loadSystemPrompts();
            } else if (section === 'skills') {
                loadSkills();
            } else if (section === 'hotTopics') {
                loadHotTopics();
            } else if (section === 'siteSettings') {
                loadSiteSettings();
            }
        }
        function showAlert(type, message) {
            if (message === undefined) {
                message = type;
                type = 'success';
            }
            const alertDiv = document.getElementById('alert');
            if (!alertDiv) return;
            alertDiv.className = 'alert alert-' + type + ' show';
            alertDiv.textContent = message;
            setTimeout(() => {
                alertDiv.className = 'alert';
            }, 3000);
        }
        function logout() {
            localStorage.removeItem('adminToken');
            localStorage.removeItem('adminInfo');
            window.location.href = 'login.php';
        }
        async function apiRequest(endpoint, options = {}) {
            const url = `api/users.php${endpoint}`;
            
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                const method = options.method || 'GET';
                
                xhr.open(method, url, true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                
                xhr.onload = function() {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('解析响应失败'));
                    }
                };
                
                xhr.onerror = function() {
                    reject(new Error('网络请求失败'));
                };
                
                if (options.body) {
                    xhr.send(options.body);
                } else {
                    xhr.send();
                }
            });
        }
        function getApiBaseUrl() {
            const protocol = window.location.protocol;
            const host = window.location.host;
            const adminDir = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));
            return protocol + '//' + host + adminDir;
        }


        // Generic modal helpers used by multiple modules
        function showModal(content, options = {}) {
            document.getElementById('modalContent').innerHTML = content;
            const modal = document.getElementById('modal');
            modal.classList.add('show');
            // 仅允许显式指定 dismissByMask: true 时点击遮罩关闭；默认只有点击叉号才能关闭弹窗
            modal.dataset.dismissByMask = (options.dismissByMask === true) ? 'true' : 'false';
            modal.classList.toggle('modal-wide', options.wide === true);
            modal.classList.toggle('modal-model-editor', options.modelEditor === true || !!document.getElementById('modalContent').querySelector('.model-editor-modal'));
            modal.classList.toggle('modal-clean-dialog', options.cleanDialog === true || !!document.getElementById('modalContent').querySelector('.clean-dialog'));
        }

        function hideModal() {
            const modal = document.getElementById('modal');
            modal.classList.remove('show');
            modal.classList.remove('modal-wide');
            modal.classList.remove('modal-model-editor');
            modal.classList.remove('modal-clean-dialog');
        }

        // Pagination helper used by multiple modules
        function renderPagination(containerId, pagination, loadFn) {
            const div = document.getElementById(containerId);
            if (!div) return;
            if (!pagination || pagination.pages <= 1) {
                div.innerHTML = '';
                div.style.display = 'none';
                return;
            }
            div.style.display = 'flex';
            div.innerHTML = '';

            const current = pagination.current_page || 1;
            const pages = pagination.pages;
            const loadCallback = typeof loadFn === 'function' ? loadFn : (page) => {
                if (typeof window[loadFn] === 'function') window[loadFn](page);
            };

            function createPageBtn(label, page, disabled, isActive) {
                const btn = document.createElement('button');
                btn.className = 'page-btn' + (isActive ? ' active' : '');
                btn.textContent = label;
                btn.disabled = !!disabled;
                if (!disabled) {
                    btn.addEventListener('click', () => loadCallback(page));
                }
                return btn;
            }

            div.appendChild(createPageBtn('上一页', current - 1, current <= 1));

            for (let i = 1; i <= pages; i++) {
                if (i === 1 || i === pages || (i >= current - 2 && i <= current + 2)) {
                    div.appendChild(createPageBtn(String(i), i, false, i === current));
                } else if (i === current - 3 || i === current + 3) {
                    const span = document.createElement('span');
                    span.className = 'page-ellipsis';
                    span.textContent = '...';
                    div.appendChild(span);
                }
            }

            div.appendChild(createPageBtn('下一页', current + 1, current >= pages));
        }

        // HTML escape helper used by multiple modules
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        document.getElementById('modal').addEventListener('click', function(e) {
            // 只有点击叉号才能关闭弹窗：遮罩点击默认不做任何关闭操作
            if (e.target === this && this.dataset.dismissByMask === 'true') {
                hideModal();
            }
        });

        // 拦截 ESC 键：默认禁止 ESC 关闭弹窗，只有点击叉号才能关闭
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                const modal = document.getElementById('modal');
                if (modal.classList.contains('show') && modal.dataset.dismissByMask !== 'true') {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        });

        // Initialize
        // 初始化加载首页数据
        // 支持 ?section=xxx 深链（独立子页面的侧边栏跳转）
        function initializeDashboard() {
            const validSections = ['home','users','systemPrompts','skills','hotTopics','siteSettings','membershipPlans','membershipOrders','builtinModels','paymentSettings','updates','themes','announcements'];
            const requested = new URLSearchParams(window.location.search).get('section');
            switchSection(validSections.indexOf(requested) !== -1 ? requested : 'home');
        }
    </script>
<script src="assets/membership-admin.js?v=<?= filemtime(__DIR__ . '/assets/membership-admin.js') ?>"></script>
<script src="assets/payment-settings.js?v=<?= filemtime(__DIR__ . '/assets/payment-settings.js') ?>"></script>
<script>initializeDashboard();</script>
</body>
</html>
