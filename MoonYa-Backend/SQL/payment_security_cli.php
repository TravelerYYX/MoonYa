<?php
declare(strict_types=1);
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once dirname(__DIR__).'/Services/PaymentKeyCommands.php';
require_once dirname(__DIR__).'/Services/MembershipService.php';
try {
    $command=$argv[1]??'';
    $config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);$path=(string)env('PAYMENT_MASTER_KEY_FILE','');
    if(in_array($command,['init-key','migrate-key'],true)){PaymentKeyStore::read($db);fwrite(STDOUT,"数据库键环已就绪，无需主密钥文件。\n");}
    elseif($command==='rotate-key'){PaymentKeyCommands::rotate($db,$path);fwrite(STDOUT,"主密钥轮换完成；键环随数据库备份恢复。\n");}
    elseif($command==='trust-root'){PaymentKeyCommands::trust($db,$path,$argv[2]??'',$argv[3]??'');fwrite(STDOUT,"根证书指纹已登记。\n");}
    elseif($command==='authorize-mfa'){
        throw new InvalidArgumentException('支付操作现已使用密码与邮箱验证码，无需绑定认证器');
    }else throw new InvalidArgumentException('用法：init-key | migrate-key | rotate-key | trust-root <production|sandbox> <官方SHA256指纹>');
}catch(Throwable $error){fwrite(STDERR,$error instanceof InvalidArgumentException || $error instanceof PaymentStorageUnavailable?$error->getMessage()."\n":"支付安全命令失败，请检查数据库升级及备份。\n");exit(1);}
