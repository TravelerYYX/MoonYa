# 浏览器自动化

`browser_automation_control` 的 `browser` 可选值为 `builtin`、`chrome`、`edge`，省略时使用内置浏览器。未选择项目的聊天仍以 `__default__` 工作空间执行；浏览器连接不使用工作目录。冷启动可直接调用 `navigate`，站点审批通过后自动创建面板、连接 CDP 并导航。

```json
{ "action": "navigate", "url": "https://www.xiaohongshu.com" }
```

“插件”页面的“允许操控 Google Chrome”和“允许操控 Microsoft Edge”独立保存，默认关闭。设置通过已认证的本地 `api/browser_settings.php` 接口写入 `.MoonYa/browser-preferences.json`；GET 返回 `preferences`，POST 接收布尔字段 `chrome`、`edge`。保存失败时界面恢复原状态。模型不能通过工具参数开启权限。

只有用户明确选择外部浏览器、对应开关已开启且浏览器已安装，才可调用：

```json
{ "action": "navigate", "browser": "edge", "url": "https://example.com" }
```

外部浏览器使用独立自动化窗口和临时资料目录；内置失败不会启动外部浏览器。三种后端分别维护会话、授权、标签页和元素 ID。授权调用必须携带相同 `browser`。关闭开关会取消在途操作、停止对应自动化会话并拒绝后续操作。

会话 ID 在首次站点挑战之前创建，启动期间不变，停止或操作取消后更新。授权仍校验用户、会话、页面版本和动作。内置连接优先选择宿主面板 target ID，只断开自身 CDP 连接；外部清理只关闭工具创建的浏览器进程。

面板发现和 CDP 连接共享 `builtin.connect_timeout_ms`，操作整体使用 `operation_timeout_ms`，客户端等待使用较长的 `relay_timeout_ms`。Harness 为每次执行生成 `operation_id`，取消时发送 `/browser/cancel`；迟到连接会被清理，迟到任务不能发布有效会话或再次发送 HTTP 结果。诊断文件记录后端、会话、阶段、耗时和原因；关注 `panel-discovery`、`cdp-connect`、`navigation`、`operation` 阶段。

CEF 初始化前检测 `builtin.remote_debugging_port`：可用时保留，遇到占用或应用服务端口冲突时由操作系统分配空闲回环端口，不修改配置文件。宿主、面板发现和 CDP 连接共享该运行时端点；`/json/list` 和 `/json/version` 绕过系统代理，期限统一由连接取消令牌控制。启动诊断记录 `configured_port` 和 `endpoint`，发现超时还记录最近一次面板状态或具体异常。面板已经显示但自动化 `running=false` 表示会话尚未连通，不能据此判定 CEF 没有启动。

## 验证入口

在仓库根目录运行：

```powershell
dotnet run --project MoonYa-Win/MoonYa-Solution/MoonYa.BrowserSmoke -- --contracts-only
dotnet run --project MoonYa-Win/MoonYa-Solution/MoonYa.BrowserSmoke -- --external-browser chrome
dotnet run --project MoonYa-Win/MoonYa-Solution/MoonYa.BrowserSmoke -- --external-browser edge
```

Harness 回归覆盖有项目/无项目、三种审批模式、首次挑战、拒绝/过期/重复挑战、取消和后端路由。前端 `workspace.test.mjs` 覆盖默认关闭、独立保存、重启恢复、认证限制和保存失败回滚。C# 契约回归模拟面板延迟、CDP 不响应、主动取消和迟到完成；完整冒烟运行真实安装的 Chrome/Edge。

真实内置验证需要运行最新版桌面端、保持未选择项目并打开内置面板。下面的夹具创建全新冷浏览器 API 会话，通过真实 Harness 执行导航，不依赖供应商模型凭据。`MOONYA_BROWSER_SMOKE_TARGET` 必须指向内置面板当前地址的一部分，不能指向应用主界面。

```powershell
$env:MOONYA_BROWSER_SMOKE_CDP_PORT = '58909'
$env:MOONYA_BROWSER_SMOKE_URL = 'https://www.xiaohongshu.com'
$env:MOONYA_BROWSER_SMOKE_TARGET = 'browser_start.html'
node --test MoonYa-Harness/tests/browser-integration.test.mjs
```

该连接夹具验证冷会话授权和导航；宿主自动创建面板的真实冷启动仍需在桌面端直接发送“打开小红书网页版”，检查首次审批、观察、停止和再次打开。没有运行桌面端时不能将模拟测试视为这一步通过。
