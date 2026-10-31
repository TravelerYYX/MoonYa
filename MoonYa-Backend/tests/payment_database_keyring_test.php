<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentPasswordSecurity.php';
if(($argv[1]??'')==='worker'){
    [$db]=membershipTestDatabase($argv[2]);putenv('PAYMENT_MASTER_KEY_FILE=');echo PaymentKeyStore::crypto($db)->activeId();exit;
}
$checks=0;
function keyCheck(bool $ok,string $message):void{global $checks;$checks++;if(!$ok)throw new RuntimeException($message);}
function keyReject(Closure $fn,string $message):void{try{$fn();}catch(Throwable $error){keyCheck(true,$message);return;}throw new RuntimeException('Expected rejection: '.$message);}
[$db,$config,$name]=membershipTestDatabase();initializePayments($db);
$file=tempnam(sys_get_temp_dir(),'moonya-key-migrate-');
try{
    // Race two independent processes initializing the same new database.
    $children=[];for($i=0;$i<2;$i++){$process=proc_open([PHP_BINARY,__FILE__,'worker',$name],[1=>['pipe','w'],2=>['pipe','w']],$pipes);$children[]=[$process,$pipes];}
    $ids=[];foreach($children as [$process,$pipes]){$ids[]=trim(stream_get_contents($pipes[1]));$err=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);keyCheck(proc_close($process)===0,'concurrent initialization '.$err);}
    keyCheck($ids[0]===$ids[1] && preg_match('/^[a-f0-9]{16}$/D',$ids[0])===1,'one winning keyring');
    $ring=PaymentKeyStore::read($db);$ring['roots']['sandbox']=[str_repeat('a',64)];$crypto=new PaymentCrypto($ring);
    $value=PaymentConfiguration::defaults();$box=$crypto->seal($value,'alipay-config','1',7);
    $db->prepare('UPDATE payment_settings SET envelope=?,revision=7 WHERE id=1')->execute([$box]);
    $db->exec('UPDATE payment_keyring SET keyring=NULL WHERE id=1');
    $wrong=$ring;$wrong['keys'][$wrong['active']]=base64_encode(random_bytes(32));file_put_contents($file,json_encode($wrong));putenv('PAYMENT_MASTER_KEY_FILE='.$file);
    keyReject(fn()=>PaymentKeyStore::read($db),'wrong legacy key rejected');
    keyCheck($db->query('SELECT keyring FROM payment_keyring')->fetchColumn()===null,'failed migration leaves keyring empty');
    keyCheck($db->query('SELECT envelope FROM payment_settings')->fetchColumn()===$box,'failed migration preserves original envelope');
    file_put_contents($file,json_encode($ring));$migrated=PaymentKeyStore::read($db);
    keyCheck($migrated===$ring,'migration retains all keys and trusted roots');
    unlink($file);putenv('PAYMENT_MASTER_KEY_FILE=');
    keyCheck(PaymentKeyStore::read($db)===$ring,'repeat initialization independent of file');
    $store=new PaymentConfiguration($db);keyCheck($store->load()===$value,'configuration readable without file');
    initializePaymentSecurity($db);keyCheck(PaymentKeyStore::read($db)===$ring,'repeat schema migration retains keyring');
    $security=new PaymentPasswordSecurity($db,$store);$db->exec("UPDATE admins SET email='' WHERE id=1");putenv('SMTP_PASS=');
    $store->locked(function()use($store,$security){$security->verifyPassword(1,'fixture-password');$next=$store->candidate(['revision'=>7,'enabled'=>false]);$store->save($next,7,1);});
    keyCheck((int)$store->row()['revision']===8,'password save without email or SMTP');
    keyReject(fn()=>$store->locked(fn()=>$store->candidate(['revision'=>7,'enabled'=>false])),'stale revision rejected');
    $challenge=$store->locked(fn()=>$security->prepare(1,['type'=>'settle','order_numbers'=>['MY20261003123456fixture']]));
    $authorized=$store->locked(fn()=>$security->authorize(1,$challenge['challenge_id'],'fixture-password'));
    keyCheck($authorized['type']==='settle','settle needs only password without email or SMTP');
    $_SERVER['REMOTE_ADDR']='127.0.0.1';for($i=0;$i<5;$i++)keyReject(fn()=>$store->locked(fn()=>$security->verifyPassword(1,'bad-password')),'bad password');
    http_response_code(200);keyReject(fn()=>$store->locked(fn()=>$security->verifyPassword(1,'fixture-password')),'locked out after failures');keyCheck(http_response_code()===429,'password rate limit status');
    keyCheck((int)$store->row()['revision']===8,'failures do not write configuration');
    keyCheck(!str_contains(json_encode($db->query('SELECT details FROM admin_logs')->fetchAll()),'fixture-password'),'audit contains no password');
    echo "PASS: $checks database keyring and password checks\n";
}finally{if(is_file($file))unlink($file);$db->exec('DROP DATABASE `'.$name.'`');}
