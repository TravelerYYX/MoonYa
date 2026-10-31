# MoonYa 多 Agent 协作系统 — 开发提示词（给 Codex）





## 一、需求概述

将现有 MoonYa 单 Agent 系统改造为 **7 个 Agent 协作架构**（MoonYa 为队长 + 6 个专业 Agent）。核心改动：

1. **后端**：定义 7 个 Agent 及各自可用工具集合，实现 MoonYa 调度其他 Agent 的机制
2. **工具重命名**：`execute_command` → `shell_executor`，`execute_python` → `python_executor`；所有 Agent 均可使用这两个工具
3. **前端**：对话区域只显示用户消息 + MoonYa 最终回复；操作详情区域改为三 Tab（工作日志 / 产出物 / 预览），以树形层级展示所有 Agent 调用、工具调用、思考内容
4. **头像**：7 个 Agent 头像在对话区域和操作详情区域均显示

---

## 二、项目技术栈说明

- **后端**：PHP，入口 `MoonYa-Backend/api.php`，配置在 `MoonYa-Backend/agent_config.php`，CU 逻辑在 `MoonYa-Backend/Services/AIAssistant.php`
- **前端**：PHP 服务端渲染 + 原生 JavaScript（非 Vue/React），通过 CefSharp 浏览器加载
- **SSE 通信**：前端通过 `fetch + ReadableStream` 流式读取，不使用 EventSource
- **前端关键文件**：
  - `wwwroot/script/MoonYa-index/layouts/main-content.php` — 页面布局（对话区 + 操作详情面板）
  - `wwwroot/script/MoonYa-index/modules/script-1e-rest.php` — SSE 解析与消息渲染
  - `wwwroot/script/MoonYa-index/styles/css-07-agent.php` — Agent 相关样式
  - `wwwroot/script/MoonYa-index/styles/css-15-result.php` — 详情面板样式
- **现有 Agent 切换机制**：`api.php` 中 `agent_switch` SSE 事件目前仅用于 ZTimage-Agent ↔ MoonYa Agent 双向切换（L3736、L3946）；前端处理在 `script-1e-rest.php` L1923-1943
- **现有操作详情面板**：`main-content.php` L432-441 定义了 `#detailPanel`，`script-1e-rest.php` 的 `appendToolDetail()` 函数（L4962）追加条目

---

## 三、Agent 定义与工具分配

### 3.1 Agent 列表

| # | Agent 名称 | 角色 | 头像文件名 |
|---|-----------|------|-----------|
| 1 | MoonYa | 团队队长 | `MoonYa.png` |
| 2 | APP Agent | APP 操作专员 | `APPAgent.png` |
| 3 | Computer Agent | 电脑操作专员 | `Computer Agent.png` |
| 4 | Browser Agent | Web 专员 | `Browser Agent.png` |
| 5 | File Agent | 数字资产管家 | `File Agent.png` |
| 6 | Search Agent | 搜索专家 | `Search Agent.png` |
| 7 | Code Agent | 全栈专家 | `Code Agent.png` |

头像源目录：`C:\Users\Administrator\Desktop\T\哓觅资源\Agent头像\抠图完的\`

### 3.2 各 Agent 技能与职责

1. **MoonYa（团队队长）**：分派任务、汇总结果呈现、使用 Skill、读写文档、写简单代码（复杂代码交 Code Agent）
2. **APP Agent（APP 操作专员）**：应用下载、安装、打开、关闭、卸载、更新
3. **Computer Agent（电脑操作专员）**：查询系统信息、修改系统配置、调用 CU 模式（桌面视觉-动作操作）
4. **Browser Agent（Web 专员）**：网页数据提取、网页自动化操作、网页爬虫
5. **File Agent（数字资产管家）**：文件搜索、文档问答、文件格式转换、数据分析报告、Office 文档编辑
6. **Search Agent（搜索专家）**：网页搜索、信息聚合、资料归纳、参考引用
7. **Code Agent（全栈专家）**：代码编写，所有代码由 Code Agent

### 3.3 工具重命名

| 原工具名 | 新工具名 |
|----------|----------|
| `execute_command` | `shell_executor` |
| `execute_python` | `python_executor` |

在 `agent_config.php` 中将这两个工具的 `name` 字段修改，并在 `api.php` 的工具分发逻辑中同步修改对应的 `case` 分支名。`get_command_status` 和 `stop_command` 保持不变，作为 `shell_executor` / `python_executor` 的配套工具。

### 3.4 工具分配矩阵

`shell_executor`、`python_executor`、`get_command_status`、`stop_command` 为所有 Agent 共享。其余工具按下表分配（✅=可用）：

| 工具 | MoonYa | APP | Computer | Browser | File | Search | Code |
|------|:------:|:---:|:--------:|:-------:|:----:|:------:|:----:|
| todo_write | ✅ | — | — | — | — | — | — |
| read_file | ✅ | — | — | — | ✅ | — | ✅ |
| create_file | ✅ | — | — | — | ✅ | — | ✅ |
| create_folder | — | — | — | — | ✅ | — | ✅ |
| delete_file | — | — | — | — | ✅ | — | — |
| list_files | — | — | — | — | ✅ | — | ✅ |
| copy_file | — | — | — | — | ✅ | — | — |
| move_file | — | — | — | — | ✅ | — | — |
| open_file | — | — | — | — | ✅ | — | — |
| edit_file | ✅ | — | — | — | ✅ | — | ✅ |
| grep | — | — | — | — | ✅ | — | ✅ |
| glob | — | — | — | — | ✅ | — | ✅ |
| view_directory | — | — | — | — | ✅ | — | ✅ |
| download_file | ✅ | ✅ | — | — | — | — | — |
| open_app | — | ✅ | — | — | — | — | — |
| close_app | — | ✅ | — | — | — | — | — |
| install_app | — | ✅ | — | — | — | — | — |
| uninstall_app | — | ✅ | — | — | — | — | — |
| check_app_installed | — | ✅ | — | — | — | — | — |
| get_system_status | — | — | ✅ | — | — | — | — |
| take_screenshot | — | — | ✅ | — | — | — | — |
| get_cursor_pos | — | — | ✅ | — | — | — | — |
| mouse_move | — | — | ✅ | — | — | — | — |
| mouse_click | — | — | ✅ | — | — | — | — |
| mouse_scroll | — | — | ✅ | — | — | — | — |
| mouse_drag | — | — | ✅ | — | — | — | — |
| mouse_hold | — | — | ✅ | — | — | — | — |
| keyboard_type | — | — | ✅ | — | — | — | — |
| key_press | — | — | ✅ | — | — | — | — |
| task_complete | — | — | ✅ | — | — | — | — |
| find_element | — | — | ✅ | — | — | — | — |
| get_ui_tree | — | — | ✅ | — | — | — | — |
| click_element | — | — | ✅ | — | — | — | — |
| set_text | — | — | ✅ | — | — | — | — |
| get_text | — | — | ✅ | — | — | — | — |
| capture_ui_snapshot | — | — | ✅ | — | — | — | — |
| focus_window | — | — | ✅ | — | — | — | — |
| browser_automation_control | — | — | — | ✅ | — | — | — |
| vls_analyze_browser | — | — | — | ✅ | — | — | — |
| web_search | — | — | — | — | — | ✅ | — |
| web_fetch | — | — | — | ✅ | — | ✅ | — |
| web_crawler | — | — | — | ✅ | — | — | — |
| get_diagnostics | — | — | — | — | — | — | ✅ |
| find_references | — | — | — | — | — | — | ✅ |
| goto_definition | — | — | — | — | — | — | ✅ |
| ZTimage-Agent | ✅ | — | — | — | — | — | — |
| get_weather | ✅ | — | — | — | — | — | — |
| search_music | ✅ | — | — | — | — | — | — |
| get_horoscope | ✅ | — | — | — | — | — | — |
| generate_video | ✅ | — | — | — | — | — | — |
| translate_classical | ✅ | — | — | — | — | — | — |
| open_video_site | ✅ | — | — | — | — | — | — |

**MoonYa 不能调用所有工具**，仅限上表 ✅ 的工具。MoonYa 通过调用其他 6 个 Agent 来间接使用其余工具。

---

## 四、后端改造

### 4.1 agent_config.php 改造

#### 4.1.1 新增 Agent 定义结构

在 `$agentTools` 数组之后，新增 `$agents` 配置数组，定义每个 Agent 的名称、角色、可用工具列表、系统提示词：

```php
$agents = [
    'MoonYa' => [
        'name' => 'MoonYa',
        'role' => '团队队长',
        'avatar' => 'MoonYa.png',
        'tools' => ['todo_write', 'read_file', 'create_file', 'edit_file', 'download_file',
                     'ZTimage-Agent', 'get_weather', 'search_music', 'get_horoscope',
                     'generate_video', 'translate_classical', 'open_video_site',
                     'shell_executor', 'python_executor', 'get_command_status', 'stop_command'],
        'can_call_agents' => ['APP Agent', 'Computer Agent', 'Browser Agent',
                              'File Agent', 'Search Agent', 'Code Agent'],
        'system_prompt' => '你是 MoonYa，团队队长。负责理解用户意图、拆解任务、分派给专业 Agent、汇总结果。',
    ],
    'APP Agent' => [
        'name' => 'APP Agent',
        'role' => 'APP操作专员',
        'avatar' => 'APPAgent.png',
        'tools' => ['open_app', 'close_app', 'install_app', 'uninstall_app',
                     'check_app_installed', 'download_file',
                     'shell_executor', 'python_executor', 'get_command_status', 'stop_command'],
        'can_call_agents' => [],
        'system_prompt' => '你是 APP Agent，负责应用下载、安装、打开、关闭、卸载、更新。',
    ],
    // ... 其余 Agent 同理
];
```

#### 4.1.2 工具重命名

将 `$agentTools` 数组中 `execute_command` 改为 `shell_executor`，`execute_python` 改为 `python_executor`。

#### 4.1.3 新增 Agent 调度工具

在 `$agentTools` 中新增一个 `call_agent` 工具，供 MoonYa 调用其他 Agent：

```php
[
    'type' => 'function',
    'function' => [
        'name' => 'call_agent',
        'description' => '调用专业 Agent 执行子任务。可选 Agent：APP Agent、Computer Agent、Browser Agent、File Agent、Search Agent、Code Agent',
        'parameters' => [
            'type' => 'object',
            'properties' => [
                'agent_name' => [
                    'type' => 'string',
                    'enum' => ['APP Agent', 'Computer Agent', 'Browser Agent',
                               'File Agent', 'Search Agent', 'Code Agent'],
                    'description' => '要调用的专业 Agent 名称',
                ],
                'task' => [
                    'type' => 'string',
                    'description' => '分配给该 Agent 的具体任务描述',
                ],
                'context' => [
                    'type' => 'string',
                    'description' => '传递给该 Agent 的上下文信息（如文件路径、搜索关键词等）',
                ],
            ],
            'required' => ['agent_name', 'task'],
        ],
    ],
    'mode_gate' => ['normal', 'agent', 'computer_user'],  // MoonYa 在所有模式下都可调用
],
```

#### 4.1.4 替换 filterAgentToolsByMode

现有 `filterAgentToolsByMode()` 按 `agentMode` + `computerUserMode` 过滤工具。改造为按 **当前活跃 Agent** 过滤工具：

```php
function filterToolsByAgent(array $allTools, string $agentName): array {
    global $agents;
    $allowedTools = $agents[$agentName]['tools'] ?? [];
    // MoonYa 额外拥有 call_agent 工具
    if ($agentName === 'MoonYa') {
        $allowedTools[] = 'call_agent';
    }
    return array_values(array_filter($allTools, function($tool) use ($allowedTools) {
        $name = $tool['function']['name'] ?? '';
        return in_array($name, $allowedTools);
    }));
}
```

保留原 `filterAgentToolsByMode` 以兼容 CU 模式内部逻辑，但主流程改为按 Agent 过滤。

### 4.2 api.php 改造

#### 4.2.1 接收 Agent 上下文

前端 POST 请求新增 `current_agent` 字段（默认 `MoonYa`），后端据此选择工具集和系统提示词：

```php
$currentAgent = $data['current_agent'] ?? 'MoonYa';
$agentTools = filterToolsByAgent($allAgentTools, $currentAgent);
$systemPrompt = $agents[$currentAgent]['system_prompt'] ?? $defaultPrompt;
```

#### 4.2.2 call_agent 工具分发

在工具循环中新增 `call_agent` 的 `case` 分支：

```php
case 'call_agent':
    $targetAgent = $currentToolCall['function']['arguments']['agent_name'] ?? '';
    $task = $currentToolCall['function']['arguments']['task'] ?? '';
    $context = $currentToolCall['function']['arguments']['context'] ?? '';

    // 1. 推送 agent_call SSE 事件
    echo "data: " . json_encode([
        'type' => 'agent_call',
        'from' => 'MoonYa',
        'to' => $targetAgent,
        'task' => $task,
        'avatar' => $agents[$targetAgent]['avatar'] ?? '',
    ]) . "\n\n"; flush();

    // 2. 推送 thinking SSE 事件（MoonYa 的思考）
    echo "data: " . json_encode([
        'type' => 'agent_thinking',
        'agent' => 'MoonYa',
        'content' => "需要调用 {$targetAgent} 来完成：{$task}",
    ]) . "\n\n"; flush();

    // 3. 切换 Agent 上下文，调用目标 Agent
    echo "data: " . json_encode([
        'type' => 'agent_switch',
        'name' => $targetAgent,
    ]) . "\n\n"; flush();

    // 4. 用目标 Agent 的工具集和系统提示词发起 LLM 调用
    //    目标 Agent 内部可能多轮工具调用，结果汇总后返回
    $agentResult = executeSubAgent($targetAgent, $task, $context, $messages);

    // 5. 推送 agent_result SSE 事件
    echo "data: " . json_encode([
        'type' => 'agent_result',
        'from' => $targetAgent,
        'to' => 'MoonYa',
        'result' => $agentResult['summary'],
        'deliverables' => $agentResult['deliverables'] ?? [],
    ]) . "\n\n"; flush();

    // 6. 切回 MoonYa
    echo "data: " . json_encode([
        'type' => 'agent_switch',
        'name' => 'MoonYa',
    ]) . "\n\n"; flush();

    // 7. 将子 Agent 结果作为 tool 结果回填给 MoonYa 的消息流
    $messages[] = [
        'role' => 'tool',
        'tool_call_id' => $currentToolCall['id'],
        'content' => $agentResult['summary'],
    ];
    break;
```

#### 4.2.3 executeSubAgent 函数

新增函数，负责执行子 Agent 的 LLM 调用 + 工具循环：

```php
function executeSubAgent(string $agentName, string $task, string $context, array $parentMessages): array {
    global $agents, $allAgentTools;

    $agentConfig = $agents[$agentName];
    $agentTools = filterToolsByAgent($allAgentTools, $agentName);

    // 构建子 Agent 的消息
    $subMessages = [
        ['role' => 'system', 'content' => $agentConfig['system_prompt']],
        ['role' => 'user', 'content' => "任务：{$task}\n上下文：{$context}"],
    ];

    // 子 Agent 的工具循环（类似主循环但独立）
    // 每次工具调用都推送 tool_call SSE 事件
    // 子 Agent 没有 call_agent 工具，不能递归调用其他 Agent
    // 循环结束后返回汇总结果 + 产出物列表

    return [
        'summary' => '执行结果摘要',
        'deliverables' => [
            ['type' => 'file', 'path' => '...', 'name' => '...'],
        ],
    ];
}
```

#### 4.2.4 工具调用 SSE 事件

每次任何 Agent 调用工具时，推送 `tool_call` 事件：

```php
echo "data: " . json_encode([
    'type' => 'tool_call',
    'agent' => $currentAgent,
    'tool' => $toolName,
    'params_summary' => $paramsSummary,  // 参数摘要（非完整参数）
    'status' => 'executing',
]) . "\n\n"; flush();

// 工具执行完毕后
echo "data: " . json_encode([
    'type' => 'tool_call',
    'agent' => $currentAgent,
    'tool' => $toolName,
    'status' => 'done',
    'result_summary' => $resultSummary,  // 结果摘要
]) . "\n\n"; flush();
```

#### 4.2.5 思考内容 SSE 事件

LLM 返回的 `reasoning_content` 推送为 `agent_thinking` 事件（替代现有 `thinking` 事件）：

```php
echo "data: " . json_encode([
    'type' => 'agent_thinking',
    'agent' => $currentAgent,
    'content' => $reasoningContent,
]) . "\n\n"; flush();
```

#### 4.2.6 产出物 SSE 事件

当工具产生文件、图片等产出物时，推送 `deliverable` 事件：

```php
echo "data: " . json_encode([
    'type' => 'deliverable',
    'agent' => $currentAgent,
    'item' => [
        'type' => 'file',           // file | image | video | search_result | code | report
        'name' => 'spider.py',
        'path' => 'D:/Desktop/spider.py',
        'size' => '2.3 KB',
        'preview_url' => null,       // 可预览时的 URL
    ],
]) . "\n\n"; flush();
```

### 4.3 AIAssistant.php 改造

- CU 模式相关逻辑保持不变，但 CU 工具仅对 Computer Agent 可见
- `filterAgentToolsByMode` 调用点改为 `filterToolsByAgent('Computer Agent')`（CU 模式下当前 Agent 固定为 Computer Agent）
- `runCuLoop` 中的 SSE 事件类型对齐新的事件名（`agent_thinking`、`tool_call` 等）

---

## 五、前端改造

### 5.1 页面布局改造（main-content.php）

#### 5.1.1 对话区域

保持现有 `.messages-container` 结构，但修改渲染逻辑：
- 仅渲染用户消息 + MoonYa 的最终回复
- **不渲染**子 Agent 的中间输出、工具调用、思考内容
- MoonYa 回复时显示 MoonYa 头像

#### 5.1.2 操作详情面板改造

将现有 `#detailPanel`（L432-441）改造为三 Tab 结构：

```html
<div class="detail-panel" id="detailPanel">
    <div class="detail-panel-header">
        <span class="detail-panel-title">操作详情</span>
        <button id="detailPanelClear">清空</button>
    </div>
    <div class="detail-panel-tabs">
        <button class="detail-tab active" data-tab="worklog">工作日志</button>
        <button class="detail-tab" data-tab="deliverables">产出物</button>
        <button class="detail-tab" data-tab="preview">预览</button>
    </div>
    <div class="detail-panel-body">
        <!-- Tab 1: 工作日志 -->
        <div class="detail-tab-content active" id="worklogTab">
            <div id="worklogTree"></div>
        </div>
        <!-- Tab 2: 产出物 -->
        <div class="detail-tab-content" id="deliverablesTab">
            <div id="deliverablesList"></div>
        </div>
        <!-- Tab 3: 预览 -->
        <div class="detail-tab-content" id="previewTab">
            <div id="previewContent"></div>
        </div>
    </div>
</div>
```

### 5.2 SSE 事件处理改造（script-1e-rest.php）

#### 5.2.1 新增 SSE 事件处理

在现有 SSE 解析循环中（L1524 附近），新增以下事件类型的处理分支：

```js
// Agent 思考内容 → 追加到工作日志树
if (data.type === 'agent_thinking') {
    appendWorklogNode({
        type: 'thinking',
        agent: data.agent,
        content: data.content,
        level: getCurrentAgentLevel(data.agent),
    });
}

// Agent 调用 → 在工作日志树中创建子节点
if (data.type === 'agent_call') {
    appendWorklogNode({
        type: 'agent_call',
        from: data.from,
        to: data.to,
        task: data.task,
        avatar: data.avatar,
        level: 1,  // MoonYa 调用的 Agent 为第二层
    });
}

// Agent 返回结果 → 关闭子节点
if (data.type === 'agent_result') {
    appendWorklogNode({
        type: 'agent_result',
        from: data.from,
        to: data.to,
        result: data.result,
        deliverables: data.deliverables || [],
    });
    // 同时将产出物添加到产出物 Tab
    data.deliverables.forEach(item => addDeliverable(item, data.from));
}

// 工具调用 → 追加到当前 Agent 的工作日志子节点
if (data.type === 'tool_call') {
    appendWorklogNode({
        type: 'tool_call',
        agent: data.agent,
        tool: data.tool,
        params: data.params_summary,
        status: data.status,
        result: data.result_summary,
        level: getCurrentAgentLevel(data.agent) + 1,  // 工具为 Agent 的子节点
    });
}

// 产出物 → 添加到产出物 Tab
if (data.type === 'deliverable') {
    addDeliverable(data.item, data.agent);
}

// agent_switch → 不再在对话区域创建新气泡，仅更新当前 Agent 上下文
if (data.type === 'agent_switch') {
    currentAgentName = data.name;
    // 不再重置对话区域的流式渲染状态（因为子 Agent 输出不显示在对话区域）
}
```

#### 5.2.2 对话区域渲染逻辑修改

修改 `content` 事件处理：
- 仅当 `currentAgentName === 'MoonYa'` 时，将内容渲染到对话区域
- 子 Agent 的 `content` 事件不渲染到对话区域（但可追加到工作日志作为简要输出）

```js
if (data.type === 'content') {
    if (currentAgentName === 'MoonYa') {
        // 渲染到对话区域（现有逻辑）
        renderToConversation(data.content);
    } else {
        // 子 Agent 的输出不渲染到对话区域
        // 可选：追加到工作日志作为该 Agent 的输出摘要
    }
}
```

#### 5.2.3 现有 thinking 事件处理

将现有 `thinking` 事件处理（L1945 附近）改为 `agent_thinking`，或将 `thinking` 事件统一改名为 `agent_thinking`。思考内容不再在对话区域显示，改为追加到工作日志树。

### 5.3 工作日志树渲染

新增 `appendWorklogNode()` 函数，以树形结构渲染执行过程：

```js
function appendWorklogNode(node) {
    const tree = document.getElementById('worklogTree');
    // 根据 node.level 和 node.type 创建对应层级的 DOM 节点
    // 每个节点包含：Agent 头像 + 名称 + 内容/工具名/结果
    // 支持折叠/展开
}
```

**树形结构示例**（DOM 层级）：

```
🌙 [MoonYa头像] MoonYa（团队队长）
├─ 💭 思考：用户要求"帮我写一个Python爬虫并保存到桌面"...
├─ 📋 [todo_write] 创建任务计划
│   ├─ ☐ 1. 编写Python爬虫脚本（Code Agent）
│   └─ ☐ 2. 保存脚本到桌面（File Agent）
├─ 🤖 [调用 Agent] → [Code Agent头像] Code Agent（全栈专家）
│   │
│   ├─ 💭 思考：需要编写一个Python爬虫脚本...
│   ├─ 🔧 [view_directory] 查看项目结构 → 返回：src/ lib/...
│   ├─ 🔧 [create_file] 创建 spider.py → 返回：文件已创建
│   ├─ 🔧 [get_diagnostics] 检查代码错误 → 返回：无错误
│   └─ ✅ 完成：爬虫脚本已编写
│
├─ 🤖 [调用 Agent] → [File Agent头像] File Agent（数字资产管家）
│   │
│   ├─ 💭 思考：将 spider.py 移动到桌面
│   ├─ 🔧 [move_file] 移动到桌面 → 返回：已移动
│   └─ ✅ 完成：文件已保存到桌面
│
└─ 📋 [todo_write] 更新任务状态 → 全部完成
```

**实现要点**：
- 第一层：MoonYa 的思考、todo_write、agent_call
- 第二层：被调用 Agent 的思考、工具调用、完成
- 第三层：工具调用的参数和返回结果
- 缩进通过 CSS `margin-left` 或 `padding-left` 实现
- 每个 Agent 节点显示对应头像（`<img>` 标签，24x24px）
- 思考内容默认折叠，点击展开
- 实时流式更新（SSE 推送即追加 DOM）

### 5.4 产出物 Tab 渲染

新增 `addDeliverable()` 函数：

```js
function addDeliverable(item, agentName) {
    const list = document.getElementById('deliverablesList');
    const card = document.createElement('div');
    card.className = 'deliverable-card';
    card.innerHTML = `
        <div class="deliverable-icon">${getDeliverableIcon(item.type)}</div>
        <div class="deliverable-info">
            <div class="deliverable-name">${item.name}</div>
            <div class="deliverable-meta">
                <span>类型：${item.type}</span>
                <span>路径：${item.path || '-'}</span>
                <span>来源：${agentName}</span>
                ${item.size ? `<span>大小：${item.size}</span>` : ''}
            </div>
            <div class="deliverable-actions">
                <button onclick="openFile('${item.path}')">打开</button>
                <button onclick="showInFolder('${item.path}')">在文件夹中显示</button>
                <button onclick="previewDeliverable('${item.path}', '${item.type}')">预览</button>
            </div>
        </div>
        <img class="deliverable-agent-avatar" src="${getAgentAvatar(agentName)}" />
    `;
    list.appendChild(card);
}
```

### 5.5 预览 Tab 渲染

新增 `previewDeliverable()` 函数，根据产出物类型选择预览方式：
- **代码文件**：语法高亮预览（读取文件内容，用 Prism.js 或类似库高亮）
- **图片**：`<img>` 直接显示
- **文档**：渲染预览（如有能力）
- **搜索结果**：结构化卡片

### 5.6 头像加载

前端需要能访问 Agent 头像图片。有两种方案：

**方案 A（推荐）**：将头像文件复制到 `wwwroot/assets/agent-avatars/` 目录，前端通过相对路径引用：
```js
const AGENT_AVATARS = {
    'MoonYa': 'assets/agent-avatars/MoonYa.png',
    'APP Agent': 'assets/agent-avatars/APPAgent.png',
    'Computer Agent': 'assets/agent-avatars/Computer Agent.png',
    'Browser Agent': 'assets/agent-avatars/Browser Agent.png',
    'File Agent': 'assets/agent-avatars/File Agent.png',
    'Search Agent': 'assets/agent-avatars/Search Agent.png',
    'Code Agent': 'assets/agent-avatars/Code Agent.png',
};
```

**方案 B**：后端通过 SSE 事件传递头像的 base64 编码（不推荐，数据量大）。

采用方案 A，需将 `C:\Users\Administrator\Desktop\T\哓觅资源\Agent头像\抠图完的\` 下的 7 个 PNG 文件复制到 `wwwroot/assets/agent-avatars/`。

### 5.7 CSS 改造（css-15-result.php 或新建 CSS 文件）

新增以下样式：
- `.detail-panel-tabs` — Tab 栏样式
- `.detail-tab` — Tab 按钮样式（active 状态高亮）
- `.detail-tab-content` — Tab 内容容器（隐藏/显示）
- `#worklogTree` — 工作日志树容器
- `.worklog-node` — 树节点样式（含缩进）
- `.worklog-agent-header` — Agent 节点头部（头像 + 名称）
- `.worklog-thinking` — 思考内容样式（可折叠）
- `.worklog-tool` — 工具调用样式
- `.worklog-result` — 工具返回结果样式
- `.deliverable-card` — 产出物卡片样式
- `.deliverable-agent-avatar` — 产出物卡片中的 Agent 头像
- `#previewContent` — 预览区域样式

---

## 六、SSE 事件类型汇总

改造后的完整 SSE 事件类型：

| 事件类型 | 数据字段 | 前端处理 |
|----------|---------|---------|
| `content` | `content` | 仅 MoonYa 的内容渲染到对话区域；子 Agent 内容忽略 |
| `agent_thinking` | `agent`, `content` | 追加到工作日志树（对应 Agent 节点下） |
| `agent_call` | `from`, `to`, `task`, `avatar` | 在工作日志树创建子 Agent 节点 |
| `agent_result` | `from`, `to`, `result`, `deliverables` | 关闭子 Agent 节点，产出物添加到产出物 Tab |
| `agent_switch` | `name` | 更新 `currentAgentName`（不在对话区域创建新气泡） |
| `tool_call` | `agent`, `tool`, `params_summary`, `status`, `result_summary` | 追加到工作日志树（对应 Agent 节点下） |
| `deliverable` | `agent`, `item{type,name,path,size}` | 添加到产出物 Tab |
| `status` | `status`, `message` | 工作日志中的状态提示 |
| `done` | — | 流结束 |
| `error` | `message` | 错误提示 |

---

## 七、Agent 调用流程时序

```
用户发消息
    │
    ▼
api.php 接收（current_agent=MoonYa）
    │
    ├─ MoonYa LLM 思考 → 推送 agent_thinking（agent=MoonYa）
    │
    ├─ MoonYa 调用 call_agent → 推送 agent_call（from=MoonYa, to=Code Agent）
    │
    ├─ 推送 agent_switch（name=Code Agent）
    │
    ├─ executeSubAgent('Code Agent')
    │   ├─ Code Agent LLM 思考 → 推送 agent_thinking（agent=Code Agent）
    │   ├─ Code Agent 调用 view_directory → 推送 tool_call（agent=Code Agent, tool=view_directory）
    │   ├─ Code Agent 调用 create_file → 推送 tool_call + deliverable
    │   ├─ Code Agent 调用 get_diagnostics → 推送 tool_call
    │   └─ Code Agent 完成 → 返回结果
    │
    ├─ 推送 agent_result（from=Code Agent, to=MoonYa, result=..., deliverables=[...])
    │
    ├─ 推送 agent_switch（name=MoonYa）
    │
    ├─ MoonYa 汇总 → 推送 content（agent=MoonYa）→ 渲染到对话区域
    │
    └─ 推送 done
```

---

## 八、改造文件清单

| 文件 | 改造内容 |
|------|---------|
| `MoonYa-Backend/agent_config.php` | 新增 `$agents` 数组；工具重命名；新增 `call_agent` 工具；新增 `filterToolsByAgent()` 函数 |
| `MoonYa-Backend/api.php` | 新增 `call_agent` 工具分发分支；新增 `executeSubAgent()` 函数；新增 `agent_thinking`/`agent_call`/`agent_result`/`tool_call`/`deliverable` SSE 事件推送；`content` 事件仅 MoonYa 渲染到对话区域 |
| `MoonYa-Backend/Services/AIAssistant.php` | CU 工具过滤改用 `filterToolsByAgent('Computer Agent')`；SSE 事件类型对齐 |
| `wwwroot/script/MoonYa-index/layouts/main-content.php` | 操作详情面板改为三 Tab 结构 |
| `wwwroot/script/MoonYa-index/modules/script-1e-rest.php` | 新增 SSE 事件处理分支；新增 `appendWorklogNode()`、`addDeliverable()`、`previewDeliverable()` 函数；修改 `content` 事件仅 MoonYa 渲染到对话区域；修改 `agent_switch` 处理逻辑 |
| `wwwroot/script/MoonYa-index/styles/css-15-result.php` | 新增 Tab 栏、工作日志树、产出物卡片、预览区域样式 |
| `wwwroot/assets/agent-avatars/` | 新增目录，复制 7 个 Agent 头像 PNG 文件 |

---

## 九、注意事项

1. **兼容现有 CU 模式**：CU 模式下 MoonYa 将任务委派给 Computer Agent，Computer Agent 内部走现有 `runCuLoop` 逻辑，CU 工具仅对 Computer Agent 可见
2. **兼容现有 ZTimage-Agent**：ZTimage-Agent 作为 MoonYa 的专属工具保留，调用时推送 `agent_switch` 事件切换显示
3. **子 Agent 不能调用其他 Agent**：只有 MoonYa 拥有 `call_agent` 工具，子 Agent 的工具集中不包含 `call_agent`
4. **并行调用**：如果 MoonYa 的 LLM 返回多个 `call_agent` 工具调用，可并行执行无依赖的子 Agent（后续优化，初版可串行）
5. **上下文传递**：MoonYa 调用子 Agent 时需传递任务描述和上下文；子 Agent 执行完毕后结果回填给 MoonYa 的消息流
6. **前端头像路径**：确保 `wwwroot/assets/agent-avatars/` 目录存在并包含 7 个 PNG 文件；文件名中的空格需 URL 编码
7. **工作日志层级**：严格按 MoonYa(第一层) → Agent(第二层) → 工具(第三层) 的缩进层级渲染

---

## 十、Agent 模型思考强度兼容矩阵（2026-07-30）

推理强度滑条只对 DeepSeek 请求生效。Kimi、MiniMax Agent 不接收由该滑条生成的 `reasoning_effort`，但 MoonYa 仍会流式解析并展示这些模型实际返回的 reasoning 内容。GLM 不属于 Agent 模型范围，因此不列入本矩阵。

| Agent 模型 | 官方思考能力 | MoonYa 五档处理 |
|---|---|---|
| `deepseek-v4-flash` | 可关闭；原生支持 `high` / `max` | 不思考 → `thinking.disabled`；低 / 中 / 高 → `high`；极高 → `max` |
| `deepseek-v4-pro` | 可关闭；原生支持 `high` / `max` | 同上 |
| `kimi-k2.6` | 仅支持 enabled / disabled，无分级 effort | 不受五档滑条控制 |
| `kimi-k3` | 支持 `low` / `high` / `max`，但无法关闭思考 | 记录模型能力，但不受当前滑条控制 |
| `MiniMax-M3` | 支持 disabled / adaptive，无真实深度档位 | 不受五档滑条控制 |
| MiniMax M2.x | 思考无法关闭，无分级 effort | 不受五档滑条控制 |

当前数据库中的 MoonYa、App、Computer、Browser、File、Search、Code Agent 均未设置 `model_override`，会继承协调模型。因此，当协调模型为 DeepSeek 时，所有继承该模型的 Agent 统一使用上述五档映射；未来某个 Agent 显式覆盖为 Kimi 或 MiniMax 时，必须跳过 DeepSeek 推理强度参数，只按对应供应商协议处理和展示 reasoning。

DeepSeek 参数归一化规则：

1. `none`（不思考）：发送 `{"thinking":{"type":"disabled"}}`，不发送 `reasoning_effort`。
2. `low` / `medium` / `high`：发送 `{"thinking":{"type":"enabled"}}` 与 `reasoning_effort="high"`。
3. `xhigh`（极高）：发送 `{"thinking":{"type":"enabled"}}` 与 `reasoning_effort="max"`。
4. 思考模式不得依赖 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 调节推理强度。
5. 带工具调用的 assistant 消息必须原样保留 `reasoning_content`，并使用非空 `content` 回传。

官方来源：

- [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
- [Kimi K3 推理强度](https://platform.kimi.com/docs/guide/use-reasoning-effort)
- [Kimi K2.6](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)
- [MiniMax-M3 Codex 兼容说明](https://platform.minimaxi.com/docs/token-plan/codex)
