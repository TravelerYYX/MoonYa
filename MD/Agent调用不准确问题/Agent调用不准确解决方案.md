# MoonYa Agent 路由、权限与历史串话修复方案

> 本文对应《Agent调用不准确问题原因分析.md》，记录已经落地的修复结构、数据库迁移和验收闭环。

## 一、设计原则

1. Work 中 MoonYa 只协调，不直接执行业务工具。
2. 模型选择 `capability_key`，服务端从数据库唯一解析 Agent。
3. 工具共用不参与岗位推断，不扫描 `instruction` 中的工具名。
4. 闲聊、补充提问和明确不支持的请求由 MoonYa 直接回复。
5. 跨岗位任务必须拆分并通过 `depends_on` 串联。
6. 当前消息、最终回复和运行记录使用稳定 ID 幂等关联。
7. 没有员工执行证据时，执行型任务不能被标记成功。
8. 岗位、能力、工具和风险都由数据库及管理后台维护，不增加关键词路由。

## 二、能力路由协议

新增 `agent_routing_capabilities`：

| 字段 | 含义 |
|---|---|
| `capability_key` | 稳定能力标识 |
| `agent_id` | 该能力唯一负责的 Agent；一个 Agent 可以负责多个能力 |
| `display_name` / `description` | 用户可理解的能力名称与说明 |
| `examples_json` | 正例 |
| `exclusions_json` | 反例和边界 |
| `required_tools_json` | 完成能力必须具备的工具 |
| `enabled` / `sort_order` | 启用状态和排序 |

固定能力归属：

| capability_key | Agent |
|---|---|
| `app.lifecycle` | App |
| `computer.system` | Computer |
| `computer.desktop_ui` | Computer |
| `browser.automation` | Browser |
| `browser.page_extraction` | Browser |
| `file.management` | File |
| `file.office` | File |
| `search.web_research` | Search |
| `code.engineering` | Code |

`delegate_to_agents.tasks[*]` 现在只接受：

- `id`
- `capability_key`
- `instruction`
- `context`
- `depends_on`
- `selection_reason`

服务端执行以下校验：

1. 能力存在且启用；
2. 能力负责 Agent 已启用并获得 MoonYa 委派授权；
3. 能力的全部必需工具存在、启用且实际授予该 Agent；
4. 每个任务只能声明一个能力；
5. 依赖存在、不能依赖自身、整个计划必须是无环图；
6. 依赖任务失败时，下游任务以 `dependency_failed` 停止，不制造伪成果。

模型不再填写 `agent_key`。同一个 `web_fetch` 或 `download_file` 可以被多个 Agent 合法使用，不会产生 `LIMIT 1` 的错误归属。

## 三、直接回复与跨岗位任务

新增协调工具 `respond_without_delegation`：

```json
{
  "response": "展示给用户的回复",
  "reason": "chat | clarification | unsupported"
}
```

Work 首轮只暴露两个工具：

- `delegate_to_agents`
- `respond_without_delegation`

DeepSeek thinking 模式按兼容要求移除强制 `tool_choice`，但仍通过系统提示词和服务端协议要求二选一。MoonYa 如果伪造并调用未暴露的业务工具，`api.php` 会返回 `root_business_tool_forbidden`，不会落入旧版执行分支。

跨岗位示例：

```text
搜索资料并生成 docx
search.web_research
        ↓ depends_on
file.office
```

```text
打开记事本并输入内容
app.lifecycle
        ↓ depends_on
computer.desktop_ui
```

用户信息不足时使用 `clarification`，问题必须面向普通用户，不要求用户理解 Agent、工具名或内部协议。

## 四、Work 最终工具矩阵

| Agent | Work 中保留 |
|---|---|
| MoonYa | 仅两个协调工具 |
| App | `check_app_installed`、`download_file`、`open_app`、`close_app`、`install_app`、`uninstall_app` |
| Computer | 系统状态、截图、UIA、鼠标键盘；Shell、命令状态、停止命令 |
| Browser | `browser_automation_control`、`vls_analyze_browser`、`web_fetch`、`web_crawler` |
| File | 完整文件工具、`download_file`、Shell、Python、命令状态、停止命令 |
| Search | `web_search`、`web_fetch` |
| Code | 项目文件工具、Shell、Python、命令状态、停止命令、LSP |

明确移除：

- App：Shell、Python、命令状态、停止命令；
- Computer：Python；Work 中的 `open_app`；
- Browser/Search：Shell、Python、命令状态、停止命令；
- Code：通用删除、移动、打开文件和桌面工具。

CU 和普通 Agent 模式除风险元数据外保持原有兼容。Computer 在独立 CU 流程仍可使用原有启动应用能力；严格 App → Computer 拆分只作用于 Work。

迁移只关闭已知内置 Agent 与已知原生工具之间的旧授权，然后按矩阵重新启用。未知自定义工具和 MCP 授权不会被批量删除。

ToolGateway 每次调用仍重新查询数据库授权；模型或前端不能通过伪造工具名绕过。

## 五、Office 运行时闭环

`MoonYa-Python/requirements.txt` 固定：

- `python-docx==1.2.0`
- `openpyxl==3.1.5`
- `python-pptx==1.0.2`
- `pypdf==6.14.2`

执行服务启动时使用实际选中的 Python 解释器检查发行包及版本，`/health` 返回：

- `python_available`
- `office_ready`
- `office_dependencies`

Office 脚本执行前会识别其 import。缺包或版本不匹配时直接返回：

```text
error_code = missing_runtime_dependency
```

员工不得临时运行 `pip install`。ToolGateway 会对 `file.office` 负责 Agent 的 Shell/Python 安装尝试返回 `managed_runtime_install_forbidden`；依赖必须由 MoonYa 安装/升级流程统一提供。

File Agent 的 Office 完成契约为：

1. 生成到用户指定路径；
2. 重新打开生成文件；
3. 检查关键内容及页数、工作表或幻灯片数量；
4. Python 标准输出最后一行返回包含 `artifact_path` 与 `verification` 的 JSON；
5. 把文件路径作为 artifact 返回；没有 artifact 时返回 `office_artifact_required`，不得判成功；
6. 未重新读取验证时不能声称完成。

## 六、消息幂等和历史修复

### 1. 当前用户消息

前端为每次发送生成 UUID `client_message_id`，写入消息 DOM 和 API 请求。

`saveCurrentChat()` 使用 Promise 队列串行保存。调用方 `await` 等待的是自己的实际保存任务，不再只是设置“待保存”标志后立即返回。

后端按：

```text
(conversation_id, user_id, client_message_id)
```

建立唯一约束并幂等插入。相同文字、不同 ID 是两条合法消息。

### 2. 模型历史

`api.php` 先按消息主键倒序取最新 20 条，再恢复正序；查询时按当前 `client_message_id` 明确排除当前消息，随后只向模型上下文追加一次。

运行记录保存：

- `client_message_id`
- `history_first_message_id`
- `history_last_message_id`

旧客户端没有消息 ID 时，只比较最后一条紧邻的同角色、同内容记录，不扫描全历史。

### 3. Work 最终回复

`assistant.completed` 内容由后端使用 `source_run_id` 幂等写入正式 `messages` AI 记录，唯一键为：

```text
(conversation_id, user_id, source_run_id, role)
```

写入成功后：

- `team_runs.final_message_id` 关联正式消息；
- `assistant.completed` 和 `run.completed` 事件包含 `message_id/run_id`；
- 刷新后通过普通会话加载得到完整 user/assistant 对；
- `.team-agent-message` 只展示过程，不承担持久化。

若有会话 ID但最终消息写入失败，运行状态改为 failed，并记录 `final_message_persistence_failed`，不能虚假完成。

## 七、失败恢复状态机

委派具有明确阶段：

- `accepted`：能力、授权和 DAG 已通过预执行校验；
- `rejected`：规划无效，没有员工开始执行；
- `executed`：至少形成员工结果。

预执行拒绝：

- 不增加员工执行委派次数；
- 增加独立 `planning_rejections`；
- 返回具体错误、可用能力列表和 `dispatch_status=rejected`；
- 允许 `max_planning_corrections` 次重新规划；
- 超限后明确失败。

员工执行后：

- 纯文字且没有工具调用 → `tool_execution_required`；
- 有调用但没有成功工具结果 → `no_successful_tool_result`；
- 依赖失败 → `dependency_failed`；
- 成功和失败结果同时存在 → 保留成功 artifact，最终为 partial；
- 没有真实员工结果且不是直接回复 → 运行必须 failed。

`shouldForceSynthesis` 只接受 `dispatch_status=executed` 且有真实结果。直接回复单独形成 completed，不伪造员工证据。

## 八、风险策略

种子风险已修正：

| 工具 | effect / risk |
|---|---|
| `web_crawler` | write / medium |
| `mouse_move`、`mouse_scroll`、`focus_window` | write / medium |
| `open_file`、`open_video_site` | write / medium |
| `todo_write`、`task_complete` | write / low |
| `ZTimage-Agent`、`generate_video` | write / high |
| `search_music` | write / medium |
| Shell、Python | write / high |
| 删除、卸载、停止进程 | destructive / critical |

`browser_automation_control` 使用 action 级风险：

- 截图、读取、检查：read / low；
- 导航、填写、点击、滚动：write / medium；
- 上传、付款、购买、提交敏感数据：write / high。

审批判断和事件记录都使用最终 action 级风险，而不是只显示工具默认值。

## 九、管理后台与可观测性

管理后台新增“路由能力”页，可查看和编辑：

- 能力归属；
- 正例、反例、说明；
- 必需工具；
- 实际缺失工具；
- MoonYa 委派授权差异；
- 启用状态。

以下操作会被拒绝：

- 启用一个没有必需工具的能力；
- 把能力交给未获得所需工具的 Agent；
- 把能力交给未获 MoonYa 委派授权的 Agent；
- 停用仍被已启用能力使用的工具；
- 从 Agent 移除能力所需授权；
- 停用仍负责已启用能力的 Agent；
- 删除仍负责能力的 MoonYa → Agent 委派关系。

每次运行记录当前消息、能力、服务端解析 Agent、选择理由、规划拒绝次数、直接回复原因、历史 ID 范围、最终消息 ID 和 run ID。

## 十、实现位置

核心文件：

- `MoonYa-Backend/Services/MultiAgentSchema.php`
- `MoonYa-Backend/Services/TeamRepository.php`
- `MoonYa-Backend/Services/TeamCoordinator.php`
- `MoonYa-Backend/Services/TeamWorkProtocol.php`
- `MoonYa-Backend/Services/ToolGateway.php`
- `MoonYa-Backend/Services/RiskPolicy.php`
- `MoonYa-Backend/api.php`
- `MoonYa-Backend/conversation_api.php`
- `MoonYa-Backend/admin/api/agent_team.php`
- `MoonYa-Backend/script/dashboard/agent_team.php`
- `MoonYa-Backend/script/MoonYa-index/modules/script-1c-save.php`
- `MoonYa-Backend/script/MoonYa-index/modules/script-1e-rest.php`
- `MoonYa-Win/MoonYa-Solution/MoonYa/Services/PythonExecutionService.cs`
- `MoonYa-Win/MoonYa-Solution/MoonYa/Services/ExecutionApiServer.cs`
- `MoonYa-Python/requirements.txt`

数据库安装后应运行：

```powershell
php MoonYa-Backend/migrate_multi_agent_v1.php --confirm
```

迁移为幂等设计，可连续运行两次。上线前仍需在目标数据库执行迁移，代码修改本身不会自动改变已经部署的数据库。

Work 采用失败关闭策略：`agent_mode=agent` 且非独立 CU 请求时，若团队表未安装、`multi_agent_v1` 缺失/关闭或初始化抛错，`api.php` 返回 `team_runtime_not_installed`、`team_runtime_disabled` 或 `team_runtime_initialization_failed`，并立即结束请求。禁止进入旧 `agentTools` 分支。初始化期间已经创建的运行会写入 `agent.failed`、`run.failed` 并更新为 `failed`。

上线检查不能只确认 PHP 文件已发布，还必须从 Apache 实际进程读取并核对：

- `TeamRepository::isInstalled() === true`；
- `multi_agent_v1 === true`；
- DeepSeek `function_calling_compatibility` 为 thinking 保留且不强制 `tool_choice`；
- 无副作用 Work 请求能够产生 `run.started`，且根请求仅含两个协调工具。

## 十一、测试与验收

自动测试：

```powershell
php MoonYa-Backend/tests/multi_agent_v1_smoke_test.php
php MoonYa-Backend/tests/message_history_contract_test.php
php MoonYa-Backend/tests/agent_ui_contract_test.php
php MoonYa-Backend/tests/office_runtime_contract_test.php
php MoonYa-Backend/tests/multi_agent_migration_state_test.php
MoonYa-Python/.venv/Scripts/python.exe MoonYa-Backend/tests/office_runtime_smoke_test.py
```

覆盖内容：

- 九项能力到六个员工 Agent 的数据库解析；
- App、Computer、Browser、File、Search、Code 固定用例；
- Search → File、App → Computer 依赖；
- 闲聊直接回复且不重放历史清空回收站；
- DeepSeek thinking 无强制 `tool_choice`；
- 循环依赖预执行拒绝；
- 员工纯文字不能作为执行证据；
- ToolGateway 未授权工具拒绝；
- File Agent 临时安装依赖拒绝及 Office 无 artifact 失败；
- Browser action 风险；
- 最新 20 条稳定历史；
- 当前消息排除；
- 两条相同文字保留；
- Work 最终 AI 回复按 run ID 幂等保存；
- Office 固定依赖、执行前缺失错误、真实文件生成与重新读取；
- UI 事件契约。

目标环境还必须执行：

1. 数据迁移连续两次并比较授权状态；
2. 确认管理员自定义工具和 MCP 授权未变化；
3. 实际生成并重新读取 docx、xlsx、pptx、pdf；
4. 缺依赖场景验证 `missing_runtime_dependency`；
5. Windows `dotnet build`；
6. 完整 Work 端到端测试，包括审批、拒绝、取消和部分成功。

验收标准：

- 固定能力路由全部正确；
- Work 根协调者不能直接执行业务工具；
- Work 团队运行时不可用时必须明确失败，不能静默回退；
- 权限矩阵与数据库实际授权一致；
- 当前消息和最终回复各保存一条；
- 历史任务不被当作当前任务重放；
- 错误委派不会被标记成功；
- Office 文件必须有重新读取证据和 artifact；
- 迁移重复执行结果一致且不破坏自定义/MCP 授权。
