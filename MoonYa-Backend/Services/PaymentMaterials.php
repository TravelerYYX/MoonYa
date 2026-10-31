<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/vendor/autoload.php';

/** Parse and verify certificates in memory; SDK identifiers are protocol metadata. */
final class PaymentMaterials {
    public const FIELDS=['private_key','public_key','app_cert','alipay_cert','root_cert'];
    public static function certificates(string $pem): array {
        preg_match_all('/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/',$pem,$matches);
        if (!$matches[0] || trim(preg_replace('/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/','',$pem))!=='') throw new InvalidArgumentException('证书格式无效');
        foreach ($matches[0] as $cert) if (!openssl_x509_read($cert)) throw new InvalidArgumentException('证书格式无效');
        return $matches[0];
    }
    public static function rsa(string $pem,bool $private): array {
        $key=$private?openssl_pkey_get_private($pem):openssl_pkey_get_public($pem);
        $details=$key?openssl_pkey_get_details($key):false;
        if (!$details || $details['type']!==OPENSSL_KEYTYPE_RSA || $details['bits']<2048) throw new InvalidArgumentException('需要至少 2048 位的有效 RSA 密钥');
        return $details;
    }
    private static function validDate(string $cert): array {
        $info=openssl_x509_parse($cert);
        if (!$info || $info['validFrom_time_t']>time() || $info['validTo_time_t']<=time()) throw new InvalidArgumentException('证书未生效或已过期');
        $decoded=(new \phpseclib3\File\X509())->loadX509($cert);$seen=[];
        if (!is_array($decoded)) throw new InvalidArgumentException('证书扩展解析失败');
        foreach ($decoded['tbsCertificate']['extensions']??[] as $extension) {
            $id=$extension['extnId'];
            if (!is_string($id) || isset($seen[$id])) throw new InvalidArgumentException('证书含重复或无效扩展');
            $seen[$id]=true;
            // Fail closed on restrictions this signing-certificate verifier cannot enforce.
            if (($extension['critical']??false) && !in_array($id,['id-ce-basicConstraints','id-ce-keyUsage'],true)) throw new InvalidArgumentException('证书含不支持的关键扩展');
            if (in_array($id,['id-ce-nameConstraints','id-ce-policyConstraints','id-ce-inhibitAnyPolicy','id-ce-extKeyUsage'],true)) throw new InvalidArgumentException('证书含不支持的用途或路径限制');
        }
        return $info;
    }
    private static function caConstraints(array $info,int $caBelow): void {
        $constraints=$info['extensions']['basicConstraints']??'';
        if (!str_contains($constraints,'CA:TRUE') || (isset($info['extensions']['keyUsage']) && !str_contains($info['extensions']['keyUsage'],'Certificate Sign'))) throw new InvalidArgumentException('CA 证书签发用途无效');
        if (preg_match('/pathlen\s*:\s*(\d+)/i',$constraints,$match) && $caBelow>(int)$match[1]) throw new InvalidArgumentException('证书链超过 CA 路径长度约束');
    }
    /** Walk signatures and CA constraints to a separately pinned root. */
    public static function chain(string $leaf,array $bundle,array $rootBundle,array $pins): void {
        $leafInfo=self::validDate($leaf);
        if (str_contains($leafInfo['extensions']['basicConstraints']??'','CA:TRUE') || (isset($leafInfo['extensions']['keyUsage']) && !preg_match('/Digital Signature|Non Repudiation/',$leafInfo['extensions']['keyUsage']))) throw new InvalidArgumentException('支付叶证书不允许交易签名');
        $trusted=[];
        foreach ($rootBundle as $root) {
            $fingerprint=openssl_x509_fingerprint($root,'sha256');
            if (in_array($fingerprint,$pins,true)) {
                $info=self::validDate($root);
                self::caConstraints($info,0);
                if (openssl_x509_verify($root,openssl_pkey_get_public($root))!==1) throw new InvalidArgumentException('受信任根证书无效');
                $trusted[$fingerprint]=$root;
            }
        }
        if (!$trusted) throw new InvalidArgumentException('根证书尚未由服务器登记信任');
        $pool=array_merge($bundle,$rootBundle);$visited=[];$current=$leaf;$caBelow=0;
        for ($depth=0;$depth<10;$depth++) {
            $info=self::validDate($current);$fp=openssl_x509_fingerprint($current,'sha256');
            if ($depth>0) self::caConstraints($info,$caBelow);
            if (isset($trusted[$fp])) return;
            if (isset($visited[$fp])) break;$visited[$fp]=true;$parent=null;
            foreach ($pool as $candidate) {
                $ci=openssl_x509_parse($candidate);
                if ($ci['subject']!==$info['issuer'] || $candidate===$current) continue;
                if (!str_contains($ci['extensions']['basicConstraints']??'','CA:TRUE')) continue;
                if (isset($ci['extensions']['keyUsage']) && !str_contains($ci['extensions']['keyUsage'],'Certificate Sign')) continue;
                if (openssl_x509_verify($current,openssl_pkey_get_public($candidate))===1) {$parent=$candidate;break;}
            }
            if (!$parent) break;
            if ($depth>0 && $info['subject']!==$info['issuer']) $caBelow++;
            $current=$parent;
        }
        throw new InvalidArgumentException('证书链签名或信任验证失败');
    }
    public static function validate(array $config,array $pins,bool $complete): array {
        $missing=[];
        if (!in_array($config['environment'],['production','sandbox'],true)) throw new InvalidArgumentException('支付环境无效');
        if (!in_array($config['mode'],['public_key','certificate'],true)) throw new InvalidArgumentException('签名模式无效');
        foreach (['app_id'=>'/^\d{16,32}$/D','seller_id'=>'/^\d{16}$/D'] as $field=>$pattern) {
            if ($config[$field]==='') $missing[]=$field;
            elseif (!preg_match($pattern,$config[$field])) throw new InvalidArgumentException('商户或应用 ID 格式无效');
        }
        if ($config['public_url']==='') $missing[]='public_url';
        else {
            $url=parse_url($config['public_url']);
            if (!$url || ($url['scheme']??'')!=='https' || empty($url['host']) || isset($url['user'],$url['pass']) || isset($url['user']) || isset($url['query']) || isset($url['fragment']) || strlen($config['public_url'])>2048 || preg_match('/[\x00-\x20\\\\]/',$config['public_url'])) throw new InvalidArgumentException('后端地址必须是有效公网 HTTPS 地址');
            if (in_array(strtolower($url['host']),['localhost','127.0.0.1','::1','[::1]'],true) || (filter_var($url['host'],FILTER_VALIDATE_IP) && !filter_var($url['host'],FILTER_VALIDATE_IP,FILTER_FLAG_NO_PRIV_RANGE|FILTER_FLAG_NO_RES_RANGE))) throw new InvalidArgumentException('不能使用回环或私网付款地址');
        }
        $required=$config['mode']==='certificate'?['private_key','app_cert','alipay_cert','root_cert']:['private_key','public_key'];
        foreach (self::FIELDS as $field) {
            $text=$config[$field];
            if (strlen($text)>65536 || str_contains($text,"\0")) throw new InvalidArgumentException('密钥或证书材料无效或超过 64 KiB');
            if ($text==='') {if (in_array($field,$required,true)) $missing[]=$field;continue;}
            if ($field==='private_key' || $field==='public_key') self::rsa($text,$field==='private_key');
            else {foreach (self::certificates($text) as $cert) self::validDate($cert);}
        }
        if ($config['private_key']!=='') {
            $message=random_bytes(32);$key=openssl_pkey_get_private($config['private_key']);$public=self::rsa($config['private_key'],true)['key'];
            if (!openssl_sign($message,$signature,$key,OPENSSL_ALGO_SHA256) || openssl_verify($message,$signature,$public,OPENSSL_ALGO_SHA256)!==1) throw new InvalidArgumentException('应用私钥签名自检失败');
        }
        if ($config['mode']==='certificate' && !array_intersect($missing,['private_key','app_cert','alipay_cert','root_cert'])) {
            $app=self::certificates($config['app_cert']);$alipay=self::certificates($config['alipay_cert']);$roots=self::certificates($config['root_cert']);
            if (!openssl_x509_check_private_key($app[0],openssl_pkey_get_private($config['private_key']))) throw new InvalidArgumentException('应用证书与私钥不匹配');
            self::rsa($app[0],false);self::rsa($alipay[0],false);
            self::chain($app[0],$app,$roots,$pins);self::chain($alipay[0],$alipay,$roots,$pins);
        }
        if (!class_exists(\Alipay\EasySDK\Kernel\EasySDKKernel::class)) $missing[]='sdk';
        if ($complete && $missing) throw new InvalidArgumentException('支付配置不完整：'.implode('、',$missing));
        return $missing;
    }
    public static function sdkPrivate(string $pem): string {
        // EasySDK expects PKCS#1. Normalize PKCS#8 with a maintained RSA library.
        $key=\phpseclib3\Crypt\PublicKeyLoader::loadPrivateKey($pem);
        return self::body($key->toString('PKCS1'));
    }
    public static function body(string $pem): string {return preg_replace('/\s+/','',preg_replace('/-----[^-]+-----/','',$pem));}
    public static function sdkCertificates(array $config): array {
        $util=new \Alipay\EasySDK\Kernel\Util\AntCertificationUtil();
        $identifier=static function(string $pem)use($util):string {
            $parsed=openssl_x509_parse($pem);$serial=$parsed['serialNumber'];
            if(str_starts_with((string)$serial,'0x'))$serial=(new \phpseclib3\Math\BigInteger($parsed['serialNumberHex'],16))->toString();
            // MD5 is mandated for Alipay's certificate identifier, never used for protection.
            return md5($util->array2string(array_reverse($parsed['issuer'])).$serial);
        };
        $rootIdentifiers=[];
        foreach(self::certificates($config['root_cert'])as$root){$info=openssl_x509_parse($root);if(in_array($info['signatureTypeLN'],['sha1WithRSAEncryption','sha256WithRSAEncryption'],true))$rootIdentifiers[]=$identifier($root);}
        if(!$rootIdentifiers)throw new InvalidArgumentException('根证书包缺少支付宝协议支持的证书');
        return ['merchantCertSN'=>$identifier(self::certificates($config['app_cert'])[0]),
            'alipayRootCertSN'=>implode('_',$rootIdentifiers),
            'alipayPublicKey'=>self::body(openssl_pkey_get_details(openssl_pkey_get_public(self::certificates($config['alipay_cert'])[0]))['key'])];
    }
}
