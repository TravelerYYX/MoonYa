# MoonYa 前后端分离：构建、部署与验收

主聊天、登录弹窗、客户端设置、办公室及办公室弹窗全部从客户端安装目录 `frontend/` 加载。
社区入口已删除；个人中心和管理后台仍由 PHP 服务器提供。主聊天服务器入口返回 410。
本次交付仅提供源码、构建与部署说明，没有执行服务器上线。

## 运行边界

```text
CEF → http://127.0.0.1:58908/index.html
      ├─ 静态 HTML / CSS / JS / 字体 / 图片 / Worker
      ├─ /gateway/remote/* → backend_url → PHP 业务接口
      ├─ /gateway/local/*  → 本机 Agent Runtime → 本机工具 / Python
      └─ /gateway/native/* → 本机文件、浏览器、执行服务
本机 Runtime → /gateway/model/{user}/chat/completions → PHP 模型代理 → 内置供应商
```

前端服务独立于 Runtime 启动。Runtime 启动失败不会阻止主界面显示，相关请求返回错误。
本地服务只绑定 `127.0.0.1`，验证 Host、Origin、每次启动的网关随机凭据和 Bearer 身份。
Runtime 的浏览器来源限制仍然生效；适配请求仅由原生网关带内部凭据发起。
执行会话、办公室分支和审批还校验用户及工作目录归属。网关只有明确白名单，不代理任意 URL。

| 能力 | 数据与执行位置 |
| --- | --- |
| 登录注册、用户资料、云端 Chat 同步、内置 Chat、在线业务 | PHP 服务器 |
| Work、办公室、自定义模型、文件、浏览器、Python、审批、执行统计 | 用户电脑 |
| 内置 Work 模型 | 本机组织上下文，服务器代理模型；供应商密钥不下发 |
| 自定义模型 | 本机原有模型配置和 Runtime；用户自行配置密钥 |

本机读取用户选择的附件，上传时传递内容或编码图片。PHP 不读取用户电脑路径。
`GET /api/client_config.php` 只返回公开配置，模型和第三方服务密钥不能放进默认配置或资源。
个人中心通过认证接口签发 60 秒单次票据打开在线页面，URL 不携带 Bearer Token。

## Windows 构建与客户端配置

先准备现有 .NET 8 / Node / Python 运行依赖，然后在仓库根目录执行：

```powershell
npm ci --prefix MoonYa-Frontend
npm ci --prefix MoonYa-Harness
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa/MoonYa.csproj -p:Platform=x64
```

MSBuild 自动构建静态前端并复制至 `frontend/`，将 Runtime、Python 桥接与执行技能复制到
`agent_runtime/`，并校验资源 SHA256。发布和安装包验证拒绝 PHP、`.env*` 和 `wwwroot`。
升级安装会删除旧安装目录的 `wwwroot`，不会删除 CEF 缓存及用户数据。
增量构建及发布会把输出目录根层和 RID 子目录的旧 `wwwroot` 移到仓库
`artifacts/legacy-client-payload-backups/`，保留原文件并记录原输出路径。
备份不随客户端发布；其他意外混入的 PHP 或服务器配置仍触发校验失败。

安装目录 `launcher_config.json`：

```json
{
  "backend_url": "https://your-server.example/moonya/",
  "frontend_port": 58908,
  "browser_automation": {"builtin": {"remote_debugging_port": 58909}}
}
```

保留配置的其他字段。`backend_url` 现在仅代表远程业务接口根地址，也用于旧来源迁移。
`MOONYA_BACKEND_URL`、`MOONYA_FRONTEND_PORT` 可覆盖对应配置；修改后重启客户端。
浏览器调试优先使用配置端口；若被占用或与前端、浏览器 API 端口冲突，CEF 初始化前由操作系统分配空闲回环端口。宿主与自动化服务共享实际端口，随包配置不变，诊断日志记录配置端口和运行端点。旧配置同样使用该机制，不依赖特定默认端口迁移。
显式配置的端口不能相同。前端端口被其他进程占用时，主窗口显示错误及重试按钮；
释放端口或调整配置后重试，不会加载远程主页面。前端来源端口应保持稳定，以保留该来源的浏览器数据。

Python 服务路径同时支持运行目录和配置目录：调试时即使选择了较新的源码目录配置，
仍优先使用运行目录内的 `python_service/main.py`、服务配置和打包的 Python。
绝对路径环境变量覆盖保持有效。爬虫/搜索服务缺失不会终止主界面启动，错误记录在
`%USERPROFILE%/.MoonYa/logs/python_backend.log`。

## 离线与升级迁移

启动先恢复缓存用户、本地 IndexedDB 历史和草稿，再检查登录、同步业务数据。
网络失败保留缓存；明确认证失效后保留该用户本地历史，同时限制需要登录的功能。
断网不提交在线任务，输入可继续编辑。恢复连接只校验状态，不自动发送草稿。
已接受的任务断线后按原消息 ID 和事件游标续订；未确认接受的请求不会自动创建执行。
发送失败保留可编辑输入，并提示先检查是否已送达。

升级时，隐藏 CEF 控件使用原全局缓存上下文，在旧 `backend_url` 来源打开客户端合成迁移页。
该页所有资源由客户端拦截提供，不访问旧服务器。迁移导出包括 MoonYa localStorage 和
`moonya-history` 的历史、事件、草稿、设置、Blob / File / ArrayBuffer 附件。
先在 `%USERPROFILE%/.MoonYa/frontend/` 写入 Windows DPAPI 加密备份及暂存，再幂等导入新来源。
迁移先等待隐藏 CEF 的 JavaScript 上下文就绪，再分批读取旧数据库。每批最多 100 条记录，
按约 1 MiB 文本大小切分（单条大附件记录单独处理），不会一次性把全部事件串成 JSON。
新备份位于 `legacy-v2-*` 子目录；批次全部备份成功后才发布迁移清单。
导入各批次可重试，全部导入完成才写完成标记；详细故障记录在 `logs/frontend-migration.log`。
已有键不覆盖，失败不写完成标记，可点击重试；旧来源数据和备份保留。
旧版缺少用户元数据时，界面让用户选择已迁移的本地账号，不推断账号归属。
请保留原来的 `backend_url` 和 CEF 缓存完成首次迁移，再更换服务器地址。

## PHP 部署清单

生成独立服务器目录，输出必须为空：

```powershell
python tools/build_server_bundle.py artifacts/php-server-separated
```

上传此目录，包含业务 API、认证、用户页面、后台、业务 Services、公开技能目录和现有 SQL。
不复制开发机 `.env`、上传数据、日志、测试、客户端 UI 片段或办公室网页资源。
聊天 / 办公室及客户端专属旧接口由短小的 410 入口替代。
可选 Docker 部署使用生成目录内的 `Dockerfile` 作为构建入口；原 Windows 目录的 Compose
兼容入口已改为使用此服务器目录。该 Docker 构建仅接受去除聊天 UI 的生成目录。
Docker 依赖下载和镜像构建需在部署环境验证；本次未运行容器或数据库上线。
不要直接将整个开发仓库作为站点根目录。升级已有服务器时先备份数据库和上传数据，
移除旧 `script/MoonYa-index`、`assets/office`、社区与旧办公室网页，再覆盖新发布文件；
保留已有业务数据及现有数据库结构，按已有项目迁移说明应用所需 SQL。

需要 PHP 8.1+、PDO MySQL、cURL、mbstring、fileinfo、JSON、OpenSSL，以及现有 MySQL 数据库。
在服务器执行 `composer install --no-dev --optimize-autoloader` 安装邮件依赖。
在线附件功能还需按既有 WebAttachmentService 配置服务器文档提取依赖。
数据库用户须有现有业务表的读写权限；初始化及结构迁移使用单独的部署账号。

将 `.env.server.example` 复制为服务器 `.env` 或设置等价进程环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASS` | 原有 MySQL 业务库 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_API_URL` | 内置模型代理，仅保留在服务器 |
| `MAIN_API_DOMAIN` | 服务器公开根地址，与客户端 backend_url 一致 |
| `MOONYA_SERVER_DATA_ROOT` | Web 根目录之外的可写绝对目录，存放服务器会话、日志、临时文件 |
| `JWT_SECRET` / `ADMIN_SECRET` | 原有管理后台密钥 |
| `MINMAX_TTS_API_KEY` / `ALIYUN_ASR_API_KEY` | 可选语音服务；实时 ASR 仅下发短期票据 |
| `YUNZHI_API_TOKEN` | 可选在线天气、星座与 OCR |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 邮箱验证与找回密码 |
| `MOONYA_PYTHON_SERVICE_URL` | 可选服务器在线业务微服务，不指向用户电脑 |

服务器不要设置客户端 `MOONYA_AGENT_RUNTIME_URL`，不要尝试通过服务器 127.0.0.1 连接用户电脑。
旧部署的 downloads、临时文件和会话目录应备份后迁入新服务器数据根对应子目录；
用户头像上传仍保留原 uploads 数据卷。不要覆盖或删除已有数据库和上传数据。
如果保留旧 `MOONYA_DATA_ROOT`，它会优先于新服务器数据根变量；建议服务器仅配置新变量。
限制 `.env`、配置源码、Services、vendor、SQL、技能源码目录直接通过 HTTP 读取，
同时允许 PHP 进程访问。Bearer 请求需保留 Authorization；业务接口无需对公网放开 CORS。

### 技能上传与客户端同步

后台“技能”根目录可新建技能，进入技能后可创建目录、上传多个 Markdown 提示词并双击编辑。
技能对所有登录用户开放；Harness 支持手动选择和根据用途说明自动匹配，先读取主文件，再按需读取引用文件。
普通 Chat 不应用技能。上传文件路径会通过 `read_skill.resource_paths` 提供给模型，主提示词应说明各引用文件用途。

PHP 服务账号须对服务器 `skills/` 目录及子目录具有读写权限；该目录继续禁止 HTTP 直接访问。
应用限制为单文件 1 MiB、单次总量 10 MiB；配置 `upload_max_filesize >= 1M`、`post_max_size >= 12M`，
`max_file_uploads` 至少覆盖预计单次文件数量，并同步配置反向代理请求体限制。上传重名文件通过编辑器修改。
生产 PHP 设置 `display_errors=Off`，避免上传超限在脚本运行前产生的 PHP 警告破坏 JSON；后台上传携带文件总数，发现 PHP 文件数截断时整批拒绝。
升级服务器前备份完整 `skills/`（包含 original.sha256），保留管理员新增的目录，合并发布内容时不要清空技能目录。
这项功能无需数据库迁移。需要同时发布后端、新版 Runtime 和 Windows 网关，旧安装包无法同步新增技能。

Windows 启动 Runtime 时传入可信的 `MOONYA_BACKEND_URL`，正文通过原生网关转发，不直接使用前端提交的正文。
最近成功快照保存在客户端数据根的 `agent-runtime/skill-cache/`，按规范化后端地址和用户 ID 隔离。
网络或服务器故障使用最近快照并显示通知，无缓存仅使用安装包内置技能；所选技能未同步时保留草稿并报错。
401/403 要求重新登录，不使用缓存绕过认证。离线缓存可能包含修改或禁用前的版本，联网成功同步后由服务器目录完整替换。

定向验收命令：

```powershell
php MoonYa-Backend/tests/skill_catalog_test.php
node --test MoonYa-Backend/tests/skill_api_test.mjs
node --test MoonYa-Harness/tests/skill-sync.test.mjs MoonYa-Harness/tests/desktop-gateway.test.mjs
node --test --test-name-pattern="uploaded custom" MoonYa-Harness/tests/loop.integration.test.mjs
npm test --prefix MoonYa-Frontend
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa/MoonYa.csproj --no-restore
```

接口与后台表单验收使用隔离的认证、数据库适配器和本地 PHP 服务；模型链路测试使用模型测试服务。
实际生产数据库认证和供应商模型调用需要部署环境验收。

## 流式接口配置

PHP-FPM / 反向代理不要缓冲或压缩 SSE。Nginx 示例需按站点路径、PHP socket 调整：

```nginx
location ~ /(?:api\.php|api/model_proxy\.php)$ {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param HTTP_AUTHORIZATION $http_authorization;
    fastcgi_pass unix:/run/php/php-fpm.sock;
    fastcgi_buffering off;
    fastcgi_request_buffering off;
    fastcgi_read_timeout 3600s;
    gzip off;
}
```

其他 PHP location 同样传递 Authorization。CDN / WAF 对 SSE 禁用缓存、响应改写及聚合。
上传大小需覆盖项目附件上限：`client_max_body_size`、PHP `post_max_size`、
`upload_max_filesize` 和 `memory_limit` 需匹配实际使用的文件与编码图片大小。
内置代理返回供应商原 SSE，本机网关持续转发，不将整个响应读入内存。
客户端下载保留 Range / Content-Disposition 等响应头；断线只续订已接受消息。

## 验证

```powershell
npm test --prefix MoonYa-Frontend
dotnet run --project MoonYa-Win/MoonYa-Solution/MoonYa.PythonServiceSmoke/MoonYa.PythonServiceSmoke.csproj
node --test MoonYa-Harness/tests/desktop-gateway.test.mjs MoonYa-Harness/tests/loop.integration.test.mjs MoonYa-Harness/tests/history-recovery.test.mjs MoonYa-Harness/tests/approval.test.mjs MoonYa-Harness/tests/conversation-stats.test.mjs
node --test --test-concurrency=1 MoonYa-Backend/tests/history_store_browser_test.js MoonYa-Backend/tests/full_page_boot_test.js MoonYa-Backend/tests/custom_models_browser_test.js MoonYa-Backend/tests/office_interaction_test.js MoonYa-Backend/tests/subagent_chat_test.js
node --test --test-concurrency=1 MoonYa-Backend/tests/auth_ui_contract_test.js MoonYa-Backend/tests/compaction_ui_test.js MoonYa-Backend/tests/composer_ime_test.js MoonYa-Backend/tests/context_ring_test.js
node --test MoonYa-Harness/tests/windows-package.test.mjs
php MoonYa-Backend/tests/client_config_test.php
php MoonYa-Backend/tests/request_headers_test.php
python tools/test_server_bundle.py artifacts/php-server-separated
& MoonYa-Harness/scripts/verify-runtime-package.ps1 -OutputRoot artifacts/frontend-client-build
& MoonYa-Win/Installer/Test-ReleasePackage.ps1 -PublishPath artifacts/frontend-client-build
```

2026-09-30 本地验证结果：前端离线与真实网关测试 9 项、Runtime 回归 51 项、
现有前端回归 23 项、Windows 打包回归 2 项全部通过；PHP 公开配置和生成服务器包检查通过。
客户端构建 0 错误，仍有原文件操作服务等既有编译警告；最终客户端目录的资源哈希与
服务器文件排除检查通过。上述两个包检查命令需先将构建输出写入该目录，或替换成自己的输出路径。

自动化使用实际 C# 回环服务、全新 Chrome 配置目录和本地伪服务器验证：无 CDN 启动、
办公室打开、Runtime 故障、历史/草稿/设置重启持久化、迁移失败重试/幂等/用户隔离、
网关凭据与来源拒绝、模型密钥边界、SSE 增量传输、停止/审批及持久化执行去重。
自动化不能替代生产账号与真实供应商验收。部署后逐项人工验证：

1. 全新安装清空缓存，断开网络且 PHP 不可达，主界面和办公室仍正常打开。
2. 离线查看已存历史、编辑草稿/设置，重启保留；旧版升级保留历史及二进制附件。
3. 用真实账号登录、内置 Chat / Work、自定义模型、办公室分支和弹窗；附件、审批、停止可用。
4. PHP 和客户端分别放在两台电脑，本地文件/桌面/浏览器操作只作用于用户电脑。
5. 流式生成中断网络并恢复，确认只续订同一消息 ID，不重复执行；Runtime 故障不影响界面。
6. 检查服务器公开配置没有任何密钥，桌面发布目录没有 PHP、服务器配置和数据库凭据。

## 本地联调记录（2026-09-30）

本机 XAMPP 的站点根为 `MoonYa-Backend`，客户端 `backend_url` 为 `http://localhost/`。
修复 Apache 仅通过 `getallheaders()` 提供 Authorization 时，登录检查与退出漏读 Bearer 的问题。
认证入口现共用请求头提取函数；不依赖 PHP 会话 Cookie 维持客户端身份。

`node tools/verify_local_separation.mjs` 使用临时账号、独立 Chrome 配置目录和本机网关，
已实测登录、刷新及网关重启后保持身份，内置 Chat 与 Work 真实模型流式响应，
办公室状态读取、退出并撤销 Token；测试账号自动清理。该命令仅允许本机 PHP 地址，
会调用已配置的真实模型，需要服务端模型配置有效。
前端离线与迁移回归现在为 11 项；新增分批上限及中断导入重试检查，全部通过。
实际 WPF/CEF 客户端也已迁移本机 32 万余条旧事件，原数据与加密备份保留。
