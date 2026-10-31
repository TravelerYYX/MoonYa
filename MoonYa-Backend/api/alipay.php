<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/Services/PaymentService.php';
require_once dirname(__DIR__).'/Services/PaymentTransport.php';
require_once dirname(__DIR__).'/Services/PaymentReturnPage.php';
header('Cache-Control: no-store');header('Referrer-Policy: no-referrer');header('X-Content-Type-Options: nosniff');
$action=$_GET['action']??'';$method=$_SERVER['REQUEST_METHOD'];
try {
    if ($action==='return' && $method==='GET') {
        $parameters=PaymentTransport::notification($_SERVER['QUERY_STRING']??'');unset($parameters['action']);
        if (!isset($parameters['sign'],$parameters['sign_type'],$parameters['out_trade_no'])) throw new InvalidArgumentException('付款返回信息无效');
    }
    $config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);$membership=new MembershipService($db);
    $payment=new PaymentService($membership,AlipayGateway::fromDatabase($db,defined('MOONYA_PAYMENT_SANDBOX_RELAY_ACTIVE')&&MOONYA_PAYMENT_SANDBOX_RELAY_ACTIVE===true?'sandbox':null));
    if ($action==='return' && $method==='GET') {
        $order=$payment->browserReturn($parameters);
        paymentReturnPage($order['status']==='paid'?'paid':($order['status']==='closed'?'closed':'pending'),$order['order_no']);
    } elseif ($action==='notify' && $method==='POST') {
        if (strtolower(trim(explode(';',$_SERVER['CONTENT_TYPE']??'')[0]))!=='application/x-www-form-urlencoded' || (int)($_SERVER['CONTENT_LENGTH']??0)>65536) throw new InvalidArgumentException('通知请求无效');
        $stream=fopen('php://input','rb');$raw=stream_get_contents($stream,65537);fclose($stream);
        $payment->notify(PaymentTransport::notification($raw));header('Content-Type: text/plain; charset=utf-8');echo 'success';
    } elseif($action==='checkout' && $method==='GET') {
        $body=$payment->checkout((string)($_GET['token']??''));header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>支付宝付款 · MoonYa</title><body>'.$body.'</body></html>';
    } else {http_response_code(405);echo 'failure';}
} catch(Throwable $error) {
    if(http_response_code()<400)http_response_code($error instanceof InvalidArgumentException?400:503);
    if ($action==='return' && $method==='GET') paymentReturnPage($error instanceof InvalidArgumentException?'invalid':'unavailable');
    elseif ($action==='notify') {header('Content-Type: text/plain; charset=utf-8');echo 'failure';}
    else {header('Content-Type: text/html; charset=utf-8');echo '<!doctype html><meta charset="utf-8"><title>付款暂不可用</title><p>付款链接已失效或服务暂不可用，请返回 MoonYa 查询订单后重试。</p>';}
    error_log('Alipay '.$action.' failed: '.get_class($error));
}
