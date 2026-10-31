<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentCrypto.php';
final class PaymentStorageUnavailable extends RuntimeException {}
/** Database-owned keyring. Legacy files are only consulted during first migration. */
final class PaymentKeyStore {
    public static function crypto(PDO $db): PaymentCrypto {return new PaymentCrypto(self::read($db));}
    public static function read(PDO $db): array {
        try {$raw=$db->query('SELECT keyring FROM payment_keyring WHERE id=1')->fetchColumn();}
        catch(PDOException $error){if((int)($error->errorInfo[1]??0)!==1146)throw $error;throw new PaymentStorageUnavailable('支付数据库尚未升级，请导入 payment_keyring_upgrade.sql',0,$error);}
        if($raw===false)throw new PaymentStorageUnavailable('支付键环记录缺失，请重新执行支付数据库升级');
        if($raw!==null)return self::decode($raw);
        if($db->inTransaction())throw new PaymentStorageUnavailable('请先完成支付键环初始化，再执行支付操作');
        $db->beginTransaction();
        try {
            $raw=$db->query('SELECT keyring FROM payment_keyring WHERE id=1 FOR UPDATE')->fetchColumn();
            if($raw!==null){$db->commit();return self::decode($raw);}
            $rows=[];
            foreach([['payment_settings','id','alipay-config'],['payment_admin_mfa','admin_id','payment-mfa'],['payment_challenges','id','payment-challenge']] as [$table,$id,$purpose]) {
                foreach($db->query("SELECT $id AS record,revision,envelope FROM $table WHERE envelope IS NOT NULL")->fetchAll(PDO::FETCH_ASSOC) as $row)$rows[]=[$purpose,$row];
            }
            $path=(string)env('PAYMENT_MASTER_KEY_FILE','');
            if($rows) {
                if($path==='' || !is_file($path) || !is_readable($path) || filesize($path)>65536)throw new PaymentStorageUnavailable('已有支付配置需要首次迁移，请将 PAYMENT_MASTER_KEY_FILE 指向原主密钥文件；迁移后无需保留此设置');
                $ring=self::decode((string)file_get_contents($path));$crypto=new PaymentCrypto($ring);
                try{foreach($rows as [$purpose,$row])$crypto->open($row['envelope'],$purpose,(string)$row['record'],(int)$row['revision']);}
                catch(Throwable $error){throw new PaymentStorageUnavailable('原主密钥无法解密已有支付数据，请恢复匹配的原主密钥；现有配置未被清空',0,$error);}
            } elseif($path!=='' && is_file($path) && is_readable($path) && filesize($path)<=65536)$ring=self::decode((string)file_get_contents($path));
            else {$id=bin2hex(random_bytes(8));$ring=['version'=>1,'active'=>$id,'keys'=>[$id=>base64_encode(random_bytes(32))],'roots'=>['production'=>[],'sandbox'=>[]]];}
            self::write($db,$ring);$db->commit();return $ring;
        }catch(Throwable $error){if($db->inTransaction())$db->rollBack();throw $error;}
    }
    private static function decode(string $raw): array {
        try{$ring=json_decode($raw,true,16,JSON_THROW_ON_ERROR);if(!is_array($ring))throw new RuntimeException();new PaymentCrypto($ring);return $ring;}
        catch(Throwable $error){throw new PaymentStorageUnavailable('支付键环内容无效，请恢复原主密钥或数据库备份',0,$error);}
    }
    public static function write(PDO $db,array $ring): void {
        new PaymentCrypto($ring);$stmt=$db->prepare('UPDATE payment_keyring SET keyring=? WHERE id=1');$stmt->execute([json_encode($ring,JSON_THROW_ON_ERROR)]);
    }
}
