<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/Services/PaymentService.php';
require_once dirname(__DIR__).'/Services/PaymentRequest.php';
$name=getenv('MOONYA_PAYMENT_TEST_DATABASE');$root=getenv('MOONYA_PAYMENT_TEST_ROOT');
if(!is_string($name)||!preg_match('/^moonya_membership_test_[a-f0-9]{12}$/D',$name)||!is_string($root))throw new RuntimeException('Isolated payment fixture required');
$normalized=str_replace('\\','/',$root);
if(!str_starts_with($normalized,str_replace('\\','/',sys_get_temp_dir()).'/moonya-payment-http-') || !preg_match('/^moonya-payment-http-[a-f0-9]{16}$/D',basename($normalized)))throw new RuntimeException('Invalid fixture directory');
foreach(['DB_NAME'=>$name,'MOONYA_SERVER_DATA_ROOT'=>$root.'/server','MOONYA_DATA_ROOT'=>'',
    'JWT_SECRET'=>hash('sha256','moonya-isolated-membership-admin-key'),'PAYMENT_MASTER_KEY_FILE'=>$root.'/keys/master-keyring.json',
    'ALIPAY_ENABLED'=>'true','ALIPAY_ENVIRONMENT'=>'sandbox','ALIPAY_APP_ID'=>'2026000000000001','ALIPAY_SELLER_ID'=>'2088000000000001','ALIPAY_SIGN_MODE'=>'public_key','ALIPAY_PRIVATE_KEY_FILE'=>$root.'/private.pem','ALIPAY_PUBLIC_KEY_FILE'=>$root.'/public.pem','ALIPAY_PUBLIC_URL'=>'https://payment.example.invalid']as$key=>$value){putenv($key.'='.$value);$_ENV[$key]=$value;}
require_once dirname(__DIR__).'/vendor/autoload.php';
// Never inherit live mailbox credentials. Only an explicitly supplied loopback TLS fixture may send.
$smtpPort=getenv('MOONYA_PAYMENT_TEST_SMTP_PORT');
foreach(['SMTP_HOST'=>'localhost','SMTP_PORT'=>(string)($smtpPort?:465),'SMTP_USER'=>'fixture-mailer@moonya.cn',
    'SMTP_PASS'=>$smtpPort?'isolated-fixture-password':'','SMTP_FROM'=>'fixture-mailer@moonya.cn',
    'SMTP_ENCRYPTION'=>'smtps','SMTP_CA_FILE'=>$root.'/tls.pem']as$key=>$value){putenv($key.'='.$value);$_ENV[$key]=$value;}
// Offline query transport exists only in this fixture router. No live provider requests.
if(is_file($root.'/query.json'))$queryResponse=(string)file_get_contents($root.'/query.json');
else{
    $queryBody='{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST"}';
    openssl_sign($queryBody,$querySignature,(string)file_get_contents($root.'/private.pem'),OPENSSL_ALGO_SHA256);
    $queryResponse='{"alipay_trade_query_response":'.$queryBody.',"sign":"'.base64_encode($querySignature).'"}';
}
\AlibabaCloud\Tea\Tea::config(['handler'=>\GuzzleHttp\HandlerStack::create(new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(200,[],$queryResponse)]))]);
$path=parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH);
// Default fixtures simulate TLS; the opt-in local fixture exercises real loopback HTTP.
$localHttp=getenv('MOONYA_PAYMENT_TEST_HTTP_MODE')==='1';putenv('PAYMENT_ALLOW_LOCAL_HTTP='.($localHttp?'true':'false'));
if(str_starts_with($path,'/admin/') && !$localHttp)$_SERVER['HTTPS']='on';
switch($path){
    case '/api/membership.php':require dirname(__DIR__).'/api/membership.php';break;
    case '/api/alipay.php':require dirname(__DIR__).'/api/alipay.php';break;
    case '/admin/api/membership_orders.php':require dirname(__DIR__).'/admin/api/membership_orders.php';break;
    case '/admin/api/payment_settings.php':require dirname(__DIR__).'/admin/api/payment_settings.php';break;
    case '/admin/payment_settings.php':require dirname(__DIR__).'/admin/payment_settings.php';break;
    case '/user_auth.php':require dirname(__DIR__).'/user_auth.php';break;
    case '/session':
        AppDataPaths::configurePhp();session_start();$_SESSION['user_id']=1;session_write_close();
        require_once dirname(__DIR__).'/Services/PaymentRequest.php';header('Content-Type: application/json');echo json_encode(['csrf'=>paymentCsrfToken()]);break;
    case '/ready':header('Content-Type: application/json');echo '{"ready":true}';break;
    default:http_response_code(404);
}
