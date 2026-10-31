<?php
declare(strict_types=1);

// Opt-in: sends only the supplied image to the project's configured model.
if (($argv[1] ?? '') !== '--live' || empty($argv[2])) {
    fwrite(STDERR, "Usage: php tests/work_vision_live_smoke.php --live <absolute-image-path>\n");
    exit(2);
}
require_once __DIR__ . '/../Services/WorkImagePaths.php';
require_once __DIR__ . '/../Services/WorkLocalAttachment.php';
$gateway = (string)file_get_contents(__DIR__ . '/../harness_api.php');
$start = strpos($gateway, 'function resolveRuntimeImageDetail(');
$end = strpos($gateway, 'function runtimePdo(', $start);
eval(substr($gateway, $start, $end - $start));
$config = require __DIR__ . '/../config.php';
if (empty($config['deepseek_api_key'])) throw new RuntimeException('Model key is not configured');
$parts = buildRuntimeUserContent(['message' => $argv[2] . '这张图片是什么？请直接描述画面，最多三句话。', 'image_detail' => 'high'], $config, 1);
$payload = [
    'model' => 'deepseek-flash',
    'messages' => [['role' => 'user', 'content' => $parts]],
    'thinking' => ['type' => 'disabled'],
    'max_tokens' => 300,
    'stream' => false,
];
$curl = curl_init($config['deepseek_api_url']);
curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $config['deepseek_api_key']],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 55,
]);
$response = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
$error = curl_error($curl);
curl_close($curl);
if ($response === false || $status !== 200) throw new RuntimeException('Vision request failed: HTTP ' . $status . ' ' . $error);
$data = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
$answer = $data['choices'][0]['message']['content'] ?? '';
if (!is_string($answer) || trim($answer) === '') throw new RuntimeException('Model returned no visual answer');
echo "Real Work image-path wire: HTTP 200\n" . $answer . "\n";
