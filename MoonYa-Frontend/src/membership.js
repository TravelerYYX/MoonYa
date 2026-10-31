(function () {
    'use strict';
    const message='你已达到使用上限。升级套餐以继续，或在积分重置后再试。';
    const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const number=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:6});
    const date=value=>value ? value+'（北京时间）' : '—';
    let account=null,plans=[],generation=0,owner=null,returnFocus=null;
    let view='detail',loadError='',loading=false;
    let purchaseEnabled=false,purchaseMessage='',csrf=null,buying=false,buyVersion=0,paymentEpoch=0,pollTimer=null,ordersPage=1,ordersVersion=0;
    const requestKeys=new Map();
    const overlay=document.createElement('div');overlay.className='membership-overlay';overlay.hidden=true;
    overlay.innerHTML=`<section class="membership-page" role="dialog" aria-modal="true" aria-labelledby="membershipTitle" tabindex="-1">
        <header class="membership-header"><button class="membership-back" type="button" aria-label="返回">‹</button><span class="membership-brand" hidden>MoonYa</span><button class="membership-close" type="button" aria-label="关闭订阅页面">${MoonYaIcons.icon('close')}</button></header>
        <div class="membership-hero"><h1 id="membershipTitle">个人订阅</h1><p class="membership-current-plan">免费版</p></div>
        <div class="membership-load-status" role="status"></div>
        <div class="membership-detail"><button class="membership-row membership-show-plans" type="button"><span>查看与升级套餐</span><span aria-hidden="true">›</span></button><div class="membership-account" aria-live="polite"></div><div class="membership-benefits"></div></div>
        <div class="membership-catalog"><div class="membership-catalog-account"></div><div class="membership-section-heading"><h2>选择你的月度套餐</h2><span>人民币 · 每月</span></div><div class="membership-plans"></div><p class="membership-note">每月重置积分，剩余积分不结转。购买暂未开放。</p></div>
        <button class="membership-row membership-ledger-toggle" type="button" aria-expanded="false"><span>积分消耗明细</span><span aria-hidden="true">›</span></button><div class="membership-ledger" hidden></div>
    </section>`;
    document.body.append(overlay);
    const status=overlay.querySelector('.membership-account'),cards=overlay.querySelector('.membership-plans');
    const note=overlay.querySelector('.membership-note');
    const purchases=document.createElement('div');purchases.className='membership-purchases';
    const ordersToggle=document.createElement('button');ordersToggle.type='button';ordersToggle.className='membership-row membership-orders-toggle';ordersToggle.innerHTML='<span>订阅与订单记录</span><span aria-hidden="true">›</span>';ordersToggle.setAttribute('aria-expanded','false');
    const ordersHost=document.createElement('div');ordersHost.className='membership-orders';ordersHost.hidden=true;
    overlay.querySelector('.membership-detail').after(purchases);
    overlay.querySelector('.membership-ledger-toggle').after(ordersToggle,ordersHost);
    const page=overlay.querySelector('.membership-page');
    const dialogOverlay=document.createElement('div');dialogOverlay.className='membership-dialog-overlay';dialogOverlay.hidden=true;
    dialogOverlay.innerHTML=`<section class="membership-dialog" role="dialog" aria-modal="true" aria-labelledby="membershipDialogTitle" aria-describedby="membershipDialogMessage" tabindex="-1"><button class="membership-dialog-close" type="button" aria-label="关闭弹窗">${MoonYaIcons.icon('close')}</button><h2 id="membershipDialogTitle"></h2><p id="membershipDialogMessage" role="status"></p><div class="membership-dialog-actions"></div></section>`;
    overlay.append(dialogOverlay);
    const dialogTitle=dialogOverlay.querySelector('h2'),dialogMessage=dialogOverlay.querySelector('p'),dialogActions=dialogOverlay.querySelector('.membership-dialog-actions');
    let dialogVersion=0,dialogFocus=null,dialogResolve=null,dialogKind='',deferredNotice=null;
    const notifiedPayments=new Set(),busyOrders=new Set();
    function closeDialog(accepted=false,discard=false){
        dialogVersion++;const resolve=dialogResolve;dialogResolve=null;dialogOverlay.hidden=true;dialogKind='';
        page.inert=false;overlay.classList.remove('membership-dialog-open');
        if(!overlay.hidden){const target=dialogFocus?.isConnected&&dialogFocus.getClientRects().length?dialogFocus:overlay.querySelector('.membership-close');target?.focus();}
        dialogFocus=null;resolve?.(accepted);
        const notice=deferredNotice;deferredNotice=null;
        if(!discard&&notice&&contextValid(notice.user,notice.epoch))showNotice(notice.message,notice.title);
    }
    function showDialog(title,text,actions,kind='notice'){
        const focus=dialogOverlay.hidden?document.activeElement:dialogFocus;
        closeDialog(false,true);dialogFocus=focus;dialogKind=kind;const token=++dialogVersion;
        dialogTitle.textContent=title;dialogMessage.textContent=text;dialogActions.replaceChildren();
        for(const action of actions){const button=document.createElement('button');button.type='button';button.className='membership-dialog-'+(action.style||'primary');button.textContent=action.text;button.onclick=()=>action.run(token);dialogActions.append(button);}
        dialogOverlay.hidden=false;page.inert=true;overlay.classList.add('membership-dialog-open');
        dialogActions.querySelector('button')?.focus();return token;
    }
    function showNotice(text,title='提示'){
        return showDialog(title,text,[{text:'确定',run:()=>closeDialog()}]);
    }
    function confirmPayment(title,text,confirmText='确认'){
        showDialog(title,text,[{text:confirmText,run:()=>closeDialog(true)},{text:'取消',style:'cancel',run:()=>closeDialog()}],'confirm');
        return new Promise(resolve=>{dialogResolve=resolve;});
    }
    dialogOverlay.querySelector('.membership-dialog-close').onclick=()=>closeDialog();
    function purchaseKind(plan){if(account?.plan.is_free||!account?.expires_at)return '开通';if(plan.id===account.plan.id)return '续费';return plan.tier_rank>account.plan.tier_rank?'升级':'到期后切换';}
    const accountName=document.getElementById('accountMenuPlan'),balance=document.getElementById('accountMenuCredits');
    function syncSummary(){
        const name=account?.plan.name||'免费版';
        if(accountName)accountName.textContent=name;
        if(balance)balance.textContent=account?number(account.balance)+' 积分':'积分暂不可用';
        const profilePlan=document.getElementById('userPlan');if(profilePlan)profilePlan.textContent=name;
        const settingsName=document.getElementById('settingsPlanName');if(settingsName)settingsName.textContent=name;
        const settingsStatus=document.getElementById('settingsPlanStatus');
        if(settingsStatus)settingsStatus.textContent=!isLoggedIn?'请登录':loadError?(account?'更新失败':'未加载'):account?(account.plan.is_free?'当前套餐':account.expires_at?'已开通':'当前套餐'):'加载中';
        const hint=document.getElementById('accountMenuMembershipStatus');if(hint)hint.textContent=loadError?(account?'更新失败，请打开订阅页重试':'会员信息未加载，请重试'):loading&&!account&&isLoggedIn?'正在加载会员信息…':'';
        overlay.querySelector('.membership-current-plan').textContent=view==='plans'?'选择每月积分额度，让 MoonYa 陪你完成更多工作':name+(account?.expires_at?' · 到期 '+date(account.expires_at):'');
        window.dispatchEvent(new Event('moonya:membership-state'));
    }
    function setView(next,focus=true){
        view=next;
        overlay.dataset.view=view;
        overlay.querySelector('.membership-brand').hidden=view!=='plans';
        overlay.querySelector('#membershipTitle').textContent={detail:'个人订阅',plans:'按你的节奏，开启更多可能',ledger:'积分消耗明细',orders:'订阅与订单记录'}[view];
        overlay.querySelector('.membership-detail').hidden=view!=='detail';
        overlay.querySelector('.membership-catalog').hidden=view!=='plans';
        const ledgerHost=overlay.querySelector('.membership-ledger');ledgerHost.hidden=view!=='ledger';
        ordersHost.hidden=view!=='orders';
        overlay.querySelector('.membership-ledger-toggle').setAttribute('aria-expanded',String(view==='ledger'));
        ordersToggle.setAttribute('aria-expanded',String(view==='orders'));
        if(view!=='orders')clearTimeout(pollTimer);
        overlay.querySelector('.membership-ledger-toggle').hidden=['ledger','orders'].includes(view);
        ordersToggle.hidden=['ledger','orders'].includes(view);
        purchases.hidden=view!=='plans';
        overlay.querySelector('.membership-page').scrollTop=0;
        overlay.scrollTop=0;
        syncSummary();
        if(focus)overlay.querySelector('.membership-close').focus();
    }
    function renderQuota(){
        if(!account){status.textContent=isLoggedIn?'会员信息未加载':'请先登录后查看会员与积分';overlay.querySelector('.membership-benefits').replaceChildren();return;}
        const allowance=Number(account.period_allowance),available=account.period_allowance!==undefined&&account.period_allowance!==null&&Number.isFinite(allowance)&&allowance>=0;
        const remaining=Number(account.balance),ratio=available?(allowance>0?Math.min(100,Math.max(0,remaining/allowance*100)):remaining>0?100:0):0;
        status.innerHTML=`<div class="membership-quota-heading"><span>本月剩余额度</span><span>${number(remaining)}${available?' / '+number(allowance):''} 积分</span></div>${available?`<div class="membership-quota-track" role="progressbar" aria-label="本月剩余额度比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${ratio}" aria-valuetext="剩余 ${number(remaining)} 积分，周期额度 ${number(allowance)} 积分"><span style="width:${ratio}%"></span></div>`:'<p class="membership-muted">周期额度暂不可用</p>'}<p class="membership-muted">${escape(date(account.resets_at))} 重置</p>`;
        const groups=Array.isArray(account.plan.features)?account.plan.features:[];
        overlay.querySelector('.membership-benefits').innerHTML=(account.plan.description||groups.length)?`<h2>套餐权益</h2>${account.plan.description?'<p>'+escape(account.plan.description)+'</p>':''}${groups.map(group=>`<section><h3>${escape(group.title)}</h3><ul>${(group.items||[]).map(item=>'<li>'+escape(item)+'</li>').join('')}</ul></section>`).join('')}`:'';
    }
    function render(){
        const restoreFocus=overlay.contains(document.activeElement)&&document.activeElement.classList.contains('membership-subscribe');
        syncSummary();renderQuota();
        const catalogAccount=overlay.querySelector('.membership-catalog-account');
        catalogAccount.innerHTML=account?`<div><span>当前套餐</span><strong>${escape(account.plan.name)}</strong></div><div><span>剩余积分</span><strong>${number(account.balance)}</strong></div><div><span>下次重置</span><span>${escape(date(account.resets_at))}</span></div>${account.expires_at?`<div><span>会员到期</span><span>${escape(date(account.expires_at))}</span></div>`:''}`:'';
        const loadStatus=overlay.querySelector('.membership-load-status');loadStatus.replaceChildren();
        if(loadError){const text=document.createElement('span');text.textContent=(account?'更新失败，以下为上次成功加载的信息。':'会员信息未加载。')+' '+loadError;const retry=document.createElement('button');retry.type='button';retry.className='membership-retry';retry.textContent='重新加载';retry.onclick=refresh;loadStatus.append(text,retry);}
        else if(loading&&!account&&isLoggedIn)loadStatus.textContent='正在加载会员信息…';
        if(!account){cards.replaceChildren();purchases.replaceChildren();return;}
        note.textContent='每月重置积分，剩余积分不结转。'+(purchaseEnabled?'手动购买，不自动扣款。':purchaseMessage||'购买暂未开放。');
        purchases.innerHTML=(account.queued_purchases||[]).length?'<h3>已购待生效套餐</h3>'+account.queued_purchases.map(p=>`<p><strong>${escape(p.plan.name)}</strong> · ${escape(date(p.starts_at))} 至 ${escape(date(p.ends_at))}</p>`).join('')+'<small>按付款确认顺序生效，预计日期随升级或人工调整顺延。</small>':'';
        cards.replaceChildren();
        const order={free:0,go:1,plus:2,pro:3,max:4};
        const catalog=[...plans].sort((a,b)=>(a.is_free?0:order[a.code]??a.tier_rank??99)-(b.is_free?0:order[b.code]??b.tier_rank??99));
        for(const plan of catalog){
            const card=document.createElement('article');card.className='membership-card'+(account.plan.id===plan.id?' current':'');
            card.innerHTML=`<div class="membership-card-head"><h3>${escape(plan.name)}</h3>${account.plan.id===plan.id?'<span class="membership-current">已开通</span>':''}</div><p class="membership-description">${escape(plan.description)}</p><div class="membership-price"><span>¥</span><strong>${number(plan.price_cents/100)}</strong><span>／月</span></div><div class="membership-allowance">${number(plan.monthly_credits)}<span> 积分／月</span></div><button class="membership-subscribe" type="button" disabled>暂未开放购买</button><div class="membership-features">${(plan.features||[]).map(group=>`<section><h4>${escape(group.title)}</h4><ul>${(group.items||[]).map(item=>`<li><span aria-hidden="true">${MoonYaIcons.icon('check')}</span><span>${escape(item)}</span></li>`).join('')}</ul></section>`).join('')}</div>`;
            cards.append(card);
            const button=card.querySelector('.membership-subscribe');
            const allowed=!plan.is_free&&purchaseEnabled&&Number.isInteger(plan.tier_rank)&&plan.price_cents>0&&(account.plan.is_free||Number.isInteger(account.plan.tier_rank));
            button.disabled=!allowed||buying||!!loadError;button.textContent=plan.is_free?(account.plan.id===plan.id?'已开通':'免费版'):allowed?purchaseKind(plan):'暂未开放购买';button.onclick=()=>buy(plan);
        }
        if(!cards.children.length)cards.textContent='暂无可开通的会员套餐';
        if(restoreFocus)overlay.querySelector('.membership-close').focus();
    }
    async function request(path,body){const response=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify(body)});const result=await response.json();if(!response.ok||!result.success)throw new Error(result.error||'会员信息加载失败，请重试');return result.data;}
    async function refresh(){
        const user=isLoggedIn?String(currentUser?.id||''):'';const current=++generation;
        if(!user){owner=null;account=null;plans=[];loading=false;loadError='';render();return;}
        if(owner!==user){account=null;plans=[];owner=user;overlay.querySelector('.membership-ledger').replaceChildren();}
        loading=true;loadError='';render();
        try{
            const data=await request('/api/membership.php');if(current!==generation||String(currentUser?.id)!==user)return;
            if(!data?.account?.plan||!Number.isFinite(Number(data.account.balance))||!Array.isArray(data.plans))throw new Error('会员信息加载失败，请重试');
            account=data.account;plans=data.plans;purchaseEnabled=data.purchase_enabled===true;purchaseMessage=data.purchase_message||'';csrf=data.csrf_token||null;loading=false;render();
        }catch(error){if(current!==generation)return;loading=false;loadError=error.message||'请求失败';render();}
    }
    function stopPayment(){paymentEpoch++;buyVersion++;buying=false;ordersVersion++;busyOrders.clear();clearTimeout(pollTimer);pollTimer=null;}
    function close(){stopPayment();closeDialog(false,true);overlay.hidden=true;document.body.classList.remove('membership-open');returnFocus?.focus();}
    async function open(next='plans'){
        if(typeof next!=='string')next='plans';
        if(overlay.hidden)returnFocus=document.activeElement;overlay.hidden=false;document.body.classList.add('membership-open');setView(next);
        window.dispatchEvent(new Event('moonya:membership-open'));await refresh();if(!ordersHost.hidden&&account)void loadOrders(ordersPage);void MoonYaClient.refreshConfig();
    }
    overlay.querySelector('.membership-close').onclick=close;
    overlay.querySelector('.membership-back').onclick=()=>view==='detail'?close():setView('detail');
    overlay.querySelector('.membership-show-plans').onclick=()=>setView('plans');
    document.addEventListener('keydown',event=>{
        if(event.key==='Escape'&&!overlay.hidden){event.preventDefault();event.stopImmediatePropagation();if(!dialogOverlay.hidden)closeDialog();else close();}
    },true);
    overlay.addEventListener('keydown',event=>{
        if(event.key==='Tab'){
            const host=dialogOverlay.hidden?page:dialogOverlay;
            const controls=[...host.querySelectorAll('button:not(:disabled),[href],input')].filter(el=>el.getClientRects().length);
            const first=controls[0],last=controls.at(-1);
            if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
            else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
        }
    });
    let ledgerPage=1,ledgerVersion=0;
    async function ledger(page=1){
        const host=overlay.querySelector('.membership-ledger'),current=++ledgerVersion,user=owner,epoch=paymentEpoch;host.hidden=false;host.textContent='正在加载积分记录…';
        try{
            const data=await request('/api/membership.php?action=ledger&page='+page);if(current!==ledgerVersion||!contextValid(user,epoch)||host.hidden)return;
            ledgerPage=page;const kinds={monthly_reset:'月度重置',membership_grant:'套餐开通',membership_purchase:'付费开通',membership_queued:'已购待生效',upgrade_transfer_in:'升级积分转入',upgrade_transfer_out:'升级积分转出',admin_adjustment:'人工调整',model_usage:'模型消耗',usage_missing:'缺少真实用量，未扣分'};
            host.innerHTML=`<table><thead><tr><th>时间</th><th>类型</th><th>积分变动</th><th>余额</th></tr></thead><tbody>${data.items.map(row=>`<tr><td>${escape(row.created_at)}</td><td>${escape(kinds[row.kind]||row.kind)}${row.details.model_id?'<small>'+escape(row.details.model_id)+'</small>':''}</td><td>${number(row.delta)}</td><td>${number(row.balance)}</td></tr>`).join('')}</tbody></table><div class="membership-pagination"><button ${page<=1?'disabled':''}>上一页</button><span>${page}</span><button ${page*20>=data.total?'disabled':''}>下一页</button></div>`;
            const buttons=host.querySelectorAll('button');buttons[0].onclick=()=>ledger(ledgerPage-1);buttons[1].onclick=()=>ledger(ledgerPage+1);
        }catch(error){if(current===ledgerVersion&&contextValid(user,epoch)&&!host.hidden)host.textContent=error.message;}
    }
    overlay.querySelector('.membership-ledger-toggle').onclick=event=>{
        setView('ledger');event.currentTarget.setAttribute('aria-expanded','true');void ledger();
    };
    function quotaNotice(host){
        if(!host||host.querySelector('.credits-exhausted-notice'))return;
        const notice=document.createElement('div');notice.className='credits-exhausted-notice';notice.setAttribute('role','status');
        notice.innerHTML='<span class="credits-notice-line"></span><span class="credits-notice-text"><span aria-hidden="true">'+MoonYaIcons.icon('info')+'</span> 你已达到使用上限。<button type="button">升级套餐</button>以继续，或在积分重置后再试。</span><span class="credits-notice-line"></span>';
        (host.querySelector('.message-content')||host).append(notice);host.dataset.quotaStopped='1';
    }
    document.addEventListener('click',event=>{if(event.target.closest('.credits-exhausted-notice button'))void open();});
    document.getElementById('accountMenuUpgrade').onclick=open;
    window.addEventListener('moonya:auth-state',()=>{
        const user=isLoggedIn?String(currentUser?.id||''):'';
        if(user!==(owner||'')){stopPayment();closeDialog(false,true);generation++;owner=null;account=null;plans=[];purchaseEnabled=false;csrf=null;requestKeys.clear();notifiedPayments.clear();ordersHost.replaceChildren();purchases.replaceChildren();overlay.querySelector('.membership-ledger').replaceChildren();}
        void refresh();
    });
    window.addEventListener('focus',()=>{if(!overlay.hidden||!document.getElementById('accountMenu').hidden)void refresh();});
    let pendingReturnOrder=null;
    async function paymentReturn(orderNumber){
        if(!/^MY[a-zA-Z0-9]{14,38}$/.test(orderNumber))return;
        pendingReturnOrder=orderNumber;
        if(!isLoggedIn){await open('orders');showNotice('请先登录后查看付款结果。','付款结果');return;}
        await open('orders');
        if(!isLoggedIn||pendingReturnOrder!==orderNumber)return;
        pendingReturnOrder=null;
        const user=owner,epoch=paymentEpoch;
        while(busyOrders.has(orderNumber)&&contextValid(user,epoch))await new Promise(resolve=>setTimeout(resolve,100));
        if(!contextValid(user,epoch))return;
        const token=showNotice('正在更新订单与会员信息…','付款结果');
        await syncOrder(orderNumber,user,epoch,{manual:true,token});
    }
    window.addEventListener('moonya:auth-state',()=>{if(isLoggedIn&&pendingReturnOrder)void paymentReturn(pendingReturnOrder);});
    window.MoonYaMembership={open,openDetail:()=>open('detail'),close,refresh,quotaNotice,message,paymentReturn,settlement:()=>refresh(),account:()=>account};
    function contextValid(user,epoch){return !overlay.hidden&&isLoggedIn&&String(currentUser?.id)===user&&owner===user&&paymentEpoch===epoch;}
    function checkoutLink(order,url){
        const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.pathname.endsWith('/api/alipay.php')||parsed.searchParams.get('action')!=='checkout')throw new Error('付款链接无效，请重试');
        const user=owner,epoch=paymentEpoch;
        showDialog('完成支付',`${order.plan.name} · ¥${number(order.amount_cents/100)}\n请在浏览器中完成支付宝付款，然后点击“我已完成支付”查询结果。如果浏览器未打开，可再次点击“继续付款”。`,[
            {text:'继续付款',run:()=>{if(contextValid(user,epoch))window.open(parsed.href,'_blank','noopener,noreferrer');}},
            {text:'我已完成支付',style:'secondary',run:token=>syncOrder(order.order_no,user,epoch,{manual:true,token})}
        ],'payment');
    }
    async function buy(plan){
        if(buying||!purchaseEnabled||loadError||plan.is_free)return;
        const kind=purchaseKind(plan),description=kind==='升级'?'立即生效，保留原剩余积分并加入新套餐整月积分；原剩余天数作废，从确认付款起算一个月。已付款的待生效套餐保留并顺延。':kind==='开通'?'立即生效，发放所购套餐整月积分；免费版剩余积分结束。':'付款后按已购队列顺序生效；当前周期结束后才发放新套餐积分，不结转剩余积分。';
        const user=owner,epoch=paymentEpoch,version=++buyVersion;buying=true;let token=null;
        try{
            const accepted=await confirmPayment(`${kind} ${plan.name}`,`¥${number(plan.price_cents/100)}／月\n${description}\n手动购买一个月，不自动扣款。`,'确认购买');
            if(!accepted||!contextValid(user,epoch))return;
            render();
            token=showNotice('正在创建订单…','创建订单');
            if(!requestKeys.has(plan.id))requestKeys.set(plan.id,{key:crypto.randomUUID(),order_no:null});
            const purchaseRequest=requestKeys.get(plan.id);
            const data=await request('/api/membership.php?action=create_order',{plan_id:plan.id,request_key:purchaseRequest.key});
            if(!contextValid(user,epoch))return;
            purchaseRequest.order_no=data.order.order_no;
            if(['expired','closed'].includes(data.order.status)){requestKeys.delete(plan.id);throw new Error('原订单已结束，请重新选择套餐创建订单。');}
            if(data.order.status==='paid'){requestKeys.delete(plan.id);if(dialogVersion===token)showNotice('该订单已付款。再次购买请重新选择套餐。');await refresh();}
            else if(dialogVersion===token){if(data.checkout_url)checkoutLink(data.order,data.checkout_url);else showNotice('订单已创建，请查询支付结果。');}
            ordersHost.hidden=false;ordersToggle.setAttribute('aria-expanded','true');await loadOrders(1);
        }catch(error){if(contextValid(user,epoch)){if(token===dialogVersion)showNotice(error.message);ordersHost.hidden=false;ordersToggle.setAttribute('aria-expanded','true');void loadOrders(1);}}
        finally{if(version===buyVersion){buying=false;if(owner===user)render();}}
    }
    const paymentKinds={pending:'待付款',paid:'已付款',expired:'付款期限已过',closed:'已关闭'};
    const purchaseKinds={queued:'待生效',active:'使用中',expired:'已到期',replaced:'已切换'};
    async function loadOrders(page=1){
        const user=owner,epoch=paymentEpoch;if(!user||overlay.hidden||ordersHost.hidden)return;
        const version=++ordersVersion;clearTimeout(pollTimer);
        try{
            const data=await request('/api/membership.php?action=orders&page='+page);if(version!==ordersVersion||!contextValid(user,epoch)||ordersHost.hidden)return;
            if(!data.items.length&&page>1&&data.total<=((page-1)*20))return loadOrders(Math.max(1,Math.ceil(data.total/20)));
            ordersPage=page;
            for(const order of data.items)if(order.status!=='pending'&&requestKeys.get(order.plan.id)?.order_no===order.order_no)requestKeys.delete(order.plan.id);
            ordersHost.innerHTML=data.items.length?`<table><thead><tr><th>套餐与订单</th><th>金额</th><th>付款／权益</th><th>生效日期</th><th>操作</th></tr></thead><tbody>${data.items.map(o=>`<tr><td>${escape(o.plan.name)}<small>${escape(o.order_no)}</small></td><td>¥${number(o.amount_cents/100)}</td><td>${escape(paymentKinds[o.status]||o.status)}${o.purchase?'<small>'+escape(purchaseKinds[o.purchase.status]||o.purchase.status)+'</small>':''}</td><td>${escape(o.purchase?.starts_at||'—')}<small>${escape(o.purchase?.ends_at||'')}</small></td><td>${o.status==='pending'?`<button type="button" data-resume="${escape(o.order_no)}">继续付款</button>`:''}${o.status!=='paid'?`<button type="button" data-sync="${escape(o.order_no)}">我已支付，查询结果</button>`:''}${o.can_delete===true?`<button type="button" data-delete="${escape(o.order_no)}" data-delete-plan="${escape(o.plan.id)}">删除订单</button>`:''}</td></tr>`).join('')}</tbody></table>`:'暂无订单记录';
            const pages=document.createElement('div');pages.className='membership-pagination';pages.innerHTML=`<button type="button" ${page<=1?'disabled':''}>上一页</button><span>${page}</span><button type="button" ${page*20>=data.total?'disabled':''}>下一页</button>`;ordersHost.append(pages);
            const buttons=pages.querySelectorAll('button');buttons[0].onclick=()=>loadOrders(page-1);buttons[1].onclick=()=>loadOrders(page+1);
            for(const button of ordersHost.querySelectorAll('[data-sync],[data-resume],[data-delete]')){button.disabled=busyOrders.has(button.dataset.sync||button.dataset.resume||button.dataset.delete);button.onclick=()=>orderAction(button);}
            const pending=data.items.find(o=>o.status==='pending');
            if(pending)pollTimer=setTimeout(()=>syncOrder(pending.order_no,user,epoch),5000);
        }catch(error){if(version===ordersVersion&&contextValid(user,epoch))showNotice(error.message,'订单加载失败');}
    }
    async function syncOrder(orderNumber,user=owner,epoch=paymentEpoch,{manual=false,token=null}={}){
        if(!contextValid(user,epoch)||busyOrders.has(orderNumber))return;
        busyOrders.add(orderNumber);clearTimeout(pollTimer);
        if(manual&&token===dialogVersion){dialogMessage.textContent='正在查询支付结果…';for(const button of dialogActions.querySelectorAll('button'))button.disabled=true;}
        try{
            const order=await request('/api/membership.php?action=sync_order',{order_no:orderNumber});if(!contextValid(user,epoch))return;
            if(order.status==='paid'){
                if(requestKeys.get(order.plan.id)?.order_no===order.order_no)requestKeys.delete(order.plan.id);
                const text=order.purchase?.status==='queued'?'付款已确认，套餐已加入待生效队列。':'付款已确认，会员信息已更新。';
                await refresh();if(!contextValid(user,epoch))return;
                if(manual?token===dialogVersion:!notifiedPayments.has(orderNumber)){
                    notifiedPayments.add(orderNumber);
                    if(!manual&&dialogKind==='confirm')deferredNotice={message:text,title:'支付成功',user,epoch};else showNotice(text,'支付成功');
                }
            }else if(manual&&token===dialogVersion){
                const text=order.status==='closed'?'订单已关闭。':order.status==='expired'?'付款期限已过，请重新选择套餐。':'尚未确认付款，请稍后再次查询。';
                if(dialogKind==='payment'&&order.status==='pending')dialogMessage.textContent=text;else showNotice(text,'支付结果');
            }
            if(contextValid(user,epoch))await loadOrders(ordersPage);
        }catch(error){if(contextValid(user,epoch)){if(manual&&token===dialogVersion){if(dialogKind==='payment')dialogMessage.textContent=error.message;else showNotice(error.message,'查询失败');}pollTimer=setTimeout(()=>syncOrder(orderNumber,user,epoch),10000);}}
        finally{if(contextValid(user,epoch)){busyOrders.delete(orderNumber);for(const button of ordersHost.querySelectorAll('[data-sync],[data-resume],[data-delete]'))if((button.dataset.sync||button.dataset.resume||button.dataset.delete)===orderNumber)button.disabled=false;}if(manual&&token===dialogVersion)for(const button of dialogActions.querySelectorAll('button'))button.disabled=false;}
    }
    async function orderAction(button){
        const orderNumber=button.dataset.sync||button.dataset.resume||button.dataset.delete;
        if(busyOrders.has(orderNumber))return;
        button.disabled=true;const user=owner,epoch=paymentEpoch;
        if(button.dataset.sync){const token=showNotice('正在查询支付结果…','支付结果');await syncOrder(orderNumber,user,epoch,{manual:true,token});button.disabled=false;return;}
        busyOrders.add(orderNumber);let token=null;
        try{
            if(button.dataset.delete){
                clearTimeout(pollTimer);
                const accepted=await confirmPayment('删除订单','删除后，该未付款订单将从你的订单列表移除，付款链接会失效。后台仍保留订单记录；如确认真实付款，会员权益仍会正常发放。','删除订单');
                if(!accepted||!contextValid(user,epoch))return;
                token=showNotice('正在删除订单…','删除订单');
                await request('/api/membership.php?action=delete_order',{order_no:orderNumber});if(!contextValid(user,epoch))return;
                requestKeys.delete(Number(button.dataset.deletePlan));
                for(const [id,value]of requestKeys)if(value.order_no===orderNumber)requestKeys.delete(id);
                if(token===dialogVersion)showNotice('订单已删除。');
            }else{
                token=showNotice('正在准备付款…','继续付款');
                const data=await request('/api/membership.php?action=resume_order',{order_no:orderNumber});if(!contextValid(user,epoch))return;
                if(token===dialogVersion){if(data.checkout_url)checkoutLink(data.order,data.checkout_url);else showNotice(data.order.status==='paid'?'该订单已付款。':'订单无法继续付款，请查询支付结果。');}
            }
        }catch(error){if(contextValid(user,epoch)){if(token===dialogVersion)showNotice(error.message);await refresh();}}
        finally{if(contextValid(user,epoch)){busyOrders.delete(orderNumber);button.disabled=false;await loadOrders(ordersPage);}}
    }
    ordersToggle.onclick=()=>{setView('orders');ordersToggle.setAttribute('aria-expanded','true');void loadOrders(1);};
    setView('detail',false);
    void refresh();
}());
