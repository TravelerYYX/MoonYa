# MoonYa Harness 化重构实施方案

> 版本：v1.0（2026-09-13）
> 性质：重构实施文档。本文档本身不包含任何代码变更；所有代码/数据操作在后续按第八章的分阶段顺序另行执行。
> 关联文档：`MoonYa-Harness\docs\SUBAGENT_OFFICE_DEVELOPMENT.zh.md`（子代理-办公室投影契约，本方案直接引用，不重复定义）

---

## 一、背景与目标

### 1.1 现状问题

1. **后端与数据库混乱**：`MoonYa-Backend` 根目录 100+ 文件，其中约 40 个为 `test_*` / `debug*` / `diagnose*` / `check_*` / `migrate_*` / `fix-*.ps1` 类残留；数据库 60 张表横跨聊天、社区、影视、音乐、版本、移动端等十几个互相耦合的业务域。
2. **架构定位错误**：聊天数据上传后端（`api.php` SSE 主管道 + execution guard + conversation task state），与"harness 本地运行时"（`MoonYa-Harness`，已存在且已与 Win 壳对接）形成双轨制。
3. **数据库名不副实**：当前使用 XAMPP 捆绑的 MariaDB 10.4.32（`sql\数据库.sql` 头部标注），并非真正的 MySQL。

### 1.2 目标架构

```
MoonYa-Win (C# + CefSharp 壳)
   ├─ 加载主站 index.php（PHP 仅服务页面与静态资源，前端界面保留）
   ├─ 启动 MoonYa-Harness (Node, localhost)
   │      ├─ 聊天/会话/子代理/工具执行全部本地化
   │      └─ 会话数据存 %LOCALAPPDATA%\MoonYa\agent-runtime（不上传后端）
   └─ 办公室面板：数据源从 /api/team.php 轮询 → harness subagent 事件

MoonYa-Backend (PHP + MySQL 8.0) —— 只做四件事：
   ① 用户系统（登录/资料/VIP）
   ② 系统提示词（system_prompts 表 + 管理面板维护与显示）
   ③ 热点（hot_topics）
   ④ 管理面板（含 cu_* 应用注册维护、site_settings）
```

### 1.3 重构原则

- **分批执行、每批验证**：按第八章顺序推进，每阶段有回归验证点，不一次性大爆炸。
- **先备份后动手**：提示词归档、旧库完整 dump 先行。
- **删除前查引用**：所有删除项执行前全局 grep 引用，避免删出死链。
- **办公室 UI 保留**：作为 harness 生成子代理的办公室，按已有契约改造数据源，不重写。

---

## 二、现状盘点

### 2.1 组件架构

| 组件 | 技术 | 职责 | 处置 |
|---|---|---|---|
| MoonYa-Win | C# + CefSharp（`MoonYa-Win\MoonYa-Solution\MoonYa`） | 桌面壳；`launcher_config.json` 配置并启动 `MoonYa-Harness\src\server.mjs`；`MoonYaLifeSpanHandler.cs` 将 `office/index.php` 弹出为独立窗口 | 保留，联动清理 |
| MoonYa-Backend | PHP + MariaDB 10.4（库 `ai_system`） | 前端界面（`index.php` + `script/MoonYa-index/`）+ 全部业务 API | 前端界面保留；后端精简 |
| MoonYa-Harness | Node；`foundation/` 为 deepseek-harness 内置副本；`src/server.mjs` 暴露 `/health`、`/v1/runtime/shutdown`、`/v1/tools`、`/v1/prompt`、`/v1/sessions` | 本地 agent 运行时 | 保留，成为唯一聊天运行时 |
| MoonYa-Python | Python 微服务（web_search / web_crawler / web_speech） | 搜索/爬虫/语音 | 保留 |
| deepseek-harness-master | 开源参考 | everything-is-a-plugin、工具契约 | 仅参考，不改动 |

### 2.2 关键链路事实

1. **办公室 UI 嵌在主站 `index.php`**：`script/MoonYa-index/layouts/office-panel.php` + `modules/script-5-office.php`；`office/index.php`（864 字节）仅为 `Location: ../index.php?office_popout=1` 重定向入口。
2. **办公室当前数据源**：独立窗口模式下 3 秒轮询 `GET /api/team.php?action=office_status`（`script-5-office.php` L8、L525）——属旧 agent 团队体系，将删除并切换。
3. **聊天本地化现成链路**：`harness_api.php` 已实现——鉴权 → 从 `system_prompts` 表读 persona（`SELECT prompt FROM system_prompts WHERE name = ? AND enabled = 1 ORDER BY sort_order ASC, id ASC LIMIT 1`，L459）→ `Services/AgentRuntimeClient.php` 对接本地 harness → SSE 转发运行时事件（`streamRuntimeEvents`）。
4. **harness 提示词组装**：`MoonYa-Harness\src\prompt.mjs` 的 `assembleSystemPrompt()` = persona（来自后端 system_prompts）+ 受控段落（identity/workflow/tools/safety）+ browser 段落 + workspace 段落。
5. **注册依赖邮件**：`user_auth.php` L71-125，注册用邮箱验证码（`$_SESSION['verification_code']` / `verification_email` / `verification_time`）。**删除邮件前必须先改造注册流程**（见 5.4）。
6. **搜索设置现状**：`script/dashboard/site_settings.php` 中"搜索设置"区块（`chat_search_backend`：`moonshot` 原生 web_search vs `function_calling` + Python 搜索服务），控制 Chat 模式下 Kimi 联网搜索行为。

### 2.3 数据库全表处置清单（60 张；`sql\数据库.sql` 60 张 CREATE TABLE，`migrate_execution_guard_v1.sql` 的 3 张 execution 表与主 dump 重复，不重复计数）

**保留（11 张）**

| # | 表 | 用途 | 备注 |
|---|---|---|---|
| 1 | `admins` | 管理员账号 | |
| 2 | `admin_login_tokens` | 管理员登录令牌 | |
| 3 | `admin_logs` | 管理员操作日志 | |
| 4 | `users` | 用户主表 | 用户系统核心 |
| 5 | `vip_codes` | VIP 兑换码 | 用户系统 |
| 6 | `system_prompts` | 系统提示词 | harness persona 数据源；管理面板维护 |
| 7 | `hot_topics` | 热点 | 明确保留 |
| 8 | `site_settings` | 通用设置 | 用户确认保留；删除其中搜索设置相关行 |
| 9 | `cu_app_registry` | Computer Use 应用注册（exe/窗口标题正则/启动方式/UIA 支持） | 用户确认保留 |
| 10 | `cu_run_checkpoints` | CU 运行检查点 | 用户确认保留 |
| 11 | `cu_runtime_config` | CU 运行时配置 | 用户确认保留 |

**删除（49 张，按功能分组）**

| 分组 | 表 | 数量 |
|---|---|---|
| 启动页/广告 | `splash_pages`、`ad_config` | 2 |
| agent 团队与调度 | `agents`、`agent_delegations`、`agent_routing_capabilities`、`agent_runtime_config`、`agent_tool_grants`、`team_artifacts`、`team_event_media`、`team_project_actors`、`team_project_groups`、`team_runs`、`team_run_events` | 11 |
| 版本保留 | `version_updates`、`app_update_config` | 2 |
| 移动端 | `mobile_updates` | 1 |
| 网页功能 | `webpages`、`work_projects`、`work_project_texts` | 3 |
| 社区 | `community_posts`、`community_comments`、`community_likes`、`community_favorites`、`community_follows`、`community_notifications`、`community_reports`、`community_system_messages` | 8 |
| 聊天数据（不上传后端） | `conversations`、`messages`、`chat_attachments`、`conversation_agent_settings`、`conversation_task_state` | 5 |
| 娱乐残留 | `music`、`music_settings`、`favorites`、`watch_history` | 4 |
| MCP 配置（本地化到 harness） | `mcp_servers`、`mcp_tool_catalog`、`user_mcp_connections` | 3 |
| 审批守卫（走 harness 本地 approval） | `tool_approvals`、`browser_action_confirmations`、`browser_site_permissions`、`execution_jobs`、`execution_job_events`、`local_tool_requests` | 6 |
| 人格/工具设置/API 域名 | `personality`（归档后删）、`tool_registry`、`tool_settings`、`api_domain_config` | 4 |
| **合计** | | **49**（归档先行：`agents` 提示词、`personality`、`tool_settings` 工具提示词见第六章） |

---

## 三、数据库重构（MariaDB 10.4 → MySQL 8.0）

目标实例：`C:\Program Files\MySQL\MySQL Server 8.0\`。

### 3.1 新库 DDL 规范

- 库名 `ai_system`，`utf8mb4` / `utf8mb4_unicode_ci` / InnoDB。
- 只建 2.3 节的 11 张保留表，全新编写 DDL（不直接复用旧 dump）。
- 修正 MariaDB 遗留写法：去掉 `int(11)` / `tinyint(4)` 显示宽度；`timestamp` 明确 `NULL`/`NOT NULL` 与默认值；`DEFAULT current_timestamp()` 统一为标准 `DEFAULT CURRENT_TIMESTAMP`。
- 补齐逻辑外键与索引（如 `admin_logs.admin_id`、`vip_codes` 唯一约束、`system_prompts(name, enabled, sort_order)` 复合索引）。

### 3.2 迁移步骤

1. 旧库全量备份：`mysqldump` 导出 MariaDB `ai_system` 整库 SQL，存档（回滚依据）。
2. 在 MySQL 8 新建库并执行新 DDL。
3. 仅导出 11 张保留表**数据**：`mysqldump --no-create-info --complete-insert` 后导入 MySQL 8（注意 `sql_mode` 与零日期兼容）。
4. 数据核对：逐表 `SELECT COUNT(*)` 对账；`users`、`system_prompts`、`hot_topics` 抽样比对内容。
5. `config.php` / `.env` 的 PDO DSN 切到 MySQL 8。
6. 停用 XAMPP MariaDB 服务（见 3.3 端口决策）。

### 3.3 端口与认证风险（执行前必须决策）

- **端口冲突**：XAMPP MariaDB 默认占 3306，独立 MySQL 8 也默认 3306。
  - 方案 A（推荐）：Windows 服务中禁用 MariaDB（mysql/mariadb 服务），MySQL 8 使用 3306，`.env` 无需写端口。
  - 方案 B：MySQL 8 改 3307，`.env` 写 `DB_PORT=3307`。
  - 严禁两个服务同时占 3306 运行——会"连错库"且极难排查。
- **认证插件**：MySQL 8 默认 `caching_sha2_password`。PHP 7.4+ 且启用 mysqlnd 时 PDO 原生支持；若 XAMPP PHP 版本过老，为应用账号执行 `ALTER USER ... IDENTIFIED WITH mysql_native_password`。

### 3.4 回滚方案

MySQL 8 迁移失败时：切回 `.env` 指向 MariaDB（3306 或原端口），恢复原 `config.php`；归档 dump 可完整还原旧库。

---

## 四、功能删除清单（10 项逐条）

> 前提共识（用户确认）：`index.php`、`script/MoonYa-index/`、`assets/`、`font/`、`toast/` 属**前端界面**，保留。以下为后端侧删除。

### 4.1 启动页（整体删掉）

- 代码：`admin/api/splash_pages.php`、`api/splash_pages/`（含 API_DOCUMENTATION.md）、`script/dashboard/splash_pages.php`、`admin/dashboard.php` 中启动页管理入口、前端启动图渲染逻辑。
- 数据表：`splash_pages`、`ad_config`（开屏广告，同属启动展示链路）。

### 4.2 agent 团队（改为 harness 生成子代理）

- 代码：`api/team.php`、`admin/api/agent_team.php`、`agent_config.php`、`migrate_multi_agent_v1.php`；`Services/` 中 `AgentLoopGuard.php`、`CapabilityRouter.php`、`AIAssistant.php` 等旧调度类（保留 `AgentRuntimeClient.php`、`BrowserAutomationGateway.php`、Cu* 系列——见第五章）。
- 数据表：团队 11 张（2.3 节）。
- 联动开发项：办公室 `office_status` 轮询切换为 harness 事件（见 5.3）。

### 4.3 版本保留（代码与数据库都删）

- 代码：`admin/api/updates.php`、`init_version_updates.php`、`admin/DownloadLogger.php`、`admin/DownloadMonitor.php`、`admin/dashboard.php` 版本管理入口；MoonYa-Win 内更新检查逻辑（执行时在 `MoonYa-Win\MoonYa-Solution` 内 grep `update`/`version` 定位）。
- 数据表：`version_updates`、`app_update_config`。

### 4.4 移动端（删掉）

- 代码：`api/mobile_updates/`、`admin/api/mobile_updates.php`、`script/dashboard/mobile_updates.php`、`admin/dashboard.php` 移动端管理入口。
- 数据表：`mobile_updates`。

### 4.5 热点（**保留**）

- 保留：`hot_topics` 表、`hot_topics_api.php`、`admin/api/hot_topics.php`、前端热点展示与调用全链路。

### 4.6 网页功能（含数据库，删掉）

- 代码：`webpage_api.php`、`webpage_preview.php`、`api/work_projects.php`、管理面板网页管理入口。
- 数据表：`webpages`、`work_projects`、`work_project_texts`。
- 联动开发项：`script/MoonYa-index/modules/script-1f-work-project.php`（Work 模式项目绑定）改为本地存储（harness 工作区/本地文件），不再走后端。

### 4.7 社区（删掉）

- 代码：`community/` 整目录（api/css/js/auth-bridge.js/detail.php/index.php/profile.php）、`admin/api/community.php`、前端社区入口与导航。
- 数据表：社区 8 张。

### 4.8 邮件（删掉）

- 代码：`send_email.php`、`SimpleSMTP.php`、`admin/api/email.php`、邮件相关配置项。
- **前置条件（必须先做）**：注册流程改造（见 5.4），否则用户系统直接瘫痪。

### 4.9 搜索设置（删掉，包括代码中的）

- 代码：`script/dashboard/site_settings.php` 中"搜索设置"区块（`chat_search_backend` 及 moonshot/function_calling 选项逻辑）、`admin/api_domain.php` 中对应配置项。
- 数据：`site_settings` / `api_domain_config` 中搜索相关配置行。
- 边界（用户确认）：**搜索工具本身保留**，MoonYa-Python 的 web_search/web_crawler 保留，API key 等改本地 `.env` 默认配置。

### 4.10 API 域名配置（删掉）

- 代码：`admin/api_domain.php`、`admin/api/api_domain.php`、`api/get_domain_config.php`、`config.php` 的 `get_api_domain_config()` 及 APCu 缓存逻辑（配置全部改走 `.env`）。
- 数据表：`api_domain_config`。

### 4.11 补充清理（"后端整体重构"组成部分）

| 类别 | 删除项 |
|---|---|
| 聊天后端管线 | `api.php`（旧 SSE 主管道 + execution guard + conversation task state）、`conversation_api.php`、`conversation_api_debug.php`、`attachment_upload.php`、`upload.php`、`deepseek_upload.php`、`kimi_upload.php`、`model_router.php`、`workers/`、`Services/ConversationTaskState.php`、`uploads/` |
| 娱乐站 | `YX_VIDEO/` 整目录（影视站）、`video_gen/`、`music_api.php`、`pet/`、`creation/`、`sandbox/` |
| 工具设置 | `tool_registry`/`tool_settings` 相关 API、`admin/api/tool_settings.php`、`admin/fix_tool_settings.php`；**写作助手、翻译助手功能整体删除** |
| 审批守卫 | `api/browser_permissions.php`、`migrate_execution_guard_v1.sql`（审批改走 harness 本地 `approval.required` 机制） |
| 测试/调试残留（根目录） | `test_*`（约 25 个 php/py）、`debug*`、`diagnose*`、`check_*`、`migrate_*.php`（5 个）、`vls_test*.php`、`cu_smoke_test.php`、`cu_reliability_test.php`、`cu_debug.log`、`fix-*.ps1`、`verify*.ps1`、`split*.ps1`、`create-placeholders.ps1`、`redo-modules.ps1`、`tmp_fix_users.py`、`redesign_dashboard.py`、`*_out.txt`、`_test_*` |
| 管理面板调试工具 | `admin/debug_images.php`、`admin/debug_login.php`、`admin/fix_password.php`、`admin/fix_personality.php`、`admin/fix_users_table.php`、`admin_login_as.php`、`admin/api/test.php` |

### 4.12 灰区清单（执行时逐一核对引用后处置）

| 项 | 疑点 | 处置原则 |
|---|---|---|
| `api/download.php` / `download_crawler.php` / `download_search.php` | 版本下载 or agent 下载工具 | grep 调用方：仅版本链路→删；agent 在用→保留 |
| `image-backend.php`、`image/` 目录 | 聊天图片生成后端 + UI 素材混放 | 业务代码随聊天本地化删除；`image/` 中被前端引用的素材保留 |
| `downloads/`（generated_images） | 聊天生成图片输出 | 随聊天本地化迁移本地，后端目录删 |
| `https_server.php` | 本地 HTTPS 调试服务 | 确认无人使用后删 |
| `file_content.php`（根目录） | 与 admin/file_content.php 重复 | 确认引用后删根目录版本 |
| `api/asr_test.php` | ASR 测试残留 | 删（asr.php/asr_key.php/tts.php 正式接口保留） |

---

## 五、保留与改造清单（开发项）

### 5.1 后端保留（最终形态）

```
MoonYa-Backend/
├─ index.php                    # 前端界面壳（保留）
├─ office/index.php             # 办公室弹出入口（重定向，保留）
├─ script/MoonYa-index/         # 前端界面模块（保留，团队/社区/移动端等入口清除）
├─ assets/ font/ toast/         # 前端静态资源（保留）
├─ user/                        # account_settings / edit_profile / user_xinxi
├─ user_auth.php user_profile.php user_xinxi.php   # 用户系统 API
├─ hot_topics_api.php           # 热点 API
├─ harness_api.php              # 唯一聊天桥（改造，见 5.2）
├─ config.php（重写）env_loader.php .env            # 配置纯 .env 化
├─ admin/                       # 精简：login/dashboard/users/system_prompts/
│                               #       hot_topics/site_settings/cu_* 维护
├─ api/                         # 精简：asr.php asr_key.php tts.php cu_health.php
├─ Services/                    # 精简：AgentRuntimeClient BrowserAutomationGateway Cu*
├─ asr-ws-proxy/                # 语音 WebSocket 代理（保留）
└─ sql/                         # MySQL 8 新 schema + 迁移脚本
```

### 5.2 聊天本地化改造（本重构最大开发项）

现状：普通 Chat 模式走 `api.php`（PHP 直连模型、SSE、execution guard、会话写库）；Work/Coding 模式走 `harness_api.php` → 本地 harness。

目标：**删除 `api.php` 双轨制，`harness_api.php`（或前端直连本地 harness server）成为唯一聊天链路**，会话数据只存 `%LOCALAPPDATA%\MoonYa\agent-runtime`。

要点：
1. 前端 `script/MoonYa-index/modules/script-1*.php` 中聊天发送/历史加载逻辑改指向本地 harness 会话接口（`/v1/sessions` 等，经 Win 壳桥接或 `harness_api.php` 透传）。
2. 历史会话列表、消息渲染改读本地 session store（`MoonYa-Harness\src\session-store.mjs`）。
3. persona 继续由后端 `system_prompts` 表下发（现链路保留），模型 API key 等配置本地化。
4. 旧 `conversations`/`messages` 表数据不迁移（用户明确：聊天数据不上传后端）。

### 5.3 办公室数据源切换

- 删除 `script-5-office.php` 对 `/api/team.php?action=office_status` 的 3 秒轮询。
- 改为 harness 子代理事件驱动：`subagent/catalog`（目录事实）→ 动态创建人物与工位；`subagent/start` → 运行中；`subagent/end` → 完成/失败/取消。
- 严格遵守 `MoonYa-Harness\docs\SUBAGENT_OFFICE_DEVELOPMENT.zh.md`：`(work_session_id, child_id)` 幂等键、SSE 重连去重、事件单调序号、无职业分类、完成后工位保留、跨会话隔离。
- 配套测试要求按该文档"未来测试要求"章节执行（单/多子代理、四种终态、乱序补齐等）。

### 5.4 注册流程改造（邮件删除的前置条件）

`user_auth.php` 当前：邮箱 + 验证码（session 存储）注册，用户名由邮箱派生。

改造方案：用户名 + 密码直接注册；邮箱改为选填、不验证（仅作展示/找回预留字段，不发码）。`users` 表结构不变（email 列保留可空）。

### 5.5 MoonYa-Win 联动清理

1. 删除更新检查逻辑（版本功能删除后）。
2. MCP 配置本地化：`McpClientManager.cs` 改读本地配置文件（原 `mcp_servers`/`user_mcp_connections` 表数据导出为本地 JSON）。
3. `PetChatBridge.cs`（`petChat.updateReply`/`finishReply`）链路确认在新聊天链路下继续工作。
4. `AgentRuntimeService.cs` 启动 harness 的逻辑保持不变（已是目标形态）。

### 5.6 MoonYa-Python 配置本地化

`service_config.json` / 相关 API key 从后端管理面板配置改为本地 `.env` 或本地配置文件；服务本身与调用链不动。

---

## 六、提示词归档方案（JSON）

### 6.1 归档范围

| 源 | 内容 | 处置 |
|---|---|---|
| `agents` 表 | 各专业 Agent 定义与提示词 | 全量归档 → 删表 |
| `personality` 表 | AI 人格（name/description/use_custom） | 全量归档 → 删表 |
| `tool_settings` 表 | 写作助手、翻译助手等工具提示词 | 全量归档 → 删表、删功能 |
| `system_prompts` 表 | 甄别：旧 agent 体系条目归档；通用条目保留在库 | 部分归档 |

### 6.2 存放位置与结构

位置：`MoonYa-Harness\docs\prompts-archive\`（日后封装插件时程序化读取）。

```
prompts-archive/
├─ index.json            # 归档总索引
├─ agents.json
├─ personality.json
└─ tool_settings.json
```

单文件结构：

```json
{
  "archived_at": "2026-09-13T00:00:00+08:00",
  "source_table": "agents",
  "source_database": "ai_system (MariaDB 10.4.32)",
  "schema_notes": "原表字段说明：id/agent_key/…（执行时按实际 SHOW CREATE TABLE 补全）",
  "records": [
    { "id": 1, "agent_key": "…", "prompt": "…", "…": "原表各行完整数据" }
  ]
}
```

`index.json` 记录各文件的表名、行数、归档时间与用途注记（"留待封装插件"）。

---

## 七、前端工具调用审计（参考 deepseek-harness-master）

### 7.1 审计结论（三态）

**保留（已接线，契约完整）：**

- MoonYa-Harness `src/tools.mjs` 的 17 个 CODING_TOOLS：`read_file`、`view_directory`、`glob`、`grep`、`edit_file`、`create_file`、`delete_file`、`execute_command`、`get_command_status`、`stop_command`、`get_diagnostics`、`find_references`、`goto_definition`、`todo_write`、`plan_write`、`goal_write`、`browser_automation_control`。每个都有 schema + 执行分发 + 调用链，与 deepseek-harness `core/tools` 契约（ToolSchema / 执行函数 / 调度元数据）对齐，无死工具。
- MoonYa-Win 本地能力：`ExecutionApiServer.cs`（命令/Python 执行、历史、风险评估、沙箱）、`McpClientManager.cs`（MCP 客户端）。
- MoonYa-Python：web_search / web_crawler / web_speech（用户确认保留）。

**删除：**

- PHP 后端 `tool_registry` / `tool_settings` 旧 agent 工具体系；写作助手、翻译助手提示词功能整体。
- 办公室对 `team.php` 的轮询依赖（工具链路角度属旧调度体系）。

**待查（执行代码重构阶段逐项核实）：**

- `api/download*.php` 三件（4.12 灰区）。
- `image-backend.php` 图片生成链路在新架构下的归属（本地化 or 删除）。
- `Services/BrowserAutomationGateway.php` 与 harness `browser_automation_control` 的调用关系确认（预期保留）。
- MoonYa-Win 内 MCP 工具列表中是否存在零调用的注册项。

### 7.2 审计方法

1. 对照 `deepseek-harness-master\docs\subsystems\tools.md` 的工具注册契约，逐工具检查 schema / 执行函数 / UI 回调三件套完整性。
2. 全局 grep 每个工具名的调用点，零调用 → 死工具，删除。
3. MCP 本地化后验证 `McpClientManager` 读本地配置的链路（`list_tools` / `call_tool` / `configure` / `health`）。

---

## 八、分阶段执行顺序与验证点

> 每阶段结束执行对应验证点，全部通过才进入下一阶段。代码阶段（4-7）在后续任务中逐批执行。

| 阶段 | 内容 | 验证点 |
|---|---|---|
| **0 准备与备份** | MariaDB 全库 dump 归档；git 提交当前状态 | dump 文件可打开、含 60 张表；工作区干净 |
| **1 提示词归档** | 按 6.1 导出 4 类来源为 JSON 至 `MoonYa-Harness\docs\prompts-archive\` | 每文件 `records` 行数与 `SELECT COUNT(*)` 一致；`index.json` 完整；抽查 3 条内容与库内一致 |
| **2 MySQL 8 建库** | 处理端口冲突（3.3 决策）；建库执行新 DDL（11 表） | `SHOW TABLES` 恰好 11 张；无 MariaDB 遗留语法告警 |
| **3 数据迁移与切换** | 导 11 表数据；`config.php`/`.env` 切 MySQL 8 | 逐表 COUNT 对账；抽样比对 users/system_prompts/hot_topics；登录、管理面板、热点页全部正常 |
| **4 注册改造 + 聊天本地化** | 5.4 注册直注；5.2 `harness_api.php` 成为唯一聊天桥，删 `api.php` 双轨 | 新用户注册/登录 OK；Chat 与 Work 模式均出话；会话只出现在 `%LOCALAPPDATA%\MoonYa\agent-runtime`，后端库无新聊天行 |
| **5 办公室切换** | 5.3 事件驱动改造；删 team.php 轮询 | 按 SUBAGENT_OFFICE_DEVELOPMENT 测试清单：多子代理创建、四终态、重连去重、会话隔离 |
| **6 功能删除（分批）** | 按 4.1→4.10 顺序 + 4.11 补充清理 + 4.12 灰区核实 | 每删一批：主站打开无 console 报错、无 404 请求；grep 确认无残留引用；管理面板各保留页正常 |
| **7 前端与 Win 壳清理** | 5.5 更新检查/MCP 本地化/PetChatBridge 确认；5.6 Python 配置本地化 | Win 壳启动→办公室弹出→聊天→热点→用户中心全链路走通；MCP list_tools 正常 |
| **8 收尾** | 测试残留清空；`sql/` 定稿；本文档更新执行记录 | 后端根目录无 test/debug/migrate 残留；验收清单（第十章）全勾 |

---

## 九、风险登记册

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **端口冲突**：MariaDB 与 MySQL 8 都默认 3306 | 连错库、数据错乱 | 阶段 2 强制先做 3.3 决策；切换后 `SELECT @@version` 验证 |
| 2 | **认证插件**：`caching_sha2_password` 老PHP不支持 | PDO 连接失败 | 阶段 2 验证连接；必要时 `mysql_native_password` |
| 3 | **邮件-注册耦合**：删邮件导致注册瘫痪 | 新用户无法注册 | 阶段 4 先改注册（5.4）再删邮件（阶段 6） |
| 4 | **多端同步消失**：聊天本地化 | 产品行为变化 | 用户已确认接受；文档明示 |
| 5 | **Chat 模式切换工作量**：`api.php` 功能面大（流式、附件、多模型） | 阶段 4 是最大开发项 | 分两步：先并行跑通 harness 链路，再删旧管线 |
| 6 | **办公室切换回归**：事件驱动改造涉及 SSE/幂等/乱序 | 办公室状态错乱 | 严格按契约文档测试清单 |
| 7 | **迁移丢数据** | 用户/提示词/热点丢失 | 阶段 0 全量 dump + 阶段 3 对账，双保险 |
| 8 | **删除引发的隐蔽引用**（如 `script-1b-features.php` 引用被删 API） | 前端报错 | 每批删除后 console + 404 扫描（阶段 6 验证点） |

---

## 十、验收清单

- [ ] 10 条删除指令逐条有"代码文件 + 数据表"清单并执行（热点明确保留）
- [ ] 60 张表处置完毕：11 保留（MySQL 8）+ 49 删除，无未处置项
- [ ] 后端最终形态符合 5.1 目录清单，根目录无测试/调试残留
- [ ] `SELECT @@version` 返回 8.0.x；连接配置无 api_domain_config 依赖
- [ ] 管理面板可显示与维护系统提示词（system_prompts）
- [ ] 提示词 JSON 归档四件 + index.json 齐全，行数对账一致
- [ ] 聊天数据零上传：后端库无聊天新写入，本地 agent-runtime 正常增长
- [ ] 办公室由 harness 子代理事件驱动，通过 SUBAGENT_OFFICE_DEVELOPMENT 测试清单
- [ ] 注册不再依赖邮件验证码；搜索设置 UI 消失但搜索工具可用
- [ ] MoonYa-Win 无更新检查调用；MCP 走本地配置
- [ ] 工具审计三态清单闭环：保留项全部有调用链，删除项无残留，待查项均有结论

---

## 附录 A：已确认决策记录（2026-09-13）

1. 前后端边界：`script/MoonYa-index` 等页面为前端界面（保留）；`admin/` 及 `api.php` 等业务 API 为后端（精简对象）。
2. `cu_*` 三表与 `site_settings` 保留；娱乐残留、MCP 三表、审批守卫六表、personality 删除。
3. agent 提示词 JSON 结构化归档至 `MoonYa-Harness\docs\prompts-archive\`。
4. 搜索只删设置，工具与 MoonYa-Python 保留。
5. MySQL 8 迁移采用"新建干净库 + 只导保留表数据"。
