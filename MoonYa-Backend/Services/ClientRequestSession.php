<?php
declare(strict_types=1);
require_once __DIR__ . '/RuntimeRequestAuth.php';

/** Adapt legacy cookie-based business endpoints to the desktop Bearer contract. */
function moonyaBindBearerSession(array $config): void
{
    $authorization = moonyaAuthorizationHeader();
    if (!preg_match('/^Bearer\s+/i', $authorization)) return;
    try {
        $id = authenticateMoonYaRequest($config);
        $_SESSION['user_id'] = $id;
    } catch (Throwable $error) {
        http_response_code(http_response_code() === 401 ? 401 : 503);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => false, 'error' => http_response_code() === 401 ? '登录已失效' : '认证服务不可用'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}
