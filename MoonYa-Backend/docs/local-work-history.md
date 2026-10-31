# Work 本地历史

- Work 的会话、草稿、执行事件、项目记录和浏览器附件保存在当前浏览器/桌面 CEF profile 的 IndexedDB `moonya-history` 中，按用户隔离。列表读取元数据，消息在打开会话时加载。
- 桌面 CEF profile 沿用 `%LOCALAPPDATA%\MoonYa\CefCache`（可由 `MOONYA_CEF_CACHE_PATH` 覆盖）。没有修改或清空原 profile。
- Agent Runtime 的完整 JSONL 日志和桌面选择的原始文件副本保存在配置的 `agent_runtime.data_path` / `MOONYA_HARNESS_DATA` 中，默认 `%LOCALAPPDATA%\MoonYa\agent-runtime`。文件副本在 `attachments/<session>/<attachment>/`，日志包含引用。
- Work 不创建云端聊天记录，不向共享会话发布正文、草稿、状态、审批或 DOM 快照，也不调用云端附件/项目写入接口。模型推理仍接收必要的任务上下文；模型消息投影可以压缩，原始本地执行记录不随之删除。
- Work / Chat 使用独立会话。切换模式不会改变已经提交任务的归属。Chat 继续使用现有云端历史。
- 旧 localStorage 历史逐条事务迁移并校验，全部成功后才移除源数据；已知运行时绑定同时迁入会话元数据。无模式证据的旧记录保留为本地只读历史。
- 本地事务失败时保留内存记录，并显示重试按钮；保存失败不阻断发送。关闭页面前仍未保存的内存数据无法替代持久化，因此界面会保留“尚未保存”的状态。

## 云端兼容

`ConversationStoragePolicy` 自动建立 `conversation_storage_policy`，只注册新建且显式声明 `mode: chat` 的会话；也可使用 `sql/migrate_chat_storage_policy.sql` 预先建立表。旧云端数据不删除、不自动分类或导入。历史接口和 Chat 推理入口拒绝未注册会话。

## 验证

```powershell
cd MoonYa-Harness
node --test tests/*.test.mjs
cd ../MoonYa-Backend/tests
npm install
npm run test:local-history
php work_local_storage_test.php
```

浏览器测试使用已安装的 Chrome，或通过 `MOONYA_TEST_BROWSER_CHANNEL=msedge` 使用 Edge；PHP 可通过 `MOONYA_TEST_PHP` 指定。测试使用独立浏览器 profile、模拟 HTTP 接口和临时运行时目录，不连接生产数据库或模型。

覆盖超过 100 步的任务、上下文压缩完整工具交换、错误/取消后的再次发送、原始文件副本、超过 localStorage 容量的历史、迁移中断、写入失败重试、用户/设备隔离，以及存储等待期间切换模式的实际页面行为。
