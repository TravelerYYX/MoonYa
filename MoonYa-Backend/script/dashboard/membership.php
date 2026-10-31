<div id="membershipPlansSection" class="content-section">
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="modern-card-title">会员套餐</h2>
                <p class="modern-card-subtitle">按月提供积分，支持支付宝单月购买。独立等级用于升级判定，不随价格、积分或排序改变。</p>
            </div>
            <button class="btn-primary btn-add" onclick="editMembershipPlan()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>添加套餐</span>
            </button>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th style="width: 25%">套餐</th>
                        <th style="width: 15%">月价</th>
                        <th style="width: 15%">月积分</th>
                        <th style="width: 15%">状态</th>
                        <th style="width: 10%">排序</th>
                        <th style="width: 20%">操作</th>
                    </tr>
                </thead>
                <tbody id="membershipPlanRows"></tbody>
            </table>
        </div>
    </div>
</div>

<div id="membershipOrdersSection" class="content-section">
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="modern-card-title">会员订单</h2>
                <p class="modern-card-subtitle">查看与管理所有会员订单及支付流水。</p>
            </div>
            <button class="btn-action-edit" onclick="loadMembershipOrders()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                <span>刷新</span>
            </button>
        </div>
        <p id="paymentConfigurationState" style="padding:0 24px"></p>
        <div style="padding:0 28px 20px 28px;display:flex;gap:12px;flex-wrap:wrap">
            <input class="user-search-input" id="orderSearch" placeholder="完整订单号" aria-label="订单号" style="flex:2;min-width:220px">
            <input class="user-search-input" id="orderUser" type="number" min="1" placeholder="用户 ID" aria-label="用户 ID" style="flex:1;min-width:140px">
            <select class="user-select-box" id="orderStatus" aria-label="付款状态"><option value="">全部状态</option><option value="pending">待付款</option><option value="paid">已付款</option><option value="expired">已超时</option><option value="closed">已关闭</option></select>
            <button class="btn-search-blue" onclick="loadMembershipOrders()">查询</button>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th>订单／用户</th>
                        <th>套餐／金额</th>
                        <th>付款／权益</th>
                        <th>生效日期</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody id="membershipOrderRows"></tbody>
            </table>
        </div>
        <div id="membershipOrderPages" style="padding:16px 28px"></div>
    </div>
</div>

<div id="builtinModelsSection" class="content-section">
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="modern-card-title">内置模型</h2>
                <p class="modern-card-subtitle">配置系统内置大语言模型、API 端点地址、Token 窗口与积分消耗倍率</p>
                <p class="modern-card-note">系统按每 1,000 个 Token (输入+输出) 消耗 1 积分 × 倍率进行扣减。API 密钥加密保存服务器，编辑时留空保留原密钥。</p>
            </div>
            <button class="btn-primary btn-add" onclick="editBuiltinModel()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <span>添加模型</span>
            </button>
        </div>
        <div class="table-container">
            <table class="table">
                <thead>
                    <tr>
                        <th style="width: 28%">模型标识与名称</th>
                        <th style="width: 20%">特性支持</th>
                        <th style="width: 12%">积分倍率</th>
                        <th style="width: 16%">上下文 / 输出上限</th>
                        <th style="width: 10%">状态</th>
                        <th style="width: 14%">操作</th>
                    </tr>
                </thead>
                <tbody id="builtinModelRows"></tbody>
            </table>
        </div>
    </div>
</div>
