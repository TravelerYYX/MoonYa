<?php
declare(strict_types=1);
require_once __DIR__.'/MembershipService.php';
require_once __DIR__.'/AlipayGateway.php';

final class PaymentService {
    public function __construct(private MembershipService $membership, private PaymentGateway $gateway) {}
    private function guarded(Closure $action) {return $this->gateway instanceof AlipayGateway?$this->gateway->withCurrent($action):$action();}
    public static function amount(int $cents): string { return intdiv($cents,100).'.'.str_pad((string)($cents%100),2,'0',STR_PAD_LEFT); }
    public static function cents(string $amount): int {
        if (!preg_match('/^\d{1,10}(?:\.\d{1,2})?$/D',$amount)) throw new InvalidArgumentException('付款金额格式无效');
        $parts=explode('.',$amount);return (int)$parts[0]*100+(int)str_pad($parts[1]??'',2,'0');
    }
    public function availability(): array {
        $state=$this->gateway->readiness();$schema=$this->membership->paymentSchemaReady();
        return ['purchase_enabled'=>$schema && $state['enabled'] && $state['ready'],
            'purchase_message'=>!$schema?'购买暂未开放（支付迁移尚未完成）':(!$state['ready']?'购买暂未开放（支付宝配置尚未完成）':(!$state['enabled']?'购买暂未开放':''))];
    }
    public function create(int $user,int $plan,string $key): array {
        return $this->guarded(fn()=>$this->createUnlocked($user,$plan,$key));
    }
    private function createUnlocked(int $user,int $plan,string $key): array {
        $availability=$this->availability();
        if (!$availability['purchase_enabled']) throw new InvalidArgumentException($availability['purchase_message']);
        $result=$this->membership->createPaymentOrder($user,$plan,$key,$this->gateway->configuration());
        return ['order'=>$result['order'],'checkout_url'=>$result['checkout_token']?$this->gateway->configuration()['public_url'].'/api/alipay.php?action=checkout&token='.$result['checkout_token']:null];
    }
    public function resume(int $user,string $number): array {
        $row=$this->membership->paymentOrder($number,$user);
        if ($row['user_deleted_at']!==null) {http_response_code(409);throw new InvalidArgumentException('订单已删除，请重新选择套餐购买');}
        return $this->create($user,(int)$row['plan_id'],$row['request_key']);
    }
    public function deleteOrder(int $user,string $number): array {
        if (!preg_match('/^MY[a-zA-Z0-9]{14,38}$/D',$number)) throw new InvalidArgumentException('订单号无效');
        return $this->guarded(function()use($user,$number){
            $row=$this->membership->paymentOrder($number,$user);
            if ($row['status']==='paid' || $row['paid_at']!==null || $row['confirmed_at']!==null) {
                http_response_code(409);throw new InvalidArgumentException('订单已付款，不能删除，请查询支付结果');
            }
            if ($row['user_deleted_at']===null && $row['status']!=='closed') {
                $evidence=$this->gateway->query($row);
                if ($evidence!==null) {
                    if (($evidence['out_trade_no']??'')!==$number) throw new InvalidArgumentException('查单返回订单号不一致');
                    $checked=$this->apply($evidence);
                    if ($checked['status']==='paid') {http_response_code(409);throw new InvalidArgumentException('订单已付款，不能删除，会员权益已更新');}
                    if ($checked['status']!=='closed') {
                        if (!$this->gateway->close($row)) throw new RuntimeException('支付宝未确认关单');
                        $confirmed=$this->gateway->query($row);
                        if ($confirmed===null || ($confirmed['out_trade_no']??'')!==$number || !in_array($confirmed['trade_status']??'',['TRADE_CLOSED','TRADE_SUCCESS','TRADE_FINISHED'],true)) throw new RuntimeException('关单结果尚未确认，请稍后重试');
                        $checked=$this->apply($confirmed);
                        if ($checked['status']==='paid') {http_response_code(409);throw new InvalidArgumentException('订单已付款，不能删除，会员权益已更新');}
                    }
                }
            }
            return $this->membership->hidePaymentOrder($user,$number);
        });
    }
    private function apply(array $parameters): array {
        $number=(string)($parameters['out_trade_no']??'');$row=$this->membership->paymentOrder($number);
        foreach(['app_id','seller_id'] as $field) if (!isset($parameters[$field]) || !hash_equals($row[$field],(string)$parameters[$field])) throw new InvalidArgumentException('付款商户信息不一致');
        if (self::cents((string)($parameters['total_amount']??''))!==(int)$row['amount_cents']) throw new InvalidArgumentException('付款金额不一致');
        $trade=(string)($parameters['trade_no']??'');if (!preg_match('/^[a-zA-Z0-9]{8,64}$/D',$trade)) throw new InvalidArgumentException('支付宝交易号无效');
        $status=$parameters['trade_status']??'';
        if (in_array($status,['TRADE_SUCCESS','TRADE_FINISHED'],true)) {
            $paid=$parameters['gmt_payment']??null;
            if ($paid!==null) {
                $parsed=DateTimeImmutable::createFromFormat('!Y-m-d H:i:s',(string)$paid,new DateTimeZone('Asia/Shanghai'));
                if (!$parsed || $parsed->format('Y-m-d H:i:s')!==$paid) throw new InvalidArgumentException('付款时间无效');
            }
            return $this->membership->confirmPayment($number,['trade_no'=>$trade,'paid_at'=>$paid]);
        }
        if (!in_array($status,['WAIT_BUYER_PAY','TRADE_CLOSED'],true)) throw new InvalidArgumentException('付款状态无效');
        $this->membership->recordPaymentCheck($number,$status==='TRADE_CLOSED');
        return $this->membership->publicOrder($this->membership->paymentOrder($number));
    }
    public function notify(array $parameters): array {
        return $this->guarded(fn()=>$this->notifyUnlocked($parameters));
    }
    private function notifyUnlocked(array $parameters): array {
        if (!$this->gateway->verifyNotification($parameters)) throw new InvalidArgumentException('支付宝通知验签失败');
        $row=$this->membership->paymentOrder((string)($parameters['out_trade_no']??''));
        foreach(['app_id','seller_id','environment'] as $field) if (!hash_equals((string)$row[$field],(string)$this->gateway->configuration()[$field])) throw new InvalidArgumentException('通知订单的支付配置不一致');
        return $this->apply($parameters);
    }
    public function sync(string $number,?int $user=null): array {
        return $this->guarded(fn()=>$this->syncUnlocked($number,$user));
    }
    public function browserReturn(array $parameters): array {
        return $this->guarded(function()use($parameters){
            if (!$this->gateway->verifyNotification($parameters)) throw new InvalidArgumentException('支付宝返回验签失败');
            $number=(string)($parameters['out_trade_no']??'');
            if (!preg_match('/^MY[a-zA-Z0-9]{14,38}$/D',$number)) throw new InvalidArgumentException('订单号无效');
            $row=$this->membership->paymentOrder($number);
            foreach(['app_id','seller_id','environment'] as $field) {
                if (!hash_equals((string)$row[$field],(string)$this->gateway->configuration()[$field])) throw new InvalidArgumentException('返回订单的支付配置不一致');
                if ($field!=='environment' && !hash_equals((string)$row[$field],(string)($parameters[$field]??''))) throw new InvalidArgumentException('付款商户信息不一致');
            }
            if (self::cents((string)($parameters['total_amount']??''))!==(int)$row['amount_cents']) throw new InvalidArgumentException('付款金额不一致');
            // The browser's return is only a signed order reference. Fulfillment still
            // requires an asynchronous notification or an authenticated provider query.
            return $this->syncUnlocked($number);
        });
    }
    private function syncUnlocked(string $number,?int $user=null): array {
        $row=$this->membership->paymentOrder($number,$user);
        // Avoid redundant provider traffic for already atomically fulfilled orders.
        if ($row['status']==='paid') { $this->membership->initializeUser((int)$row['user_id']);return $this->membership->publicOrder($row); }
        $this->membership->recordPaymentCheck($number);
        $parameters=$this->gateway->query($row);
        if ($parameters!==null) {
            if (($parameters['out_trade_no']??'')!==$number) throw new InvalidArgumentException('查单返回订单号不一致');
            return $this->apply($parameters);
        }
        return $this->membership->publicOrder($row);
    }
    public function checkout(string $token): string { return $this->guarded(fn()=>$this->gateway->checkout($this->membership->checkoutOrder($token))); }
    public function settle(string $number): array {
        return $this->guarded(function()use($number){
            $order=$this->membership->paymentOrder($number);
            if (in_array($order['status'],['paid','closed'],true)) return $this->membership->publicOrder($order);
            $evidence=$this->gateway->query($order);
            if ($evidence!==null) {
                if (($evidence['out_trade_no']??'')!==$number) throw new InvalidArgumentException('查单返回订单号不一致');
                if (in_array($evidence['trade_status']??'',['TRADE_SUCCESS','TRADE_FINISHED','TRADE_CLOSED'],true)) return $this->apply($evidence);
                // Validate the signed merchant, amount and trade ID before attempting closure.
                $this->apply($evidence);
                if (!$this->gateway->close($order)) throw new RuntimeException('支付宝未确认关单');
                $confirmed=$this->gateway->query($order);
                if ($confirmed===null || !in_array($confirmed['trade_status']??'',['TRADE_CLOSED','TRADE_SUCCESS','TRADE_FINISHED'],true)) throw new RuntimeException('关单结果尚未确认，请稍后查单');
                if (($confirmed['out_trade_no']??'')!==$number) throw new InvalidArgumentException('关单订单号不一致');
                return $this->apply($confirmed);
            }
            if ($order['expires_at']>=(new DateTimeImmutable('now',new DateTimeZone('Asia/Shanghai')))->format('Y-m-d H:i:s')) throw new InvalidArgumentException('交易不存在但付款期限尚未结束，请稍后结清');
            $this->membership->recordPaymentCheck($number,true);
            return $this->membership->publicOrder($this->membership->paymentOrder($number));
        });
    }
}
