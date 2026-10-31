# MoonYa — Computer Use & 浏览器自动化 技术文档

> 面向桌面与 Web 的视觉-动作自动化能力集，由 LLM 驱动、数据库配置、多层可靠性机制保障。

---

## 目录

- [一、功能概述](#一功能概述)
- [二、整体架构](#二整体架构)
- [三、Computer Use 核心实现](#三computer-use-核心实现)
- [四、Plan-Act-Verify 可靠性模型](#四plan-act-verify-可靠性模型)
- [五、浏览器自动化（BA）集成](#五浏览器自动化ba集成)
  - [5.7 内置浏览器（右侧栏 CEF 面板）](#57-内置浏览器右侧栏-cef-面板)
- [六、SSE 事件流机制](#六sse-事件流机制)
- [七、多 Agent 协同调度](#七多-agent-协同调度)
- [八、风险策略与资源锁](#八风险策略与资源锁)
- [九、API 接口示例](#九api-接口示例)
- [十、测试与验证](#十测试与验证)
- [十一、设计哲学](#十一设计哲学)
- [十二、关键文件索引](#十二关键文件索引)

---

## 一、功能概述

MoonYa 提供两套并行的桌面/Web 自动化能力：

| 能力 | 名称 | 入口模式 | 控制目标 | 适用场景 |
|------|------|---------|---------|---------|
| **Computer Use (CU)** | 计算机使用 | `computer_user_mode=true` | 操作系统桌面、原生应用 | 桌面应用操作、自绘 UI、登录流程、跨应用协同 |
| **浏览器自动化 (BA)** | Browser Automation | `agent` / `computer_user` | 浏览器 DOM 与页面 | 网页抓取、表单填写、Web 应用操控、视觉分析 |

两者共享 LLM 编排、SSE 事件总线、风险策略与资源锁基础设施，但在工具集、传输层与可靠性模型上各自独立。

### 核心特性

- **LLM 驱动 + 数据库配置**：Agent 选择、工具授权、提示词、风险等级均存储在数据库中，运行时不依赖硬编码关键词
- **运行时证据驱动降级**：不依据应用名/进程名预判能力，仅在 UIA 实测失败到阈值才切换视觉模型
- **Plan-Act-Verify 可开关**：可切换反应式循环与三阶段规划架构
- **多层防假完成机制**：哈希对比、独立裁判模型、死循环检测、点击止损
- **统一 Team Event V1 协议**：CU 与多 Agent 协同走同一事件流，前端一套渲染逻辑

---

## 二、整体架构

### 2.1 调用链总览

```
前端 POST api.php (computer_user_mode=true)
        │
        ▼
api.php  解析 $computerUserMode
        │
        ▼ 构建 Multi-Agent v1 运行时
        │   TeamRepository / TeamEventEmitter / ToolGateway / TeamCoordinator
        │
        ▼ 进入 CU 模式分支
        │
        ▼ 构造 CuEventEmitter（或 TeamCuEventEmitter 包装）
        │
        ▼ new AIAssistant($pdo, $config, 'callLauncherViaRelay', $cuEmitter, ...)
        │
        ▼ $cuAssistant->runCuLoop($cuUserMessage, $cuHistory)
        │   ├─ tryHandleLoginAppRequest / tryHandleSimpleOpenAppRequest 快速通道
        │   └─ executeCuLoop()
        │       ├─ 加载 system_prompts.computer_user + CAPABILITY_ROUTING_POLICY
        │       ├─ 注入 scenario_hints（cu_runtime_config JSON）
        │       ├─ 过滤 CU 工具集
        │       ├─ plan_enabled=1 → runPlanActVerifyLoop()
        │       └─ 否则 → 反应式三层降级循环
        │
        ▼ 每轮 queryUiAction → 调用 LLM → 解析 tool_calls
        │
        ▼ handleToolCall → callLauncherViaRelay('http://127.0.0.1:58900/cu-op', ...)
        │
        ▼ SSE 事件经 CuEventEmitter 流式输出到前端
        │
        ▼ runCuLoop finally → saveCuConversationToDatabase + emitter->done()
```

### 2.2 后端服务清单

| 文件 | 角色 |
|------|------|
| `MoonYa-Backend/api.php` | 主入口，CU 分支与 BA 工具分发 |
| `MoonYa-Backend/agent_config.php` | 工具定义 + CU 配置透传 |
| `MoonYa-Backend/Services/AIAssistant.php` | CU 模式 LLM 编排类 |
| `MoonYa-Backend/Services/CuEventEmitter.php` | CU SSE 事件发射器 |
| `MoonYa-Backend/Services/TeamCuEventEmitter.php` | CU 事件 → Team Event V1 适配器 |
| `MoonYa-Backend/Services/TeamEventEmitter.php` | Team Event V1 总线 |
| `MoonYa-Backend/Services/TeamWorkProtocol.php` | Work 协议边界 |
| `MoonYa-Backend/Services/TeamCoordinator.php` | 多 Agent 协调器 |
| `MoonYa-Backend/Services/ToolGateway.php` | 工具网关 |
| `MoonYa-Backend/Services/MultiAgentSchema.php` | Schema + 种子数据 |
| `MoonYa-Backend/Services/RiskPolicy.php` | 风险策略 |
| `MoonYa-Backend/Services/ResourceLockManager.php` | 资源锁管理器 |

### 2.3 C# 端服务（PHP 通过 HTTP 调用）

| 服务 | 端口 | 端点 |
|------|------|------|
| FileOperationApiServer | 58900 | `/file-op`、`/cu-op`、`/cu/window-snapshot`、`/cu/health` |
| ExecutionApiServer | 58903 | `/execute`（SSE 流式） |
| BrowserApiServer | 58905 | `/browser/*`（start/navigate/click/fill/screenshot/scroll/get-text/get-elements/evaluate/wait/stop/status） |
| LspApiServer | 58906 | `/lsp-op` |
| Python 统一服务 | 58901 | `/crawl`、`/search`、`/download/*` |

### 2.4 关键常量

```php
private const CU_MAX_ITERATIONS = 20;             // 单次 CU 运行最大迭代
private const CU_API_TIMEOUT = 30;
private const VLS_API_TIMEOUT = 25;
private const CU_TOTAL_TIMEOUT_SECONDS = 120;     // 整体硬超时
private const LOGIN_MAX_SCREENSHOTS = 3;          // 登录流程最多 3 张截图
private const LOGIN_MAX_VISION_DECISIONS = 3;     // 登录流程最多 3 次视觉决策
private const CU_PROTOCOL_VERSION = 'cu-reliability-v2';
```

---

## 三、Computer Use 核心实现

### 3.1 三层降级架构

CU 模式采用运行时证据驱动的三层降级，**不依赖应用名/进程名预判**：

#### 第一层 — UIA + 坐标操作（默认）

- **工具集**：`capture_ui_snapshot`（首选感知）、`find_element`、`get_ui_tree`、`click_element`、`set_text`、`get_text`、`focus_window`、`mouse_*`、`keyboard_*`、`take_screenshot`
- **切换条件**：UIA 实测连续失败到阈值（`uiaFailureCount`）

#### 第二层 — VLS-Agent 视觉模型

- **模型**：`vls_model`（默认 `moonshot-v1-8k-vision-preview`）
- **工具集**：收窄为 `VLS_TOOL_NAMES`，避免 8K 视觉上下文被无关 schema 占满
- **最大迭代**：`vls_max_iterations`（默认 6）

#### 第三层 — 键盘快捷键策略

- 加载 `keyboard_fallback_strategy` 提示词
- `keyboard_fallback_hints` JSON 提供 QQ/微信/画图 等应用的快捷键映射

### 3.2 CU 工具白名单

```php
private const CU_ACTION_TOOLS = [
    'take_screenshot', 'get_cursor_pos',
    'mouse_move', 'mouse_click', 'mouse_scroll', 'mouse_drag', 'mouse_hold',
    'keyboard_type', 'key_press',
    'task_complete',
    // UIA 元素级工具
    'find_element', 'get_ui_tree', 'click_element', 'set_text', 'get_text',
    'capture_ui_snapshot',           // 首选感知工具
    'focus_window',                 // 窗口管理
    // BA 浏览器自动化工具
    'browser_automation_control',
    'vls_analyze_browser',
];
```

### 3.3 坐标还原逻辑

截图元信息由 `take_screenshot` / `capture_ui_snapshot` 写入 `$lastScreenshotMeta`：

```php
// window-relative 坐标系（capture_ui_snapshot 默认）
screen_x = origin_x + aiCoords[0] / scale_ratio
screen_y = origin_y + aiCoords[1] / scale_ratio

// screen 坐标系（take_screenshot v1 行为）
screen_x = aiCoords[0] / scale_ratio
```

`scale_ratio` 用于 4K 屏降采样还原（例如 3840×2160 → 1430×804，scale≈0.3725）。

### 3.4 截图缩放比例计算

```
longEdgeRatio   = screenshot_max_long_edge / max(width, height)      // 默认 1568
totalPixelRatio = sqrt(screenshot_max_pixels / (width * height))     // 默认 1150000
scaleRatio      = min(longEdgeRatio, totalPixelRatio, 1.0)
```

### 3.5 可靠性机制

| 机制 | 实现 | 说明 |
|------|------|------|
| **点击止损** | `stop_loss_tolerance_px`（默认 10px） | 同坐标 ±10px 仅允许 1 次；UIA `click_element` 豁免 |
| **死循环检测** | `detectToolCallLoop()` | 最近 3 次签名相同 / 最近 6 次中某签名出现 ≥4 次 |
| **空 tool_calls 重试** | `handleEmptyToolCalls` | 上限 `empty_tool_calls_max_retries`（默认 2） |
| **task_complete 验证** | `isTaskCompleteAcceptable` | 哈希对比 + 证据关键词（弹出/出现/消失/变为/已输入/已点击） |
| **UIA 操作效果验证** | `verifyUiActionEffect` | 操作后 settle_ms（默认 350ms）→ 重新 capture → 对比 tree+image hash |
| **用户取消检测** | `shouldStopCuRun` | `connection_aborted()===1` 立即终止 |

### 3.6 登录安全边界

- `extractLoginAppTarget`：识别"登录/登陆 + 应用名"单一任务
- `hasUserExplicitLoginIntent`：正则匹配 14 个模式检测用户明确登录意图
- 触发 `cu_waiting_user` SSE 事件，由 `TeamCuEventEmitter` 转译为 `approval.required`

### 3.7 数据库表

| 表 | 用途 |
|------|------|
| `cu_runtime_config` (id=1) | CU 运行时配置（cu_model/scenario_hints/tool_descriptions/login_detection_keywords/vls_*/plan_*） |
| `cu_app_registry` | 桌面应用注册（app_name/exe_name/launch_method） |
| `system_prompts` | 系统提示词（computer_user / vls_agent / keyboard_fallback_strategy / cu_planner / cu_verifier / cu_step_router） |

---

## 四、Plan-Act-Verify 可靠性模型

### 4.1 三阶段流程

```
Phase 1 — Plan（generatePlan）
   LLM (plan_model) 拆解用户目标为步骤列表
   输出 JSON: {"steps":[{"id","title","task_type","expected_outcome"}]}
   步骤数 2-10 个，expected_outcome 必须可视觉验证
   emitter->plan($plan) 发送 cu_plan 事件给前端
        │
        ▼
Phase 2+3 — 逐步 Act + Verify（per step）
   for each step in plan:
       ├─ routeByTaskType(task_type, cuMessages, step)  // 注入路由提示
       ├─ while verifyRound <= verify_max_rounds:
       │   ├─ executeStep(...)                         // 执行步骤
       │   ├─ verifyStepCompletion(step, userGoal)     // 独立裁判
       │   │   ├─ take_screenshot → base64
       │   │   ├─ 调用 verify_model（thinking 禁用，temperature=0.1）
       │   │   └─ 解析 JSON: {completed, reason, missing}
       │   ├─ emitter->verify(stepIndex, completed, reason, missing, round)
       │   └─ 若未完成且 round < max → verifyRound++，注入补全指令
       └─ 步骤间注入 system 消息 "步骤「{title}」已完成，现在进入下一步"
        │
        ▼
最终汇总
   allCompleted → cu_complete(success)
   否则        → cu_complete(limited)，列出 failedSteps
```

### 4.2 配置字段（`cu_runtime_config`）

```sql
plan_enabled TINYINT(1) DEFAULT 0        -- 0=关闭走原逻辑，1=启用 PAV
plan_model VARCHAR(100) DEFAULT 'deepseek-v4-pro'
verify_model VARCHAR(100) DEFAULT 'kimi-k2.5'   -- 必须为视觉模型
verify_max_rounds INT DEFAULT 3          -- 单步骤验证失败最大补全轮次
plan_max_steps INT DEFAULT 10            -- Plan 阶段最大步骤数
step_action_max_iterations INT DEFAULT 20 -- 单步骤 Act 最大迭代
verify_token_budget INT DEFAULT 2000     -- Verify LLM 最大 token
```

### 4.3 任务类型（task_type）

`task_type ∈ {drag, click, type, key, observe, scroll}`，由 `cu_step_router` 提示词决定每类任务的工具策略。

### 4.4 前端渲染

| SSE 事件 | 前端渲染 |
|---------|---------|
| `cu_plan` | 渲染 `.cu-plan-card` 任务计划卡片 |
| `cu_step_progress` | 更新步骤状态（pending/active/verifying/completed/failed/retrying） |
| `cu_verify` | 渲染 `.cu-verify-result` 验证结果节点 |

---

## 五、浏览器自动化（BA）集成

### 5.1 BA 工具定义

两个工具均带 `mode_gate: ['agent', 'computer_user']`，由 `filterAgentToolsByMode` 按会话模式过滤。

#### `browser_automation_control` — 浏览器操控合集

```php
'action'    => enum: start|navigate|click|fill|screenshot|scroll|stop
'url'       => action=start/navigate 时必填
'selector'  => action=click/fill 时必填（CSS 选择器）
'text'      => action=fill 时必填
'direction' => action=scroll 时必填（up/down）
'amount'    => action=scroll 时必填
```

#### `vls_analyze_browser` — 调用 VLS-Agent 视觉分析当前浏览器页面（无参数，自动截图）

### 5.2 后端分发

api.php 在工具分发阶段识别 BA 工具集，统一通过 `callLauncherViaRelay` 转发到 C# `BrowserApiServer`（`127.0.0.1:58905`）：

```php
$baToolNames = ['browser_automation_control', 'vls_analyze_browser', 'browser_auth'];
$baRelayUrl  = 'http://127.0.0.1:58905';

// action → endpoint 映射
$baEndpointMap = [
    'start'      => '/browser/start',
    'navigate'   => '/browser/navigate',
    'click'      => '/browser/click',
    'fill'       => '/browser/fill',
    'screenshot' => '/browser/screenshot',
    'scroll'     => '/browser/scroll',
    'stop'       => '/browser/stop',
];
```

辅助端点：`/browser/get-elements`（获取可交互 DOM，含 `in_modal` 标志）、`/browser/status`（页面 URL/title）、`/browser/evaluate`（执行 JS）。

### 5.3 防循环策略

| 策略 | 阈值 | 行为 |
|------|------|------|
| 连续 screenshot 拦截 | `>= 3` | 直接返回错误，迫使 AI 换策略（用 dom_elements 或调 `vls_analyze_browser`） |
| 同选择器无效点击拦截 | `>= 3` | 引导换 selector 或调 VLS |

### 5.4 VLS 浏览器分析流程

`vls_analyze_browser` 工具执行流程：

1. `callLauncherViaRelay($baRelayUrl . '/browser/screenshot', '{}', 30)` 取截图
2. 调用视觉模型（`vls_model`）分析页面
3. `callLauncherViaRelay($baRelayUrl . '/browser/get-elements', '{}', 10)` 获取 DOM
4. 通过 `vls_analysis` SSE 事件返回元素布局与交互建议

### 5.5 多 Agent 路径

在 Work 模式下，`browser` Agent 通过 ToolGateway 调用 BA 工具：

- `dispatch()` 匹配 `transport='browser'`
- `vls_analyze_browser` 特殊处理：调 `/browser/screenshot` 并补充结构化 content
- 其它 BA 工具调 `/browser/execute`

### 5.6 BA SSE 事件

```php
baScreenshot(string $imageBase64, int $index)   // ba_screenshot
baStatus(string $status, string $action)        // ba_status (starting|navigating|clicking|completed|error)
vlsAnalysis(array $elements, string $summary)   // vls_analysis
```

前端 `window.BaPanel` 全局对象提供 `appendScreenshot`、`appendStatus`、`renderVlsAnalysis`，BA 面板仅在 `agent` / `computer_user` 模式下显示。

### 5.7 内置浏览器（右侧栏 CEF 面板）

> 目标：**未安装 Google Chrome 的电脑也能执行浏览器自动化**，并且用户与 Agent 看到的是同一个浏览器。

#### 5.7.1 引擎选择

`browser_automation.builtin`（`launcher_config.json`）：

```json
"builtin": {
  "enabled": true,                     // 关闭后完全回到外部 Chrome 链路
  "prefer": true,                      // 内置可用时优先内置（no-Chrome 场景的关键）
  "remote_debugging_port": 58908,      // CEF 远程调试端口（仅回环）
  "open_panel_on_start": true,          // 会话开始自动展开右侧栏"浏览器"页签
  "keep_rendering_when_hidden": true,   // 面板收起时仍出帧（截图依赖）
  "isolate_profile": true,              // 面板使用独立 RequestContext（隔离 cookie/缓存）
  "cache_path": "%LOCALAPPDATA%\\MoonYa\\CefCache\\BrowserPanel",
  "start_page": "Assets\\browser_start.html",
  "connect_timeout_ms": 8000
}
```

`BrowserAutomationService.StartAsync` 的决策顺序：

1. `headless=true` → 只能外部引擎；
2. `builtin.prefer && 内置可用` → 内置（连接失败且存在外部浏览器时自动回退，两条失败原因合并进错误信息）；
3. 否则外部 Chrome/Edge（`chromium_executable_path` / `chromium_candidate_paths`）；
4. 都不可用 → `browser_launch_failed`（错误信息包含两类原因，便于定位）。

环境变量覆盖（生产部署无需改随包配置）：
`MOONYA_BUILTIN_BROWSER_ENABLED`、`MOONYA_BUILTIN_BROWSER_PORT`、`MOONYA_CEF_CACHE_PATH`（主 CEF 缓存根目录，便携部署/隔离测试用）。

#### 5.7.2 实现结构

| 组成 | 说明 |
|------|------|
| `MainWindow.xaml` 的 `BuiltinBrowserLayer` | 与主 WebView 同格的 Canvas 覆盖层，坐标原点一致 |
| `MainWindow.BuiltinBrowser.cs` | 面板控件懒创建、比例矩形定位、状态回推、JS 桥 `moonYaBrowserPanel` |
| `PanelChromiumWebBrowser.cs` | OSR 控件：隐藏时保持渲染 + 抓取 OSR 帧作为截图兜底 |
| `PanelRequestHandler.cs` | 请求级：Chrome UA 覆盖、证书错误放行、弹窗原地导航、JS 对话框、下载落地 |
| `BuiltinBrowserHost.cs` | App 级宿主：把"确保面板/会话开始结束/复位/兜底截图"转发到窗口（Dispatcher） |
| `script-6-browser-panel.php` + `css-18-builtin-browser.php` | 面板外壳（多标签条/「+」菜单/展开/折叠）、浏览器工具栏与两个菜单、视口矩形上报、状态渲染 |

UI 流程：右侧栏面板外壳的「+」菜单里选「浏览器」（桥可用时才出现）→ 页面把 `#teamBrowserViewport` 矩形按**视口比例**上报 → C# 乘以 WebView 的 DIP 尺寸定位 CEF 控件（DPI/缩放/侧栏折叠无需特判）→ 控件获得真实尺寸后 CefSharp 按常规路径创建底层浏览器。

#### 5.7.3 面板外壳（工作面板已并入浏览器式外壳）

右侧栏工作面板**不再有独立的标题头与页签排**：它们已整体并入浏览器式外壳
（样式对齐参考图：浅灰标签条 + 白色圆角菜单 + 图标/文字）。

**多标签模型**（`script-6-browser-panel.php` 的 `tabs` 数组，标签条由 JS 渲染）：

- 工作日志 / 产出物 / 预览**各最多一个标签**；**浏览器（新标签页）可以开多个**；
- 已经打开的视图不再出现在「+」菜单里（浏览器入口始终保留，每次点＝新建一个浏览器标签）；
- 多个浏览器标签**共用一个内置浏览器内核**：每个标签记住自己的地址与标题，切到某标签＝把该地址加载进内核（后台标签不保留页面实时状态、表单与滚动位置）；
- 没有任何标签时＝**首页空状态**：显示视图列表（图标 + 文字，不带快捷键 pill），标签与「+」都不显示。

| 区域 | 元素 | 行为 |
|------|------|------|
| 标签条 | `#panelTabStrip` 里的 `.bp-tab`（图标 + 文字 + ×） | 每个标签一个胶囊，当前标签高亮；点标签＝切换，点 × 或中键＝关闭该标签；浏览器标签显示网页标题与地球图标，其余显示「工作日志/产出物/预览」 |
| 标签条 | `#panelViewMenuBtn`「+」 | 新建标签页（`#panelViewMenu`：工作日志/产出物/预览/浏览器、——、清空当前日志、关闭工作面板） |
| 标签条 | `#teamBrowserExpand` | 面板宽度在「当前宽度 ⇄ 可用最大宽度」间切换；上限按左侧边栏**当前**状态扣除，因此永远不会连带收起左侧边栏（已经在上限时点击＝收回默认宽度） |
| 标签条 | `#panelCollapseBtn` | 折叠整个工作面板（等同关闭工作面板），再展开走顶栏的「操作详情」按钮 `#detailToggleContainer` |
| 首页 | `.bp-home` 列表 | 没有标签时的视图入口 + `#detailPanelClear`（清空当前日志）/ `#detailPanelClose`（关闭工作面板） |
| 工具栏 | `#teamBrowserBack/Forward/Reload` | **仅浏览器视图显示**；禁用态随 `state.can_go_back/forward`，加载中 `#teamBrowserReload` 旋转且点击变为 `stop` |
| 工具栏 | `#teamBrowserAddress` + `#teamBrowserGo` | 回车/点箭头导航：URL 直连，含空格或无点走 Bing 搜索，缺 scheme 补 `https://` |
| 工具栏 | `#teamBrowserMenuBtn`「⋮」 | 打开**浏览器菜单**（`#teamBrowserMenu`） |

**默认宽度**：右侧栏首次展开取容器宽度的 **45%**（不窄于 430px），并收在
`maximumPanelWidthWithExpandedSidebar()` 之内 —— 默认宽度自身不会挤掉左侧栏，所以首次展开时
左侧栏保持展开（1434px 窗口＝面板 645px，主对话 548px）。要更宽就拖分割边（上限仍保留
「主对话 520px + 左侧栏」，超出时左侧栏按既有规则收起），或点标签条的展开按钮。
用户拖动后的宽度记在 `localStorage` 的 `moonya.team.panel.width.v4`。

菜单样式：图标 + 文字，白底圆角 + 阴影（视图菜单不带快捷键 pill；浏览器菜单保留快捷键 pill）。

- **视图菜单**：工作日志、产出物、预览、浏览器、——、清空当前日志（id `detailPanelClear`）、关闭工作面板（id `detailPanelClose`）
- **浏览器菜单**：新标签页（Ctrl+T，＝新建浏览器标签）、刷新（Ctrl+R）、复制网址、在系统浏览器打开、放大（Ctrl+=）、缩小（Ctrl+-）、重置缩放（Ctrl+0，pill 实时显示当前百分比）

**兼容既有逻辑**：视图菜单项保留 `data-team-tab` 与 `aria-controls`，因此 script-1e 的
`activateTeamTab()` 与「产出物→预览」联动完全不用改（本模块切视图也是点击这些锚点）；
`teamArtifactCount`、`detailPanelClear`、`detailPanelClose` 等 id 全部保留。
待命指示 `teamLiveIndicator` 已按要求删除，script-1e 的 `teamSetLive()` 找不到元素时会直接跳过。

**布局**：面板自身 `padding: 0`，外壳顶到面板边缘；非浏览器视图（工作日志/产出物/预览）在
`.team-panel-pane` 上补 12px 内边距，观感与改造前一致；浏览器视图（导航条 + 网页视口）铺满面板。

**覆盖层挂起机制（必须遵守）**：CEF 覆盖层永远画在 HTML 之上，所以菜单与网页重叠时会被盖住。因此
`openMenu()` → `setVisible(false)`（挂起覆盖层）→ 关闭时 `lastBoundsJson=''` 强制重报矩形恢复。
`reportBounds()` 在 `menuSuspended` 期间只发送 `setVisible(false)`，防止 ResizeObserver/MutationObserver
把覆盖层重新显示出来；菜单条目一律「先关菜单恢复覆盖层，再执行动作」。

**MutationObserver 写值约束（踩过的坑）**：面板子树被 `MutationObserver` 观察
（`attributeFilter: ['class','hidden']` + `childList`）。给元素**重复赋同一个 hidden/文本**也会产生
一条 mutation 记录 → 观察者 → `reportBounds()` → 再赋值，形成死循环（渲染进程 100% CPU、页面假死、
CDP 完全无响应）。因此面板内所有 `hidden`/`textContent` 写入都必须先比较当前值（`setHidden()`），
菜单的显隐也不能触发"顺手关菜单"（只在**视图变化**时才 `closeMenu()`）。

**快捷键**：视图/标签切换**不绑定**快捷键；`Ctrl+T/R/W/=/−/0` 仅在浏览器视图生效
（`Ctrl+T` ＝ 新建浏览器标签，`Ctrl+W` ＝ 关闭工作面板）。与既有 `Ctrl+K`（script-1d-dom.php）
和 C# 侧 `Ctrl+Space`（PTT）无冲突。

缩放在 CEF 面板浏览器实例上生效（`ZoomLevel`，夹紧 ±3），`stop`/复位时归 0（100%）。

**动效约定（css-18 + script-6）**：面板内所有状态变化都带过渡，且刻意与全站既有节奏对齐。

| 主题 | 规则 |
|------|------|
| 令牌 | `--bp-dur-fast 110ms`（退场/按下）、`--bp-dur 160ms`（控件/菜单）、`--bp-dur-slow 180ms`（内容面）；入场 `cubic-bezier(.2,.8,.2,1)`，退场 `cubic-bezier(.4,0,1,1)` |
| 面板级 | 开合与宽度沿用 css-06 的 `0.3s ease`（本模块不改），与左侧栏折叠同拍 |
| 菜单 | `is-open` 播 `bp-menu-in`（与 css-06 的 `team-menu-in` 同形：位移 + 轻微缩放 + 淡入），`is-closing` 播 `bp-menu-out`；菜单项按 `--i` 错峰 10ms。**退场动画结束才置 `hidden`** |
| 标签 | 新增 `is-entering`（`bp-tab-in`：宽度从 0 长出来）；关闭 `is-closing`（宽度收到 0、`margin-right:-4px` 抵消 gap）后再移除节点；标题真变化时轻微淡一下 |
| 内容面 | 日志/产出物/预览 `bp-pane-in`；首页列表 `bp-row-in` 逐行错峰；**浏览器面板只做淡入**（transform 会让视口矩形逐帧位移，覆盖层跟不上） |
| reduced-motion | CSS 由 css-06 的 `.team-panel *` 全局规则兜底（`animation:none !important`、`transition-duration:.01ms !important`）；JS 侧统一走 `prefersReducedMotion()`（**实时**查询 `matchMedia`，系统设置改了不用刷新），命中时不加类、不排定时器、不平滑滚动 |

两条必须遵守的实现约束：

1. **标签节点只能增量复用**（`renderTabs()` 按 id reconcile，只有新增节点加 `is-entering`）。若按"整条重建"实现，切换标签会把所有入场动画重放一遍——有动画反而更生硬。
2. **覆盖层必须跟帧**：`transform` 位移不会触发 `ResizeObserver`，所以面板开合/宽度过渡期间由 `transitionstart`/`animationstart` → `syncBoundsWhileAnimating()` 逐帧 `reportBounds()`；面板收起时 `overlayShouldShow()` 在过渡未结束前继续返回 true（网页跟着滑出，而不是瞬间消失），过渡结束后才 `setVisible(false)`，另有 520ms 兜底保证不会卡在可见态。菜单退场期间覆盖层保持挂起，直到 `endMenuClose()` 才恢复，否则网页会盖住正在淡出的菜单。

验证脚本（`.test-obj/builtin-browser-test/`）：`motion-check.js`（菜单入退场/覆盖层时序/标签节点复用与入退场）、`bounds-sync-check.js`（包一层桥方法，断言过渡期间 `setBounds` 逐帧上报且 `setVisible(false)` 出现在过渡之后）、`motion-check-reduced.js` + `cdp-reduced-motion-reload.ps1`（注入 `matchMedia` 覆盖并重载；注意 CEF 不支持 `Emulation.setEmulatedMedia` 的 `prefers-reduced-motion`）。

#### 5.7.4 CDP 连接

- 宿主从 CEF 的 `/json/list` 取面板页面的 `id`（CDP target id）与地址，交给自动化引擎；
- 连接走**浏览器级端点** `http://localhost:<port>`（PuppeteerSharp `ConnectAsync`），再按 `target id → window.name 标记 → 地址` 三路信号选中面板页面（`BuiltinTargetMatcher`）；
- 面板由 C# 在每次 `FrameLoadEnd` 后写入 `window.name='moonya-builtin-panel'` 作为跨导航保留的兜底标记；
- **不能使用页面级端点**：PuppeteerSharp 建连时会调用浏览器域命令（`Target.getBrowserContexts`），而 CEF 在页面会话里拒绝浏览器域命令（`Protocol error: Not allowed`）；
- 连接失败重试 5 次（宿主侧会等到面板页面级端点可用为止），全部失败才回退外部引擎。

#### 5.7.5 行为约定

| 主题 | 行为 |
|------|------|
| 标签页（自动化语义） | **单页面**：内置浏览器只有一个 CEF 页面（Agent 会话驱动它），因此 `new_tab` 等价于在当前页面打开（返回同一 `tab_id`）、`list_tabs` 返回一条、`close_tab` 回新标签页；界面上的"多标签"是外壳层概念，多个浏览器标签共用这一个页面（各自记住地址，切换时加载） |
| 截图 | 主路径 CDP `Page.captureScreenshot`（实测 CEF OSR 可用）；失败回退面板最近一帧 OSR 位图编码 PNG；再失败抛 `screenshot_unavailable` |
| 下载 | `PanelDownloadHandler` 静默落到 `browser_automation.download_directory`，`list_downloads` 从磁盘枚举 |
| 证书 | 与外部链路 `AcceptInsecureCerts=true` 语义一致，交由 `BrowserSecurityGate` 站点确认流程处理 |
| JS 对话框 | 与 Puppeteer 默认一致（自动关闭），`beforeunload` 放行，避免自动化挂起 |
| 弹窗 | `window.open` / `target=_blank` 在面板内原地导航（单页面语义） |
| 主页面标签 | 界面多标签只影响外壳（切标签＝把该标签记住的地址加载进同一个 CEF 页面）；Agent 自动化始终驱动这个页面 |
| 面板被收起 | 会话期间保持 CEF 渲染，截图与操作继续有效 |
| 主页面刷新 | 覆盖层先隐藏，等新页面重新上报矩形后恢复；面板浏览器实例与登录态保留 |

#### 5.7.6 安全边界

- 远程调试端口**仅回环**（CEF 默认绑定；连接侧统一用 `localhost` 以兼容 IPv4/IPv6 绑定差异），与既有本地服务（58900–58907）同一信任模型，可用 `builtin.enabled=false` 彻底关闭；
- 面板浏览器**不注册任何 MoonYa JS 桥**（浏览外部站点时没有本机文件/命令能力），桥 `moonYaBrowserPanel` 只在主界面 WebView 上注册并校验来源；
- 面板使用独立 `RequestContext`（独立 cookie/缓存），与主界面会话隔离；CEF 要求该 `cache_path` 必须是根缓存目录的子目录。

#### 5.7.7 已知限制与排查

- **`data:` URL 导航会让面板渲染进程触发 CEF 断言崩溃**（`libcef` STATUS_BREAKPOINT）→ 内置浏览器只用于真实 http(s)/file 站点；自动化语句不要用 `data:` 页面；
- 同一面板同一时刻只应由一个 CDP 客户端驱动（应用自身的自动化服务）；外部调试客户端同时 attach 可能使面板渲染进程崩溃；
- 面板浏览器在"首次需要显示"时创建：若页面上报失败（旧缓存页面），自动化会报"面板 不可用"并回退外部引擎；
- 排查顺序：`Get-Process chrome`（是否误用外部引擎）→ `curl http://localhost:<port>/json/list`（面板目标是否存在）→ `cef.log` / 事件查看器（子进程崩溃）→ 用 `MoonYa.BrowserSmoke --connect <port>` 复现连接与动作。

#### 5.7.8 冒烟验证

```powershell
# 1) 启动桌面端（可选指定端口），在应用内让面板创建（Agent start 或打开"浏览器"页签并访问一次）
# 2) 释放面板：调用 /browser/execute {action:stop}，确保没有其他 CDP 客户端
# 3) 内置浏览器全量冒烟（自动清空外部浏览器候选路径 = 模拟未安装 Chrome 的机器）
MoonYa.BrowserSmoke.exe --connect 58908
# 纯逻辑契约（无需浏览器）：配置解析、引擎选择、目标匹配
MoonYa.BrowserSmoke.exe
```

---

## 六、SSE 事件流机制

### 6.1 三层流式架构

| 层次 | 协议 | 实现 |
|------|------|------|
| Provider → MoonYa 后端 | OpenAI SSE | `TeamCoordinator::requestModelBatch` 用 `curl_multi` + `CURLOPT_WRITEFUNCTION` 流式解析 |
| MoonYa 后端 → 前端 | 自定义 SSE | `CuEventEmitter::send` / `TeamEventEmitter::emit` |
| 前端 → 后端 | `fetch` + `ReadableStream`（非 EventSource） | `script-1e-rest.php` |

### 6.2 CuEventEmitter 事件类型表

| 方法 | 事件 type | 关键字段 | 用途 |
|------|---------|---------|------|
| `thinking($text)` | `cu_thinking` | content | AI 推理文本 |
| `status($text)` | `cu_status` | content | 即时状态更新 |
| `screenshot($b64, $index, $ts)` | `cu_screenshot` | image/index/timestamp | base64 PNG |
| `action($type, $target, $method)` | `cu_action` | action_type/action/target/method/timestamp | 鼠标/键盘/UIA 动作 |
| `step($idx, $type, $text, $status)` | `cu_step` | step_index/step_type/text/status | 通用步骤 |
| `complete($summary, $status, $count)` | `cu_complete` | summary/status/step_count | 任务完成 |
| `waitingUser($app, $reason, $prompt, $sec)` | `cu_waiting_user` | app/reason/prompt/remaining_seconds | 桌面登录安全边界等待 |
| `launcherRequest($id, $url, $body)` | `launcher_request` | request_id/url/method/body | 转发请求调试 |
| `baScreenshot($img, $idx)` | `ba_screenshot` | image/index | 浏览器自动化截图 |
| `baStatus($status, $action)` | `ba_status` | status/action | 浏览器状态 |
| `vlsAnalysis($elements, $summary)` | `vls_analysis` | elements/summary | 视觉布局分析 |
| `plan($steps, $raw)` | `cu_plan` | steps/raw/timestamp | Plan 阶段步骤计划 |
| `stepProgress(...)` | `cu_step_progress` | step_index/total_steps/step_title/task_type/status | 步骤执行进度 |
| `verify(...)` | `cu_verify` | step_index/completed/reason/missing/verify_round | Verify 阶段独立裁判 |
| `heartbeat()` | (SSE 注释) | — | `: heartbeat\n\n` keep-alive |
| `done()` | `done` | — | 终止 SSE 流 |

### 6.3 TeamCuEventEmitter 适配映射

`TeamCuEventEmitter` 继承 `CuEventEmitter`，将 CU 运行时事件适配为统一 Team Event V1 协议：

| CU type | Team 事件 |
|---------|----------|
| `cu_thinking` | `emitDelta('reasoning', content, ...)` |
| `cu_action` | `tool.started`（tool_key=action_type，display_name='桌面操作'）→ 记录 lastActionCallId |
| `cu_screenshot` | `tool.completed`（tool_key='take_screenshot'，content='已获取屏幕快照'） |
| `cu_step` / `cu_step_progress` / `cu_verify` / `cu_plan` | `completeLastAction` → `agent.summary` |
| `cu_waiting_user` | `approval.required`（external_user_action=true） |
| `cu_complete` | `completeTurn(completed/partial)` → `agent.completed` 或 `agent.failed` |
| `cu_status` | `agent.summary` |

### 6.4 Team Event 信封结构

```php
[
    'type'             => 'team_event',
    'version'          => 1,
    'run_id'           => $this->runId,        // UUID
    'seq'              => $this->seq,          // 单调递增
    'event'            => 'agent.turn.started',
    'timestamp'        => gmdate('c'),         // ISO 8601
    'agent'            => ['key','name','avatar_url','role_summary'],
    'parent_agent_key' => 'moonya',
    'task_id'          => 'task-1',
    'tool_call_id'     => 'call_xxx',
    'payload'          => TeamRepository::redact($payload),  // 脱敏
]
```

### 6.5 Keep-alive

- `CuEventEmitter::heartbeat()`：`: heartbeat\n\n`（SSE 注释）
- `TeamEventEmitter::heartbeat()`：`: team-heartbeat\n\n`
- `ToolGateway::waitForApproval` 每 5 秒发一次 heartbeat 防止客户端断开

---

## 七、多 Agent 协同调度

### 7.1 Agent 体系

| agent_key | display_name | 角色 | is_coordinator |
|-----------|--------------|------|----------------|
| `moonya` | MoonYa | 团队负责人，任务分解与综合 | ✅ |
| `app` | APP Agent | 应用检测、安装、卸载、打开与关闭 | — |
| `computer` | Computer Agent | 系统状态和桌面 CU 操作 | — |
| `browser` | Browser Agent | 浏览器自动化、网页抓取与视觉分析 | — |
| `file` | File Agent | 文件、目录、搜索、编辑和 Office 产物 | — |
| `search` | Search Agent | 联网搜索和来源抓取 | — |
| `code` | Code Agent | 代码浏览、编辑、执行与 LSP 分析 | — |

### 7.2 工具授权矩阵

```php
'computer' => array_merge($common, [
    'get_system_status', 'capture_ui_snapshot', 'take_screenshot',
    'get_cursor_pos', 'mouse_move', 'mouse_click', 'mouse_drag',
    'mouse_hold', 'mouse_scroll', 'keyboard_type', 'key_press',
    'find_element', 'get_ui_tree', 'click_element', 'set_text',
    'get_text', 'focus_window', 'task_complete', 'open_app',
]),
'browser' => array_merge($common, [
    'browser_automation_control', 'vls_analyze_browser',
    'web_fetch', 'web_crawler',
]),
```

### 7.3 工具传输类型

```php
$cu      = ['capture_ui_snapshot', 'take_screenshot', ..., 'focus_window', 'task_complete'];  // → launcher_cu
$browser = ['browser_automation_control', 'vls_analyze_browser'];                             // → browser
// CU 工具 transport_config:      ['action' => $legacyName, 'endpoint' => '/cu-op']
// Browser 工具 transport_config: ['action' => $legacyName, 'endpoint' => '/browser/execute']
```

### 7.4 委派工具协议

MoonYa 唯一可见工具 `delegate_to_agents`：

```php
'parameters' => [
    'type' => 'object',
    'properties' => [
        'tasks' => [
            'type' => 'array', 'minItems' => 1, 'maxItems' => 12,
            'items' => [
                'type' => 'object',
                'properties' => [
                    'id'          => 'string',  // 1-120 位安全标识
                    'agent_key'   => 'string',  // enum: 子 Agent key 列表
                    'instruction' => 'string',  // 完整可独立执行的子任务说明
                    'context'     => 'string',  // 补充上下文
                    'depends_on'  => 'array',   // 依赖任务 id 列表
                ],
                'required' => ['id', 'agent_key', 'instruction'],
            ],
        ],
    ],
],
```

### 7.5 依赖调度与并行执行

```
1. validateTasks：
   - tasks 非空数组，≤12 项
   - id 唯一且匹配 /^[A-Za-z0-9._-]{1,120}$/
   - agent_key ∈ MoonYa 委派白名单
   - instruction 非空
   - depends_on 引用存在且无环、无自依赖

2. 调度循环：
   while pending != []:
       ready = [task ∈ pending | depends_on 全部已 results]
       if ready == []: 报循环依赖错误
       foreach batch in array_chunk(ready, max_parallel_agents=3, true):
           runAgentBatch(batch)  // curl_multi 并行
       collect results → unset from pending

3. 最终 toolResult(ok=true, summary, results, artifacts)
```

### 7.6 CU 直通模式

CU 模式不走 `delegate_to_agents`，直接由 Computer Agent 执行：

```
teamEvents->emit('agent.summary', phase='delegation', tasks=[{id:'direct-cu', agent_key:'computer_agent', ...}])
teamEvents->emit('agent.started', 'computer_agent', 'moonya', 'direct-cu')
$cuEmitter = new TeamCuEventEmitter($teamEvents)
$cuAssistant = new AIAssistant(...)
$cuAssistant->runCuLoop(...)
teamEvents->emit('agent.started', phase='final_synthesis', 'moonya')
TeamEventEmitter::activeDelta('content', $cuSummary)
teamEvents->completeTurn(turnId, $cuStatus, ['mode'=>'computer_user'])
teamEvents->emit($cuStatus === 'failed' ? 'agent.failed' : 'agent.completed', ..., 'moonya')
teamEvents->emit('run.completed', status, 'moonya')
```

---

## 八、风险策略与资源锁

### 8.1 RiskPolicy 审批判定

```php
// 服务端不可变安全边界：未审核的 MCP 工具始终需要人工确认
if ($source === 'mcp' && !$reviewed) return [true, '该 MCP 工具尚未经过管理员审核'];

if ($mode === 'confirm_writes' && $effect !== 'read') return [true, '当前会话设置为"变更前始终确认"'];
if ($mode === 'high_risk' && in_array($risk, ['high', 'critical'], true)) return [true, "工具风险级别为 {$risk}"];
if ($mode === 'full_access') return [false, ''];
return [false, ''];
```

### 8.2 四种审批模式

| 模式 | 行为 |
|------|------|
| `full_access` | 全自动 |
| `high_risk`（默认） | 仅 high/critical 风险需确认 |
| `confirm_writes` | 所有非 read 操作需确认 |
| （不可变边界） | 未审核 MCP 工具无视模式始终需确认 |

### 8.3 风险等级分类

```php
$destructive = ['delete_file', 'uninstall_app', 'stop_command'];     // → destructive / critical
$highWrite   = ['install_app', 'shell_executor', 'execute_command', 'python_executor',
                'mouse_click', 'mouse_drag', 'mouse_hold', 'keyboard_type',
                'key_press', 'click_element', 'set_text'];            // → write / high
$writes      = ['create_folder', 'create_file', 'copy_file', 'move_file', 'edit_file',
                'open_app', 'close_app', 'download_file', 'browser_automation_control'];  // → write / medium
// 其余 → read / low
```

### 8.4 ToolGateway 执行流程

```
1. isRunCancelled 检查 → 直接返回错误
2. canonicalToolName 规范化（execute_command→shell_executor, execute_python→python_executor）
3. getToolForAgent 校验 Agent 工具授权 → forbidden_tool
4. emit('tool.started', tool_key/display_name/arguments/effect/risk_level)
5. RiskPolicy.requiresApproval → 若需确认：
   createApproval + emit('approval.required') + waitForApproval（轮询 100ms，每 5s heartbeat）
   emit('approval.decided') → 若非 allowed 返回 approval_denied/expired
6. ResourceLockManager.keysFor + acquire（emit 'tool.locked'）→ try/finally release
7. dispatch(tool, toolKey, arguments) 按 transport 分发：
   - launcher_file  → callLauncherFile (POST http://127.0.0.1:58900/file-op)
   - launcher_cu    → callLauncherCu   (POST http://127.0.0.1:58900/cu-op)
   - execution      → callExecution    (POST http://127.0.0.1:58903/execute)
   - search         → callSearch       (POST http://127.0.0.1:58901/search)
   - crawler        → callCrawler      (POST http://127.0.0.1:58901/crawl)
   - browser        → callBrowser      (POST http://127.0.0.1:58905/browser/*)
   - mcp            → callMcp          (POST http://127.0.0.1:58900/mcp-op)
   - php_native     → 错误（由 MoonYa 主运行时执行）
8. extractArtifacts 从 structured_content 提取文件 URI → createArtifact + emit('artifact.created')
9. emitToolCompleted
```

### 8.5 审批超时与心跳

```php
while (true) {
    $status = getApprovalStatus($approvalId, $userId);
    if ($status !== 'pending') return $status;
    if (isRunCancelled(runId)) return 'denied';
    if (connection_aborted()) return 'denied';
    if (time() - $lastHeartbeat >= 5) { events->heartbeat(); $lastHeartbeat = time(); }
    usleep(100000);  // 100ms 轮询
}
```

### 8.6 审批表结构

```sql
CREATE TABLE tool_approvals (
  id CHAR(36) PRIMARY KEY,
  run_id CHAR(36),
  user_id INT,
  conversation_id INT,
  agent_key VARCHAR(80),
  tool_call_id VARCHAR(180),
  tool_key VARCHAR(160),
  arguments_hash CHAR(64),
  reason VARCHAR(1000),
  status ENUM('pending','allowed','denied','expired'),
  expires_at TIMESTAMP,
  decided_at TIMESTAMP NULL
);
```

`approval_timeout_seconds` 默认 600 秒。

---

## 九、API 接口示例

### 9.1 CU 模式入口请求

```http
POST /api.php
Content-Type: application/json

{
  "message": "打开QQ并发送消息给张三",
  "computer_user_mode": true,
  "conversation_id": 123,
  "user_id": 1
}
```

响应：`text/event-stream` SSE，依次发射 `cu_status` → `cu_thinking` → `cu_screenshot` × N → `cu_action` × N → `cu_step` × N → `cu_complete` → `done`。

### 9.2 Work 模式委派请求

```http
POST /api.php
Content-Type: application/json

{
  "message": "搜索 2026 年 AI 趋势并保存为 docx",
  "agent_mode": "agent"
}
```

MoonYa 被强制首轮调用 `delegate_to_agents`：

```json
{
  "tasks": [
    {"id":"t1","agent_key":"search","instruction":"搜索 2026 年 AI 趋势，返回来源 URL","depends_on":[]},
    {"id":"t2","agent_key":"file","instruction":"把搜索结果保存为 docx","depends_on":["t1"]}
  ]
}
```

SSE 事件流：

```
team_event(agent.summary delegation)
  → team_event(agent.started search)
  → team_event(agent.turn.started)
  → team_event(agent.reasoning.delta) × N
  → team_event(tool.started web_search)
  → team_event(tool.completed)
  → team_event(agent.completed)
  → team_event(agent.started file)
  → ...
  → team_event(agent.completed moonya)
  → team_event(run.completed)
  → data: {"type":"done"}
```

### 9.3 工具调用结果结构

```json
{
  "ok": true,
  "content": "已获取屏幕快照",
  "structured_content": { "windows": [...], "accessibility": {...} },
  "artifacts": [{ "uri": "C:/Users/..." }],
  "metadata": { "vault_key": "...", "scopes": [] },
  "error": null
}
```

### 9.4 Team Event 信封示例

```
data: {"type":"team_event","version":1,"run_id":"abc-123","seq":5,"event":"tool.started","timestamp":"2026-07-31T10:00:00+00:00","agent":{"key":"computer","name":"Computer Agent","avatar_url":"/assets/agents/computer-agent.png","role_summary":"..."},"parent_agent_key":"moonya","task_id":"t1","tool_call_id":"call_x","payload":{"tool_key":"capture_ui_snapshot","display_name":"Capture UI Snapshot","arguments":{...},"effect":"read","risk_level":"low"}}

```

### 9.5 CU 直通 cu_complete 事件示例

```
data: {"type":"cu_complete","summary":"所有步骤已完成。用户目标：打开QQ并发送消息给张三","status":"success","step_count":12,"timestamp":1753940400}
```

### 9.6 健康检查

```http
GET /api/cu_health.php
```

```json
{
  "success": true,
  "protocol_version": "cu-reliability-v2",
  "backend_root": "D:\\Project\\Project\\MoonYa\\MoonYa-Backend",
  "build_id": "local-source",
  "coordinator_sha256": "...",
  "emitter_sha256": "...",
  "coordinator_modified_utc": "2026-07-31T10:00:00+00:00"
}
```

---

## 十、测试与验证

### 10.1 cu_smoke_test.php（19 个冒烟测试）

| 测试 | 验证内容 |
|------|---------|
| 1-3 | DB 连接、`cu_runtime_config` 种子、`cu_app_registry` 种子 |
| 4 | `system_prompts.computer_user` 无场景化补丁残留 |
| 5-6 | `loadCuRuntimeConfig()` / `loadToolDescriptions()` 函数可用 |
| 7-8 | `AIAssistant::getCuConfig()` / `buildWindowListText()` 反射调用 |
| 9 | 截图缩放比例计算（3840×2160 → 1430×804，scale≈0.3725） |
| 10 | C# `/cu/window-snapshot` 端点可达性（可选 SKIP） |
| 11-12 | `vls_agent` / `keyboard_fallback_strategy` 提示词 + `keyboard_fallback_hints` JSON |
| 13-14 | 坐标还原 window-relative（scale=1.0 → [1070,542]；scale=0.5 → [2116,1084]） |
| 15 | 用户显式登录意图识别（3 组用例） |
| 16 | 空 tool_calls 重试上限（maxRetries=2） |
| 17-19 | task_complete 哈希变化接受 / 哈希相同拒绝 / 禁用回退 v1 |

### 10.2 cu_reliability_test.php（反射调用私有方法）

通过 `ReflectionClass` 绕过构造函数，覆盖：

- HTML 指令归一化（`<div class="ProseMirror"><p>&nbsp;登陆QQ&nbsp;</p></div>` → `登陆QQ`）
- `extractLoginAppTarget`（"登陆QQ" → 'QQ'；"登录QQ然后发送消息" → null）
- `extractSimpleOpenAppTarget`（"打开QQ" → 'QQ'）
- CU 工具集排除（todo_write/execute_command/edit_file/create_file 不在 CU_ACTION_TOOLS）
- `buildLoginVisionTools` 仅暴露 `login_safe_click` 和 `report_login_state`
- `validateToolTranscript` 多工具调用严格配对
- `adaptMessagesForModel`（Moonshot 仅保留最新截图；MiniMax 剔除全部图片；system 消息归并首部）
- `waitingUser` SSE 结构（含 `remaining_seconds:90`）
- 常量：CU_MAX_ITERATIONS=20 / CU_TOTAL_TIMEOUT_SECONDS=120 / LOGIN_MAX_SCREENSHOTS=3 / LOGIN_MAX_VISION_DECISIONS=3

### 10.3 迁移脚本

- `migrate_cu_plan_act_verify.php`：访问 `?confirm=YES` 执行（HTML 确认页），新增 7 字段 + 3 提示词 + 2 scenario_hints
- `migrate_cu_reliability_v2.php`：CLI only，事务内更新 `cu_runtime_config` 数值字段、`tool_descriptions` JSON、`user_login_intent_keywords`、剥离旧补丁

---

## 十一、设计哲学

1. **LLM 驱动 + 数据库配置**：Agent 选择、工具授权、提示词、风险等级均存储在数据库（`agents` / `tool_registry` / `agent_tool_grants` / `system_prompts` / `cu_runtime_config`），运行时代码不依赖硬编码关键词规则。

2. **运行时证据驱动降级**：不依据应用名/进程名预判 UIA 能力，仅当本轮 UIA 实测失败到阈值才切视觉模型（避免"自绘应用"硬编码假设）。

3. **能力选择顺序**（`CAPABILITY_ROUTING_POLICY`）：直接 API/专用工具 → CLI → 浏览器自动化 → Computer Use 最后。

4. **桌面交互顺序**（`DESKTOP_INTERACTION_POLICY`）：先 `capture_ui_snapshot` → UIA 元素工具 → 坐标鼠标仅作 UIA 不可用回退。

5. **协议边界强制**：MoonYa 必须先委派员工才能综合；员工必须实际调用工具并成功才能声称完成（`tool_execution_required` / `no_successful_tool_result` 错误码）。

6. **多层防假完成**：UIA 操作效果验证（tree+image hash）、task_complete 哈希对比、Plan-Act-Verify 独立裁判模型、死循环检测、点击止损、空 tool_calls 重试上限。

7. **SSE 双协议**：CU 模式直接 `CuEventEmitter`（兼容前端旧协议），Work 模式 `TeamEventEmitter`（统一 Team Event V1），`TeamCuEventEmitter` 适配器桥接两者。

8. **Plan-Act-Verify 可开关**：`plan_enabled` 默认 0 走原反应式循环，开启后走三阶段架构，Plan 失败自动降级到 `runReactiveLoopFallback`。

---

## 十二、关键文件索引

### 后端核心（PHP）

| 文件 | 关键行号/方法 |
|------|--------------|
| [api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api.php) | CU 分支 L2335-2422，BA 分发 L4873-5652，Multi-Agent 运行时 L2194-2263 |
| [agent_config.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/agent_config.php) | L4 loadCuRuntimeConfig，L74 filterAgentToolsByMode，L887-924 BA 工具，L1118-1133 CU/PAV 配置 |
| [AIAssistant.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/AIAssistant.php) | L308 runCuLoop，L1162 executeCuLoop，L4469 runPlanActVerifyLoop，L4977 verifyStepCompletion，L3460 callLauncherViaRelay，L3540 restoreCoordinatesToScreen，L3571 getCuConfig，L4045 buildWindowListText |
| [CuEventEmitter.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/CuEventEmitter.php) | CU SSE 发射器 |
| [TeamCuEventEmitter.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/TeamCuEventEmitter.php) | CU → Team Event 适配器 |
| [TeamEventEmitter.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/TeamEventEmitter.php) | Team Event V1 总线 |
| [TeamWorkProtocol.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/TeamWorkProtocol.php) | Work 协议边界 |
| [TeamCoordinator.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/TeamCoordinator.php) | L70 delegationTool，L130 executeDelegation，L228 runAgentBatch，L489 requestModelBatch |
| [ToolGateway.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/ToolGateway.php) | L42 execute，L167 dispatch，L259 callBrowser，L393 waitForApproval |
| [MultiAgentSchema.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/MultiAgentSchema.php) | Schema + 种子数据 |
| [RiskPolicy.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/RiskPolicy.php) | 风险策略 |
| [ResourceLockManager.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/ResourceLockManager.php) | 资源锁管理器 |

### AIAssistant.php 关键常量与策略

- `CU_ACTION_TOOLS`（L95）— CU 工具白名单
- `CU_LAUNCHER_TOOLS`（L113）— Launcher 转发工具
- `VLS_TOOL_NAMES`（L173）— VLS 视觉模型工具集
- `CAPABILITY_ROUTING_POLICY`（L43）— 能力路由策略
- `DESKTOP_INTERACTION_POLICY`（L60）— 桌面交互策略
- `DEFAULT_LOGIN_KEYWORDS`（L73）— 默认登录关键词
- `DEFAULT_LOGIN_INTENT_KEYWORDS`（L85）— 默认登录意图关键词

### 测试与迁移

| 文件 | 用途 |
|------|------|
| [api/cu_health.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api/cu_health.php) | 健康检查 |
| [cu_smoke_test.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/cu_smoke_test.php) | 19 个冒烟测试 |
| [cu_reliability_test.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/cu_reliability_test.php) | 反射式可靠性测试 |
| [migrate_cu_plan_act_verify.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/migrate_cu_plan_act_verify.php) | Plan-Act-Verify 迁移 |
| [migrate_cu_reliability_v2.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/migrate_cu_reliability_v2.php) | CU v2 可靠性迁移 |

### 前端

| 文件 | 关键行号 |
|------|---------|
| `script/MoonYa-index/modules/script-1e-rest.php` | L3590 cu_plan，L3633 cu_step_progress，L3689 cu_verify，L3715 ba_screenshot，L3723 ba_status，L3730 vls_analysis |

---

## License

本项目采用 [LICENSE](file:///d:/Project/Project/MoonYa/LICENSE) 中声明的协议。
