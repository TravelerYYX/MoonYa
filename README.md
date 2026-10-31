# MoonYa

MoonYa 是一个本地优先的 AI 桌面助手 / Agent 平台：Windows 桌面客户端通过本地 Agent 运行时驱动模型循环、工具调用、文件与桌面操作、浏览器自动化，并可对接 PHP 后端完成账号、会员、模型代理与附件等在线能力。

> 本仓库以 Apache-2.0 许可证开源。所有真实密钥、数据库口令、用户数据与个人配置均不入库，请通过环境变量自行配置。

## 组成

| 目录 | 技术栈 | 职责 |
| --- | --- | --- |
| `MoonYa-Win/` | .NET 8 / WPF (C#) | Windows 桌面客户端宿主，负责窗口、前端承载、桌面/文件/执行服务与更新安装 |
| `MoonYa-Frontend/` | 原生 JavaScript / ES Modules | 聊天与设置界面，`build.mjs` 打包，Playwright 风格测试 |
| `MoonYa-Harness/` | Node.js (>=22.19) / ESM | 本地 Agent 运行时：版本化会话事件、可重连 SSE、OpenAI 兼容模型循环、工具协议、子代理办公室、工作区变更撤销、浏览器自动化 |
| `MoonYa-Backend/` | PHP 8.1+ / MySQL (PDO) | 账号、会员、支付、模型代理、附件与在线适配层；依赖见 `composer.json` |
| `MoonYa-Python/` | Python | 网页搜索与爬虫微服务（`web_search` / `web_crawler`） |

## 目录结构

```
MoonYa/
├── MoonYa-Win/          # WPF 桌面客户端与各冒烟测试工程
├── MoonYa-Frontend/     # Web 界面与构建脚本
├── MoonYa-Harness/     # 本地 Agent 运行时（含 foundation 上游副本）
├── MoonYa-Backend/     # PHP 在线后端
├── MoonYa-Python/      # 搜索 / 爬虫微服务
├── docs/                # 跨模块技术说明
├── LICENSE              # Apache-2.0
└── THIRD_PARTY_NOTICES.md
```

## 环境要求

- Windows 10/11（桌面客户端）
- .NET 8 SDK（构建 `MoonYa-Win`）
- Node.js >= 22.19（运行 `MoonYa-Harness`、构建前端）
- PHP 8.1+ 与 MySQL（部署 `MoonYa-Backend`，扩展 `openssl`、`pdo`、`pdo_mysql`）
- Python 3（运行 `MoonYa-Python` 微服务，依赖见其 `requirements.txt`）

## 配置

仓库只提供模板，**不要**把真实密钥写进代码：

- 后端本地/桌面配置：复制 `MoonYa-Backend/.env.example` 为 `.env`
- 服务器部署配置：复制 `MoonYa-Backend/.env.server.example` 为 `.env`
- 模型 API Key、数据库口令、JWT/ADMIN 密钥、邮件与支付材料全部通过环境变量注入

`.gitignore` 已排除 `.env`、证书、密钥材料、本地数据库 dump 与构建产物。

## 数据库

仓库提供一份可直接导入的 MySQL 8 快照：[`MoonYa-Backend/SQL/ai_system_opensource.sql`](./MoonYa-Backend/SQL/ai_system_opensource.sql)。

```bash
mysql -u root -p -e "CREATE DATABASE ai_system DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p ai_system < MoonYa-Backend/SQL/ai_system_opensource.sql
```

这份快照包含全部 34 张表的结构，以及 7 张系统配置表的数据（系统提示词、内置模型、会员套餐、应用注册表、界面文案等）。

**不包含任何用户数据**。账号、会话、消息、积分、会员账户、订单、支付、管理员与访问日志等 27 张表只有结构、没有一行数据。

`builtin_models.api_key` 全部替换为 `sk-REDACTED`，导入后需在后台填入自己的密钥；也可以改成 `@env:DEEPSEEK_API_KEY` 形式，由后端从环境变量读取。

## 各模块开发入口

- **Agent 运行时**：见 `MoonYa-Harness/README.md`（`npm ci` → `npm run build:subagents` → `npm test` → `npm start`，默认 `127.0.0.1:58907`）。
- **前端**：`MoonYa-Frontend/` 下 `npm run build`，测试见其 `package.json` 的 `test` 脚本。
- **后端**：`MoonYa-Backend/` 执行 `composer install`，按 `.env.server.example` 配置数据库与环境变量。
- **Python 微服务**：见 `MoonYa-Python/` 下 `requirements.txt` 与 `service_config.json`。
- **桌面客户端**：用 .NET 8 构建 `MoonYa-Win/MoonYa-Solution/` 下的主工程。

各模块的详细协议、数据布局与验收入口见其内部 `docs/` 与测试目录。

## 安全说明

- 运行时的权限模式（请求批准 / 帮我批准 / 完全访问）是**应用层**检查，不提供操作系统级沙箱，不能限制任意命令及其子进程的全部文件与网络访问。
- 支付、邮件、模型等第三方凭据仅从环境变量/安全存储读取，仓库内不含任何真实值。

## 许可证

[Apache License 2.0](./LICENSE)。第三方组件归属与许可证见 `THIRD_PARTY_NOTICES.md` 及各上游目录内的许可声明。
