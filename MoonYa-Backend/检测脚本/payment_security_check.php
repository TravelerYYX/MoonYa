<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/Services/PaymentConfiguration.php';
require_once dirname(__DIR__).'/Services/MembershipService.php';
try {
    $config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);
    // Read-only: do not initialize/migrate a keyring during inspection.
    $raw=$db->query('SELECT keyring FROM payment_keyring WHERE id=1')->fetchColumn();
    if(!is_string($raw))throw new PaymentStorageUnavailable('数据库键环尚未初始化，请执行 sql/payment_security_cli.php migrate-key');
    $crypto=new PaymentCrypto(json_decode($raw,true,16,JSON_THROW_ON_ERROR));$store=new PaymentConfiguration($db,$crypto);
    $state=$store->publicState();echo '数据库键环及配置解密正常；修订号 '.(int)$state['revision'].'；配置'.($state['ready']?'已就绪':'尚未填完整')."\n";
}catch(Throwable $error){fwrite(STDERR,'支付检查失败：'.($error instanceof PaymentStorageUnavailable?$error->getMessage():get_class($error).'，请检查数据库升级及备份')."\n");exit(1);}
