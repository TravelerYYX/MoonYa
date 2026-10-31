<?php
declare(strict_types=1);

/** Catalog-backed reasoning; version 1 remains a compatibility contract. */
final class BuiltinReasoning {
    public const LEVELS = ['low','medium','high','xhigh','max','ultra'];
    public static function defaults(array $caps): array {
        $levels = array_values(array_intersect(self::LEVELS, $caps['efforts'] ?? []));
        $caps['efforts'] = $levels;
        $caps['effort_labels'] ??= [];
        $caps['default_effort'] ??= in_array('high', $levels, true) ? 'high' : ($levels ? end($levels) : 'auto');
        return $caps;
    }
    public static function resolve(array $data, array $caps, bool $work = false): array {
        $caps = self::defaults($caps);
        $legacy = ['none'=>['none','high'],'light'=>['low','low'],'medium'=>['low','high'],
            'high'=>['high','high'],'max'=>['max','high'],'ultra'=>['max','high']];
        $version = $data['reasoningProfileVersion'] ?? 1;
        if (!in_array($version, [1,2], true)) throw new InvalidArgumentException('无效的思考档位版本');
        $profile = strtolower(trim((string)($data['reasoningProfile'] ?? '')));
        $detail = strtolower(trim((string)($data['image_detail'] ?? '')));
        $effort = strtolower(trim((string)($data['reasoningEffort'] ?? (($data['deepThinking'] ?? true) ? ($version === 1 ? 'high' : $caps['default_effort']) : 'none'))));
        if ($version === 1) {
            $effort = match ($effort) {
                'none','off'=>'none', 'minimal','low'=>'low', 'medium','high','xhigh'=>'high',
                'max','ultra'=>'max', 'auto'=>'auto', default=>throw new InvalidArgumentException('无效的思考强度')
            };
            if ($profile !== '') {
                if (!isset($legacy[$profile])) throw new InvalidArgumentException('无效的界面思考档位');
                if ($effort !== $legacy[$profile][0]) throw new InvalidArgumentException('界面思考档位与请求 effort 不匹配');
                if ($detail !== '' && $detail !== $legacy[$profile][1]) throw new InvalidArgumentException('界面思考档位与图片 detail 不匹配');
                $detail = $legacy[$profile][1];
            }
        } else {
            if (!in_array($effort, ['none','auto',...self::LEVELS], true) || ($profile !== '' && $profile !== $effort))
                throw new InvalidArgumentException('界面思考档位与请求 effort 不匹配');
            if (empty($caps['supports_thinking'])) {
                if ($effort !== 'none') throw new InvalidArgumentException('所选模型不支持思考模式');
            } elseif ($effort === 'none') {
                if ($work || ($caps['reasoning'] ?? '') === 'always' || !empty($caps['reasoning_required']) || ($caps['allow_thinking_off'] ?? true) === false)
                    throw new InvalidArgumentException('所选模型不允许关闭思考');
            } elseif ($caps['efforts'] ? !in_array($effort, $caps['efforts'], true) : $effort !== 'auto') {
                throw new InvalidArgumentException('所选模型不支持该思考强度，请刷新模型配置');
            }
        }
        if ($detail === '') $detail = $effort === 'low' ? 'low' : 'high';
        if (!in_array($detail, ['low','high'], true)) throw new InvalidArgumentException('图片 detail 必须为 low 或 high');
        return ['effort'=>$effort, 'detail'=>$detail];
    }
}
