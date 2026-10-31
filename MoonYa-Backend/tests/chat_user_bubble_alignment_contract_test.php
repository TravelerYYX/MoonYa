<?php
declare(strict_types=1);

/**
 * 用户消息气泡的对齐契约（css-06-main.php，逐行对照 DSH MessageItem.module.css）。
 *
 * 气泡必须贴在对话列的右侧、与助手正文落在同一条右边缘上：
 *   .message.user                   ← DSH .userRow：占满整列 + 气泡右对齐 + 与助手行同内缩
 *   .message.user .message-content  ← DSH .bubble + .userStack：宽度上限属于气泡本身
 *
 * 回归点：把宽度上限（0.702 × 对话列宽）加到 .message.user 上，块级盒子会贴到列的左边，
 * 气泡随之停在列的中间；body.chat-fullscreen 的 margin-left: 50% 则把气泡推出右边缘。
 */

function userBubbleAssert(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

/** 取某个选择器第一条规则的声明块，取不到即视为契约缺失。 */
function userBubbleBlock(string $css, string $selector): string
{
    $pattern = '/' . preg_quote($selector, '/') . '\s*\{([^}]*)\}/';
    userBubbleAssert(
        preg_match($pattern, $css, $matches) === 1,
        "缺少 {$selector} 的样式规则"
    );
    return $matches[1];
}

$root = dirname(__DIR__);
$styles = (string)file_get_contents($root . '/script/MoonYa-index/styles/css-06-main.php');

$userRow = userBubbleBlock($styles, '.message.user');
$userBubble = userBubbleBlock($styles, '.message.user .message-content');
$aiRow = userBubbleBlock($styles, '.message.ai');

userBubbleAssert(
    str_contains($userRow, 'align-items: flex-end'),
    '用户行不再把气泡右对齐（align-items: flex-end 缺失）'
);

// 宽度上限出现在**任何**一条 .message.user 规则里都会把整行压到列的左边，
// 后出现的规则还会覆盖前面的（曾经就有一条残留的 .message.user { max-width: 100% }）。
preg_match_all('/\.message\.user\s*\{([^}]*)\}/', $styles, $userRowRules);
foreach ($userRowRules[1] as $rule) {
    userBubbleAssert(
        preg_match('/max-width:\s*(?:min|calc)\(/', $rule) !== 1,
        '宽度上限又回到了 .message.user 上：块级盒子贴左，用户气泡会停在对话列中间'
    );
}

userBubbleAssert(
    str_contains(
        $userBubble,
        'max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)'
    ),
    'DSH .userStack 的气泡宽度上限（0.702 × 对话列宽，窄窗口 82% 兜底）缺失'
);

userBubbleAssert(
    preg_match('/padding-left:\s*(\d+)px/', $aiRow, $aiLeft) === 1
        && preg_match('/padding-right:\s*(\d+)px/', $aiRow, $aiRight) === 1
        && $aiLeft[1] === $aiRight[1],
    '助手行缺少左右对称的内缩，用户行无从对齐'
);

userBubbleAssert(
    preg_match('/padding:\s*0\s+(\d+)px/', $userRow, $userInset) === 1
        && $userInset[1] === $aiLeft[1]
        && str_contains($userRow, 'box-sizing: border-box'),
    '用户行内缩与助手行不一致或缺少 box-sizing: border-box，气泡右边缘无法与助手正文对齐'
);

userBubbleAssert(
    !str_contains($styles, 'body.chat-fullscreen .message.user'),
    '全屏模式的 margin-left: 50% 位移又回来了：它会把用户气泡推出对话列右边缘'
);

fwrite(
    STDOUT,
    "[PASS] user bubble stays right-aligned with the assistant column (inset {$aiLeft[1]}px, cap on the bubble).\n"
);
