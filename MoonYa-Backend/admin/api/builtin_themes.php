<?php
declare(strict_types=1);
ini_set('display_errors', '0');
require_once dirname(__DIR__, 2).'/env_loader.php';
require_once dirname(__DIR__, 2).'/Services/BuiltinThemeService.php';
require_once dirname(__DIR__, 2).'/Services/RequestHeaders.php';
require_once __DIR__.'/../Database.php';
require_once __DIR__.'/../Auth.php';
require_once __DIR__.'/../Logger.php';
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function themeResponse(int $status, mixed $data = null, ?string $error = null): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8');
    echo json_encode($error === null ? ['success'=>true,'data'=>$data] : ['success'=>false,'error'=>$error], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR); exit;
}
try {
    $config = require __DIR__.'/../config.php';
    $db = (new Database($config))->getConnection();
    $service = new BuiltinThemeService(
        $db,
        dirname(__DIR__, 2).'/uploads/themes',
        (string)(env('MAIN_API_DOMAIN') ?: ''),
        dirname(__DIR__, 2).'/config/builtin_themes.json'
    );
    $method = $_SERVER['REQUEST_METHOD'];
    $action = (string)($_GET['action'] ?? 'list');

    // 公开目录与资源：客户端下载前不需要后台登录态，但走的是同一份服务。
    if ($method === 'GET' && $action === 'catalog') themeResponse(200, $service->catalog());

    $logger = new Logger($config, $db); $auth = new Auth($db, $config, $logger);
    // Apache/FastCGI 下 $_SERVER['HTTP_AUTHORIZATION'] 常为空，统一走 moonyaAuthorizationHeader()
    $authorization = moonyaAuthorizationHeader();
    $admin = $auth->authenticate(preg_match('/^Bearer\s+(.+)$/i', $authorization, $match) ? trim($match[1]) : null);
    if (!$admin) themeResponse(401, null, '请先登录管理后台');
    $adminId = (int)$admin['id'];
    if (!$auth->hasPermission($admin, 'edit_users')) themeResponse(403, null, '没有管理权限');

    if ($method === 'GET' && $action === 'list') {
        themeResponse(200, ['themes' => $service->listing(), 'base' => (string)(env('MAIN_API_DOMAIN') ?: '')]);
    }
    if ($method !== 'POST') themeResponse(405, null, '不支持的请求方法');

    // 资源上传走 multipart，必须在解析 JSON body 之前处理
    if ($action === 'upload') {
        $id = (int)($_POST['id'] ?? 0);
        $field = ($_POST['kind'] ?? 'background') === 'thumb' ? 'thumb' : 'background';
        if (!isset($_FILES[$field])) throw new InvalidArgumentException('请选择要上传的图片');
        $row = $service->attachAsset($id, $_FILES[$field], $field === 'thumb');
        $logger->logAdminAction($adminId, 'builtin_theme_asset', null, $row['slug'].' '.$field);
        themeResponse(200, $row);
    }

    $input = json_decode((string)file_get_contents('php://input'), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new InvalidArgumentException('请求数据无效');

    if ($action === 'save') {
        $row = $service->save($adminId, $input);
        $logger->logAdminAction($adminId, 'builtin_theme_save', null, $row['slug']);
        themeResponse(200, $row);
    }
    if ($action === 'publish' || $action === 'unpublish') {
        $row = $service->setEnabled((int)($input['id'] ?? 0), $action === 'publish');
        $logger->logAdminAction($adminId, 'builtin_theme_'.$action, null, $row['slug']);
        themeResponse(200, $row);
    }
    if ($action === 'sort') {
        $row = $service->setSort((int)($input['id'] ?? 0), (int)($input['sortOrder'] ?? 0));
        $logger->logAdminAction($adminId, 'builtin_theme_sort', null, $row['slug']);
        themeResponse(200, $row);
    }
    if ($action === 'delete') {
        $row = $service->remove((int)($input['id'] ?? 0));
        $logger->logAdminAction($adminId, 'builtin_theme_delete', null, $row['slug']);
        themeResponse(200, $row);
    }
    if ($action === 'export_config') {
        themeResponse(200, $service->exportConfig());
    }
    if ($action === 'import_config') {
        $result = $service->importConfig($adminId);
        $logger->logAdminAction($adminId, 'builtin_theme_import_config', null, (string)$result['imported']);
        themeResponse(200, $result);
    }
    themeResponse(400, null, '无效的操作');
} catch (InvalidArgumentException | JsonException $error) { themeResponse(400, null, $error->getMessage()); }
catch (PDOException $error) {
    error_log('Builtin themes: '.$error->getMessage());
    themeResponse(500, null, $error->getCode() === '23000' ? '主题标识已存在' : '主题数据不可用，请确认数据库迁移已完成');
}
catch (Throwable $error) { error_log('Builtin themes: '.$error->getMessage()); themeResponse(500, null, '主题服务暂时不可用'); }
