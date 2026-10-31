<?php
declare(strict_types=1);
ini_set('display_errors','0');
require_once dirname(__DIR__,2).'/env_loader.php';
require_once dirname(__DIR__,2).'/Services/AnnouncementService.php';
require_once dirname(__DIR__,2).'/Services/RequestHeaders.php';
require_once __DIR__.'/../Database.php';
require_once __DIR__.'/../Auth.php';
require_once __DIR__.'/../Logger.php';
header('X-Content-Type-Options: nosniff'); header('Cache-Control: no-store');
function announcementResponse(int $status, mixed $data=null, ?string $error=null): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8');
    echo json_encode($error === null ? ['success'=>true,'data'=>$data] : ['success'=>false,'error'=>$error],JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR); exit;
}
try {
    $config = require __DIR__.'/../config.php'; $db = (new Database($config))->getConnection();
    $service = new AnnouncementService($db,dirname(__DIR__,2));
    $method = $_SERVER['REQUEST_METHOD']; $action = (string)($_GET['action'] ?? 'list');
    if ($method === 'GET' && $action === 'feed') announcementResponse(200,['announcements'=>$service->feed()]);
    $logger = new Logger($config,$db); $auth = new Auth($db,$config,$logger);
    $authorization = moonyaAuthorizationHeader();
    $admin = $auth->authenticate(preg_match('/^Bearer\s+(.+)$/i',$authorization,$match) ? trim($match[1]) : null);
    if (!$admin) announcementResponse(401,null,'请先登录管理后台');
    if ($method === 'GET' && $action === 'list') announcementResponse(200,['announcements'=>$service->listing()]);
    if ($method !== 'POST') announcementResponse(405,null,'不支持的请求方法');
    $input = json_decode((string)file_get_contents('php://input'),true,512,JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new InvalidArgumentException('请求数据无效');
    $id = (int)($input['id'] ?? 0);
    $row = match($action) {
        'save' => $service->save((int)$admin['id'],$input),
        'publish' => $service->publish($id),
        'withdraw' => $service->withdraw($id),
        'delete' => $service->delete($id),
        default => throw new InvalidArgumentException('无效的操作')
    };
    $logger->logAdminAction((int)$admin['id'],'announcement_'.$action,null,$row['id'].' '.$row['title']);
    announcementResponse(200,$row);
} catch (InvalidArgumentException | JsonException $error) { announcementResponse(400,null,$error->getMessage()); }
catch (Throwable $error) { error_log('Announcements: '.$error->getMessage()); announcementResponse(500,null,'公告服务暂时不可用，请确认数据库迁移已完成'); }
