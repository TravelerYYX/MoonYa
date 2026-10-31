<?php
declare(strict_types=1);

/**
 * 上下文占用估算与历史消息自动压缩。
 *
 * api.php（Chat 模式）、context_usage.php（圆环统计端点）共用本服务，
 * 保证「上下文圆环显示的占用」与「实际发送给模型的占用」来自同一套算法。
 *
 * PHP 侧无法加载 DeepSeek 分词器，这里采用与前端 script 完全一致的启发式估算：
 *   - 中日韩字符：1 token / 字（偏保守）
 *   - 英文单词 / 数字串：1.3 token
 *   - 其余字符（标点、空白、符号）：0.25 token
 *   - 图片块：按 1100 token / 张估算（视觉 token 与服务端实际值接近）
 * 估算整体偏保守（偏高约 10~20%）：宁可早触发压缩，也绝不让上下文撑爆模型窗口。
 */
final class ContextUsage
{
    /** 单张图片占用的估算 token 数（ vision token 近似值） */
    public const IMAGE_TOKEN_ESTIMATE = 1100;

    /**
     * 估算单条文本的 token 数。
     * @param mixed $text 字符串或 OpenAI 多模态 content 数组
     */
    public static function estimateTokens($text): int
    {
        if (is_array($text)) {
            $tokens = 0;
            foreach ($text as $part) {
                if (!is_array($part)) {
                    $tokens += self::estimateTokens(is_string($part) ? $part : '');
                    continue;
                }
                $type = (string)($part['type'] ?? 'text');
                if ($type === 'text') {
                    $tokens += self::estimateTokens((string)($part['text'] ?? ''));
                } elseif ($type === 'image_url' || $type === 'image') {
                    $tokens += self::IMAGE_TOKEN_ESTIMATE;
                }
            }
            return $tokens;
        }
        if (!is_string($text) || $text === '') {
            return 0;
        }

        $chineseChars = preg_match_all('/[\x{4e00}-\x{9fff}\x{3040}-\x{30ff}\x{ac00}-\x{d7af}]/u', $text);
        $englishWords = preg_match_all('/[a-zA-Z0-9_]+/', $text);
        // 剩余字符（标点、空白、其他符号）粗略折算
        $remaining = mb_strlen($text) - $chineseChars - ($englishWords * 3);
        if ($remaining < 0) {
            $remaining = 0;
        }

        return max(1, (int)round($chineseChars + $englishWords * 1.3 + $remaining * 0.25));
    }

    /**
     * 估算 messages 数组的总 token 数。
     */
    public static function estimateMessageTokens(array $messages): int
    {
        $total = 0;
        foreach ($messages as $msg) {
            if (!is_array($msg)) {
                continue;
            }
            $total += self::estimateTokens($msg['content'] ?? '');
            if (!empty($msg['reasoning_content'])) {
                $total += self::estimateTokens($msg['reasoning_content']);
            }
        }
        return $total;
    }

    /**
     * 服务端模型元数据决定最大窗口和允许选择的运行档位。
     */
    public static function resolveLimit(array $config, $requested = null, ?array $model = null): int
    {
        $model = $model ?? ($config['model_capabilities']['deepseek-flash'] ?? []);
        $limit = $model['context_window'] ?? null;
        if (!is_int($limit) || $limit < 1) {
            throw new RuntimeException('请先配置该模型已确认的真实上下文长度');
        }
        if ($requested === null) return $limit;
        $choices = $model['context_window_options'] ?? [$limit];
        if (!is_int($requested) || $requested < 1 || $requested > $limit || !in_array($requested, $choices, true)) {
            throw new RuntimeException('所选上下文档位不可用，请重新选择');
        }
        return $requested;
    }

    /**
     * 历史消息自动压缩：从最新的消息开始往回保留，直到再加一条会超出预算。
     *
     * 修复旧版实现的方向性错误（旧循环从最新往最旧累积却在
     * "tokens <= threshold" 时才 break，导致超出预算后一路跑完、
     * 一条没裁还插入了"已被精简"的误导提示）。
     *
     * @param array $messages    完整消息数组（system + history + 当前消息）
     * @param int   $budgetTokens 历史+系统允许占用的 token 预算
     * @param int   $minRounds    至少保留的最近用户轮次
     * @return array 裁剪后的消息数组；确实裁掉过内容时插入压缩提示
     */
    public static function trimHistoryMessages(array $messages, int $budgetTokens, int $minRounds = 3): array
    {
        $system = [];
        $history = [];
        foreach ($messages as $msg) {
            if (($msg['role'] ?? '') === 'system' && count($system) === 0) {
                $system[] = $msg;
            } else {
                $history[] = $msg;
            }
        }

        if (self::estimateMessageTokens($messages) <= $budgetTokens) {
            return $messages;
        }

        $kept = [];
        $used = self::estimateMessageTokens($system);
        for ($i = count($history) - 1; $i >= 0; $i--) {
            $msgTokens = self::estimateMessageTokens([$history[$i]]);
            $rounds = 0;
            foreach ($kept as $keptMsg) {
                if (($keptMsg['role'] ?? '') === 'user') {
                    $rounds++;
                }
            }
            // 已保留足够轮次后再遇超预算消息即停；不足 minRounds 时强制保留（单条过大只能接受）
            if ($rounds >= $minRounds && $used + $msgTokens > $budgetTokens) {
                break;
            }
            array_unshift($kept, $history[$i]);
            $used += $msgTokens;
        }

        if (count($kept) === count($history)) {
            // 一条都没能裁掉（最近几轮本身已超预算），保持原样、不插提示
            return $messages;
        }

        array_unshift($kept, [
            'role' => 'system',
            'content' => '[系统提示] 对话历史已超过上下文限制，早期内容已被自动压缩。如需回顾之前内容，请在新对话中重新开始。',
        ]);

        return array_merge($system, $kept);
    }
}
