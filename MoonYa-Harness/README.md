# MoonYa Agent Runtime

MoonYa 的本地编码执行运行时。它提供版本化会话事件、可重连 SSE、分段系统提示词、OpenAI-compatible 模型循环，以及对 MoonYa Windows 文件、PowerShell 和 LSP 服务的统一工具协议。

开发启动：

```powershell
npm ci
npm run build:subagents
npm test
npm start
```

四种真实语言工程闭环夹具：

```powershell
.\scripts\verify-language-fixtures.ps1
```

默认监听 `127.0.0.1:58907`，数据保存在 `%USERPROFILE%\.MoonYa\agent-runtime`。运行时不发送遥测，也不接受带浏览器 `Origin` 的直接请求；Web 界面统一通过已登录的 PHP 适配层访问。

自定义供应商保存在同一数据根目录的 `config.toml`，使用标准 TOML 解析器与原子替换，保留其他配置项。PHP 的 `model_api.php` 提供登录鉴权后的配置、目录与连接测试；读取只返回 `has_key`。前端保存和发送模型引用，运行时解析实际地址与密钥；目录获取及测试不保存草稿。预设目录来自各提供商官方文档，获取失败时显示来源和错误，未知模型使用 32K/4K、文本和工具调用的保守默认值。

`model-client.mjs` 适配 OpenAI Chat Completions 和 Anthropic Messages。Work 子代理继承启动轮次的完整配置；Anthropic 原始内容块与签名在本机保留。Chat 的逐条流式日志保存在 `chat/runs`，断线按序号续订同一轮，显式停止会中断上游。进程重启后未完成的生成记录标为中断，不自动重发请求。

桌面、运行时、PHP 和 Python 的新数据使用 `.MoonYa`，浏览器资料、下载、凭据、附件、日志和程序临时文件均由该根目录派生。源码、资源、指定项目目录与服务端数据库保留原位置。源码不包含旧数据迁移逻辑，旧安装的数据需在关闭程序后单独备份和迁移。

配置字段、协议回放、数据布局和验证入口见[自定义模型与本机存储](docs/CUSTOM_MODELS_AND_STORAGE.zh.md)。

`/health` 的 `runtime_capability_version: 2` 与 `capabilities` 声明 Python 实体桌面、完整工具交互压缩、发送前历史校验和 `subagent-office-v1` 能力。客户端要求这些能力均存在；旧实例仍可通过原退出端点释放端口，但不能作为新版客户端的可用运行时。

Windows Build/Publish 会运行 `scripts/verify-runtime-package.ps1`，逐个校验输出中的 Harness、Python 桥接和 Computer Use 技能与源码一致。修改源码后必须重新构建并重启客户端；已启动的 Node 进程不会热更新。发布包中的单文件运行时同样必须通过能力检查。

浏览器默认使用内置面板，冷启动直接 `navigate`，无需选择项目。Chrome 和 Edge 必须明确指定并在插件页面开启对应权限，使用独立自动化窗口；内置失败不会自动回退。参数、原生设置、取消协议和测试入口见[浏览器自动化](docs/BROWSER_AUTOMATION.zh.md)。

会话恢复只采用工具调用配对有效的压缩检查点；旧版无历史检查点会重放原始事件。缺少持久化结果的调用记录执行状态未知，不重复执行。旧日志中被截断的截图要求重新观察，不将残缺 base64 当成视觉证据。

权限菜单提供请求批准（`confirm_writes`）、帮我批准（`high_risk`）和完全访问权限（`full_access`）。请求批准允许项目内常规文件读写与宿主确认的低风险只读命令；项目外修改、删除、任务联网、任意 Python、电脑操作和影响不明确的命令统一进入一次性批准流程。帮我批准由当前聊天模型的独立、无工具审核请求决定；拒绝后禁止本轮自动改换高风险工具重试，超时、调用失败或无效响应转为用户批准。完全访问权限跳过权限确认，仍保留工具参数、命令语法、浏览器协议和明确禁止规则。

默认权限保存在本机用户偏好中，只影响新聊天；每个聊天的选项单独保存。旧聊天缺少记录时使用请求批准。桌面网关通过 `harness_api.php?action=permissions` 转发 `POST /v1/sessions/:id/permissions`，校验登录用户、聊天和工作目录；会话摘要提供 `approval_mode`，`permissions.updated` 和 `permission.reviewed` 写入事件日志。同一聊天的执行会话同步变更，子代理每次调用读取根聊天的有效权限。切换只影响下一次调用，已有确认卡片继续等待；审批复用十分钟超时、取消和重连机制，批准只授权准确的当前操作。

路径检查统一规范化相对路径、Windows 大小写、目录穿越和符号链接。模型及本机服务通信属于内部通信，不重复请求任务联网批准。此实现仅为应用层权限检查，没有 Windows 进程沙箱，不能限制任意命令及其子进程全部文件和网络访问，也不宣称具有 Codex 同等的操作系统隔离能力。宿主业务失败仍严格记录为 `tool.failed`。桌面能力检查包含 `permission-modes-v1`，修改运行时后需重新构建并重启客户端。

Work 子代理直接使用 `deepseek-harness-master` 的进程内后台派发源码，沿用 MoonYa Foundation 包名。`npm run build:subagents` 校验 34 个源码文件，仅允许包名前缀替换，并生成发布用组合、来源哈希和会话验证 worker；构建依赖 Foundation 的 pnpm 安装。Windows Build/Publish 自动运行这一步并携带 Koffi Windows 依赖。

常规构建按 `subagent-source.json` 的原始哈希核对 Foundation 源码，不受本地上游目录是否存在或版本变化影响。需要核对上游导入时，显式设置 `MOONYA_SUBAGENT_SOURCE` 为上游目录；该模式要求目录中的源码存在，且与 Foundation 副本仅有包名前缀差异。本地上游导入目录不进入版本控制。`subagent-LICENSE.txt` 汇集实际打包源码的许可证，并与来源记录一起进入安装包。

办公室按当前 Work 会话动态显示工位，支持任意任务、批量派发、默认每用户 8 个执行名额、三层父子关系、详情和整个分支取消。并发数在办公室修改，保存在本机运行时的用户设置中。子代理使用独立历史，继承工作目录、模型、技能及审批。重连和恢复办公室只读取日志，不唤醒子代理。实现约定见[中文开发约定](docs/SUBAGENT_OFFICE_DEVELOPMENT.zh.md)。

模型圆环详情浮层的统计口径、接口与恢复规则见[会话详情统计](docs/CONVERSATION_STATISTICS.zh.md)。

每轮 Harness 回复底部提供文件变更汇总、差异查看和确认后的整轮撤销。工作区轮次前后的原始字节快照保存在运行时的 `workspace-changes` 下，重启后仍可使用；有任何后续文件修改时整轮拒绝撤销。统计包含本轮期间工作区内主代理、子代理和命令产生的净变化，也可能包含其他聊天或人工编辑，结束后的后台修改不追加入已结束的轮次。Git 项目纳入已跟踪和未被忽略的新文件，普通目录排除常见依赖、缓存与构建目录；应用运行时数据和符号链接不进入快照。二进制及超过 2 MiB 的文本保留原始撤销备份，但不展示全文差异。记录不进入模型上下文。

无项目聊天使用 `%USERPROFILE%\.MoonYa\workspaces\default` 下按用户和聊天隔离的目录。旧无项目聊天下次继续时绑定独立目录，主目录旧文件保留原位。在“设置 → 数据导入与同步”可仅更改新聊天的默认根目录，或迁移所有已有默认工作区文件。迁移更新稳定绑定，历史差异和撤销继续可用；不搬迁账号、模型及浏览器数据。复制、字节校验和绑定提交都有恢复日志，目标已存在时拒绝覆盖，清理时遇到外部新增或修改的内容保留原位并提示。运行中的任务或后台命令阻止迁移与撤销。同项目不同聊天继续并发；只有快照任务在各自会话内排队。

接口通过桌面鉴权网关的 `harness_api.php` 提供 `changes_summary`、`changes_diff`、`changes_undo` 和 `workspace_settings`。变更请求携带 `session_id`、`client_chat_id`、`project_path` 和 `turn`，差异请求携带记录内的 `file_id`，撤销请求携带 `revision` 和 `request_id`。新增能力为 `workspace-changes-v1` 与 `default-workspaces-v1`。实现来源和许可证见 `src/workspace-changes-source.json` 与 `src/workspace-changes-LICENSE.txt`。

针对性验收：`node --test tests/workspace-changes.test.mjs tests/workspace-flow.integration.test.mjs tests/desktop-gateway.test.mjs`。界面验收在前端 `tests/process.test.mjs` 中，截图输出至根目录 `artifacts/workspace-changes`。
