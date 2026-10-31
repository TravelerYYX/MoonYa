<?php
declare(strict_types=1);

function codexAssert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

$root = dirname(__DIR__);
$events = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1e-rest.php');
$history = (string)file_get_contents($root . '/script/MoonYa-index/modules/script-1c-save.php');
$styles = (string)file_get_contents($root . '/script/MoonYa-index/styles/css-06-main.php');
$agentStyles = (string)file_get_contents($root . '/script/MoonYa-index/styles/css-16-agent-experience.php');
$bridge = (string)file_get_contents($root . '/harness_api.php');

foreach ([
    'function codexFinalizeInlineTimeline',
    'function ensureCodexActivityGroup',
    'function renderCodexToolDetail',
    'function recordCodexViewedImage',
    '上下文已自动压缩',
    "'正在工作 · ' + formatTurnDuration",
    "header.setAttribute('aria-expanded', 'false')",
    "record.container.setAttribute('data-turn-elapsed'",
    'function createWorkflowImageIcon',
    "tile.className = 'codex-viewed-image-tile'",
    "'data:image/png;base64,' + String(cuShot.image || '')",
    "'data:image/png;base64,' + String(data.image || '')",
] as $contract) {
    codexAssert(str_contains($events, $contract), "Missing Codex turn contract: {$contract}");
}

foreach ([
    'version: 2',
    'trace: trace',
    'finalContent:',
    'startedAt:',
    'completedAt:',
    'elapsedMs:',
    'codex_presentation_v2',
    'function hydrateCodexPresentation',
] as $contract) {
    codexAssert(str_contains($history, $contract), "Missing presentation v2 history contract: {$contract}");
}

foreach ([
    '.codex-turn-header',
    '.codex-activity-group',
    '.codex-activity-list',
    'max-height: 216px',
    '.codex-tool-detail',
    'max-height: 260px',
    '.codex-viewed-images-grid',
    '.codex-viewed-image-tile',
    '.message.ai > .message-sender { display: none !important; }',
] as $contract) {
    codexAssert(str_contains($styles, $contract), "Missing Codex visual contract: {$contract}");
}

foreach (["'turn' =>", "'step' =>", "'timestamp' =>"] as $contract) {
    codexAssert(str_contains($bridge, $contract), "Harness event metadata missing: {$contract}");
}

codexAssert(
    str_contains($events, "String(args.action || '').toLowerCase() === 'screenshot' ? 'image' : 'browser'")
        && str_contains($events, "parts.push('执行了 ' + counts.browser + ' 次浏览器操作')")
        && str_contains($events, "if (!/^data:image\\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]/i.test(imageSource)) return null;")
        && !str_contains($styles, '.tool-row[data-state="executing"] .tool-row-leading {' . "\n            animation: statusSpin"),
    'Browser actions are still mislabeled as viewed images or running tool icons still rotate'
);

codexAssert(
    str_contains($events, "traceLabel.textContent = '正在工作'")
        && str_contains($events, 'function finishTeamPresentationTimer')
        && str_contains($agentStyles, '.team-presentation-message > .team-main-head { display: none !important; }'),
    'Agent/Team presentation is not using the shared Codex document treatment'
);

codexAssert(
    !str_contains($events, "tail.className = 'turn-tail'"),
    'The removed standalone turn-tail UI is still being created'
);

codexAssert(
    str_contains($events, "return runId + ':turn:' + String(transportTurn) + ':step:' + String(step);")
        && str_contains($events, "const transportKey = String(event.run_id || 'run') + ':turn:' + String(transportTurn);")
        && str_contains($events, 'function conversationReasoningBlockKey')
        && str_contains($events, 'reasoningBlocks: new Map()')
        && str_contains($events, 'appendTurnReasoning(conversationKey, blockKey, payload.delta)')
        && str_contains($events, 'finalizeTurnReasoningBlock('),
    'Harness turn/step identity is not isolating sequential reasoning blocks'
);

codexAssert(
    str_contains($events, "if (useAgentRuntime) return;")
        && str_contains($events, "data.source === 'harness' && data.event === 'agent.turn.started'")
        && str_contains($events, "data.source === 'harness' && data.event === 'assistant.message'")
        && str_contains($events, 'closeContentSegment();')
        && str_contains($events, 'clearTurnLoadingIndicator();'),
    'Harness legacy reasoning/loading UI is still rendered beside the structured turn trace'
);

codexAssert(
    !str_contains($events, 'upsertReasoningRow(conversationKey, 0, turnText, true)'),
    'All Harness model steps are still forced into reasoning row zero'
);

codexAssert(
    str_contains($events, "if (event && event.source === 'harness')")
        && str_contains($events, "approvals.className = 'team-main-approvals codex-turn-approvals'")
        && str_contains($events, 'content: approvals'),
    'Harness approvals still create a second Agent presentation/loading card'
);

fwrite(STDOUT, "Codex timeline contract: PASS\n");
