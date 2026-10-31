<?php
declare(strict_types=1);
require_once __DIR__ . '/SkillCatalog.php';
require_once __DIR__ . '/BuiltinModelService.php';

/** Public, versioned desktop configuration. Never serialize the server config. */
function moonyaClientConfig(array $config, ?array $catalog = null): array
{
    if ($catalog !== null) {
        $config['ui_model_groups'] = ['deepseek' => ['default' => $catalog[0]['id'] ?? '', 'models' => $catalog]];
        $config['model_capabilities'] = [];
        foreach ($catalog as $row) $config['model_capabilities'][$row['id']] = $row['capabilities'];
    }
    $groups = [];
    foreach ($config['ui_model_groups'] ?? [] as $name => $group) {
        $groups[$name] = ['default' => $group['default'], 'models' => array_map(
            static fn(array $model): array => array_intersect_key($model, array_flip(['id', 'label', 'multiplier'])), $group['models'])];
    }
    $skills = array_map(static fn(array $skill): array => array_intersect_key($skill,
        array_flip(['name', 'display_name', 'description', 'enabled'])),
        (new SkillCatalog(dirname(__DIR__) . '/skills'))->list(false));
    return [
        'version' => 1, 'modelGroups' => $groups,
        'modelCapabilities' => array_map(static fn(array $caps): array => array_intersect_key($caps, array_flip([
            'provider', 'protocol', 'max_output_tokens', 'supports_tools', 'supports_thinking', 'reasoning', 'reasoning_required', 'allow_thinking_off', 'efforts', 'effort_labels', 'default_effort', 'supports_stream_usage', 'supports_tool_choice', 'context_window', 'context_window_options', 'context_window_source', 'supports_images',
            'disable_thinking_for_tools', 'reasoning_control', 'strip_sampling_when_thinking', 'omit_tool_choice_when_thinking',
            'supports_thinking_with_tools', 'uses_scene_prompt', 'normalize_multimodal_to_text', 'planning_thinking_disabled'
        ])), $config['model_capabilities'] ?? []),
        'skills' => array_values(array_filter($skills, static fn(array $s): bool => $s['enabled'])),
        'voice' => array_intersect_key($config['voice_config'] ?? [], array_flip(['lang', 'rate', 'pitch', 'volume'])),
        'ptt' => ['asrEnabled' => !empty($config['aliyun_asr']['api_key']), 'asrEndpoint' => '/api/asr.php', 'mode' => 'hold',
            'model' => $config['aliyun_asr']['model'] ?? ''],
        'features' => [
            'horoscope' => ['enabled' => $config['horoscope']['enabled'] ?? true, 'apiUrl' => '/api/client_feature.php?feature=horoscope', 'apiToken' => ''],
            'weather' => ['enabled' => $config['weather']['enabled'] ?? true, 'apiUrl' => '/api/client_feature.php?feature=weather', 'apiToken' => '',
                'ipLocationApis' => [], 'defaultTimezone' => $config['weather']['default_timezone'] ?? 'UTC+8'],
        ],
        'runtime' => ['pdfWorkerUrl' => '/vendor/pdf.worker.min.js', 'videoPortalUrl' => $config['video_portal']['url'] ?? ''],
        'persona' => '你是 MoonYa。用清晰、直接的中文与用户协作；执行任务时持续工作到完成并验证。',
        'contextReserveRatio' => (float)($config['context_window']['reserve_ratio'] ?? 0.2),
    ];
}
