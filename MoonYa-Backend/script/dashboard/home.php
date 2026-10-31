<div id="homeSection" class="content-section active">
    <div class="dash-header-wrap">
        <div class="dash-header-left">
            <div class="dash-eyebrow">Dashboard</div>
            <h1 class="dash-title" id="welcomeTitle">欢迎回来，Admin</h1>
            <p class="dash-subtitle">今天也是充满可能性的一天，继续打造更好的 AI 体验吧！</p>
        </div>
        <div class="dash-banner-art">
            <img src="assets/images/dashboard-banner-3d.png" alt="More Possibilities with AI" class="dash-banner-img">
        </div>
    </div>

    <div class="stats-grid-3">
        <div class="stat-card-modern">
            <div class="stat-card-left">
                <div class="stat-icon-wrap icon-blue">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="stat-info">
                    <div class="stat-value" id="totalUsers">12</div>
                    <div class="stat-label">总用户数</div>
                    <div class="stat-trend trend-up">
                        <span>↑</span> +12%
                    </div>
                </div>
            </div>
            <div class="mini-chart mini-chart-blue">
                <span style="height: 40%"></span>
                <span style="height: 60%"></span>
                <span style="height: 35%"></span>
                <span style="height: 80%"></span>
                <span style="height: 100%"></span>
            </div>
        </div>

        <div class="stat-card-modern">
            <div class="stat-card-left">
                <div class="stat-icon-wrap icon-green">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                </div>
                <div class="stat-info">
                    <div class="stat-value" id="activeUsers">12</div>
                    <div class="stat-label">活跃用户数</div>
                    <div class="stat-trend trend-up">
                        <span>↑</span> +8%
                    </div>
                </div>
            </div>
            <div class="mini-chart mini-chart-green">
                <span style="height: 35%"></span>
                <span style="height: 50%"></span>
                <span style="height: 45%"></span>
                <span style="height: 70%"></span>
                <span style="height: 95%"></span>
            </div>
        </div>

        <div class="stat-card-modern">
            <div class="stat-card-left">
                <div class="stat-icon-wrap icon-red">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                </div>
                <div class="stat-info">
                    <div class="stat-value" id="bannedUsers">0</div>
                    <div class="stat-label">封禁用户数</div>
                    <div class="stat-trend trend-neutral">
                        <span>↓</span> 0%
                    </div>
                </div>
            </div>
            <div class="mini-chart mini-chart-red">
                <span style="height: 30%"></span>
                <span style="height: 50%"></span>
                <span style="height: 80%"></span>
                <span style="height: 60%"></span>
                <span style="height: 40%"></span>
            </div>
        </div>
    </div>

    <div class="dash-section-card">
        <div class="dash-section-header">
            <h2>快捷操作</h2>
        </div>
        <div class="dash-quick-grid">
            <div class="dash-quick-card" onclick="switchSection('users')">
                <div class="quick-icon-box bg-blue">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="quick-card-text">
                    <div class="quick-card-title">用户管理</div>
                    <div class="quick-card-desc">管理用户账号</div>
                </div>
            </div>
            <div class="dash-quick-card" onclick="switchSection('membershipPlans')">
                <div class="quick-icon-box bg-orange">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>
                </div>
                <div class="quick-card-text">
                    <div class="quick-card-title">会员套餐</div>
                    <div class="quick-card-desc">配置会员权益</div>
                </div>
            </div>
            <div class="dash-quick-card" onclick="switchSection('builtinModels')">
                <div class="quick-icon-box bg-cyan">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg>
                </div>
                <div class="quick-card-text">
                    <div class="quick-card-title">内置模型</div>
                    <div class="quick-card-desc">管理 AI 模型</div>
                </div>
            </div>
            <div class="dash-quick-card" onclick="switchSection('siteSettings')">
                <div class="quick-icon-box bg-navy">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </div>
                <div class="quick-card-text">
                    <div class="quick-card-title">系统设置</div>
                    <div class="quick-card-desc">全局系统配置</div>
                </div>
            </div>
        </div>
    </div>

    <div class="dash-section-card">
        <div class="dash-section-header flex-between">
            <div class="section-title-wrap">
                <h2>最近动态</h2>
                <span class="section-sub-en">Recent Activity</span>
            </div>
            <a href="javascript:void(0)" onclick="switchSection('users')" class="link-more">查看更多 →</a>
        </div>
        <div class="recent-activity-list" id="homeRecentActivity">
            <div class="activity-item">
                <div class="activity-avatar bg-blue-subtle">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                </div>
                <div class="activity-info">
                    <div class="activity-title">新用户注册</div>
                    <div class="activity-desc">用户 MoonYa 完成注册</div>
                </div>
                <div class="activity-time">2026-02-26 21:39</div>
            </div>
            <div class="activity-item">
                <div class="activity-avatar bg-indigo-subtle">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg>
                </div>
                <div class="activity-info">
                    <div class="activity-title">模型更新</div>
                    <div class="activity-desc">Gemini-3.8 Flash 已更新配置</div>
                </div>
                <div class="activity-time">2026-02-26 18:20</div>
            </div>
            <div class="activity-item">
                <div class="activity-avatar bg-amber-subtle">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/></svg>
                </div>
                <div class="activity-info">
                    <div class="activity-title">会员套餐</div>
                    <div class="activity-desc">用户 1234567890 购买了 Pro 套餐</div>
                </div>
                <div class="activity-time">2026-02-26 16:45</div>
            </div>
        </div>
    </div>
</div>

<script>
async function loadStats() {
    try {
        const data = await apiRequest('?limit=1000');
        if (data.success) {
            const users = data.data.users;
            document.getElementById('totalUsers').textContent = data.data.pagination.total;
            document.getElementById('activeUsers').textContent = users.filter(u => u.status === 'active').length;
            document.getElementById('bannedUsers').textContent = users.filter(u => u.status === 'banned').length;
        }
    } catch (e) {
        // Fallback to default count
    }
}
</script>
