<?php

final class AgentRuntimeRequestException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly int $httpStatus,
        public readonly string $remoteCode
    ) {
        parent::__construct($message);
    }
}

final class AgentRuntimeClient
{
    private string $baseUrl;

    public function __construct(string $baseUrl)
    {
        $baseUrl = rtrim(trim($baseUrl), '/');
        if (!preg_match('#^http://(?:127\.0\.0\.1|localhost)(?::\d+)?$#i', $baseUrl)) {
            throw new InvalidArgumentException('Agent Runtime 只允许使用本机 HTTP 地址');
        }
        $this->baseUrl = $baseUrl;
    }

    public function request(string $method, string $path, ?array $payload = null, int $timeout = 20): array
    {
        $curl = curl_init($this->baseUrl . $path);
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        ]);
        if ($payload !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
        $raw = curl_exec($curl);
        $error = curl_error($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        curl_close($curl);
        if ($raw === false || $error !== '') throw new RuntimeException('MoonYa Agent Runtime 不可用: ' . $error);
        $decoded = json_decode($raw, true);
        if ($status < 200 || $status >= 300 || !is_array($decoded)) {
            $remoteCode = is_array($decoded) ? trim((string)($decoded['error'] ?? '')) : '';
            throw new AgentRuntimeRequestException(
                'MoonYa Agent Runtime 请求失败: HTTP ' . $status . ' ' . mb_substr($raw, 0, 500),
                $status,
                $remoteCode
            );
        }
        return $decoded;
    }

    public function streamEvents(string $sessionId, int $after, callable $onEvent, ?callable $onHeartbeat = null): void
    {
        $this->streamPath('/v1/sessions/' . rawurlencode($sessionId) . '/events?after=' . max(0, $after), $onEvent, $onHeartbeat);
    }

    public function streamPath(string $path, callable $onEvent, ?callable $onHeartbeat = null, ?array $payload = null): void
    {
        $buffer = '';
        $curl = curl_init($this->baseUrl . $path);
        curl_setopt_array($curl, [
            CURLOPT_HTTPHEADER => ['Accept: text/event-stream'],
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 0,
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$buffer, $onEvent, $onHeartbeat): int {
                $buffer .= str_replace("\r\n", "\n", $chunk);
                while (($boundary = strpos($buffer, "\n\n")) !== false) {
                    $frame = substr($buffer, 0, $boundary);
                    $buffer = substr($buffer, $boundary + 2);
                    foreach (explode("\n", $frame) as $line) {
                        if (str_starts_with($line, 'data: ')) {
                            $event = json_decode(substr($line, 6), true);
                            if (is_array($event) && $onEvent($event) === false) return 0;
                            continue;
                        }
                        // Runtime 每 15 秒发一次 SSE 注释心跳。默认它在这里被丢弃，
                        // 网关→浏览器方向长时间零流量，确认卡片等待期间（approval
                        // 挂起最长 10 分钟）连接会被中间层当作空闲掐断，客户端
                        // 只能重连。回调让网关把心跳原样转发出去以保活链路。
                        if ($onHeartbeat !== null && str_starts_with($line, ': ')) {
                            $onHeartbeat($line);
                        }
                    }
                }
                return strlen($chunk);
            },
        ]);
        if ($payload !== null) {
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_HTTPHEADER, ['Accept: text/event-stream', 'Content-Type: application/json']);
            curl_setopt($curl, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        }
        curl_exec($curl);
        $errorNumber = curl_errno($curl);
        $error = curl_error($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
        curl_close($curl);
        // 终止本轮流是正常控制流（$onEvent 返回 false → 写函数返回 0）。
        // 此时 curl 以 CURLE_WRITE_ERROR 结束，错误文案随 libcurl 版本变化
        // （8.x 'Failure writing output to destination'、更早 'Failed writing body'）。
        // 按错误码判定，不能再依赖文案匹配；否则每次正常结束都会被当成流中断。
        if ($errorNumber === CURLE_WRITE_ERROR) {
            return;
        }
        if ($error !== '') {
            throw new RuntimeException('Agent Runtime 事件流中断: ' . $error);
        }
        if ($status >= 400) throw new RuntimeException('Agent Runtime 请求失败: HTTP ' . $status);
    }
}
