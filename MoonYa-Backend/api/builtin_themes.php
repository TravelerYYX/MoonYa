<?php
declare(strict_types=1);
ini_set('display_errors', '0');
require_once dirname(__DIR__).'/env_loader.php';
require_once dirname(__DIR__).'/Services/BuiltinThemeService.php';
require_once dirname(__DIR__).'/admin/Database.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }
try {
    $config = require dirname(__DIR__).'/config.php';
    $db = (new Database($config))->getConnection();
    $service = new BuiltinThemeService(
        $db,
        dirname(__DIR__).'/uploads/themes',
        (string)(env('MAIN_API_DOMAIN') ?: ''),
        dirname(__DIR__).'/config/builtin_themes.json'
    );
    echo json_encode(['success' => true, 'data' => $service->catalog()], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    error_log('Builtin themes catalog: '.$error->getMessage());
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => '内置主题暂不可用'], JSON_UNESCAPED_UNICODE);
}
