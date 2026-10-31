<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/Services/MembershipService.php';
function initializePaymentSecurity(PDO $db): void {
    $db->exec((string)file_get_contents(__DIR__.'/payment_security_schema.sql'));
}
if(realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    $config=require dirname(__DIR__).'/config.php';initializePaymentSecurity(MembershipService::connect($config));
    fwrite(STDOUT,"支付安全迁移完成；未自动导入商户配置或启用购买。\n");
}
