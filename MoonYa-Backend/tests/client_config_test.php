<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/Services/ClientConfig.php';
require_once dirname(__DIR__) . '/Services/DesktopImageInput.php';
$secret = 'never-return-this-server-secret';
$config = [
    'db_pass' => $secret, 'deepseek_api_key' => $secret,
    'ui_model_groups' => ['deepseek' => ['default' => 'deepseek-flash', 'models' => [
        ['id' => 'deepseek-flash', 'label' => 'DeepSeek', 'api_key' => $secret, 'endpoint' => $secret]]]],
    'model_capabilities' => ['deepseek-flash' => ['provider' => 'deepseek', 'context_window' => 100000, 'api_key' => $secret]],
    'voice_config' => ['lang' => 'zh-CN', 'minimax' => ['api_key' => $secret]],
    'aliyun_asr' => ['api_key' => $secret, 'model' => 'fun-asr'],
    'weather' => ['api_token' => $secret], 'horoscope' => ['api_token' => $secret],
];
$public = moonyaClientConfig($config);
if (str_contains(json_encode($public, JSON_THROW_ON_ERROR), $secret)) throw new RuntimeException('Server secret in client configuration');
if ($public['version'] !== 1 || !$public['ptt']['asrEnabled'] || count($public['skills']) !== 2) throw new RuntimeException('Public configuration contract changed');
if (isset($public['modelGroups']['deepseek']['models'][0]['endpoint'])) throw new RuntimeException('Supplier endpoint in public model list');
if ($public['runtime']['pdfWorkerUrl'] !== '/vendor/pdf.worker.min.js') throw new RuntimeException('Remote PDF worker');
$png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
$messages = DesktopImageInput::messages([['role' => 'user', 'content' => [
    ['type' => 'image_url', 'image_url' => ['url' => $png, 'detail' => 'low']]]]], []);
if ($messages[0]['content'][0]['image_url']['url'] !== $png) throw new RuntimeException('Inline image bytes changed');
fwrite(STDOUT, "Public config excludes credentials; image bytes need no desktop path: PASS\n");
