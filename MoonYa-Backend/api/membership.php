<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
try {
    require_once dirname(__DIR__) . '/Services/PaymentService.php';
    require_once dirname(__DIR__) . '/Services/PaymentRequest.php';
    require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
    require_once dirname(__DIR__) . '/Services/CorsPolicy.php';
    applyCorsPolicy();
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
    $config=require dirname(__DIR__).'/config.php'; $user=authenticateMoonYaRequest($config);
    $db=MembershipService::connect($config);$service=new MembershipService($db);
    $payment=new PaymentService($service,AlipayGateway::fromDatabase($db));
    $action=$_GET['action']??'summary';$method=$_SERVER['REQUEST_METHOD'];
    if ($method==='GET') {
        switch($action) {
            case 'summary':$data=['account'=>$service->summary($user),'plans'=>$service->plans(),'csrf_token'=>paymentCsrfToken()]+$payment->availability();break;
            case 'ledger':$data=$service->history($user,(int)($_GET['page']??1));break;
            case 'orders':$service->summary($user);$data=$service->paymentOrders($user,(int)($_GET['page']??1));break;
            case 'order':$service->summary($user);$data=$service->publicOrder($service->paymentOrder((string)($_GET['order_no']??''),$user));break;
            default:throw new InvalidArgumentException('不支持的会员操作');
        }
    } elseif ($method==='POST') {
        checkPaymentCsrf();$input=json_decode((string)file_get_contents('php://input'),true,16,JSON_THROW_ON_ERROR);
        if(!is_array($input))throw new InvalidArgumentException('请求格式无效');
        switch($action) {
            case 'create_order':
                $id=filter_var($input['plan_id']??null,FILTER_VALIDATE_INT);
                if(!$id || !is_string($input['request_key']??null))throw new InvalidArgumentException('购买请求格式无效');
                $data=$payment->create($user,$id,$input['request_key']);break;
            case 'delete_order':
                if(!is_string($input['order_no']??null))throw new InvalidArgumentException('订单号无效');
                $data=$payment->deleteOrder($user,$input['order_no']);break;
            case 'resume_order':case 'sync_order':
                if(!is_string($input['order_no']??null))throw new InvalidArgumentException('订单号无效');
                $data=$action==='resume_order'?$payment->resume($user,$input['order_no']):$payment->sync($input['order_no'],$user);break;
            default:throw new InvalidArgumentException('不支持的会员操作');
        }
    } else {http_response_code(405);throw new InvalidArgumentException('不支持的请求方法');}
    echo json_encode(['success'=>true,'data'=>$data],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    error_log(sprintf('MoonYa membership: %s: %s in %s:%d', get_class($error), $error->getMessage(), $error->getFile(), $error->getLine()));
    if (http_response_code()<400) http_response_code($error instanceof InvalidArgumentException || $error instanceof JsonException?400:503);
    $message = $error instanceof InvalidArgumentException ? $error->getMessage() : (http_response_code() === 401 ? '登录已失效，请重新登录' : '会员或支付信息暂不可用，请稍后查询订单后重试');
    echo json_encode(['success'=>false,'error'=>$message],JSON_UNESCAPED_UNICODE);
}
