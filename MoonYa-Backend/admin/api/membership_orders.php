<?php
declare(strict_types=1);
ini_set('display_errors', '0');
ini_set('log_errors', '1');
header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store');
$admin=null;
try {
    require_once dirname(__DIR__,2).'/Services/PaymentService.php';
    require_once dirname(__DIR__,2).'/Services/RequestHeaders.php';
    require_once dirname(__DIR__).'/Auth.php';require_once dirname(__DIR__).'/Logger.php';
    $token=preg_replace('/^Bearer\s+/i','',moonyaAuthorizationHeader());
    if(!$token){http_response_code(401);throw new InvalidArgumentException('请先登录管理后台');}
    $config=require dirname(__DIR__).'/config.php';$db=MembershipService::connect($config);$logger=new Logger($config,$db);
    $auth=new Auth($db,$config,$logger);$admin=$auth->authenticate($token);
    if (!$admin) {http_response_code(401);throw new InvalidArgumentException('请先登录管理后台');}
    if (!$auth->hasPermission($admin,'edit_users')) {http_response_code(403);throw new InvalidArgumentException('没有订单管理权限');}
    $membership=new MembershipService($db);$gateway=AlipayGateway::fromDatabase($db);$payment=new PaymentService($membership,$gateway);
    if ($_SERVER['REQUEST_METHOD']==='GET') {
        if (!empty($_GET['order_no'])) {
            $order=$membership->paymentOrder((string)$_GET['order_no']);$membership->initializeUser((int)$order['user_id']);
            $data=['order'=>$membership->publicOrder($order),'trade_no'=>$order['trade_no']];
        } else $data=$membership->paymentSchemaReady()?$membership->paymentOrders(isset($_GET['user_id']) && $_GET['user_id']!==''?(int)$_GET['user_id']:null,(int)($_GET['page']??1),(string)($_GET['status']??''),(string)($_GET['search']??''),true):['items'=>[],'page'=>1,'total'=>0];
        $data['configuration']=$gateway->readiness()+['schema_ready'=>$membership->paymentSchemaReady()];
    } elseif ($_SERVER['REQUEST_METHOD']==='POST') {
        $input=json_decode((string)file_get_contents('php://input'),true,16,JSON_THROW_ON_ERROR);
        if(!is_array($input))throw new InvalidArgumentException('请求格式无效');
        $number=(string)($input['order_no']??'');$data=$payment->sync($number);
        $logger->logAdminAction((int)$admin['id'],'membership_order_sync',$data['user_id'],json_encode(['order_no'=>$number,'status'=>$data['status']],JSON_UNESCAPED_UNICODE));
    } else {http_response_code(405);throw new InvalidArgumentException('不支持的请求方法');}
    echo json_encode(['success'=>true,'data'=>$data],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
} catch(Throwable $error) {
    error_log(sprintf('MoonYa membership orders: %s: %s in %s:%d', get_class($error), $error->getMessage(), $error->getFile(), $error->getLine()));
    if(http_response_code()<400)http_response_code($error instanceof InvalidArgumentException?400:503);
    // 兜底文案不解释原因。已登录管理员（或本机回环请求）额外带上真实异常，避免只能靠查日志。
    $detail='';
    if(!($error instanceof InvalidArgumentException) && ($admin!==null || in_array($_SERVER['REMOTE_ADDR']??'',['127.0.0.1','::1'],true)))
        $detail='（'.get_class($error).'：'.$error->getMessage().' @ '.basename($error->getFile()).':'.$error->getLine().'）';
    echo json_encode(['success'=>false,'error'=>($error instanceof InvalidArgumentException?$error->getMessage():'订单查询暂不可用，请检查支付迁移与商户配置').$detail],JSON_UNESCAPED_UNICODE);
}
