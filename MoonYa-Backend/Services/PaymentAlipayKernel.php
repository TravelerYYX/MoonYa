<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentMaterials.php';

/** Reject malformed/unsigned replies before entering EasySDK's permissive decoder. */
final class PaymentAlipayKernel extends \Alipay\EasySDK\Kernel\EasySDKKernel {
    public function verify($respMap,$alipayPublicKey) {
        $body=$respMap[\Alipay\EasySDK\Kernel\AlipayConstants::BODY_FIELD]??null;
        if (!is_string($body) || strlen($body)>262144) return false;
        $decoded=json_decode($body,true,32);
        if (!is_array($decoded) || !is_string($decoded['sign']??null)) return false;
        $raw=base64_decode($decoded['sign'],true);
        if ($raw===false || base64_encode($raw)!==$decoded['sign']) return false;
        $bits=PaymentMaterials::rsa("-----BEGIN PUBLIC KEY-----\n".$alipayPublicKey."\n-----END PUBLIC KEY-----",false)['bits'];
        if(strlen($raw)!==intdiv($bits+7,8))return false;
        return parent::verify($respMap,$alipayPublicKey);
    }
}
