# 会员与积分制度部署

会员基础制度现支持支付宝电脑网站支付扩展。配置未完成时购买按钮仍显示“暂未开放购买”；管理员仍可开通、切换、续期或恢复免费版。支付迁移、配置、排队续费及升级规则见 [支付宝部署说明](ALIPAY_DEPLOYMENT.zh.md)。套餐介绍仅用于展示。

## 部署顺序

1. 备份数据库及当前服务文件，暂停新的 Chat / Harness 请求，等待正在进行的模型调用结束。
2. 部署后端代码，确保 PHP 8.1+、64 位整数、PDO MySQL、cURL 可用，数据库支持 InnoDB 和 JSON。沿用后端 `.env` 的数据库及 `DEEPSEEK_API_KEY`、DeepSeek 服务地址配置。
3. 在服务器 `MoonYa-Backend` 目录执行 `php sql/migrate_membership.php`。迁移创建六张表、初始化套餐和模型，并给没有积分账户的既有用户建立免费周期。重复运行不会重新发放积分或覆盖已经编辑、停止、归档的套餐和模型。迁移会删除 `users.vip_level`、`users.vip_expire` 和 `vip_codes`，旧会员信息不映射到新制度。
4. 登录管理后台，检查“会员套餐”“内置模型”以及用户管理的“会员／积分”。初始模型名称是 DeepSeek 4.1 Flash，目录和调用标识为 `deepseek-flash`，倍率为 0.15x。验证密钥、地址和能力设置。
5. 在 `MoonYa-Frontend` 执行 `npm run build`，发布生成的 `dist`；更新 Harness 源码／运行时包和 Windows 桌面客户端。桌面网关需要新会员接口和模型目录／余额代理路由，不能只更新前端。
6. 重启服务和客户端，恢复请求。验证真实调用后出现积分流水、账户余额刷新、选择新增模型后实际调用对应供应商标识。

新安装使用更新后的 SQL 结构导入后，也要执行迁移脚本初始化目录。迁移已经在隔离测试库验证；部署到其他环境时仍须对目标数据库执行迁移。不要用带历史业务数据的 `数据库.sql` 覆盖现有数据库。

2026-10-02 已修复本机 `localhost:3306/ai_system` 缺少会员表的问题：先完整备份，再执行迁移。12 个既有用户均初始化为免费版 100 积分，五档套餐及 DeepSeek 4.1 Flash 的 0.15x 倍率已创建；重复迁移的数据指纹一致，未重复发放或覆盖配置。备份位于工作区 `artifacts/database-backups/ai_system-before-membership-20261002-154405.sql`（包含业务数据，仅保留在本机，不提交或发布）。

## 管理后台

- 套餐：可编辑名称、人民币月价格、月积分、简介、排序、分组标题及逐行介绍。价格存为人民币分。停止后不能新开通，已有会员继续使用开通时的快照。删除保留归档及账本；免费回退套餐不能停止或删除，额度可编辑并在下次重置生效。
- 用户：正常用户操作栏新增独立“积分管理”入口，可查看余额、下次重置和分页流水，选择增加／扣除并填写正数数量及原因；提交后保持弹窗打开并刷新余额、流水和用户列表。最多 6 位小数，数量非零，原因去除首尾空白后为 1–500 字，调整后余额范围为 0–999999999。手动调整沿用当前周期，无需新增迁移。原“会员与积分”入口保留：选套餐并开通／切档／续期会立即重置积分并开始新周期；不填到期时间默认一个月，填写时间使用北京时间。选择免费版即恢复免费周期。
- 模型：目录标识供客户端选择；供应商模型 ID 用于真实请求。服务地址填完整的 OpenAI 兼容 Chat Completions URL。设置密钥、倍率、上下文、输出上限、图片／工具／思考能力及思考参数格式，支持排序、默认模型和启停。编辑时密钥留空保留原值，接口只返回是否已配置密钥。没有启用模型时客户端显示不可用状态。
- 操作使用现有管理后台鉴权和 `edit_users` 权限，写入管理员操作日志；开通和积分调整还写入积分账本。

## 计费与周期

积分与倍率存为百万分之一的整数。每次上游调用保存当时倍率及周期，按 `(输入 Token + 输出 Token) / 1000 × 倍率` 结算，最小扣分精度为 0.000001 积分（向上取整）。缓存输入及思考用量不会再额外加到总 Token 中。1000 Token × 0.15x = 0.15 积分。没有有效的输入／输出真实用量时不扣分，记 `usage_missing` 异常流水。子代理、压缩及权限审核等辅助调用也独立结算；用户自定义密钥模型不扣平台积分。

周年日按 Asia/Shanghai 计算，月底取目标月最后一天。积分每月重置、不结转；离线多月只建立当前周期。会员到期以到期时间开始免费周期。跨月、切档时仍在执行的调用只结算原周期。单次最多扣至零，差额在流水中记为免除额度，不形成欠款。

流式代理先发送 `credits_update`，再发送结束标记。余额耗尽时当前模型输出和已经开始的操作保留，任务及子任务停止新的模型／工具操作；Harness 持久化 `turn.quota_stopped`，客户端显示可打开套餐页的使用上限提示。重连通过已有任务事件重放，不重新调用模型或扣费。

## 接口与验证

- 用户 `GET api/membership.php`：本人账户与套餐目录；`?action=ledger&page=1`：每页 20 条流水。
- 公共 `GET api/client_config.php`：启用模型、默认模型、能力及真实倍率；不包含余额、上游地址和密钥。
- 管理员 `admin/api/membership_plans.php`、`admin/api/builtin_models.php`：GET 查询，POST／PUT 保存，DELETE 归档。
- 管理员 `admin/api/users.php?action=membership&user_id=…`：账户与流水；POST／PUT 的 `set_membership`、`adjust_credits` 操作分别接收套餐／到期时间、积分变化／原因。

验证命令：

```text
php MoonYa-Backend/tests/membership_test.php
php MoonYa-Backend/tests/membership_schema_test.php
php MoonYa-Backend/tests/client_config_test.php
php MoonYa-Backend/tests/model_context_limit_test.php
cd MoonYa-Harness
npm test
cd ../MoonYa-Frontend
npm test
```

MySQL 计费与代理测试只允许本地数据库，使用随机命名的隔离测试库并在结束时删除。PHP 可执行文件可通过 `PHP_BIN` 指定。前端浏览器测试使用已安装 Chrome 和桌面网关 smoke 工程。

开发验证结果（2026-10-02）：前端 73 项回归通过，另补充验证了 Chat 和 Harness 在没有生成正文时的耗尽提示（共 75 项）；Harness 149 项通过、1 项既有测试跳过；PHP 计费及两份 SQL 导入／迁移测试通过。真实本地 HTTP 测试覆盖后台套餐与模型编辑、密钥脱敏、管理员操作日志、新模型在 PHP Chat 和 Harness 代理中的调用映射、倍率更新、分片用量、无用量和耗尽后的流式顺序。最后的 PHP 统计收尾调整另经 8 项代理／统计测试验证。子代理耗尽和并行操作收尾测试验证了文件与结果保留、终止状态持久化及重放。桌面网关 smoke 构建通过，0 警告、0 错误。

并行执行前端构建和运行时打包检查会竞争同一个 `dist` 目录，因此发布验证应先完成前端构建，再执行 Harness 打包检查；本次最后的验证使用有限测试并发。界面截图位于 `MoonYa-Frontend/artifacts/membership/`，测试日志位于其中的 `verification/` 子目录（`harness-membership-final.log`、`frontend-membership-serial.log`、`membership-ui-final.log`、`membership-php-final.log` 是最后的通过记录，其他日志保留早期诊断过程）。
