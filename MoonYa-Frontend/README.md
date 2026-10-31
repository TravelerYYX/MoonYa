# MoonYa 本地前端

沿用原 PHP 页面中的 HTML、CSS、全局脚本及执行顺序；当前维护入口为 `src`，
不再维护 `MoonYa-Backend/script/MoonYa-index` 的聊天 UI。

```powershell
npm ci --prefix MoonYa-Frontend
npm run build --prefix MoonYa-Frontend
npm test --prefix MoonYa-Frontend
```

`dist` 为生成目录。Windows 客户端的本地 HTTP 服务提供 `/index.html`、资源和接口网关。
不要用 `file://` 打开页面，也不需要本地 PHP。浏览器回归测试使用已安装的 Chrome。

主题回归使用 `node --test MoonYa-Frontend/tests/theme.test.mjs`（先执行上述构建及 FrontendSmoke 构建）；原生同步验收在项目根目录执行 `dotnet run --project MoonYa-Win/MoonYa-Solution/MoonYa.ThemeSmoke -- .`。验收使用隔离偏好文件和 CEF 缓存，截图输出至 `MoonYa-Frontend/artifacts/theme`。

- `manifest.json` 保留原脚本顺序；新增文件必须登记。
- `defaults.json` 只放公开配置；运行时使用缓存并异步请求 `api/client_config.php`。
- `client.js` 是现有全局脚本的统一请求边界，远程路由和本机路由在原生服务中再次校验。
- 后台新增技能同步到 Harness 加号菜单的“自定义技能”组及插件面板，支持每项启用偏好。启动、恢复联网、重新获得焦点和打开技能菜单会刷新；本地 `api/skills.php` 返回实际可执行目录的摘要和缓存状态。每轮由 Runtime 独立获取权威正文，主文件与子文件经 `read_skill` 按需进入模型上下文。普通 Chat 不使用技能。
- `migration-export.js`/`migration-import.js` 处理旧来源数据、二进制附件及幂等导入。
- `public/vendor` 固定版本为 Highlight.js 11.9.0、Mammoth 1.8.0、PDF.js 3.11.174，
  与原页面一致。许可文件随资源发布；参见根目录 `THIRD_PARTY_NOTICES.md`。

部署与验收步骤见 `docs/FRONTEND_BACKEND_SEPARATION.zh.md`。

Work 项目侧边栏、会话归属和原子更新规则见 `docs/WORKSPACE_MANAGEMENT.zh.md`。

## 客户端界面

- 默认打开 Harness 对话页；顶部下拉菜单切换 Harness / Chat，内部继续使用 `work` / `chat`，历史和桥接协议保持兼容。
- `app-shell.js` 同步模式、欢迎区、导航及搜索；`css-24-app-shell.css` 管理整体布局和组件表面，基础视觉变量定义在 `css-01-base.css`。
- 应用自带图标使用 `MoonYaIcons.icon(name)` 或 `[data-ui-icon]`，图形来自本地 `ui-icons.js`。UI 文案不使用表情符号，用户输入、AI 回复及用户命名内容原样保留。
- “设置 → 外观”提供浅色、深色和跟随系统（默认）三种主题，即时生效并在本机保存。`theme.js` 在首屏绘制前恢复缓存，`css-32-theme.css` 定义主题颜色；组件使用 `--theme-*` / `--ui-*` 变量。Windows 客户端通过 `moonYaTheme` 桥接同步原生标题栏、菜单及加载界面，权威偏好保存在 `~/.MoonYa/frontend/theme.json`；独立浏览器使用 `moonya.theme.v1` 本地存储与 `prefers-color-scheme`。第三方网页及媒体内容保持自身配色。
- 悬停提示统一使用 `data-tooltip`（动态控件使用 `element.dataset.tooltip`），由 `tooltips.js` 和 `css-25-tooltips.css` 渲染深色圆角浮层；保留换行及完整路径。图标按钮仍需提供 `aria-label`。不要再使用浏览器原生 `title` 提示；iframe 的可访问标题和业务数据的 `title` 字段保持原用途。
- 附件通过 `attachments-ui.js` 共用上传、实时消息与历史卡片：待发送 122px，已发送 80px；普通文件显示图标和名称，待发送卡片悬停显示移除按钮。按钮与回车支持纯文件发送，粘贴和拖拽沿用文件选择的校验。桌面图片缩略图通过已有本机媒体路由读取并缓存，原文件的模型输入不变；历史兼容旧图片、文档标记和文档标签。构建后运行 `node --test MoonYa-Frontend/tests/attachments.test.mjs` 验证；截图在 `MoonYa-Frontend/artifacts/attachments`。
- 操作通知统一使用 `showToast(message, duration = 2000)`；`notifications.js` 在请求边界之前加载，白色卡片在内容区顶部居中，以真实消息最多叠放三层，弹出时下方两角弹性鼓起。持续状态使用 `MoonYaNotifications.update(id, message, { duration: 0 })`，完成后改为有限时长，或调用 `remove(id)`。通知使用纯文本，不抢焦点；确认、输入、权限审批和带操作按钮的提示保持原交互。
- “设置 → 外观 → 过程动画”提供轻柔玻璃感（默认）和液态玻璃两种过渡，主对话与子代理共用 `process-ui.js` / `css-28-process.css`；偏好保存在本地并即时生效。过程状态不带背景，运行时白色扫光每秒一轮，展开的思考行从图标、标题到摘要统一扫过，完成、失败或停止后立即关闭。系统减少动态效果时关闭动画；历史回放不播放状态切换。
- 过程列表按记录增量维护分类、计数和运行状态，流式表头每帧最多刷新一次；保存历史、轮次结束和用户展开前同步刷新。`MoonYaProcessUI.flush(host?)` 可在需要立即读取表头状态时调用。隐藏详情不测量布局，屏幕外收起行使用浏览器渲染跳过，展开的详情保留自然高度和滚动。
- Chat 快捷功能与热门话题在输入框加号菜单中；办公室、浏览器及设置通过左侧导航进入，工作面板可通过聊天区右上角按钮开合。
- 聊天区顶部显示当前会话标题；右侧依次为更多选项（语音播报）、工作面板、新建对话，桌面及网页共用这组入口。
- 每轮 Harness 回复正文末尾的文件变更卡片由 `workspace-changes.js` 渲染，默认展示三个文件，提供差异查看和整轮撤销确认。历史保存稳定坐标，重放后从运行时读取权威状态并重新绑定交互。`css-29-workspace-changes.css` 管理卡片、差异与确认弹窗；“数据导入与同步”中可配置或迁移默认工作目录。
- `npm test` 包含界面、模式、项目、离线数据、浏览器桥接及表情禁用检查；界面验收截图输出至 `artifacts/ui-redesign`。

过程列表性能测试：`npm run benchmark:process`。与修改前版本比较时，先保存原 `process-ui.js` 和 `css-28-process.css` 到同一目录，再使用 `npm run benchmark:process -- --baseline <目录>`。测试在 1000×800 窗口下对两种动画各测三次，覆盖 100 / 1000 / 3000 / 5000 条混合记录；旧版仅测至 3000 条，避免重复执行其高成本路径。记录生成、同步展开、布局、长帧和裁切结果，输出至 `artifacts/process-performance/benchmark.json`。基准应单独运行，避免并行浏览器测试影响测量；这些夹具数据不代表已完成真实桌面客户端验收。

附件查看由 `attachment-preview.js` 提供聊天页内的模糊遮罩、图片缩放和平移、PDF 分页、纯文本及音视频控件，Office 等格式显示文件信息并提供下载或桌面系统应用入口。原文件不超过 20MB 时保存在现有附件缓存中，文本内嵌上限为 2MB；大文件继续使用已有授权的本机路径，来源失效时需要重新选择。图片加载使用骨架，失败保留诊断和重试，缓存失败不丢弃已生成缩略图。删除卡片立即更新草稿，剩余节点以 220ms FLIP 动画补位，并遵循系统减少动态效果设置。

Windows 文件拖放通过 `AttachmentDropController` 的 WPF FileDrop 接入，使用真实系统路径和现有精确文件授权；聊天区域之外阻止接收，也阻止浏览器直接打开文件。原生隔离回归项目 `MoonYa.AttachmentSmoke` 验证实际 CEF/WPF 拖放事件、路径顺序、授权与拒绝后的撤销；运行时传入仓库 `yax.png` 和客户端的 CEF 原生库输出目录。
