<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
header('Content-Type: application/json; charset=utf-8');
try {
    $config = require dirname(__DIR__) . '/config.php';
    authenticateMoonYaRequest($config);
    $feature = (string)($_GET['feature'] ?? '');
    if (!in_array($feature, ['weather', 'horoscope'], true)) throw new InvalidArgumentException('功能无效');
    $settings = $config[$feature];
    if (($settings['enabled'] ?? true) !== true) throw new RuntimeException('功能已停用');
    $target = (string)($settings['api_url'] ?? '');
    if (!preg_match('#^https?://#', $target)) throw new RuntimeException('功能未配置');
    $query = $_GET; unset($query['feature'], $query['token'], $query['api_token']);
    // Feature adapters formerly embedded the service token in the HTML.
    if (!empty($settings['api_token'])) $query['token'] = $settings['api_token'];
    $curl = curl_init($target . (str_contains($target, '?') ? '&' : '?') . http_build_query($query));
    curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 15, CURLOPT_FOLLOWLOCATION => false]);
    $body = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
    if ($body === false || $status < 200 || $status >= 300) throw new RuntimeException('功能请求失败');
    echo $body;
} catch (Throwable $error) { http_response_code(http_response_code() === 401 ? 401 : 503); echo json_encode(['success' => false, 'error' => '在线功能暂不可用']); }
