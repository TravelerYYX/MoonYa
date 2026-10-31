-- ============================================================
-- MoonYa ai_system — MySQL 8.0 全新 Schema（Harness 化重构 阶段2）
-- 来源：MariaDB 10.4.32 dump（2026-08-09）11 张保留表重写
-- 修正：去显示宽度、timestamp 默认值标准化、cu_run_checkpoints
--       解除对已删除 conversations 表的外键、email 可空（注册改造）、
--       补齐逻辑外键索引
-- ============================================================

CREATE DATABASE IF NOT EXISTS `ai_system`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `ai_system`;

-- ---------- 用户系统 ----------

CREATE TABLE `admins` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) NOT NULL COMMENT '管理员用户名',
  `password` varchar(255) NOT NULL COMMENT '管理员密码（加密）',
  `email` varchar(100) NOT NULL COMMENT '管理员邮箱',
  `role` enum('super_admin','admin') DEFAULT 'admin' COMMENT '角色',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员表';

CREATE TABLE `admin_login_tokens` (
  `id` int NOT NULL AUTO_INCREMENT,
  `token` varchar(64) NOT NULL,
  `user_id` int NOT NULL,
  `admin_id` int NOT NULL,
  `expires_at` datetime NOT NULL,
  `used` tinyint DEFAULT '0',
  `used_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_token` (`token`),
  KEY `idx_expires` (`expires_at`,`used`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_admin_id` (`admin_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员代登录令牌';

CREATE TABLE `admin_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admin_id` int DEFAULT NULL COMMENT '管理员ID',
  `action` varchar(100) NOT NULL COMMENT '操作动作',
  `target_user_id` int DEFAULT NULL COMMENT '目标用户ID',
  `details` text COMMENT '操作详情',
  `ip_address` varchar(45) DEFAULT NULL COMMENT 'IP地址',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_admin_id` (`admin_id`),
  KEY `idx_target_user_id` (`target_user_id`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员操作日志表';

CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL COMMENT '用户名',
  `password` varchar(255) DEFAULT NULL COMMENT '密码（加密，未设置时为NULL）',
  `email` varchar(100) DEFAULT NULL COMMENT '邮箱（选填，注册改造后不验证）',
  `real_name` varchar(100) DEFAULT NULL COMMENT '真实姓名',
  `gender` enum('male','female','private') DEFAULT NULL COMMENT '性别：male=男，female=女，private=保密',
  `avatar` varchar(255) DEFAULT NULL COMMENT '头像URL',
  `bio` varchar(200) DEFAULT NULL COMMENT '用户签名',
  `likes_count` int DEFAULT '0' COMMENT '获赞总数',
  `status` enum('active','banned','deleted') DEFAULT 'active' COMMENT '状态',
  `ban_reason` text COMMENT '封禁原因',
  `ban_until` datetime DEFAULT NULL COMMENT '封禁时间',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `api_token` varchar(255) DEFAULT NULL COMMENT 'API访问令牌',
  `token_created_at` timestamp NULL DEFAULT NULL COMMENT '令牌创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_status` (`status`),
  KEY `idx_api_token` (`api_token`(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';


-- ---------- 系统提示词 / 热点 / 设置 ----------

CREATE TABLE `system_prompts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL COMMENT 'prompt identifier: normal/programming/agent',
  `display_name` varchar(100) NOT NULL COMMENT '展示名',
  `prompt` text NOT NULL COMMENT '系统提示词正文',
  `applicable_models` text NOT NULL COMMENT 'JSON 数组；["*"]=全部模型',
  `enabled` tinyint NOT NULL DEFAULT '1' COMMENT '是否启用',
  `sort_order` int NOT NULL DEFAULT '0' COMMENT '列表展示顺序',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`),
  KEY `idx_name_enabled_sort` (`name`,`enabled`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统提示词模板表';

CREATE TABLE `hot_topics` (
  `id` int NOT NULL AUTO_INCREMENT,
  `topic` varchar(500) NOT NULL COMMENT '热点内容',
  `sort_order` int DEFAULT '0' COMMENT '排序顺序，越小越靠前',
  `is_active` tinyint DEFAULT '1' COMMENT '是否启用：0-否，1-是',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  KEY `idx_active_sort` (`is_active`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='热点话题表';

CREATE TABLE `site_settings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `setting_key` varchar(100) NOT NULL COMMENT '配置键',
  `setting_value` text COMMENT '配置值',
  `setting_label` varchar(255) DEFAULT NULL COMMENT '配置显示名',
  `setting_type` varchar(50) DEFAULT 'text' COMMENT '类型:text/select/boolean',
  `setting_options` text COMMENT 'select 类型的可选项 JSON',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `setting_key` (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='通用设置表';

-- ---------- Computer Use ----------

CREATE TABLE `cu_app_registry` (
  `id` int NOT NULL AUTO_INCREMENT,
  `app_name` varchar(100) NOT NULL COMMENT '应用名（用户可读）',
  `exe_name` varchar(255) NOT NULL COMMENT '进程名或可执行文件名',
  `window_title_regex` varchar(500) DEFAULT NULL COMMENT '窗口标题正则（用于匹配已运行窗口）',
  `launch_method` enum('win_menu','exe_path','shell') NOT NULL DEFAULT 'win_menu',
  `launch_args` varchar(500) DEFAULT NULL COMMENT '启动参数（exe_path 时为完整命令行）',
  `enabled` tinyint NOT NULL DEFAULT '1',
  `sort_order` int NOT NULL DEFAULT '0',
  `uia_supported` tinyint NOT NULL DEFAULT '1' COMMENT '是否支持 UIA 语义化操作',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_app_name` (`app_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='CU应用注册表';

CREATE TABLE `cu_run_checkpoints` (
  `run_id` char(36) NOT NULL,
  `user_id` int NOT NULL,
  `conversation_id` int NOT NULL COMMENT '逻辑关联（conversations 表已删除，仅保留索引）',
  `client_message_id` char(36) NOT NULL,
  `status` enum('running','recovering','completed','failed','cancelled') NOT NULL DEFAULT 'running',
  `current_layer` varchar(32) NOT NULL DEFAULT 'router',
  `iteration_no` int unsigned NOT NULL DEFAULT '0',
  `last_event_seq` bigint unsigned NOT NULL DEFAULT '0',
  `model_messages_json` longtext,
  `state_json` longtext,
  `pending_operation_id` varchar(64) DEFAULT NULL,
  `pending_operation_json` longtext,
  `pending_operation_status` enum('none','pending','succeeded','failed','unknown') NOT NULL DEFAULT 'none',
  `pending_result_json` longtext,
  `lease_owner` char(36) DEFAULT NULL,
  `lease_expires_at` datetime DEFAULT NULL,
  `last_error` varchar(2000) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`run_id`),
  UNIQUE KEY `uq_cu_checkpoint_message` (`user_id`,`conversation_id`,`client_message_id`),
  KEY `idx_cu_checkpoint_lease` (`status`,`lease_expires_at`),
  KEY `idx_cu_checkpoint_conversation` (`conversation_id`),
  KEY `idx_cu_checkpoint_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='CU运行检查点';

CREATE TABLE `cu_runtime_config` (
  `id` int NOT NULL DEFAULT '1',
  `cu_model` varchar(100) NOT NULL DEFAULT 'MiniMax-M3',
  `cu_max_iterations` int NOT NULL DEFAULT '1000',
  `cu_api_timeout` int NOT NULL DEFAULT '90',
  `stop_loss_tolerance_px` int NOT NULL DEFAULT '10',
  `uia_tree_depth` int NOT NULL DEFAULT '6',
  `uia_tree_max_elements` int NOT NULL DEFAULT '2000',
  `element_cache_ttl` int NOT NULL DEFAULT '60',
  `screenshot_max_long_edge` int NOT NULL DEFAULT '1568',
  `screenshot_max_pixels` int NOT NULL DEFAULT '1150000',
  `scenario_hints` text COMMENT '场景化提示词 JSON',
  `tool_descriptions` text COMMENT '工具描述 JSON，key=工具名 value=描述',
  `login_detection_keywords` text COMMENT '登录界面检测关键词 JSON 数组',
  `vls_model` varchar(100) NOT NULL DEFAULT 'moonshot-v1-8k-vision-preview' COMMENT 'VLS-Agent 视觉模型名',
  `vls_max_iterations` int NOT NULL DEFAULT '15' COMMENT 'VLS-Agent 最大迭代次数',
  `vls_failure_threshold` int NOT NULL DEFAULT '3' COMMENT 'VLS 连续失败降级到键盘策略阈值',
  `keyboard_fallback_hints` text COMMENT '键盘快捷键场景化策略 JSON',
  `screenshot_default_target` varchar(16) NOT NULL DEFAULT 'window' COMMENT '截图默认目标：window/screen',
  `screenshot_window_margin_px` int NOT NULL DEFAULT '0' COMMENT 'window-relative 截图外边距像素',
  `coordinate_restore_strategy` varchar(32) NOT NULL DEFAULT 'php_side' COMMENT '坐标还原策略：php_side/csharp_side',
  `uia_tree_format` varchar(8) NOT NULL DEFAULT 'text' COMMENT 'UIA 树输出格式：text/json',
  `user_login_intent_keywords` text COMMENT '用户登录意图关键词 JSON 数组',
  `user_intent_lookback_messages` int NOT NULL DEFAULT '3' COMMENT '用户意图回溯消息条数',
  `login_screen_force_complete_threshold` int NOT NULL DEFAULT '3' COMMENT '登录界面强制 task_complete 阈值',
  `empty_tool_calls_max_retries` int NOT NULL DEFAULT '2' COMMENT '空 tool_calls 重试次数上限',
  `task_complete_hash_compare_enabled` tinyint NOT NULL DEFAULT '1' COMMENT 'task_complete 前后 UIA hash 对比验证',
  `task_complete_evidence_keywords` text COMMENT 'task_complete 完成证据关键词 JSON 数组',
  `network_retry_max` int NOT NULL DEFAULT '5',
  `network_retry_base_delay_ms` int NOT NULL DEFAULT '1000',
  `network_retry_max_delay_ms` int NOT NULL DEFAULT '16000',
  `cu_total_timeout_seconds` int NOT NULL DEFAULT '0',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='CU模式运行时配置表';

-- Membership balances use millionths of a point; prices use CNY cents.
CREATE TABLE IF NOT EXISTS membership_plans (
 id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL,
 price_cents INT NOT NULL, monthly_units BIGINT NOT NULL,
 description VARCHAR(500) NOT NULL DEFAULT '', features_json JSON NOT NULL,
 is_free TINYINT NOT NULL DEFAULT 0, enabled TINYINT NOT NULL DEFAULT 1,
 archived TINYINT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS membership_accounts (
 user_id INT NOT NULL PRIMARY KEY, plan_id INT NOT NULL, subscription_json JSON NOT NULL,
 anchor_at DATETIME NOT NULL, expires_at DATETIME NULL, current_period_id BIGINT NULL,
 revision BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_periods (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
 starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, allowance_units BIGINT NOT NULL,
 balance_units BIGINT NOT NULL, INDEX idx_credit_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_calls (
 id CHAR(36) NOT NULL PRIMARY KEY, user_id INT NOT NULL, period_id BIGINT NOT NULL,
 model_id VARCHAR(128) NOT NULL, multiplier_units BIGINT NOT NULL,
 input_tokens BIGINT NULL, output_tokens BIGINT NULL, cost_units BIGINT NOT NULL DEFAULT 0,
 charged_units BIGINT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'running',
 created_at DATETIME NOT NULL, settled_at DATETIME NULL, INDEX idx_calls_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_ledger (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, period_id BIGINT NOT NULL,
 call_id CHAR(36) NULL UNIQUE, kind VARCHAR(32) NOT NULL, delta_units BIGINT NOT NULL,
 balance_units BIGINT NOT NULL, details_json JSON NOT NULL, created_at DATETIME NOT NULL,
 INDEX idx_ledger_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS builtin_models (
 id VARCHAR(128) NOT NULL PRIMARY KEY, label VARCHAR(128) NOT NULL,
 upstream_model VARCHAR(128) NOT NULL, endpoint VARCHAR(2048) NOT NULL,
 api_key TEXT NOT NULL, capabilities_json JSON NOT NULL, multiplier_units BIGINT NOT NULL,
 enabled TINYINT NOT NULL DEFAULT 1, archived TINYINT NOT NULL DEFAULT 0,
 is_default TINYINT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Encrypted payment settings and step-up authentication. No credentials or seeds.
CREATE TABLE IF NOT EXISTS payment_settings (
 id TINYINT NOT NULL PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0,
 envelope MEDIUMTEXT NULL, imported TINYINT NOT NULL DEFAULT 0,
 updated_by INT NULL, updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO payment_settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS payment_admin_mfa (
 admin_id INT NOT NULL PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0,
 envelope TEXT NULL, last_step BIGINT NOT NULL DEFAULT -1,
 bootstrap_hash CHAR(64) NULL, bootstrap_expires BIGINT NULL,
 generation BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS payment_email_limits (
    scope_hash CHAR(64) NOT NULL PRIMARY KEY,
    window_start BIGINT NOT NULL,
    sends INT NOT NULL DEFAULT 0,
    next_send_at BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_auth_attempts (
 scope_hash CHAR(64) NOT NULL PRIMARY KEY, failures INT NOT NULL DEFAULT 0,
 window_start BIGINT NOT NULL, blocked_until BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS payment_challenges (
 id CHAR(64) NOT NULL PRIMARY KEY, admin_id INT NOT NULL,
 revision BIGINT NOT NULL, mfa_generation BIGINT NOT NULL,
 envelope MEDIUMTEXT NOT NULL, expires_at BIGINT NOT NULL,
 consumed TINYINT NOT NULL DEFAULT 0,
 INDEX idx_payment_challenge_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
