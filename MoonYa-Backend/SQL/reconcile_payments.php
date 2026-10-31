<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/Services/PaymentService.php';
$config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);$membership=new MembershipService($db);$gateway=AlipayGateway::fromDatabase($db);
if (!$membership->paymentSchemaReady() || !$gateway->readiness()['ready']) {fwrite(STDERR,"支付迁移或商户配置尚未完成。\n");exit(1);}
$payment=new PaymentService($membership,$gateway);$failed=0;$count=0;
foreach($membership->ordersToReconcile((int)($argv[1]??100)) as $number) {
    try {$payment->sync($number);$count++;}
    catch(Throwable $error){$failed++;fwrite(STDERR,$number.' '.get_class($error)."\n");}
}
fwrite(STDOUT,"已查单 $count；失败 $failed。\n");exit($failed?1:0);
