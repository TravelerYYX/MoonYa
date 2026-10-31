<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
$config = require dirname(__DIR__) . '/config.php';
$paths = ['user/user_xinxi.php', 'user/edit_profile.php', 'user/account_settings.php'];
$directory = AppDataPaths::directory('temp', 'client-links');
try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $id = authenticateMoonYaRequest($config);
        $input = json_decode((string)file_get_contents('php://input'), true);
        $path = (string)($input['path'] ?? '');
        if (!in_array($path, $paths, true)) throw new InvalidArgumentException('页面不允许');
        $code = bin2hex(random_bytes(32));
        if (file_put_contents($directory . '/' . $code . '.json', json_encode(['id' => $id, 'path' => $path, 'expires' => time() + 60]), LOCK_EX) === false) throw new RuntimeException('页面凭据不可用');
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => true, 'data' => ['path' => 'api/client_link.php?code=' . $code]]); exit;
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'GET' || !preg_match('/^[a-f0-9]{64}$/', (string)($_GET['code'] ?? ''))) throw new InvalidArgumentException('页面凭据无效');
    $file = $directory . '/' . $_GET['code'] . '.json';
    // Rename atomically claims the link. A second browser cannot reuse it.
    if (!@rename($file, $file . '.used')) throw new InvalidArgumentException('页面凭据已使用或过期');
    try { $ticket = json_decode((string)file_get_contents($file . '.used'), true); } finally { @unlink($file . '.used'); }
    if (!$ticket || $ticket['expires'] < time() || !in_array($ticket['path'], $paths, true)) throw new InvalidArgumentException('页面凭据已过期');
    AppDataPaths::configurePhp(); session_start(); session_regenerate_id(true);
    $_SESSION['user_id'] = (int)$ticket['id'];
    header('Location: ../' . $ticket['path'], true, 303);
} catch (Throwable $error) {
    http_response_code(http_response_code() === 401 ? 401 : 400);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => '页面无法打开，请在客户端重新点击'], JSON_UNESCAPED_UNICODE);
}
