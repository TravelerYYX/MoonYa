<div id="paymentSettingsSection" class="content-section"><div class="payment-page">
<header class="payment-heading"><p>支付宝电脑网站支付 · 仅超级管理员</p><button id="reload" class="btn-secondary" type="button">重新加载</button></header>
<p id="notice" role="status" aria-live="polite"></p>
<section class="card payment-card"><h2>操作安全验证</h2><p id="verificationState">正在检查管理员密码验证状态…</p><p>保存配置、导入旧配置、结清及强制删除订单均仅需当前管理员密码。</p></section>
<form id="configurationForm" autocomplete="off">
<section class="card payment-card"><h2>商户与支付设置</h2><p id="configurationState"></p><div class="payment-grid">
<label>支付开关<select class="form-input" id="enabled"><option value="false">关闭购买</option><option value="true">启用购买</option></select></label>
<label>环境<select class="form-input" id="environment"><option value="production">正式环境</option><option value="sandbox">沙箱环境</option></select></label>
<label>应用 AppID<input class="form-input" id="app_id" inputmode="numeric" maxlength="32"></label>
<label>收款商户 UID<input class="form-input" id="seller_id" inputmode="numeric" maxlength="16"></label>
<label>签名模式<select class="form-input" id="mode"><option value="public_key">RSA2 公钥模式</option><option value="certificate">RSA2 证书模式</option></select></label>
<label>公网 HTTPS 后端根地址<input class="form-input" id="public_url" type="url" maxlength="2048" placeholder="https://example.com"><small>本机沙箱测试可填写映射到本机的临时公网 HTTPS 地址；管理后台仍可通过 localhost 访问。</small></label>
</div><dl class="payment-addresses"><dt>异步通知地址</dt><dd id="notifyUrl">—</dd><dt>付款返回地址</dt><dd id="returnUrl">—</dd></dl></section>
<section class="card payment-card"><h2>密钥与证书</h2><p>支持 PEM 文本粘贴或文件上传，每份不超过 64 KiB。留空保留原材料，清除需勾选。已保存的私钥不会回显或提供下载。</p>
<?php foreach(['private_key'=>'应用私钥','public_key'=>'支付宝公钥','app_cert'=>'应用公钥证书','alipay_cert'=>'支付宝公钥证书','root_cert'=>'支付宝根证书包'] as $field=>$label): ?>
<div class="payment-material" data-material="<?= $field ?>"><div class="payment-material-title"><label for="<?= $field ?>"><?= $label ?></label><span id="<?= $field ?>_state">未配置</span></div>
<textarea class="form-input" id="<?= $field ?>" rows="4" autocomplete="off" spellcheck="false" placeholder="粘贴新的 PEM 材料；留空保留"></textarea>
<div class="payment-material-actions"><label>上传文件 <input type="file" data-file="<?= $field ?>" accept=".pem,.key,.crt,.cer"></label><label><input type="checkbox" id="<?= $field ?>_clear"> 清除已有材料</label></div></div>
<?php endforeach; ?>
<p>证书模式还需服务器登记来自支付宝官方材料的根证书 SHA-256 指纹。</p></section>
<div class="payment-actions"><button class="btn-primary" id="save" type="submit" disabled>输入密码并保存</button><button class="btn-secondary" id="import" type="button" disabled>一次性导入旧 .env 配置</button></div>
</form>
<section class="card payment-card"><h2>更换配置前结清订单</h2><p id="blockingState"></p><p>存在待付款或本地超时订单时，不能更换商户、环境、签名模式或密钥。先关闭购买，再查单结清；关闭购买仍会处理已有付款通知。</p>
<label for="orderNumbers">需要处理的订单号（每行一个，最多 20 个）</label><textarea class="form-input" id="orderNumbers" rows="4" autocomplete="off"></textarea><div class="payment-actions"><a href="dashboard.php?section=membershipOrders">查看会员订单</a><button class="btn-secondary" id="settle" type="button" disabled>验证身份，查单并关闭未付款订单</button><button class="btn-danger" id="forceDelete" type="button" disabled>强制删除未结清订单</button></div><p>强制删除会直接删除数据库中的待付款或已超时订单，解除其对更换支付配置的限制，不会关闭支付宝交易。删除后若实际付款，无法自动补发会员权益，需人工核对处理。最多 20 笔，任一订单不符合条件时整批不删除；保留删除审计。</p><pre id="settleResults"></pre></section>
<dialog id="verification"><form id="verifyForm" autocomplete="off"><h2>确认操作并验证身份</h2><pre id="operationSummary"></pre><p id="verificationHint"></p>
<div id="passwordStep"><label for="verifyPassword">当前管理员密码</label><input class="form-input" id="verifyPassword" type="password" autocomplete="off" maxlength="1024" required></div>
<p id="verifyError" role="alert"></p><div class="payment-actions"><button id="cancelVerification" class="btn-secondary" type="button">取消</button><button class="btn-primary" id="confirmVerification" type="submit">确认并执行操作</button></div></form></dialog>

</div></div>
