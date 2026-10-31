<?php
declare(strict_types=1);
require_once __DIR__.'/payment_http_fixture.php';
require_once dirname(__DIR__).'/Services/PaymentEmailSecurity.php';
final class FixtureEmailMailer implements PaymentVerificationMailer {
    public array $messages=[];public bool $ready=true;public bool $fail=false;
    public function configured():bool{return $this->ready;}
    public function send(string $email,string $code,string $operation):void{
        if($this->fail)throw new PaymentMailUnavailable('Fixture delivery failure');
        $this->messages[]=compact('email','code','operation');
    }
}
$checks=0;
function emailCheck(bool $ok,string $label):void{global $checks;$checks++;if(!$ok)throw new RuntimeException($label);}
function emailReject(Closure $fn,string $label,?int $status=null):void{
    http_response_code(200);try{$fn();}catch(Throwable $error){emailCheck($status===null||http_response_code()===$status,$label);return;}
    throw new RuntimeException('Expected rejection: '.$label);
}
[$db,$config,$name]=membershipTestDatabase();initializePayments($db);
$root=sys_get_temp_dir().'/moonya-payment-http-'.bin2hex(random_bytes(8));mkdir($root,0700);
try{
    paymentFixtureInitializeKey($root);$db->exec("UPDATE admins SET email='fixture-admin@moonya.cn' WHERE id=1");
    $_SERVER['REMOTE_ADDR']='127.0.0.1';$now=time();$mailer=new FixtureEmailMailer();$store=new PaymentConfiguration($db);
    $security=new PaymentEmailSecurity($db,$store,static function()use(&$now){return $now;},$mailer);
    $prepare=fn()=>$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>PaymentConfiguration::defaults()]));
    $send=fn($id,$password='fixture-password')=>$store->locked(fn()=>$security->sendCode(1,$id,$password));
    $confirm=fn($id,$code)=>$store->locked(fn()=>$security->authorize(1,$id,$code));
    $reset=function()use($db,$mailer){foreach(['payment_challenges','payment_auth_attempts','payment_email_limits']as$table)$db->exec('DELETE FROM '.$table);$mailer->messages=[];$mailer->fail=false;};
    emailCheck($security->status(1)['ready']&&$security->status(1)['method']==='email','Email verification ready');
    $a=$prepare();emailCheck(count($mailer->messages)===0,'Preparing never sends email');
    emailReject(fn()=>$confirm($a['challenge_id'],'000000'),'Password stage cannot be skipped',403);
    emailReject(fn()=>$send($a['challenge_id'],'wrong-password'),'Wrong password',403);emailCheck(count($mailer->messages)===0,'Wrong password never sends email');
    $sent=$send($a['challenge_id']);$code=$mailer->messages[0]['code'];
    emailCheck(preg_match('/^\d{6}$/D',$code)===1&&$mailer->messages[0]['email']==='fixture-admin@moonya.cn','Code sent only to stored administrator');
    emailCheck(!str_contains(json_encode($sent),$code)&&$sent['expires_at']===$now+120,'Response contains no code and expires in two minutes');
    $raw=$db->query('SELECT envelope FROM payment_challenges')->fetchColumn();emailCheck(!str_contains($raw,$code),'Database does not contain plaintext code');
    $operation=$confirm($a['challenge_id'],$code);emailCheck($operation['type']==='save'&&!isset($operation['_email']),'Sealed operation returned');
    emailReject(fn()=>$confirm($a['challenge_id'],$code),'Code and challenge replay',403);
    $logs=json_encode($db->query('SELECT details FROM admin_logs')->fetchAll());emailCheck(!str_contains($logs,$code)&&!str_contains($logs,'fixture-password'),'Logs exclude codes and passwords');
    $reset();$a=$prepare();$send($a['challenge_id']);$old=$mailer->messages[0]['code'];
    emailReject(fn()=>$send($a['challenge_id']),'Resend cooldown',429);emailCheck(count($mailer->messages)===1,'Cooldown sends nothing');
    $now+=61;$send($a['challenge_id']);$new=$mailer->messages[1]['code'];emailCheck($old!==$new,'Resend generates different code');
    emailReject(fn()=>$confirm($a['challenge_id'],$old),'Resend invalidates old code',403);$confirm($a['challenge_id'],$new);emailCheck(true,'New code works');
    $reset();$a=$prepare();$b=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];
    emailReject(fn()=>$confirm($b['challenge_id'],$code),'Cross-challenge replacement',403);$confirm($a['challenge_id'],$code);
    $reset();$a=$prepare();for($i=0;$i<5;$i++)emailReject(fn()=>$send($a['challenge_id'],'wrong-password'),'Password failure '.$i,403);
    emailReject(fn()=>$send($a['challenge_id']),'Account block',429);$_SERVER['REMOTE_ADDR']='127.0.0.2';emailReject(fn()=>$send($a['challenge_id']),'Account block across addresses',429);
    emailCheck((int)$db->query('SELECT MAX(blocked_until) FROM payment_auth_attempts')->fetchColumn()===$now+900,'15 minute block');
    $db->prepare('INSERT INTO admins(username,password,email,role) VALUES(?,?,?,?)')->execute(['other-super',password_hash('fixture-password',PASSWORD_DEFAULT),'other-admin@moonya.cn','super_admin']);$other=(int)$db->lastInsertId();$_SERVER['REMOTE_ADDR']='127.0.0.1';
    $otherChallenge=$store->locked(fn()=>$security->prepare($other,['type'=>'save']));emailReject(fn()=>$store->locked(fn()=>$security->sendCode($other,$otherChallenge['challenge_id'],'fixture-password')),'Source block across accounts',429);
    $reset();$a=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];$wrong=$code==='000000'?'000001':'000000';
    for($i=0;$i<5;$i++)emailReject(fn()=>$confirm($a['challenge_id'],$wrong),'Code failure '.$i,403);
    emailReject(fn()=>$confirm($a['challenge_id'],$code),'Correct code blocked after failures',429);
    $reset();$a=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];$now+=121;emailReject(fn()=>$confirm($a['challenge_id'],$code),'Code expiry',403);
    foreach(['email','password','role']as$field){
        $reset();$a=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];$before=$db->query('SELECT '.$field.' FROM admins WHERE id=1')->fetchColumn();
        $value=match($field){'email'=>'changed-admin@moonya.cn','password'=>password_hash('changed-password',PASSWORD_DEFAULT),'role'=>'admin'};
        $db->prepare('UPDATE admins SET '.$field.'=? WHERE id=1')->execute([$value]);emailReject(fn()=>$confirm($a['challenge_id'],$code),'Account '.$field.' change invalidates code');$db->prepare('UPDATE admins SET '.$field.'=? WHERE id=1')->execute([$before]);
    }
    $reset();$a=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];$db->prepare('UPDATE payment_challenges SET expires_at=expires_at+1 WHERE id=?')->execute([$a['challenge_id']]);emailReject(fn()=>$confirm($a['challenge_id'],$code),'Expiry metadata tamper');
    $reset();$a=$prepare();$send($a['challenge_id']);$code=$mailer->messages[0]['code'];$db->exec('UPDATE payment_settings SET revision=revision+1 WHERE id=1');emailReject(fn()=>$confirm($a['challenge_id'],$code),'Stale revision',409);$db->exec('UPDATE payment_settings SET revision=revision-1 WHERE id=1');
    $reset();$a=$prepare();$before=$store->row();$mailer->fail=true;emailReject(fn()=>$send($a['challenge_id']),'Mail delivery fails closed');
    emailCheck((int)$db->query('SELECT consumed FROM payment_challenges')->fetchColumn()===1,'Failed delivery revokes operation');
    emailCheck($store->row()===$before,'Failed delivery never changes configuration');$mailer->fail=false;$b=$prepare();emailReject(fn()=>$send($b['challenge_id']),'Failed delivery retains send throttle',429);
    $reset();for($i=0;$i<5;$i++)$prepare();emailReject(fn()=>$prepare(),'Maximum pending challenges',429);
    $reset();$a=$prepare();$row=$db->query('SELECT * FROM payment_challenges')->fetch();$action=$store->crypto()->open($row['envelope'],'payment-challenge',$row['id'],0);unset($action['_verification']);
    $db->prepare('UPDATE payment_challenges SET envelope=? WHERE id=?')->execute([$store->crypto()->seal($action,'payment-challenge',$row['id'],0),$row['id']]);emailReject(fn()=>$send($a['challenge_id']),'Legacy authenticator challenges rejected');
    $reset();$mailer->ready=false;emailReject(fn()=>$prepare(),'Missing SMTP fails closed');$mailer->ready=true;$db->exec("UPDATE admins SET email='fixture@example.invalid' WHERE id=1");emailReject(fn()=>$prepare(),'Placeholder mailbox rejected');$db->exec("UPDATE admins SET email='fixture-admin@moonya.cn' WHERE id=1");
    $reset();for($i=0;$i<10;$i++){$a=$prepare();$send($a['challenge_id']);$confirm($a['challenge_id'],$mailer->messages[$i]['code']);$now+=61;}
    $a=$prepare();emailReject(fn()=>$send($a['challenge_id']),'Ten sends per fifteen minutes',429);
    echo "PASS: $checks password-first email security checks\n";
}finally{
    if($db->inTransaction())$db->rollBack();$db->exec('DROP DATABASE `'.$name.'`');
    unlink($root.'/keys/master-keyring.json');rmdir($root.'/keys');rmdir($root);
}
