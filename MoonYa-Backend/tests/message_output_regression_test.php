<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/Services/ExecutionGuard.php';

function outputRegressionAssert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$root = dirname(__DIR__);
$events = (string)file_get_contents(
    $root . '/script/MoonYa-index/modules/script-1e-rest.php'
);
$api = (string)file_get_contents($root . '/api.php');
$envExample = (string)file_get_contents($root . '/.env.example');

outputRegressionAssert(
    ExecutionGuard::availabilityError($root) === null,
    'Execution guard did not discover the local PHP CLI'
);
outputRegressionAssert(
    ExecutionGuard::availabilityError($root . '/missing-root') === 'execution_guard_worker_missing',
    'Execution guard did not report a missing worker deterministically'
);
outputRegressionAssert(
    str_contains($api, "ExecutionGuard::availabilityError(__DIR__)")
        && str_contains($api, '回退到当前请求直接执行'),
    'API no longer falls back before enqueue when detached execution is unavailable'
);
outputRegressionAssert(
    str_contains($envExample, 'PHP_CLI_BINARY='),
    'PHP CLI deployment override is undocumented'
);
outputRegressionAssert(
    str_contains($events, 'typeWriter(textDiv, content, 30, destinationContainer);')
        && str_contains($events, 'function typeWriter(element, text, speed = 30, targetContainer = null)')
        && str_contains($events, 'function addAIMessageWithHTML(text, htmlContent, targetContainer = null)'),
    'Message rendering can lose its destination container again'
);

fwrite(STDOUT, "[PASS] execution-guard fallback and complete message rendering regression.\n");
