<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentAdminSecurity.php';

/** These operations have no HTTP route. The database backup includes the keyring. */
final class PaymentKeyCommands {
    public static function write(string $path,array $ring,bool $new=false): void {
        $path=PaymentCrypto::externalPath($path,!$new);
        $target=$new?$path:dirname($path).DIRECTORY_SEPARATOR.'.payment-keyring-'.bin2hex(random_bytes(8)).'.json';
        $handle=fopen($target,'x+b');if (!$handle) throw new RuntimeException('不能创建主密钥文件');$done=false;
        try {
            chmod($target,0600);
            if (PHP_OS_FAMILY==='Windows') {
                $script='$ErrorActionPreference="Stop"; $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetAccessRuleProtection($true,$false); $ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544"); foreach($sid in $ids){$s=New-Object System.Security.Principal.SecurityIdentifier($sid); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,"FullControl","Allow");$a.AddAccessRule($r)}; foreach($sid in ([string]$env:PAYMENT_KEY_ALLOWED_SIDS).Split(",")){if($sid -match "^S-1-\\d+(-\\d+)+$"){ $s=New-Object System.Security.Principal.SecurityIdentifier($sid);$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,"Read","Allow"))) }}; [System.IO.File]::SetAccessControl($env:MOONYA_KEY_ACL_TARGET,$a)';
                $env=getenv();$env['MOONYA_KEY_ACL_TARGET']=$target;$env['PAYMENT_KEY_ALLOWED_SIDS']=implode(',',PaymentCrypto::extraSids());
                $process=proc_open(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',base64_encode(iconv('UTF-8','UTF-16LE',$script))],[1=>['pipe','w'],2=>['pipe','w']],$pipes,null,$env,['bypass_shell'=>true]);
                if(!is_resource($process))throw new RuntimeException('无法设置密钥 ACL');
                stream_get_contents($pipes[1]);fclose($pipes[1]);stream_get_contents($pipes[2]);fclose($pipes[2]);
                if(proc_close($process)!==0)throw new RuntimeException('无法设置密钥 ACL');
            }
            PaymentCrypto::checkPermissions($target);
            new PaymentCrypto($ring);
            $data=json_encode($ring,JSON_THROW_ON_ERROR|JSON_PRETTY_PRINT);
            if (fwrite($handle,$data)!==strlen($data) || !fflush($handle) || !fsync($handle)) throw new RuntimeException('主密钥写入失败');
            fclose($handle);$handle=null;
            if (!$new && !rename($target,$path)) throw new RuntimeException('主密钥替换失败');
            $done=true;
        } finally {if(is_resource($handle))fclose($handle);if((!$new || !$done) && is_file($target))unlink($target);}
    }
    public static function initialize(string $path): void {
        $id=bin2hex(random_bytes(8));self::write($path,['version'=>1,'active'=>$id,'keys'=>[$id=>base64_encode(random_bytes(32))],'roots'=>['production'=>[],'sandbox'=>[]]],true);
    }
    public static function read(string $path): array {
        $path=PaymentCrypto::externalPath($path);PaymentCrypto::checkPermissions($path);
        $ring=json_decode((string)file_get_contents($path),true,16,JSON_THROW_ON_ERROR);new PaymentCrypto($ring);return $ring;
    }
    public static function rotate(PDO $db,string $path=''): void {
        $store=new PaymentConfiguration($db);
        $store->locked(function()use($db,$store){
            $ring=PaymentKeyStore::read($db);$source=new PaymentCrypto($ring);
            $id=bin2hex(random_bytes(8));$ring['keys'][$id]=base64_encode(random_bytes(32));$ring['active']=$id;$target=new PaymentCrypto($ring);
            $db->beginTransaction();
            try {
                foreach([['payment_settings','id','alipay-config'],['payment_admin_mfa','admin_id','payment-mfa'],['payment_challenges','id','payment-challenge']] as [$table,$key,$purpose]) {
                    foreach($db->query("SELECT $key AS record,revision,envelope FROM $table WHERE envelope IS NOT NULL")->fetchAll(PDO::FETCH_ASSOC) as $row){
                        $value=$source->open($row['envelope'],$purpose,(string)$row['record'],(int)$row['revision']);
                        $stmt=$db->prepare("UPDATE $table SET envelope=? WHERE $key=?");$stmt->execute([$target->seal($value,$purpose,(string)$row['record'],(int)$row['revision']),$row['record']]);unset($value);
                    }
                }
                PaymentKeyStore::write($db,$ring);$store->audit(0,'payment_master_key_rotated',['key_id'=>$id]);$db->commit();
            }catch(Throwable $error){if($db->inTransaction())$db->rollBack();throw $error;}
        });
    }
    public static function trust(PDO $db,string $path,string $environment,string $fingerprint): void {
        if(!in_array($environment,['production','sandbox'],true)||!preg_match('/^[a-f0-9]{64}$/D',$fingerprint))throw new InvalidArgumentException('需要环境及官方根证书 SHA-256 指纹');
        $store=new PaymentConfiguration($db);
        $store->locked(function()use($db,$environment,$fingerprint,$store){
            $ring=PaymentKeyStore::read($db);$db->beginTransaction();
            try{$ring['roots'][$environment]=array_values(array_unique(array_merge($ring['roots'][$environment]??[],[$fingerprint])));PaymentKeyStore::write($db,$ring);$store->audit(0,'payment_root_trusted',['environment'=>$environment,'fingerprint'=>$fingerprint]);$db->commit();}
            catch(Throwable $error){if($db->inTransaction())$db->rollBack();throw $error;}
        });
    }
}
