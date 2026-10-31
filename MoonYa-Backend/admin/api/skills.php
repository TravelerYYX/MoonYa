<?php
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__, 2) . '/Services/CorsPolicy.php';
require_once dirname(__DIR__, 2) . '/Services/SkillCatalog.php';
applyCorsPolicy();
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

try {
    require_once __DIR__ . '/../config.php';
    require_once __DIR__ . '/../Database.php';
    require_once __DIR__ . '/../Auth.php';
    require_once __DIR__ . '/../Logger.php';
    $config = require __DIR__ . '/../config.php';
    $db = new Database($config);
    $conn = $db->getConnection();
    $logger = new Logger($config, $conn);
    $auth = new Auth($conn, $config, $logger);
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $authorization = (string)($headers['Authorization'] ?? $headers['authorization'] ?? '');
    $admin = $auth->authenticate(str_starts_with($authorization, 'Bearer ') ? substr($authorization, 7) : '');
    if (!$admin) sendError(401, '未授权访问，请先登录');

    $catalog = new SkillCatalog(dirname(__DIR__, 2) . '/skills');
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $action = trim((string)($_GET['action'] ?? 'list'));
        if ($action === 'list') sendSuccess(['skills' => array_map(static fn(array $skill): array => $skill + [
            'can_edit_info' => SkillCatalog::isCustom($skill['name']), 'can_delete' => SkillCatalog::isCustom($skill['name']),
        ], $catalog->list(true))]);
        $name = trim((string)($_GET['name'] ?? ''));
        $path = (string)($_GET['path'] ?? '');
        if ($name === '') sendError(400, 'name 不能为空');
        if ($action === 'detail') sendSuccess(['skill' => $catalog->read($name)]);
        if ($action === 'browse') sendSuccess(['directory' => $catalog->browse($name, $path)]);
        if ($action === 'read') sendSuccess(['file' => $catalog->readFile($name, $path ?: 'SKILL.md')]);
        sendError(400, '未知技能操作');
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') sendError(405, '不支持的请求方法');
    if (str_starts_with(strtolower((string)($_SERVER['CONTENT_TYPE'] ?? '')), 'multipart/form-data')) {
        if ($_POST === [] && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) sendError(413, '上传请求为空，请检查服务器 post_max_size 与代理请求体限制');
        if (($_POST['action'] ?? '') !== 'upload') sendError(400, '未知技能操作');
        $upload = $_FILES['files'] ?? null;
        if (!is_array($upload) || !is_array($upload['name'] ?? null)) sendError(400, '请选择 Markdown 文件，或检查服务器上传限制');
        if (isset($_POST['file_count']) && (string)count($upload['name']) !== (string)$_POST['file_count']) sendError(400, '上传文件数量不完整，请检查服务器 max_file_uploads 限制');
        $files = []; $total = 0;
        foreach ($upload['name'] as $index => $filename) {
            if (($upload['error'][$index] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) sendError(400, '文件上传失败，请检查服务器上传限制');
            $size = (int)($upload['size'][$index] ?? 0); $total += $size;
            if ($size > SkillCatalog::MAX_FILE_BYTES || $total > SkillCatalog::MAX_UPLOAD_BYTES) sendError(413, '上传超过限制：单文件 1 MiB，单次总量 10 MiB');
            $temporary = (string)($upload['tmp_name'][$index] ?? '');
            if (!is_uploaded_file($temporary)) sendError(400, '上传文件无效');
            $raw = file_get_contents($temporary);
            if (!is_string($raw)) sendError(400, '上传文件无法读取');
            $files[] = ['name' => (string)$filename, 'raw' => $raw];
        }
        $name = trim((string)($_POST['name'] ?? '')); $path = (string)($_POST['path'] ?? '');
        $directory = $catalog->upload($name, $path, $files);
        $logger->logAdminAction((int)$admin['id'], 'upload_skill_files', null, "上传技能提示词 {$name}/{$path}，共 " . count($files) . ' 个文件');
        sendSuccess(['directory' => $directory]);
    }
    if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 67108864) sendError(413, '请求体超过限制');
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) sendError(400, '请求 JSON 无效');
    $action = trim((string)($input['action'] ?? 'save'));
    $name = trim((string)($input['name'] ?? ''));
    if ($action === 'upload_tree') {
        $mode = $input['mode'] ?? 'resources';
        if (!in_array($mode, ['resources', 'import'], true)) sendError(400, '未知文件夹上传方式');
        if (!is_array($input['directories'] ?? null) || !is_array($input['files'] ?? null)) sendError(400, '上传目录或文件清单无效');
        if ($mode === 'resources' && (!is_string($input['name'] ?? null) || !is_string($input['path'] ?? ''))) sendError(400, 'name 和 path 必须为文本');
        $data = $mode === 'import'
            ? $catalog->importTrees($input['directories'], $input['files'])
            : $catalog->uploadTree($name, $input['path'] ?? '', $input['directories'], $input['files']);
        $names = $mode === 'import' ? implode(', ', array_column($data['skills'], 'name')) : $name;
        $logger->logAdminAction((int)$admin['id'], $mode === 'import' ? 'import_skills' : 'upload_skill_tree', null,
            "上传技能 {$names}，共 {$data['uploaded_count']} 个文件、{$data['directory_count']} 个目录，跳过 " . count($data['skipped']) . ' 个文件');
        sendSuccess($data);
    }
    if ($action === 'update_info') {
        foreach (['name', 'display_name', 'description', 'body'] as $field) {
            if (!isset($input[$field]) || !is_string($input[$field])) sendError(400, $field . ' 必须为文本');
        }
        $skill = $catalog->updateInfo($name, $input['display_name'], $input['description'], $input['body']);
        $logger->logAdminAction((int)$admin['id'], 'update_skill_info', null, "更新技能信息 {$name}");
        sendSuccess(['skill' => $skill]);
    }
    if ($action === 'delete') {
        if (!isset($input['name']) || !is_string($input['name'])) sendError(400, 'name 必须为文本');
        $catalog->delete($name);
        $logger->logAdminAction((int)$admin['id'], 'delete_skill', null, "删除技能及全部子文件 {$name}");
        sendSuccess(['deleted_name' => $name]);
    }
    if ($action === 'create') {
        $skill = $catalog->create($name, (string)($input['display_name'] ?? ''), (string)($input['description'] ?? ''), (string)($input['body'] ?? ''));
        $logger->logAdminAction((int)$admin['id'], 'create_skill', null, "新建技能 {$name}");
        sendSuccess(['skill' => $skill]);
    }
    if ($action === 'mkdir') {
        $path = (string)($input['path'] ?? '');
        $directory = $catalog->createDirectory($name, $path);
        $logger->logAdminAction((int)$admin['id'], 'create_skill_directory', null, "新建技能目录 {$name}/{$path}");
        sendSuccess(['directory' => $directory]);
    }
    if ($action !== 'save') sendError(400, '未知技能操作');
    $path = (string)($input['path'] ?? 'SKILL.md');
    $raw = (string)($input['raw'] ?? '');
    $file = $catalog->updateFile($name, $path, $raw);
    $logger->logAdminAction((int)$admin['id'], 'update_skill', null, "更新技能 {$name}/{$path}");
    sendSuccess(['skill' => $file]);
} catch (InvalidArgumentException $error) {
    sendError(400, $error->getMessage());
} catch (DomainException $error) {
    sendError(403, $error->getMessage());
} catch (OutOfBoundsException $error) {
    sendError(404, $error->getMessage());
} catch (Throwable $error) {
    sendError(500, '服务器错误: ' . $error->getMessage());
}

function sendSuccess(array $data): void
{
    echo json_encode(['success' => true, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function sendError(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['success' => false, 'error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
