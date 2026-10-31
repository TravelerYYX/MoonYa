<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
// The obsolete destructive reset workflow has been removed.
if(count($argv)===1){require __DIR__.'/payment_security_check.php';exit;}
if($argv!==[$argv[0],'--apply']){fwrite(STDERR,"用法：不带参数只读检查；--apply 升级并迁移数据库键环（不清空配置）。\n");exit(1);}
require_once dirname(__DIR__).'/Services/PaymentConfiguration.php';
require_once dirname(__DIR__).'/sql/migrate_payment_security.php';
try{$config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);initializePaymentSecurity($db);PaymentKeyStore::read($db);echo "数据库键环已就绪，后续更新无需主密钥文件。\n";}
catch(Throwable $error){fwrite(STDERR,($error instanceof PaymentStorageUnavailable?$error->getMessage():'数据库迁移失败，请检查连接、权限及备份')."\n");exit(1);}
