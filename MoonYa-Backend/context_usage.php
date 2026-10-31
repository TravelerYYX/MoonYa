<?php
declare(strict_types=1);
// Desktop presentation/runtime adapters have moved to MoonYa-Frontend and MoonYa-Harness.
require_once __DIR__ . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond();

require_once __DIR__ . '/Services/AppDataPaths.php';
// Chat 圆环读取后端采集的实际请求上下文快照，并叠加当前草稿估算。
// Work 使用 harness_api.php 的 context_usage 端点；累计统计使用 statistics.php。

error_reporting(E_ALL);
ini_set('display_errors', '0');

header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/Services/CorsPolicy.php';
applyCorsPolicy();
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

function contextUsageSend(array $payload): void {
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

AppDataPaths::configurePhp(); session_start();

$config = require __DIR__ . '/config.php';
require_once __DIR__ . '/Services/ContextUsage.php';

try {
    $pdo = new PDO(
        "mysql:host=" . $config['db_host'] . ";dbname=" . $config['db_name'] . ";charset=utf8mb4",
        $config['db_user'],
        $config['db_pass'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
} catch (Throwable $e) {
    contextUsageSend(['success' => false, 'error' => '数据库连接失败']);
}

// ── 鉴权：Bearer token 优先，其次会话（与 conversation_api.php 同一套）──
$tokenUserId = null;
$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if ($authHeader === '' && isset($_GET['token']) && $_GET['token'] !== '') {
    $authHeader = 'Bearer ' . $_GET['token'];
}
if ($authHeader === '' && function_exists('getallheaders')) {
    $headers = getallheaders();
    $authHeader = $headers['Authorization'] ?? ($headers['authorization'] ?? '');
}
if (is_string($authHeader) && preg_match('/Bearer\s+(.*)$/i', $authHeader, $matches)) {
    $token = trim($matches[1]);
    try {
        $stmt = $pdo->prepare('SELECT id, token_created_at FROM users WHERE api_token = ?');
        $stmt->execute([$token]);
        $user = $stmt->fetch();
        if ($user) {
            $elapsed = $user['token_created_at'] ? time() - strtotime($user['token_created_at']) : 0;
            if (!$user['token_created_at'] || $elapsed <= 1296000) {
                $tokenUserId = (int)$user['id'];
                $_SESSION['user_id'] = $tokenUserId;
            }
        }
    } catch (Throwable $e) {
        contextUsageSend(['success' => false, 'error' => '鉴权失败']);
    }
}
$userId = $tokenUserId ?? (int)($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    contextUsageSend(['success' => false, 'error' => '未登录']);
}

$conversationId = (int)($_GET['conversation_id'] ?? 0);
if ($conversationId <= 0) {
    contextUsageSend(['success' => false, 'error' => '缺少 conversation_id']);
}

// 校验对话归属；缺表时给出明确错误码（前端会回退到 localStorage 估算）
try {
    $tables = $pdo->query("SHOW TABLES LIKE 'conversations'")->fetchAll(PDO::FETCH_COLUMN);
    if (count($tables) === 0) {
        contextUsageSend(['success' => false, 'error' => 'tables_missing', 'message' => '当前数据库缺少 conversations/messages 表，服务端无法统计上下文']);
    }
    $ownership = $pdo->prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?');
    $ownership->execute([$conversationId, $userId]);
    if (!$ownership->fetchColumn()) {
        contextUsageSend(['success' => false, 'error' => '对话不存在']);
    }
} catch (Throwable $e) {
    contextUsageSend(['success' => false, 'error' => '查询失败']);
}

// 根据当前模型解析真实上限，不能信任客户端传入的长度。
$modelRef = null;
$modelMetadata = null;
try {
    if (isset($_GET['model_ref'])) {
        $modelRef = json_decode((string)$_GET['model_ref'], true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($modelRef)) throw new RuntimeException('模型引用无效');
        require_once __DIR__ . '/Services/CustomModelChat.php';
        $modelMetadata = CustomModelChat::metadata($config, $modelRef);
    }
    $requested = isset($_GET['context_limit']) ? filter_var($_GET['context_limit'], FILTER_VALIDATE_INT) : null;
    $contextLimit = ContextUsage::resolveLimit($config, $requested, $modelMetadata);
} catch (Throwable $error) {
    contextUsageSend(['success' => false, 'error' => $error->getMessage()]);
}
// Exact request content is captured by the runtime journal. Never substitute a fixed system prompt size.
try {
    require_once __DIR__ . '/Services/AgentRuntimeClient.php';
    $chatId = trim((string)($_GET['client_chat_id'] ?? ('db:' . $conversationId)));
    $query = ['user_context' => (string)$userId, 'client_chat_id' => $chatId, 'conversation_id' => $conversationId,
        'model_id' => $modelMetadata['id'] ?? ($_GET['model_id'] ?? 'deepseek-flash'), 'limit_tokens' => $contextLimit, 'has_history' => '1', 'mode' => 'chat'];
    if ($modelRef !== null) $query['model_ref'] = json_encode($modelRef);
    $statistics = (new AgentRuntimeClient($config['agent_runtime_url']))->request('GET', '/v1/conversation-stats?' . http_build_query($query));
    $context = $statistics['context'] ?? null;
    if ($context === null) contextUsageSend(['success' => true, 'data' => null, 'message' => '尚无实际请求上下文记录']);
    $draft = isset($_GET['draft']) && is_string($_GET['draft']) ? ContextUsage::estimateTokens(mb_substr($_GET['draft'], 0, 200000)) : 0;
    contextUsageSend(['success' => true, 'data' => array_merge($context, ['used_tokens' => $context['used_tokens'] + $draft,
        'limit' => $contextLimit, 'draft_tokens' => $draft, 'history_tokens' => $context['messages_tokens'],
        'system_estimate_tokens' => $context['system_tokens'],
    ])]);
} catch (Throwable $error) {
    contextUsageSend(['success' => false, 'error' => '上下文记录暂不可用']);
}
