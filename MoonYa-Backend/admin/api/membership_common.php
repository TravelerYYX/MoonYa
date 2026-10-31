<?php
declare(strict_types=1);
require_once dirname(__DIR__,2).'/Services/BuiltinModelService.php';
require_once dirname(__DIR__,2).'/Services/RequestHeaders.php';
require_once dirname(__DIR__,2).'/Services/CorsPolicy.php';
require_once dirname(__DIR__).'/Auth.php';
require_once dirname(__DIR__).'/Logger.php';
function membershipAdminEndpoint(bool $models): void {
    applyCorsPolicy(); header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store');
    if ($_SERVER['REQUEST_METHOD']==='OPTIONS') { http_response_code(204); return; }
    try {
        $config=require dirname(__DIR__).'/config.php'; $db=MembershipService::connect($config); $logger=new Logger($config,$db);
        $auth=new Auth($db,$config,$logger); $admin=$auth->authenticate(preg_replace('/^Bearer\s+/i','',moonyaAuthorizationHeader()));
        if (!$admin) { http_response_code(401); throw new RuntimeException('请先登录管理后台'); }
        $service=$models?new BuiltinModelService($db,require dirname(__DIR__,2).'/config.php'):new MembershipService($db);
        $method=$_SERVER['REQUEST_METHOD'];
        $action=$_GET['action'] ?? '';
        if ($models && $action === 'test' && $method === 'POST') {
            if (!$auth->hasPermission($admin,'edit_users')) { http_response_code(403); throw new RuntimeException('没有管理权限'); }
            $input=json_decode((string)file_get_contents('php://input'),true,64,JSON_THROW_ON_ERROR);
            if (!is_array($input)) throw new InvalidArgumentException('请求格式无效');
            $data = $service->testConnection($input);
            echo json_encode(['success'=>true,'data'=>$data],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
            return;
        }
        if ($method==='GET') $data=['items'=>$models?$service->list(true):$service->plans(true)];
        elseif (in_array($method,['POST','PUT','DELETE'],true)) {
            if (!$auth->hasPermission($admin,'edit_users')) { http_response_code(403); throw new RuntimeException('没有管理权限'); }
            $input=json_decode((string)file_get_contents('php://input'),true,64,JSON_THROW_ON_ERROR);
            if (!is_array($input)) throw new InvalidArgumentException('请求格式无效');
            if ($method==='DELETE') { $models?$service->delete((string)($input['id']??'')):$service->deletePlan((int)($input['id']??0)); $data=[]; }
            else { $data=$models?($service->save($input)??[]):$service->savePlan($input); }
            // Keys and supplier payloads are never included in administrative logs.
            $logger->logAdminAction((int)$admin['id'],($models?'builtin_model_':'membership_plan_').strtolower($method),null,json_encode(['id'=>$input['id']??null,'name'=>$input['label']??$input['name']??null],JSON_UNESCAPED_UNICODE));
        } else { http_response_code(405); throw new InvalidArgumentException('不支持的请求方法'); }
        echo json_encode(['success'=>true,'data'=>$data],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        if (http_response_code()<400) http_response_code($error instanceof InvalidArgumentException?400:503);
        $message=$error instanceof InvalidArgumentException||http_response_code()===401||http_response_code()===403?$error->getMessage():'配置操作失败，请检查标识是否重复及数据库迁移是否完成';
        echo json_encode(['success'=>false,'error'=>$message],JSON_UNESCAPED_UNICODE);
    }
}
