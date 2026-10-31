<?php
declare(strict_types=1);
require_once __DIR__ . '/../Services/ContextUsage.php';
$testDataRoot = sys_get_temp_dir() . '/moonya-context-test-' . bin2hex(random_bytes(8));
putenv('MOONYA_DATA_ROOT=' . $testDataRoot);
register_shutdown_function(static function () use ($testDataRoot): void {
    foreach (['logs/backend', 'logs', 'temp/php-sessions', 'temp/web-attachments', 'temp/ocr', 'temp/downloads', 'temp', 'downloads', 'crawler_output', ''] as $part) {
        $path = $testDataRoot . ($part === '' ? '' : '/' . $part);
        if (is_dir($path)) rmdir($path);
    }
});
$config = require __DIR__ . '/../config.php';
function check(bool $value, string $message): void {
    if (!$value) throw new RuntimeException($message);
}
check(ContextUsage::resolveLimit($config) === 1048576, '默认采用最大档位');
check(ContextUsage::resolveLimit($config, 300000) === 300000, '内置 300K 档位生效');
check(ContextUsage::resolveLimit($config, 1048576) === 1048576, '内置 1M 档位生效');
check(ContextUsage::resolveLimit($config, 4096, ['context_window' => 8192, 'context_window_options' => [4096,8192]]) === 4096, '模型自定义档位生效');
foreach ([1000000, 1, -1, '300000'] as $requested) {
    try { ContextUsage::resolveLimit($config, $requested); throw new LogicException('非法档位应拒绝'); }
    catch (RuntimeException $error) { check(strpos($error->getMessage(), '上下文档位') !== false, '提供档位错误'); }
}
try {
    ContextUsage::resolveLimit($config, 1000000, ['context_window' => null]);
    throw new LogicException('未知长度应拒绝');
} catch (RuntimeException $error) {
    check(strpos($error->getMessage(), '真实上下文长度') !== false, '应提供配置提示');
}
echo "model context limits passed\n";
