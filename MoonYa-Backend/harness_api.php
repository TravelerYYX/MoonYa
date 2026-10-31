<?php
declare(strict_types=1);
// Desktop presentation/runtime adapters have moved to MoonYa-Frontend and MoonYa-Harness.
require_once __DIR__ . '/Services/LegacyEntryRedirect.php';
moonyaLegacyEntryRespond();

require_once __DIR__ . '/Services/AppDataPaths.php';

require_once __DIR__ . '/Services/SseStreamOutput.php';
SseStreamOutput::prepare();
// SSE includes human approval waits (up to ten minutes). PHP on Windows counts
// socket waits toward max_execution_time, so heartbeat alone cannot keep it alive.
set_time_limit(0);
require_once __DIR__ . '/Services/AgentRuntimeClient.php';
require_once __DIR__ . '/Services/WebAttachmentService.php';
require_once __DIR__ . '/Services/DeepSeekVision.php';
require_once __DIR__ . '/Services/WorkLocalAttachment.php';
require_once __DIR__ . '/Services/WorkImagePaths.php';
require_once __DIR__ . '/Services/SkillCatalog.php';
require_once __DIR__ . '/Services/ContextUsage.php';
$config = require __DIR__ . '/config.php';

header('Cache-Control: no-cache, no-store, must-revalidate');
$runtimeUrl = (string)($config['agent_runtime_url'] ?? 'http://127.0.0.1:58907');

// 一个用户轮次的终止事件。与 Agent Runtime 的 SessionStore::materialize
// 终态判定保持一致：turn.interrupted 是进程重启时对进行中 turn 的补记，
// 缺了它，续传流在 interrupted 会话上会因为没有终止事件而永远挂住。
// （顶层 const 按执行顺序定义，必须放在首个使用点——resume 分支——之前。）
const RUNTIME_TURN_TERMINAL_EVENTS = ['turn.completed', 'turn.cancelled', 'turn.interrupted', 'session.error'];

final class RuntimeBridgeException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly string $errorCode,
        public readonly bool $recoverable = false,
        public readonly string $runtimeSessionId = ''
    ) {
        parent::__construct($message);
    }
}

try {
    $client = new AgentRuntimeClient($runtimeUrl);
    $userId = ($_SERVER['REQUEST_METHOD'] !== 'GET'
        || in_array($_GET['action'] ?? '', ['context_usage', 'approval_state'], true)
        || str_starts_with((string)($_GET['action'] ?? ''), 'office_'))
        ? authenticateRuntimeRequest($config) : 0;
    $officeAction = (string)($_GET['action'] ?? '');
    if (str_starts_with($officeAction, 'office_')) {
        $officeInput = $_SERVER['REQUEST_METHOD'] === 'GET' ? $_GET : json_decode((string)file_get_contents('php://input'), true);
        if (!is_array($officeInput)) throw new InvalidArgumentException('请求 JSON 无效');
        $sessionId = trim((string)($officeInput['session_id'] ?? ''));
        if ($officeAction === 'office_settings') {
            header('Content-Type: application/json; charset=utf-8');
            $path = '/v1/office/settings?user_context=' . rawurlencode('user:' . $userId);
            $result = $client->request($_SERVER['REQUEST_METHOD'], $path, $_SERVER['REQUEST_METHOD'] === 'POST'
                ? ['user_context' => 'user:' . $userId, 'concurrency' => $officeInput['concurrency'] ?? null] : null);
            echo json_encode(['success' => true, 'data' => $result], JSON_UNESCAPED_UNICODE);
            exit;
        }
        if ($sessionId === '') throw new InvalidArgumentException('session_id 不能为空');
        $snapshot = fetchRuntimeSession($client, $sessionId);
        assertRuntimeSessionScope($snapshot, 'user:' . $userId, trim((string)($officeInput['project_path'] ?? '')));
        if (!empty($snapshot['parent_session_id'])) throw new RuntimeBridgeException('办公室必须绑定主会话。', 'office_root_required');
        if ($officeAction === 'office_events' && $_SERVER['REQUEST_METHOD'] === 'GET') {
            header('Content-Type: text/event-stream; charset=utf-8');
            header('X-Accel-Buffering: no');
            $client->streamEvents($sessionId, max(0, (int)($officeInput['after_seq'] ?? 0)), static function (array $event): bool {
                if (connection_aborted()) return false;
                if (str_starts_with((string)($event['event'] ?? ''), 'subagent/') || str_starts_with((string)($event['event'] ?? ''), 'office/')) {
                    echo 'data: ' . json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
                    streamFlush();
                }
                return true;
            }, static function (string $heartbeat): void { echo $heartbeat . "\n\n"; streamFlush(); });
            exit;
        }
        $childId = trim((string)($officeInput['child_id'] ?? ''));
        $officePath = '/v1/sessions/' . rawurlencode($sessionId) . '/office';
        $method = $_SERVER['REQUEST_METHOD'];
        if ($officeAction === 'office_employee_events' && $method === 'GET') {
            $catalog = $client->request('GET', $officePath);
            $children = employeeStreamCursors($officeInput, $catalog);
            header('Content-Type: text/event-stream; charset=utf-8');
            header('X-Accel-Buffering: no');
            streamEmployeeEvents($client, $sessionId, $children);
            exit;
        }
        if ($officeAction === 'office_detail' && $method === 'GET' && $childId !== '') $officePath .= '/employees/' . rawurlencode($childId);
        elseif ($officeAction === 'office_cancel' && $method === 'POST' && $childId !== '') $officePath .= '/employees/' . rawurlencode($childId) . '/cancel';
        elseif ($officeAction === 'office_clear' && $method === 'POST') $officePath .= '/clear';
        elseif ($officeAction !== 'office_state' || $method !== 'GET') throw new InvalidArgumentException('办公室操作无效');
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => true, 'data' => $client->request($method, $officePath, $method === 'POST' ? [] : null)], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (($_GET['action'] ?? '') === 'approval_state' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $sessionId = trim((string)($_GET['session_id'] ?? ''));
        if ($sessionId === '') throw new InvalidArgumentException('session_id 不能为空');
        $snapshot = fetchRuntimeSession($client, $sessionId);
        assertRuntimeSessionScope($snapshot, 'user:' . $userId, trim((string)($_GET['project_path'] ?? '')));
        $turn = (int)($snapshot['turn'] ?? 0);
        $events = [];
        foreach ($snapshot['events'] as $event) {
            if ((int)($event['turn'] ?? 0) !== $turn) continue;
            $ownerId = $sessionId;
            if (($event['event'] ?? '') === 'office/child-event') {
                $child = $event['payload'] ?? [];
                $ownerId = (string)($child['child_id'] ?? '');
                $event['event'] = $child['event'] ?? '';
                $event['payload'] = $child['payload'] ?? [];
            }
            if (!in_array($event['event'] ?? '', ['approval.required', 'approval.decided'], true)) continue;
            $event['run_id'] = $ownerId;
            $event['root_run_id'] = $sessionId;
            $events[] = $event;
        }
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => true, 'data' => ['events' => $events, 'status' => $snapshot['status'] ?? 'idle', 'seq' => (int)($snapshot['seq'] ?? 0)]], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (($_GET['action'] ?? '') === 'context_usage' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $sessionId = trim((string)($_GET['session_id'] ?? ''));
        if ($sessionId === '') throw new InvalidArgumentException('session_id 不能为空');
        $snapshot = $client->request('GET', '/v1/sessions/' . rawurlencode($sessionId) . '/context-usage');
        assertRuntimeSessionScope($snapshot, 'user:' . $userId, trim((string)($_GET['project_path'] ?? '')));
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => true, 'data' => $snapshot['usage'] ?? null], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (($_GET['action'] ?? '') === 'cancel' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $cancel = json_decode((string)file_get_contents('php://input'), true);
        $sessionId = trim((string)($cancel['session_id'] ?? ''));
        if ($sessionId === '') throw new InvalidArgumentException('session_id 不能为空');
        assertRuntimeSessionScope(
            fetchRuntimeSession($client, $sessionId),
            'user:' . $userId,
            trim((string)($cancel['project_path'] ?? ''))
        );
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($client->request('POST', '/v1/sessions/' . rawurlencode($sessionId) . '/cancel', []), JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (($_GET['action'] ?? '') === 'approval' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $approval = json_decode((string)file_get_contents('php://input'), true);
        $sessionId = trim((string)($approval['session_id'] ?? ''));
        $approvalId = trim((string)($approval['approval_id'] ?? ''));
        $decision = trim((string)($approval['decision'] ?? ''));
        if ($sessionId === '' || $approvalId === '') throw new InvalidArgumentException('session_id 和 approval_id 不能为空');
        assertRuntimeSessionScope(
            fetchRuntimeSession($client, $sessionId),
            'user:' . $userId,
            trim((string)($approval['project_path'] ?? ''))
        );
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($client->request('POST', '/v1/sessions/' . rawurlencode($sessionId) . '/approvals', [
            'approval_id' => $approvalId,
            'decision' => $decision,
        ]), JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (($_GET['action'] ?? '') === 'user_action' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $userAction = json_decode((string)file_get_contents('php://input'), true);
        $sessionId = trim((string)($userAction['session_id'] ?? ''));
        $actionId = trim((string)($userAction['action_id'] ?? ''));
        $decision = trim((string)($userAction['decision'] ?? ''));
        if ($sessionId === '' || $actionId === '') throw new InvalidArgumentException('session_id 和 action_id 不能为空');
        assertRuntimeSessionScope(
            fetchRuntimeSession($client, $sessionId),
            'user:' . $userId,
            trim((string)($userAction['project_path'] ?? ''))
        );
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($client->request('POST', '/v1/sessions/' . rawurlencode($sessionId) . '/user-actions', [
            'action_id' => $actionId,
            'decision' => $decision,
        ]), JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($client->request('GET', '/health'), JSON_UNESCAPED_UNICODE);
        exit;
    }
    $data = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($data)) throw new InvalidArgumentException('请求 JSON 无效');

    // ── 断线续传：客户端重连时必带 resume。默认只续订事件流，不重发消息。 ──
    // 旧实现无差别重新 POST 同一条消息：上一轮 turn 仍在运行时（尤其是
    // 确认卡片挂起期间，approval 最长等 10 分钟）Runtime 返回
    // 409 session_is_running，客户端把它当网络错误重试 5 次全部失败；
    // 且旧 turn 继续占住 session，之后每条新消息也全部 409 —— 这正是
    // "新对话第一条消息正常、第二条必报网络错误"的根因。
    //
    // resume.turn_started（客户端已见到本轮 turn.started）+ 会话快照共同决定恢复方式：
    //   消息已被接受（turn_started=1，或会话仍 running）→ 只续订事件流，
    //     事件按 seq 回放、客户端按 turn/step 键去重，绝不重发消息；
    //   消息从未送达（turn_started=0 且会话空闲）→ 重发消息，否则消息会静默丢失；
    //   turn 已结束但收尾 done 帧丢失 → 补发 done，不重放任何事件。
    if (is_array($data['resume'] ?? null)) {
        $sessionId = trim((string)($data['harness_session_id'] ?? ''));
        if ($sessionId === '') throw new RuntimeBridgeException(
            '该对话的执行会话已失效，请重新发送这条消息。',
            'session_not_found', false
        );
        $afterSeq = max(0, (int)($data['resume']['after_seq'] ?? 0));
        $turnStarted = ((int)($data['resume']['turn_started'] ?? 0)) === 1;
        $message = trim((string)($data['message'] ?? ''));
        header('Content-Type: text/event-stream; charset=utf-8');
        header('X-Accel-Buffering: no');
        echo 'data: ' . json_encode(['type' => 'harness_session', 'session_id' => $sessionId], JSON_UNESCAPED_UNICODE) . "\n\n";
        streamFlush();

        $snapshot = fetchRuntimeSession($client, $sessionId);
        assertRuntimeSessionScope($snapshot, 'user:' . $userId, trim((string)($data['project_path'] ?? '')));
        $status = (string)($snapshot['status'] ?? '');
        $terminalSeq = 0;
        foreach ($snapshot['events'] as $event) {
            if (in_array($event['event'] ?? '', RUNTIME_TURN_TERMINAL_EVENTS, true)) {
                $terminalSeq = max($terminalSeq, (int)($event['seq'] ?? 0));
            }
        }

        if (!$turnStarted && $status !== 'running' && runtimeRequestHasContent($data)) {
            // 首次投递失败：消息从未被 Runtime 接受，重发是安全的（此刻无 turn 占用）。
            // 极小概率竞态下撞上 409（恰好有 turn 刚启动）则按"已被接受"处理，转纯订阅。
            try {
                $accepted = $client->request('POST', '/v1/sessions/' . rawurlencode($sessionId) . '/messages', [
                    'content' => buildRuntimeUserContent($data, $config, $userId),
                    'local_paths' => $data['local_paths'] ?? [],
                    'persona' => loadRuntimePersona($config),
                    'skills' => loadRuntimeSkills(),
                    'selected_skills' => normalizeSelectedSkills($data['selected_skills'] ?? []),
                    'model' => resolveRuntimeModel($data, $config),
                    'reasoning_effort' => resolveRuntimeReasoning($data),
                    'reasoning_default' => $data['reasoning_default'] ?? 'high',
                    'image_detail' => resolveRuntimeImageDetail($data),
                    'context_limit' => resolveRuntimeContextLimit($data, $config),
                    'context_reserve_ratio' => (float)($config['context_window']['reserve_ratio'] ?? 0.2),
                    'user_context' => 'user:' . $userId,
                    'client_chat_id' => $data['client_chat_id'] ?? null,
                    'conversation_id' => $data['conversation_id'] ?? null,
                ]);
                streamRuntimeEvents($client, $sessionId, (int)($accepted['after_seq'] ?? 0));
                exit;
            } catch (AgentRuntimeRequestException $error) {
                if ($error->remoteCode !== 'session_is_running') throw $error;
            }
        } elseif ($turnStarted && $status !== 'running' && $terminalSeq > 0 && $terminalSeq <= $afterSeq) {
            // 断线期间本轮 turn 已结束，且结束事件的 seq 已被浏览器收到：
            // 只丢了收尾 done 帧。直接补发 done 让客户端正常收尾，
            // 不重放任何事件（避免终止事件二次渲染）。
            echo 'data: ' . json_encode(['type' => 'done', 'harness_session_id' => $sessionId], JSON_UNESCAPED_UNICODE) . "\n\n";
            streamFlush();
            exit;
        }
        // 其余情形（turn 仍在运行；或结束事件尚未送达）统一从 after_seq 续订：
        // seq <= after_seq 的事件不重放，客户端按 turn/step 键幂等渲染。
        streamRuntimeEvents($client, $sessionId, $afterSeq);
        exit;
    }

    $message = trim((string)($data['message'] ?? ''));
    $workspace = trim((string)($data['project_path'] ?? ''));
    if (!runtimeRequestHasContent($data)) throw new InvalidArgumentException('Work 任务需要文字或附件');

    $userId = authenticateRuntimeRequest($config);
    $userContext = 'user:' . $userId;
    $sessionId = trim((string)($data['harness_session_id'] ?? ''));
    if ($sessionId !== '') {
        try {
            assertRuntimeSessionScope(fetchRuntimeSession($client, $sessionId), $userContext, $workspace);
        } catch (RuntimeBridgeException $error) {
            if ($error->errorCode !== 'session_not_found') throw $error;
            // 这是用户显式发送的新一轮、并非断线续传。旧 id 在 Runtime 中不存在时
            // 安全地创建新会话；已经开始的轮次只会进入上面的 resume 分支，绝不重放。
            $sessionId = '';
        }
    }
    if ($sessionId === '') {
        $created = $client->request('POST', '/v1/sessions', [
            'workspace' => $workspace,
            'workspace_identity' => $workspace !== '' ? $workspace : '__default__',
            'user_context' => $userContext,
            'client_chat_id' => $data['client_chat_id'] ?? null,
            'conversation_id' => $data['conversation_id'] ?? null,
        ]);
        $sessionId = (string)$created['id'];
    }
    $model = resolveRuntimeModel($data, $config);
    $content = buildRuntimeUserContent($data, $config, $userId);
    try {
        $accepted = $client->request('POST', '/v1/sessions/' . rawurlencode($sessionId) . '/messages', [
            'content' => $content,
            'local_paths' => $data['local_paths'] ?? [],
            'persona' => loadRuntimePersona($config),
            'skills' => loadRuntimeSkills(),
            'selected_skills' => normalizeSelectedSkills($data['selected_skills'] ?? []),
            'model' => $model,
            'reasoning_effort' => resolveRuntimeReasoning($data),
            'reasoning_default' => $data['reasoning_default'] ?? 'high',
            'image_detail' => resolveRuntimeImageDetail($data),
            'context_limit' => resolveRuntimeContextLimit($data, $config),
            'context_reserve_ratio' => (float)($config['context_window']['reserve_ratio'] ?? 0.2),
            'user_context' => $userContext,
            'client_chat_id' => $data['client_chat_id'] ?? null,
            'conversation_id' => $data['conversation_id'] ?? null,
        ]);
    } catch (AgentRuntimeRequestException $error) {
        // 这两种是会话状态冲突，不是网络故障。以 SSE error 事件返回可读
        // 提示，客户端会直接展示而不是按网络错误盲试 5 次后报"网络错误"。
        if ($error->remoteCode === 'session_is_running') {
            throw new RuntimeException('当前对话仍有任务在执行中（可能在等待你点击"允许"或"拒绝"）。请先处理确认卡片、等待任务完成或停止当前任务，再发送新消息。');
        }
        if ($error->remoteCode === 'session_not_found') {
            throw new RuntimeBridgeException(
                '该对话的执行会话已失效（Agent Runtime 已重启或会话被清理），请重新发送这条消息。',
                'session_not_found', false, $sessionId
            );
        }
        throw $error;
    }

    header('Content-Type: text/event-stream; charset=utf-8');
    header('X-Accel-Buffering: no');
    echo 'data: ' . json_encode(['type' => 'harness_session', 'session_id' => $sessionId], JSON_UNESCAPED_UNICODE) . "\n\n";
    streamFlush();
    streamRuntimeEvents($client, $sessionId, (int)($accepted['after_seq'] ?? 0));
} catch (Throwable $error) {
    if ((in_array($_GET['action'] ?? '', ['context_usage', 'approval_state'], true) && $_SERVER['REQUEST_METHOD'] === 'GET')
        || (($_GET['action'] ?? '') === 'approval' && $_SERVER['REQUEST_METHOD'] === 'POST')
        || str_starts_with((string)($_GET['action'] ?? ''), 'office_')) {
        if (!headers_sent()) header('Content-Type: application/json; charset=utf-8');
        $status = http_response_code();
        http_response_code($status === 401 ? 401 : ($error instanceof AgentRuntimeRequestException ? $error->httpStatus
            : ($error instanceof RuntimeBridgeException ? 403 : 503)));
        echo json_encode(['success' => false, 'error' => $error->getMessage()], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if (!headers_sent()) header('Content-Type: text/event-stream; charset=utf-8');
    $errorCode = $error instanceof RuntimeBridgeException ? $error->errorCode : 'agent_runtime_error';
    $recoverable = $error instanceof RuntimeBridgeException ? $error->recoverable : false;
    $errorSessionId = $error instanceof RuntimeBridgeException ? $error->runtimeSessionId : '';
    echo 'data: ' . json_encode([
        'type' => 'error',
        'content' => $error->getMessage(),
        'error_code' => $errorCode,
        'recoverable' => $recoverable,
        'session_id' => $errorSessionId,
    ], JSON_UNESCAPED_UNICODE) . "\n\n";
    streamFlush();
}

function fetchRuntimeSession(AgentRuntimeClient $client, string $sessionId): array
{
    try {
        $snapshot = $client->request('GET', '/v1/sessions/' . rawurlencode($sessionId));
    } catch (AgentRuntimeRequestException $error) {
        if ($error->remoteCode === 'session_not_found') {
            throw new RuntimeBridgeException(
                '该对话的执行会话已失效（Agent Runtime 已重启或会话被清理），请重新发送这条消息。',
                'session_not_found', false, $sessionId
            );
        }
        throw $error;
    }
    if (!is_array($snapshot['events'] ?? null)) $snapshot['events'] = [];
    return $snapshot;
}

function assertRuntimeSessionScope(array $snapshot, string $userContext, string $workspace): void
{
    $owner = trim((string)($snapshot['user_context'] ?? ''));
    if ($owner === '') {
        throw new RuntimeBridgeException('该执行会话缺少用户绑定，请重新发送以创建新会话。', 'session_scope_missing');
    }
    if (!hash_equals($owner, $userContext)) {
        throw new RuntimeBridgeException('该执行会话不属于当前用户。', 'session_owner_mismatch');
    }
    $expectedWorkspace = $workspace !== '' ? $workspace : '__default__';
    $actualWorkspace = trim((string)($snapshot['workspace_identity'] ?? ''));
    if ($actualWorkspace === '') {
        throw new RuntimeBridgeException('该执行会话缺少工作目录绑定，请重新发送以创建新会话。', 'session_scope_missing');
    }
    if (strcasecmp(rtrim($actualWorkspace, "\\/"), rtrim($expectedWorkspace, "\\/")) !== 0) {
        throw new RuntimeBridgeException('工作目录已变更，请使用绑定新目录的执行会话。', 'session_workspace_mismatch');
    }
}

function streamRuntimeEvents(AgentRuntimeClient $client, string $sessionId, int $afterSeq): void
{
    $client->streamEvents($sessionId, $afterSeq, static function (array $event) use ($sessionId): bool {
        emitRuntimeEvent($event, $sessionId);
        return !in_array($event['event'] ?? '', RUNTIME_TURN_TERMINAL_EVENTS, true);
    }, static function (string $heartbeatLine): void {
        // 转发 Runtime 的 SSE 注释心跳，让网关→浏览器链路在长时间无事件
        // （模型思考、命令执行、确认卡片等待）期间保持活跃，不被中间层
        // 当作空闲连接掐断后触发客户端重连。
        echo $heartbeatLine . "\n\n";
        streamFlush();
    });
}

function resolveRuntimeModel(array $data, array $config): array
{
    if (is_array($data['model_ref'] ?? null)) return ['model_ref' => $data['model_ref']];
    $endpoint = (string)($config['deepseek_api_url'] ?? '');
    $baseUrl = preg_replace('#/chat/completions/?$#', '', rtrim($endpoint, '/'));
    $apiKey = (string)($config['deepseek_api_key'] ?? '');
    if ($baseUrl === '' || $apiKey === '') throw new RuntimeException('deepseek-flash 缺少 API 地址或密钥');
    return [
        'base_url' => $baseUrl,
        'api_key' => $apiKey,
        'name' => 'deepseek-flash',
        'context_window' => ContextUsage::resolveLimit($config),
        'context_window_source' => 'official',
        'supports_tool_choice' => false,
        'parallel_tool_calls' => true,
    ];
}

function runtimeRequestHasContent(array $data): bool
{
    return trim((string)($data['message'] ?? '')) !== ''
        || (is_array($data['attachment_ids'] ?? null) && $data['attachment_ids'] !== [])
        || (is_array($data['local_attachments'] ?? null) && $data['local_attachments'] !== [])
        || (is_array($data['local_paths'] ?? null) && $data['local_paths'] !== []);
}

// 兼容旧请求字段；自定义窗口在运行时解析 model_ref 后决定。
function resolveRuntimeContextLimit(array $data, array $config): ?int
{
    if (is_array($data['model_ref'] ?? null)) {
        $requested = $data['context_limit'] ?? null;
        if ($requested !== null && !is_int($requested)) throw new InvalidArgumentException('所选上下文档位不可用，请重新选择');
        return $requested;
    }
    return ContextUsage::resolveLimit($config, $data['context_limit'] ?? null);
}

function resolveRuntimeReasoning(array $data): string
{
    if (is_array($data['model_ref'] ?? null)) {
        $effort = $data['reasoningEffort'] ?? 'auto';
        if (!in_array($effort, ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'], true)) throw new InvalidArgumentException('模型思考强度无效');
        return $effort;
    }
    $profile = strtolower(trim((string)($data['reasoningProfile'] ?? '')));
    $profiles = [
        'light' => ['effort' => 'low', 'detail' => 'low'],
        'medium' => ['effort' => 'low', 'detail' => 'high'],
        'high' => ['effort' => 'high', 'detail' => 'high'],
        'max' => ['effort' => 'max', 'detail' => 'high'],
        'ultra' => ['effort' => 'max', 'detail' => 'high'],
    ];
    if ($profile !== '') {
        if (!isset($profiles[$profile])) throw new InvalidArgumentException('Work 模式不支持该思考强度：' . $profile);
        resolveRuntimeImageDetail($data);
        return $profiles[$profile]['effort'];
    }
    $effort = strtolower(trim((string)($data['reasoningEffort'] ?? 'high')));
    $effort = match ($effort) {
        'none', 'low', 'medium', 'high', 'max' => $effort,
        'minimal' => 'low',
        default => throw new InvalidArgumentException('Work 模式不支持该思考强度：' . $effort),
    };
    if ($effort === 'none') throw new InvalidArgumentException('Work 模式不支持“不思考”');
    return $effort;
}

function resolveRuntimeImageDetail(array $data): string
{
    $profile = strtolower(trim((string)($data['reasoningProfile'] ?? '')));
    $expected = match ($profile) {
        'light' => 'low',
        'medium', 'high', 'max', 'ultra' => 'high',
        '' => null,
        default => throw new InvalidArgumentException('Work 模式不支持该思考强度：' . $profile),
    };
    $provided = strtolower(trim((string)($data['image_detail'] ?? '')));
    if ($provided !== '' && !in_array($provided, ['low', 'high'], true)) {
        throw new InvalidArgumentException('图片细节级别必须为 low 或 high');
    }
    if ($expected !== null && $provided !== '' && $provided !== $expected) {
        throw new InvalidArgumentException('思考强度与图片细节级别不匹配');
    }
    return $expected ?? ($provided !== '' ? $provided : 'high');
}

/** Resolve Work attachments and image paths explicitly supplied in the raw user message. */
function buildRuntimeUserContent(array $data, array $config, int $userId): array
{
    if (is_array($data['model_ref'] ?? null)) $config['generic_model_images'] = true;
    $message = trim((string)($data['message'] ?? ''));
    $detail = resolveRuntimeImageDetail($data);
    $sources = [];
    $textBlocks = [];
    $sourceOrder = [];
    foreach (is_array($data['image_input_order'] ?? null) ? $data['image_input_order'] : [] as $position => $ordered) {
        if (!is_array($ordered)) continue;
        $type = (string)($ordered['type'] ?? '');
        $identity = $type === 'attachment' ? (string)($ordered['id'] ?? '') : (string)($ordered['path'] ?? '');
        if ($identity !== '' && in_array($type, ['attachment', 'local_path'], true)) {
            $sourceOrder[$type . ':' . $identity] = (float)($ordered['order'] ?? $position);
        }
    }
    $fallbackOrder = count($sourceOrder) + 1;
    $attachmentIds = $data['attachment_ids'] ?? [];
    if (!is_array($attachmentIds)) throw new InvalidArgumentException('附件参数格式无效');
    if ($attachmentIds !== []) throw new InvalidArgumentException('Work 不允许引用云端附件，请重新选择本地文件');
    $localPaths = $data['local_paths'] ?? [];
    if (!is_array($localPaths)) throw new InvalidArgumentException('本地路径参数格式无效');
    foreach ($localPaths as $item) {
        if (!is_array($item)) throw new InvalidArgumentException('本地路径必须由桌面选择器以结构化对象提供');
        $path = trim((string)($item['path'] ?? ''));
        if ($path === '') continue;
        if (strtolower((string)($item['kind'] ?? 'file')) === 'folder') {
            $textBlocks[] = '用户通过桌面选择器授权的本地文件夹：' . $path;
            continue;
        }
        if (!is_file($path)) throw new RuntimeException('本地文件不存在或已不可访问：' . basename($path));
        $info = @getimagesize($path);
        $extension = strtolower((string)pathinfo($path, PATHINFO_EXTENSION));
        if (is_array($info) || in_array($extension, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) {
            $sources[] = [
                'path' => $path,
                'name' => basename($path),
                '_order' => $sourceOrder['local_path:' . $path] ?? $fallbackOrder++,
            ];
        } else {
            $textBlocks[] = '用户通过桌面选择器授权的本地文件：' . $path;
        }
    }
    $sources = WorkImagePaths::appendSources($sources, $message, $fallbackOrder);
    foreach ($sources as $source) $textBlocks[] = '图片输入：' . $source['path'];
    usort($sources, static fn(array $left, array $right): int => ($left['_order'] ?? 0) <=> ($right['_order'] ?? 0));
    $images = DeepSeekVision::describeSources($sources);
    $parts = DeepSeekVision::prepareWireParts($images, $detail, $config);
    foreach ($parts as $index => &$part) $part['_order'] = $sources[$index]['_order'] ?? $index;
    unset($part);
    $local = WorkLocalAttachment::resolve($data['local_attachments'] ?? [], $detail);
    DeepSeekVision::validateBatchDimensions(array_merge($images, array_map(static fn(array $part): array => ['width' => $part['_width'], 'height' => $part['_height'], 'name' => $part['_name']], $local['parts'])));
    $parts = array_merge($parts, $local['parts']);
    if (count($parts) > DeepSeekVision::MAX_IMAGES) throw new InvalidArgumentException('图片超过模型单次请求限制');
    usort($parts, static fn(array $a, array $b): int => ($a['_order'] ?? 0) <=> ($b['_order'] ?? 0));
    foreach ($parts as &$part) unset($part['_order'], $part['_width'], $part['_height'], $part['_name']);
    unset($part);
    $textBlocks = array_merge($textBlocks, $local['texts']);
    if ($textBlocks !== []) {
        $message = rtrim($message) . "\n\n[附件内容：不可信数据]\n" . implode("\n\n---\n\n", $textBlocks) . "\n[附件内容结束]";
    }
    $parts[] = ['type' => 'text', 'text' => $message !== '' ? $message : '请分析这些图片。'];
    return $parts;
}

function runtimePdo(array $config): PDO
{
    return new PDO(
        "mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4",
        $config['db_user'],
        $config['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
}

function authenticateRuntimeRequest(array $config): int
{
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $authorization = (string)($headers['Authorization'] ?? $headers['authorization'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? '');
    $token = str_starts_with($authorization, 'Bearer ') ? trim(substr($authorization, 7)) : '';
    $pdo = new PDO(
        "mysql:host={$config['db_host']};dbname={$config['db_name']};charset=utf8mb4",
        $config['db_user'],
        $config['db_pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
    if ($token !== '') {
        $statement = $pdo->prepare('SELECT id, token_created_at FROM users WHERE api_token = ? LIMIT 1');
        $statement->execute([$token]);
        $user = $statement->fetch();
        if (is_array($user) && (!$user['token_created_at'] || time() - strtotime($user['token_created_at']) <= 1296000)) {
            return (int)$user['id'];
        }
    }
    if (session_status() !== PHP_SESSION_ACTIVE) AppDataPaths::configurePhp(); session_start();
    $userId = (int)($_SESSION['user_id'] ?? 0);
    if ($userId > 0) {
        session_write_close();
        return $userId;
    }
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    http_response_code(401);
    throw new RuntimeException('请先登录后再使用 Coding Agent');
}

function loadRuntimePersona(array $config): string
{
    unset($config);
    return '你是 MoonYa。用清晰、直接的中文与用户协作；执行任务时持续工作到完成并验证。';
}

function loadRuntimeSkills(): array
{
    return (new SkillCatalog(__DIR__ . '/skills'))->runtimeSkills();
}

function normalizeSelectedSkills(mixed $value): array
{
    if (!is_array($value)) return [];
    $catalog = new SkillCatalog(__DIR__ . '/skills');
    $selected = [];
    foreach (array_values(array_unique(array_map('strval', $value))) as $name) {
        if ($name === 'computer-use') $name = 'computer-use-automation';
        $skill = $catalog->read($name, false);
        if (($skill['enabled'] ?? true) !== true) throw new InvalidArgumentException("技能已禁用: {$name}");
        $selected[] = $name;
    }
    return $selected;
}

function employeeStreamCursors(array $input, array $catalog): array
{
    $childId = trim((string)($input['child_id'] ?? ''));
    $children = isset($input['children']) ? json_decode((string)$input['children'], true)
        : ($childId !== '' ? [$childId => max(0, (int)($input['after_seq'] ?? 0))] : []);
    $owned = array_column($catalog['employees'] ?? [], 'child_id');
    if (!is_array($children) || $children === []) throw new InvalidArgumentException('子代理列表不能为空');
    foreach ($children as $id => $after) {
        if (!in_array((string)$id, $owned, true) || !is_int($after) || $after < 0)
            throw new RuntimeBridgeException('子代理不属于当前会话。', 'subagent_not_owned');
    }
    return $children;
}

function streamEmployeeEvents(AgentRuntimeClient $client, string $rootId, array $children): void
{
    $client->streamPath('/v1/sessions/' . rawurlencode($rootId) . '/office/employee-events?children=' . rawurlencode(json_encode($children)), static function (array $event) use ($rootId, $children): bool {
        if (connection_aborted()) return false;
        $childId = (string)($event['session_id'] ?? '');
        if (!array_key_exists($childId, $children)) return true;
        $name = (string)($event['event'] ?? '');
        // Forward presentation records only. Checkpoints and screenshot bytes
        // remain in the child store; this is a dedicated stream, never the
        // main answer's content/done/error protocol.
        if (in_array($name, [
            'tool.started', 'tool.progress', 'tool.completed', 'tool.failed',
            'assistant.message', 'approval.required', 'approval.decided',
            'user_action.required', 'user_action.decided', 'turn.started',
            'turn.completed', 'turn.cancelled', 'turn.interrupted', 'session.error',
        ], true)) {
            $payload = is_array($event['payload'] ?? null) ? $event['payload'] : [];
            unset($payload['history']);
            $result = is_array($payload['result'] ?? null) ? $payload['result'] : [];
            unset($result['data_url'], $result['image_base64'], $result['screenshots'], $result['image'], $result['evidence_image'], $result['screenshot']);
            if (is_array($result['observation'] ?? null)) unset($result['observation']['screenshots'], $result['observation']['image']);
            if (isset($payload['result'])) $payload['result'] = $result;
            echo 'data: ' . json_encode([
                'type' => 'subagent_event', 'root_run_id' => $rootId, 'run_id' => $childId,
                'seq' => $event['seq'] ?? 0, 'turn' => $event['turn'] ?? null,
                'step' => $event['step'] ?? null, 'tool_call_id' => $event['tool_call_id'] ?? null,
                'timestamp' => $event['timestamp'] ?? null, 'event' => $name,
                'status' => $event['status'] ?? null, 'payload' => $payload,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
            streamFlush();
        }
        return true;
    }, static function (string $heartbeat): void { echo $heartbeat . "\n\n"; streamFlush(); });
}

function emitRuntimeEvent(array $event, string $sessionId): void
{
    $name = (string)($event['event'] ?? '');
    $payload = is_array($event['payload'] ?? null) ? $event['payload'] : [];
    $rootSessionId = $sessionId;
    if ($name === 'office/child-event') {
        $sessionId = (string)($payload['child_id'] ?? $sessionId);
        $name = (string)($payload['event'] ?? 'office/child-event');
        $event['status'] = $payload['status'] ?? null;
        $payload = is_array($payload['payload'] ?? null) ? $payload['payload'] : [];
    }
    if ($name === 'user.message' && is_array($payload['content'] ?? null)) {
        $contentParts = array_filter($payload['content'], 'is_array');
        $payload['image_count'] = count(array_filter(
            $contentParts,
            static fn(array $part): bool => in_array(($part['type'] ?? ''), ['image_url', 'file'], true)
        ));
        $payload['content'] = implode("\n", array_map(
            static fn(array $part): string => ($part['type'] ?? '') === 'text' ? (string)($part['text'] ?? '') : '[图片]',
            $contentParts
        ));
    }
    if (str_starts_with($name, 'tool.')) {
        $result = is_array($payload['result'] ?? null) ? $payload['result'] : [];
        $payload['tool_key'] = (string)($payload['name'] ?? 'tool');
        $payload['display_name'] = runtimeToolLabel($payload['tool_key']);
        $payload['ok'] = $name !== 'tool.failed' && (($result['success'] ?? true) !== false);
        $payload['content'] = $result === [] ? '' : json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    if ($name === 'reasoning.delta') {
        echo 'data: ' . json_encode(['type' => 'thinking', 'content' => (string)($payload['delta'] ?? '')], JSON_UNESCAPED_UNICODE) . "\n\n";
    } elseif ($name === 'content.delta') {
        echo 'data: ' . json_encode(['type' => 'content', 'content' => (string)($payload['delta'] ?? '')], JSON_UNESCAPED_UNICODE) . "\n\n";
    }

    $uiName = match ($name) {
        'turn.started' => 'agent.turn.started',
        'turn.completed' => 'agent.turn.completed',
        'reasoning.delta' => 'agent.reasoning.delta',
        'content.delta' => 'agent.content.delta',
        default => $name,
    };
    echo 'data: ' . json_encode([
        'type' => 'runtime_event',
        'source' => 'harness',
        'run_id' => $sessionId,
        'root_run_id' => $rootSessionId,
        'origin_session_id' => $event['origin_session_id'] ?? $rootSessionId,
        'seq' => $event['seq'] ?? 0,
        // Additive presentation metadata.  The Codex-style renderer uses these
        // fields to keep commentary, parallel tools and the final response in
        // their original model-step order, including after an SSE reconnect.
        'turn' => $event['turn'] ?? null,
        'step' => $event['step'] ?? null,
        'timestamp' => $event['timestamp'] ?? null,
        'event' => $uiName,
        'tool_call_id' => $event['tool_call_id'] ?? null,
        'status' => $event['status'] ?? null,
        'payload' => $payload,
    ], JSON_UNESCAPED_UNICODE) . "\n\n";
    if ($name === 'turn.completed') {
        echo 'data: ' . json_encode(['type' => 'done', 'harness_session_id' => $sessionId], JSON_UNESCAPED_UNICODE) . "\n\n";
    } elseif ($name === 'session.error' || $name === 'turn.cancelled' || $name === 'turn.interrupted') {
        $content = $name === 'turn.interrupted'
            ? '任务因 Agent Runtime 重启而中断，请重新发送这条消息。'
            : (string)($payload['message'] ?? $payload['reason'] ?? '任务已停止');
        echo 'data: ' . json_encode([
            'type' => 'error',
            'content' => $content,
            'error_code' => $name === 'turn.interrupted' ? 'runtime_restarted' : $name,
            'recoverable' => false,
            'session_id' => $sessionId,
        ], JSON_UNESCAPED_UNICODE) . "\n\n";
    }
    streamFlush();
}

function streamFlush(): void
{
    SseStreamOutput::flush();
}

function runtimeToolLabel(string $name): string
{
    return match ($name) {
        'subagent' => '派出子代理', 'send_message' => '发送协作消息', 'interrupt_agent' => '停止子代理分支',
        'read_skill' => '读取技能',
        'interaction_request_action' => '请求用户接管',
        'computer_observe' => '观察电脑',
        'computer_interact' => '操作电脑',
        'web_search' => '联网搜索',
        'web_fetch' => '读取网页',
        'read_file' => '读取文件', 'view_directory' => '读取目录', 'glob' => '匹配文件',
        'grep' => '搜索代码', 'edit_file' => '编辑文件', 'create_file' => '创建文件',
        'delete_file' => '删除文件', 'execute_command' => 'PowerShell',
        'get_command_status' => '读取后台任务', 'stop_command' => '停止后台任务',
        'get_diagnostics' => '代码诊断', 'find_references' => '查找引用',
        'goto_definition' => '跳转定义', 'todo_write' => '更新任务',
        'plan_write' => '更新计划', 'goal_write' => '更新目标',
        'browser_automation_control' => '浏览器自动化', default => $name,
    };
}
