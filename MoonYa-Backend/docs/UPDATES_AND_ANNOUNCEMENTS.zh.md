# 强制更新与图文公告

## 部署顺序

1. 备份数据库，部署本次后端文件。
2. 在 `MoonYa-Backend` 目录使用服务器 PHP CLI 执行：

   ```powershell
   php tools/migrate_program_updates.php
   php tools/migrate_announcements.php
   ```

   两个脚本均可重复执行。已有版本的 `force_update` 默认是关闭，不修改现有安装包。
3. 构建前端和 Windows 客户端，发布支持本功能的安装包。旧客户端需要先升级一次，之后才会执行强制拦截和公告提醒。

本次代码修改不自动连接或迁移线上数据库，也不自动发布安装包。

## 后台操作

- “更新程序”上传区及版本列表都有强制更新开关。最低要求版本是所有已发布强制版本中的最高版本，用户直接安装最新版本。关闭开关或删除强制版本后，客户端下次成功检查重新计算要求。
- “公告管理”支持新增、编辑、预览、发布、撤下及删除。文字和图片是有序块，可拖动手柄或使用上移、下移；图片支持10%至100%宽度和左、中、右对齐。
- 保存草稿不会修改公开内容；发布复制当前草稿并增加修订号，触发设备再次提醒。列表“发布草稿”发布已保存内容，“保存并发布”发布编辑器当前内容。
- 删除公告保留上传图片，因为同一图片可能被其他后台内容使用。

## 接口和客户端行为

- 更新接口沿用 `admin/api/updates.php`，版本新增 `force_update`（布尔）和 `minimum_required_version`（字符串或 null）；管理员通过 POST `action=set_force` 提交 `{id, force_update}`。
- 公告管理员 GET `action=list`，POST `action=save|publish|withdraw|delete`，地址为 `admin/api/announcements.php`。保存字段为 `{id?, title, blocks}`；其他操作提交 `{id}`，沿用 Bearer 管理员身份和审计日志。
- 公开 GET `action=feed` 只返回已发布快照，按首次发布时间、ID升序。文字块为 `{type:"text", text}`；图片块为 `{type:"image", url, width, align}`，只接受后台上传的有效图片。
- 原生网关 GET `/gateway/announcements/feed` 返回公告及设备已读映射；POST `/gateway/announcements/read` 接受 `{id, revision}`。两者要求本机网关令牌和合法来源，不要求用户登录。
- 已读记录位于用户 `.MoonYa/announcements/`，以规范化后端地址的 SHA-256 分文件保存，修订号单调递增。客户端启动和每5分钟检查公告；关闭、Escape和“我知道了”均确认当前修订。写入失败可重试。
- 更新在启动和每30分钟检查。强制状态保存在现有下载清单中，断网不清除；成功查询无发布版本时清除。强制弹窗优先于公告，支付弹窗打开时公告等待。
- 新用户轮次在前端和原生网关被拦截，已接受轮次的续订、审批、事件流与工具调用继续。仅下载校验完成后可安装，安装失败保留拦截。

## 验证

```powershell
node MoonYa-Frontend/build.mjs
dotnet build MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/MoonYa.FrontendSmoke.csproj -v:quiet
dotnet MoonYa-Win/MoonYa-Solution/MoonYa.FrontendSmoke/bin/Debug/net8.0-windows/MoonYa.FrontendSmoke.dll --updates-smoke
node --test MoonYa-Frontend/tests/announcements-http.test.mjs MoonYa-Frontend/tests/system-dialog.test.mjs MoonYa-Frontend/tests/program-updates-http.test.mjs MoonYa-Frontend/tests/program-updates-ui.test.mjs MoonYa-Frontend/tests/payment.test.mjs MoonYa-Frontend/tests/membership.test.mjs
```

从仓库根目录执行。测试使用临时 SQLite、PHP HTTP服务及浏览器，覆盖发布隔离、上传图片、拖动排序、设备已读、跨版本强制要求、同版本刷新、断网恢复、任务续订及支付回归。
