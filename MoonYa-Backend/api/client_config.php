<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/ClientConfig.php';
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); exit; }
try {
    $config = require dirname(__DIR__) . '/config.php';
    $catalog = (new BuiltinModelService(MembershipService::connect($config), $config))->list();
    echo json_encode(['success' => true, 'data' => moonyaClientConfig($config, $catalog)],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => '客户端配置暂不可用']);
}
