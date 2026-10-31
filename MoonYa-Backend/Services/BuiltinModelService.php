<?php
declare(strict_types=1);
require_once __DIR__ . '/MembershipService.php';
require_once __DIR__ . '/BuiltinReasoning.php';
require_once __DIR__ . '/BuiltinProtocol.php';

final class BuiltinModelService {
    public function __construct(private PDO $db, private array $config = []) {}
    public function list(bool $admin = false): array {
        $rows = $this->db->query('SELECT * FROM builtin_models ' . ($admin ? '' : 'WHERE enabled=1 AND archived=0 ') . 'ORDER BY is_default DESC,sort_order,id')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(function ($row) use ($admin) {
            $public = ['id' => $row['id'], 'label' => $row['label'], 'multiplier' => MembershipService::points((int)$row['multiplier_units']),
                'capabilities' => BuiltinReasoning::defaults(json_decode($row['capabilities_json'], true, 32, JSON_THROW_ON_ERROR)),
                'enabled' => (bool)$row['enabled'], 'archived' => (bool)$row['archived'], 'is_default' => (bool)$row['is_default'], 'sort_order' => (int)$row['sort_order']];
            if ($admin) $public += ['upstream_model' => $row['upstream_model'], 'endpoint' => $row['endpoint'], 'has_api_key' => $row['api_key'] !== ''];
            return $public;
        }, $rows);
    }
    public function resolve(string $id): array {
        $statement = $this->db->prepare('SELECT * FROM builtin_models WHERE id=? AND enabled=1 AND archived=0'); $statement->execute([$id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new InvalidArgumentException('内置模型不存在或已停用');
        $row['capabilities'] = BuiltinReasoning::defaults(json_decode($row['capabilities_json'], true, 32, JSON_THROW_ON_ERROR));
        // Seed references the existing server environment instead of copying its credential into SQL.
        $row['api_key'] = $row['api_key'] === '@env:DEEPSEEK_API_KEY' ? (string)($this->config['deepseek_api_key'] ?? '') : $row['api_key'];
        if ($row['api_key'] === '') throw new RuntimeException('内置模型密钥尚未配置');
        return $row;
    }
    public static function capabilities(array $input): array {
        $context = filter_var($input['context_window'] ?? null, FILTER_VALIDATE_INT);
        $output = filter_var($input['max_output_tokens'] ?? null, FILTER_VALIDATE_INT);
        if (!$context || !$output || $context < 1024 || $context > 100000000 || $output < 1 || $output > $context) throw new InvalidArgumentException('上下文／输出上限无效');
        $reasoning = $input['reasoning'] ?? '';
        if (!in_array($reasoning, ['', 'deepseek', 'openai', 'kimi', 'glm', 'minimax', 'always', 'gemini'], true)) throw new InvalidArgumentException('思考参数格式无效');
        $protocol = $input['protocol'] ?? 'openai-completions';
        if (!in_array($protocol, ['openai-completions','openai-responses'], true) || ($protocol === 'openai-responses' && !empty($input['supports_thinking']) && $reasoning !== 'openai')) throw new InvalidArgumentException('模型协议与思考参数不兼容');
        $levels = $input['efforts'] ?? [];
        if (!is_array($levels) || !array_is_list($levels) || array_diff($levels, ['low','medium','high','xhigh','max','ultra'])) throw new InvalidArgumentException('思考强度无效');
        $levels = array_values(array_intersect(BuiltinReasoning::LEVELS, $levels));
        $default = $input['default_effort'] ?? (in_array('high', $levels, true) ? 'high' : ($levels ? end($levels) : 'auto'));
        if ($levels ? !in_array($default, $levels, true) : $default !== 'auto') throw new InvalidArgumentException('默认思考强度必须属于已勾选档位');
        $labels = $input['effort_labels'] ?? [];
        if (!is_array($labels) || array_diff(array_keys($labels), BuiltinReasoning::LEVELS)) throw new InvalidArgumentException('思考档位显示名称无效');
        $cleanLabels = [];
        foreach ($labels as $level => $label) {
            if (!is_string($label) || mb_strlen($label) > 64 || preg_match('/[\x00-\x1F\x7F]/u', $label)) throw new InvalidArgumentException('档位名称须为不超过64字的单行文本');
            if (in_array($level, $levels, true) && trim($label) !== '') $cleanLabels[$level] = trim($label);
        }
        $choices=$input['context_window_options']??[$context];
        if (!is_array($choices) || !array_is_list($choices) || count($choices)>20) throw new InvalidArgumentException('上下文档位无效');
        foreach ($choices as $choice) if (!is_int($choice)||$choice<1||$choice>$context) throw new InvalidArgumentException('上下文档位无效');
        if (!empty($input['supports_thinking']) && $reasoning==='') throw new InvalidArgumentException('支持思考的模型必须配置参数格式');
        $required = !empty($input['supports_thinking']) && ($input['reasoning_required'] ?? in_array($reasoning, ['always','gemini'], true));
        return ['protocol' => $protocol, 'provider' => (string)($input['provider'] ?? 'custom'),
            'context_window' => $context, 'max_output_tokens' => $output,
            'context_window_options' => array_values(array_unique([...$choices,$context])),
            'supports_images' => !empty($input['supports_images']), 'supports_tools' => !empty($input['supports_tools']),
            'supports_thinking' => !empty($input['supports_thinking']), 'reasoning' => $reasoning, 'efforts' => array_values($levels),
            'reasoning_required' => (bool)$required, 'allow_thinking_off' => !$required && ($input['allow_thinking_off'] ?? true),
            'effort_labels' => (object)$cleanLabels, 'default_effort' => $default,
            'supports_stream_usage' => true, 'supports_tool_choice' => $input['supports_tool_choice'] ?? true];
    }
    public function save(array $input): void {
        $id = trim((string)($input['id'] ?? '')); $label = trim((string)($input['label'] ?? ''));
        $upstream = trim((string)($input['upstream_model'] ?? '')); $endpoint = trim((string)($input['endpoint'] ?? ''));
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,127}$/', $id) || in_array($id, ['__proto__','constructor','prototype'], true) || $label === '' || mb_strlen($label) > 128 || $upstream === '' || strlen($upstream) > 128)
            throw new InvalidArgumentException('模型标识或名称无效');
        $url = parse_url($endpoint);
        if (!$url || !in_array($url['scheme'] ?? '', ['https','http'], true) || empty($url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['fragment']) || strlen($endpoint) > 2048) throw new InvalidArgumentException('模型服务地址无效');
        $multiplier = MembershipService::units($input['multiplier'] ?? '');
        if ($multiplier < 0 || $multiplier > MembershipService::units('1000')) throw new InvalidArgumentException('倍率必须大于或等于 0 且不超过 1000');
        $caps = self::capabilities($input['capabilities'] ?? []);
        $endpoint = BuiltinProtocol::endpoint($endpoint, $caps['protocol']);
        $this->db->beginTransaction();
        try {
            // Serialize catalog changes, including first default assignment.
            $this->db->query('SELECT id FROM membership_plans WHERE is_free=1 FOR UPDATE')->fetchAll();
            $statement = $this->db->prepare('SELECT * FROM builtin_models WHERE id=? FOR UPDATE'); $statement->execute([$id]); $old = $statement->fetch(PDO::FETCH_ASSOC);
            if ($old && $old['archived']) throw new InvalidArgumentException('已删除模型不能编辑，请使用新的模型标识');
            $key = trim((string)($input['api_key'] ?? '')); if ($key === '') $key = $old['api_key'] ?? '';
            if ($key === '' || strlen($key) > 16000 || ($key[0] === '@' && $key !== '@env:DEEPSEEK_API_KEY')) throw new InvalidArgumentException('请填写模型密钥');
            $enabled = !empty($input['enabled']); $default = !empty($input['is_default']);
            if ($default && !$enabled) throw new InvalidArgumentException('默认模型必须启用');
            if ($default) $this->db->exec('UPDATE builtin_models SET is_default=0');
            $sql = 'INSERT INTO builtin_models (id,label,upstream_model,endpoint,api_key,capabilities_json,multiplier_units,enabled,is_default,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),upstream_model=VALUES(upstream_model),endpoint=VALUES(endpoint),api_key=VALUES(api_key),capabilities_json=VALUES(capabilities_json),multiplier_units=VALUES(multiplier_units),enabled=VALUES(enabled),is_default=VALUES(is_default),sort_order=VALUES(sort_order)';
            $statement = $this->db->prepare($sql); $statement->execute([$id,$label,$upstream,$endpoint,$key,json_encode($caps,JSON_UNESCAPED_UNICODE),$multiplier,(int)$enabled,(int)$default,(int)($input['sort_order'] ?? 0)]);
            $this->ensureDefault(); $this->db->commit();
        } catch (Throwable $error) { $this->db->rollBack(); throw $error; }
    }
    private function ensureDefault(): void {
        $this->db->exec('UPDATE builtin_models SET is_default=0 WHERE enabled=0 OR archived=1');
        if (!$this->db->query('SELECT id FROM builtin_models WHERE is_default=1 AND enabled=1 AND archived=0 LIMIT 1')->fetchColumn()) {
            $id = $this->db->query('SELECT id FROM builtin_models WHERE enabled=1 AND archived=0 ORDER BY sort_order,id LIMIT 1')->fetchColumn();
            if ($id) { $q=$this->db->prepare('UPDATE builtin_models SET is_default=1 WHERE id=?'); $q->execute([$id]); }
        }
    }
    public function delete(string $id): void {
        $this->db->beginTransaction();
        try {
            $this->db->query('SELECT id FROM membership_plans WHERE is_free=1 FOR UPDATE')->fetchAll();
            $q=$this->db->prepare('UPDATE builtin_models SET enabled=0,archived=1,is_default=0 WHERE id=?'); $q->execute([$id]);
            $this->ensureDefault(); $this->db->commit();
        } catch (Throwable $error) { $this->db->rollBack(); throw $error; }
    }
    public function testConnection(array $input): array {
        require_once __DIR__ . '/BuiltinBilling.php';
        $endpoint = trim((string)($input['endpoint'] ?? ''));
        $upstream = trim((string)($input['upstream_model'] ?? '')) ?: 'gpt-4o';
        $key = trim((string)($input['api_key'] ?? ''));
        $id = trim((string)($input['id'] ?? ''));
        if ($key === '' && $id !== '') {
            $stmt = $this->db->prepare('SELECT api_key FROM builtin_models WHERE id=?');
            $stmt->execute([$id]);
            $key = (string)($stmt->fetchColumn() ?: '');
        }
        if ($key === '@env:DEEPSEEK_API_KEY') {
            $key = (string)($this->config['deepseek_api_key'] ?? '');
        }
        if ($endpoint === '' || !preg_match('/^https?:\/\//i', $endpoint)) {
            throw new InvalidArgumentException('接口地址无效，请填写正确的 http:// 或 https:// 协议地址');
        }
        if ($key === '') {
            throw new InvalidArgumentException('请填写 API Key 后再进行连接测试');
        }

        $caps = self::capabilities($input['capabilities'] ?? ['context_window'=>8192,'max_output_tokens'=>4096]);
        $endpoint = BuiltinProtocol::endpoint($endpoint, $caps['protocol']);
        $request = [
            'model' => $upstream,
            'messages' => [['role' => 'user', 'content' => 'hi']],
            'max_tokens' => min(4096, $caps['max_output_tokens']),
            'thinking' => ['type' => $caps['supports_thinking'] ? 'enabled' : 'disabled'],
        ];
        if ($caps['efforts']) $request['reasoning_effort'] = $caps['default_effort'];
        $payload = json_encode(BuiltinBilling::payload($request, ['capabilities'=>$caps,'upstream_model'=>$upstream]), JSON_UNESCAPED_UNICODE);

        $ch = curl_init($endpoint);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $key
            ],
            CURLOPT_TIMEOUT => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2
        ]);
        $response = curl_exec($ch);
        $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = curl_error($ch);
        curl_close($ch);

        if ($curlErr) {
            throw new RuntimeException('网络连接超时或无法访问: ' . $curlErr);
        }
        if ($httpCode >= 200 && $httpCode < 300) {
            $json = json_decode((string)$response, true);
            if (!is_array($json) || isset($json['error'])) throw new RuntimeException('供应商返回内容格式无效');
            $completion = BuiltinProtocol::completion($json, $caps['protocol']);
            if (!isset($completion['choices'][0]['message']) || isset($completion['error'])) throw new RuntimeException('供应商返回内容无效或响应未完成');
            $hasReasoning = !empty($completion['choices'][0]['message']['reasoning_content']);
            return ['ok' => true, 'has_reasoning' => $hasReasoning, 'message' => '连接成功 (HTTP ' . $httpCode . ')' . ($caps['supports_thinking'] ? ($hasReasoning ? '，已收到思考摘要' : '，本次未返回思考摘要') : '')];
        }

        $detail = '';
        if ($response) {
            $json = json_decode((string)$response, true);
            if (isset($json['error']['message'])) {
                $detail = (string)$json['error']['message'];
            } elseif (isset($json['message'])) {
                $detail = (string)$json['message'];
            } else {
                $detail = mb_substr(strip_tags((string)$response), 0, 150);
            }
        }
        $detail = str_replace($key, '[密钥已隐藏]', $detail);
        throw new RuntimeException('供应商返回错误 (HTTP ' . $httpCode . ($detail ? ': ' . $detail : '') . ')');
    }
}
