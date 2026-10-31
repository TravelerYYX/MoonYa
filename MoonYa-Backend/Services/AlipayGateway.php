<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentConfiguration.php';
require_once __DIR__.'/PaymentAlipayKernel.php';

interface PaymentGateway {
    public function configuration(): array;
    public function readiness(): array;
    public function checkout(array $order): string;
    public function verifyNotification(array $parameters): bool;
    public function query(array $order): ?array;
    public function close(array $order): bool;
}

final class AlipayGateway implements PaymentGateway {
    private array $config;
    public function __construct(?array $config=null,private ?PaymentConfiguration $store=null,private ?string $requiredEnvironment=null) {
        if ($requiredEnvironment!==null && !in_array($requiredEnvironment,['production','sandbox'],true)) throw new InvalidArgumentException('支付环境限制无效');
        // No environment fallback and no runtime plaintext file adapter.
        $this->config=$config??($store?$store->runtime():PaymentConfiguration::defaults()+['_error'=>'encrypted_configuration_unavailable']);
        foreach (PaymentMaterials::FIELDS as $field) $this->config[$field]??='';
    }
    public static function fromDatabase(PDO $db,?string $requiredEnvironment=null): self {return new self(null,new PaymentConfiguration($db),$requiredEnvironment);}
    private function checkEnvironment(): void {
        if ($this->requiredEnvironment!==null && ($this->config['environment']??null)!==$this->requiredEnvironment) throw new RuntimeException('当前入口不能使用该支付环境');
    }
    public function withCurrent(Closure $action) {
        if (!$this->store) {$this->checkEnvironment();return $action();}
        return $this->store->locked(function()use($action){$this->config=$this->store->runtime();$this->checkEnvironment();return $action();});
    }
    public function configuration(): array {return $this->config;}
    public function readiness(): array {
        $missing=[];
        if (isset($this->config['_error'])) $missing[]=$this->config['_error'];
        try {$missing=array_merge($missing,PaymentMaterials::validate($this->config,$this->config['_pins']??[],false));}
        catch(Throwable $error){$missing[]='invalid_key_or_certificate_configuration';}
        return ['enabled'=>(bool)$this->config['enabled'],'ready'=>$missing===[],'missing'=>$missing,'environment'=>$this->config['environment'],'mode'=>$this->config['mode']];
    }
    private function initialize(): \Alipay\EasySDK\Kernel\EasySDKKernel {
        $this->checkEnvironment();
        if (!$this->readiness()['ready']) throw new RuntimeException('支付宝配置尚未完成');
        // Preserve the SDK handler while forbidding redirects away from the fixed gateway.
        \AlibabaCloud\Tea\Tea::config(array_replace(\AlibabaCloud\Tea\Tea::client()->getConfig(),['verify'=>true,'allow_redirects'=>false]));
        $options=new \Alipay\EasySDK\Kernel\Config();
        $options->protocol='https';$options->gatewayHost=$this->config['environment']==='sandbox'?'openapi-sandbox.dl.alipaydev.com':'openapi.alipay.com';
        $options->appId=$this->config['app_id'];$options->signType='RSA2';$options->ignoreSSL=false;
        $options->merchantPrivateKey=PaymentMaterials::sdkPrivate($this->config['private_key']);
        if ($this->config['mode']==='certificate') {
            foreach (PaymentMaterials::sdkCertificates($this->config) as $field=>$value) $options->$field=$value;
        } else $options->alipayPublicKey=PaymentMaterials::body($this->config['public_key']);
        $options->notifyUrl=$this->config['public_url'].'/api/alipay.php?action=notify';
        date_default_timezone_set('Asia/Shanghai');
        return new PaymentAlipayKernel($options);
    }
    public function validateMerchant(array $order): void {
        foreach(['app_id','seller_id','environment'] as $field) if (!is_string($order[$field]??null) || !hash_equals($order[$field],$this->config[$field])) throw new RuntimeException('订单商户配置与当前配置不一致');
    }
    public function checkout(array $order): string {
        if (!$this->config['enabled']) throw new RuntimeException('购买暂未开放');
        $this->validateMerchant($order);$kernel=$this->initialize();$plan=json_decode($order['plan_json'],true,32,JSON_THROW_ON_ERROR);
        return (new \Alipay\EasySDK\Payment\Page\Client($kernel))->batchOptional(['seller_id'=>$order['seller_id'],'time_expire'=>$order['expires_at']])
            ->pay('MoonYa '.$plan['name'].' 月度会员',$order['order_no'],PaymentService::amount((int)$order['amount_cents']),$this->config['public_url'].'/api/alipay.php?action=return')->body;
    }
    public function verifyNotification(array $parameters): bool {
        foreach($parameters as $key=>$value) if (!is_string($value) || $value!=='' && $value[0]==='@') return false; // SDK omits @-prefixed values from its signature string.
        if (($parameters['sign_type']??'')!=='RSA2' || !is_string($parameters['sign']??null)) return false;
        $raw=base64_decode($parameters['sign'],true);
        if ($raw===false || base64_encode($raw)!==$parameters['sign'] || strlen($raw)!==intdiv(PaymentMaterials::rsa($this->config['mode']==='certificate'?PaymentMaterials::certificates($this->config['alipay_cert'])[0]:$this->config['public_key'],false)['bits']+7,8)) return false;
        return (new \Alipay\EasySDK\Payment\Common\Client($this->initialize()))->verifyNotify($parameters);
    }
    public function query(array $order): ?array {
        $this->validateMerchant($order);
        $result=(new \Alipay\EasySDK\Payment\Common\Client($this->initialize()))->query($order['order_no']);
        if ($result->code!=='10000') {
            if ($result->subCode==='ACQ.TRADE_NOT_EXIST') return null;
            throw new RuntimeException('支付宝查单暂不可用');
        }
        // EasySDK verifies API signatures; query is scoped to the authenticated merchant app.
        return ['app_id'=>$this->config['app_id'],'seller_id'=>$this->config['seller_id'],'out_trade_no'=>$result->outTradeNo,
            'trade_no'=>$result->tradeNo,'total_amount'=>$result->totalAmount,'trade_status'=>$result->tradeStatus,'gmt_payment'=>$result->sendPayDate??null];
    }
    public function close(array $order): bool {
        $this->validateMerchant($order);
        $result=(new \Alipay\EasySDK\Payment\Common\Client($this->initialize()))->close($order['order_no']);
        if ($result->code!=='10000' || ($result->outTradeNo??'')!==$order['order_no']) throw new RuntimeException('支付宝未确认关单');
        return true;
    }
}
