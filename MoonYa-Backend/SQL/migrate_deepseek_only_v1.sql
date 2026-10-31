-- ============================================================================
-- migrate_deepseek_only_v1.sql
-- ----------------------------------------------------------------------------
-- 项目完成“只保留 DeepSeek”收敛后的一次性数据迁移。
--
-- 适用场景：**已经安装过旧版本**的数据库（曾包含 Kimi / MiniMax / GLM 模型路由，
--           以及 ZTimage-Agent 图片生成、Image Agent 图片/视频理解子代理）。
--
-- 全新安装不需要执行本脚本 —— sql/数据库.sql 已同步为 DeepSeek 专用版本。
--
-- 说明：
--   * 模型目录（Kimi/MiniMax/GLM 的 api_key / api_url）原本只存在于
--     MoonYa-Backend/config.php，不落库，因此无需数据迁移。
--   * 图片/视频生成此前由前端 + api.php 直连 MiniMax / CogView 完成，
--     未落库，因此也无需数据迁移。
--   * 本脚本只处理确实落库的遗留：system_prompts、agents、site_settings。
-- ============================================================================

-- 1) 删除已废弃的子代理提示词（图片生成 / 图片视频理解）
DELETE FROM `system_prompts` WHERE `name` IN ('ztimage_agent', 'image_agent');

-- 2) 删除已废弃的 Agent 注册行
DELETE FROM `agents` WHERE `agent_key` = 'image_agent';

-- 3) Chat 模式联网搜索后端：移除 Moonshot 原生 web_search 选项，
--    统一为“自建 Python 搜索服务（function_calling）”。
UPDATE `site_settings`
SET `setting_value`   = 'function_calling',
    `setting_label`   = 'Chat 模式联网搜索后端',
    `setting_options` = '{"auto":"🤖 自动（推荐）— 系统智能选择","function_calling":"Function Calling + Python 搜索服务"}',
    `updated_at`      = NOW()
WHERE `setting_key` = 'chat_search_backend'
  AND (`setting_options` LIKE '%moonshot%' OR `setting_value` = 'moonshot');

-- 4) 历史会话/事件表中的 model='kimi' 等字段属于历史数据，保留不动。
