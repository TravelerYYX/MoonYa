# MoonYa 所有工具列表

工具定义位置：[agent_config.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/agent_config.php)

---

## 一、生活娱乐类工具

### 1. get_weather（获取天气）
- **功能**：获取用户指定城市或当前所在地的实时天气信息
- **触发场景**：询问天气相关问题（"今天天气怎么样"、"北京明天会下雨吗"、"现在外面多少度"等）
- **参数**：
  - `query` (string, 必填)：用户原始天气查询消息，如"今天天气"、"北京天气"
- **相关文件**：后端内部处理

---

### 2. search_music（搜索音乐）
- **功能**：搜索并播放音乐
- **触发场景**：要求听音乐、推荐歌曲、搜索特定歌曲
- **重要说明**：调用后系统自动在前端渲染音乐卡片（含封面、歌名、歌手和播放按钮），无需 AI 输出文字描述
- **参数**：
  - `query` (string, 必填)：音乐搜索关键词或用户原始消息，如"来点音乐"、"推荐几首周杰伦的歌"
- **相关文件**：[music_api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/music_api.php)

---

### 3. get_horoscope（星座运势）
- **功能**：查询星座运势
- **触发场景**：询问星座相关问题（"今天双子座运势怎么样"、"查看星座运程"、"本周运势"等）
- **参数**：
  - `query` (string, 必填)：用户原始星座查询消息

---

### 4. generate_video（生成视频）
- **功能**：使用 AI 生成视频
- **触发场景**：要求生成视频、制作视频、创作视频
- **参数**：
  - `prompt` (string, 必填)：用户想要生成的视频描述
- **相关文件**：[video_api.php](file:///d:/Project/Project/MoonYa/MoonYa-Backend/video_gen/video_api.php)

---

### 5. translate_classical（文言文翻译）
- **功能**：将现代中文翻译为文言文（古文）
- **触发场景**：要求文言文翻译、古文翻译、用文言文表达
- **参数**：
  - `text` (string, 必填)：需要翻译为文言文的原文内容

---

### 6. open_video_site（打开影视网站）
- **功能**：打开影视视频网站供用户观看电影、电视剧、综艺等
- **触发场景**：要求看电影、看视频、追剧、浏览影视内容
- **参数**：无参数

---

## 二、网络搜索与爬虫类工具

### 7. web_search（联网搜索）
- **功能**：联网搜索互联网信息
- **触发场景**：查找最新新闻、事实或任何实时信息（"今天发生了什么新闻"、"最新科技动态"等）
- **参数**：
  - `query` (string, 必填)：搜索关键词
- **相关服务**：Python SearchServer（统一入口下端口 58901，独立启动端口 58902）
- **启动方式**：
  - 统一入口：`python main.py` → 端口 58901，同时提供 /crawl 和 /search
  - 独立启动：SearchServerService 包装启动 → 端口 58902
- **相关文件**：
  - [main.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/main.py)
  - [web_search.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_search/web_search.py)
  - [search_server.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_search/search_server.py)
  - [SearchServerService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/SearchServerService.cs)

---

### 8. web_fetch（抓取网页）
- **功能**：抓取并阅读网页内容
- **触发场景**：要求查看某个网页的具体内容、阅读文章、获取网页详情
- **参数**：
  - `url` (string, 必填)：要抓取和阅读的网址

---

### 9. web_crawler（网页爬虫）
- **功能**：爬取指定网页，将页面及所有资源（CSS/JS/图片/字体等）本地化保存到本地文件夹
- **触发场景**：要求爬取网页、抓取网站、保存网页、下载网站内容
- **参数**：
  - `url` (string, 必填)：要爬取的目标网页 URL 地址
  - `folder` (string, 可选)：用户指定的本地保存文件夹路径，不指定则使用默认位置
- **相关服务**：Python CrawlerServer（统一入口下端口 58901，SSE 流式进度）
- **启动方式**：
  - 统一入口：`python main.py` → 端口 58901，同时提供 /crawl 和 /search
  - 独立启动：`python crawler_server.py` → 端口 58901
- **依赖**：Playwright（启动时自动安装 Chromium）
- **相关文件**：
  - [main.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/main.py)
  - [web_crawler.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_crawler/web_crawler.py)
  - [crawler_server.py](file:///d:/Project/Project/MoonYa/MoonYa-Python/web_crawler/crawler_server.py)

---

## 三、文件操作类工具

### 10. create_file（创建文件）
- **功能**：在指定路径创建文件并写入内容
- **触发场景**：要求新建文件、创建文本文件、写入内容到文件
- **参数**：
  - `path` (string, 必填)：文件创建路径，如"桌面/test.txt"或"D:/test.txt"
  - `content` (string, 必填)：要写入文件的内容
- **执行端点**：POST /file-op（C# FileOperationApiServer，端口 58900）

---

### 11. create_folder（创建文件夹）
- **功能**：在指定路径创建文件夹
- **触发场景**：要求新建文件夹、创建目录
- **参数**：
  - `path` (string, 必填)：文件夹创建路径，如"桌面/新文件夹"或"D:/新文件夹"
- **执行端点**：POST /file-op

---

### 12. delete_file（删除文件/文件夹）
- **功能**：删除指定的文件或文件夹
- **触发场景**：要求删除文件、删除文件夹
- **参数**：
  - `path` (string, 必填)：要删除的文件或文件夹路径
- **执行端点**：POST /file-op

---

### 13. open_file（打开文件）
- **功能**：使用系统默认程序打开指定路径的文件（AI 无法看到文件内容，仅触发外部程序打开）
- **触发场景**：明确要求"打开文件"、"用某某程序打开"
- **注意**：若需要获取文件内容用于后续操作，请改用 read_file 工具
- **参数**：
  - `path` (string, 必填)：要打开的文件路径
- **执行端点**：POST /file-op

---

### 14. read_file（读取文件）
- **功能**：读取指定文件的内容并返回给 AI（文本内容直接回填）
- **触发场景**：要求"执行 xxx.md/xxx.txt"、"按照 xxx 文件实施"、"读取 xxx 文件内容"、"根据 xxx 文档操作"
- **返回格式**：带行号（cat -n 格式：行号右对齐 6 位 + 制表符 + 内容），便于 edit_file 精确引用行号
- **参数**：
  - `path` (string, 必填)：要读取内容的文件路径
  - `offset` (integer, 可选)：起始行号（默认 1）
  - `limit` (integer, 可选)：读取行数（默认全部）
- **执行端点**：POST /file-op

---

### 15. list_files（列出目录）
- **功能**：列出指定目录下的文件和文件夹
- **触发场景**：要求浏览文件、查看目录内容
- **参数**：
  - `path` (string, 必填)：要浏览的目录路径，如"桌面"或"D:/"
- **执行端点**：POST /file-op

---

### 16. copy_file（复制文件）
- **功能**：复制文件或文件夹到指定位置
- **触发场景**：要求复制文件、拷贝文件、把文件复制到某处
- **参数**：
  - `source` (string, 必填)：源文件或文件夹的路径
  - `destination` (string, 必填)：目标路径
- **执行端点**：POST /file-op

---

### 17. move_file（移动文件）
- **功能**：移动文件或文件夹到指定位置
- **触发场景**：要求移动文件、剪切文件、把文件移到某处
- **参数**：
  - `source` (string, 必填)：源文件或文件夹的路径
  - `destination` (string, 必填)：目标路径
- **执行端点**：POST /file-op

---

## 四、下载类工具

### 18. download_file（下载文件）
- **功能**：从指定的 URL 下载文件到本地
- **触发场景**：要求下载文件、保存文件、下载图片/视频/文档等资源
- **参数**：
  - `url` (string, 可选)：要下载的文件 URL 地址（不提供则使用 search_query 自动搜索）
  - `search_query` (string, 可选)：搜索关键词，当 url 为空时使用（如"腾讯视频 PC版 官方下载"）
  - `filename` (string, 可选)：保存到本地的文件名（不指定则从 URL 自动提取）
  - `path` (string, 可选)：保存路径（默认保存到桌面）
  - `method` (string, 可选)：下载方式：direct=直接下载，sandbox=沙箱下载，mcp=MCP 协议下载
- **执行端点**：POST /file-op

---

## 五、应用管理类工具

### 19. open_app（打开应用）
- **功能**：打开指定的应用程序
- **触发场景**：要求打开软件、启动应用
- **参数**：
  - `path` (string, 必填)：应用名称（如"微信"、"记事本"）或可执行文件路径
- **执行端点**：POST /file-op

---

### 20. close_app（关闭应用）
- **功能**：关闭指定的正在运行的应用程序
- **触发场景**：要求关闭软件、退出应用
- **参数**：
  - `path` (string, 必填)：要关闭的应用名称（如"微信"、"记事本"）
- **执行端点**：POST /file-op

---

### 21. uninstall_app（卸载应用）
- **功能**：卸载指定的应用程序（通过 Windows 注册表查找卸载程序并执行）
- **触发场景**：要求卸载软件、删除应用
- **参数**：
  - `path` (string, 必填)：要卸载的应用名称（如"微信"、"记事本"）
- **执行端点**：POST /file-op

---

### 22. check_app_installed（检测应用安装）
- **功能**：检测指定的应用程序是否已安装在系统中
- **触发场景**：确认某款软件是否可用、执行任务前检查依赖、决定是否需要安装
- **返回**：安装状态、可执行文件路径和版本信息
- **参数**：
  - `app_name` (string, 必填)：要检测的应用程序名称，如"Notepad++"、"VSCode"、"7-Zip"等
- **执行端点**：POST /file-op

---

### 23. install_app（安装应用）
- **功能**：自动下载并安装指定的应用程序
- **触发场景**：检测到缺失某款软件且任务需要该软件时
- **说明**：系统从配置的安装源下载安装包并执行静默安装，仅支持预定义软件列表
- **参数**：
  - `app_name` (string, 必填)：要安装的应用程序名称，如"Notepad++"、"VSCode"、"7-Zip"、"Python"、"Git"等
- **执行端点**：POST /file-op
- **相关服务**：[AppInstallService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/AppInstallService.cs)

---

## 六、命令与脚本执行类工具

### 24. execute_command（执行命令）
- **功能**：在安全沙箱中执行 Windows 命令行指令（支持 cmd 和 PowerShell）
- **触发场景**：执行系统命令、运行脚本、查看系统信息、操作文件等需要命令行操作
- **重要说明**：长运行命令（如 dev server、watch 模式）必须用 blocking=false 后台运行
- **参数**：
  - `command` (string, 必填)：要执行的命令行指令（cmd 命令如 dir/echo/type，PowerShell 命令如 Get-Process/Write-Output）
  - `blocking` (boolean, 可选)：true=同步等待结果（默认），false=后台运行返回 command_id
  - `cwd` (string, 可选)：工作目录
  - `timeout` (integer, 可选)：同步模式超时秒数
- **执行端点**：POST /file-op（或 POST /execute 端口 58903）
- **相关服务**：
  - [CommandExecutionService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/CommandExecutionService.cs)
  - [SandboxService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/SandboxService.cs)
  - [RiskAssessmentService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/RiskAssessmentService.cs)

---

### 25. execute_python（执行 Python）
- **功能**：在嵌入式 Python 3.11 环境中执行 Python 脚本
- **触发场景**：运行 Python 代码、进行数据分析、文件处理、执行计算任务
- **说明**：执行前进行语法检查，默认超时 30 秒
- **参数**：
  - `code` (string, 必填)：要执行的 Python 脚本代码
  - `args` (string, 可选)：传递给 Python 脚本的命令行参数
- **执行端点**：POST /execute（端口 58903）
- **相关服务**：[PythonExecutionService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/PythonExecutionService.cs)

---

### 26. get_command_status（查询命令状态）
- **功能**：查询后台命令状态（running/done/killed）和输出
- **触发场景**：配合 execute_command blocking=false 使用
- **参数**：
  - `command_id` (string, 必填)：execute_command blocking=false 返回的 command_id
- **执行端点**：POST /file-op

---

### 27. stop_command（停止命令）
- **功能**：停止后台命令（终止进程树）
- **参数**：
  - `command_id` (string, 必填)：要停止的 command_id
- **执行端点**：POST /file-op

---

## 七、系统信息类工具

### 28. get_system_status（获取系统状态）
- **功能**：获取当前系统状态信息，包括 CPU 使用率、内存使用率、磁盘可用空间、网络连接状态
- **触发场景**：检查系统资源是否充足、诊断性能问题、执行任务前评估环境
- **参数**：无参数
- **执行端点**：POST /file-op
- **相关服务**：[SystemStatusService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/SystemStatusService.cs)

---

## 八、图片生成类工具

### 29. ZTimage-Agent（图片生成代理）
- **功能**：委派图片生成任务给 ZTimage-Agent（专用图片生成代理，调用 MiniMax image-01 / image-01-live 模型）
- **触发场景**：需要生成图片、为 PPT/文档配图、创作插图
- **★重要**：返回的 URL 可能过期失效，必须在收到 URL 后调用 download_file 下载到本地，再把本地路径插入到最终文件中；严禁生成图片后不插入到最终文件
- **参数**：
  - `images` (array, 必填)：要生成的图片清单，每项含：
    - `prompt` (string, 必填)：图片的文本描述，最长 1500 字符
    - `model` (string, 必填)：模型选择（image-01 / image-01-live）
      - image-01：通用文生图（画面细腻，支持 21:9）
      - image-01-live：需要特定画风时使用（配合 style_type）
    - `aspect_ratio` (string, 必填)：图片宽高比（1:1/16:9/4:3/3:2/2:3/3:4/9:16/21:9）
      - PPT配图用16:9，人物肖像用3:4或1:1，风景用16:9，方形用1:1
    - `style_type` (string, 可选，仅 image-01-live)：画风类型（漫画/元气/中世纪/水彩）
    - `n` (integer, 可选)：单次生成图片数量，1-9，默认1
- **Agent 切换**：调用时会切换到 ZTimage-Agent 输出，完成后切回 MoonYa Agent

---

## 九、Computer Use（CU）桌面操作类工具

### 30. take_screenshot（截屏）
- **功能**：截取屏幕或前景窗口并返回图像与精确坐标元数据
- **重要**：视觉模型接管后必须传 target="screen"；所有坐标操作只能依据这一次截图返回的坐标系、origin 和 scale
- **参数**：
  - `target` (string, 可选)：截图范围（screen=全屏，window=前景窗口）；视觉模型层必须使用 screen
- **执行端点**：POST /cu-op（端口 58900）
- **CU 专用**：仅在 computer_user 模式下可用

---

### 31. get_cursor_pos（获取鼠标位置）
- **功能**：获取当前鼠标光标在屏幕上的坐标（像素，左上角为 0,0）
- **触发场景**：执行 mouse_click 之前确认当前鼠标位置，或校验上一次点击是否生效
- **参数**：无参数
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 32. mouse_move（移动鼠标）
- **功能**：将鼠标光标移动到指定屏幕坐标 (x, y)，不点击
- **参数**：
  - `x` (integer, 必填)：屏幕横坐标（像素）
  - `y` (integer, 必填)：屏幕纵坐标（像素）
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 33. mouse_click（鼠标点击）
- **功能**：在指定屏幕坐标 (x, y) 执行鼠标点击
- **参数**：
  - `x` (integer, 必填)：屏幕横坐标（像素）
  - `y` (integer, 必填)：屏幕纵坐标（像素）
  - `button` (string, 可选)：鼠标按键（left/right/middle），默认 left
  - `click` (string, 可选)：单击或双击（single/double），默认 single
- **执行端点**：POST /cu-op
- **CU 专用**
- **止损机制**：同坐标 ±10px 仅允许 1 次

---

### 34. mouse_scroll（鼠标滚轮）
- **功能**：在当前位置滚动鼠标滚轮
- **参数**：
  - `delta` (integer, 必填)：滚动量，正值向上滚，负值向下滚（如 120 或 -120）
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 35. mouse_drag（鼠标拖动）
- **功能**：鼠标拖动：按住左键拖动画线，支持直线模式和曲线模式
- **两种模式**：
  1. **直线模式**：传 from_x/from_y/to_x/to_y，从起点画直线到终点
  2. **曲线模式**：传 points 数组（至少3个点），用 Catmull-Rom 样条插值生成平滑曲线
- **画曲线建议**：画圆弧用 8-12 个点沿圆周分布；画弧线用 3-5 个点
- **参数**：
  - `from_x` (integer, 可选)：直线模式起点横坐标
  - `from_y` (integer, 可选)：直线模式起点纵坐标
  - `to_x` (integer, 可选)：直线模式终点横坐标
  - `to_y` (integer, 可选)：直线模式终点纵坐标
  - `points` (array, 可选)：曲线模式路径点数组，每项含 x,y；非空时忽略 from/to
  - `button` (string, 可选)：鼠标按键（left/right/middle），默认 left
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 36. mouse_hold（鼠标长按）
- **功能**：鼠标长按：在 (x, y) 位置按下指定按键并保持 duration 毫秒后释放
- **触发场景**：长按操作（长按右键弹出菜单、长按左键拖动预备、长按文件弹出属性等）
- **参数**：
  - `x` (integer, 必填)：横坐标（像素）
  - `y` (integer, 必填)：纵坐标（像素）
  - `button` (string, 可选)：鼠标按键，默认 left
  - `duration` (integer, 可选)：按住时长（毫秒），默认 500，范围 100-5000
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 37. keyboard_type（键盘输入）
- **功能**：模拟键盘输入一段文本（逐字符输入）
- **参数**：
  - `text` (string, 必填)：要输入的文本内容
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 38. key_press（按键）
- **功能**：模拟按下组合键或单键（如 ctrl+c、enter、alt+tab、win、esc）
- **参数**：
  - `keys` (string, 必填)：按键组合，多个键用 + 连接，如 "ctrl+c"、"enter"、"alt+tab"、"win"
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 39. task_complete（任务完成）
- **功能**：当用户命令已全部完成时调用此工具结束 Computer User 任务循环
- **验证机制**：首次调用需截图验证界面是否变化，验证通过才结束
- **参数**：
  - `summary` (string, 必填)：任务完成总结，说明完成了什么操作
- **CU 专用**

---

### 40. find_element（查找 UI 元素）
- **功能**：在当前活动窗口（或指定父元素）的 UI 树中按条件查找单个 UI 元素
- **说明**：优先使用此工具精确定位元素而非整树获取；返回 element_id 用于后续操作
- **参数**：
  - `parent_element_id` (string, 可选)：父元素 ID（来自上一次 find_element），缺省为当前活动窗口
  - `automation_id` (string, 可选)：按 AutomationId 匹配（精确匹配，最稳定）
  - `name` (string, 可选)：按 Name 匹配（不区分大小写包含匹配）
  - `control_type` (string, 可选)：按 ControlType 匹配（Button/Edit/CheckBox/ComboBox/MenuItem/TabItem 等）
- **执行端点**：POST /cu-op
- **CU 专用**
- **相关服务**：[UiAutomationService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/UiAutomationService.cs)

---

### 41. get_ui_tree（获取 UI 树）
- **功能**：获取当前活动窗口（或指定根元素）的 UIA 文本树
- **说明**：树中的数字是观察索引，不是 element_id；需要操作时再用 find_element 获取 element_id
- **参数**：
  - `root_element_id` (string, 可选)：根元素 ID，缺省为当前活动窗口
  - `max_depth` (integer, 可选)：最大递归深度，默认 6
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 42. click_element（点击 UI 元素）
- **功能**：点击指定 UI 元素
- **说明**：优先使用 InvokePattern（按钮）/ TogglePattern（复选框/单选框），模式不可用时回退到 SendInput 点击元素中心坐标；比 mouse_click 更稳定，不受窗口位置变化影响
- **参数**：
  - `element_id` (string, 必填)：目标元素 ID（来自 find_element，或 capture_ui_snapshot 的 focused_element_id）
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 43. set_text（设置文本）
- **功能**：设置文本框/编辑框的内容
- **说明**：通过 ValuePattern.SetValue 直接赋值（覆盖原有内容），比 keyboard_type 更快更可靠；失败时回退到清空+keyboard_type 输入
- **参数**：
  - `element_id` (string, 必填)：目标文本框元素 ID
  - `text` (string, 必填)：要设置的文本内容
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 44. get_text（获取文本）
- **功能**：读取 UI 元素的文本内容
- **优先级**：TextPattern（富文本控件）→ ValuePattern（输入框）→ element.Current.Name
- **用途**：读取输入框当前值、列表项标签等；返回文本超过 5000 字符时截断
- **参数**：
  - `element_id` (string, 必填)：目标元素 ID
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 45. capture_ui_snapshot（UI 快照感知）
- **功能**：CU 模式首选感知工具，一次调用同时获取 UIA 树、可用元素数、截图、焦点元素、窗口元信息
- **说明**：每轮决策前优先调用此工具，替代 take_screenshot + get_ui_tree 两步组合；截图坐标系是 window-relative，AI 输出的坐标会被系统自动还原为屏幕物理坐标
- **参数**：
  - `max_depth` (integer, 可选)：UIA 树最大深度，默认 6
  - `include_screenshot` (boolean, 可选)：是否包含截图，默认 true；设为 false 时仅返回 UIA 树
  - `screenshot_target` (string, 可选)：截图目标，window（默认，window-relative 坐标系）或 screen（整屏）
- **执行端点**：POST /cu-op
- **CU 专用**

---

### 46. focus_window（聚焦窗口）
- **功能**：切换到已经运行的窗口
- **重要**：应用已运行时必须用此工具，禁止再次调用 open_app
- **参数**：
  - `window_title` (string, 可选)：目标窗口标题关键词
  - `process_name` (string, 可选)：目标进程名，如 QQ.exe
- **执行端点**：POST /cu-op
- **CU 专用**

---

## 十、浏览器自动化（BA）类工具

### 47. browser_automation_control（浏览器自动化操控）
- **功能**：浏览器自动化操控工具合集，通过子参数 action 指定具体操作
- **模式门控**：仅在 agent / computer_user 模式下可用（mode_gate: ['agent', 'computer_user']）
- **子操作（action）**：
  - `start`：启动浏览器并导航到 URL
  - `navigate`：导航到新 URL
  - `click`：点击 CSS 选择器元素
  - `fill`：向元素输入文本
  - `screenshot`：页面截图
  - `scroll`：滚动页面
  - `stop`：停止浏览器
- **参数**：
  - `action` (string, 必填)：具体浏览器操作（start/navigate/click/fill/screenshot/scroll/stop）
  - `url` (string, action=start/navigate时必填)：导航目标 URL
  - `selector` (string, action=click/fill时必填)：CSS 选择器
  - `text` (string, action=fill时必填)：输入文本
  - `direction` (string, action=scroll时必填)：滚动方向（up/down）
  - `amount` (integer, action=scroll时必填)：滚动量
- **执行端点**：BrowserApiServer（端口 58905）
- **相关服务**：
  - [BrowserAutomationService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserAutomationService.cs)
  - [BrowserSecurityGate.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/BrowserSecurityGate.cs)

---

### 48. vls_analyze_browser（VLS 浏览器视觉分析）
- **功能**：调用 VLS-Agent 分析当前浏览器页面，返回元素布局与交互建议
- **说明**：无需参数，自动截取当前浏览器视口并交给视觉模型分析
- **模式门控**：仅在 agent / computer_user 模式下可用
- **参数**：无参数

---

## 十一、Trae Work 代码工具集（Agent/CU 双模式可用）

### 49. edit_file（编辑文件）
- **功能**：编辑文件的通用工具，支持三个子命令
- **重要**：修改代码时优先使用此工具，禁止整文件重写
- **子命令**：
  1. `view` - 查看文件内容（带行号）或目录列表
  2. `str_replace` - 精确字符串替换（要求 old_str 在文件中唯一匹配，不唯一时返回所有匹配行号让你用更长上下文重试）
  3. `insert` - 在指定行号后插入内容（insert_line=0 表示文件开头）
- **参数**：
  - `command` (string, 必填)：子命令（view/str_replace/insert）
  - `path` (string, 必填)：文件或目录的绝对路径
  - `old_str` (string, str_replace时必填)：要被替换的字符串
  - `new_str` (string, str_replace/insert时必填)：替换后的新字符串或待插入内容
  - `insert_line` (integer, insert时必填)：在第几行后插入（0=文件开头，1=第1行后）
  - `view_range` (array, view时可选)：[start, end] 行号范围，end=-1 到文件末尾；查看目录时 [depth_min, depth_max]
  - `cwd` (string, 可选)：工作目录
- **执行端点**：POST /file-op
- **相关服务**：[EditFileService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/EditFileService.cs)

---

### 50. grep（内容搜索）
- **功能**：基于 ripgrep 的高速内容搜索工具
- **重要**：找不到代码时必须用此工具定位，禁止盲猜路径；无匹配返回空结果（不算错误）
- **参数**：
  - `pattern` (string, 必填)：正则表达式模式
  - `path` (string, 可选)：搜索根目录（默认当前目录）
  - `output_mode` (string, 可选)：输出模式（content/files_with_matches/count），默认 content
  - `context_before` (integer, 可选)：上下文行数（匹配行前 N 行）
  - `context_after` (integer, 可选)：上下文行数（匹配行后 N 行）
  - `context` (integer, 可选)：上下文行数（同时设置前后 N 行）
  - `show_line_numbers` (boolean, 可选)：是否显示行号，默认 true
  - `case_insensitive` (boolean, 可选)：是否忽略大小写，默认 false
  - `glob_filter` (string, 可选)：文件名 glob 过滤（如 *.php）
  - `type_filter` (string, 可选)：文件类型过滤（如 php/py/js）
- **执行端点**：POST /file-op
- **相关服务**：[GrepService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/GrepService.cs)

---

### 51. glob（文件名匹配）
- **功能**：按 glob 模式匹配文件名（如 **/*.php）
- **返回**：按修改时间倒序排序的文件列表，单次最多 200 个
- **参数**：
  - `pattern` (string, 必填)：glob 模式（支持 **、*、?、{a,b} 语法）
  - `path` (string, 可选)：搜索根目录（默认当前目录）
- **执行端点**：POST /file-op
- **相关服务**：[GlobService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/GlobService.cs)

---

### 52. view_directory（查看目录树）
- **功能**：查看目录树结构（递归深度可配置，默认 2 层）
- **自动排除**：.git/node_modules/vendor/bin/obj/.venv/__pycache__/.vs/.idea 等噪声目录
- **参数**：
  - `path` (string, 必填)：目录路径
  - `depth` (integer, 可选)：递归深度（默认 2）
  - `exclude_patterns` (array, 可选)：自定义排除模式（追加到默认排除列表）
- **执行端点**：POST /file-op
- **相关服务**：[ViewDirectoryService.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/ViewDirectoryService.cs)

---

### 53. todo_write（任务管理）
- **功能**：管理任务列表（创建/更新/查询）
- **重要**：复杂任务（≥3 步）必须先调用此工具规划；同时只能有一个 in_progress 任务；任务状态变化通过 SSE 实时推送到前端
- **本地处理**：此工具在 PHP 本地处理，不调用 C# launcher
- **参数**：
  - `todos` (array, 必填)：任务列表，每项含：
    - `id` (string, 必填)：任务唯一 ID
    - `content` (string, 必填)：任务描述
    - `status` (string, 必填)：任务状态（pending/in_progress/completed）
    - `priority` (string, 必填)：优先级（high/medium/low）
    - `summary` (string, 可选)：任务完成时的总结（仅 status=completed 时填）
  - `merge` (boolean, 可选)：false=替换整个列表（默认），true=按 id 合并到现有列表

---

### 54. get_diagnostics（LSP 诊断）
- **功能**：获取指定文件的 LSP 诊断信息（错误/警告/提示）
- **重要**：修改代码后必须调用此工具验证是否引入错误
- **支持语言**：PHP（Intelephense）、Python（Pyright）、JS-TS（tsserver）
- **参数**：
  - `path` (string, 必填)：文件路径
  - `full_project` (boolean, 可选)：是否获取全项目诊断（默认 false，仅获取指定文件）
- **执行端点**：POST /file-op
- **相关服务**：
  - [LspServiceManager.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/LspServiceManager.cs)
  - [PhpIntelephenseServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/PhpIntelephenseServer.cs)
  - [PythonPyrightServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/PythonPyrightServer.cs)
  - [TypeScriptServer.cs](file:///d:/Project/Project/MoonYa/MoonYa-Win/MoonYa-Solution/MoonYa/Services/TypeScriptServer.cs)

---

### 55. find_references（查找引用）
- **功能**：查找指定符号的所有引用位置（LSP textDocument/references）
- **触发场景**：重构函数前用此工具了解调用方
- **参数**：
  - `path` (string, 必填)：文件路径
  - `line` (integer, 必填)：符号所在行号（1-based）
  - `column` (integer, 必填)：符号所在列号（1-based）
- **执行端点**：POST /file-op

---

### 56. goto_definition（跳转定义）
- **功能**：跳转到指定符号的定义位置（LSP textDocument/definition）
- **参数**：
  - `path` (string, 必填)：文件路径
  - `line` (integer, 必填)：符号所在行号（1-based）
  - `column` (integer, 必填)：符号所在列号（1-based）
- **执行端点**：POST /file-op

---

## 工具数量统计

| 分类 | 数量 |
|------|------|
| 生活娱乐类 | 6 |
| 网络搜索与爬虫类 | 3 |
| 文件操作类 | 8 |
| 下载类 | 1 |
| 应用管理类 | 5 |
| 命令与脚本执行类 | 4 |
| 系统信息类 | 1 |
| 图片生成类 | 1 |
| Computer Use 桌面操作类 | 17 |
| 浏览器自动化类 | 2 |
| Trae Work 代码工具集 | 8 |
| **总计** | **56** |

---

## 工具执行端点汇总

| 服务 | 端口 | 端点 | 处理工具 |
|------|------|------|---------|
| FileOperationApiServer | 58900 | POST /file-op | 文件/应用/代码/grep/glob/目录查看等 |
| FileOperationApiServer | 58900 | POST /cu-op | 截图/鼠标/键盘/UIA元素操作 |
| FileOperationApiServer | 58900 | GET/POST /cu/window-snapshot | 窗口列表快照 |
| ExecutionApiServer | 58903 | POST /execute | 命令沙箱执行/Python脚本执行（SSE流式） |
| BrowserApiServer | 58905 | POST /browser/* | 浏览器自动化（启动/导航/点击/填充/截图/滚动/JS执行等） |
| LspApiServer | 58906 | POST /lsp-op | LSP代码诊断/跳转定义/查找引用 |
| Python 统一服务 (main.py) | 58901 | POST /crawl, GET /download/* | 网页爬取（SSE流式进度）/下载zip |
| Python 统一服务 (main.py) | 58901 | POST /search (action=web_search/web_fetch) | 网络搜索/网页内容抓取 |
| SearchServerService（独立启动） | 58902 | POST /search | 独立搜索服务（可选启动方式） |

---

## 工具模式可用性矩阵

| 工具分类 | normal | agent | computer_user |
|----------|--------|-------|---------------|
| 生活娱乐类 | ✅ | ✅ | ✅ |
| 网络搜索/爬虫 | ✅ | ✅ | ✅ |
| 文件操作 | ✅ | ✅ | ✅ |
| 下载 | ✅ | ✅ | ✅ |
| 应用管理 | ✅ | ✅ | ✅ |
| 命令执行 | ❌ | ✅ | ✅ |
| 系统信息 | ✅ | ✅ | ✅ |
| 图片生成 | ✅ | ✅ | ✅ |
| CU 桌面操作（鼠标/键盘/UIA/截图） | ❌ | ❌ | ✅ |
| 浏览器自动化 | ❌ | ✅ | ✅ |
| Trae Work 代码工具 | ❌ | ✅ | ✅ |

---

## 已废弃/已移除工具

| 工具名 | 状态 | 说明 |
|--------|------|------|
| scroll_element | 废弃（在 $cuOnlyTools 列表中但未定义） | UIA 元素滚动 |
| invoke_element | 废弃（在 $cuOnlyTools 列表中但未定义） | UIA 元素调用 |
| get_window_list | 废弃（在 $cuOnlyTools 列表中但未定义） | 获取窗口列表（由 /cu/window-snapshot 端点替代） |
| wait | 废弃（在 $cuOnlyTools 列表中但未定义） | 等待 |
| scroll | 废弃（在 $cuOnlyTools 列表中但未定义） | 滚动 |
| MoonYa-T-Agent | 已移除 | 深度思考工具，现通过 reasoning_content 处理 |
| generate_image | 内部映射 | 实际映射到 ZTimage-Agent |
