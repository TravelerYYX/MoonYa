<?php
declare(strict_types=1);
// Development-only origin for a HTTPS tunnel. Never serve the repository root.
ini_set('display_errors','0');ini_set('zend.exception_ignore_args','1');
header('Cache-Control: no-store');header('Referrer-Policy: no-referrer');header('X-Content-Type-Options: nosniff');
if(PHP_SAPI!=='cli-server' || getenv('MOONYA_PAYMENT_SANDBOX_RELAY')!=='1' || !in_array($_SERVER['REMOTE_ADDR']??'',['127.0.0.1','::1'],true)){
    http_response_code(404);exit;
}
$path=parse_url($_SERVER['REQUEST_URI']??'',PHP_URL_PATH);$action=$_GET['action']??null;$method=$_SERVER['REQUEST_METHOD']??'';
if($path!=='/api/alipay.php' || !is_string($action) || !in_array($action,['checkout','notify','return'],true)){
    http_response_code(404);exit;
}
if(($action==='notify'&&$method!=='POST') || ($action!=='notify'&&$method!=='GET')){
    http_response_code(405);exit;
}
// Limit requests before loading application code; reject duplicate action selectors.
$selectors=0;foreach(explode('&',$_SERVER['QUERY_STRING']??'')as$pair){if(urldecode(explode('=',$pair,2)[0])==='action')$selectors++;}
if($selectors!==1 || (int)($_SERVER['CONTENT_LENGTH']??0)>65536){http_response_code(400);exit;}
try{
    require_once dirname(__DIR__).'/MoonYa-Backend/Services/PaymentService.php';
    $config=require dirname(__DIR__).'/MoonYa-Backend/config.php';$db=MembershipService::connect($config);$store=new PaymentConfiguration($db);
    $sandbox=$store->locked(fn()=>$store->load()['environment']==='sandbox');unset($store,$db,$config);
    if(!$sandbox){http_response_code(503);header('Content-Type: text/plain; charset=utf-8');echo 'Sandbox configuration required';exit;}
    define('MOONYA_PAYMENT_SANDBOX_RELAY_ACTIVE',true);
    require dirname(__DIR__).'/MoonYa-Backend/api/alipay.php';
}catch(Throwable $error){http_response_code(503);header('Content-Type: text/plain; charset=utf-8');echo 'Sandbox relay unavailable';error_log('Sandbox relay failed: '.get_class($error));}
