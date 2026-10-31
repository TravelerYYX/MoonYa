<?php
declare(strict_types=1);

/** Payment/queue operations share MembershipService's user-first transaction and clock. */
trait MembershipPurchases {
    private ?bool $hasPaymentSchema = null;
    public function paymentSchemaReady(): bool {
        return $this->hasPaymentSchema ??= (int)$this->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('membership_orders','membership_purchases','credit_transfers')")->fetchColumn()===3;
    }
    private function purchaseQueue(int $user): array {
        return array_map(static fn($r)=>['order_no'=>$r['order_no'],'plan'=>json_decode($r['plan_json'],true,32,JSON_THROW_ON_ERROR),
            'starts_at'=>$r['starts_at'],'ends_at'=>$r['ends_at'],'status'=>$r['status']],
            $this->query("SELECT * FROM membership_purchases WHERE user_id=? AND status='queued' ORDER BY id",[$user])->fetchAll());
    }
    private function reschedulePurchases(int $user, DateTimeImmutable $anchor, DateTimeImmutable $end): void {
        $offset=((int)$end->format('Y')-(int)$anchor->format('Y'))*12+(int)$end->format('m')-(int)$anchor->format('m');
        if ($offset<1 || self::month($anchor,$offset)!=$end) { $anchor=$end; $offset=0; }
        foreach ($this->query("SELECT id FROM membership_purchases WHERE user_id=? AND status='queued' ORDER BY id FOR UPDATE",[$user])->fetchAll() as $row) {
            $start=self::month($anchor,$offset);$finish=self::month($anchor,$offset+1);$offset++;
            $this->query('UPDATE membership_purchases SET starts_at=?,ends_at=?,schedule_anchor_at=? WHERE id=?',
                [$start->format('Y-m-d H:i:s'),$finish->format('Y-m-d H:i:s'),$anchor->format('Y-m-d H:i:s'),$row['id']]);
        }
    }
    private function rotatePurchases(array &$account, DateTimeImmutable $now): void {
        $user=(int)$account['user_id'];$stamp=$now->format('Y-m-d H:i:s');
        $this->query("UPDATE membership_purchases SET status='expired' WHERE user_id=? AND status='active' AND ends_at<=?",[$user,$stamp]);
        $due=$this->query("SELECT * FROM membership_purchases WHERE user_id=? AND status='queued' AND starts_at<=? ORDER BY id FOR UPDATE",[$user,$stamp])->fetchAll();
        if (!$due) return;
        foreach ($due as $purchase) {
            $live=$purchase['ends_at']>$stamp;
            $this->query('UPDATE membership_purchases SET status=? WHERE id=?',[$live?'active':'expired',$purchase['id']]);
            $plan=json_decode($purchase['plan_json'],true,32,JSON_THROW_ON_ERROR);
            $account['plan_id']=$plan['id'];$account['subscription_json']=$purchase['plan_json'];
            $account['anchor_at']=$purchase['schedule_anchor_at'];$account['expires_at']=$purchase['ends_at'];$account['current_period_id']=null;
            $this->query('UPDATE membership_accounts SET plan_id=?,subscription_json=?,anchor_at=?,expires_at=?,current_period_id=NULL,revision=revision+1 WHERE user_id=?',
                [$account['plan_id'],$account['subscription_json'],$account['anchor_at'],$account['expires_at'],$user]);
        }
    }
    public function createPaymentOrder(int $user, int $planId, string $requestKey, array $merchant): array {
        if (!$this->paymentSchemaReady()) throw new RuntimeException('请先执行支付数据库迁移');
        if (!preg_match('/^[a-zA-Z0-9_-]{16,80}$/D',$requestKey)) throw new InvalidArgumentException('购买请求标识无效');
        return $this->tx(function() use($user,$planId,$requestKey,$merchant) {
            $account=$this->account($user);$now=$this->now();$stamp=$now->format('Y-m-d H:i:s');
            $row=$this->query('SELECT * FROM membership_orders WHERE user_id=? AND request_key=? FOR UPDATE',[$user,$requestKey])->fetch();
            if ($row && (int)$row['plan_id']!==$planId) throw new InvalidArgumentException('同一请求不能购买不同套餐');
            if ($row && $row['user_deleted_at']!==null) {http_response_code(409);throw new InvalidArgumentException('订单已删除，请重新选择套餐购买');}
            if (!$row) {
                $this->query("UPDATE membership_orders SET status='expired',pending_user_id=NULL,checkout_hash=NULL WHERE user_id=? AND status='pending' AND expires_at<=?",[$user,$stamp]);
                if ($this->query("SELECT id FROM membership_orders WHERE pending_user_id=?",[$user])->fetch()) {
                    http_response_code(409);throw new InvalidArgumentException('已有待付款订单，请在订单记录中继续付款或等待订单到期');
                }
                $plan=$this->query('SELECT * FROM membership_plans WHERE id=? AND enabled=1 AND archived=0 FOR UPDATE',[$planId])->fetch();
                if (!$plan || $plan['is_free'] || (int)$plan['price_cents']<=0 || !isset($plan['tier_rank'])) throw new InvalidArgumentException('套餐不可购买，请检查价格和等级');
                if (!$account['plan']['is_free'] && !isset($account['plan']['tier_rank'])) throw new InvalidArgumentException('当前套餐尚未设置等级，请联系管理员');
                $number='MY'.$now->format('YmdHis').bin2hex(random_bytes(8));
                $this->query('INSERT INTO membership_orders (order_no,user_id,request_key,plan_id,plan_json,amount_cents,app_id,seller_id,environment,pending_user_id,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    [$number,$user,$requestKey,$planId,json_encode($this->publicPlan($plan),JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$plan['price_cents'],$merchant['app_id'],$merchant['seller_id'],$merchant['environment'],$user,$stamp,$now->modify('+30 minutes')->format('Y-m-d H:i:s')]);
                $row=$this->query('SELECT * FROM membership_orders WHERE order_no=?',[$number])->fetch();
            }
            $token=null;
            if ($row['status']==='pending' && $row['expires_at']>$stamp) {
                $token=bin2hex(random_bytes(32));
                $this->query('UPDATE membership_orders SET checkout_hash=? WHERE id=?',[hash('sha256',$token),$row['id']]);
            }
            return ['order'=>$this->publicOrder($row),'checkout_token'=>$token];
        });
    }
    public function checkoutOrder(string $token): array {
        if (!preg_match('/^[a-f0-9]{64}$/D',$token)) throw new InvalidArgumentException('付款链接无效');
        $row=$this->query("SELECT o.* FROM membership_orders o JOIN users u ON u.id=o.user_id WHERE checkout_hash=? AND o.status='pending' AND o.user_deleted_at IS NULL AND u.status='active' AND o.expires_at>?",[hash('sha256',$token),$this->now()->format('Y-m-d H:i:s')])->fetch();
        if (!$row) throw new InvalidArgumentException('付款链接已失效，请返回 MoonYa 查询订单');
        return $row;
    }
    public function paymentOrder(string $number, ?int $user=null): array {
        $row=$this->query('SELECT * FROM membership_orders WHERE order_no=?'.($user===null?'':' AND user_id=?'),$user===null?[$number]:[$number,$user])->fetch();
        if (!$row) { http_response_code(404);throw new InvalidArgumentException('订单不存在'); }
        return $row;
    }
    public function publicOrder(array $row): array {
        $purchase=$this->query('SELECT status,starts_at,ends_at FROM membership_purchases WHERE order_no=?',[$row['order_no']])->fetch();
        return ['order_no'=>$row['order_no'],'user_id'=>(int)$row['user_id'],'plan'=>json_decode($row['plan_json'],true,32,JSON_THROW_ON_ERROR),
            'amount_cents'=>(int)$row['amount_cents'],'status'=>$row['status']==='pending' && $row['expires_at']<=$this->now()->format('Y-m-d H:i:s')?'expired':$row['status'],
            'created_at'=>$row['created_at'],'expires_at'=>$row['expires_at'],'paid_at'=>$row['paid_at'],'confirmed_at'=>$row['confirmed_at'],'purchase'=>$purchase?:null,
            'can_delete'=>in_array($row['status'],['pending','expired','closed'],true) && $row['user_deleted_at']===null && $row['paid_at']===null && $row['confirmed_at']===null && !$purchase && !$this->query('SELECT order_no FROM credit_transfers WHERE order_no=?',[$row['order_no']])->fetch()];
    }
    public function paymentOrders(?int $user, int $page=1, string $status='', string $search='', bool $includeDeleted=false): array {
        $page=max(1,min($page,100000));$where=[];$args=[];
        if ($user!==null) {$where[]='user_id=?';$args[]=$user;if(!$includeDeleted)$where[]="(user_deleted_at IS NULL OR status='paid')";}
        if ($status!=='') {
            if (!in_array($status,['pending','paid','closed','expired'],true)) throw new InvalidArgumentException('订单状态无效');
            if ($status==='expired') {$where[]="(status='expired' OR (status='pending' AND expires_at<=?))";$args[]=$this->now()->format('Y-m-d H:i:s');}
            elseif ($status==='pending') {$where[]="status='pending' AND expires_at>?";$args[]=$this->now()->format('Y-m-d H:i:s');}
            else {$where[]='status=?';$args[]=$status;}
        }
        if ($search!=='') {$where[]='order_no=?';$args[]=$search;}
        $filter=$where?' WHERE '.implode(' AND ',$where):'';$offset=($page-1)*20;
        $rows=$this->query("SELECT * FROM membership_orders$filter ORDER BY id DESC LIMIT 20 OFFSET $offset",$args)->fetchAll();
        // Normalize schedules for admin lists too, including users who have been offline.
        foreach (array_unique(array_column($rows,'user_id')) as $identity) $this->initializeUser((int)$identity);
        return ['page'=>$page,'total'=>(int)$this->query('SELECT COUNT(*) FROM membership_orders'.$filter,$args)->fetchColumn(),'items'=>array_map([$this,'publicOrder'],$rows)];
    }
    /** Called only by the verified gateway service; no public route accepts payment evidence. */
    public function confirmPayment(string $number, array $evidence): array {
        $identity=$this->paymentOrder($number);
        return $this->tx(function() use($identity,$number,$evidence) {
            $user=(int)$identity['user_id'];$account=$this->account($user,true);
            $order=$this->query('SELECT * FROM membership_orders WHERE order_no=? FOR UPDATE',[$number])->fetch();
            if ($order['status']==='paid') {
                if ($order['trade_no']!==$evidence['trade_no']) throw new InvalidArgumentException('交易号不一致');
                return $this->publicOrder($order);
            }
            $now=$this->now();$stamp=$now->format('Y-m-d H:i:s');$plan=json_decode($order['plan_json'],true,32,JSON_THROW_ON_ERROR);
            if (!$account['plan']['is_free'] && !isset($account['plan']['tier_rank'])) throw new RuntimeException('当前套餐缺少等级，已付款订单等待管理员设置等级后重新查单');
            $immediate=$account['plan']['is_free'] || ($plan['id']!==$account['plan']['id'] && $plan['tier_rank']>$account['plan']['tier_rank']);
            $this->query("UPDATE membership_orders SET status='paid',user_deleted_at=NULL,pending_user_id=NULL,checkout_hash=NULL,trade_no=?,paid_at=?,confirmed_at=? WHERE id=?",[$evidence['trade_no'],$evidence['paid_at']??$stamp,$stamp,$order['id']]);
            $this->query('INSERT INTO membership_purchases (order_no,user_id,plan_json,status,starts_at,ends_at,schedule_anchor_at) VALUES (?,?,?,?,?,?,?)',
                [$number,$user,$order['plan_json'],$immediate?'active':'queued',$stamp,self::month($now,1)->format('Y-m-d H:i:s'),$stamp]);
            if ($immediate) {
                $this->query("UPDATE membership_purchases SET status='replaced' WHERE user_id=? AND status='active' AND order_no<>?",[$user,$number]);
                $carry=$account['plan']['is_free']?0:self::units($account['balance']);
                $newUnits=self::units($plan['monthly_credits']);
                if ($carry+$newUnits>self::units('999999999')) throw new RuntimeException('积分余额超出允许范围');
                $end=self::month($now,1);
                $this->query('UPDATE membership_accounts SET plan_id=?,subscription_json=?,anchor_at=?,expires_at=?,current_period_id=NULL,revision=revision+1 WHERE user_id=?',[$plan['id'],$order['plan_json'],$stamp,$end->format('Y-m-d H:i:s'),$user]);
                $this->reschedulePurchases($user,$now,$end);
                $fresh=$this->account($user,true);
                if ($carry>0) {
                    $this->query('UPDATE credit_periods SET balance_units=0 WHERE id=?',[$account['period_id']]);
                    $this->query('INSERT INTO credit_transfers (source_period_id,target_period_id,order_no,amount_units,remaining_units,created_at) VALUES (?,?,?,?,?,?)',[$account['period_id'],$fresh['period_id'],$number,$carry,$carry,$stamp]);
                    $this->ledger($user,$account['period_id'],'upgrade_transfer_out',-$carry,0,['order_no'=>$number,'target_period_id'=>$fresh['period_id']]);
                    $this->query('UPDATE credit_periods SET balance_units=balance_units+? WHERE id=?',[$carry,$fresh['period_id']]);
                    $this->ledger($user,$fresh['period_id'],'upgrade_transfer_in',$carry,$carry+$newUnits,['order_no'=>$number,'source_period_id'=>$account['period_id']]);
                }
                $this->ledger($user,$fresh['period_id'],'membership_purchase',0,$carry+$newUnits,['order_no'=>$number,'plan_id'=>$plan['id']]);
            } else {
                $row=$this->query('SELECT anchor_at,expires_at FROM membership_accounts WHERE user_id=?',[$user])->fetch();
                $this->reschedulePurchases($user,$this->date($row['anchor_at']),$this->date($row['expires_at']));
                $this->ledger($user,$account['period_id'],'membership_queued',0,self::units($account['balance']),['order_no'=>$number,'plan_id'=>$plan['id']]);
            }
            return $this->publicOrder($this->paymentOrder($number));
        });
    }
    public function recordPaymentCheck(string $number, bool $closed=false): void {
        $identity=$this->paymentOrder($number);
        $this->tx(function() use($identity,$number,$closed) {
            $this->query('SELECT id FROM users WHERE id=? FOR UPDATE',[$identity['user_id']]);
            $this->query('SELECT id FROM membership_orders WHERE order_no=? FOR UPDATE',[$number]);
            $this->query('UPDATE membership_orders SET last_checked_at=? WHERE order_no=?',[$this->now()->format('Y-m-d H:i:s'),$number]);
            if ($closed) $this->query("UPDATE membership_orders SET status='closed',pending_user_id=NULL,checkout_hash=NULL WHERE order_no=? AND status<>'paid'",[$number]);
        });
    }
    public function ordersToReconcile(int $limit=100): array {
        $limit=max(1,min(1000,$limit));
        return $this->query("SELECT order_no FROM membership_orders WHERE status IN ('pending','expired') AND (last_checked_at IS NULL OR last_checked_at<?) ORDER BY COALESCE(last_checked_at,created_at),id LIMIT $limit",[$this->now()->modify('-1 minute')->format('Y-m-d H:i:s')])->fetchAll(PDO::FETCH_COLUMN);
    }
    /** Preserve the order for verified callbacks and reconciliation; never delete payment evidence. */
    public function hidePaymentOrder(int $user,string $number): array {
        return $this->tx(function()use($user,$number){
            $this->query('SELECT id FROM users WHERE id=? FOR UPDATE',[$user]);
            $row=$this->query('SELECT * FROM membership_orders WHERE order_no=? AND user_id=? FOR UPDATE',[$number,$user])->fetch();
            if (!$row) {http_response_code(404);throw new InvalidArgumentException('订单不存在');}
            if (!in_array($row['status'],['pending','expired','closed'],true) || $row['paid_at']!==null || $row['confirmed_at']!==null) {
                http_response_code(409);throw new InvalidArgumentException('订单已付款，不能删除，请查询支付结果');
            }
            foreach (['membership_purchases','credit_transfers'] as $table) {
                if ($this->query('SELECT order_no FROM '.$table.' WHERE order_no=? FOR UPDATE',[$number])->fetch()) {
                    http_response_code(409);throw new InvalidArgumentException('订单已有会员权益或积分记录，不能删除');
                }
            }
            $this->query('UPDATE membership_orders SET user_deleted_at=COALESCE(user_deleted_at,?),checkout_hash=NULL,pending_user_id=NULL WHERE id=?',[$this->now()->format('Y-m-d H:i:s'),$row['id']]);
            return ['order_no'=>$number,'deleted'=>true];
        });
    }
}
