<?php
declare(strict_types=1);
require_once __DIR__ . '/AgentRuntimeClient.php';
require_once __DIR__ . '/ContextUsage.php';
require_once __DIR__ . '/BuiltinBilling.php';

/** Collects only actual PHP model requests; raw responses and credentials never enter the journal. */
final class MoonYaStatistics
{
    private static ?array $scope = null;
    private static array $calls = [];
    public static ?array $latestContext = null;
    public static function configure(array $config, array $data, int $userId): void
    {
        $chatId = (string)($data['client_chat_id'] ?? (isset($data['conversation_id']) ? 'db:' . $data['conversation_id'] : ''));
        if ($chatId === '' || $userId < 1) return;
        self::$scope = ['user_context' => (string)$userId,
            'client_chat_id' => $chatId, 'conversation_id' => $data['conversation_id'] ?? null,
            'has_history' => !empty($data['statistics_has_history']),
            'model_id' => $data['deepseekModelVersion'] ?? 'deepseek-flash', 'limit' => $data['context_limit'] ?? null];
    }
    private static function publish(array $record, bool $hasHistory): ?array
    {
        if (self::$scope === null) return null;
        // Presentation records travel with the authenticated response. The desktop journals them locally.
        echo 'data: ' . json_encode(['type' => 'statistics_record', 'data' => [
            'client_chat_id' => self::$scope['client_chat_id'], 'conversation_id' => self::$scope['conversation_id'],
            'has_history' => $hasHistory, 'record' => $record,
        ]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
        if (function_exists('streamFlush')) streamFlush();
        return null;
    }
    public static function execute($curl, array $request)
    {
        if (self::$scope === null) return BuiltinBilling::execute($curl, $request);
        $key = spl_object_id($curl);
        $id = 'php:' . bin2hex(random_bytes(16));
        $hasHistory = self::$scope['has_history'];
        $base = ['id' => $id, 'kind' => 'model', 'model_id' => self::$scope['model_id'], 'status' => 'running'];
        self::publish($base, $hasHistory);
        self::$calls[$key] = ['start' => hrtime(true), 'first' => null, 'last' => null, 'usage' => null,
            'buffer' => '', 'content' => '', 'reasoning' => '', 'calls' => [], 'ended' => false, 'error' => false, 'stream' => !empty($request['stream'])];
        try { $response = BuiltinBilling::execute($curl, $request, true); }
        finally {
            if (self::$calls[$key]['stream']) self::chunk($curl, "\n");
            $call = self::$calls[$key]; unset(self::$calls[$key]);
            if (isset($response) && is_string($response) && !$call['stream']) {
                $json = json_decode($response, true);
                $call['usage'] = $json['usage'] ?? null;
                $call['error'] = isset($json['error']);
                $call['content'] = $json['choices'][0]['message']['content'] ?? '';
                $call['reasoning'] = $json['choices'][0]['message']['reasoning_content'] ?? '';
            }
            $http = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
            $base['status'] = curl_errno($curl) || $http < 200 || $http >= 300 || $call['error'] || $call['stream'] && !$call['ended'] ? 'failed' : 'completed';
            $base['llm_ms'] = (hrtime(true) - $call['start']) / 1000000;
            $base['ttft_ms'] = $call['first'] !== null ? ($call['first'] - $call['start']) / 1000000 : null;
            $base['decode_ms'] = $call['first'] !== null && $call['last'] !== null ? ($call['last'] - $call['first']) / 1000000 : null;
            $base['usage'] = self::usage($call['usage']);
            $snapshot = self::publish($base, $hasHistory);
            $messages = $request['messages'] ?? [];
            if ($call['content'] !== '' || $call['reasoning'] !== '' || $call['calls']) {
                $messages[] = ['role' => 'assistant', 'content' => $call['content'], 'reasoning_content' => $call['reasoning'], 'tool_calls' => $call['calls']];
            }
            $system = 0; $history = 0;
            foreach ($messages as $message) {
                $tokens = ContextUsage::estimateMessageTokens([$message]);
                if (!empty($message['tool_calls'])) $tokens += ContextUsage::estimateTokens(json_encode($message['tool_calls'], JSON_UNESCAPED_UNICODE));
                if (in_array($message['role'] ?? '', ['system', 'developer'], true)) $system += $tokens; else $history += $tokens;
            }
            $tools = empty($request['tools']) ? 0 : ContextUsage::estimateTokens(json_encode($request['tools'], JSON_UNESCAPED_UNICODE));
            $context = ['kind' => 'context', 'id' => 'context:php:' . self::$scope['model_id'], 'model_id' => self::$scope['model_id'],
                'limit_tokens' => self::$scope['limit'], 'used_tokens' => $system + $history + $tools,
                'system_tokens' => $system, 'tools_tokens' => $tools, 'messages_tokens' => $history];
            self::$latestContext = $context;
            $snapshot = self::publish($context, $hasHistory) ?? $snapshot;
            if ($snapshot !== null) {
                echo 'data: ' . json_encode(['type' => 'session_statistics', 'data' => $snapshot], JSON_UNESCAPED_UNICODE) . "\n\n";
                if (function_exists('streamFlush')) streamFlush();
            }
        }
        BuiltinBilling::finishCall();
        return $response;
    }
    public static function startTool(): ?string
    {
        if (self::$scope === null) return null;
        $id = 'php-tool:' . bin2hex(random_bytes(16));
        self::publish(['kind' => 'tool', 'id' => $id, 'status' => 'running'], self::$scope['has_history']);
        return $id;
    }
    public static function finishTool(?string $id, float $milliseconds, bool $failed = false): void
    {
        if ($id === null || self::$scope === null) return;
        $snapshot = self::publish(['kind' => 'tool', 'id' => $id, 'tool_ms' => max(0, $milliseconds), 'status' => $failed ? 'failed' : 'completed'], self::$scope['has_history']);
        if ($snapshot !== null) {
            echo 'data: ' . json_encode(['type' => 'session_statistics', 'data' => $snapshot], JSON_UNESCAPED_UNICODE) . "\n\n";
            if (function_exists('streamFlush')) streamFlush();
        }
    }
    public static function executeTool($curl)
    {
        $id = self::startTool(); $start = hrtime(true);
        try { return curl_exec($curl); }
        finally { self::finishTool($id, (hrtime(true) - $start) / 1000000, curl_errno($curl) !== 0 || curl_getinfo($curl, CURLINFO_HTTP_CODE) >= 400); }
    }
    public static function chunk($curl, string $chunk): void
    {
        $key = spl_object_id($curl);
        if (!isset(self::$calls[$key])) return;
        $call =& self::$calls[$key]; $call['buffer'] .= $chunk;
        while (($pos = strpos($call['buffer'], "\n")) !== false) {
            $line = trim(substr($call['buffer'], 0, $pos)); $call['buffer'] = substr($call['buffer'], $pos + 1);
            if (!str_starts_with($line, 'data:')) continue;
            if (trim(substr($line, 5)) === '[DONE]') { $call['ended'] = true; continue; }
            $json = json_decode(trim(substr($line, 5)), true);
            if (!is_array($json)) continue;
            if (isset($json['usage'])) $call['usage'] = $json['usage'];
            if (isset($json['error'])) $call['error'] = true;
            $delta = $json['choices'][0]['delta'] ?? [];
            $hasToken = !empty($delta['content']) || !empty($delta['reasoning_content']);
            $call['content'] .= $delta['content'] ?? ''; $call['reasoning'] .= $delta['reasoning_content'] ?? '';
            foreach ($delta['tool_calls'] ?? [] as $part) {
                $index = $part['index'] ?? 0;
                $call['calls'][$index] ??= ['id' => '', 'type' => 'function', 'function' => ['name' => '', 'arguments' => '']];
                if (isset($part['id'])) $call['calls'][$index]['id'] = $part['id'];
                $call['calls'][$index]['function']['name'] .= $part['function']['name'] ?? '';
                $call['calls'][$index]['function']['arguments'] .= $part['function']['arguments'] ?? '';
                $hasToken = $hasToken || !empty($part['function']['arguments']);
            }
            if ($hasToken) { $call['first'] ??= hrtime(true); $call['last'] = hrtime(true); }
            if (!empty($json['choices'][0]['finish_reason'])) { $call['ended'] = true; if ($call['first'] !== null) $call['last'] = hrtime(true); }
        }
    }
    public static function usage(?array $raw): ?array
    {
        if ($raw === null) return null;
        $count = static fn($value) => is_int($value) && $value >= 0 ? $value : null;
        $total = $count($raw['prompt_tokens'] ?? null);
        $read = $count($raw['prompt_cache_hit_tokens'] ?? $raw['prompt_tokens_details']['cached_tokens'] ?? null);
        $write = $count($raw['cache_creation_input_tokens'] ?? 0);
        $input = $count($raw['prompt_cache_miss_tokens'] ?? ($total !== null && $read !== null && $write !== null ? $total - $read - $write : null));
        if ($total === null && $input !== null && $read !== null && $write !== null) $total = $input + $read + $write;
        if ($total !== null && $input !== null && $read !== null && $write !== null && $input + $read + $write !== $total) $input = null;
        return ['total_input' => $total, 'input' => $input, 'cache_read' => $read, 'cache_write' => $write, 'output' => $count($raw['completion_tokens'] ?? null)];
    }
}
