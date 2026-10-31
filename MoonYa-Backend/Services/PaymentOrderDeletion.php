<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentConfiguration.php';

/** Local deletion deliberately makes no provider query or close request. */
final class PaymentOrderDeletion {
    public function __construct(private PDO $db,private PaymentConfiguration $store) {}
    private function orders(array $numbers,bool $lock=false): array {
        if(!array_is_list($numbers) || count($numbers)<1 || count($numbers)>20)throw new InvalidArgumentException('删除订单数量须为 1 至 20 笔');
        foreach($numbers as$number)if(!is_string($number)||!preg_match('/^MY[a-zA-Z0-9]{14,38}$/D',$number))throw new InvalidArgumentException('订单号无效');
        $numbers=array_values(array_unique($numbers));$marks=implode(',',array_fill(0,count($numbers),'?'));
        $stmt=$this->db->prepare('SELECT * FROM membership_orders WHERE order_no IN ('.$marks.') ORDER BY user_id,id'.($lock?' FOR UPDATE':''));$stmt->execute($numbers);$orders=$stmt->fetchAll();
        if(count($orders)!==count($numbers)){http_response_code(409);throw new InvalidArgumentException('部分订单不存在，请检查订单号后重试');}
        foreach($orders as$order){
            if(!in_array($order['status'],['pending','expired'],true) || $order['trade_no']!==null || $order['paid_at']!==null || $order['confirmed_at']!==null){http_response_code(409);throw new InvalidArgumentException('仅可强制删除待付款或已超时且未确认付款的订单');}
            foreach(['membership_purchases','credit_transfers']as$table){
                $stmt=$this->db->prepare('SELECT order_no FROM '.$table.' WHERE order_no=?'.($lock?' FOR UPDATE':''));$stmt->execute([$order['order_no']]);
                if($stmt->fetch()){http_response_code(409);throw new InvalidArgumentException('订单已有会员权益或积分转移记录，不能删除');}
            }
        }return $orders;
    }
    public function preview(array $numbers): array {return $this->orders($numbers);}
    public function delete(array $numbers,int $admin): array {
        return $this->store->locked(function()use($numbers,$admin){
            $this->db->beginTransaction();
            try{
                // Match fulfillment's user-first lock order, then recheck all rows before deleting any.
                $preview=$this->orders($numbers);$users=array_unique(array_column($preview,'user_id'));sort($users,SORT_NUMERIC);
                foreach($users as$user){$stmt=$this->db->prepare('SELECT id FROM users WHERE id=? FOR UPDATE');$stmt->execute([$user]);$stmt->fetch();}
                $orders=$this->orders($numbers,true);$results=[];
                foreach($orders as$order){
                    $this->store->audit($admin,'payment_order_force_delete',['order_no'=>$order['order_no'],'user_id'=>(int)$order['user_id'],'status'=>$order['status'],'amount_cents'=>(int)$order['amount_cents'],'app_id'=>$order['app_id'],'seller_id'=>$order['seller_id'],'environment'=>$order['environment'],'created_at'=>$order['created_at'],'expires_at'=>$order['expires_at']]);
                    $stmt=$this->db->prepare("DELETE FROM membership_orders WHERE id=? AND status IN ('pending','expired')");$stmt->execute([$order['id']]);
                    if($stmt->rowCount()!==1)throw new RuntimeException('订单删除冲突');$results[]=['order_no'=>$order['order_no'],'status'=>'deleted'];
                }
                $this->db->commit();return $results;
            }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
        });
    }
}
