<?php
/**
 * 认证后的实时 ASR 短期凭据；永久供应商密钥不离开服务器。
 */
header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/Services/CorsPolicy.php';
applyCorsPolicy();

$config = require_once __DIR__ . '/../config.php';
require_once dirname(__DIR__) . '/Services/RuntimeRequestAuth.php';
try { authenticateMoonYaRequest($config); } catch (Throwable $error) {
    http_response_code(http_response_code() === 401 ? 401 : 503);
    echo json_encode(['success' => false, 'error' => '请登录后使用语音识别']); exit;
}
$asrConfig = $config['aliyun_asr'] ?? [];

$required = ['api_key', 'model', 'fallback_models', 'realtime_models', 'websocket_url'];
foreach ($required as $field) {
    $value = $asrConfig[$field] ?? null;
    if ($value === null || $value === '' || (is_array($value) && $value === [])) {
        http_response_code(503);
        echo json_encode([
            'success' => false,
            'error_code' => 'missing_config',
            'error' => "Missing required configuration: aliyun_asr.{$field}",
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

$fallbackModels = $asrConfig['fallback_models'];
$fallbackModels = array_values(array_unique(array_map('strval', $fallbackModels)));

$realtimeModels = array_values(array_unique(array_map('strval', $asrConfig['realtime_models'])));
$allModels = array_merge($fallbackModels, $realtimeModels);
$allModels = array_values(array_unique($allModels));

// https://help.aliyun.com/en/model-studio/application-obtain-temporary-authentication-token
$tokenUrl = $asrConfig['temporary_token_url'] ?? 'https://dashscope.aliyuncs.com/api/v1/tokens';
$curl = curl_init($tokenUrl . (str_contains($tokenUrl, '?') ? '&' : '?') . 'expire_in_seconds=300');
curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => '', CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $asrConfig['api_key']], CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => false]);
$result = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
$credential = $result === false ? null : json_decode($result, true);
if ($status !== 200 || empty($credential['token']) || empty($credential['expires_at'])) {
    http_response_code(503); echo json_encode(['success' => false, 'error' => '实时语音凭据暂不可用']); exit;
}

echo json_encode([
    'success'         => true,
    'api_key'         => $credential['token'],
    'expires_at'      => (int)$credential['expires_at'],
    'model'           => $asrConfig['model'],
    'fallback_models' => $allModels,
    'websocket_url'   => $asrConfig['websocket_url'],
    'region'          => $asrConfig['region'] ?? '',
], JSON_UNESCAPED_UNICODE);
