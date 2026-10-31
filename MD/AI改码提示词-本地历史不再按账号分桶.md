# 提示词：把 MoonYa 本地历史从「按账号分桶」改为「全局单桶 + 退出后只读可见」

> 用法：把下面 `---` 之间的全部内容整段复制给 AI 编码助手。

---

## 一、任务目标

MoonYa 桌面端的本地会话历史与工作台项目，当前是**按登录账号分桶**存储的，
导致「退出登录后侧边栏历史全没了」「换账号看不到上一个账号的记录」。

请改成：

1. **本地历史（会话 + 项目 + 分区布局 + 草稿）不再按账号隔离**，整机只有一个全局桶。
2. **退出登录后，侧边栏照常显示全部本地历史**（项目和会话都能看到、能点开查看）。
3. **切换账号时，新账号能直接接上前一个账号留下的本地记录。**
4. **未登录状态为「只读浏览」**：历史可见、可翻阅，但禁止任何写入操作，也禁止发送消息。
5. 登录状态下功能完全恢复，不受影响。
6. 已存在的历史数据**零丢失**，需要一次性合并进全局桶。

---

## 二、红线（不遵守视为任务失败）

- 绝对**不要删除或清空任何已存在的 IndexedDB / localStorage 数据**。迁移是「复制 + 合并」，不是「搬走 + 删除」。
- 只改 `MoonYa-Frontend/src/**`。**不要改** `MoonYa-Backend/script/MoonYa-index/**`（那是已退役的旧前端副本，只被几个契约测试当文本 grep）。
- 不要改服务端 PHP 接口、不要动数据库表结构、不要动 `.env`。
- 不要动 `deepseek-harness-master/**`。
- 不要重命名 `CHAT_HISTORY_KEY` 这个全局变量（大量文件通过它取 scope，改名会引发连锁改动）。

---

## 三、现状（先读懂再动手）

### 3.1 本地历史存在哪

`MoonYa-Frontend/src/history-store.js`，IndexedDB 库名 `moonya-history`，第 1 行注释已写明
`Browser-local history. No network requests and no localStorage writes.`

- object stores：`conversations` / `messages` / `events` / `attachments` / `drafts` / `migrations`
- 全部 `keyPath: 'key'`，每条记录的 key 形如 `[scope, id]`，并带一个 `scope` 字段和 `scope` 索引
- 这个 `scope` 就是分桶键

### 3.2 scope 从哪来

`scope` = 全局变量 `CHAT_HISTORY_KEY`：

| 位置 | 内容 |
|---|---|
| `src/modules/script-1a-vars.js:7` | `let CHAT_HISTORY_KEY = 'chat_history';`（初始值） |
| `src/modules/script-1d-dom.js:1396` | `CHAT_HISTORY_KEY = user ? 'chat_history_' + user.id : 'chat_history';` ← **分桶的元凶** |

引用点（都要跟着检查）：
`script-1b-features.js:10/15/23/54/75`、`work-sidebar.js:67/74/101/168/190/255/293/447/475/508`、
`script-1f-work-project.js:92/222/241/352`、`script-1c-save.js:161/181/415/418/746/1377`、
`script-1d-dom.js:1396/1471/1475`、`script-1e-rest.js:568/570/594/616/641/653/1702/1803/1856/1880/1885/3062`、
`search-dialog.js:25/111/155`、`settings-modal.js:260`。

### 3.3 项目列表也在同一个桶里

- 项目：`history-store.js:310 / 438`，drafts store 的键 `[scope, '__work_projects__']`
- 分区布局：键 `[scope, '__sidebar_layout__']`

**所以退出登录切 scope，项目分组跟着一起消失，这不是 bug，是分桶的必然结果。**

### 3.4 退出登录做了什么

`src/modules/script-1d-dom.js:1419-1451` `logoutMoonYaAccount()`：

```
fetch('user_auth.php?action=logout')
localStorage.removeItem('api_token')
localStorage.removeItem('api_token_expires')
localStorage.removeItem('moonya.auth-expired.v1')
renderAuthState(null, false)      // ← scope 被切回 'chat_history'
currentChatId = null
currentDbConversationId = null
await initializeChatHistory()     // ← 去读那个空桶
renderChatList()                  // ← 于是侧边栏空了
```

**全程没有任何删除历史数据的调用**——数据还在 `chat_history_<id>` 里。这一点在改造后依然要成立。

### 3.5 发送拦截已经存在

`src/modules/script-1e-rest.js:1817-1821`：

```js
if (!isLoggedIn) {
    showToast('请先登录');
    openAuthModal();
    return;
}
```

其余零散的未登录拦截：`script-1d-dom.js:1168/1202/1225`（音乐/星座/天气）、`script-1c-save.js:1790`。

### 3.6 构建链

```
改 MoonYa-Frontend/src/**  →  cd MoonYa-Frontend && node build.mjs  →  dist/
桌面壳生效：把 dist/. 覆盖到 MoonYa-Win/.../bin/x64/Debug/net8.0-windows10.0.19041.0/frontend/
           或重新编译 C# 壳
```

---

## 四、目标行为（验收口径）

| # | 行为 |
|---|---|
| A | 本地历史 scope 恒为 `'chat_history'`，与登录状态、账号 id 完全无关 |
| B | 退出登录后，侧边栏「项目」分组与全部会话照常显示，可点开查看消息内容 |
| C | 换账号登录后，仍能看到上一个账号时期留下的本地会话与项目 |
| D | 未登录时**只读**：禁止发送、新建会话、重命名、删除、移动、归档、拖拽排序、新建/编辑/删除项目与分区、清空历史 |
| E | 登录后上述功能全部恢复 |
| F | 已有散落在 `chat_history_<id>` 的旧数据全部合并进全局桶，且原数据不删 |
| G | 云端会话（服务端）仍按账号归属，不产生跨账号串号 |

---

## 五、具体改动清单

### 5.1 scope 常量化

`src/modules/script-1a-vars.js`：

```js
const LOCAL_HISTORY_SCOPE = 'chat_history';
let CHAT_HISTORY_KEY = LOCAL_HISTORY_SCOPE;   // 保留 let，但全局不再有任何重新赋值的代码
```

`src/modules/script-1d-dom.js:1396`：**删除这一行**（`CHAT_HISTORY_KEY = user ? ... : ...`）。

### 5.2 清理因 scope 恒定而变成死代码的分支

- `script-1d-dom.js:1471-1488`（`checkUserSession`）：`const oldScope = CHAT_HISTORY_KEY;`、
  `anonymousDraft`、`if (oldScope !== CHAT_HISTORY_KEY)` 整段已成死代码，简化掉；
  但 `initializeChatHistory() / renderChatList()` 的调用必须保留。
- `script-1d-dom.js:1472`、`1475`、`1478-1486` 一并清理。
- `script-1e-rest.js:1856 / 1885 / 3062` 的 `if (CHAT_HISTORY_KEY !== submissionScope) throw ...`
  改完后永远不会触发，可保留（无害）也可改成更贴切的校验，但**不要让它误伤正常发送**。

### 5.3 退出登录的新行为

`src/modules/script-1d-dom.js:1419-1451` `logoutMoonYaAccount()` 改为：

1. 照旧调 `user_auth.php?action=logout`，照旧清 `api_token` / `api_token_expires` / `moonya.auth-expired.v1`。
2. `renderAuthState(null, false)`（此时已不再影响 scope）。
3. **不要**重置 `currentChatId` / `currentDbConversationId` —— 当前打开的会话保持可见。
4. 只做 `renderChatList()` 重渲染 + 切到只读态，**不要**清空消息区。
5. 若当前有任务正在运行，不要打断运行中的会话；只禁止「再发新消息」。

### 5.4 一次性数据合并迁移（最关键，也最容易写坏）

新增 `src/history-scope-migration.js`（或作为函数并入 `history-store.js`），要求：

**触发时机**：应用启动、首次打开 `moonya-history` 之后、`initializeChatHistory()` 之前。
不要放在 `renderAuthState` 里（它会随登录态反复调用）。

**做法**：

1. 扫描 `conversations` store 的 `scope` 索引，收集所有匹配 `/^chat_history_\d+$/` 的 scope。
2. 对每个旧 scope，把 `conversations` / `messages` / `events` / `attachments` / `drafts`
   中属于它的记录，**复制**一份到 scope `'chat_history'`（key 的第一段换成 `'chat_history'`）。
3. `drafts` 里的 `__work_projects__` / `__sidebar_layout__` 需要**按内容合并**而不是整条覆盖：
   - 项目数组按 `id` 去重，保留先到的；合并后按 `last_used_at` 重排，`order` 重连续编号。
   - `layout.sections` 按 `id` 去重；`layout.expanded` 做浅合并；`selectedProjectId` 若失效则置 `null`。
4. **冲突策略**：目标 scope 已存在同 `id` 的记录 → 保留目标已有的，跳过（保证幂等）。
5. **迁移标记**：往 `migrations` store 写 `{ key: ['chat_history', '__scope_merge_v1__'], scope: 'chat_history', ... }`，
   存在则整个迁移直接跳过。
6. **不删除**原 scope 的任何数据（当作备份留着）。
7. localStorage 里历史遗留的 `chat_history_<id>` JSON 数组，也要对每个旧 scope 各跑一次
   `history-store.js` 已有的 `migrate(scope)` 逻辑（注意 `migrate` 会 `removeItem` 源 key，
   这是它原有的、已验证过的行为，可以沿用）。
8. 迁移必须**幂等**：手动跑两遍结果一致，不会产生重复会话。
9. 迁移失败不能阻断启动：捕获异常、`console.error`，让应用照常起来（宁可这次不迁移）。

### 5.5 云端会话防串号（G 项）

`syncChatHistoryFromServer()` 落库的服务端会话，加一个 `ownerUserId` 字段。

渲染与打开时：

- `ownerUserId` 存在 && ≠ 当前登录账号 id（含未登录情况）→ 该条目标记为「其他账号的云端会话」，
  置灰、禁止点击打开、禁止继续对话，只显示标题与时间。
- 本地会话（`mode === 'work'` 或 `'legacy'`，`storage === 'local'`）不写 `ownerUserId`，全局可见可用。

> 这一项是为了防止「A 的云端会话出现在 B 账号下，点开必然 403」的假故障。
> 用户的痛点是项目/work 会话（local），云端只做隔离保护，不要反向给 local 会话加账号限制。

### 5.6 只读态实现

统一判定沿用 `isLoggedIn`（`script-1a-vars.js:5`，由 `renderAuthState` 维护）。

**单点拦截建议**（改动小、覆盖全）：

| 位置 | 处理 |
|---|---|
| `script-1e-rest.js:1817` | 已有拦截，文案改成「未登录状态仅支持浏览本地历史，请登录后继续对话」 |
| `script-1c-save.js:1799` `newChatTopBtn` | 未登录时拦截「新建会话」 |
| `work-sidebar.js:74` `request(action, body, scope)` | 未登录时，除只读 action（`list`、`get_texts`）外一律拦截，弹出统一提示 |
| `script-1f-work-project.js:92` | 项目增删改走的就是 `sidebarRequest`，被上一条覆盖即可 |
| 侧边栏右键菜单 / 更多菜单 | 未登录时置灰禁用（删除、重命名、移动、归档、置顶、新建项目、新建分区、拖拽排序） |
| 拖拽排序 | `sidebarRequest 'reorder'` 已被 `work-sidebar.js:74` 覆盖 |

**UI 反馈（必须有，不能只是静默失败）**：

- 输入框 placeholder 在未登录时改为「未登录 · 只读浏览本地历史」。
- 发送按钮在未登录时禁用态。
- 侧边栏登录区：`renderAuthState` 未登录分支的 `userQQ.textContent` 目前是空字符串
  （`script-1d-dom.js:1408`），改成「本地历史只读 · 登录后可继续对话」。
- 拦截时统一 `showToast(...)`，提示「登录后可继续」，并可复用现有 `openAuthModal()`。
- 一切提示走现有 `showToast`，不要用原生 `alert/confirm`。

### 5.7 启动流程调整

`script-1d-dom.js:1337-1371` 的启动 IIFE 里：

- `renderAuthState(offlineUser, !localStorage.getItem('moonya.auth-expired.v1'))` 保留。
- `await initializeChatHistory()` 之前先跑 5.4 的迁移。
- 注意 `if (isLoggedIn) { ... }` 与 `if (!isLoggedIn) { renderChatList(); void checkUserSession(); }`
  两条分支目前都会 `renderChatList()`，改造后未登录也必须有历史可渲染。
- `script-1d-dom.js:1344-1357` 那段「一次性清理堆积的空对话」逻辑要保留，
  但注意它现在会跨账号作用于全局桶，确认不会误删别的账号留下的空会话（空会话本来就无内容，可接受，
  但要在注释里写明）。

---

## 六、构建与自测

**构建**：

```bash
cd MoonYa-Frontend
node build.mjs
```

只改 `src/**`，不要手改 `dist/**`（`asset-manifest.json` 是产物，由构建生成）。

**手动验收清单（逐条执行并回报结果）**：

1. 登录 A 账号 → 建 2 个会话、建 1 个项目并把会话拖进去 → 退出登录。
   → 期望：**侧边栏项目分组与 2 个会话都还在**，能点开看到消息。
2. 未登录状态下：点发送 → 有「请登录」提示，消息不发出去；点「新建会话」 → 被拦截；
   右键会话删除/重命名/移动 → 菜单项置灰。
3. 未登录状态下打开 `DevTools → Application → IndexedDB → moonya-history → conversations`：
   → 期望：原 `chat_history_<A的id>` 记录**依然存在**，同时 `chat_history` 下出现合并后的副本。
4. 登录 B 账号 → **能看到步骤 1 里 A 时期建的本地会话与项目**。
5. 在 B 账号下正常发消息、新建会话、删会话、拖拽排序 → 全部正常。
6. 刷新应用 → 无重复会话、项目不重复、无报错。
7. 再执行一次迁移（清掉 `migrations` 里的 `__scope_merge_v1__` 标记后重启）→ 结果与第一次一致（幂等）。
8. 未登录时刷新页面 → 仍然显示全部本地历史（不是空列表）。

**必须自查的回归风险点**：

- `search-dialog.js:25/111/155` 用 `CHAT_HISTORY_KEY` 做 scope 校验，改造后搜索范围应覆盖全部本地历史。
- `settings-modal.js:260` 用 `CHAT_HISTORY_KEY` 统计归档数，未登录也要能正确统计。
- `membership.js:44/94` 依赖 `isLoggedIn` / `currentUser.id`，只读态不要影响会员面板的账号判断。
- `migration-import.js:46/52/95-96` 里旧的「多账号本地历史导入」流程会与新逻辑语义重叠，
  确认它不会把全局桶又拆回账号桶；两者冲突时以全局单桶为准。
- `history-store.js:315 requireIdle`：任务执行中会拒绝写操作，只读拦截不要绕过它，也不要因此卡死。
- `script-1c-save.js:418 / 527 / 786` 的 `isLoggedIn && isCloudChat(...)` 服务端同步逻辑保持原样。

---

## 七、交付要求

1. 给出**改动文件清单**，每个文件说明改了哪几处、为什么。
2. 迁移逻辑单独成文件并写清幂等保证。
3. 逐条回报第六节的 8 项手动验收结果（做到了/没做到/为什么）。
4. 如果发现任何「不删数据就做不到」的场景，**先停下来问我**，不要自作主张删除已存在的数据。
5. 不要顺手重构无关代码，不要改文案以外的 UI 样式，不要调整缩进风格。

---

## 八、如果你想先快速见效（最小可用版本）

只想先解决「退出登录看不到历史」，可以只做这三步，云端归属（5.5）留到下一轮：

1. **5.1** scope 常量化 + 删掉 `script-1d-dom.js:1396` 那行。
2. **5.3** 退出登录不再重置 scope / 不再清空列表。
3. **5.4** 一次性合并迁移（这步不能省，否则你现有的历史会「真·看不见」）。

只读拦截可以先只做发送与新建会话两处（5.6 的前两行），侧边栏写操作拦截随后补。
