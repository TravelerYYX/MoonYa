<?php
declare(strict_types=1);
require_once __DIR__ . '/AgentRuntimeClient.php';

final class CustomModelChat
{
    public static function metadata(array $config, array $ref): array
    {
        return (new AgentRuntimeClient($config['agent_runtime_url']))->request('POST', '/v1/model-config', ['action' => 'resolve', 'model_ref' => $ref]);
    }
    public static function stream(array $config, array $data, array $messages, array $model): string
    {
        $emit = static function (array $event): void { echo 'data: ' . json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n"; streamFlush(); };
        $failed = false;
        $terminal = 'completed';
        try {
            (new AgentRuntimeClient($config['agent_runtime_url']))->streamPath('/v1/llm/chat', static function (array $event) use ($emit, &$failed, &$terminal): bool {
                if (isset($event['error'])) { $failed = true; $emit(['type' => 'error', 'content' => $event['error']['message'] ?? '模型请求失败']); return false; }
                if (!empty($event['moonya_started'])) $emit(['type' => 'custom_model_seq', 'model_seq' => $event['moonya_seq']]);
                if (!empty($event['moonya_done'])) { $terminal = $event['moonya_status'] ?? 'completed'; return true; }
                if (isset($event['session_statistics'])) { $emit(['type' => 'session_statistics', 'data' => $event['session_statistics']]); return true; }
                if (isset($event['moonya_context'])) { $emit(['type' => 'context_usage'] + $event['moonya_context']); return true; }
                $delta = $event['choices'][0]['delta'] ?? [];
                if (!empty($delta['reasoning_content'])) $emit(['type' => 'thinking', 'content' => $delta['reasoning_content'], 'model_seq' => $event['moonya_seq']]);
                if (!empty($delta['content'])) $emit(['type' => 'content', 'content' => $delta['content'], 'model_seq' => $event['moonya_seq']]);
                return true;
            }, static function (string $heartbeat): void { echo $heartbeat . "\n\n"; streamFlush(); }, [
                'model_ref' => $data['model_ref'], 'messages' => $messages,
                'client_chat_id' => (string)($data['client_chat_id'] ?? $data['conversation_id'] ?? $data['client_message_id'] ?? ''),
                'user_context' => (string)($GLOBALS['conversationTaskUserId'] ?? $GLOBALS['userId'] ?? ''),
                'conversation_id' => (string)($data['conversation_id'] ?? $data['client_message_id'] ?? ''),
                'client_message_id' => (string)($data['client_message_id'] ?? ''),
                'after_seq' => (int)($data['resume']['after_seq'] ?? 0), 'resume' => !empty($data['resume']),
                'reasoning_effort' => $data['reasoningEffort'] ?? 'auto',
                'reasoning_default' => $data['reasoning_default'] ?? 'none',
                'context_limit' => $data['context_limit'] ?? null,
            ]);
        } catch (Throwable $error) { $failed = true; $emit(['type' => 'error', 'content' => $error->getMessage()]); }
        if ($failed) $terminal = 'failed';
        $emit(['type' => 'done', 'failed' => $failed, 'status' => $terminal]);
        return $terminal;
    }
}
