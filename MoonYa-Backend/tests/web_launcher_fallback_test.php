<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/Services/LauncherAccessPolicy.php';

function launcherFallbackAssert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$root = dirname(__DIR__);
$client = (string)file_get_contents(
    $root . '/script/MoonYa-index/modules/script-1e-rest.php'
);
$api = (string)file_get_contents($root . '/api.php');

launcherFallbackAssert(
    LauncherAccessPolicy::isAvailable(['launcher_available' => true]),
    'Launcher requests are incorrectly treated as web requests'
);
launcherFallbackAssert(
    !LauncherAccessPolicy::isAvailable(['launcher_available' => false]),
    'Web requests are incorrectly allowed to invoke local tools'
);
launcherFallbackAssert(
    LauncherAccessPolicy::isAvailable([]),
    'Legacy clients lost backward compatibility'
);

$result = LauncherAccessPolicy::unavailableToolResult();
launcherFallbackAssert(
    ($result['success'] ?? true) === false
        && ($result['error_code'] ?? '') === 'moonya_launcher_required'
        && ($result['requires_launcher'] ?? false) === true
        && str_contains((string)($result['message'] ?? ''), '请使用 MoonYa 启动器'),
    'Web tool fallback does not tell the user to use the MoonYa launcher'
);
launcherFallbackAssert(
    str_contains($client, 'launcher_available: isMoonYaDesktopRuntime()')
        && str_contains($client, 'return Promise.resolve(launcherRequiredToolResult());'),
    'The browser does not declare its runtime or locally short-circuit launcher calls'
);
launcherFallbackAssert(
    str_contains($api, "LauncherAccessPolicy::isAvailable(\$data)")
        && str_contains($api, "LauncherAccessPolicy::unavailableToolResult()"),
    'The API does not enforce the web launcher fallback before relay creation'
);

echo "web launcher fallback: PASS\n";
