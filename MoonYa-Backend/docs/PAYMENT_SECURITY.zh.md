# 支付配置与数据库键环部署

支付配置入口为后台右侧「支付配置」，地址 `admin/dashboard.php?section=paymentSettings`。旧地址自动跳转。仅超级管理员可读写，私钥不回显、不提供导出接口。

## 更新已有服务器

1. 先备份当前线上数据库及原主密钥文件。
2. 上传新代码，保留服务器自己的 `.env`、上传目录及业务数据。不要用本地 `.env` 覆盖服务器设置。
3. 向当前线上库导入 `sql/payment_keyring_upgrade.sql`，或执行 `php sql/migrate_payment_security.php`。升级可重复执行，保留配置、订单和用户。
4. 首次转换时，让服务器 `.env` 中 `PAYMENT_MASTER_KEY_FILE` 指向原主密钥文件，PHP 必须能读取该文件。无需站点外路径、0700/0600 或 Windows ACL 检查。
5. 执行 `php sql/payment_security_cli.php migrate-key`，或打开支付配置页自动完成首次转换。所有现存加密记录验证通过后才事务性保存完整键环，包含历史密钥及根证书信任指纹。
6. 转换成功后，删除 `.env` 中的 `PAYMENT_MASTER_KEY_FILE` 设置。后续更新及数据库恢复不依赖该文件；原文件可按自己的备份策略保留。

原文件缺失或与旧密文不匹配时不能恢复旧配置；系统会提示具体原因并保留数据，不自动清空。可以执行 `php 检测脚本/payment_security_check.php` 只读检查；`php 检测脚本/payment_deploy_fix.php --apply` 执行升级和转换，不支持破坏性重置参数。

## 新安装和数据库恢复

完整数据库文件 `backups/db/ai_system_mysql57_2026-10-04.sql` 包含当前本地全部业务数据与数据库键环，用于新建空数据库导入。已有线上库应使用增量升级，不用完整文件覆盖线上用户和订单。

使用服务器自身数据库连接配置、独立 JWT 密钥和 HTTPS 设置。完整导出不包含 `.env`；恢复后检查后台根地址、商户及支付开关是否符合服务器用途。

没有旧密文的新安装会自动生成 32 字节随机支付加密密钥，独立于 JWT 密钥。支付数据继续采用 AES-256-GCM 加密。键环与密文均保存在数据库，因此数据库备份包含解密能力；数据库泄露者可能解密支付材料，这是本次取消独立文件依赖所采用的存储方式。

## 身份确认

- 保存、启停购买、清除密钥、一次性导入旧 `.env` 配置、查单、结清及强制删除订单：均只需当前管理员密码，不要求邮箱、SMTP 或验证码。每次提交重新验证数据库中的当前超级管理员账户。
- 导入、结清及强制删除订单使用 2 分钟内有效的一次性操作快照，绑定管理员、当前密码和配置修订号；确认时只接受快照 ID 与密码，不能替换操作内容。
- 身份验证失败按账户及实际来源地址限流：15 分钟内失败 5 次后限制 15 分钟。
- 保存请求绑定配置修订号，旧修订号返回 409。保留未结清订单阻止更换商户、环境和密钥的限制。关闭购买仍处理已有付款回调。
- 密码及支付私钥不存浏览器持久化存储，不进入审计。切换页面清除未提交的私钥与密码。

## 强制删除未结清订单

支付配置页可按订单号批量强制删除，每次最多 20 笔。订单存在后端 MySQL 的 `membership_orders` 表中，强制删除直接移除数据库订单，同时释放待付款占用及更换支付配置的限制。只允许待付款或已超时、无付款确认和会员权益／积分转移记录的订单；已付款和已关闭订单不能删除。

确认前展示操作和订单号，输入当前超级管理员密码后执行。执行时重新检查所有订单，任一订单不符合条件则整批不删除。删除与审计在同一数据库事务内完成，审计保留订单号、用户、金额、商户、环境及原状态。不会调用支付宝查单或关单；删除后若实际付款，系统无法自动补发会员权益，需要人工核对处理。

## 密钥维护和证书模式

以下 CLI 命令直接维护数据库键环，不再读写主密钥文件：

```sh
php sql/payment_security_cli.php init-key
php sql/payment_security_cli.php migrate-key
php sql/payment_security_cli.php rotate-key
php sql/payment_security_cli.php trust-root production <官方根证书SHA256指纹>
php sql/payment_security_cli.php trust-root sandbox <官方根证书SHA256指纹>
```

`init-key`/`migrate-key` 为幂等初始化，已有配置不会换键。轮换在同一事务中更新配置、历史 MFA、挑战密文和键环；失败整体回滚，历史密钥仍保留。证书模式继续要求有效证书链、私钥匹配和官方根证书信任登记。

## API

- `GET admin/api/payment_settings.php?action=state`：公开配置状态和管理员密码验证状态，不返回支付材料或键环。
- `POST ?action=save_password`：JSON `{password, configuration}`，配置包含整数 `revision`；材料留空保留、`clear` 指定清除。成功返回新公开配置状态。
- `POST ?action=challenge`：接受 `import`、`settle` 或 `force_delete` 操作，冻结待验证快照；后两者传入 `order_numbers` 字符串列表，1 至 20 项，重复订单号只处理一次。
- `POST ?action=confirm`：仅 `{challenge_id, password}`，验证当前管理员密码后执行冻结的操作。强制删除成功返回 `results: [{order_no, status: "deleted"}]` 与消息。`send_code` 接口已停用，旧邮件验证码挑战不能用于确认操作。
- 继续要求管理员 Bearer 登录、超级管理员、同源与 HTTPS 校验；本机 HTTP 仅按原开发开关允许。

## 验证结果（2026-10-04）

完整导出已实际导入独立 MySQL 5.7.44，27 张表逐行数据一致（新增一张键环表）。关闭主密钥文件设置后可读取支付配置；在隔离库中无需邮箱及 SMTP 的密码保存成功，重复执行升级保留配置。
