<?php
declare(strict_types=1);

/** Emit CORS only for the same origin or an explicit allowlist. */
function applyCorsPolicy(
    string $methods = 'GET, POST, PUT, DELETE, OPTIONS',
    string $headers = 'Content-Type, Authorization, X-CSRF-Token'
): void {
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin === '') {
        return;
    }
    $originParts = parse_url($origin);
    if (!is_array($originParts) || !in_array(strtolower((string)($originParts['scheme'] ?? '')), ['http', 'https'], true)) {
        return;
    }

    $originHost = strtolower((string)($originParts['host'] ?? ''));
    $originPort = isset($originParts['port']) ? (int)$originParts['port'] : null;
    $requestHost = strtolower(trim((string)($_SERVER['HTTP_HOST'] ?? '')));
    $sameOrigin = $requestHost !== '' && strtolower($originHost . ($originPort ? ':' . $originPort : '')) === $requestHost;

    // 优先走 env_loader 的 env()：putenv 被禁用时 getenv() 读不到 .env 注入的值。
    // 本文件可能被独立引入（不经 env_loader），故此处不做硬依赖。
    $configured = function_exists('env') ? env('CORS_ALLOWED_ORIGINS') : getenv('CORS_ALLOWED_ORIGINS');
    $allowlist = is_string($configured)
        ? array_values(array_filter(array_map('trim', explode(',', $configured))))
        : [];
    $allowed = $sameOrigin || in_array(rtrim($origin, '/'), array_map(
        static fn(string $item): string => rtrim($item, '/'),
        $allowlist
    ), true);
    if (!$allowed) {
        return;
    }

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin', false);
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Methods: ' . $methods);
    header('Access-Control-Allow-Headers: ' . $headers);
}
