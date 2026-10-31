<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentConfiguration.php';
require_once __DIR__.'/PaymentEmailMailer.php';

/** Password-first email verification, bound to a single encrypted payment operation. */
final class PaymentEmailSecurity {
    private Closure $clock;
    private PaymentVerificationMailer $mailer;
    public function __construct(private PDO $db,private PaymentConfiguration $store,?Closure $clock=null,?PaymentVerificationMailer $mailer=null) {
        $this->clock=$clock??static fn()=>time();$this->mailer=$mailer??new PaymentEmailMailer();
    }
    private function now(): int {return ($this->clock)();}
    private function account(int $admin,bool $lock=false): array {
        $stmt=$this->db->prepare('SELECT id,password,email,role FROM admins WHERE id=?'.($lock?' FOR UPDATE':''));$stmt->execute([$admin]);$row=$stmt->fetch();
        if(!$row || $row['role']!=='super_admin'){http_response_code(403);throw new InvalidArgumentException('仅超级管理员可确认支付操作');}return $row;
    }
    private static function validEmail(string $email): bool {
        if(!filter_var($email,FILTER_VALIDATE_EMAIL))return false;
        $domain=strtolower(substr(strrchr($email,'@'),1));
        return !in_array($domain,['example.com','example.org','example.net','example.invalid','localhost'],true) && !preg_match('/\.(?:invalid|example|test)$/D',$domain);
    }
    private static function masked(string $email): string {if(!filter_var($email,FILTER_VALIDATE_EMAIL))return '';[$name,$domain]=explode('@',$email,2);return substr($name,0,1).'***@'.$domain;}
    public function status(int $admin): array {
        $account=$this->account($admin);$emailReady=self::validEmail($account['email']);$mailReady=$this->mailer->configured();
        return ['method'=>'email','ready'=>$emailReady&&$mailReady,'email_configured'=>$emailReady,'mail_configured'=>$mailReady,'email_masked'=>self::masked($account['email'])];
    }
    private function scopes(int $admin): array {$keys=[hash('sha256','account:'.$admin),hash('sha256','address:'.($_SERVER['REMOTE_ADDR']??'cli'))];sort($keys);return $keys;}
    private function limits(int $admin): array {
        $rows=[];
        foreach($this->scopes($admin)as$key){
            $stmt=$this->db->prepare('INSERT IGNORE INTO payment_auth_attempts(scope_hash,window_start) VALUES(?,?)');$stmt->execute([$key,$this->now()]);
            $stmt=$this->db->prepare('SELECT * FROM payment_auth_attempts WHERE scope_hash=? FOR UPDATE');$stmt->execute([$key]);$row=$stmt->fetch();
            if((int)$row['blocked_until']>$this->now()){http_response_code(429);throw new InvalidArgumentException('身份验证失败次数过多，请稍后重试');}$rows[]=$row;
        }return $rows;
    }
    private function failed(array $limits,int $admin,string $message='管理员密码或邮箱验证码无效'): never {
        foreach($limits as$row){
            $fresh=$this->now()-(int)$row['window_start']>=900;$count=$fresh?1:(int)$row['failures']+1;
            $stmt=$this->db->prepare('UPDATE payment_auth_attempts SET failures=?,window_start=?,blocked_until=? WHERE scope_hash=?');
            $stmt->execute([$count,$fresh?$this->now():(int)$row['window_start'],$count>=5?$this->now()+900:0,$row['scope_hash']]);
        }
        $this->store->audit($admin,'payment_auth_failed',[]);$this->db->commit();http_response_code(403);throw new InvalidArgumentException($message);
    }
    private function identity(array $account): array {return [(int)$account['id'],hash('sha256',$account['email']),hash('sha256',$account['password'])];}
    private function pending(int $admin,string $id,array $account,array $limits): array {
        $stmt=$this->db->prepare('SELECT * FROM payment_challenges WHERE id=? AND admin_id=? FOR UPDATE');$stmt->execute([$id,$admin]);$row=$stmt->fetch();
        if(!$row || $row['consumed'] || (int)$row['expires_at']<=$this->now())$this->failed($limits,$admin);
        if((int)$row['revision']!==(int)$this->store->row()['revision']){http_response_code(409);throw new InvalidArgumentException('配置已变更，请重新发起验证');}
        $action=$this->store->crypto()->open($row['envelope'],'payment-challenge',$row['id'],(int)$row['revision']);
        if(($action['_context']??null)!==[$admin,(int)$row['expires_at'],0,(int)$row['revision']] || ($action['_verification']??null)!=='email-v1' || ($action['_identity']??null)!==$this->identity($account))throw new InvalidArgumentException('验证已失效或操作内容被修改，请重新发起');
        return [$row,$action];
    }
    public function prepare(int $admin,array $action): array {
        if(!in_array($action['type']??null,['save','import','settle'],true))throw new InvalidArgumentException('操作无效');$account=$this->account($admin);
        if(!self::validEmail($account['email']))throw new InvalidArgumentException('管理员尚未设置有效收件邮箱，请先配置管理员邮箱');
        if(!$this->mailer->configured())throw new PaymentMailUnavailable('邮件发送尚未配置完整，请设置 SMTP 发信服务');
        $stmt=$this->db->prepare('DELETE FROM payment_challenges WHERE expires_at<?');$stmt->execute([$this->now()]);
        $stmt=$this->db->prepare('SELECT COUNT(*) FROM payment_challenges WHERE admin_id=? AND consumed=0');$stmt->execute([$admin]);
        if((int)$stmt->fetchColumn()>=5){http_response_code(429);throw new InvalidArgumentException('待验证操作过多，请稍后重试');}
        $id=bin2hex(random_bytes(32));$expires=$this->now()+120;$revision=(int)$this->store->row()['revision'];
        $action['_context']=[$admin,$expires,0,$revision];$action['_verification']='email-v1';$action['_identity']=$this->identity($account);
        $stmt=$this->db->prepare('INSERT INTO payment_challenges(id,admin_id,revision,mfa_generation,envelope,expires_at) VALUES(?,?,?,0,?,?)');
        $stmt->execute([$id,$admin,$revision,$this->store->crypto()->seal($action,'payment-challenge',$id,$revision),$expires]);
        return ['challenge_id'=>$id,'expires_at'=>$expires,'email_masked'=>self::masked($account['email'])];
    }
    public function verifyPassword(int $admin,string $password): void {
        $this->db->beginTransaction();
        try {
            $limits=$this->limits($admin);$account=$this->account($admin,true);
            if(strlen($password)>1024 || !password_verify($password,$account['password']))$this->failed($limits,$admin,'管理员密码无效');
            $this->store->audit($admin,'payment_password_verified',[]);$this->db->commit();
        }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
    private function sendingLimits(int $admin): void {
        foreach($this->scopes($admin)as$key){
            $stmt=$this->db->prepare('INSERT IGNORE INTO payment_email_limits(scope_hash,window_start) VALUES(?,?)');$stmt->execute([$key,$this->now()]);
            $stmt=$this->db->prepare('SELECT * FROM payment_email_limits WHERE scope_hash=? FOR UPDATE');$stmt->execute([$key]);$row=$stmt->fetch();$fresh=$this->now()-(int)$row['window_start']>=900;
            if((int)$row['next_send_at']>$this->now() || (!$fresh && (int)$row['sends']>=10)){http_response_code(429);throw new InvalidArgumentException('验证码发送过于频繁，请稍后重试');}
            $stmt=$this->db->prepare('UPDATE payment_email_limits SET next_send_at=?,window_start=?,sends=? WHERE scope_hash=?');
            $stmt->execute([$this->now()+60,$fresh?$this->now():(int)$row['window_start'],$fresh?1:(int)$row['sends']+1,$key]);
        }
    }
    /** No email is dispatched until the current account password has passed verification. */
    public function sendCode(int $admin,string $id,string $password): array {
        $this->db->beginTransaction();
        try{
            $limits=$this->limits($admin);$account=$this->account($admin,true);
            if(strlen($password)>1024 || !password_verify($password,$account['password']))$this->failed($limits,$admin,'管理员密码无效');
            [$row,$action]=$this->pending($admin,$id,$account,$limits);
            if(!self::validEmail($account['email']))throw new InvalidArgumentException('管理员收件邮箱无效');
            if(!$this->mailer->configured())throw new PaymentMailUnavailable('邮件发送尚未配置完整，请设置 SMTP 发信服务');$this->sendingLimits($admin);
            do{$code=str_pad((string)random_int(0,999999),6,'0',STR_PAD_LEFT);$hash=hash('sha256',$id.':'.$code);}while(isset($action['_email']['hash'])&&hash_equals($action['_email']['hash'],$hash));
            $expires=$this->now()+120;$action['_context'][1]=$expires;$action['_email']=['hash'=>$hash,'status'=>'sending'];
            $staged=$this->store->crypto()->seal($action,'payment-challenge',$id,(int)$row['revision']);
            $stmt=$this->db->prepare('UPDATE payment_challenges SET envelope=?,expires_at=? WHERE id=?');$stmt->execute([$staged,$expires,$id]);$this->db->commit();
        }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
        try{
            $this->mailer->send($account['email'],$code,$action['type']);unset($code);$action['_email']['status']='sent';$this->db->beginTransaction();
            $stmt=$this->db->prepare('UPDATE payment_challenges SET envelope=? WHERE id=? AND consumed=0 AND envelope=?');$stmt->execute([$this->store->crypto()->seal($action,'payment-challenge',$id,(int)$row['revision']),$id,$staged]);
            if($stmt->rowCount()!==1)throw new RuntimeException('Challenge delivery state conflict');$this->store->audit($admin,'payment_email_code_sent',['challenge_id'=>$id]);$this->db->commit();
            return ['expires_at'=>$expires,'retry_after'=>60,'email_masked'=>self::masked($account['email'])];
        }catch(Throwable $error){
            unset($code);if($this->db->inTransaction())$this->db->rollBack();
            $stmt=$this->db->prepare('UPDATE payment_challenges SET consumed=1,envelope=? WHERE id=? AND envelope=?');$stmt->execute([$this->store->crypto()->seal(['consumed'=>true],'payment-challenge',$id,(int)$row['revision']),$id,$staged]);
            $this->store->audit($admin,'payment_email_delivery_failed',['challenge_id'=>$id]);throw new PaymentMailUnavailable('验证码邮件发送失败，请检查 SMTP 配置后重新发起操作');
        }
    }
    /** Confirmation consumes the password-verified operation, never replacement request content. */
    public function authorize(int $admin,string $id,string $code): array {
        $this->db->beginTransaction();
        try{
            $limits=$this->limits($admin);$account=$this->account($admin,true);[$row,$action]=$this->pending($admin,$id,$account,$limits);
            if(!preg_match('/^\d{6}$/D',$code) || ($action['_email']['status']??null)!=='sent' || !hash_equals($action['_email']['hash'],hash('sha256',$id.':'.$code)))$this->failed($limits,$admin);
            $stmt=$this->db->prepare('UPDATE payment_challenges SET consumed=1,envelope=? WHERE id=? AND consumed=0');$stmt->execute([$this->store->crypto()->seal(['consumed'=>true],'payment-challenge',$id,(int)$row['revision']),$id]);
            if($stmt->rowCount()!==1)throw new RuntimeException('Challenge consumption conflict');$this->store->audit($admin,'payment_email_verified',['challenge_id'=>$id]);$this->db->commit();
            unset($action['_context'],$action['_verification'],$action['_identity'],$action['_email']);return $action+['revision'=>(int)$row['revision']];
        }catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
}
