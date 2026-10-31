<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentService.php';
$checks=0;
function userDeletionCheck(bool $ok,string $message): void {global $checks;$checks++;if(!$ok)throw new RuntimeException($message);}
function userDeletionReject(Closure $fn,string $message): void {try{$fn();}catch(Throwable $error){userDeletionCheck(true,$message);return;}throw new RuntimeException('Expected rejection: '.$message);}
final class UserDeletionGateway implements PaymentGateway {
    public array $trades=[];public bool $queryFails=false,$closeFails=false,$closeUnconfirmed=false;public int $queries=0,$closes=0;public ?Closure $onQuery=null;
    public function configuration(): array {return ['app_id'=>'2026000000000001','seller_id'=>'2088000000000001','environment'=>'sandbox','public_url'=>'https://payment.example.invalid'];}
    public function readiness(): array {return ['ready'=>true,'enabled'=>true];}
    public function checkout(array $order): string {return 'fixture';}
    public function verifyNotification(array $parameters): bool {return true;}
    public function query(array $order): ?array {
        $this->queries++;if($this->queryFails)throw new RuntimeException('Fixture query failure');
        if($this->onQuery){$hook=$this->onQuery;$this->onQuery=null;$hook($order);}
        return $this->trades[$order['order_no']]??null;
    }
    public function close(array $order): bool {$this->closes++;if($this->closeFails)return false;if(!$this->closeUnconfirmed)$this->trades[$order['order_no']]['trade_status']='TRADE_CLOSED';return true;}
}
[$db,$config,$name]=membershipTestDatabase();
try{
    initializePayments($db);$db->exec('ALTER TABLE membership_orders DROP COLUMN user_deleted_at');initializePayments($db);initializePayments($db);
    userDeletionCheck((int)$db->query("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='membership_orders' AND column_name='user_deleted_at'")->fetchColumn()===1,'Existing schemas upgrade idempotently');
    $db->exec("INSERT INTO users(id,api_token) VALUES(2,'other-user'),(3,'waiting-user'),(4,'failure-user'),(5,'paid-user'),(6,'race-user'),(7,'benefits-user'),(8,'transfer-user'),(9,'unconfirmed-user'),(10,'mismatch-user')");
    $membership=new MembershipService($db);$gateway=new UserDeletionGateway();$payment=new PaymentService($membership,$gateway);$plan=$membership->plans()[1];
    $create=fn($user)=>$payment->create($user,$plan['id'],bin2hex(random_bytes(16)));
    $evidence=fn($order,$status='WAIT_BUYER_PAY')=>$gateway->configuration()+['out_trade_no'=>$order['order_no'],'trade_no'=>'20261004'.substr(hash('sha256',$order['order_no']),0,20),'total_amount'=>PaymentService::amount($order['amount_cents']),'trade_status'=>$status];
    $a=$create(1);$number=$a['order']['order_no'];parse_str(parse_url($a['checkout_url'],PHP_URL_QUERY),$checkout);
    userDeletionCheck($a['order']['can_delete']===true,'Pending row offers deletion');
    userDeletionReject(fn()=>$payment->deleteOrder(2,$number),'Order ownership required');userDeletionReject(fn()=>$payment->deleteOrder(1,'invalid'),'Invalid order number rejected');
    $balance=$membership->summary(1)['balance'];$payment->deleteOrder(1,$number);$row=$membership->paymentOrder($number,1);
    userDeletionCheck($row['user_deleted_at']!==null&&$row['checkout_hash']===null&&$row['pending_user_id']===null&&$row['status']==='pending','Absent provider trade hides row without falsifying closure');
    userDeletionCheck($membership->paymentOrders(1)['total']===0&&$membership->paymentOrders(null)['total']===1,'User list hides order; admin keeps it');
    userDeletionCheck($membership->paymentOrders(1,1,'','',true)['total']===1,'Admin user filter also includes hidden orders');
    userDeletionCheck($membership->summary(1)['balance']===$balance,'Deletion leaves balance unchanged');
    userDeletionCheck(in_array($number,$membership->ordersToReconcile(),true),'Hidden missing trade still reconciles');
    $queries=$gateway->queries;$payment->deleteOrder(1,$number);userDeletionCheck($gateway->queries===$queries,'Repeat deletion succeeds without querying');
    userDeletionReject(fn()=>$membership->checkoutOrder($checkout['token']),'Checkout token revoked');userDeletionReject(fn()=>$payment->resume(1,$number),'Hidden order cannot resume');
    userDeletionReject(fn()=>$payment->create(1,$plan['id'],$row['request_key']),'Hidden request key cannot recreate checkout');
    $new=$create(1);userDeletionCheck($new['order']['order_no']!==$number,'Deletion releases pending slot');
    $params=$evidence($a['order'],'TRADE_SUCCESS');$payment->notify($params);$payment->notify($params);
    userDeletionCheck($membership->paymentOrder($number)['user_deleted_at']===null&&$membership->paymentOrders(1)['total']===2,'Late verified payment restores order');
    $count=$db->prepare('SELECT COUNT(*) FROM membership_purchases WHERE order_no=?');$count->execute([$number]);userDeletionCheck((int)$count->fetchColumn()===1,'Late repeated notification grants once');
    userDeletionCheck($membership->publicOrder($membership->paymentOrder($number))['can_delete']===false,'Paid order has no delete action');userDeletionReject(fn()=>$payment->deleteOrder(1,$number),'Paid order cannot be deleted');
    $waiting=$create(3);$n=$waiting['order']['order_no'];$gateway->trades[$n]=$evidence($waiting['order']);$payment->deleteOrder(3,$n);
    userDeletionCheck($gateway->closes===1&&$membership->paymentOrder($n)['status']==='closed'&&$membership->paymentOrders(3)['total']===0,'Existing unpaid provider trade closes before hiding');
    $failure=$create(4);$n=$failure['order']['order_no'];$gateway->queryFails=true;userDeletionReject(fn()=>$payment->deleteOrder(4,$n),'Query failure retains row');$gateway->queryFails=false;
    $gateway->trades[$n]=$evidence($failure['order']);$gateway->closeFails=true;userDeletionReject(fn()=>$payment->deleteOrder(4,$n),'Close failure retains row');$gateway->closeFails=false;
    userDeletionCheck($membership->paymentOrder($n)['user_deleted_at']===null&&$membership->paymentOrders(4)['total']===1,'Failed deletion remains visible');
    $paid=$create(5);$n=$paid['order']['order_no'];$gateway->trades[$n]=$evidence($paid['order'],'TRADE_SUCCESS');userDeletionReject(fn()=>$payment->deleteOrder(5,$n),'Provider payment is fulfilled and blocks deletion');
    userDeletionCheck($membership->paymentOrder($n)['status']==='paid'&&$membership->summary(5)['plan']['id']===$plan['id'],'Discovering paid trade refreshes membership');
    $race=$create(6);$n=$race['order']['order_no'];$gateway->onQuery=fn($order)=>$membership->confirmPayment($order['order_no'],['trade_no'=>'20261004race00001']);
    userDeletionReject(fn()=>$payment->deleteOrder(6,$n),'Payment arriving after query blocks final hiding');userDeletionCheck($membership->paymentOrder($n)['user_deleted_at']===null,'Race keeps paid order visible');
    $benefit=$create(7);$n=$benefit['order']['order_no'];$db->prepare("INSERT INTO membership_purchases(order_no,user_id,plan_json,status,starts_at,ends_at,schedule_anchor_at) SELECT order_no,user_id,plan_json,'queued',created_at,expires_at,created_at FROM membership_orders WHERE order_no=?")->execute([$n]);
    userDeletionReject(fn()=>$payment->deleteOrder(7,$n),'Existing benefits block deletion');
    $transfer=$create(8);$n=$transfer['order']['order_no'];$db->prepare('INSERT INTO credit_transfers(source_period_id,target_period_id,order_no,amount_units,remaining_units,created_at) VALUES(123456,123457,?,1,1,NOW())')->execute([$n]);userDeletionReject(fn()=>$payment->deleteOrder(8,$n),'Credit records block deletion');
    $unknown=$create(9);$n=$unknown['order']['order_no'];$gateway->trades[$n]=$evidence($unknown['order']);$gateway->closeUnconfirmed=true;userDeletionReject(fn()=>$payment->deleteOrder(9,$n),'Unconfirmed closure does not hide order');$gateway->closeUnconfirmed=false;
    userDeletionCheck($membership->paymentOrder($n)['user_deleted_at']===null,'Unconfirmed closure preserves row');
    $mismatch=$create(10);$n=$mismatch['order']['order_no'];$gateway->trades[$n]=array_replace($evidence($mismatch['order']),['out_trade_no'=>$number]);userDeletionReject(fn()=>$payment->deleteOrder(10,$n),'Mismatched provider order rejected');userDeletionCheck($membership->paymentOrder($n)['user_deleted_at']===null,'Mismatch preserves row');
    echo "PASS: $checks user order deletion checks\n";
}finally{if($db->inTransaction())$db->rollBack();$db->exec('DROP DATABASE `'.$name.'`');}
