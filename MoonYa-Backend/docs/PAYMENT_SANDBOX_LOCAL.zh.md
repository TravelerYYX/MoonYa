# 本机支付宝沙箱完整验收

代码和数据库均留在本机。临时 HTTPS 隧道只提供支付宝收银台、异步通知及返回页，管理后台继续使用 `http://localhost/admin/payment_settings.php`。本机 HTTP 开关不改变支付宝网关 TLS 校验、RSA2 验签、金额核对或权益幂等规则。

## 准备与启动

1. 在支付宝沙箱控制台准备沙箱 AppID、沙箱收款商户 UID、应用私钥和沙箱支付宝公钥（或完整证书材料）。不要混用正式环境账户、密钥或公钥。沙箱买家账户用于付款，不能将收款商户作为买家。沙箱材料获取与 RSA2 配置参考[支付宝说明](https://github.com/AlipayDocs/open-docs/blob/main/support/支付宝小程序/常用工具/沙箱环境中如何联调小程序.md)。
2. 保持本机 Apache、MySQL 运行；支付安全迁移、数据库键环需已就绪；保存、导入和结清订单使用当前超级管理员密码确认，无需邮箱或 SMTP。
3. 安装 Cloudflare 官方 Windows `cloudflared`。辅助脚本默认位置为 `%LOCALAPPDATA%\MoonYaTools\cloudflared-2026.9.3.exe`；其他位置通过 `-Cloudflared` 指定。官方[下载入口](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)与[临时隧道说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。隧道只用于开发，地址会变化，不作为部署地址。
4. 从仓库根目录运行（若当前目录不是仓库根，改用脚本绝对路径，如 `-File <仓库根>\tools\start_payment_sandbox.ps1`；脚本按自身位置定位其余文件，与当前目录无关）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start_payment_sandbox.ps1
```

脚本启动仅绑定 `127.0.0.1:19091` 的独立 PHP 入口，再建立临时公网 HTTPS 地址。端口被占用时通过 `-Port 其他端口` 指定。脚本不输出请求日志或支付链接凭据，按 Ctrl+C 停止两个进程，也可执行 `powershell -NoProfile -File tools\stop_payment_sandbox.ps1`（自定义端口需传同一个 `-Port`）。进程状态记录在 `%LOCALAPPDATA%\MoonYaTools\payment-sandbox-端口.json`，停止时核对进程创建时间，避免误停复用 PID 的其他进程。不要将整个 Apache 站点或源码根目录直接映射到公网。

5. 将打印的 `https://某名称.trycloudflare.com` **根地址**填写到本机支付后台的“公网 HTTPS 后端根地址”，不添加 `/api/alipay.php`。环境选“沙箱”，填入材料，先保持关闭购买；通过管理员密码保存，再按同样流程启用购买。证书模式仍需通过服务器命令登记官方沙箱根指纹。
6. 入口只允许 `/api/alipay.php?action=checkout/notify/return` 对应方法，其他路径返回 404。未配置为沙箱或加密配置不可用时返回 503。后台、环境文件、会员 API、SQL 及密钥没有公网入口。只有沙箱配置保存后，返回页探测才会成功。

支付宝异步通知必须能访问公网地址，直接填写 `localhost` 或局域网 IP 无法接收通知，见[支付宝回调排查](https://help.alipay.com/support/help_detail.htm?help_id=430554)。若临时隧道域名无法访问，应使用能够正常连通的 HTTPS 隧道，并将其转发到这个专用回环端口。

## 完整流程验收

桌面客户端或本机会员页面必须使用本机后端，而不是已部署站点。登录测试用户后进行以下验收，不使用管理员令牌代替用户身份：

桌面 `launcher_config.json` 的 `backend_url` 应为 `http://localhost/`。也可仅在启动测试进程时设置 `MOONYA_BACKEND_URL=http://localhost/`，重启客户端后生效；不要将后端地址设为只开放支付路径的临时隧道地址。若已有登录令牌属于另一后端，需重新登录本机测试用户。

- 购买套餐：创建订单、打开官方沙箱收银台、使用沙箱买家完成付款。
- 回调：支付宝 POST 到本机通知入口，验签及订单／金额核对成功后才返回 `success`；订单变为 `paid`，会员或队列及积分账本按现有规则发放。
- 返回页：验签及订单信息核对后主动查单；已确认付款时显示“付款成功”并自动唤起 MoonYa，未确认时显示等待界面并自动重查。返回参数本身不会开通权益；付款确认仍使用支付宝查单响应或异步通知。
- 幂等：再次查询订单，权益及账本不能重复发放。
- 补查：另外一笔订单付款时短暂停止隧道，恢复后在会员页“我已支付，查询结果”或后台主动查单，验证成功付款补确认且不重复发放。
- 关单：另外一笔未付款订单，通过支付配置页验证身份后查单关单，核实已关闭；结果不确定时继续阻塞更换配置。
- 会员规则：根据测试用户当前套餐，确认升级、续费及排队行为与实际订单和积分记录一致。

隧道地址变化前应关闭购买并处理未结清订单。临时隧道无法承诺稳定回调；未确认订单仍保留，需要恢复对应配置后补查。

模拟测试、入口可达及收银台打开，都不能代替实际完成沙箱付款、真实回调和权益核对。将结果记录为沙箱验收；不宣称正式收款已验证。

## 上线

关闭购买并结清本机测试订单，再停止隧道。本机测试配置与密钥不随部署包上传。服务器初始化数据库键环，配置正式商户材料和稳定公网 HTTPS 地址、SMTP 与管理员邮箱，保持本机 HTTP 开关为 false。正式环境仍需重新完成真实小额付款、通知和补查验收。
