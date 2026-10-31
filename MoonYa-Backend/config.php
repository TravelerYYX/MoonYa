<?php
require_once __DIR__ . '/env_loader.php';
require_once __DIR__ . '/Services/AppDataPaths.php';
AppDataPaths::configurePhp();

// Harness 化重构（4.10）：api_domain_config 表与 get_api_domain_config() 已删除，
// 组件域名配置全部走 .env：
//   MOONYA_PYTHON_SERVICE_URL → Python 微服务（搜索/爬虫/语音）
//   MAIN_API_DOMAIN           → 主站对外域名（分享链接等）
$python_service_domain = trim((string)(env('MOONYA_PYTHON_SERVICE_URL') ?: ''));
$main_api_domain = rtrim(trim((string)(env('MAIN_API_DOMAIN') ?: '')), '/');

// Web 附件配置：环境变量可覆盖部署默认值，业务代码和前端不得另写限制。
$web_attachment_max_files = max(1, (int)(env('WEB_UPLOAD_MAX_FILES') ?: 100));
$web_attachment_max_images = 600;
$web_attachment_max_file_size = max(1, (int)(env('WEB_UPLOAD_MAX_FILE_BYTES') ?: 5242880));
$web_attachment_max_image_size = 64 * 1024 * 1024;
$web_attachment_ttl_seconds = max(60, (int)(env('WEB_UPLOAD_TTL_SECONDS') ?: 5400));
$web_attachment_temp_dir = AppDataPaths::directory('temp', 'web-attachments');

// API 配置
return [
    // API访问密钥 - 用于外部系统对接时的身份验证
    // 请求时需要在Header中设置: X-API-Key: <API_ACCESS_KEY>
    'api_access_key' => env('API_ACCESS_KEY') ?: '',

    'browser_security' => [
        'confirmation_ttl_seconds' => max(30, (int)(env('BROWSER_CONFIRMATION_TTL_SECONDS') ?: 120)),
    ],
    'web_assets' => [
        'highlight_css' => env('HIGHLIGHT_CSS_URL') ?: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
        'highlight_js' => env('HIGHLIGHT_JS_URL') ?: 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
        'mammoth_js' => env('MAMMOTH_JS_URL') ?: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
        'pdf_js' => env('PDF_JS_URL') ?: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
        'pdf_worker_js' => env('PDF_WORKER_JS_URL') ?: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    ],
    'profile' => [
        'default_avatar_url' => env('DEFAULT_AVATAR_URL') ?: '/image/default-avatar.png',
    ],
    'internal_api_url' => env('MOONYA_INTERNAL_API_URL') ?: '',
    'internal_api_timeout_seconds' => max(1, (int)(env('MOONYA_INTERNAL_API_TIMEOUT_SECONDS') ?: 30)),
    // 本地持久化 Coding Agent 运行时。只接受 loopback 地址，密钥仅由 PHP 注入。
    'agent_runtime_url' => env('MOONYA_AGENT_RUNTIME_URL') ?: 'http://127.0.0.1:58907',
    

    // DeepSeek 是本项目唯一的对话/视觉模型供应商。
    // 其余厂商（Kimi/Moonshot、MiniMax 对话模型、GLM）的模型目录、端点与密钥已于 v4.11 全部移除。
    // 注意：MiniMax 仅保留 TTS 语音合成（见 voice_config.minimax），阿里云仅保留 ASR 语音识别。
    'deepseek_api_key' => env('DEEPSEEK_API_KEY') ?: '',








    // ==================== API 配置 ====================
    'deepseek_api_url' => env('DEEPSEEK_API_URL') ?: 'https://api.deepseek.com/v1/chat/completions',

    // ==================== Web 附件统一配置 ====================
    'web_attachments' => [
        'max_files' => $web_attachment_max_files,
        'max_images' => $web_attachment_max_images,
        'max_file_size' => $web_attachment_max_file_size,
        'max_image_size' => $web_attachment_max_image_size,
        'ttl_seconds' => $web_attachment_ttl_seconds,
        'temp_dir' => $web_attachment_temp_dir,
        'provider_connect_timeout_seconds' => max(1, (int)(env('WEB_ATTACHMENT_CONNECT_TIMEOUT_SECONDS') ?: 10)),
        'provider_timeout_seconds' => max(1, (int)(env('WEB_ATTACHMENT_PROVIDER_TIMEOUT_SECONDS') ?: 90)),
        'max_extracted_chars' => max(1000, (int)(env('WEB_UPLOAD_MAX_EXTRACTED_CHARS') ?: 500000)),
        'categories' => [
            'image' => ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            'audio' => ['mp3', 'wav', 'm4a', 'ogg', 'webm', 'pcm'],
            'document' => [
                'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'rtf',
                'md', 'txt', 'json', 'xml', 'yaml', 'yml', 'go', 'h', 'c', 'cpp',
                'cxx', 'cc', 'cs', 'java', 'js', 'css', 'jsp', 'php', 'py', 'py3',
                'asp', 'ini', 'conf', 'ts', 'tsx', 'html', 'log',
            ],
        ],
    ],
    
    // ==================== DeepSeek 文件上传配置 ====================
    'deepseek_upload' => [
        'max_file_size' => 64 * 1024 * 1024,
        'max_file_count' => 600,
        'inline_body_budget_bytes' => 40 * 1024 * 1024,
        'allowed_types' => [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain',
        ],
        'allowed_extensions' => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'doc', 'docx', 'txt'],
        'image_extensions' => ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        'document_extensions' => ['pdf', 'doc', 'docx', 'txt'],
        'max_text_length' => 500000,
    ],
    
    // ==================== OCR 图片文字识别配置 ====================
    'ocr' => [
        'enabled' => true,
        'api_url' => env('OCR_API_URL') ?: 'https://yunzhiapi.cn/API/ocrwzsb.php',
        'token' => env('YUNZHI_API_TOKEN') ?: '',
        'max_image_size' => 1 * 1024 * 1024,
        'supported_formats' => ['pdf', 'gif', 'png', 'jpg', 'tif', 'bmp', 'jpeg'],
        'target' => 'chs',
        'type' => 'json',
        'site_url' => $main_api_domain,
        'temp_dir' => AppDataPaths::directory('temp', 'ocr') . DIRECTORY_SEPARATOR,
        'temp_url_path' => '/ocr_image.php?file=',
    ],
    
    // ==================== 模型配置 ====================
    // 各模式使用的模型名称
    'search_models' => [
        'search' => 'deepseek-flash',                // 联网搜索模型（自建搜索服务 + DeepSeek Function Calling）
    ],
    'tool_models' => ['deepseek-flash'],
    'default_chat_model_group' => 'deepseek',
    'prompt_optimizer_model' => env('PROMPT_OPTIMIZER_MODEL') ?: 'deepseek-flash',
    'deep_thinking_model' => env('DEEP_THINKING_MODEL') ?: 'deepseek-flash',
    'browser_vls_temperature' => (float)(env('BROWSER_VLS_TEMPERATURE') ?: 0.2),

    // 生产模型目录的唯一来源。界面、路由和 Agent 只读取这份组件配置。
    // v4.11：只保留 DeepSeek 一个模型组，kimi / minmax / glm 三组已全部删除。
    'ui_model_groups' => [
        'deepseek' => [
            'default' => 'deepseek-flash',
            'models' => [
                ['id' => 'deepseek-flash', 'label' => 'deepseek-flash', 'supports_images' => true],
            ],
        ],
    ],
    'model_provider_routes' => [
        'deepseek' => ['url_key' => 'deepseek_api_url', 'api_key_key' => 'deepseek_api_key'],
    ],
    'model_capabilities' => [
        'deepseek-flash' => ['provider' => 'deepseek', 'context_window' => 1048576, 'context_window_options' => [300000, 1048576], 'context_window_source' => 'official', 'supports_images' => true, 'disable_thinking_for_tools' => false, 'reasoning_control' => 'binary_strength', 'strip_sampling_when_thinking' => true, 'omit_tool_choice_when_thinking' => true, 'supports_thinking_with_tools' => true, 'uses_scene_prompt' => true, 'normalize_multimodal_to_text' => false, 'planning_thinking_disabled' => true],
    ],

    // ==================== 联网搜索统一配置（自建 Python 搜索服务 + DeepSeek Function Calling） ====================
    // v4.11：原 Kimi（Moonshot）原生 $web_search 两阶段协议已全部移除，
    //        联网搜索统一走本配置块 + search_api_url 指向的自建 Python 搜索服务。
    // 关键流程：phase1 非流式 chat/completions 拿 tool_calls → 拼 role=tool 消息 →
    //          phase2 流式 chat/completions 拿最终回答
    // 业务侧（api.php）应读取本配置块，不要在代码中硬编码模型名/URL/温度/tool schema
    'deepseek_web_search' => [
        'enabled' => true,
        'primary_model' => 'deepseek-flash',
        'supported_models' => [
            'deepseek-flash',
        ],
        'endpoint' => env('DEEPSEEK_API_URL') ?: 'https://api.deepseek.com/v1/chat/completions',
        'temperature' => 0.6,
        'max_tokens' => 32768,
        'phase1_max_tokens' => 32768,             // 搜索结果会占用大量 token，phase 1 保持 32768
        'thinking' => ['type' => 'disabled'],     // 走工具调用时不开启思考
        'phase1_stream' => false,                 // 第一阶段：非流式拿 tool_calls
        'phase2_stream' => true,                  // 第二阶段：可流式拿最终回答

        // ★ v4.7 (2026-06-20): tool_choice 配置化（严禁硬编码）
        //   auto = 让模型自主判断是否需要调用工具
        //   required = 强制每次都调用工具（旧行为，违反"AI 自主判断"原则）
        'tool_choice' => 'auto',

        // ★ v4.8 (2026-06-20): 日期格式配置化（严禁硬编码）
        //   api.php 用此 format 调用 date() 替换 {DATE} 占位符
        //   修改这里即可调整日期显示格式
        'date_format' => 'Y-m-d l H:i',

        // ★ v4.7 (2026-06-20): system prompt 配置化（严禁硬编码）
        // ★ v4.8 (2026-06-20): 增加 {DATE} 占位符 + 引导模型输出 query_count
        //   引导式 prompt：告诉模型什么时候该搜、什么时候不该搜
        //   修改这里即可调整联网搜索行为，无需改 api.php 代码
        //   {DATE} 会被 api.php 用 date_format 替换
        // ★ v4.9.4 (2026-06-20): 删除模板里残留的【当前日期】块
        //   根因：v4.9 dateHint 模板（"当前日期：{DATE}"）已统一为全模型日期注入入口。
        //   之前此模板仍带【当前日期】{DATE} 块 + api.php:1688 去重判断用的是
        //   `strpos('【当前日期】')`，因 v4.9 模板用"当前日期："（中文冒号、无方括号）不匹配，
        //   导致 webSearchHint 整体被追加，system prompt 中出现两份日期块（格式不同）。
        //   LLM 看到两份不同格式的日期块 + v4.9 模板的"严禁复述"+"照搬示例"矛盾指令时
        //   倾向输出两次（重复 bug 在 Kimi 模型上 100% 复现）。
        //   修复：从此处删除【当前日期】块，日期统一由 system_prompt_date_injection 注入。
        'web_search_system_prompt' => "\n\n【联网搜索能力】\n你可以使用 web_search 工具搜索互联网获取实时信息。\n\n请按以下原则判断是否需要调用：\n- ✅ 需要搜索：用户问新闻、股价、天气、今天/最近/最新发生的事、你不知道的事实、要求\"搜一下/查一下\"的内容\n- ❌ 不需要搜索：问候、闲聊、常识问题、数学计算、编程问题、翻译、你能直接回答的内容\n\n对于不需要搜索的问题，直接回答，不要调用工具。\n对于需要搜索的问题，先调用工具再基于结果用简洁自然的中文给出最终答案。\n\n【搜索参数】\n调用 web_search 时，根据问题复杂度决定 query_count（并行搜索数量）：\n- query_count=4：简单明确的问题（如\"今天有什么新闻\"、\"Python 教程\"）\n- query_count=6：稍复杂的问题（如\"AI 最新发展\"、\"Vibe Coding 是什么\"）\n- query_count=8：复杂或不确定的问题（如开放式话题、多角度分析）\n系统会自动基于你的 query 扩展为对应数量的变体并行搜索。",

        // 自定义 Function Calling web_search 工具（走自建 Python 搜索服务）
        // ★ v4.8 (2026-06-20): 增加 query_count 字段（让模型评估问题复杂度）
        'function_calling_tool' => [
            'type' => 'function',
            'function' => [
                'name' => 'web_search',
                'description' => '联网搜索互联网信息。系统会自动将你提供的 query 扩展为 4-8 个变体并行搜索。请根据问题复杂度通过 query_count 参数指定并行搜索数量。',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => [
                            'type' => 'string',
                            'description' => '核心搜索关键词（系统会自动扩展为多个变体并行搜索）',
                        ],
                        'query_count' => [
                            'type' => 'integer',
                            'description' => '期望并行搜索的数量（4-8），系统会基于此生成对应数量的变体查询',
                        ],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],

        // 自有 Python 搜索服务（联网搜索的唯一后端）
        'search_api_url' => rtrim($python_service_domain, '/'),
        'search_api_timeout' => 30,
        'search_api_connect_timeout' => 10,
    ],

    // ==================== 全模型注入当前日期 ====================
    // ★ v4.9 (2026-06-20): 全模型注入当前日期（与 deepseek_web_search 联动）
    //   在非排除模式（写作/编程/研究/普通/Agent/Work）下会注入当前日期。
    //   排除模式：图片生成、视频生成、音乐生成、文言文翻译、翻译（这 5 类无意义且走独立端点）。
    //   template 必须含 {DATE} 占位符，api.php 会在请求时用 date(date_format) 替换。
    //   date_format 与 deepseek_web_search.date_format 保持完全一致，避免后端出现两种日期格式。
    'system_prompt_date_injection' => [
        'enabled' => true,
        // ★ v4.9.4 (2026-06-20): 简化为中性"系统时间"陈述
        //   根因：v4.9.2 模板用"严禁复述/翻译/重新格式化"+"用户问起时直接照搬"+"例如「今天是{REPLY_DATE}。」"
        //   是矛盾指令 + 强示例锚点，模型会把"照搬示例"理解为"必须输出示例格式"，
        //   再叠加 system prompt 出现两份日期块的 bug → 100% 输出两遍。
        //   v4.9.4 改为纯陈述："系统当前时间：{DATE}"，不给指令、不给示例，让模型按自己的自然格式回答日期。
        'date_format' => 'Y年n月j日 l H:i',
        'template' => "\n\n系统当前时间：{DATE}",
    ],

    // 各模型最大token限制配置
    // 键为模型名称，值为最大token数，null表示不限制
    'model_max_tokens' => [
        'deepseek-flash' => 393216,
        'deepseek-v4-flash' => 393216,
        'deepseek-v4-pro' => 393216,
    ],

    // ==================== 上下文窗口配置 ====================
    // 窗口上限由模型元数据决定，此处只配置用量估算与压缩策略。
    //   - reserve_ratio：为回答输出 + 系统开销预留的比例，
    //     历史消息裁剪阈值 = 所选窗口 × (1 - reserve_ratio)
    //   - history_load_limit：每次请求从数据库加载的最大历史消息条数
    //     （替代旧硬编码 LIMIT 20；真正防止上下文撑爆的是按 token 的自动压缩）
    //   - system_estimate_tokens：system prompt 的估算 token 数（用于上下文圆环统计）
    // api.php / harness / context_usage.php 共用本配置，保证圆环显示与裁剪行为一致。
    'context_window' => [
        'reserve_ratio' => 0.2,
        'history_load_limit' => 100,
        'system_estimate_tokens' => 1500,
    ],
    
    // ==================== 温度配置 ====================
    // DeepSeek 动态 temperature 配置（基于使用场景）
    'deepseek_temperature' => [
        'enabled' => true,
        'default' => 0.7,
        'scenes' => [
            'coding' => [
                'temperature' => 0.0,
                'keywords' => ['代码', '编程', '程序', '开发', 'bug', 'debug', '函数', '类', '接口', 'python', 'javascript', 'java', 'php', 'sql', 'html', 'css', 'react', 'vue', 'node', 'typescript', 'api', '算法', '实现', '编写', '脚本', '编译', '运行', '部署', '框架', '库', '组件', '模块'],
            ],
            'math' => [
                'temperature' => 0.0,
                'keywords' => ['数学', '计算', '证明', '方程', '函数', '积分', '微分', '概率', '统计', '几何', '代数', '求解', '推导', '公式', '定理'],
            ],
            'data_extraction' => [
                'temperature' => 1.0,
                'keywords' => ['提取', '抽取', '解析', '抓取', '采集', '导出', '整理', '分类', '标注', '识别', '检测', '筛选', '匹配', '比对', '转换格式', '结构化'],
            ],
            'translation' => [
                'temperature' => 1.3,
                'keywords' => ['翻译', 'translate', '英文', '中文', '日语', '韩语', '法语', '德语', '俄语', '西班牙语', '译成', '翻成', '互译'],
            ],
            'creative' => [
                'temperature' => 1.5,
                'keywords' => ['创意', '写作', '文章', '小说', '故事', '诗歌', '诗', '文案', '润色', '改写', '散文', '剧本', '歌词', '对联', '续写', '创作', '想象', '幻想', '童话'],
            ],
        ],
    ],

    // DeepSeek 深度思考模式 stop 参数（可选，未设置则默认 ["\n\n\n\n"]）
    // 'deepseek_stop' => ["\n\n\n\n"],

    // ==================== Code-Agent 模型配置 ====================
    // Code-Agent 使用的 DeepSeek 模型，强制启用深度思考
    'code_agent_models' => [
        'fast' => 'deepseek-v4-flash',   // 简单代码任务（单文件、小函数）
        'deep' => 'deepseek-v4-pro',     // 复杂代码任务（项目级、多文件、重构）
    ],

    // ==================== DeepSeek penalty 配置 ====================
    // ★ v4.10 (2026-06-20): 抑制 self-repetition 倾向
    //   默认值从 0.0 调整为 0.3/0.4，经实测可显著降低 deepseek-v4-flash 的"重复整段输出"行为
    //   frequency_penalty: 惩罚已出现过的 token 频率
    //   presence_penalty:  惩罚已出现过的 token 主题
    'deepseek_penalty' => [
        'enabled' => true,
        'default' => [
            'frequency_penalty' => 0.3,
            'presence_penalty' => 0.4,
        ],
        'scenes' => [
            'creative' => [
                'frequency_penalty' => 0.2,
                'presence_penalty' => 0.3,
            ],
            'coding' => [
                'frequency_penalty' => 0.0,
                'presence_penalty' => 0.0,
            ],
            'math' => [
                'frequency_penalty' => 0.0,
                'presence_penalty' => 0.0,
            ],
        ],
    ],

    // 数据库配置
    'db_host' => env('DB_HOST') ?: 'localhost',
    'db_port' => (int)(env('DB_PORT') ?: 3306),
    'db_name' => env('DB_NAME') ?: 'ai_system',
    'db_user' => env('DB_USER') ?: '',
    'db_pass' => env('DB_PASS') ?: '',

    // 注意：jwt_secret 实际由 admin/config.php 提供（Auth.php 读的是 admin config）
    // 这里不再重复声明，避免双源不一致

    // Token 限制配置
    // ULID白名单用户token限制（留空或设为null则不限制）
    'max_tokens_ulid' => null,
    // ULID白名单列表，填入ULID则该用户无限制
    'ulid_whitelist' => [],
    
    // 深度思考 + 联网搜索配置
    // 启用后，深度思考模式会先进行思考分析，然后自动进行联网搜索，最后综合生成回答
    'enable_deep_thinking_with_search' => true, // 是否启用深度思考+联网搜索组合功能
    'search_model' => 'deepseek-flash', // 用于联网搜索的模型（需要支持 tools 参数）
    
    // 简单问题关键词列表 - 如果用户消息包含这些关键词，跳过联网搜索，直接使用深度思考回答
    // 这样可以避免"你好"、"谢谢"等简单问候也触发耗时的联网搜索流程
    'simple_queries' => [
        '你好', '您好', '嗨', '哈喽', 'hello', 'hi', 'hey',
        '谢谢', '感谢', '多谢', 'thanks', 'thank',
        '再见', '拜拜', 'bye', 'goodbye',
        '嗯', '哦', '啊', '好', '是的', '没错', '对的',
        '在吗', '在不在', '有人吗',
        '早上好', '下午好', '晚上好', '晚安'
    ],
    
    // 音乐功能配置
    
    // 语音播报配置
    'voice_config' => [
        'enabled' => true,                      // 是否启用语音播报
        'use_browser_tts' => false,            // 是否使用浏览器原生TTS（false则使用MinMax TTS）
        'lang' => 'zh-CN',                     // 语言设置
        'rate' => 1.0,                         // 语速 (0.1 - 10)
        'pitch' => 1.0,                        // 音调 (0 - 2)
        'volume' => 1.0,                       // 音量 (0 - 1)
        'voice_name' => "Microsoft Huihui",     // 浏览器TTS音色名称
        // MinMax语音合成配置
        'minimax' => [
            'enabled' => true,                  // 是否启用MinMax TTS
            'api_key' => env('MINMAX_TTS_API_KEY') ?: '',  // MinMax API Key
            'api_url' => env('MINMAX_TTS_API_URL') ?: 'https://api.minimaxi.com/v1/t2a_v2',
            'voice_id' => env('MINMAX_TTS_VOICE_ID') ?: 'Moonya_yueyaxuan',
            'model' => env('MINMAX_TTS_MODEL') ?: 'speech-2.8-hd',
            'connect_timeout_seconds' => max(1, (int)(env('MINMAX_TTS_CONNECT_TIMEOUT_SECONDS') ?: 10)),
            'timeout_seconds' => max(1, (int)(env('MINMAX_TTS_TIMEOUT_SECONDS') ?: 90)),
            'need_noise_reduction' => true,     // 是否需要降噪
            'language_boost' => 'auto',          // 语言增强
        ],
    ],
    'horoscope' => [
        'enabled' => true,
        'api_url' => 'https://yunzhiapi.cn/API/xzyspd.php',
        'api_token' => env('YUNZHI_API_TOKEN') ?: '',
    ],
    'weather' => [
        'enabled' => true,
        'api_url' => 'https://yunzhiapi.cn/API/zxtqsk.php',
        'api_token' => env('YUNZHI_API_TOKEN') ?: '',
        'ip_location_apis' => [
            'https://ip.useragentinfo.com/json',
            'https://api.ip.sb/geoip',
            'https://ipapi.co/json/',
            'https://ipinfo.io/json',
        ],
        'default_timezone' => 'UTC+8',
    ],

    // ==================== 文件下载配置 ====================
    'download' => [
        'storage_path' => AppDataPaths::directory('downloads') . DIRECTORY_SEPARATOR,
        'temp_path' => AppDataPaths::directory('temp', 'downloads') . DIRECTORY_SEPARATOR,
        'max_file_size' => 524288000,                        // 最大单文件下载大小（字节，默认500MB）
        'max_concurrent' => 5,                               // 最大并发下载数
        'rate_limit_kbps' => 0,                              // 单连接下载速率限制（KB/s，0=不限制）
        'allowed_extensions' => [                            // 允许下载的文件类型扩展名列表
            // 文档类
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
            'md', 'epub', 'mobi', 'log', 'rtf', 'odt', 'ods', 'odp',
            // 图片类
            'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif', 'apng',
            // 音视频类
            'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma',
            'mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv',
            // 压缩包类
            'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz',
            // 代码类
            'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less',
            'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php',
            'swift', 'kt', 'dart', 'lua', 'sh', 'bat', 'ps1',
            'json', 'xml', 'yaml', 'yml', 'ini', 'conf', 'toml',
            'sql', 'r', 'm', 'mm', 'pl', 'pm',
        ],
        'allowed_mime_types' => [                            // 允许的 MIME 类型列表
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', 'text/csv', 'text/markdown',
            'text/html', 'text/css', 'text/javascript',
            'application/json', 'application/xml', 'text/xml',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
            'image/svg+xml', 'image/avif', 'image/apng', 'image/tiff',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac',
            'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
            'video/x-matroska', 'video/x-flv', 'video/x-ms-wmv',
            'application/zip', 'application/x-rar-compressed',
            'application/x-7z-compressed', 'application/gzip',
            'application/x-tar', 'application/x-bzip2', 'application/x-xz',
        ],
        'temp_file_ttl' => 3600,                              // 临时文件保留时间（秒，默认1小时）
        'temp_cleanup_interval' => 1800,                      // 临时文件清理间隔（秒，默认30分钟）
        'enable_permission_check' => true,                    // 是否启用下载权限校验
        'permission_levels' => [                              // 权限级别映射
            'admin' => ['all'],                               // 管理员：所有类型
            'user' => ['image', 'document', 'archive', 'code', 'audio', 'video'],
            'guest' => ['image', 'document'],                 // 访客：仅图片和文档
        ],
        'permission_categories' => [                          // 扩展名到类别的映射
            'image' => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif', 'apng'],
            'document' => ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'epub', 'mobi', 'rtf', 'odt', 'ods', 'odp'],
            'archive' => ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
            'code' => ['py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'dart', 'lua', 'sh', 'bat', 'ps1', 'json', 'xml', 'yaml', 'yml', 'ini', 'conf', 'toml', 'sql', 'r', 'm', 'mm', 'pl', 'pm'],
            'audio' => ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'],
            'video' => ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'],
        ],
        'log_enabled' => true,                                // 是否启用下载日志
        'log_path' => AppDataPaths::directory('logs', 'backend') . DIRECTORY_SEPARATOR,
        'enable_monitoring' => true,                          // 是否启用下载监控
        'monitor_alert_threshold' => 0.3,                     // 失败率告警阈值（30%）
        'monitor_window_minutes' => 5,                        // 监控滚动窗口（分钟）
        'sandbox_timeout' => 300,                             // 沙箱下载超时时间（秒）
    ],

    // ==================== 爬虫服务配置 ====================
    'crawler_api_url' => rtrim($python_service_domain, '/'),
    // 爬虫输出目录由本机运行时确认的当前用户数据根目录派生。
    'crawler_output_dir' => AppDataPaths::directory('crawler_output'),

    // ==================== 搜索服务配置 ====================
    // 实际生效的配置已统一到 deepseek_web_search.search_api_url
    // 保留此 key 作为向后兼容（api.php 旧代码会读取），新代码请读 deepseek_web_search
    'search_api_url' => rtrim($python_service_domain, '/'),

    // ==================== Agent 模式配置 ====================
    'agent_mode' => require __DIR__ . '/agent_config.php',

    // ==================== 阿里云 ASR 语音识别配置 ====================

    'aliyun_asr' => [
        'api_key'         => env('ALIYUN_ASR_API_KEY') ?: '',  // 百炼平台 API-Key
        'temporary_token_url' => env('ALIYUN_ASR_TEMPORARY_TOKEN_URL') ?: 'https://dashscope.aliyuncs.com/api/v1/tokens',
        'model'           => env('ALIYUN_ASR_MODEL') ?: 'fun-asr',
        'fallback_models' => array_values(array_filter(array_map('trim', explode(',', env('ALIYUN_ASR_FALLBACK_MODELS') ?: 'fun-asr,paraformer-v2,paraformer-v1,fun-asr-mtl')))),
        'realtime_models' => array_values(array_filter(array_map('trim', explode(',', env('ALIYUN_ASR_REALTIME_MODELS') ?: 'fun-asr-realtime,paraformer-realtime-v2,paraformer-realtime-v1')))),
        'websocket_url' => env('ALIYUN_ASR_WEBSOCKET_URL') ?: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/',
        'upload_policy_url' => env('ALIYUN_ASR_UPLOAD_POLICY_URL') ?: 'https://dashscope.aliyuncs.com/api/v1/uploads',
        'transcription_url' => env('ALIYUN_ASR_TRANSCRIPTION_URL') ?: 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription',
        'task_url_template' => env('ALIYUN_ASR_TASK_URL_TEMPLATE') ?: 'https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}',
        'max_wait_seconds' => max(1, (int)(env('ALIYUN_ASR_MAX_WAIT_SECONDS') ?: 30)),
        'poll_interval_microseconds' => max(1000, (int)(env('ALIYUN_ASR_POLL_INTERVAL_MICROSECONDS') ?: 500000)),
        'connect_timeout_seconds' => max(1, (int)(env('ALIYUN_ASR_CONNECT_TIMEOUT_SECONDS') ?: 5)),
        'request_timeout_seconds' => max(1, (int)(env('ALIYUN_ASR_REQUEST_TIMEOUT_SECONDS') ?: 20)),
        'upload_timeout_seconds' => max(1, (int)(env('ALIYUN_ASR_UPLOAD_TIMEOUT_SECONDS') ?: 60)),
        'result_timeout_seconds' => max(1, (int)(env('ALIYUN_ASR_RESULT_TIMEOUT_SECONDS') ?: 20)),
        'region'          => 'cn-beijing',                     // 地域
        'enable_vad'      => true,                             // 静音检测
        'enable_interim'  => false,                            // 是否返回中间结果
        'sample_rate'     => 16000,                            // 采样率
        'language_hints'  => ['zh', 'en'],                     // 语言提示
        // 以下字段保留兼容性（设计方案中提到，但实际使用 api_key 即可）
        'access_key_id'     => '',
        'access_key_secret' => '',
        'app_key'           => '',
    ],

];
