# 子代理与动态办公室验证记录

验证日期：2026-09-29。保留仓库原有未提交改动，未提交或推送代码。

## 已验证行为

- 原始 DeepSeek 子代理组合真实创建 12 个独立 Agent/Session；默认最多 8 个执行，其余排队，所有员工可显示，同一素材可重复使用。
- 8 个父子代理等待下级时释放名额，16 个员工正常结算；第四层派发被拒绝，失败发布不产生虚假员工。
- 多个 Work 会话共享同一用户并发名额，其他用户独立计数；增加限制立即调度，降低限制不强制停止，设置重启后保留。
- 分支停止取消运行及排队的全部下级，兄弟分支继续；迟到事件与重启后的协作消息不能重新打开已取消分支。
- 子代理审批释放名额，事件保留 child ID，刷新后的审批决定发给对应员工；一个子代理失败不影响兄弟任务。
- 父代理仍有未结算任务时不显示提前汇总；消费包含子代理证据的持久结算通知后才完成。
- 重启只恢复持久事实，不执行中断子任务；可从上游原始目录修复丢失的办公室目录副本。
- 浏览器验证超过 9 人的换行和滚动、员工详情与记录、分支停止、并发输入、独立窗口、空办公室弹出后首次绑定、会话隔离、刷新恢复、乱序补齐、重复事件与重连快照补齐。
- Windows 发布目录包含实际组合、持久化 worker、来源哈希、许可证及 Koffi x64/ARM64 原生依赖；发布包中的 exe 通过 10 项办公室运行测试。

## 测试与构建结果

| 检查 | 结果 |
| --- | --- |
| 五个移植包的上游测试 | 24 个测试文件；563 通过，1 项按上游条件跳过 |
| MoonYa Harness 完整测试 | 86 项，85 通过；本机桌面浏览器服务未运行的 1 项按条件跳过 |
| 前端子代理行、PHP 记录网关、办公室、审批与审批 SSE 交互 | 5 项通过；发布目录前端另通过子代理行浏览器测试 |
| PHP 语法及办公室/UI 迁移契约 | 通过 |
| 12 个前端模块 JavaScript 语法 | 通过 |
| Windows x64 Debug Build/Publish | 通过；已有 C# 可空性和未使用字段警告保留 |
| 发布目录内容哈希与物理桌面发布检查 | 通过 |
| 发布目录内单文件 exe 的办公室测试 | 10 通过，包含创建、嵌套、取消、审批、重启、并发与详情记录 |
| ARM64 单文件打包 | 通过；未在 ARM64 设备上运行 |

运行时集成测试使用本地可控模型服务，前端使用浏览器和可控接口夹具；没有连接真实账号数据库或调用付费模型 API。

## 工具请求格式回归修复

实际模型曾返回 `Invalid schema for function 'subagent'`（HTTP 400）。原因是办公室适配层把上游工具注册器已经生成的标准 JSON Schema 当作参数定义表，再次包进 `properties`，导致 `description` 注释变成对象、必填参数丢失。

现直接保留上游的完整参数 schema，仅扩展可选外观和后台执行限制。办公室模型夹具在处理每一个父子代理请求前检查 `subagent`、`send_message`、`interrupt_agent` 的参数结构、必填字段与字符串注释。修复前该检查复现 HTTP 400；修复后 9 项办公室测试与 85 项 Harness 完整测试全部通过。重新生成的 Windows x64 单文件运行包也通过上述 9 项检查；ARM64 运行包已重新打包，未在 ARM64 设备运行。

当前 Debug 运行目录与发布目录均已同步修复并通过内容哈希检查；已启动的 MoonYa 需重启后加载新代码。

## Work 对话子代理行

本次增加共享会话事实源和独立的子代理详情订阅，保持现有调度、并发和办公室入口。浏览器检查了 12 个真实目录条目在两个原始派发轮次独立成行、六种状态、长标题省略、鼠标及键盘展开、完整长任务、父子关系、Markdown 结果和实时工具记录。子代理终态不改变 MoonYa 回复，创建失败没有虚假行，办公室关闭后状态仍持续更新。

多个展开详情通过 office_employee_events 的 children 游标表复用一条连接；验证全部 12 行展开时仍可发送普通 HTTP 请求、每个子会话序号独立、重复记录去重、重连从缓存序号续传、无名称进度事件保留工具名称。PHP 记录网关验证所有员工属于所选根目录，拒绝跨分支 ID，过滤内部历史、检查点与图片数据，不产生主回复 content/done/error。

保存中保留 child ID、created_turn 与 created_seq；恢复从持久目录校准状态，空过程区也保留轮次锚点，刷新后详情默认收起。验证乱序目录补齐、迟到事件、清空缓存、Chat/Work 与跨会话隔离、详情订阅释放，以及下级和后续协作的原行更新。单文件运行时验证原始派发 prompt 不截断、原始轮次跨重启保留，读取详情和记录不重新执行任务。

Windows x64 Debug 和 Publish 均已重建，单文件运行时重新生成；ARM64 运行时已重新打包，未在 ARM64 设备运行。内容哈希检查已扩展到共享状态源、子代理行脚本、样式、保存恢复模块、办公室模块与 PHP 网关，发布目录浏览器测试直接读取 wwwroot 文件。预览位于 artifacts/subagent-runtime-package/subagent-chat-collapsed.png 和 subagent-chat-expanded.png。

## 复查命令

在 MoonYa-Harness 下运行 `npm test`；在 foundation 下运行：

```powershell
pnpm exec vitest run packages/subagent/subagent/tests packages/subagent/subagent-spawn-in-process/tests packages/subagent/subagent-in-process-driver/tests packages/subagent/tool-subagent/tests packages/subagent/tool-subagent-control/tests
```

在 MoonYa-Backend 下运行：

```powershell
node --test tests/subagent_chat_test.js tests/subagent_gateway_test.js tests/office_interaction_test.js tests/composer_approval_test.js tests/harness_approval_stream_test.js
```

从仓库根目录构建发布包后，将 MOONYA_HARNESS_EXECUTABLE 指向发布目录中的 agent_runtime/moonya-agent-runtime.exe，运行：

```powershell
node --test MoonYa-Harness/tests/office.test.mjs MoonYa-Harness/tests/office.integration.test.mjs
```

验证输出位于本地忽略目录 artifacts/subagent-runtime-package；桌面测试发布包位于其 publish 子目录。
