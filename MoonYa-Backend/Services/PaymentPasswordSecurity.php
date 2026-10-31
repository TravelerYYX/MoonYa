<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentConfiguration.php';

/** Current administrator password, bound to a single encrypted payment operation. */
final class PaymentPasswordSecurity {
    private Closure $clock;
    public function __construct(private PDO $db,private PaymentConfiguration $store,?Closure $clock=null) {
        $this->clock=$clock??static fn()=>time();
    }
    private function now(): int {return ($this->clock)();}
    private function account(int $admin,bool $lock=false): array {
        $stmt=$this->db->prepare('SELECT id,password,role FROM admins WHERE id=?'.($lock?' FOR UPDATE':''));$stmt->execute([$admin]);$row=$stmt->fetch();
        if(!$row || $row['role']!=='super_admin'){http_response_code(403);throw new InvalidArgumentException('仅超级管理员可确认支付操作');}return $row;
    }
    public function status(int $admin): array {$this->account($admin);return ['method'=>'password','ready'=>true];}
    private function limits(int $admin): array {
        $keys=[hash('sha256','account:'.$admin),hash('sha256','address:'.($_SERVER['REMOTE_ADDR']??'cli'))];sort($keys);$rows=[];
        foreach($keys as$key){
            $stmt=$this->db->prepare('INSERT IGNORE INTO payment_auth_attempts(scope_hash,window_start) VALUES(?,?)');$stmt->execute([$key,$this->now()]);
            $stmt=$this->db->prepare('SELECT * FROM payment_auth_attempts WHERE scope_hash=? FOR UPDATE');$stmt->execute([$key]);$row=$stmt->fetch();
            if((int)$row['blocked_until']>$this->now()){http_response_code(429);throw new InvalidArgumentException('身份验证失败次数过多，请稍后重试');}$rows[]=$row;
        }return $rows;
    }
    private function failed(array $limits,int $admin,string $message): never {
        foreach($limits as$row){
            $fresh=$this->now()-(int)$row['window_start']>=900;$count=$fresh?1:(int)$row['failures']+1;
            $stmt=$this->db->prepare('UPDATE payment_auth_attempts SET failures=?,window_start=?,blocked_until=? WHERE scope_hash=?');
            $stmt->execute([$count,$fresh?$this->now():(int)$row['window_start'],$count>=5?$this->now()+900:0,$row['scope_hash']]);
        }
        $this->store->audit($admin,'payment_auth_failed',[]);$this->db->commit();http_response_code(403);throw new InvalidArgumentException($message);
    }
    private function checkPassword(int $admin,string $password,array $account,array $limits): void {
        if(strlen($password)>1024 || !password_verify($password,$account['password']))$this->failed($limits,$admin,'管理员密码无效');
    }
    public function verifyPassword(int $admin,string $password): void {
        $this->db->beginTransaction();
        try{
            $limits=$this->limits($admin);$account=$this->account($admin,true);$this->checkPassword($admin,$password,$account,$limits);
            $this->store->audit($admin,'payment_password_verified',[]);$this->db->commit();
        }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
    public function prepare(int $admin,array $action): array {
        if(!in_array($action['type']??null,['import','settle','force_delete'],true))throw new InvalidArgumentException('操作无效');$account=$this->account($admin);
        $stmt=$this->db->prepare('DELETE FROM payment_challenges WHERE expires_at<=?');$stmt->execute([$this->now()]);
        $stmt=$this->db->prepare('SELECT COUNT(*) FROM payment_challenges WHERE admin_id=? AND consumed=0');$stmt->execute([$admin]);
        if((int)$stmt->fetchColumn()>=5){http_response_code(429);throw new InvalidArgumentException('待验证操作过多，请稍后重试');}
        $id=bin2hex(random_bytes(32));$expires=$this->now()+120;$revision=(int)$this->store->row()['revision'];
        $action['_context']=[$admin,$expires,0,$revision];$action['_verification']='password-v1';$action['_identity']=[(int)$account['id'],hash('sha256',$account['password'])];
        $stmt=$this->db->prepare('INSERT INTO payment_challenges(id,admin_id,revision,mfa_generation,envelope,expires_at) VALUES(?,?,?,0,?,?)');
        $stmt->execute([$id,$admin,$revision,$this->store->crypto()->seal($action,'payment-challenge',$id,$revision),$expires]);
        return ['challenge_id'=>$id,'expires_at'=>$expires];
    }
    public function authorize(int $admin,string $id,string $password): array {
        $this->db->beginTransaction();
        try{
            $limits=$this->limits($admin);$account=$this->account($admin,true);$this->checkPassword($admin,$password,$account,$limits);
            $stmt=$this->db->prepare('SELECT * FROM payment_challenges WHERE id=? AND admin_id=? FOR UPDATE');$stmt->execute([$id,$admin]);$row=$stmt->fetch();
            if(!$row || $row['consumed'] || (int)$row['expires_at']<=$this->now())$this->failed($limits,$admin,'验证已失效，请重新发起操作');
            if((int)$row['revision']!==(int)$this->store->row()['revision']){http_response_code(409);throw new InvalidArgumentException('配置已变更，请重新发起验证');}
            $action=$this->store->crypto()->open($row['envelope'],'payment-challenge',$row['id'],(int)$row['revision']);
            if(($action['_context']??null)!==[$admin,(int)$row['expires_at'],0,(int)$row['revision']] || ($action['_verification']??null)!=='password-v1' || ($action['_identity']??null)!==[(int)$account['id'],hash('sha256',$account['password'])] || !in_array($action['type']??null,['import','settle','force_delete'],true))throw new InvalidArgumentException('验证已失效或操作内容被修改，请重新发起');
            $stmt=$this->db->prepare('UPDATE payment_challenges SET consumed=1,envelope=? WHERE id=? AND consumed=0');$stmt->execute([$this->store->crypto()->seal(['consumed'=>true],'payment-challenge',$id,(int)$row['revision']),$id]);
            if($stmt->rowCount()!==1)throw new RuntimeException('Challenge consumption conflict');$this->store->audit($admin,'payment_password_verified',['challenge_id'=>$id]);$this->db->commit();
            unset($action['_context'],$action['_verification'],$action['_identity']);return $action+['revision'=>(int)$row['revision']];
        }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
}
