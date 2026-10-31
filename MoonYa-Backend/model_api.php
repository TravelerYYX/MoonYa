<?php
declare(strict_types=1);
// Desktop presentation/runtime adapters have moved to MoonYa-Frontend and MoonYa-Harness.
require_once __DIR__ . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
require_once __DIR__ . '/Services/AgentRuntimeClient.php';
require_once __DIR__ . '/Services/RuntimeRequestAuth.php';
try {
    $config = require __DIR__ . '/config.php';
    $authenticatedUserId = authenticateMoonYaRequest($config);
    $client = new AgentRuntimeClient($config['agent_runtime_url']);
    $method = $_SERVER['REQUEST_METHOD'];
    if ($method === 'GET') $result = $client->request('GET', '/v1/model-config');
    elseif ($method === 'POST') {
        if (!str_contains(strtolower($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json')) throw new InvalidArgumentException('请求必须使用 JSON');
        $input = json_decode((string)file_get_contents('php://input'), true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($input) || !in_array($input['action'] ?? '', ['save', 'delete', 'discover', 'test', 'cancel_chat'], true)) throw new InvalidArgumentException('模型配置操作无效');
        if ($input['action'] === 'cancel_chat') {
            $messageId = trim((string)($input['client_message_id'] ?? ''));
            if (!preg_match('/^[a-f0-9-]{36}$/i', $messageId)) throw new InvalidArgumentException('消息标识无效');
            $result = $client->request('POST', '/v1/llm/cancel', [
                'user_context' => (string)$authenticatedUserId,
                'conversation_id' => (string)($input['conversation_id'] ?? $messageId),
                'client_message_id' => $messageId,
            ]);
        } else $result = $client->request('POST', '/v1/model-config', $input, 45);
    } else { http_response_code(405); throw new InvalidArgumentException('请求方法无效'); }
    echo json_encode(['success' => true, 'data' => $result], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    if (http_response_code() < 400) http_response_code($error instanceof InvalidArgumentException ? 400 : 503);
    $message = $error instanceof AgentRuntimeRequestException && $error->remoteCode !== '' ? $error->remoteCode : $error->getMessage();
    echo json_encode(['success' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
}
