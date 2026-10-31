<?php
declare(strict_types=1);
ini_set('display_errors', '0');
require_once dirname(__DIR__, 2).'/env_loader.php';
require_once dirname(__DIR__, 2).'/Services/ProgramUpdateService.php';
require_once dirname(__DIR__, 2).'/Services/RequestHeaders.php';
require_once __DIR__.'/../Database.php';
require_once __DIR__.'/../Auth.php';
require_once __DIR__.'/../Logger.php';
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function updateResponse(int $status, mixed $data = null, ?string $error = null): never {
    http_response_code($status); header('Content-Type: application/json; charset=utf-8');
    echo json_encode($error === null ? ['success'=>true,'data'=>$data] : ['success'=>false,'error'=>$error], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR); exit;
}
try {
    $config = require __DIR__.'/../config.php';
    $db = (new Database($config))->getConnection();
    $chunkBytes = max(65536, min(67108864, (int)env('MOONYA_UPDATE_CHUNK_BYTES', 8388608)));
    $maxBytes = max($chunkBytes, (int)env('MOONYA_UPDATE_MAX_BYTES', 2147483648));
    $service = new ProgramUpdateService($db, dirname(__DIR__, 2).'/uploads/program-updates', $maxBytes, $chunkBytes);
    $method = $_SERVER['REQUEST_METHOD']; $action = (string)($_GET['action'] ?? 'list');
    if ($method === 'GET' && $action === 'latest') updateResponse(200, $service->publicRow($service->latest()));
    if (in_array($method, ['GET','HEAD'], true) && $action === 'download') {
        $row = $service->get((int)($_GET['id'] ?? 0)); $service->download($row, $method); exit;
    }
    $logger = new Logger($config, $db); $auth = new Auth($db, $config, $logger);
    // Apache/FastCGI 下 $_SERVER['HTTP_AUTHORIZATION'] 常为空，统一走与其他管理端一致的读取方式
    $authorization = moonyaAuthorizationHeader();
    $admin = $auth->authenticate(preg_match('/^Bearer\s+(.+)$/i', $authorization, $match) ? trim($match[1]) : null);
    if (!$admin) updateResponse(401, null, '请先登录管理后台');
    $adminId = (int)$admin['id'];
    if ($method === 'GET' && $action === 'list') updateResponse(200, ['releases'=>array_map($service->publicRow(...), $service->listing()), 'chunk_bytes'=>$chunkBytes, 'max_bytes'=>$maxBytes]);
    if ($method !== 'POST') updateResponse(405, null, '不支持的请求方法');
    if ($action === 'chunk') {
        $input = fopen('php://input', 'rb'); $bytes = stream_get_contents($input, $chunkBytes + 1); fclose($input);
        updateResponse(200, $service->chunk($adminId, (string)($_GET['upload_id'] ?? ''), (int)($_GET['offset'] ?? -1), $bytes));
    }
    $input = json_decode((string)file_get_contents('php://input'), true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($input)) throw new InvalidArgumentException('请求数据无效');
    if ($action === 'begin') updateResponse(200, $service->begin($adminId, $input));
    if ($action === 'set_force') {
        if (!isset($input['force_update']) || !is_bool($input['force_update'])) throw new InvalidArgumentException('强制更新开关无效');
        $row = $service->setForce((int)($input['id'] ?? 0), $input['force_update']);
        $logger->logAdminAction($adminId, 'program_update_force', null, $row['version'].' '.($input['force_update'] ? '开启' : '关闭'));
        updateResponse(200, $service->publicRow($row));
    }
    if ($action === 'complete') {
        $row = $service->complete($adminId, (string)($input['upload_id'] ?? ''));
        $logger->logAdminAction($adminId, 'program_update_upload', null, $row['version']);
        updateResponse(200, $service->publicRow($row));
    }
    if ($action === 'publish') {
        $row = $service->publish((int)($input['id'] ?? 0));
        $logger->logAdminAction($adminId, 'program_update_publish', null, $row['version']);
        updateResponse(200, $service->publicRow($row));
    }
    if ($action === 'delete') {
        $raw = $input['ids'] ?? (array_key_exists('id', $input) ? [$input['id']] : null);
        if (!is_array($raw)) throw new InvalidArgumentException('请选择要删除的版本');
        $ids = [];
        foreach ($raw as $value) {
            $valid = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
            if ($valid === false) throw new InvalidArgumentException('版本标识无效');
            $ids[(int)$valid] = (int)$valid;
        }
        $ids = array_values($ids);
        if (!$ids) throw new InvalidArgumentException('请选择要删除的版本');
        if (count($ids) > 100) throw new InvalidArgumentException('单次最多删除 100 个版本');
        if (count($ids) === 1) {
            $row = $service->delete($ids[0]);
            $logger->logAdminAction($adminId, 'program_update_delete', null, $row['version'].'（'.$row['file_name'].'）');
            updateResponse(200, ['deleted'=>[$row], 'failed'=>[]]);
        }
        $result = $service->deleteMany($ids);
        foreach ($result['deleted'] as $row) $logger->logAdminAction($adminId, 'program_update_delete', null, $row['version'].'（'.$row['file_name'].'）');
        updateResponse(200, $result);
    }
    updateResponse(400, null, '无效的操作');
} catch (InvalidArgumentException | JsonException $error) { updateResponse(400, null, $error->getMessage()); }
catch (PDOException $error) { error_log('Program updates: '.$error->getMessage()); updateResponse(500, null, $error->getCode() === '23000' ? '版本号已存在' : '更新数据不可用，请确认数据库迁移已完成'); }
catch (Throwable $error) { error_log('Program updates: '.$error->getMessage()); updateResponse(500, null, '更新服务暂时不可用'); }
