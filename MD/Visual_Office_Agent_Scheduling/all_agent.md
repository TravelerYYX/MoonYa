# MoonYa 所有 Agent 列表

## 一、主 Agent 体系

### 1. MoonYa Agent（主代理）
- **位置**：系统核心对话代理
- **模式**：
  - `normal` - 普通对话模式
  - `agent` - Agent 模式（工具调用模式）
  - `computer_user` - Computer User 模式（桌面视觉-动作循环）
- **说明**：MoonYa 的主对话代理，负责与用户交互、理解用户意图、调用工具完成任务
- **相关文件**：
  - [api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api.php)
  - [config.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/config.php)

---

### 2. ZTimage-Agent（图片生成代理）
- **功能**：专用图片生成代理，委派图片生成任务
- **模型**：调用 MiniMax image-01 / image-01-live 模型
- **触发方式**：通过 `ZTimage-Agent` 工具调用
- **能力**：
  - 支持 1:1、16:9、4:3、3:2、2:3、3:4、9:16、21:9 多种宽高比
  - image-01：通用文生图（画面细腻，支持21:9）
  - image-01-live：特定画风（漫画/元气/中世纪/水彩）
  - 单次生成 1-9 张图片
  - 自动下载图片到本地并返回本地路径
- **相关文件**：
  - [agent_config.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/agent_config.php#L563-L607)
  - [api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api.php#L3725-L3946)

---

### 3. VLS-Agent（视觉语言服务代理）
- **全称**：Visual Language Service Agent
- **功能**：
  - 浏览器页面视觉分析（vls_analyze_browser）
  - 桌面视觉坐标操作（三层降级架构第二层）
- **模型**：视觉模型（moonshot-v1-8k-vision-preview 等）
- **用途**：
  - 分析浏览器页面元素布局与交互建议
  - 当 UIA（UI 自动化）不可用时，通过视觉模型识别界面元素
  - 登录界面状态分类（扫码/密码/验证码/已登录）
- **三层降级架构**：
  1. **第一层**：UIA + 坐标操作（默认）
  2. **第二层**：VLS-Agent 视觉模型（自绘应用如 QQ/画图触发）
  3. **第三层**：键盘快捷键策略（最后手段）
- **相关文件**：
  - [AIAssistant.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/AIAssistant.php)
  - [agent_config.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/agent_config.php#L1123)

---

### 4. Computer User Agent（CU Agent / 桌面操作代理）
- **功能**：Computer Use 模式，桌面视觉-动作循环代理
- **能力**：
  - UIA（User Interface Automation）元素级操作
  - 鼠标键盘坐标模拟操作
  - 屏幕截图与感知
  - Plan-Act-Verify 架构（计划-执行-验证）
  - 登录界面自动处理（安全边界）
- **核心工具集**：
  - 截图感知：take_screenshot、capture_ui_snapshot
  - UIA 操作：find_element、get_ui_tree、click_element、set_text、get_text
  - 鼠标操作：mouse_move、mouse_click、mouse_scroll、mouse_drag、mouse_hold
  - 键盘操作：keyboard_type、key_press
  - 窗口管理：focus_window、get_window_list
- **可靠性机制**：
  - 点击止损：同坐标 ±10px 仅允许 1 次
  - 空 tool_calls 重试机制
  - 死循环检测
  - task_complete 验证（界面变化验证）
- **相关文件**：
  - [AIAssistant.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/Services/AIAssistant.php)
  - [ComputerUseService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/ComputerUseService.cs)
  - [UiAutomationService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/UiAutomationService.cs)

---

### 5. Browser Automation Agent（BA Agent / 浏览器自动化代理）
- **功能**：浏览器自动化操控代理
- **能力**：
  - 启动/停止浏览器
  - 页面导航
  - CSS 选择器点击/输入
  - 页面滚动
  - 页面截图
  - 获取可交互 DOM 元素
  - JavaScript 执行
  - VLS 视觉分析辅助
- **API 端点**（监听 127.0.0.1:58905）：
  - POST /browser/start - 启动浏览器
  - POST /browser/navigate - 导航
  - POST /browser/click - 点击元素
  - POST /browser/fill - 输入文本
  - GET/POST /browser/screenshot - 截图
  - POST /browser/scroll - 滚动
  - POST /browser/get-text - 获取元素文本
  - GET/POST /browser/get-elements - 获取所有可交互元素
  - POST /browser/evaluate - 执行 JS
  - POST /browser/wait - 等待
  - POST /browser/stop - 停止浏览器
  - GET/POST /browser/status - 状态查询
- **相关文件**：
  - [BrowserApiServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserApiServer.cs)
  - [BrowserAutomationService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserAutomationService.cs)
  - [BrowserSecurityGate.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserSecurityGate.cs)

---

### 6. Code-Agent（代码生成代理）- 已废弃
- **状态**：已废弃，自动回退为 agent 模式
- **说明**：历史版本用于代码生成，现工具集已整合到 Agent 模式
- **相关文件**：
  - [api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api.php#L872-L877)

---

### 7. MoonYa-T-Agent（思考代理）- 已移除
- **状态**：已移除
- **说明**：原用于深度思考，现通过 reasoning_content 机制直接处理
- **相关文件**：
  - [api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/api.php#L3711-L3714)

---

## 二、后端服务代理（Python）

### 8. MoonYa Python 统一服务入口（main.py）
- **端口**：默认 58901（可配置）
- **启动方式**：`python main.py [config.json]`
- **功能**：合并启动爬虫服务与搜索服务，统一监听同一端口，通过路径区分
- **统一端点**：
  - POST /crawl - 网页爬虫（SSE 流式进度）
  - GET /download/{user_id}/{filename} - 下载爬取结果 zip
  - POST /search - 联网搜索/网页抓取（action=web_search/web_fetch）
  - GET /health - 统一健康检查（返回 {"status":"ok","services":["crawler","search"]}）
- **配置文件**：service_config.json（优先）/ launcher_config.json
- **相关文件**：
  - [main.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/main.py)
  - [service_config.json](file:///d:/Project/Project/MoonYa/MoonYa-Python/service_config.json)

---

### 9. CrawlerServer（网页爬虫子服务）
- **功能**：爬取指定网页，将页面及所有资源（CSS/JS/图片/字体等）本地化保存，打包为 zip
- **独立端口**：单独启动时默认 58901
- **依赖**：Playwright（启动时自动安装 Chromium）
- **统一入口下挂载路径**：POST /crawl, GET /download/*
- **相关文件**：
  - [crawler_server.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_crawler/crawler_server.py)
  - [web_crawler.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_crawler/web_crawler.py)

---

### 10. SearchServer（网页搜索子服务）
- **功能**：联网搜索互联网信息、抓取网页内容
- **独立端口**：单独启动时默认 58902
- **C# 启动包装**：SearchServerService 可独立启动该 Python 进程（端口 58902）
- **统一入口下挂载路径**：POST /search
- **相关文件**：
  - [search_server.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_search/search_server.py)
  - [web_search.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_search/web_search.py)
  - [SearchServerService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/SearchServerService.cs)

---

## 三、C# 桌面端服务代理

### 11. FileOperationApiServer（文件操作 API 服务）
- **端口**：58900
- **功能**：提供文件系统操作、应用管理、代码编辑、UIA 操作等 HTTP API（核心服务）
- **端点**：
  - POST /file-op - 文件/应用/代码操作（文件CRUD、应用管理、grep/glob、LSP诊断等）
  - POST /cu-op - 计算机使用操作（截图/鼠标/键盘/UIA元素操作）
  - GET/POST /cu/window-snapshot - 窗口列表快照
  - GET/POST /cu/health - 健康检查
- **集成服务**：
  - FileOperationService - 文件系统操作
  - ComputerUseService - 鼠标键盘截图
  - UiAutomationService - UIA 元素自动化
  - EditFileService - 文件编辑（view/str_replace/insert）
  - GrepService - 内容搜索（ripgrep）
  - GlobService - 文件名匹配
  - ViewDirectoryService - 目录树查看
  - AppInstallService - 应用安装
  - SystemStatusService - 系统状态监控
  - CommandExecutionService / SandboxService - 命令沙箱执行
  - PythonExecutionService - Python 脚本执行
- **相关文件**：
  - [FileOperationApiServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/FileOperationApiServer.cs)

---

### 12. ExecutionApiServer（命令执行 API 服务）
- **端口**：58903
- **功能**：提供命令行和 Python 脚本执行服务（沙箱环境），支持 SSE 流式输出
- **端点**：
  - POST /execute - 执行命令或 Python 脚本（支持 SSE 流式）
  - GET /history - 执行历史
  - GET /health - 健康检查
- **相关文件**：
  - [ExecutionApiServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/ExecutionApiServer.cs)

---

### 13. BrowserApiServer（浏览器自动化 API 服务）
- **端口**：58905
- **功能**：提供浏览器自动化操控 HTTP API（独立于 FileOperationApiServer）
- **端点**：
  - POST /browser/start - 启动浏览器
  - POST /browser/navigate - 导航
  - POST /browser/click - 点击元素
  - POST /browser/fill - 输入文本
  - GET/POST /browser/screenshot - 截图
  - POST /browser/scroll - 滚动
  - POST /browser/get-text - 获取元素文本
  - GET/POST /browser/get-elements - 获取所有可交互元素
  - POST /browser/evaluate - 执行 JavaScript
  - POST /browser/wait - 等待
  - POST /browser/stop - 停止浏览器
  - GET/POST /browser/status - 状态查询
- **相关文件**：
  - [BrowserApiServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserApiServer.cs)
  - [BrowserAutomationService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserAutomationService.cs)
  - [BrowserSecurityGate.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserSecurityGate.cs)

---

### 14. LspApiServer（LSP 语言服务 API）
- **端口**：58906
- **功能**：LSP（Language Server Protocol）HTTP API 网关，提供 IDE 级代码智能功能
- **端点**：POST /lsp-op - LSP 操作（按 action 分发）
- **核心管理器**：LspServiceManager
- **支持语言服务器**：
  - PHP（PhpIntelephenseServer）
  - Python（PythonPyrightServer）
  - JavaScript/TypeScript（TypeScriptServer）
- **相关文件**：
  - [LspApiServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/LspApiServer.cs)
  - [LspServiceManager.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/LspServiceManager.cs)
  - [PhpIntelephenseServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/PhpIntelephenseServer.cs)
  - [PythonPyrightServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/PythonPyrightServer.cs)
  - [TypeScriptServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/TypeScriptServer.cs)

---

## 四、Agent 模式说明

| 模式 | 说明 | 可用工具集 |
|------|------|-----------|
| `normal` | 普通对话模式 | 基础工具（天气、音乐、星座、视频生成、文言文翻译等） |
| `agent` | Agent 模式（工具调用） | 全部工具（含浏览器自动化、代码编辑、LSP等） |
| `computer_user` | Computer User 模式 | CU专用工具（截图、UIA、鼠标键盘）+ Agent工具 |
| ~~`code_agent`~~ | ~~代码生成代理~~ | ~~已废弃，回退为agent模式~~ |

---

## 五、Agent 切换机制

系统支持运行时 Agent 切换，通过 SSE 事件 `agent_switch` 通知前端：
```json
{"type": "agent_switch", "name": "ZTimage-Agent"}
```
完成后切回主 Agent：
```json
{"type": "agent_switch", "name": "MoonYa Agent"}
```

---

## 六、能力选择优先级（CU 模式）

1. **直接 API / 专用工具优先**：文件、应用、系统信息、搜索、LSP 等已有专用工具时，不通过界面重复操作
2. **CLI 其次**：没有可用 API，但命令行能可靠完成时使用 execute_command
3. **浏览器自动化**：目标是网页操作时使用 browser_automation_control
4. **Computer Use 最后**：只有上述方式都不可用时才使用 UIA 或鼠标键盘
