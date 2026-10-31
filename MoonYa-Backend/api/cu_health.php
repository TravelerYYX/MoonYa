<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// .env 取值走 env_loader 的 env()：putenv 被禁用时 getenv() 读不到 .env 注入的值。
$envLoader = dirname(__DIR__) . '/env_loader.php';
if (is_file($envLoader)) require_once $envLoader;
$buildId = function_exists('env') ? (string) env('MOONYA_BUILD_ID', '') : (string) getenv('MOONYA_BUILD_ID');

$backendRoot = realpath(dirname(__DIR__)) ?: dirname(__DIR__);
$coordinator = $backendRoot . DIRECTORY_SEPARATOR . 'Services' . DIRECTORY_SEPARATOR . 'AIAssistant.php';
$emitter = $backendRoot . DIRECTORY_SEPARATOR . 'Services' . DIRECTORY_SEPARATOR . 'CuEventEmitter.php';

http_response_code(200);
echo json_encode([
    'success' => true,
    'protocol_version' => 'cu-reliability-v2',
    'backend_root' => $backendRoot,
    'build_id' => $buildId !== '' ? $buildId : 'local-source',
    'coordinator_sha256' => is_file($coordinator) ? hash_file('sha256', $coordinator) : null,
    'emitter_sha256' => is_file($emitter) ? hash_file('sha256', $emitter) : null,
    'coordinator_modified_utc' => is_file($coordinator)
        ? gmdate(DATE_ATOM, (int)filemtime($coordinator))
        : null,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
