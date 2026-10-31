<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentKeyStore.php';
require_once __DIR__.'/PaymentMaterials.php';

final class PaymentConfiguration {
    private int $depth=0;
    private bool $deploymentCrypto;
    public function __construct(private PDO $db,private ?PaymentCrypto $crypto=null) {$this->deploymentCrypto=$crypto===null;}
    public static function defaults(): array {
        return ['enabled'=>false,'environment'=>'production','mode'=>'public_key','app_id'=>'','seller_id'=>'','public_url'=>'',
            'private_key'=>'','public_key'=>'','app_cert'=>'','alipay_cert'=>'','root_cert'=>''];
    }
    public function crypto(): PaymentCrypto {return $this->crypto??=PaymentKeyStore::crypto($this->db);}
    public function locked(Closure $action) {
        if ($this->depth>0) return $action();
        $name='moonya_payment_'.hash('sha256',(string)$this->db->query('SELECT DATABASE()')->fetchColumn());
        $stmt=$this->db->prepare('SELECT GET_LOCK(?,10)');$stmt->execute([substr($name,0,64)]);
        if ((int)$stmt->fetchColumn()!==1) throw new RuntimeException('支付配置正在使用，请稍后重试');
        $this->depth++;
        if($this->deploymentCrypto)$this->crypto=null;
        try{return $action();}finally{$this->depth--; $stmt=$this->db->prepare('SELECT RELEASE_LOCK(?)');$stmt->execute([substr($name,0,64)]);}
    }
    public function row(): array {
        $row=$this->db->query('SELECT * FROM payment_settings WHERE id=1')->fetch(PDO::FETCH_ASSOC);
        if (!$row) throw new PaymentStorageUnavailable('支付配置记录缺失，请执行支付数据库升级');
        return $row;
    }
    public function load(): array {
        $row=$this->row();
        if($row['envelope']===null)$value=self::defaults();
        else {$crypto=$this->crypto();try{$value=$crypto->open($row['envelope'],'alipay-config','1',(int)$row['revision']);}
            catch(Throwable $error){throw new PaymentStorageUnavailable('支付配置密文损坏或与键环不匹配，请恢复数据库备份',0,$error);}}
        if (array_keys($value)!==array_keys(self::defaults())) throw new PaymentStorageUnavailable('支付配置结构无效，请恢复数据库备份');
        return $value;
    }
    public function runtime(): array {
        try {
            $config=$this->load();$config['_pins']=$config['mode']==='certificate'?$this->crypto()->roots($config['environment']):[];
            return $config;
        } catch (Throwable $error) {
            return self::defaults()+['_error'=>'encrypted_configuration_unavailable'];
        }
    }
    public function publicState(): array {
        $row=$this->row();$value=$this->load();
        try {$missing=PaymentMaterials::validate($value,$this->crypto()->roots($value['environment']),false);}
        catch (InvalidArgumentException $error) {$missing=['invalid_key_or_certificate'];}
        $public=array_diff_key($value,array_flip(PaymentMaterials::FIELDS));$public['materials']=[];
        foreach (PaymentMaterials::FIELDS as $field) $public['materials'][$field]=['configured'=>$value[$field]!=='',
            'fingerprint'=>$field==='private_key'?'':($value[$field]!==''?hash('sha256',$value[$field]):'')];
        return $public+['revision'=>(int)$row['revision'],'imported'=>(bool)$row['imported'],'ready'=>$missing===[],'missing'=>$missing,
            'blocking_orders'=>(int)$this->db->query("SELECT COUNT(*) FROM membership_orders WHERE status IN ('pending','expired')")->fetchColumn(),
            'notify_url'=>$value['public_url']?$value['public_url'].'/api/alipay.php?action=notify':'',
            'return_url'=>$value['public_url']?$value['public_url'].'/api/alipay.php?action=return':''];
    }
    public function candidate(array $input): array {
        $allowed=array_merge(array_keys(self::defaults()),['revision','clear']);
        if (array_diff(array_keys($input),$allowed)) throw new InvalidArgumentException('未知的支付配置字段');
        if (!is_int($input['revision']??null) || $input['revision']!==(int)$this->row()['revision']) {http_response_code(409);throw new InvalidArgumentException('配置已变更，请重新加载');}
        $next=$this->load();$clear=$input['clear']??[];
        if (!is_array($clear) || !array_is_list($clear) || array_diff($clear,PaymentMaterials::FIELDS)) throw new InvalidArgumentException('清除字段无效');
        foreach (self::defaults() as $field=>$default) {
            if (!array_key_exists($field,$input)) continue;
            if ($field==='enabled') {if (!is_bool($input[$field])) throw new InvalidArgumentException('支付开关无效');$next[$field]=$input[$field];continue;}
            if (!is_string($input[$field])) throw new InvalidArgumentException('支付配置格式无效');
            $text=trim($input[$field]);
            if (in_array($field,PaymentMaterials::FIELDS,true) && $text==='') continue;
            $next[$field]=$field==='public_url'?rtrim($text,'/'):$text;
        }
        foreach ($clear as $field) $next[$field]='';
        PaymentMaterials::validate($next,$this->crypto()->roots($next['environment']),$next['enabled']);
        $this->checkChange($next);
        return $next;
    }
    private function checkChange(array $next,bool $initialImport=false): void {
        $old=$this->load();$identityChanged=false;
        foreach (array_merge(['app_id','seller_id','environment','mode'],PaymentMaterials::FIELDS) as $field) if ($next[$field]!==$old[$field]) $identityChanged=true;
        if ($initialImport && $this->row()['envelope']===null) {
            // Existing pre-migration orders can only import their original environment merchant.
            $stmt=$this->db->prepare("SELECT COUNT(*) FROM membership_orders WHERE status IN ('pending','expired') AND (app_id<>? OR seller_id<>? OR environment<>?)");
            $stmt->execute([$next['app_id'],$next['seller_id'],$next['environment']]);
            if ((int)$stmt->fetchColumn()>0) {http_response_code(409);throw new InvalidArgumentException('旧配置与未结清订单的商户不一致，禁止导入');}
            $identityChanged=false;
        }
        if ($identityChanged && (int)$this->db->query("SELECT COUNT(*) FROM membership_orders WHERE status IN ('pending','expired')")->fetchColumn()>0) {
            http_response_code(409);throw new InvalidArgumentException('存在未结清订单，不能更换商户、环境或密钥，请先查单结清');
        }
        if ($old['public_url']!==$next['public_url'] && $old['enabled'] && $next['enabled']) throw new InvalidArgumentException('修改后端地址前必须先关闭购买');
    }
    public function save(array $next,int $revision,int $admin,bool $import=false): void {
        if ($this->depth<1) throw new LogicException('Payment configuration write requires lock');
        $owned=!$this->db->inTransaction();if($owned)$this->db->beginTransaction();
        try{$this->persist($next,$revision,$admin,$import);if($owned)$this->db->commit();}
        catch(Throwable $error){if($owned&&$this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
    private function persist(array $next,int $revision,int $admin,bool $import): void {
        if ($this->depth<1) throw new LogicException('Payment configuration write requires lock');
        $row=$this->row();
        if ($revision!==(int)$row['revision']) {http_response_code(409);throw new InvalidArgumentException('配置已变更，请重新验证操作');}
        if ($import && ($row['envelope']!==null || $row['imported'])) throw new InvalidArgumentException('已有后台配置，不能再次导入');
        PaymentMaterials::validate($next,$this->crypto()->roots($next['environment']),$next['enabled']);$this->checkChange($next,$import);
        $old=$this->load();$fields=[];foreach($next as $field=>$value)if($old[$field]!==$value)$fields[]=$field;
        $envelope=$this->crypto()->seal($next,'alipay-config','1',$revision+1);
        $stmt=$this->db->prepare('UPDATE payment_settings SET envelope=?,revision=revision+1,updated_by=?,imported=IF(?=1,1,imported) WHERE id=1 AND revision=?');
        $stmt->execute([$envelope,$admin,(int)$import,$revision]);
        if ($stmt->rowCount()!==1) throw new RuntimeException('支付配置保存冲突');
        $this->audit($admin,$import?'payment_config_import':'payment_config_save',['revision'=>$revision+1,'fields'=>$fields]);
    }
    public function audit(int $admin,string $action,array $details): void {
        $stmt=$this->db->prepare('INSERT INTO admin_logs(admin_id,action,details,ip_address) VALUES(?,?,?,?)');
        $stmt->execute([$admin>0?$admin:null,$action,json_encode($details,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$_SERVER['REMOTE_ADDR']??'cli']);
    }
    public function legacy(): array {
        $row=$this->row();if ($row['envelope']!==null || $row['imported']) throw new InvalidArgumentException('已有后台配置，不能再次导入');
        $value=self::defaults();
        foreach (['enabled'=>'ALIPAY_ENABLED','environment'=>'ALIPAY_ENVIRONMENT','mode'=>'ALIPAY_SIGN_MODE','app_id'=>'ALIPAY_APP_ID','seller_id'=>'ALIPAY_SELLER_ID','public_url'=>'ALIPAY_PUBLIC_URL'] as $field=>$key) {
            $text=env($key,$value[$field]);$value[$field]=$field==='enabled'?filter_var($text,FILTER_VALIDATE_BOOLEAN,FILTER_NULL_ON_FAILURE):trim((string)$text);
        }
        if (!is_bool($value['enabled'])) throw new InvalidArgumentException('旧支付开关无效');
        foreach (['private_key'=>'ALIPAY_PRIVATE_KEY_FILE','public_key'=>'ALIPAY_PUBLIC_KEY_FILE','app_cert'=>'ALIPAY_APP_CERT_FILE','alipay_cert'=>'ALIPAY_CERT_FILE','root_cert'=>'ALIPAY_ROOT_CERT_FILE'] as $field=>$key) {
            $path=(string)env($key,'');if ($path==='') continue;
            $real=realpath($path);
            if (!$real || !is_file($real) || !is_readable($real) || filesize($real)>65536) throw new InvalidArgumentException('旧支付材料路径不可用或不安全');
            PaymentCrypto::externalPath($real);
            $value[$field]=(string)file_get_contents($real);
        }
        $value['public_url']=rtrim($value['public_url'],'/');
        PaymentMaterials::validate($value,$this->crypto()->roots($value['environment']),$value['enabled']);$this->checkChange($value,true);
        return $value;
    }
}
