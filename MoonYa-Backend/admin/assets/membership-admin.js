/* Membership administration uses the existing authenticated admin shell. */
(function () {
    'use strict';
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const get = id => document.getElementById(id);
    const field = (id,label,value='',type='text') => `<div class="form-group"><label for="${id}">${label}</label><input class="form-input" id="${id}" type="${type}" value="${esc(value)}"></div>`;
    let plans = [], models = [];
    const ICONS = {
        cpu: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 21v2"/><path d="M9 1v2"/></svg>',
        bot: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
        tag: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>',
        globe: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
        key: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-1.5 1.5L16 7l-2-2-4 4a6.5 6.5 0 1 0 7.5 7.5l4-4-2-2 1.5-1.5L22 8l-1-1 1-1-1-1Z"/></svg>',
        zap: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
        coins: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
        sort: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
        tool: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
        eye: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
        brain: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-5.04z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-5.04z"/></svg>',
        star: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        sparkle: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>',
        arrowUp: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
        power: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>',
        lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
        info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        check: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    };
    async function request(endpoint, method='GET', body) {
        const response=await fetch('api/'+endpoint,{method,headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
        const result=await response.json(); if(!response.ok||!result.success)throw new Error(result.error||'操作失败'); return result.data;
    }
    function report(error) { showAlert('error',error.message||'操作失败'); }
    function footer(save) { return `<div class="modal-footer"><button class="btn-secondary" onclick="hideModal()">取消</button><button class="btn-primary" id="memberSave">${save}</button></div>`; }
    function bindSave(fn) { get('memberSave').onclick=async()=> { const button=get('memberSave');button.disabled=true;try{await fn();hideModal();showAlert('success','已保存');}catch(error){report(error);}finally{button.disabled=false;} }; }
    window.loadMembershipPlans=async()=> {
        try {
            plans=(await request('membership_plans.php')).items;
            get('membershipPlanRows').innerHTML=plans.map((p,i)=>{
                const isFree = !!p.is_free || String(p.code||'').toLowerCase()==='free' || String(p.name||'').includes('免费');
                const isGo = String(p.code||'').toLowerCase()==='go' || String(p.name||'').includes('GO');
                const isPlus = String(p.code||'').toLowerCase()==='plus' || String(p.name||'').includes('Plus');
                const isPro = String(p.code||'').toLowerCase()==='pro' || String(p.name||'').includes('Pro');
                const isMax = String(p.code||'').toLowerCase()==='max' || String(p.name||'').includes('Max');

                let iconClass = 'plan-icon-pink';
                let iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12l4 6-10 13L2 9z"/></svg>';

                if (isFree) {
                    iconClass = 'plan-icon-pink';
                    iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12l4 6-10 13L2 9z"/></svg>';
                } else if (isGo) {
                    iconClass = 'plan-icon-blue';
                    iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 4l3 12h14l3-12-5 5-5-7-5 7z"/></svg>';
                } else if (isPlus) {
                    iconClass = 'plan-icon-purple';
                    iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
                } else if (isPro) {
                    iconClass = 'plan-icon-orange';
                    iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
                } else if (isMax) {
                    iconClass = 'plan-icon-violet';
                    iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2 4l3 12h14l3-12-5 5-5-7-5 7z"/></svg>';
                }

                const statusHtml = p.archived
                    ? '<span class="status-pill status-pill-disabled">已删除</span>'
                    : `<div class="ios-switch-wrap"><div class="ios-switch ${p.enabled ? 'checked' : ''}"><span class="ios-switch-slider"></span></div><span class="ios-switch-label ${p.enabled ? 'text-green' : 'text-muted'}">${p.enabled ? '启用' : '已停止'}</span></div>`;

                return `<tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:12px">
                            <div class="plan-icon-badge ${iconClass}">
                                ${iconSvg}
                            </div>
                            <div>
                                <div class="plan-name-title">${esc(p.name)}</div>
                                <div class="plan-name-sub">每月 ${esc(Number(p.monthly_credits))} 积分</div>
                            </div>
                        </div>
                    </td>
                    <td><span class="price-highlight">¥${(p.price_cents/100).toFixed(2)} / 月</span></td>
                    <td style="font-weight:600;color:#1e293b">${esc(Number(p.monthly_credits))}</td>
                    <td>${statusHtml}</td>
                    <td style="color:#64748b;font-weight:500">${p.sort_order}</td>
                    <td>
                        <div style="display:flex;align-items:center;gap:6px">
                            ${p.archived ? '' : `<button class="btn-action-edit" data-plan-edit="${i}">编辑</button> ${isFree ? '' : `<button class="btn-action-delete" data-plan-delete="${i}">删除</button>`}`}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }catch(error){report(error);}
    };
    const SVG = {
        close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        diamond: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg>',
        chevronDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
        eye: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
        eyeOff: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
        plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        spinner: '<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>'
    };

    window.editMembershipPlan = function (index) {
        const isEdit = typeof index === 'number' && plans[index];
        const p = isEdit ? plans[index] : {
            code: '',
            name: '',
            price_cents: 0,
            monthly_credits: '',
            description: '',
            features: [],
            enabled: true,
            sort_order: plans.length
        };

        const modalHtml = `
            <div class="clean-dialog">
                <div class="clean-dialog-header">
                    <h3 class="clean-dialog-title">${p.id ? '编辑套餐' : '添加套餐'}</h3>
                    <button class="clean-dialog-close" type="button" title="关闭" onclick="hideModal()">${SVG.close}</button>
                </div>

                <div class="clean-form-row">
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="mpCode">套餐标识 (Code)</label>
                        <input class="clean-form-control" id="mpCode" type="text" placeholder="例如 pro、vip" value="${esc(p.code)}" ${p.is_free ? 'disabled' : ''}>
                    </div>
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="mpName">套餐名称</label>
                        <input class="clean-form-control" id="mpName" type="text" placeholder="例如 专业版会员" value="${esc(p.name)}">
                    </div>
                </div>

                <div class="clean-form-row">
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="mpPrice">月价格 (人民币元)</label>
                        <input class="clean-form-control" id="mpPrice" type="text" placeholder="0.00" value="${(p.price_cents / 100).toFixed(2)}" ${p.is_free ? 'disabled' : ''}>
                    </div>
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="mpCredits">每月赠送积分</label>
                        <input class="clean-form-control" id="mpCredits" type="number" placeholder="例如 3000" value="${esc(Number(p.monthly_credits) || '')}">
                    </div>
                </div>

                <div class="clean-form-group">
                    <label class="clean-form-label" for="mpRank">独立套餐等级（付费套餐大于 0，不能重复）</label><input class="clean-form-control" id="mpRank" type="number" min="0" max="1000000" value="${p.tier_rank ?? ''}" ${p.is_free ? 'disabled' : ''}>
                </div>
                <div class="clean-form-group">
                    <label class="clean-form-label" for="mpDescription">套餐简介</label>
                    <input class="clean-form-control" id="mpDescription" type="text" placeholder="例如 适合日常高频使用的 AI 助手服务" value="${esc(p.description)}">
                </div>

                <div class="clean-form-row">
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="mpOrder">显示排序</label>
                        <input class="clean-form-control" id="mpOrder" type="number" placeholder="0" value="${p.sort_order ?? 0}">
                    </div>
                    <div class="clean-form-group" style="display:flex;align-items:center;padding-top:24px">
                        <label class="clean-checkbox-item">
                            <input id="mpEnabled" type="checkbox" ${p.enabled ? 'checked' : ''} ${p.is_free ? 'disabled' : ''}>
                            <span>启用上线（取消后停止新开通）</span>
                        </label>
                    </div>
                </div>

                <div class="clean-form-group" style="margin-top:6px">
                    <div class="clean-features-header">
                        <span>套餐权益介绍</span>
                        <button type="button" class="clean-add-group-btn" id="mpAddGroup">${SVG.plus}<span>添加权益分组</span></button>
                    </div>
                    <div id="mpGroups"></div>
                </div>

                <div class="clean-dialog-footer">
                    <button type="button" class="clean-btn-cancel" onclick="hideModal()">取消</button>
                    <button type="button" class="clean-btn-save" id="memberSave">保存套餐</button>
                </div>
            </div>
        `;

        showModal(modalHtml, { cleanDialog: true, dismissByMask: false });

        function addGroup(group = { title: '', items: [] }) {
            const box = document.createElement('div');
            box.className = 'clean-feature-group';
            box.innerHTML = `
                <div class="clean-feature-group-header">
                    <input class="clean-form-control" data-group-title style="height:36px;font-size:13px;flex:1" placeholder="分组标题 (如 核心权益)" value="${esc(group.title)}">
                    <button class="clean-remove-group-btn" type="button" title="删除分组">${SVG.trash}<span>删除</span></button>
                </div>
                <textarea class="clean-form-control" data-group-items rows="3" style="font-size:13px;padding:8px 12px" placeholder="每行一条权益介绍">${esc((group.items || []).join('\n'))}</textarea>
            `;
            box.querySelector('.clean-remove-group-btn').onclick = () => box.remove();
            get('mpGroups').append(box);
        }

        (p.features || []).forEach(addGroup);
        get('mpAddGroup').onclick = () => addGroup();

        bindSave(async () => {
            const code = get('mpCode').value.trim();
            const name = get('mpName').value.trim();
            if (!code) throw new Error('请填写套餐标识');
            if (!name) throw new Error('请填写套餐名称');
            const price = get('mpPrice').value.trim();
            if (!/^\d{1,8}(\.\d{1,2})?$/.test(price)) throw new Error('价格格式无效，最多两位小数');
            const [yuan, cents = ''] = price.split('.');
            const features = [...get('mpGroups').children].map(box => ({
                title: box.querySelector('[data-group-title]').value.trim(),
                items: box.querySelector('[data-group-items]').value.split('\n').map(t => t.trim()).filter(Boolean)
            }));
            await request('membership_plans.php', 'POST', {
                id: p.id,
                code: code,
                name: name,
                price_cents: Number(yuan) * 100 + Number(cents.padEnd(2, '0')),
                monthly_credits: get('mpCredits').value,
                description: get('mpDescription').value.trim(),
                sort_order: Number(get('mpOrder').value),
                tier_rank: Number(get('mpRank').value),
                enabled: get('mpEnabled').checked,
                features
            });
            await loadMembershipPlans();
        });
    };
    const orderStatuses={pending:'待付款',paid:'已付款',expired:'已超时',closed:'已关闭'};
    const purchaseStatuses={queued:'待生效',active:'使用中',expired:'已到期',replaced:'已切换'};
    window.loadMembershipOrders=async function(page=1) {
        try {
            const params=new URLSearchParams({page,status:get('orderStatus').value,search:get('orderSearch').value.trim(),user_id:get('orderUser').value});
            const data=await request('membership_orders.php?'+params);
            const c=data.configuration;
            get('paymentConfigurationState').textContent=`支付宝：${c.environment==='sandbox'?'沙箱':'正式环境'} · ${c.enabled?'开关已启用':'购买开关关闭'} · ${c.ready&&c.schema_ready?'配置完整':'尚未完成配置'}${!c.schema_ready?'；需要支付迁移':''}${c.missing.length?'；缺少：'+c.missing.join('、'):''}`;
            get('membershipOrderRows').innerHTML=data.items.map(o=>`<tr><td>${esc(o.order_no)}<small>用户 ${o.user_id} · ${esc(o.created_at)}</small></td><td>${esc(o.plan.name)} · ¥${(o.amount_cents/100).toFixed(2)}</td><td>${esc(orderStatuses[o.status]||o.status)}<small>${esc(purchaseStatuses[o.purchase?.status]||'')}</small></td><td>${esc(o.purchase?.starts_at||'—')}<small>${esc(o.purchase?.ends_at||'')}</small></td><td><button type="button" class="btn-secondary btn-sm" data-order-detail="${esc(o.order_no)}">详情</button> <button type="button" class="btn-secondary btn-sm" data-order-sync="${esc(o.order_no)}">查单</button></td></tr>`).join('')||'<tr><td colspan="5">暂无订单</td></tr>';
            get('membershipOrderPages').innerHTML=`<button id="orderPrev" class="btn-secondary" ${page<=1?'disabled':''}>上一页</button> ${page} <button id="orderNext" class="btn-secondary" ${page*20>=data.total?'disabled':''}>下一页</button>`;
            get('orderPrev').onclick=()=>loadMembershipOrders(page-1);get('orderNext').onclick=()=>loadMembershipOrders(page+1);
            for(const button of get('membershipOrderRows').querySelectorAll('[data-order-detail],[data-order-sync]'))button.onclick=async()=>{
                button.disabled=true;
                try {
                    if(button.dataset.orderSync){await request('membership_orders.php','POST',{order_no:button.dataset.orderSync});await loadMembershipOrders(page);showAlert('success','订单状态已查询');}
                    else {const d=await request('membership_orders.php?order_no='+encodeURIComponent(button.dataset.orderDetail)),o=d.order;showModal(`<div class="modal-header"><h3>订单详情</h3></div><p>订单：${esc(o.order_no)}</p><p>用户：${o.user_id}</p><p>套餐：${esc(o.plan.name)} · 等级 ${esc(o.plan.tier_rank)} · ${esc(o.plan.monthly_credits)} 积分</p><p>金额：¥${(o.amount_cents/100).toFixed(2)}</p><p>付款：${esc(orderStatuses[o.status])} · ${esc(o.paid_at||'—')}</p><p>支付宝交易号：${esc(d.trade_no||'—')}</p><p>权益：${esc(purchaseStatuses[o.purchase?.status]||'尚未生效')}</p><p>有效期：${esc(o.purchase?.starts_at||'—')} 至 ${esc(o.purchase?.ends_at||'—')}（北京时间）</p><div class="modal-footer"><button class="btn-secondary" onclick="hideModal()">关闭</button></div>`);}
                }catch(error){report(error);}finally{button.disabled=false;}
            };
        }catch(error){report(error);}
    };
    window.loadBuiltinModels = async () => {
        try {
            models = (await request('builtin_models.php')).items;
            const container = get('builtinModelRows');
            if (!container) return;
            if (!models.length) {
                container.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:#94a3b8">暂无内置模型，点击上方“添加模型”创建</td></tr>';
                return;
            }
            container.innerHTML = models.map((m, i) => {
                const c = m.capabilities || {};
                const capsBadges = [
                    c.supports_tools ? `<span class="feature-tag feature-tool" title="支持 Agent 工具 / 函数调用"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><span>工具</span></span>` : '',
                    c.supports_images ? `<span class="feature-tag feature-vision" title="支持多模态视觉 / 图片解析">视觉</span>` : '',
                    c.supports_thinking ? `<span class="feature-tag feature-thinking" title="支持思维链 / 深度思考">思考</span>` : ''
                ].filter(Boolean).join(' ');

                const statusBadge = m.archived
                    ? '<span class="status-pill status-pill-disabled">已删除</span>'
                    : m.enabled
                        ? '<span class="status-pill status-pill-active">● 启用中</span>'
                        : '<span class="status-pill status-pill-disabled">○ 已停用</span>';

                const contextDisplay = (c.context_window >= 1000)
                    ? `${(c.context_window / 1024).toFixed(0)}K <small class="text-secondary" style="font-size:11px">(${Number(c.context_window).toLocaleString()})</small>`
                    : `${c.context_window}`;

                const outputDisplay = (c.max_output_tokens >= 1000)
                    ? `${(c.max_output_tokens / 1024).toFixed(0)}K`
                    : `${c.max_output_tokens || 4096}`;

                const lowerId = String(m.id || '').toLowerCase();
                const lowerLabel = String(m.label || '').toLowerCase();

                let brandLogo = '';
                if (lowerId.includes('deepseek') || lowerLabel.includes('deepseek')) {
                    brandLogo = `<div class="model-brand-icon model-brand-deepseek"><svg width="22" height="22" viewBox="0 0 32 32" fill="currentColor"><path d="M8 18c0-5.5 4.5-10 10-10 3 0 5.8 1.3 7.7 3.5-1.5.8-3.2 1.5-5 1.5-4 0-7.3 2.7-8.3 6.4C10.8 20.3 8 18 8 18zm18.5-1.2C27.5 15.2 28 13.6 28 12c0-.5-.1-1-.2-1.5-1.8 1.2-3.8 2-6 2.3 2.4 1.2 4.1 3.5 4.7 6zM6.5 19.2C5.6 20.6 5 22.2 5 24c0 .8.1 1.5.3 2.2 1.4-1.8 3.4-3.2 5.7-3.8-1.9-.8-3.4-2-4.5-3.2z"/></svg></div>`;
                } else if (lowerId.includes('gpt') || lowerLabel.includes('gpt') || lowerId.includes('openai')) {
                    brandLogo = `<div class="model-brand-icon model-brand-openai"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12A10 10 0 0 0 12 2v10z"/><path d="M12 12 5 3.5A10 10 0 0 0 2 12h10z"/><path d="M12 12l-7 8.5A10 10 0 0 0 12 22V12z"/><path d="M12 12l7 8.5A10 10 0 0 0 22 12H12z"/></svg></div>`;
                } else if (lowerId.includes('gemini') || lowerLabel.includes('gemini') || lowerId.includes('google')) {
                    brandLogo = `<div class="model-brand-icon model-brand-google"><svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.65v3.03h3.88c2.27-2.09 3.665-5.17 3.665-9.12z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.03c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.13C3.26 21.39 7.36 24 12 24z"/><path fill="#FBBC05" d="M5.28 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.58H1.25C.45 8.18 0 9.99 0 12s.45 3.82 1.25 5.42l4.03-3.13z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.36 0 3.26 2.61 1.25 6.58l4.03 3.13c.95-2.83 3.6-4.96 6.72-4.96z"/></svg></div>`;
                } else {
                    brandLogo = `<div class="model-brand-icon model-brand-fallback"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 22 12 12 22 2 12"/></svg></div>`;
                }

                return `<tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:12px">
                            ${brandLogo}
                            <div>
                                <div style="display:flex;align-items:center;gap:6px">
                                    <strong style="color:#0f172a;font-size:14px">${esc(m.label)}</strong>
                                    ${m.is_default ? '<span class="tag-default">默认</span>' : ''}
                                </div>
                                <div class="sub-model-id">
                                    ${esc(m.id)}${m.upstream_model ? ` → ${esc(m.upstream_model)}` : ''}
                                </div>
                            </div>
                        </div>
                    </td>
                    <td>${capsBadges || '<span style="color:#94a3b8;font-size:12px">基础对话</span>'}</td>
                    <td><span class="multiplier-pill">${esc(Number(m.multiplier))}x</span></td>
                    <td>
                        <div style="font-size:13px;font-weight:500;color:#1e293b">${contextDisplay}</div>
                        <div style="font-size:11.5px;color:#64748b;margin-top:2px">输出上限: ${outputDisplay}</div>
                    </td>
                    <td>${statusBadge}</td>
                    <td>
                        <div style="display:flex;align-items:center;gap:6px">
                            ${m.archived ? '' : `
                                <button class="btn-action-edit" data-model-edit="${i}">编辑</button>
                                <button class="btn-action-delete" data-model-delete="${i}">删除</button>
                            `}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        } catch (error) {
            report(error);
        }
    };
    window.editBuiltinModel = function (index) {
        const isEdit = typeof index === 'number' && models[index];
        const m = isEdit ? JSON.parse(JSON.stringify(models[index])) : {
            id: '',
            label: '',
            upstream_model: '',
            endpoint: '',
            multiplier: '1',
            enabled: true,
            is_default: false,
            sort_order: models.length,
            capabilities: {
                context_window: 65536,
                max_output_tokens: 4096,
                supports_tools: true,
                supports_thinking: false,
                supports_images: false,
                reasoning: '',
                efforts: []
            }
        };
        const c = m.capabilities || {};
        let activeEfforts = Array.isArray(c.efforts) ? [...c.efforts] : [];
        const effortOrder = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
        const effortNames = {low:'低',medium:'中',high:'高',xhigh:'超高',max:'极致',ultra:'Ultra'};
        const effortLabels = {...(c.effort_labels || {})};
        let defaultEffort = c.default_effort || (activeEfforts.includes('high') ? 'high' : effortOrder.filter(e => activeEfforts.includes(e)).at(-1) || 'auto');
        function renderEffortFields() {
            const levels = effortOrder.filter(e => activeEfforts.includes(e));
            get('bmEffortLabels').innerHTML = levels.map(e => `<div class="clean-form-group"><label class="clean-form-label" for="bmLabel_${e}">${e} 显示名称</label><input class="clean-form-control" id="bmLabel_${e}" data-effort-label="${e}" maxlength="64" placeholder="${effortNames[e]}" value="${esc(effortLabels[e] || '')}"></div>`).join('');
            get('bmEffortLabels').querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
                const level = input.dataset.effortLabel;
                effortLabels[level] = input.value;
                get('bmDefaultEffort').querySelector(`option[value="${level}"]`).textContent = `${input.value.trim() || effortNames[level]} (${level})`;
            }));
            const select = get('bmDefaultEffort');
            select.innerHTML = levels.length ? '<option value="">请选择默认档位</option>' + levels.map(e => `<option value="${e}">${esc(effortLabels[e]?.trim() || effortNames[e])} (${e})</option>`).join('') : '<option value="auto">开启思考（无强度参数）</option>';
            if (!levels.length) defaultEffort = 'auto';
            else if (!levels.includes(defaultEffort)) defaultEffort = '';
            select.value = defaultEffort;
            select.disabled = !levels.length;
            select.onchange = () => { defaultEffort = select.value; };
        }

        const providers = [
            {
                key: 'custom',
                name: '◇ 自定义',
                endpoint: '',
                upstream: '',
                id: '',
                label: '',
                multiplier: '1.0',
                context: 65536,
                output: 4096,
                tools: true,
                images: false,
                thinking: false,
                reasoning: '',
                efforts: []
            },
            {
                key: 'deepseek-chat',
                name: 'DeepSeek (官方)',
                endpoint: 'https://api.deepseek.com/v1/chat/completions',
                upstream: 'deepseek-chat',
                id: 'deepseek-chat',
                label: 'DeepSeek V3',
                multiplier: '0.15',
                context: 65536,
                output: 8192,
                tools: true,
                images: false,
                thinking: false,
                reasoning: 'deepseek',
                efforts: []
            },
            {
                key: 'deepseek-reasoner',
                name: 'DeepSeek R1 (深度思考)',
                endpoint: 'https://api.deepseek.com/v1/chat/completions',
                upstream: 'deepseek-reasoner',
                id: 'deepseek-reasoner',
                label: 'DeepSeek R1',
                multiplier: '0.55',
                context: 65536,
                output: 8192,
                tools: true,
                images: false,
                thinking: true,
                reasoning: 'deepseek',
                efforts: ['low', 'medium', 'high', 'max']
            },
            {
                key: 'openai-gpt4o',
                name: 'OpenAI (GPT-4o)',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                upstream: 'gpt-4o',
                id: 'gpt-4o',
                label: 'GPT-4o',
                multiplier: '1.0',
                context: 128000,
                output: 16384,
                tools: true,
                images: true,
                thinking: false,
                reasoning: 'openai',
                efforts: []
            },
            {
                key: 'openai-o1',
                name: 'OpenAI (o1 推理)',
                endpoint: 'https://api.openai.com/v1/chat/completions',
                upstream: 'o1',
                id: 'o1',
                label: 'OpenAI o1',
                multiplier: '2.0',
                context: 200000,
                output: 65536,
                tools: true,
                images: true,
                thinking: true,
                reasoning: 'openai',
                efforts: ['low', 'medium', 'high']
            },
            {
                key: 'qwen',
                name: '通义千问 (阿里百炼)',
                endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                upstream: 'qwen-plus',
                id: 'qwen-plus',
                label: '通义千问 Qwen Plus',
                multiplier: '0.3',
                context: 131072,
                output: 8192,
                tools: true,
                images: false,
                thinking: false,
                reasoning: '',
                efforts: []
            },
            {
                key: 'glm',
                name: '智谱 AI (GLM)',
                endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                upstream: 'glm-4-plus',
                id: 'glm-4-plus',
                label: '智谱 GLM-4 Plus',
                multiplier: '0.4',
                context: 128000,
                output: 4096,
                tools: true,
                images: false,
                thinking: false,
                reasoning: 'glm',
                efforts: []
            },
            {
                key: 'kimi',
                name: '月之暗面 (Kimi)',
                endpoint: 'https://api.moonshot.cn/v1/chat/completions',
                upstream: 'moonshot-v1-128k',
                id: 'moonshot-v1-128k',
                label: 'Moonshot Kimi 128K',
                multiplier: '0.5',
                context: 131072,
                output: 4096,
                tools: true,
                images: false,
                thinking: false,
                reasoning: 'kimi',
                efforts: []
            },
            {
                key: 'minimax',
                name: 'MiniMax',
                endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
                upstream: 'minimax-text-01',
                id: 'minimax-text-01',
                label: 'MiniMax Text-01',
                multiplier: '0.4',
                context: 1000000,
                output: 8192,
                tools: true,
                images: false,
                thinking: false,
                reasoning: 'minimax',
                efforts: []
            },
            {
                key: 'siliconflow',
                name: '硅基流动 (SiliconFlow)',
                endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
                upstream: 'deepseek-ai/DeepSeek-V3',
                id: 'siliconflow-deepseek-v3',
                label: 'SiliconFlow DeepSeek V3',
                multiplier: '0.15',
                context: 65536,
                output: 4096,
                tools: true,
                images: false,
                thinking: false,
                reasoning: '',
                efforts: []
            },
            {
                key: 'ollama',
                name: '本地 Ollama',
                endpoint: 'http://localhost:11434/v1/chat/completions',
                upstream: 'llama3.3',
                id: 'ollama-local',
                label: 'Ollama 本地服务',
                multiplier: '0.01',
                context: 32768,
                output: 4096,
                tools: true,
                images: false,
                thinking: false,
                reasoning: '',
                efforts: []
            }
        ];

        // 识别当前供应商
        let initialProviderKey = 'custom';
        if (m.endpoint) {
            for (const p of providers) {
                if (p.key !== 'custom' && (m.endpoint === p.endpoint || (p.upstream && m.upstream_model === p.upstream))) {
                    initialProviderKey = p.key;
                    break;
                }
            }
        }

        const modalHtml = `
            <div class="clean-dialog">
                <!-- 顶栏 Header -->
                <div class="clean-dialog-header">
                    <h3 class="clean-dialog-title">${isEdit ? '编辑模型' : '添加模型'}</h3>
                    <button class="clean-dialog-close" type="button" title="关闭" onclick="hideModal()">${SVG.close}</button>
                </div>

                <!-- 1. 供应商 -->
                <div class="clean-form-group">
                    <label class="clean-form-label" for="bmProvider">供应商<span class="clean-label-hint">（仅支持 OpenAI 兼容协议 API）</span></label>
                    <div class="clean-select-wrapper">
                        <span class="clean-select-icon">${SVG.diamond}</span>
                        <select class="clean-form-control clean-select" id="bmProvider">
                            ${providers.map(p => `<option value="${p.key}" ${initialProviderKey === p.key ? 'selected' : ''}>${p.name}</option>`).join('')}
                        </select>
                        <span class="clean-select-arrow">${SVG.chevronDown}</span>
                    </div>
                </div>

                <!-- 2. 接口地址 -->
                <div class="clean-form-group">
                    <label class="clean-form-label" for="bmEndpoint">接口地址</label>
                    <input class="clean-form-control" id="bmEndpoint" type="url" placeholder="https://api.example.com/v1/chat/completions" value="${esc(m.endpoint)}">
                </div>

                <!-- 3. API Key -->
                <div class="clean-form-group">
                    <label class="clean-form-label" for="bmProtocol">API 协议</label>
                    <select class="clean-form-control" id="bmProtocol">
                        <option value="openai-completions" ${c.protocol !== 'openai-responses' ? 'selected' : ''}>OpenAI Chat Completions</option>
                        <option value="openai-responses" ${c.protocol === 'openai-responses' ? 'selected' : ''}>OpenAI Responses（支持 GPT 思考摘要）</option>
                    </select>
                </div>
                <div class="clean-form-group">
                    <label class="clean-form-label" for="bmKey">API Key ${isEdit && m.has_api_key ? '<span class="clean-label-hint">（已配置密钥，留空保留原密钥）</span>' : ''}</label>
                    <div class="clean-apikey-row">
                        <div class="clean-input-with-eye">
                            <input class="clean-form-control" id="bmKey" type="password" placeholder="${isEdit && m.has_api_key ? '•••••••••••••••• (留空保留服务器原密钥)' : '输入你的 API Key'}">
                            <button class="clean-eye-btn" type="button" id="bmToggleKeyBtn" title="切换明文/密文">${SVG.eye}</button>
                        </div>
                        <button class="clean-test-btn" type="button" id="bmTestBtn"><span>测试连接</span></button>
                    </div>
                    <div class="clean-test-status" id="bmTestStatus"></div>
                </div>

                <!-- 4. 模型名称 (供应商模型参数) -->
                <div class="clean-form-group">
                    <label class="clean-form-label" for="bmUpstream">模型名称</label>
                    <input class="clean-form-control" id="bmUpstream" type="text" placeholder="输入模型参数值，例如 gpt-4o 或 openai/gpt-4o" value="${esc(m.upstream_model)}">
                </div>

                <!-- 显示名称 & 模型标识 -->
                <div class="clean-form-row">
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="bmLabel">显示名称</label>
                        <input class="clean-form-control" id="bmLabel" type="text" placeholder="面向用户展示的名称" value="${esc(m.label)}">
                    </div>
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="bmId">模型标识 (ID) ${isEdit ? '<span class="clean-label-hint">（已锁定）</span>' : ''}</label>
                        <input class="clean-form-control" id="bmId" type="text" placeholder="系统内部唯一调用标识" value="${esc(m.id)}" ${isEdit ? 'disabled' : ''}>
                    </div>
                </div>

                <!-- 消耗积分倍率 & 排序权重 -->
                <div class="clean-form-row">
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="bmMultiplier">消耗积分倍率</label>
                        <input class="clean-form-control" id="bmMultiplier" type="number" step="0.01" min="0" max="1000" placeholder="1.0" value="${Number(m.multiplier ?? 1)}">
                    </div>
                    <div class="clean-form-group">
                        <label class="clean-form-label" for="bmOrder">排序权重</label>
                        <input class="clean-form-control" id="bmOrder" type="number" placeholder="0" value="${m.sort_order ?? 0}">
                    </div>
                </div>

                <!-- 5. 高级配置 -->
                <div class="clean-advanced-section">
                    <div class="clean-advanced-title">高级配置</div>
                    <button type="button" class="clean-btn-cancel" id="bmOfficialThinking">应用 GPT-6.1 Sol / Gemini-3.8 Flash 思考配置</button>
                    <div class="clean-checkbox-row">
                        <label class="clean-checkbox-item">
                            <input type="checkbox" id="bm_supports_tools" ${c.supports_tools ? 'checked' : ''}>
                            <span>工具调用</span>
                        </label>
                        <label class="clean-checkbox-item">
                            <input type="checkbox" id="bm_supports_images" ${c.supports_images ? 'checked' : ''}>
                            <span>图片输入</span>
                        </label>
                        <label class="clean-checkbox-item">
                            <input type="checkbox" id="bm_supports_thinking" ${c.supports_thinking ? 'checked' : ''}>
                            <span>思考模式</span>
                        </label>
                        <label class="clean-checkbox-item">
                            <input type="checkbox" id="bm_enabled" ${m.enabled ? 'checked' : ''}>
                            <span>启用上线</span>
                        </label>
                        <label class="clean-checkbox-item">
                            <input type="checkbox" id="bm_is_default" ${m.is_default ? 'checked' : ''}>
                            <span>设为默认</span>
                        </label>
                    </div>

                    <!-- 思考模式展开参数 -->
                    <div class="clean-thinking-panel ${c.supports_thinking ? '' : 'hidden'}" id="bmThinkingPanel">
                        <div class="clean-form-group" style="margin-bottom:8px">
                            <label class="clean-form-label" for="bmReasoning" style="font-size:12.5px">思考参数协议格式</label>
                            <select class="clean-form-control" id="bmReasoning" style="height:36px;font-size:13px">
                                <option value="" ${!c.reasoning ? 'selected' : ''}>-- 请选择思考参数格式 --</option>
                                <option value="deepseek" ${c.reasoning === 'deepseek' ? 'selected' : ''}>DeepSeek 格式 (thinking: {type: 'enabled'})</option>
                                <option value="openai" ${c.reasoning === 'openai' ? 'selected' : ''}>OpenAI 格式 (reasoning_effort)</option>
                                <option value="gemini" ${c.reasoning === 'gemini' ? 'selected' : ''}>Gemini 格式（thinking_config / 思考摘要）</option>
                                <option value="kimi" ${c.reasoning === 'kimi' ? 'selected' : ''}>Kimi / Moonshot 格式</option>
                                <option value="glm" ${c.reasoning === 'glm' ? 'selected' : ''}>智谱 GLM 格式</option>
                                <option value="minimax" ${c.reasoning === 'minimax' ? 'selected' : ''}>MiniMax 格式</option>
                                <option value="always" ${c.reasoning === 'always' ? 'selected' : ''}>强制始终深度思考 (Always)</option>
                            </select>
                        </div>
                        <label class="clean-checkbox-item"><input type="checkbox" id="bmRequired" ${c.reasoning_required || c.allow_thinking_off === false || c.reasoning === 'always' || c.reasoning === 'gemini' ? 'checked' : ''}><span>不允许关闭思考</span></label>
                        <div>
                            <label class="clean-form-label" style="font-size:12.5px;margin-bottom:4px">支持的思考强度档位</label>
                            <div class="clean-effort-pills" id="bmEffortPills">
                                ${['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(eff => `
                                    <button type="button" class="clean-effort-pill ${activeEfforts.includes(eff) ? 'active' : ''}" data-effort="${eff}">${eff}</button>
                                `).join('')}
                            </div>
                            <input type="hidden" id="bmEfforts" value="${esc(activeEfforts.join(','))}">
                            <div id="bmEffortLabels" style="margin-top:12px"></div>
                            <div class="clean-form-group"><label class="clean-form-label" for="bmDefaultEffort">默认思考档位</label><select class="clean-form-control" id="bmDefaultEffort"></select></div>
                        </div>
                    </div>

                    <!-- 输入 / 输出 Token 上限 -->
                    <div class="clean-tokens-row" style="margin-top:14px">
                        <div class="clean-tokens-col">
                            <label for="bmContext">输入</label>
                            <input class="clean-form-control" id="bmContext" type="number" min="1024" max="100000000" placeholder="使用提供商默认值" value="${c.context_window || 65536}">
                        </div>
                        <div class="clean-tokens-col">
                            <label for="bmOutput">输出</label>
                            <input class="clean-form-control" id="bmOutput" type="number" min="1" placeholder="使用提供商默认值" value="${c.max_output_tokens || 4096}">
                        </div>
                    </div>
                </div>

                <!-- 底栏 Footer -->
                <div class="clean-dialog-footer">
                    <button type="button" class="clean-btn-cancel" onclick="hideModal()">取消</button>
                    <button type="button" class="clean-btn-save" id="memberSave">保存</button>
                </div>
            </div>
        `;

        showModal(modalHtml, { cleanDialog: true, dismissByMask: false });

        // 供应商选择联动
        renderEffortFields();
        get('bmOfficialThinking').onclick = () => {
            const id = get('bmUpstream').value.trim();
            if (!['gpt-6.1-sol','gemini-3.8-flash'].includes(id)) { report(new Error('此配置仅适用于 gpt-6.1-sol 或 gemini-3.8-flash')); return; }
            const gpt = id === 'gpt-6.1-sol';
            get('bmProtocol').value = gpt ? 'openai-responses' : 'openai-completions';
            get('bmReasoning').value = gpt ? 'openai' : 'gemini';
            get('bmRequired').checked = true; get('bm_supports_thinking').checked = true;
            get('bmThinkingPanel').classList.remove('hidden');
            activeEfforts = gpt ? ['low','medium','high','xhigh','max'] : ['low','medium','high'];
            defaultEffort = 'medium'; get('bmEfforts').value = activeEfforts.join(',');
            document.querySelectorAll('#bmEffortPills .clean-effort-pill').forEach(pill => pill.classList.toggle('active',activeEfforts.includes(pill.dataset.effort)));
            renderEffortFields();
        };
        const providerSelect = get('bmProvider');
        if (providerSelect) {
            providerSelect.addEventListener('change', () => {
                const selectedKey = providerSelect.value;
                const p = providers.find(item => item.key === selectedKey);
                if (!p || p.key === 'custom') return;

                get('bmEndpoint').value = p.endpoint;
                get('bmProtocol').value = p.protocol || 'openai-completions';
                get('bmRequired').checked = !!p.required;
                get('bmUpstream').value = p.upstream;
                if (!isEdit) {
                    if (!get('bmId').value || providers.some(item => item.id === get('bmId').value)) {
                        get('bmId').value = p.id;
                    }
                    if (!get('bmLabel').value || providers.some(item => item.label === get('bmLabel').value)) {
                        get('bmLabel').value = p.label;
                    }
                }
                get('bmMultiplier').value = p.multiplier;
                get('bmContext').value = p.context;
                get('bmOutput').value = p.output;

                get('bm_supports_tools').checked = !!p.tools;
                get('bm_supports_images').checked = !!p.images;
                get('bm_supports_thinking').checked = !!p.thinking;

                const thinkingPanel = get('bmThinkingPanel');
                if (thinkingPanel) {
                    thinkingPanel.classList.toggle('hidden', !p.thinking);
                }
                if (p.reasoning) {
                    get('bmReasoning').value = p.reasoning;
                }
                activeEfforts = [...(p.efforts || [])];
                defaultEffort = activeEfforts.includes('high') ? 'high' : effortOrder.filter(e => activeEfforts.includes(e)).at(-1) || 'auto';
                renderEffortFields();
                get('bmEfforts').value = activeEfforts.join(',');
                document.querySelectorAll('#bmEffortPills .clean-effort-pill').forEach(pill => {
                    pill.classList.toggle('active', activeEfforts.includes(pill.dataset.effort));
                });
            });
        }

        // 密钥显示/隐藏切换
        const toggleKeyBtn = get('bmToggleKeyBtn');
        if (toggleKeyBtn) {
            toggleKeyBtn.onclick = () => {
                const keyInput = get('bmKey');
                if (!keyInput) return;
                const isPassword = keyInput.type === 'password';
                keyInput.type = isPassword ? 'text' : 'password';
                toggleKeyBtn.innerHTML = isPassword ? SVG.eyeOff : SVG.eye;
            };
        }

        // 测试连接
        const testBtn = get('bmTestBtn');
        if (testBtn) {
            testBtn.onclick = async () => {
                const statusEl = get('bmTestStatus');
                const endpoint = get('bmEndpoint').value.trim();
                const key = get('bmKey').value.trim();
                const upstream = get('bmUpstream').value.trim();

                if (!endpoint) {
                    statusEl.className = 'clean-test-status show error';
                    statusEl.innerHTML = `${SVG.alert}<span>请先填写接口地址</span>`;
                    return;
                }
                if (!key && !isEdit) {
                    statusEl.className = 'clean-test-status show error';
                    statusEl.innerHTML = `${SVG.alert}<span>请先填写 API Key</span>`;
                    return;
                }

                testBtn.disabled = true;
                testBtn.innerHTML = `${SVG.spinner}<span>测试中...</span>`;
                statusEl.className = 'clean-test-status';
                statusEl.innerHTML = '';

                try {
                    const res = await request('builtin_models.php?action=test', 'POST', {
                        endpoint,
                        api_key: key,
                        upstream_model: upstream,
                        id: isEdit ? m.id : '',
                        capabilities: readCapabilities()
                    });
                    statusEl.className = 'clean-test-status show success';
                    statusEl.innerHTML = `${SVG.check}<span>${esc(res.message || '连接成功，服务正常响应')}</span>`;
                } catch (err) {
                    statusEl.className = 'clean-test-status show error';
                    statusEl.innerHTML = `${SVG.alert}<span>${esc(err.message || '连接测试失败')}</span>`;
                } finally {
                    testBtn.disabled = false;
                    testBtn.innerHTML = `<span>测试连接</span>`;
                }
            };
        }

        // 思考模式切换
        const thinkingCb = get('bm_supports_thinking');
        if (thinkingCb) {
            thinkingCb.addEventListener('change', () => {
                const panel = get('bmThinkingPanel');
                if (panel) panel.classList.toggle('hidden', !thinkingCb.checked);
                if (thinkingCb.checked && !get('bmReasoning').value) {
                    get('bmReasoning').value = 'deepseek';
                }
            });
        }

        // 默认模型联动启用
        const defaultCb = get('bm_is_default');
        if (defaultCb) {
            defaultCb.addEventListener('change', () => {
                if (defaultCb.checked) {
                    get('bm_enabled').checked = true;
                }
            });
        }

        // 思考强度点击
        document.querySelectorAll('#bmEffortPills .clean-effort-pill').forEach(pill => {
            pill.onclick = () => {
                const eff = pill.dataset.effort;
                if (activeEfforts.includes(eff)) {
                    activeEfforts = activeEfforts.filter(x => x !== eff);
                    pill.classList.remove('active');
                } else {
                    activeEfforts.push(eff);
                    pill.classList.add('active');
                }
                get('bmEfforts').value = activeEfforts.join(',');
                renderEffortFields();
            };
        });

        function readCapabilities() {
            const caps = { ...c, protocol: get('bmProtocol').value,
                context_window: Number(get('bmContext').value), max_output_tokens: Number(get('bmOutput').value),
                reasoning: get('bmReasoning').value, efforts: activeEfforts,
                default_effort: activeEfforts.length ? defaultEffort : 'auto',
                effort_labels: Object.fromEntries(activeEfforts.filter(e => effortLabels[e]?.trim()).map(e => [e, effortLabels[e].trim()])),
                supports_tools: get('bm_supports_tools').checked, supports_images: get('bm_supports_images').checked,
                supports_thinking: get('bm_supports_thinking').checked,
                reasoning_required: get('bmRequired').checked, allow_thinking_off: !get('bmRequired').checked };
            if (caps.context_window !== c.context_window) delete caps.context_window_options;
            return caps;
        }
        // 保存校验与请求
        bindSave(async () => {
            const id = get('bmId').value.trim();
            const label = get('bmLabel').value.trim();
            const upstream = get('bmUpstream').value.trim();
            const endpoint = get('bmEndpoint').value.trim();
            const key = get('bmKey').value.trim();
            const mult = Number(get('bmMultiplier').value);
            const context = Number(get('bmContext').value);
            const output = Number(get('bmOutput').value);
            const supportsThinking = get('bm_supports_thinking').checked;
            const reasoning = get('bmReasoning').value;
            const isDefault = get('bm_is_default').checked;
            const enabled = get('bm_enabled').checked;

            document.querySelectorAll('.clean-form-control').forEach(el => el.classList.remove('is-invalid'));

            if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,127}$/.test(id)) {
                get('bmId').classList.add('is-invalid');
                throw new Error('模型标识格式无效（须以英文字母或数字开头，仅支持英文、数字、点、横杠与下划线）');
            }
            if (!label) {
                get('bmLabel').classList.add('is-invalid');
                throw new Error('请输入有效的显示名称');
            }
            if (!upstream) {
                get('bmUpstream').classList.add('is-invalid');
                throw new Error('请输入模型名称（供应商真实参数值，如 deepseek-chat）');
            }
            if (!endpoint || !/^https?:\/\/.+/i.test(endpoint)) {
                get('bmEndpoint').classList.add('is-invalid');
                throw new Error('接口地址必须是完整的 http:// 或 https:// 协议地址');
            }
            if (!isEdit && !key) {
                get('bmKey').classList.add('is-invalid');
                throw new Error('新建模型必须填写 API Key');
            }
            if (isEdit && !m.has_api_key && !key) {
                get('bmKey').classList.add('is-invalid');
                throw new Error('该模型尚未配置密钥，请填写 API Key');
            }
            if (isNaN(context) || context < 1024 || context > 100000000) {
                get('bmContext').classList.add('is-invalid');
                throw new Error('输入 Token 上限必须介于 1,024 与 100,000,000 之间');
            }
            if (isNaN(output) || output < 1 || output > context) {
                get('bmOutput').classList.add('is-invalid');
                throw new Error('输出 Token 上限必须大于 0 且不超过输入上限');
            }
            if (isNaN(mult) || mult < 0 || mult > 1000) {
                get('bmMultiplier').classList.add('is-invalid');
                throw new Error('积分倍率必须大于或等于 0 且不超过 1000');
            }
            if (supportsThinking && !reasoning) {
                get('bmReasoning').classList.add('is-invalid');
                throw new Error('启用了思考模式的模型必须选择思考参数协议格式');
            }
            if (isDefault && !enabled) {
                throw new Error('默认模型必须处于启用状态');
            }

            if (activeEfforts.length && !activeEfforts.includes(defaultEffort)) {
                get('bmDefaultEffort').classList.add('is-invalid');
                throw new Error('请从已勾选档位中重新选择默认思考档位');
            }
            const caps = readCapabilities();
            if (caps.context_window !== c.context_window) {
                delete caps.context_window_options;
            }

            await request('builtin_models.php', 'POST', {
                id: id,
                label: label,
                upstream_model: upstream,
                endpoint: endpoint,
                api_key: key,
                multiplier: get('bmMultiplier').value.trim(),
                capabilities: caps,
                enabled: enabled,
                is_default: isDefault,
                sort_order: Number(get('bmOrder').value)
            });

            await loadBuiltinModels();
        });
    };

    const creditText = value => {
        const text = String(value ?? '0');
        const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
        if (!match) return text;
        const integer = match[2].replace(/^0+(?=\d)/, '');
        const fraction = (match[3] || '').replace(/0+$/, '');
        const number = integer + (fraction ? '.' + fraction : '');
        return (number === '0' ? '' : match[1]) + number;
    };
    window.manageUserCredits = async function(user, name = '') {
        try {
            const endpoint = 'users.php?action=membership&user_id=' + encodeURIComponent(user);
            const data = await request(endpoint);
            showModal(`<div id="userCreditsPanel">
                <div class="modal-header"><h3>积分管理 · 用户 ${esc(user)}</h3></div>
                <div class="modal-body">
                    <p>用户：${esc(name || user)}</p>
                    <p>当前余额：<strong id="ucBalance"></strong> 积分</p>
                    <p>下次重置：<span id="ucReset"></span>（北京时间）</p>
                    <p>手动增减仅调整当前周期余额，下次重置按原有套餐规则处理。</p>
                    <form id="ucForm">
                        <div class="form-group"><label for="ucDirection">调整方式</label><select class="form-input" id="ucDirection"><option value="add">增加积分</option><option value="subtract">扣除积分</option></select></div>
                        <div class="form-group"><label for="ucAmount">积分数量（正数，最多 6 位小数）</label><input class="form-input" id="ucAmount" type="text" inputmode="decimal" autocomplete="off" required placeholder="例如 100 或 0.5"></div>
                        <div class="form-group"><label for="ucReason">调整原因（必填，1–500 字）</label><textarea class="form-input" id="ucReason" rows="3" required></textarea></div>
                        <button class="btn-primary" id="ucSubmit" type="submit">提交调整</button>
                    </form>
                    <p id="ucMessage" role="status" aria-live="polite"></p>
                    <hr><h3>积分流水</h3>
                    <div class="credits-ledger-scroll"><table class="table"><thead><tr><th>时间（北京时间）</th><th>类型</th><th>变动</th><th>余额</th><th>说明</th><th>管理员 ID</th></tr></thead><tbody id="ucLedger"></tbody></table></div>
                    <div id="ucPages" style="padding-top:12px"></div>
                </div>
                <div class="modal-footer"><button class="btn-secondary" id="ucRefresh" type="button">刷新余额和流水</button><button class="btn-secondary" id="ucClose" type="button">关闭</button></div>
            </div>`, {wide: true});
            const panel = get('userCreditsPanel');
            const active = () => panel.isConnected && get('modal').classList.contains('show');
            let busy = false, history = data.ledger;
            const kinds = {monthly_reset:'月度重置',membership_grant:'套餐开通',admin_adjustment:'人工调整',model_usage:'模型消耗',usage_missing:'缺少真实用量',membership_purchase:'购买生效',membership_queued:'会员排队',upgrade_transfer_out:'升级转出',upgrade_transfer_in:'升级转入'};
            function message(text, error = false) {
                if (!active()) return;
                get('ucMessage').textContent = text;
                get('ucMessage').style.color = error ? 'var(--danger, #dc2626)' : 'var(--text-secondary)';
            }
            function account(value) {
                if (!active()) return;
                get('ucBalance').textContent = creditText(value.balance);
                get('ucReset').textContent = value.resets_at;
            }
            function renderLedger(value) {
                if (!active()) return;
                history = value;
                get('ucLedger').innerHTML = value.items.length ? value.items.map(row => {
                    const delta = creditText(row.delta);
                    return `<tr><td>${esc(row.created_at)}</td><td>${esc(kinds[row.kind] || row.kind)}</td><td>${esc(delta !== '0' && !delta.startsWith('-') ? '+' + delta : delta)}</td><td>${esc(creditText(row.balance))}</td><td>${esc(row.details?.reason || row.details?.model_id || '—')}</td><td>${esc(row.details?.admin_id ?? '—')}</td></tr>`;
                }).join('') : '<tr><td colspan="6">暂无积分流水</td></tr>';
                get('ucPages').innerHTML = `<button id="ucPrev" class="btn-secondary" type="button" ${busy || value.page <= 1 ? 'disabled' : ''}>上一页</button> 第 ${value.page} 页 · 共 ${value.total} 条 <button id="ucNext" class="btn-secondary" type="button" ${busy || value.page * 20 >= value.total ? 'disabled' : ''}>下一页</button>`;
                get('ucPrev').onclick = () => refresh(value.page - 1);
                get('ucNext').onclick = () => refresh(value.page + 1);
            }
            function setBusy(value) {
                busy = value;
                if (!active()) return;
                ['ucDirection','ucAmount','ucReason','ucSubmit','ucRefresh','ucClose'].forEach(id => { get(id).disabled = value; });
                renderLedger(history);
            }
            async function refresh(page = 1) {
                if (busy || !active()) return;
                setBusy(true);
                try {
                    const fresh = await request(endpoint + '&page=' + page);
                    account(fresh.account);
                    renderLedger(fresh.ledger);
                    message('余额和流水已刷新');
                } catch (error) { message(error.message, true); }
                finally { setBusy(false); }
            }
            account(data.account);
            renderLedger(data.ledger);
            get('ucRefresh').onclick = () => refresh();
            get('ucClose').onclick = hideModal;
            get('ucForm').onsubmit = async event => {
                event.preventDefault();
                if (busy || !active()) return;
                const amount = get('ucAmount').value.trim(), reason = get('ucReason').value.trim();
                if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(amount) || /^0+(?:\.0+)?$/.test(amount)) {
                    message('请输入大于零、最多 9 位整数和 6 位小数的积分数量', true); return;
                }
                if (!reason || Array.from(reason).length > 500) {
                    message('请填写 1–500 字的调整原因', true); return;
                }
                const delta = (get('ucDirection').value === 'subtract' ? '-' : '') + amount;
                const listPage = currentPage, filters = {...currentFilters};
                setBusy(true);
                message('正在调整积分…');
                let saved = false;
                try {
                    const updated = await request('users.php?action=adjust_credits&user_id=' + encodeURIComponent(user), 'POST', {delta, reason});
                    saved = true;
                    account(updated.account);
                    if (active()) { get('ucAmount').value = ''; get('ucReason').value = ''; }
                    let refreshError = false;
                    try {
                        const fresh = await request(endpoint + '&page=1');
                        account(fresh.account);
                        renderLedger(fresh.ledger);
                    } catch (_) { refreshError = true; }
                    try { if (await loadUsers(listPage, filters) === false) refreshError = true; } catch (_) { refreshError = true; }
                    message(refreshError ? '积分已调整成功，但刷新失败，请刷新查看最新余额和流水。' : '积分已调整成功，余额和流水已更新。', refreshError);
                } catch (error) {
                    message(saved ? '积分已调整成功，请刷新查看最新余额和流水。' : error.message, true);
                } finally { setBusy(false); }
            };
        } catch (error) { report(error); }
    };

    window.editUserMembership=async function(user) {
        try {
            const data=await request('users.php?action=membership&user_id='+user),a=data.account;
            showModal(`<div class="modal-header"><h3>会员与积分 · 用户 ${user}</h3></div><p>当前：${esc(a.plan.name)} · ${esc(Number(a.balance))} 积分</p><p>重置：${esc(a.resets_at)}（北京时间）</p><p>到期：${esc(a.expires_at||'免费版')}</p><div class="form-group"><label>开通／切换套餐</label><select class="form-input" id="umPlan">${data.plans.map(p=>`<option value="${p.id}" ${p.id===a.plan.id?'selected':''}>${esc(p.name)} · ${Number(p.monthly_credits)} 积分／月</option>`).join('')}</select></div>${field('umExpiry','会员到期时间（北京时间；留空默认一个月）','','datetime-local')}<button class="btn-primary" id="umGrant">开通／切换／续期并重置额度</button><hr>${field('umDelta','积分调整值（负数为扣除）')}${field('umReason','调整原因')}<button class="btn-secondary" id="umAdjust">调整积分</button><hr><h3>积分流水</h3><div style="overflow:auto"><table class="table"><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>余额</th><th>说明</th></tr></thead><tbody id="umLedger"></tbody></table></div><div id="umPages"></div><div class="modal-footer"><button class="btn-secondary" onclick="hideModal()">关闭</button></div>`,{wide:true});
            const kinds={monthly_reset:'月度重置',membership_grant:'套餐开通',admin_adjustment:'人工调整',model_usage:'模型消耗',usage_missing:'缺少真实用量'};
            function ledger(h){get('umLedger').innerHTML=h.items.map(r=>`<tr><td>${esc(r.created_at)}</td><td>${esc(kinds[r.kind]||r.kind)}</td><td>${Number(r.delta)}</td><td>${Number(r.balance)}</td><td>${esc(r.details.reason||r.details.model_id||'')}</td></tr>`).join('');get('umPages').innerHTML=`<button id="umPrev" class="btn-secondary" ${h.page<=1?'disabled':''}>上一页</button> ${h.page} <button id="umNext" class="btn-secondary" ${h.page*20>=h.total?'disabled':''}>下一页</button>`;get('umPrev').onclick=()=>loadPage(h.page-1);get('umNext').onclick=()=>loadPage(h.page+1);}
            async function loadPage(page){try{ledger((await request('users.php?action=membership&user_id='+user+'&page='+page)).ledger);}catch(error){report(error);}}
            ledger(data.ledger);
            function action(button,fn){get(button).onclick=async()=>{get(button).disabled=true;try{await fn();hideModal();await loadUsers(currentPage,currentFilters);showAlert('success','已更新会员账户');}catch(error){report(error);if(get(button))get(button).disabled=false;}};}
            action('umGrant',()=>request('users.php?action=set_membership&user_id='+user,'POST',{plan_id:Number(get('umPlan').value),expires_at:get('umExpiry').value.replace('T',' ')||null}));
            action('umAdjust',()=>request('users.php?action=adjust_credits&user_id='+user,'POST',{delta:get('umDelta').value,reason:get('umReason').value}));
        }catch(error){report(error);}
    };
    document.addEventListener('click',async event=>{
        const button=event.target.closest('[data-credits-user],[data-plan-edit],[data-plan-delete],[data-model-edit],[data-model-delete]');if(!button)return;
        if(button.dataset.creditsUser!==undefined){
            if(button.disabled)return;
            button.disabled=true;
            try{await manageUserCredits(button.dataset.creditsUser,button.dataset.creditsName);}finally{button.disabled=false;}
            return;
        }
        if(button.dataset.planEdit!==undefined)return editMembershipPlan(Number(button.dataset.planEdit));
        if(button.dataset.modelEdit!==undefined)return editBuiltinModel(Number(button.dataset.modelEdit));
        const plan=button.dataset.planDelete!==undefined,index=Number(plan?button.dataset.planDelete:button.dataset.modelDelete),item=(plan?plans:models)[index];
        if(!confirm('删除 '+(item.name||item.label)+'？历史账本保留'+(plan?'，已有会员保留至到期':'，后续模型调用停止')+'。'))return;
        button.disabled=true;try{await request(plan?'membership_plans.php':'builtin_models.php','DELETE',{id:item.id});await(plan?loadMembershipPlans():loadBuiltinModels());}catch(error){report(error);button.disabled=false;}
    });
}());
