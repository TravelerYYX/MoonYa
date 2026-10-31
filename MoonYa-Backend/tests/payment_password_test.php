<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentPasswordSecurity.php';
$checks=0;
function passwordCheck(bool $ok,string $message): void {global $checks;$checks++;if(!$ok)throw new RuntimeException($message);}
function passwordReject(Closure $fn,string $message,?int $status=null): void {
    http_response_code(200);try{$fn();}catch(Throwable $error){passwordCheck($status===null||http_response_code()===$status,$message);return;}throw new RuntimeException('Expected rejection: '.$message);
}
[$db,$config,$name]=membershipTestDatabase();initializePayments($db);
try{
    putenv('PAYMENT_MASTER_KEY_FILE=');putenv('SMTP_PASS=');$db->exec("UPDATE admins SET email='' WHERE id=1");$_SERVER['REMOTE_ADDR']='127.0.0.1';
    $now=time();$store=new PaymentConfiguration($db);$security=new PaymentPasswordSecurity($db,$store,static function()use(&$now){return $now;});
    $prepare=fn($type='settle')=>$store->locked(fn()=>$security->prepare(1,['type'=>$type,'order_numbers'=>['MY20261003123456fixture']]));
    $confirm=fn($id,$password='fixture-password')=>$store->locked(fn()=>$security->authorize(1,$id,$password));
    $reset=function()use($db){$db->exec('DELETE FROM payment_challenges');$db->exec('DELETE FROM payment_auth_attempts');http_response_code(200);};
    passwordCheck($security->status(1)===['method'=>'password','ready'=>true],'Password verification ready without mailbox or SMTP');
    foreach(['import','settle','force_delete']as$type){
        $a=$prepare($type);passwordCheck($a['expires_at']===$now+120&&!isset($a['email_masked']),'Password challenge expires in two minutes');
        passwordReject(fn()=>$confirm($a['challenge_id'],''),'Empty password rejected',403);
        passwordReject(fn()=>$confirm($a['challenge_id'],'wrong'),'Wrong password rejected',403);
        $operation=$confirm($a['challenge_id']);passwordCheck($operation['type']===$type&&$operation['revision']===0&&!isset($operation['_identity']),'Password returns only the frozen operation');
        passwordReject(fn()=>$confirm($a['challenge_id']),'Consumed challenge cannot replay',403);$reset();
    }
    $a=$prepare();$db->exec("UPDATE admins SET email='changed@example.invalid' WHERE id=1");passwordCheck($confirm($a['challenge_id'])['type']==='settle','Mailbox change is irrelevant to password verification');$reset();
    $a=$prepare();$now+=120;passwordReject(fn()=>$confirm($a['challenge_id']),'Expired challenge rejected at its deadline',403);$reset();
    $a=$prepare();$db->exec('UPDATE payment_settings SET revision=revision+1 WHERE id=1');passwordReject(fn()=>$confirm($a['challenge_id']),'Stale configuration revision',409);$db->exec('UPDATE payment_settings SET revision=revision-1 WHERE id=1');$reset();
    $a=$prepare();$hash=$db->query('SELECT password FROM admins WHERE id=1')->fetchColumn();$db->prepare('UPDATE admins SET password=? WHERE id=1')->execute([password_hash('changed-password',PASSWORD_DEFAULT)]);
    passwordReject(fn()=>$confirm($a['challenge_id'],'changed-password'),'Password change invalidates frozen operation');$db->prepare('UPDATE admins SET password=? WHERE id=1')->execute([$hash]);$reset();
    $a=$prepare();$db->exec("UPDATE admins SET role='admin' WHERE id=1");passwordReject(fn()=>$confirm($a['challenge_id']),'Current role must still be super administrator',403);$db->exec("UPDATE admins SET role='super_admin' WHERE id=1");$reset();
    $db->prepare('INSERT INTO admins(username,password,email,role) VALUES(?,?,?,?)')->execute(['other-super',password_hash('fixture-password',PASSWORD_DEFAULT),'','super_admin']);$other=(int)$db->lastInsertId();
    $a=$prepare();passwordReject(fn()=>$store->locked(fn()=>$security->authorize($other,$a['challenge_id'],'fixture-password')),'Challenge is bound to its administrator',403);$reset();
    $a=$prepare();$db->prepare('UPDATE payment_challenges SET expires_at=expires_at+1 WHERE id=?')->execute([$a['challenge_id']]);passwordReject(fn()=>$confirm($a['challenge_id']),'Expiry metadata tampering rejected');$reset();
    $a=$prepare();$row=$db->query('SELECT * FROM payment_challenges')->fetch();$sealed=$store->crypto()->open($row['envelope'],'payment-challenge',$row['id'],0);$sealed['_verification']='email-v1';
    $db->prepare('UPDATE payment_challenges SET envelope=? WHERE id=?')->execute([$store->crypto()->seal($sealed,'payment-challenge',$row['id'],0),$row['id']]);passwordReject(fn()=>$confirm($a['challenge_id']),'Old email challenges cannot bypass the new password protocol');$reset();
    for($i=0;$i<5;$i++)$prepare();passwordReject(fn()=>$prepare(),'Pending challenge limit',429);$reset();
    $a=$prepare();for($i=0;$i<5;$i++)passwordReject(fn()=>$confirm($a['challenge_id'],'wrong'),'Password failure '.$i,403);
    passwordReject(fn()=>$confirm($a['challenge_id']),'Account rate limit',429);$_SERVER['REMOTE_ADDR']='127.0.0.2';passwordReject(fn()=>$confirm($a['challenge_id']),'Account rate limit across addresses',429);
    $_SERVER['REMOTE_ADDR']='127.0.0.1';passwordReject(fn()=>$store->locked(fn()=>$security->verifyPassword($other,'fixture-password')),'Address rate limit across accounts',429);
    $now+=901;$a=$prepare();passwordCheck($confirm($a['challenge_id'])['type']==='settle','Can retry after lockout expires');
    passwordCheck((int)$db->query('SELECT COUNT(*) FROM payment_email_limits')->fetchColumn()===0,'Password flow never stages an email');
    $logs=json_encode($db->query('SELECT details FROM admin_logs')->fetchAll());passwordCheck(!str_contains($logs,'fixture-password')&&!str_contains($logs,'changed-password'),'Audit contains no passwords');
    echo "PASS: $checks payment password security checks\n";
}finally{if($db->inTransaction())$db->rollBack();$db->exec('DROP DATABASE `'.$name.'`');}
