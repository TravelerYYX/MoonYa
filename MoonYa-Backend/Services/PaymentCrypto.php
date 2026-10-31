<?php
declare(strict_types=1);
require_once __DIR__.'/AppDataPaths.php';
require_once dirname(__DIR__).'/env_loader.php';
ini_set('zend.exception_ignore_args','1');

/** AEAD envelopes never contain a plaintext key. The keyring is deployment-owned. */
final class PaymentCrypto {
    public function __construct(private array $ring) {
        if (($ring['version']??null)!==1 || !is_string($ring['active']??null) || !isset($ring['keys'][$ring['active']])) throw new RuntimeException('支付主密钥无效');
        foreach ($ring['keys'] as $id=>$encoded) {
            if (!preg_match('/^[a-f0-9]{16}$/D',(string)$id) || !is_string($encoded) || strlen(self::decode($encoded))!==32) throw new RuntimeException('支付主密钥无效');
            $jwt=(string)env('JWT_SECRET','');
            if($jwt!=='' && ($jwt===$encoded || $jwt===self::decode($encoded) || $jwt===bin2hex(self::decode($encoded))))throw new RuntimeException('支付主密钥不能复用管理员签名密钥');
        }
        foreach(['production','sandbox']as$environment){$pins=$ring['roots'][$environment]??[];if(!is_array($pins)||!array_is_list($pins))throw new RuntimeException('根证书信任配置无效');foreach($pins as$pin)if(!is_string($pin)||!preg_match('/^[a-f0-9]{64}$/D',$pin))throw new RuntimeException('根证书信任配置无效');}
    }
    private static function decode(string $text): string {
        $raw=base64_decode($text,true);
        if ($raw===false || base64_encode($raw)!==$text) throw new RuntimeException('支付加密数据无效');
        return $raw;
    }
    public static function externalPath(string $path, bool $exists=true): string {
        if (!preg_match('~^(?:[A-Za-z]:[\\\\/]|/)~',$path) || is_link($path)) throw new RuntimeException('主密钥必须使用站点之外的绝对路径');
        $resolved=$exists?realpath($path):(($parent=realpath(dirname($path)))?$parent.DIRECTORY_SEPARATOR.basename($path):false);
        if (!$resolved) throw new RuntimeException('主密钥路径不可用');
        $normal=static fn($s)=>strtolower(rtrim(str_replace('\\','/',$s),'/'));
        $workspaceRoot=is_dir(dirname(__DIR__,2).'/.git')?dirname(__DIR__,2):'';
        foreach ([dirname(__DIR__),$workspaceRoot,AppDataPaths::root(),$_SERVER['DOCUMENT_ROOT']??''] as $root) {
            if ($root==='' || !($actual=realpath($root))) continue;
            if ($normal($resolved)===$normal($actual) || str_starts_with($normal($resolved),$normal($actual).'/')) throw new RuntimeException('主密钥不能位于站点或业务数据目录');
        }
        return $resolved;
    }
    /** No permissive fallback: permission inspection failures disable payment. */
    public static function extraSids(): array {
        $sids=[];
        foreach(explode(',',(string)env('PAYMENT_KEY_ALLOWED_SIDS',''))as$sid){$sid=trim($sid);if($sid==='')continue;
            // Permit account/service identities, never broad built-in groups.
            if(!preg_match('/^S-1-5-(?:21-\d+-\d+-\d+-\d+|80(?:-\d+){5}|18|19|20)$/D',$sid))throw new RuntimeException('主密钥仅允许明确的服务或操作员账号 SID');$sids[]=$sid;
        }
        return array_values(array_unique($sids));
    }
    public static function checkPermissions(string $path): void {
        if (PHP_OS_FAMILY!=='Windows') {
            foreach ([$path,dirname($path)] as $target) {
                clearstatcache(true,$target);$stat=stat($target);
                if (!$stat || ($stat['mode']&0077)!==0) throw new RuntimeException('支付主密钥权限不安全');
            }
            return;
        }
        $script='$ErrorActionPreference="Stop"; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@(); $owners=@(); foreach($p in @($env:MOONYA_KEY_ACL_TARGET,[System.IO.Path]::GetDirectoryName($env:MOONYA_KEY_ACL_TARGET))) { $a=if([System.IO.File]::Exists($p)){[System.IO.File]::GetAccessControl($p)}else{[System.IO.Directory]::GetAccessControl($p)}; $owners+=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; foreach($r in $a.Access) { $rules += @{sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;allow=($r.AccessControlType -eq "Allow")} } }; @{me=$me;rules=$rules;owners=$owners}|ConvertTo-Json -Depth 4 -Compress';
        $encoded=base64_encode(iconv('UTF-8','UTF-16LE',$script));
        $env=getenv();$env['MOONYA_KEY_ACL_TARGET']=$path;
        $process=proc_open(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',$encoded],[1=>['pipe','w'],2=>['pipe','w']],$pipes,null,$env,['bypass_shell'=>true]);
        if (!is_resource($process)) throw new RuntimeException('无法检查主密钥 ACL');
        $out=stream_get_contents($pipes[1]);fclose($pipes[1]);stream_get_contents($pipes[2]);fclose($pipes[2]);
        if (proc_close($process)!==0 || !is_array($acl=json_decode($out,true))) throw new RuntimeException('无法检查主密钥 ACL');
        $allowed=['S-1-5-18','S-1-5-32-544',$acl['me']];
        $allowed=array_merge($allowed,self::extraSids());
        foreach ($acl['rules'] as $rule) if ($rule['allow'] && !in_array($rule['sid'],$allowed,true)) throw new RuntimeException('支付主密钥 ACL 不安全');
        foreach ($acl['owners'] as $owner) if (!in_array($owner,$allowed,true)) throw new RuntimeException('支付主密钥所有者不安全');
    }
    public static function fromDeployment(): self {
        $path=self::externalPath((string)env('PAYMENT_MASTER_KEY_FILE',''));
        self::checkPermissions($path);
        if (!is_file($path) || filesize($path)>65536) throw new RuntimeException('支付主密钥不可用');
        $ring=json_decode((string)file_get_contents($path),true,16,JSON_THROW_ON_ERROR);
        return new self($ring);
    }
    public function roots(string $environment): array { return $this->ring['roots'][$environment]??[]; }
    public function activeId(): string { return $this->ring['active']; }
    public function seal(array $value,string $purpose,string $record,int $revision): string {
        $id=$this->ring['active'];$iv=random_bytes(12);$aad=json_encode([1,$id,$purpose,$record,$revision],JSON_THROW_ON_ERROR);
        $plain=json_encode($value,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
        $cipher=openssl_encrypt($plain,'aes-256-gcm',self::decode($this->ring['keys'][$id]),OPENSSL_RAW_DATA,$iv,$tag,$aad,16);
        unset($plain);
        if ($cipher===false || strlen($tag)!==16) throw new RuntimeException('支付配置加密失败');
        return json_encode(['v'=>1,'kid'=>$id,'iv'=>base64_encode($iv),'tag'=>base64_encode($tag),'ciphertext'=>base64_encode($cipher)],JSON_THROW_ON_ERROR);
    }
    public function open(string $envelope,string $purpose,string $record,int $revision): array {
        if (strlen($envelope)>524288) throw new RuntimeException('支付加密数据无效');
        $box=json_decode($envelope,true,8,JSON_THROW_ON_ERROR);
        if (!is_array($box) || count($box)!==5 || ($box['v']??null)!==1 || !is_string($box['kid']??null) || !isset($this->ring['keys'][$box['kid']])) throw new RuntimeException('支付加密数据无效');
        foreach (['iv','tag','ciphertext'] as $field) if (!is_string($box[$field]??null)) throw new RuntimeException('支付加密数据无效');
        $iv=self::decode($box['iv']);$tag=self::decode($box['tag']);$cipher=self::decode($box['ciphertext']);
        if (strlen($iv)!==12 || strlen($tag)!==16 || $cipher==='') throw new RuntimeException('支付加密数据无效');
        $aad=json_encode([1,$box['kid'],$purpose,$record,$revision],JSON_THROW_ON_ERROR);
        $plain=openssl_decrypt($cipher,'aes-256-gcm',self::decode($this->ring['keys'][$box['kid']]),OPENSSL_RAW_DATA,$iv,$tag,$aad);
        if ($plain===false) throw new RuntimeException('支付配置完整性验证失败');
        $value=json_decode($plain,true,32,JSON_THROW_ON_ERROR);unset($plain);
        if (!is_array($value)) throw new RuntimeException('支付加密数据无效');
        return $value;
    }
}
