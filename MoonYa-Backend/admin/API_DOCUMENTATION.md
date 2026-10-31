# 用户管理系统 API 文档

## 技能管理

管理员接口为 `admin/api/skills.php`，使用管理员 Bearer 令牌；响应沿用 `{success,data}` / `{success:false,error}`。

| 方法 | 操作 | 参数 | 返回 data |
| --- | --- | --- | --- |
| GET | `list` | `action=list` | `skills`（包含禁用技能及 `can_edit_info,can_delete`） |
| GET | `detail` | `name` | `skill`（含显示名称、用途说明、主提示词） |
| GET | `browse` | `name,path`，path 为技能内相对目录，可为空 | `directory` |
| GET | `read` | `name,path`，默认 `SKILL.md` | `file` |
| POST JSON | `create` | `action,name,display_name,description,body` | `skill` |
| POST JSON | `update_info` | `action,name,display_name,description,body` | `skill` |
| POST JSON | `delete` | `action,name` | `deleted_name` |
| POST JSON | `mkdir` | `action,name,path`，父目录须已存在 | `directory` |
| POST multipart | `upload` | `action=upload,name,path,files[]`；可传 `file_count` 检测 PHP 文件数截断 | `directory` |
| POST JSON | `upload_tree` | `action,mode,name,path,directories,files`；格式见下方 | `directory` 或 `skills`，以及 `uploaded_count,directory_count,skipped` |
| POST JSON | `save` | `action,name,path,raw` | `skill` |

技能标识为 1–63 位小写字母、数字或连字符，不能使用内置技能、旧别名、原生插件或系统保留名称。
创建时自动生成带 name、description、display_name 的 `SKILL.md`，用途说明为单行，正文不能为空。
上传仅接受非空 UTF-8 `.md` 文件，单文件上限 1 MiB、单次总量上限 10 MiB；整批校验后写入，失败回滚已写入文件。
`update_info` 仅编辑自定义技能的显示名称、单行用途说明和主提示词，技能标识固定，保留其他 frontmatter、metadata（包括 enabled）与子文件。显示名称留空时使用技能标识。
`delete` 永久删除自定义技能及全部子文件；管理页面先显示确认弹窗。内置技能和旧别名不允许编辑信息或删除（403）；技能不存在返回 404；无效参数返回 400；文件操作失败返回 500。删除前检查整个目录树，存在符号链接或越界路径时拒绝操作。
禁止越界相对路径、绝对路径和符号链接。创建、目录与上传遇到重名返回 400，不覆盖；已有文件通过 save 编辑。
电脑技能主文件继续由 `original.sha256` 保护，兼容说明在 references 中编辑。

### 文件夹上传

管理页面支持拖入文件/文件夹以及选择文件夹，显示扫描、检查、实际上传百分比和服务器处理状态；只有服务器成功响应后才显示完成。跳过的文件在可展开清单中显示相对路径及原因。

`upload_tree` 使用一个 JSON 请求携带目录清单和 Markdown 文本，避免 multipart 的 `max_file_uploads` 限制造成大量文件截断。JSON 请求体上限 64 MiB（包含编码开销），有效 Markdown 内容仍受单文件 1 MiB、总量 10 MiB 限制；部署代理也需允许相应请求体大小。

```json
{
  "action": "upload_tree",
  "mode": "resources",
  "name": "writing-helper",
  "path": "references",
  "directories": ["资料", "资料/详细", "资料/空目录"],
  "files": [{"path": "资料/详细/guide.md", "raw": "# 提示词正文"}]
}
```

- `resources`（默认）：写入 `name` 技能内的 `path` 目录，保留传入的外层文件夹和子目录；清单中的空目录也会创建。拖拽能够枚举空目录，传统文件夹选择器只能传递文件及其父目录。
- `import`：不需要 `name,path`。传入一个或多个完整技能文件夹，例如 `files[].path` 为 `本地文件夹/SKILL.md` 和 `本地文件夹/references/guide.md`；每个外层文件夹根部必须有合法 `SKILL.md`，以其中 `name` 作为安装标识，安装后去掉本地外层文件夹名。保留子目录、资源和空目录；所有技能先校验并暂存，再发布，任一重名或校验失败不导入部分技能。
- `.md` 扩展名不区分大小写。其他扩展名在 `upload_tree` 中跳过，并返回 `skipped: [{path,reason}]`；页面在发送前也会过滤并提示不能读取为非空 UTF-8 文本的文件。原 multipart `upload` 接口保留严格校验行为。
- 所有路径先经过安全校验，即使文件格式会被跳过，也不允许越界路径。已有目录可以合并，已有文件不覆盖，大小写冲突拒绝；校验失败不留下部分文件或新目录。
- 上传日志分别为 `upload_skill_tree` / `import_skills`，信息编辑和删除日志为 `update_skill_info` / `delete_skill`。运行时响应结构和每轮同步机制不变，下一次成功同步后获取更新内容并移除已删除技能。

普通登录用户通过 `GET api/skills.php`（用户 Bearer 令牌或登录会话）获取只读执行目录：
`{success:true,data:{version:1,skills:[{name,display_name,description,enabled,body,resources}]}}`。
resources 是“技能内 Markdown 相对路径 → 正文”的对象；仅返回启用技能，不包含服务器路径或原始 frontmatter。
未登录返回 401，非 GET 返回 405，技能目录不可用返回 503。
客户端公开配置中的 skills 仍只提供摘要。

桌面 UI 使用本地 `GET /gateway/local/api/skills.php` 获取摘要和 source/synced_at 状态；
Runtime 通过原生受保护的 `/gateway/model/{userId}/skills` 获取服务器正文，用户令牌不会进入模型请求。
每轮任务前刷新，当前轮固定快照；`read_skill` 的主文件结果增加 `resource_paths`，资源按需读取。

## 用户积分管理

用户管理列表提供独立“积分管理”入口，仅正常用户可查看和调整。查询需要 `view_users` 权限，修改需要 `edit_users` 权限，均使用管理员 Bearer 令牌。

| 方法 | URL | 请求 | 返回 data |
| --- | --- | --- | --- |
| GET | `/admin/api/users.php?action=membership&user_id=2&page=1` | 用户 ID、页码均为正整数，page 默认 1 | `account,ledger,plans`；流水每页 20 条 |
| POST / PUT | `/admin/api/users.php?action=adjust_credits&user_id=2` | JSON `{ "delta": "-0.5", "reason": "人工扣除" }` | `account`，包含最新余额 |

`delta` 正数为增加、负数为扣除，推荐传十进制字符串以保留精度；必须非零，最多 9 位整数、6 位小数。调整后余额必须在 `0–999999999` 范围内。`reason` 必须是文本，去除首尾空白后为 1–500 字。修改余额和积分流水处于同一事务，流水包含管理员 ID、原因、调整数量及操作后余额，同时记录管理员操作日志。

积分调整沿用当前周期，不改变套餐、月度额度或重置时间。错误 JSON／参数／不可用用户返回 400，未登录 401，无权限 403，不存在的用户 404，不支持的方法 405。独立弹窗提交成功后保持打开，刷新余额、第一页流水和原筛选、页码的用户列表；失败保留输入，不自动重试。

隔离验证：`node --test MoonYa-Backend/tests/admin_credits_test.js`（从项目根目录运行，需要本地 MySQL、PHP、Chrome 和 tests 中的 playwright-core；测试库自动清理）。

## 基础信息

- **基础URL**: `/admin/api/users.php`
- **数据格式**: JSON
- **字符编码**: UTF-8

## 认证说明

所有接口（除登录接口外）都需要在请求头中携带认证令牌：

```
Authorization: Bearer {token}
```

## 接口列表

### 1. 管理员登录

**接口**: `POST /login`

**请求参数**:
```json
{
  "username": "admin",
  "password": "Admin@123"
}
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
    "admin": {
      "id": 1,
      "username": "admin",
      "email": "admin@example.com",
      "role": "super_admin"
    }
  }
}
```

---

### 2. 查询用户列表

**接口**: `GET /`

**查询参数**:
- `page`: 页码（默认1）
- `limit`: 每页数量（默认20，最大100）
- `id`: 用户ID（精确查询）
- `username`: 用户名（模糊查询）
- `email`: 邮箱（模糊查询）
- `status`: 状态（active/banned/deleted）

**响应示例**:
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": 1,
        "username": "user1",
        "email": "user1@example.com",
        "status": "active",
        "ban_reason": null,
        "ban_until": null,
        "created_at": "2024-01-01 00:00:00",
        "updated_at": "2024-01-01 00:00:00"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "pages": 5
    }
  }
}
```

---

### 3. 获取单个用户信息

**接口**: `GET /{userId}`

**响应示例**:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "username": "user1",
    "email": "user1@example.com",
    "status": "active",
    "ban_reason": null,
    "ban_until": null,
    "created_at": "2024-01-01 00:00:00",
    "updated_at": "2024-01-01 00:00:00"
  }
}
```

---

### 4. 修改用户名

**接口**: `PUT /{userId}/username`

**请求参数**:
```json
{
  "username": "new_username"
}
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "用户名更新成功"
  }
}
```

---

### 5. 修改密码

**接口**: `PUT /{userId}/password`

**请求参数**:
```json
{
  "password": "NewPass@123"
}
```

**密码要求**:
- 至少8位
- 包含大写字母
- 包含小写字母
- 包含数字
- 包含特殊符号

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "密码更新成功"
  }
}
```

---

### 6. 修改邮箱

**接口**: `PUT /{userId}/email`

**请求参数**:
```json
{
  "email": "new_email@example.com"
}
```

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "邮箱更新成功"
  }
}
```

---

### 7. 封禁用户

**接口**: `PUT /{userId}/ban`

**请求参数**:
```json
{
  "reason": "违规操作",
  "duration_hours": 24
}
```

**参数说明**:
- `reason`: 封禁原因（可选）
- `duration_hours`: 封禁时长（小时，可选，不填则永久封禁）

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "用户已封禁"
  }
}
```

---

### 8. 解禁用户

**接口**: `PUT /{userId}/unban`

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "用户已解禁"
  }
}
```

---

### 9. 删除用户

**接口**: `DELETE /{userId}`

**权限要求**: 仅超级管理员

**响应示例**:
```json
{
  "success": true,
  "data": {
    "message": "用户已删除"
  }
}
```

---

## 错误响应

所有错误响应格式统一：

```json
{
  "success": false,
  "error": "错误信息描述"
}
```

**常见HTTP状态码**:
- `400`: 请求参数错误
- `401`: 未授权（未登录或token无效）
- `403`: 权限不足
- `404`: 资源不存在
- `405`: 不支持的请求方法
- `500`: 服务器内部错误

---

## 初始化系统

首次使用前需要运行初始化脚本：

```bash
php admin/init.php
```

初始化会：
1. 创建数据库表
2. 创建默认管理员账号（用户名：admin，密码：Admin@123）

**注意**: 请务必在首次登录后修改默认密码！


## 支付安全配置

支付配置接口 `api/payment_settings.php` 仅允许 HTTPS 同源访问和超级管理员身份，所有操作均只验证当前管理员密码，不要求邮箱、SMTP 或验证码。保存配置通过 `save_password` 提交密码和含修订号的配置。导入、结清及强制删除订单先通过 `challenge` 获取一次性操作快照，再通过 `confirm` 提交 `{challenge_id, password}`，验证通过后执行该快照；`send_code` 已停用。批量强制删除传 `{operation: "force_delete", order_numbers: [...]}`，最多 20 笔，仅删除无付款或权益记录的待付款／已超时订单，整批事务处理并保留审计，不关闭支付宝交易。接口、部署和密钥恢复详见 [支付安全说明](../docs/PAYMENT_SECURITY.zh.md)。
# 程序更新

`GET api/updates.php?action=latest` 公开返回 `{success:true,data:null|release}`。
Release 包含 `id/version/notes/file_name/size/sha256/status/published_at/download_url`。
`GET/HEAD api/updates.php?action=download&id=ID` 下载已发布安装包，支持 Range、If-Range、ETag 和 200/206/416。

下列接口要求现有管理员 `Authorization: Bearer TOKEN`：

- `GET api/updates.php?action=list`：版本列表和服务端 `chunk_bytes/max_bytes`。
- `POST ...?action=begin`：JSON `version/notes/file_name/file_size`，返回上传标识和分块大小。
- `POST ...?action=chunk&upload_id=ID&offset=BYTES`：原始二进制请求体；相同内容分块重试幂等。
- `POST ...?action=complete`：JSON `upload_id`；确认完整长度、EXE 格式及 SHA256 后生成待发布版本。
- `POST ...?action=publish`：JSON `id`；重新校验安装包后发布，版本号和文件不可替换。
- `POST ...?action=delete`：JSON `ids`（数组，兼容单条 `id`）；删除历史版本（草稿与已发布均可，含当前最新的已发布版本），同时清理服务端安装包。单次最多 100 个，返回 `{deleted:[...], failed:[...]}`，批量删除部分失败不中断；单条删除不存在的版本返回 400。审计动作 `program_update_delete`。

部署和构建说明见 `docs/PROGRAM_UPDATES.zh.md`；已有数据库运行 `tools/migrate_program_updates.php`。
