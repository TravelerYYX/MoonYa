<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentOrderDeletion.php';
$checks=0;
function deletionCheck(bool $ok,string $message): void {global $checks;$checks++;if(!$ok)throw new RuntimeException($message);}
function deletionReject(Closure $fn,string $message): void {try{$fn();}catch(Throwable $error){deletionCheck(true,$message);return;}throw new RuntimeException('Expected rejection: '.$message);}
[$db,$config,$name]=membershipTestDatabase();initializePayments($db);
try{
    putenv('PAYMENT_MASTER_KEY_FILE=');$db->exec("INSERT INTO users(id,api_token) VALUES(2,'other-user'),(3,'paid-user')");
    $membership=new MembershipService($db);$store=new PaymentConfiguration($db);$deletion=new PaymentOrderDeletion($db,$store);$plan=$membership->plans()[1];
    $merchant=['app_id'=>'2026000000000001','seller_id'=>'2088000000000001','environment'=>'sandbox'];
    $create=fn($user)=>$membership->createPaymentOrder($user,$plan['id'],bin2hex(random_bytes(16)),$merchant);
    $a=$create(1);$b=$create(2);$paid=$create(3);$number=$a['order']['order_no'];$other=$b['order']['order_no'];
    $db->prepare("UPDATE membership_orders SET status='expired',pending_user_id=NULL,checkout_hash=NULL WHERE order_no=?")->execute([$other]);
    $membership->confirmPayment($paid['order']['order_no'],['trade_no'=>'2026100400000001']);
    $balances=$db->query('SELECT * FROM credit_periods ORDER BY id')->fetchAll();$purchases=$db->query('SELECT * FROM membership_purchases')->fetchAll();
    deletionCheck(count($deletion->preview([$number,$other]))===2,'Preview pending and expired orders');
    foreach([[],array_fill(0,21,$number),['invalid'],[$number,'MY20261004123456missing'],[$number,$paid['order']['order_no']]]as$numbers)deletionReject(fn()=>$deletion->delete($numbers,1),'Invalid batch rejected');
    deletionCheck((int)$db->query('SELECT COUNT(*) FROM membership_orders')->fetchColumn()===3,'Rejected batches delete nothing');
    // Confirmation must recheck a payment that arrived after the preview.
    $deletion->preview([$number]);$db->prepare("UPDATE membership_orders SET status='paid',trade_no='2026100400000002' WHERE order_no=?")->execute([$number]);
    deletionReject(fn()=>$deletion->delete([$number,$other],1),'Payment after preview blocks the complete batch');
    $db->prepare("UPDATE membership_orders SET status='pending',trade_no=NULL WHERE order_no=?")->execute([$number]);
    $db->prepare("UPDATE membership_orders SET paid_at=NOW() WHERE order_no=?")->execute([$number]);deletionReject(fn()=>$deletion->delete([$number],1),'Payment evidence blocks inconsistent unpaid status');$db->prepare('UPDATE membership_orders SET paid_at=NULL WHERE order_no=?')->execute([$number]);
    $db->prepare("INSERT INTO membership_purchases(order_no,user_id,plan_json,status,starts_at,ends_at,schedule_anchor_at) SELECT order_no,user_id,plan_json,'queued',created_at,expires_at,created_at FROM membership_orders WHERE order_no=?")->execute([$number]);
    deletionReject(fn()=>$deletion->delete([$number],1),'Existing membership benefits cannot be deleted');$db->prepare('DELETE FROM membership_purchases WHERE order_no=?')->execute([$number]);
    $db->prepare("INSERT INTO credit_transfers(source_period_id,target_period_id,order_no,amount_units,remaining_units,created_at) VALUES(123456,123457,?,1,1,NOW())")->execute([$number]);
    deletionReject(fn()=>$deletion->delete([$number],1),'Existing credit transfers cannot be deleted');$db->prepare('DELETE FROM credit_transfers WHERE order_no=?')->execute([$number]);
    $db->prepare("UPDATE membership_orders SET status='closed' WHERE order_no=?")->execute([$other]);deletionReject(fn()=>$deletion->delete([$other],1),'Closed order is outside deletion scope');$db->prepare("UPDATE membership_orders SET status='expired' WHERE order_no=?")->execute([$other]);
    $db->exec("CREATE TRIGGER fixture_reject_delete_audit BEFORE INSERT ON admin_logs FOR EACH ROW BEGIN IF NEW.action='payment_order_force_delete' AND JSON_UNQUOTE(JSON_EXTRACT(NEW.details,'$.order_no'))=".$db->quote($other)." THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture audit unavailable'; END IF; END");
    deletionReject(fn()=>$deletion->delete([$number,$other],1),'Audit failure rolls back deletion');$db->exec('DROP TRIGGER fixture_reject_delete_audit');
    deletionCheck((int)$db->query('SELECT COUNT(*) FROM membership_orders')->fetchColumn()===3,'Audit failure preserves all orders');
    deletionCheck((int)$db->query("SELECT COUNT(*) FROM admin_logs WHERE action='payment_order_force_delete'")->fetchColumn()===0,'Audit failure rolls back earlier audit records in the batch');
    $results=$deletion->delete([$number,$other,$number],1);deletionCheck(count($results)===2&&array_unique(array_column($results,'status'))===['deleted'],'Deduplicated batch deleted');
    deletionCheck((int)$db->query('SELECT COUNT(*) FROM membership_orders')->fetchColumn()===1,'Paid order preserved');
    deletionCheck($store->publicState()['blocking_orders']===0,'Deleted orders no longer block configuration changes');
    deletionCheck($balances===$db->query('SELECT * FROM credit_periods ORDER BY id')->fetchAll(),'Credits unchanged');
    deletionCheck($purchases===$db->query('SELECT * FROM membership_purchases')->fetchAll(),'Existing benefits unchanged');
    deletionReject(fn()=>$membership->checkoutOrder($a['checkout_token']),'Deleted checkout token invalid');
    deletionReject(fn()=>$membership->confirmPayment($number,['trade_no'=>'2026100400000003']),'Late payment cannot fulfill deleted order');
    $logs=$db->query("SELECT details FROM admin_logs WHERE action='payment_order_force_delete'")->fetchAll();deletionCheck(count($logs)===2,'One audit per deleted order');
    $logged=json_decode($logs[0]['details'],true);deletionCheck(isset($logged['amount_cents'],$logged['user_id'],$logged['seller_id'])&&!isset($logged['checkout_hash']),'Audit retains order identity and amount without checkout credentials');
    deletionCheck($create(1)['order']['status']==='pending','User can create another order after deletion');
    echo "PASS: $checks forced order deletion checks\n";
}finally{if($db->inTransaction())$db->rollBack();$db->exec('DROP DATABASE `'.$name.'`');}
