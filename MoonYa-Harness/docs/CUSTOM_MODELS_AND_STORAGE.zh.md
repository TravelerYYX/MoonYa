# 自定义模型与本机存储

Work 和 Chat 的模型菜单均提供“自定义模型”和“配置自定义模型”。配置弹窗包含第三方提供商、自定义 API 两个标签；支持配置编辑、删除、模型搜索、自动/手动目录和高级能力设置。目录获取与连接测试仅使用草稿，保存才更新可选模型。删除正在选择的提供商后回到内置 DeepSeek。

预设提供商为 DeepSeek、Kimi、GLM、MiniMax、OpenAI，默认官方 API 地址。自定义提供商使用独立 ID，协议支持 `openai-completions`（OpenAI Chat Completions）、`openai-responses`（OpenAI Responses）和 `anthropic-messages`（Anthropic Messages）。上下文长度采用接口返回的完整窗口或对应模型的已核实官方资料；`max_input_tokens` 不直接当作总窗口。`context_window_source` 标记 `api`、`official`、`manual` 或 `unknown`。未知长度在 API 中为 `null`、TOML 中省略数值，菜单显示“待配置”；可以保存配置，但填写已确认的长度前不能选择、测试或生成。其他未知能力仍默认 4096 最大输出、文本输入和工具调用，图片关闭。明确不兼容的模型显示原因，Work 菜单禁用没有工具能力的模型。

Chat 和 Work 的上下文长度使用模型的 `context_window_options`，单档模型显示固定长度，多档模型可选择。内置 DeepSeek 提供 300,000 和 1,048,576 tokens 两档；新会话默认最大档位，同一会话按模型保存选择，Chat/Work 共用。`context_window` 始终表示最大窗口，请求的 `context_limit` 必须属于服务端允许的档位。圆环容量与实际生成、压缩采用同一有效窗口，用量仍为估算，输出预留预算另算。本轮及子代理固定启动时的模型和档位快照。旧配置的明确手动覆盖继续保留；无长度来源的历史自动值按官方目录重新解析，不能确认的需要重新获取目录或手动补齐。

模型高级配置提供工具调用、图片输入、思考模式、仅思考模式、允许关闭思考和模型专属协议。“输入”是总上下文窗口，“输出”是最大输出 tokens；快捷值按 1024 tokens/K 计算，清空取消手动覆盖并恢复接口或提供商默认值。上下文档位可自动读取和手动配置，不会给未知模型合成 300K 档位。

思考能力由 `supports_thinking`、`reasoning_required`、`allow_thinking_off`、`efforts`、`default_effort` 与 `reasoning` 表示。强度为低/中/高/超高/极致（`low/medium/high/xhigh/max`）；没有强度档位时仅提供开关。会话明确选择优先于模型默认，模型设为 `auto` 时使用请求层默认。开启仅思考模式禁止关闭思考。参数格式自动采用已知提供商适配，无法识别时需要手动选择。模型勾选 `custom_protocol` 后使用自身 `protocol`，否则继承提供商协议。

## 配置与密钥

本机运行时负责 `%USERPROFILE%\.MoonYa\config.toml`，使用 `smol-toml` 标准解析器，串行原子替换并保留其他配置。配置损坏或写入失败保留原文件并报错。API Key 明文保存于该文件；读取接口返回 `has_key`，编辑时密钥留空保留，清除勾选显式删除。

PHP `model_api.php` 沿用现有登录/令牌鉴权，提供读取、保存、删除、目录和测试。浏览器只持久化模型 ID 引用；草稿密钥仅存在弹窗内存，关闭时清空。请求发送 `model_ref: { provider_id, model_id }`，运行时读取实际地址和密钥。测试用目录中选定模型发起最小生成，返回耗时和错误；目录失败时，预设显示官方目录及错误，自定义 API 保留草稿原目录。

## 实际调用和恢复

协议还支持 `openai-responses`。`gpt-6.1-sol` 使用 `/v1/responses`，开启思考时发送 `reasoning: { effort, summary: "auto" }`；不允许关闭推理。`gemini-3.8-flash` 保持 `/v1/chat/completions`，思考参数格式选 `gemini`，使用 `extra_body.google.thinking_config` 的 `thinking_level`（low/medium/high）和 `include_thoughts: true`，不同时发送 `reasoning_effort`。完整接口地址会按模型协议归一化。

后台添加的模型使用数据库配置，读取本机 TOML 不会更新这些模型。管理员在模型编辑器选择协议与思考参数，或点击“应用 GPT-6.1 Sol / Gemini-3.8 Flash 思考配置”，保存后刷新客户端配置。该按钮保留中转地址、密钥、上下文和输出上限；输出上限需要按照供应商确认的限制设置。客户端自定义模型中的 GPT 可通过“使用 Responses 显示思考摘要”保存模型专属协议，其他模型继续继承原协议。

Responses 摘要、正文、工具参数和最终快照分别处理，最终快照不会重复追加文本。原始推理项（包括加密内容）按模型和供应商身份随工具结果回传；Gemini 工具签名同样保留在协议历史中。只展示接口实际返回的摘要，推理 Token 用量不代表一定返回可展示的思考文本。

2026-10-03 使用本机数据库中的 WawAPI 密钥实测：GPT Responses 流式请求返回摘要、正文和用量，GPT 和 Gemini 均完成工具结果回传；简单非流式问题未返回摘要。Gemini 官方兼容参数请求返回 HTTP 200，但流式和非流式都没有思考文本。公开站点没有配置文档链接，未找到 Gemini 思考透传说明；因此 Gemini 的真实思考显示仍需上游返回摘要才能验收。没有改写数据库配置或部署服务器。

可复现实测：`php MoonYa-Backend/tests/reasoning_live_smoke.php --live <model-id> stream`（或 json），以及 `node MoonYa-Harness/tests/reasoning-live-smoke.mjs --live <model-id>`。测试只读保存配置，使用真实上游并产生正常 API 用量；输出不包含密钥。默认自动化测试使用模拟接口与隔离测试数据库。

`model-client.mjs` 是自定义 Chat、Work 和子代理共用的协议适配器。它处理图片、流式文本/推理、工具调用片段、工具结果、协议鉴权、输出限制和已知推理参数。Work 每轮启动时固定配置，运行期间修改配置不会改变该轮及其子代理使用的密钥和地址。内置 DeepSeek 的默认行为保留。

Anthropic 原始内容块和签名留在本机，Work 随会话事件保存，Chat 位于 `chat/protocol-history.jsonl`。Chat 历史用消息标识关联原始块，避免相同回复文本混用签名。内部回放标识和内容块不会直接进入 OpenAI 请求。

Chat 的生成事件位于 `chat/runs`。断线只断开订阅，重连按事件序号续订同一轮；停止请求取消上游。运行时重启后将未完成轮次明确标为中断，保留已收到内容，不自动重新生成。中断的最后一条日志写入在保留副本后修复。上下文压缩使用模型窗口、输出预留和完整工具交互规则。

自定义 Chat 的显式取消可通过鉴权后的 `model_api.php` 发起，按用户和消息身份取消本机轮次，即使尚未建立云端会话也可停止生成。

## 统一数据根目录

C# 初始化当前用户 `.MoonYa` 并传给 Node/Python；PHP 从本机运行时健康接口确认该路径，避免 Apache 服务账号生成另一份数据。默认布局：

| 目录/文件 | 内容 |
| --- | --- |
| `config.toml` | 自定义供应商、模型目录和能力 |
| `agent-runtime` | Work 会话、子代理、附件和用户运行时设置 |
| `chat` | Chat 协议回放和生成事件 |
| `CefCache`、`chromium-cache` | 浏览器资料、IndexedDB、localStorage |
| `mcp-vault`、`McpArtifacts` | 原加密凭据与 MCP 附件 |
| `pet_settings.json`、`execution_history.json` | 桌宠和执行历史 |
| `downloads`、`crawler_output` | 下载与爬虫输出 |
| `tools`、`crawler-cache` | 工具和浏览器下载、爬虫缓存 |
| `logs`、`temp` | 程序日志与运行临时文件、PHP 登录会话 |

源码、安装资源、用户选定的项目目录和服务端数据库保持原位置。源文件编辑所用的原子替换临时文件与源文件相邻，替换后删除。已有凭据仍采用原 DPAPI 加密。应用源码不进行旧数据迁移。

## 验证入口

- `npm test`：运行时回归；`tests/models.test.mjs` 覆盖配置、协议、目录、历史签名、Chat 取消/重连、Work 和子代理继承。
- 后端 `node --test custom_models_browser_test.js`：弹窗草稿、标签、目录、能力、保存编辑删除和重启选择。
- 后端 `node --test full_page_boot_test.js`：渲染完整 PHP 页面，检查全部脚本语法，并实际点击模型菜单、弹窗标签、取消及输入框。
- 后端 PHP 的 `work_local_storage_test.php`、`work_image_paths_test.php`、`harness_browser_contract_test.php`：存储和原有调用回归。
- `dotnet build MoonYa.csproj -c Debug -p:Platform=x64`：客户端和运行时资源一致性验证。
- `scripts/build-windows-runtime.ps1`：Windows 单文件运行时打包，包含 TOML 依赖。

真实连接依赖用户已有密钥。模拟服务覆盖两种协议，不代表未提供密钥的供应商已做真实账户验证。
