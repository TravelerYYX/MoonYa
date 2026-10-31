<?php
declare(strict_types=1);
require_once __DIR__ . '/AppDataPaths.php';
require_once __DIR__ . '/RequestHeaders.php';

function authenticateMoonYaRequest(array $config): int
{
    $authorization = moonyaAuthorizationHeader();
    if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $match)) {
        $pdo = new PDO("mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4",
            $config['db_user'], $config['db_pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $stmt = $pdo->prepare("SELECT id, token_created_at FROM users WHERE api_token = ? AND status != 'deleted' LIMIT 1");
        $stmt->execute([trim($match[1])]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($user && (!$user['token_created_at'] || time() - strtotime($user['token_created_at']) <= 1296000)) return (int)$user['id'];
        http_response_code(401);
        throw new RuntimeException('登录已失效');
    }
    if (session_status() !== PHP_SESSION_ACTIVE) {
        AppDataPaths::configurePhp();
        session_start();
    }
    $id = (int)($_SESSION['user_id'] ?? 0);
    session_write_close();
    if ($id > 0) return $id;
    http_response_code(401);
    throw new RuntimeException('请先登录后再配置模型');
}

