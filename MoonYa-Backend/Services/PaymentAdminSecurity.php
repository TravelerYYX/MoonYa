<?php
declare(strict_types=1);
require_once __DIR__.'/PaymentConfiguration.php';

final class PaymentAdminSecurity {
    private Closure $clock;
    public function __construct(private PDO $db,private PaymentConfiguration $store,?Closure $clock=null) {$this->clock=$clock??static fn()=>time();}
    private function now(): int {return ($this->clock)();}
    public function status(int $admin): array {
        $stmt=$this->db->prepare('SELECT envelope,bootstrap_expires FROM payment_admin_mfa WHERE admin_id=?');$stmt->execute([$admin]);$row=$stmt->fetch();
        return ['bound'=>$row && $row['envelope']!==null,'server_authorized'=>$row && (int)$row['bootstrap_expires']>$this->now()];
    }
    private function scopes(int $admin): array {
        $keys=[hash('sha256','account:'.$admin),hash('sha256','address:'.($_SERVER['REMOTE_ADDR']??'cli'))];sort($keys);return $keys;
    }
    private function limits(int $admin): array {
        $rows=[];
        foreach ($this->scopes($admin) as $key) {
            $stmt=$this->db->prepare('INSERT IGNORE INTO payment_auth_attempts(scope_hash,window_start) VALUES(?,?)');$stmt->execute([$key,$this->now()]);
            $stmt=$this->db->prepare('SELECT * FROM payment_auth_attempts WHERE scope_hash=? FOR UPDATE');$stmt->execute([$key]);$row=$stmt->fetch();
            if ((int)$row['blocked_until']>$this->now()) {http_response_code(429);throw new InvalidArgumentException('身份验证失败次数过多，请稍后重试');}
            $rows[]=$row;
        }
        return $rows;
    }
    private function failed(array $limits,int $admin): never {
        foreach ($limits as $row) {
            $fresh=$this->now()-(int)$row['window_start']>=900;$count=$fresh?1:(int)$row['failures']+1;$start=$fresh?$this->now():(int)$row['window_start'];
            $stmt=$this->db->prepare('UPDATE payment_auth_attempts SET failures=?,window_start=?,blocked_until=? WHERE scope_hash=?');
            $stmt->execute([$count,$start,$count>=5?$this->now()+900:0,$row['scope_hash']]);
        }
        $this->store->audit($admin,'payment_auth_failed',[]);$this->db->commit();
        http_response_code(403);throw new InvalidArgumentException('密码、验证码或授权凭证无效');
    }
    private function password(int $admin,string $password): bool {
        $stmt=$this->db->prepare('SELECT password,role FROM admins WHERE id=? FOR UPDATE');$stmt->execute([$admin]);$row=$stmt->fetch();
        return $row && $row['role']==='super_admin' && strlen($password)<=1024 && password_verify($password,$row['password']);
    }
    private function mfa(int $admin): array {
        $stmt=$this->db->prepare('SELECT * FROM payment_admin_mfa WHERE admin_id=? FOR UPDATE');$stmt->execute([$admin]);
        $row=$stmt->fetch();if (!$row) throw new InvalidArgumentException('请先通过服务器授权绑定认证器');return $row;
    }
    private function otpStep(string $secret,string $code,int $last): ?int {
        if (!preg_match('/^\d{6}$/D',$code)) return null;
        $totp=\OTPHP\TOTP::create($secret,30,'sha1',6);$current=intdiv($this->now(),30);
        foreach ([0,-1,1] as $offset) {
            $step=$current+$offset;
            if ($step>$last && hash_equals($totp->at($step*30),$code)) return $step;
        }
        return null;
    }
    private function insertChallenge(int $admin,array $action,int $revision,int $generation): array {
        $stmt=$this->db->prepare('DELETE FROM payment_challenges WHERE expires_at<?');$stmt->execute([$this->now()]);
        $stmt=$this->db->prepare('SELECT COUNT(*) FROM payment_challenges WHERE admin_id=? AND consumed=0');$stmt->execute([$admin]);
        if ((int)$stmt->fetchColumn()>=5) {http_response_code(429);throw new InvalidArgumentException('待验证操作过多，请等待两分钟后重试');}
        $id=bin2hex(random_bytes(32));$expires=$this->now()+120;
        $action['_context']=[$admin,$expires,$generation,$revision];
        $box=$this->store->crypto()->seal($action,'payment-challenge',$id,$revision);
        $stmt=$this->db->prepare('INSERT INTO payment_challenges(id,admin_id,revision,mfa_generation,envelope,expires_at) VALUES(?,?,?,?,?,?)');
        $stmt->execute([$id,$admin,$revision,$generation,$box,$expires]);
        return ['challenge_id'=>$id,'expires_at'=>$expires];
    }
    public function prepare(int $admin,array $action): array {
        $mfa=$this->status($admin);if (!$mfa['bound']) throw new InvalidArgumentException('请先绑定认证器');
        $stmt=$this->db->prepare('SELECT generation FROM payment_admin_mfa WHERE admin_id=?');$stmt->execute([$admin]);
        return $this->insertChallenge($admin,$action,(int)$this->store->row()['revision'],(int)$stmt->fetchColumn());
    }
    public function beginEnrollment(int $admin,string $password,string $bootstrap): array {
        $this->db->beginTransaction();
        try {
            $limits=$this->limits($admin);$valid=$this->password($admin,$password);$row=$this->mfa($admin);
            if (!$valid || !preg_match('/^[a-f0-9]{64}$/D',$bootstrap) || !$row['bootstrap_hash'] || (int)$row['bootstrap_expires']<=$this->now() || !hash_equals($row['bootstrap_hash'],hash('sha256',$bootstrap))) $this->failed($limits,$admin);
            $totp=\OTPHP\TOTP::create(null,30,'sha1',6);$totp->setLabel('admin-'.$admin);$totp->setIssuer('MoonYa Payment');
            $challenge=$this->insertChallenge($admin,['type'=>'enroll','secret'=>$totp->getSecret(),'bootstrap_hash'=>$row['bootstrap_hash']],(int)$this->store->row()['revision'],(int)$row['generation']);
            $this->db->commit();
            return $challenge+['secret'=>$totp->getSecret(),'provisioning_uri'=>$totp->getProvisioningUri()];
        } catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
    /** Consume both the challenge and time step before executing any external action. */
    public function authorize(int $admin,string $challenge,string $password,string $code): array {
        $this->db->beginTransaction();
        try {
            $limits=$this->limits($admin);$valid=$this->password($admin,$password);$row=$this->mfa($admin);
            $stmt=$this->db->prepare('SELECT * FROM payment_challenges WHERE id=? AND admin_id=? FOR UPDATE');$stmt->execute([$challenge,$admin]);$pending=$stmt->fetch();
            if (!$valid || !$pending || $pending['consumed'] || (int)$pending['expires_at']<=$this->now() || (int)$pending['mfa_generation']!==(int)$row['generation']) $this->failed($limits,$admin);
            if ((int)$pending['revision']!==(int)$this->store->row()['revision']) {http_response_code(409);throw new InvalidArgumentException('配置已变更，请重新验证操作');}
            $action=$this->store->crypto()->open($pending['envelope'],'payment-challenge',$pending['id'],(int)$pending['revision']);
            if (($action['_context']??null)!==[$admin,(int)$pending['expires_at'],(int)$pending['mfa_generation'],(int)$pending['revision']]) throw new InvalidArgumentException('操作挑战完整性验证失败，请重新发起');
            unset($action['_context']);
            if (($action['type']??'')==='enroll') {
                if (!$row['bootstrap_hash'] || (int)$row['bootstrap_expires']<=$this->now() || !hash_equals($row['bootstrap_hash'],$action['bootstrap_hash'])) $this->failed($limits,$admin);
                $step=$this->otpStep($action['secret'],$code,-1);if ($step===null) $this->failed($limits,$admin);
                $revision=(int)$row['revision']+1;$box=$this->store->crypto()->seal(['secret'=>$action['secret']],'payment-mfa',(string)$admin,$revision);
                $stmt=$this->db->prepare('UPDATE payment_admin_mfa SET envelope=?,revision=?,last_step=?,bootstrap_hash=NULL,bootstrap_expires=NULL,generation=generation+1 WHERE admin_id=?');$stmt->execute([$box,$revision,$step,$admin]);
                $this->store->audit($admin,'payment_mfa_enrolled',[]);$action=['type'=>'enrolled'];
            } else {
                if (!$row['envelope'] || ((int)$row['bootstrap_expires']>$this->now())) $this->failed($limits,$admin);
                $seed=$this->store->crypto()->open($row['envelope'],'payment-mfa',(string)$admin,(int)$row['revision']);
                $step=$this->otpStep($seed['secret'],$code,(int)$row['last_step']);unset($seed);
                if ($step===null) $this->failed($limits,$admin);
                $stmt=$this->db->prepare('UPDATE payment_admin_mfa SET last_step=? WHERE admin_id=?');$stmt->execute([$step,$admin]);
            }
            $stmt=$this->db->prepare('UPDATE payment_challenges SET consumed=1,envelope=? WHERE id=?');$stmt->execute([$this->store->crypto()->seal(['consumed'=>true],'payment-challenge',$pending['id'],(int)$pending['revision']),$pending['id']]);
            $this->db->commit();return $action+['revision'=>(int)$pending['revision']];
        } catch(Throwable $error){if($this->db->inTransaction())$this->db->rollBack();throw $error;}
    }
    public function bootstrap(int $admin): string {
        $stmt=$this->db->prepare("SELECT id FROM admins WHERE id=? AND role='super_admin'");$stmt->execute([$admin]);
        if (!$stmt->fetchColumn()) throw new InvalidArgumentException('需要有效的超级管理员 ID');
        $token=bin2hex(random_bytes(32));
        $stmt=$this->db->prepare('INSERT INTO payment_admin_mfa(admin_id,bootstrap_hash,bootstrap_expires,generation) VALUES(?,?,?,1) ON DUPLICATE KEY UPDATE bootstrap_hash=VALUES(bootstrap_hash),bootstrap_expires=VALUES(bootstrap_expires),generation=generation+1');
        $stmt->execute([$admin,hash('sha256',$token),$this->now()+600]);$this->store->audit($admin,'payment_mfa_server_authorization',[]);
        return $token;
    }
}
