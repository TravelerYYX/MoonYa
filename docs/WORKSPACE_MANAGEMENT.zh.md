# Work 项目与会话管理

实现入口为 `MoonYa-Frontend/src/work-sidebar.js`，通过 manifest 随本地静态页面发布。Chat 继续使用原最近会话列表；Work 提供搜索、置顶、自定义分区、项目、最近与归档。

## 用户行为

- 项目行选择新建会话的默认项目，并展开／折叠；不会改变当前会话的目录。项目行右侧按钮直接在该项目中新建。
- 所有新建入口（侧边栏、顶部、浮动按钮和桌面标题栏）使用已选默认项目。空会话只在同一项目和目录下复用。
- 项目默认最多展示 5 条会话，“展开显示”与折叠状态保存在本机。最近按最后发送时间排序，包含所有未归档 Work 会话。
- 项目菜单支持置顶、编辑名称／目录、分区、打开文件夹、归档会话和移除项目。更换目录只影响后续轮次，不移动文件。
- 分区与项目支持拖拽排序及菜单上移／下移；会话可拖到项目或分区。会话的项目关联与分区位置独立：移到分区后仍受原项目的目录编辑和归档影响。
- 统一置顶区保留原位置信息。取消置顶回到原位置；最近列表仍保留会话入口。
- 归档隐藏会话，项目保留；归档入口位于「设置 → 归档会话」，可以查看、逐条恢复或按项目全部恢复。恢复后才能继续发送。
- 移除项目不会删除文件或历史，其会话清除项目、分区与置顶关联，回到最近列表并保留原工作目录。
- 执行、准备发送或等待审批时禁止会话移动目录、归档与删除，以及受影响项目的换目录、归档与移除。整理分区、排序和置顶不受限制。
- 搜索项目名称、目录、会话标题；路径搜索兼容两种分隔符。归档列表单独搜索标题。会话菜单保留重命名、删除和批量删除。

## 外观

- 归档入口只在设置弹窗中提供，侧边栏不再挂载归档按钮；弹窗关闭动画结束后再打开归档对话框，避免两个模态层叠。归档对话框仍复用 `work-sidebar.js` 的 `archiveDialog`，通过 `window.MoonYaWorkspace.archiveDialog` 暴露。

## 存储与接口

继续使用 `moonya-history` 版本 1，不新增数据库或云端项目路由。项目记录扩展原 `drafts/[scope, __work_projects__]`；分区、排序、默认项目和展开状态使用 `drafts/[scope, __sidebar_layout__]`。项目 ID 保持稳定，Windows 路径按大小写、分隔符及尾部分隔符去重，允许不同目录同名。

会话元数据增加 `projectId`、`workingDirectory`、`projectName`、`sectionId`、`archivedAt` 和 `lastActivityAt`，复用 `pinned`、`activeWorkspaceIdentity` 与 `runtimeSessions`。消息、附件和旧目录 session 映射不随归档／移动清理。

`MoonYaHistoryStore.projectRequest(scope, action, body)` 保持 `list/create/delete/save_current` 兼容并增加 `update`。`sidebarRequest` 统一项目置顶／分区／归档、分区 CRUD、排序、展开状态和会话移动／置顶／分区／归档／恢复操作，返回 `{ success, data, message? }`。

项目及关联会话、草稿目录使用同一个 IndexedDB 事务提交。所有同账号写入通过同一队列排序；工作区管理字段在提交后成为权威值，并合并进晚到的消息和草稿快照。失败事务回滚，界面保留旧状态并显示错误；用户可重新提交。现有历史保存失败仍使用原重试机制。

首次读取按已有 active directory、草稿目录或唯一 session 目录识别旧会话项目；缺失或冲突时保持未归属，绝不根据会话标题或当前全局目录推断。新界面状态随账号 scope 隔离，切换账号关闭旧菜单和弹窗。

原生文件操作继续通过鉴权桌面网关的 `/file-op` 使用 `validate_path`、`pick_folder` 和 `open_file`。测试 smoke host 可通过 `MOONYA_SMOKE_FILE_SERVICE` 接入本地文件接口夹具，该配置仅用于测试 host。

## 验证

```powershell
npm test --prefix MoonYa-Frontend
node --test MoonYa-Backend/tests/history_store_browser_test.js
```

`tests/workspace.test.mjs` 使用真实 Chrome、IndexedDB 和 .NET 桌面网关，覆盖目录绑定、晚到流式快照、附件／草稿保留、事务回滚、旧数据识别、执行中限制、项目菜单、拖拽、搜索、归档和模式切换。视觉截图输出到 `artifacts/workspace`。构建资源位于 `MoonYa-Frontend/dist`。
