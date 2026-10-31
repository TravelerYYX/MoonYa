<?php
declare(strict_types=1);

function contractAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$root = dirname(__DIR__);
if (($argv[1] ?? '') === 'sse-flush-probe') {
    require_once $root . '/Services/SseStreamOutput.php';
    ob_start();
    echo "event: approval.required\ndata: {\"id\":1}\n\n";
    SseStreamOutput::prepare();
    SseStreamOutput::flush();
    usleep(1_200_000);
    exit(0);
}

$bridge = (string)file_get_contents($root . '/harness_api.php');
$tools = (string)file_get_contents($root . '/../MoonYa-Harness/src/tools.mjs');
$prompt = (string)file_get_contents($root . '/../MoonYa-Harness/src/prompt.mjs');
$server = (string)file_get_contents($root . '/../MoonYa-Harness/src/server.mjs');
$streamOutput = (string)file_get_contents($root . '/Services/SseStreamOutput.php');

contractAssert(str_contains($bridge, "'skills' => loadRuntimeSkills()"), '后端未传递动态技能目录');
contractAssert(str_contains($bridge, "'selected_skills' => normalizeSelectedSkills"), '后端未传递显式技能');
contractAssert(!str_contains($bridge, "['browser_automation']") && !str_contains($bridge, 'agent_planning'), 'Harness 仍注入旧数据库技能提示词');
foreach (['read_skill', 'interaction_request_action', 'browser_automation_control', 'computer_use_tool', 'web_search', 'web_fetch'] as $tool) {
    contractAssert(str_contains($tools, "fileTool('{$tool}'"), "缺少 Harness 工具 {$tool}");
}
contractAssert(str_contains($prompt, 'there is no keyword router') && str_contains($prompt, 'read_skill'), '技能选择仍可能依赖关键词路由');
contractAssert(str_contains($server, 'selectedSkills') && str_contains($server, 'skills: session.skills'), '技能目录未进入会话工具上下文');
contractAssert(str_contains($server, 'isBrowserApprovalChallenge'), '浏览器安全确认机制缺失');
contractAssert(str_contains($bridge, 'SseStreamOutput::prepare()')
    && str_contains($bridge, 'function streamFlush(): void')
    && str_contains($bridge, 'SseStreamOutput::flush()')
    && str_contains($streamOutput, "ini_set('output_buffering', 'off')")
    && str_contains($streamOutput, "ini_set('zlib.output_compression', 'Off')")
    && str_contains($streamOutput, 'while (ob_get_level() > 0)')
    && str_contains($streamOutput, 'ob_flush();'), 'Harness SSE 未完整关闭并主动刷新 PHP 输出缓冲');

ob_start();
ob_start();
contractAssert(ob_get_level() >= 2, '无法构造 PHP 多层输出缓冲测试场景');
require_once $root . '/Services/SseStreamOutput.php';
SseStreamOutput::prepare();
contractAssert(ob_get_level() === 0, 'SSE 流入口未清理已有 PHP 输出缓冲层');

$probe = proc_open(
    [PHP_BINARY, __FILE__, 'sse-flush-probe'],
    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
    $pipes
);
contractAssert(is_resource($probe), '无法启动 SSE 实时刷新探针');
fclose($pipes[0]);
stream_set_blocking($pipes[1], false);
$received = '';
$deadline = microtime(true) + 0.75;
while (microtime(true) < $deadline && !str_contains($received, 'approval.required')) {
    $received .= (string)stream_get_contents($pipes[1]);
    usleep(10_000);
}
contractAssert(str_contains($received, 'approval.required'), '小体积 approval.required 未在后续静默期间立即到达客户端');
fclose($pipes[1]);
fclose($pipes[2]);
proc_close($probe);
contractAssert(str_contains($server, "'user_action.required'") && str_contains($server, "'user_action.decided'")
    && str_contains($server, "{ action: 'inspect' }"), '用户接管或完成后重新观察机制缺失');
contractAssert(str_contains($bridge, "action'] ?? '') === 'user_action'"), 'PHP 桥未转发用户接管决定');
$layout = (string)file_get_contents($root . '/script/MoonYa-index/layouts/main-content.php');
$events = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1e-rest.php');
contractAssert(str_contains($layout, 'id="userActionCard"') && str_contains($layout, 'id="teamBrowserHandoffComplete"'), '接管卡片或浏览器完成按钮缺失');
contractAssert(str_contains($events, 'moonyaCompleteUserAction') && str_contains($events, "decideUserAction('skip')"), '前端接管完成/跳过流程缺失');

echo "harness_browser_contract_test: OK\n";
