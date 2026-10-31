<?php
declare(strict_types=1);
require_once __DIR__.'/RequestHeaders.php';
require_once __DIR__.'/AppDataPaths.php';

function paymentCsrfToken(): ?string {
    if (preg_match('/^Bearer\s+/i',moonyaAuthorizationHeader())) return null;
    if (session_status()!==PHP_SESSION_ACTIVE) { AppDataPaths::configurePhp();session_start(); }
    $token=$_SESSION['payment_csrf']??=bin2hex(random_bytes(32));session_write_close();return $token;
}
function checkPaymentCsrf(): void {
    if (preg_match('/^Bearer\s+/i',moonyaAuthorizationHeader())) return;
    $expected=paymentCsrfToken();$provided=$_SERVER['HTTP_X_CSRF_TOKEN']??'';
    if (!$provided || !hash_equals($expected,$provided)) { http_response_code(403);throw new InvalidArgumentException('安全验证失败，请重新加载会员页面'); }
}
