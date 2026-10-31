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
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') { http_response_code(405); throw new InvalidArgumentException('请求方法无效'); }
    $config = require __DIR__ . '/config.php';
    $userId = authenticateMoonYaRequest($config);
    $chatId = trim((string)($_GET['client_chat_id'] ?? ''));
    if ($chatId === '' || strlen($chatId) > 128) throw new InvalidArgumentException('会话标识无效');
    $query = ['user_context' => (string)$userId, 'client_chat_id' => $chatId];
    foreach (['has_history', 'model_id', 'model_ref', 'session_id', 'limit_tokens', 'mode', 'conversation_id'] as $key) {
        if (isset($_GET[$key]) && is_string($_GET[$key])) $query[$key] = $_GET[$key];
    }
    $data = (new AgentRuntimeClient($config['agent_runtime_url']))->request('GET', '/v1/conversation-stats?' . http_build_query($query));
    echo json_encode(['success' => true, 'data' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    if (http_response_code() < 400) http_response_code($error instanceof InvalidArgumentException ? 400 : 503);
    echo json_encode(['success' => false, 'error' => $error->getMessage()], JSON_UNESCAPED_UNICODE);
}
