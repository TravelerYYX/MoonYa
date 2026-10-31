<?php
declare(strict_types=1);
require_once __DIR__.'/payment_http_fixture.php';
require_once dirname(__DIR__).'/Services/PaymentTransport.php';
require_once dirname(__DIR__).'/admin/Auth.php';
$checks=0;
function secureCheck(bool $ok,string $message): void {global $checks;$checks++;if(!$ok)throw new RuntimeException($message);}
function secureReject(Closure $action,string $message): void {try{$action();}catch(Throwable $error){secureCheck(true,$message);return;}throw new RuntimeException('Expected rejection: '.$message);}
function secureCleanup(string $root): void {
    $real=realpath($root);if(!$real)return;
    if(strtolower(dirname($real))!==strtolower(realpath(sys_get_temp_dir())) || !preg_match('/^moonya-payment-http-[a-f0-9]{16}$/D',basename($real)))throw new RuntimeException('Unsafe fixture cleanup');
    $remove=function(string $path)use(&$remove,$real){
        if(!str_starts_with(strtolower(str_replace('\\','/',$path)),strtolower(str_replace('\\','/',$real)).'/'))throw new RuntimeException('Fixture path escape');
        if(is_link($path)||is_file($path)){unlink($path);return;}
        foreach(new DirectoryIterator($path)as$item)if(!$item->isDot())$remove($item->getPathname());rmdir($path);
    };
    foreach(new DirectoryIterator($real)as$item)if(!$item->isDot())$remove($item->getPathname());rmdir($real);
}
[$db,$config,$name]=membershipTestDatabase();initializePayments($db);
$root=sys_get_temp_dir().'/moonya-payment-http-'.bin2hex(random_bytes(8));mkdir($root,0700);
try {
    $keyPath=paymentFixtureInitializeKey($root);$ring=PaymentKeyCommands::read($keyPath);$crypto=new PaymentCrypto($ring);
    $box=$crypto->seal(['secret'=>'fixture-secret'],'purpose','record',1);
    secureCheck($crypto->open($box,'purpose','record',1)['secret']==='fixture-secret','encrypted round trip');
    secureCheck(!str_contains($box,'fixture-secret'),'no plaintext in envelope');
    secureCheck(json_decode($box,true)['iv']!==json_decode($crypto->seal(['secret'=>'fixture-secret'],'purpose','record',1),true)['iv'],'fresh IV');
    foreach(['ciphertext','tag','iv']as$field){$b=json_decode($box,true);$raw=base64_decode($b[$field]);$raw[0]=chr(ord($raw[0])^1);$b[$field]=base64_encode($raw);secureReject(fn()=>$crypto->open(json_encode($b),'purpose','record',1),'tampered '.$field);}
    $b=json_decode($box,true);$b['tag']=base64_encode(substr(base64_decode($b['tag']),0,1));secureReject(fn()=>$crypto->open(json_encode($b),'purpose','record',1),'truncated GCM tag');
    foreach([['other','record',1],['purpose','other',1],['purpose','record',2]]as$args)secureReject(fn()=>$crypto->open($box,...$args),'context binding');
    $wrong=$ring;$wrong['keys'][$wrong['active']]=base64_encode(random_bytes(32));secureReject(fn()=>(new PaymentCrypto($wrong))->open($box,'purpose','record',1),'wrong master key');
    $wrong['keys'][$wrong['active']]=base64_encode(random_bytes(31));secureReject(fn()=>new PaymentCrypto($wrong),'wrong key length');
    $previousJwt=(string)env('JWT_SECRET','');putenv('JWT_SECRET='.$ring['keys'][$ring['active']]);secureReject(fn()=>new PaymentCrypto($ring),'separate JWT and payment keys');putenv('JWT_SECRET='.$previousJwt);
    $previousSids=(string)env('PAYMENT_KEY_ALLOWED_SIDS','');putenv('PAYMENT_KEY_ALLOWED_SIDS=S-1-1-0');secureReject(fn()=>PaymentCrypto::extraSids(),'cannot allow Everyone as a service');putenv('PAYMENT_KEY_ALLOWED_SIDS='.$previousSids);
    secureReject(fn()=>PaymentCrypto::externalPath(dirname(__DIR__).'/master-keyring.json',false),'master outside web root');
    $cipher=openssl_encrypt(str_repeat("\0",16),'aes-256-gcm',str_repeat("\0",32),OPENSSL_RAW_DATA,str_repeat("\0",12),$tag,'',16);
    secureCheck(bin2hex($cipher)==='cea7403d4d606b6e074ec5d3baf39d18'&&bin2hex($tag)==='d0d1c8a799996bf0265b98b5d48ab919','NIST AES-256-GCM known vector');

    $jwtKey=hash('sha256','test-auth');$auth=new Auth(null,['jwt_secret'=>$jwtKey],null);$decode=new ReflectionMethod(Auth::class,'decodeToken');$decode->setAccessible(true);
    $token=function(array $claims,array $header=['typ'=>'JWT','alg'=>'HS256'])use($jwtKey):string{$h=base64_encode(json_encode($header));$p=base64_encode(json_encode($claims));return $h.'.'.$p.'.'.base64_encode(hash_hmac('sha256',$h.'.'.$p,$jwtKey,true));};
    secureCheck($decode->invoke($auth,$token(['admin_id'=>1,'exp'=>time()+60]))!==null,'valid admin token');
    foreach([['admin_id'=>1],['admin_id'=>1,'exp'=>time()-1],['admin_id'=>1,'exp'=>'9999999999'],['admin_id'=>1,'exp'=>time()+86401]]as$claims)secureCheck($decode->invoke($auth,$token($claims))===null,'invalid expiry');
    secureCheck($decode->invoke($auth,$token(['admin_id'=>1,'exp'=>time()+60],['alg'=>'none','typ'=>'JWT']))===null,'algorithm confusion');
    secureCheck($decode->invoke($auth,'bad.bad.bad')===null,'malformed token');secureReject(fn()=>new Auth(null,['jwt_secret'=>''],null),'empty signing key');

    $openssl=dirname(__DIR__).'/ssl/openssl.cnf';$key=openssl_pkey_new(['config'=>$openssl,'private_key_bits'=>2048]);openssl_pkey_export($key,$private,null,['config'=>$openssl]);$public=openssl_pkey_get_details($key)['key'];
    $input=PaymentConfiguration::defaults();$input['enabled']=true;$input['environment']='sandbox';$input['app_id']='2026000000000001';$input['seller_id']='2088000000000001';$input['public_url']='https://payment.example.invalid';$input['private_key']=$private;$input['public_key']=$public;$input['revision']=0;
    $store=new PaymentConfiguration($db,$crypto);$store->locked(fn()=>$store->save($store->candidate($input),0,1));
    secureCheck(!str_contains($store->row()['envelope'],$private),'SQL contains no private key');secureCheck(!str_contains(json_encode($store->publicState()),'BEGIN'),'public response redacted');
    $beforeSave=$store->row();$db->exec("CREATE TRIGGER fixture_reject_payment_audit BEFORE INSERT ON admin_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated audit failure'");
    $rollbackConfig=$store->load();$rollbackConfig['enabled']=false;secureReject(fn()=>$store->locked(fn()=>$store->save($rollbackConfig,1,1)),'audit failure rolls back configuration');$db->exec('DROP TRIGGER fixture_reject_payment_audit');
    secureCheck($store->row()['envelope']===$beforeSave['envelope']&&(int)$store->row()['revision']===1,'configuration revision and ciphertext unchanged after failed save');
    $weak=openssl_pkey_new(['config'=>$openssl,'private_key_bits'=>1024]);openssl_pkey_export($weak,$weakPem,null,['config'=>$openssl]);secureReject(fn()=>PaymentMaterials::rsa($weakPem,true),'weak RSA key');
    $now=intdiv(time(),30)*30+5;$security=new PaymentAdminSecurity($db,$store,static function()use(&$now){return $now;});
    $bootstrap=$store->locked(fn()=>$security->bootstrap(1));$enroll=$store->locked(fn()=>$security->beginEnrollment(1,'fixture-password',$bootstrap));$secret=$enroll['secret'];$otp=\OTPHP\TOTP::create($secret,30,'sha1',6);
    $action=$store->locked(fn()=>$security->authorize(1,$enroll['challenge_id'],'fixture-password',$otp->at($now)));secureCheck($action['type']==='enrolled','server authorized MFA enrollment');
    $seedRow=$db->query('SELECT * FROM payment_admin_mfa WHERE admin_id=1')->fetch();secureCheck(!str_contains($seedRow['envelope'],$secret),'MFA seed encrypted');
    secureReject(fn()=>$store->locked(fn()=>$security->beginEnrollment(1,'fixture-password',$bootstrap)),'bootstrap replay');
    $db->exec('DELETE FROM payment_auth_attempts');$now+=30;
    $challenge=$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>$store->load()]));
    $authorized=$store->locked(fn()=>$security->authorize(1,$challenge['challenge_id'],'fixture-password',$otp->at($now)));secureCheck($authorized['type']==='save','password and OTP authorization');
    secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$challenge['challenge_id'],'fixture-password',$otp->at($now))),'challenge replay');
    $next=$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>$store->load()]));secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$next['challenge_id'],'fixture-password',$otp->at($now))),'OTP time step replay');
    $now+=30;secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$next['challenge_id'],'wrong-password',$otp->at($now))),'wrong password');
    $now+=121;secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$next['challenge_id'],'fixture-password',$otp->at($now))),'expired challenge');
    $db->exec('DELETE FROM payment_auth_attempts');
    $blocked=$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>$store->load()]));
    for($i=0;$i<5;$i++)secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$blocked['challenge_id'],'wrong-password','000000')),'rate failure '.$i);
    secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$blocked['challenge_id'],'fixture-password',$otp->at($now))),'rate lockout');
    secureCheck((int)$db->query('SELECT MAX(blocked_until) FROM payment_auth_attempts')->fetchColumn()===$now+900,'15 minute rate block');
    $now+=901;$db->exec('DELETE FROM payment_challenges');
    $mismatch=$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>$store->load()]));
    $expiryAttack=$store->locked(fn()=>$security->prepare(1,['type'=>'save','configuration'=>$store->load()]));
    $db->prepare('UPDATE payment_challenges SET expires_at=expires_at+1 WHERE id=?')->execute([$expiryAttack['challenge_id']]);
    secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$expiryAttack['challenge_id'],'fixture-password',$otp->at($now))),'challenge metadata tamper');
    $candidate=$store->load();$candidate['enabled']=false;$store->locked(fn()=>$store->save($candidate,1,1));
    secureReject(fn()=>$store->locked(fn()=>$security->authorize(1,$mismatch['challenge_id'],'fixture-password',$otp->at($now))),'revision changed after challenge');
    $db->exec('DELETE FROM payment_challenges');
    $recovery=$store->locked(fn()=>$security->bootstrap(1));secureReject(fn()=>$store->locked(fn()=>$security->beginEnrollment(1,'fixture-password','not-authorized')),'recovery authorization required');
    $rebind=$store->locked(fn()=>$security->beginEnrollment(1,'fixture-password',$recovery));$newOtp=\OTPHP\TOTP::create($rebind['secret'],30,'sha1',6);
    $store->locked(fn()=>$security->authorize(1,$rebind['challenge_id'],'fixture-password',$newOtp->at($now)));secureCheck($security->status(1)['bound'],'MFA recovery with new authenticator');

    $candidate=$store->load();$candidate['enabled']=true;$store->locked(fn()=>$store->save($candidate,2,1));
    $membership=new MembershipService($db);$payment=new PaymentService($membership,AlipayGateway::fromDatabase($db));$order=$payment->create(1,$membership->plans()[1]['id'],'security_order_request_123')['order'];
    $change=['revision'=>3,'app_id'=>'2026000000000002'];secureReject(fn()=>$store->candidate($change),'pending order blocks identity change');
    $disabled=$store->candidate(['revision'=>3,'enabled'=>false]);$store->locked(fn()=>$store->save($disabled,3,1));secureCheck(!$store->load()['enabled'],'purchase switch may close with pending orders');
    secureReject(fn()=>$store->candidate(['revision'=>3,'enabled'=>true]),'stale revision');secureReject(fn()=>$store->legacy(),'no legacy reimport');

    $response=function(string $method,array $body)use($key):string{$json=json_encode($body,JSON_UNESCAPED_SLASHES);openssl_sign($json,$sig,$key,OPENSSL_ALGO_SHA256);return '{"'.str_replace('.','_',$method).'_response":'.$json.',"sign":"'.base64_encode($sig).'"}';};
    $mock=function(array $bodies){\AlibabaCloud\Tea\Tea::config(['handler'=>\GuzzleHttp\HandlerStack::create(new \GuzzleHttp\Handler\MockHandler(array_map(fn($body)=>new \GuzzleHttp\Psr7\Response(200,[],$body),$bodies)))]);};
    $trade=['code'=>'10000','out_trade_no'=>$order['order_no'],'trade_no'=>'20261003123456789001','total_amount'=>'8.00','trade_status'=>'WAIT_BUYER_PAY'];
    $mock([$response('alipay.trade.query',$trade),$response('alipay.trade.close',['code'=>'10000','out_trade_no'=>$order['order_no']]),$response('alipay.trade.query',$trade+[])]);
    secureReject(fn()=>$payment->settle($order['order_no']),'close must be reconfirmed');secureCheck($membership->paymentOrder($order['order_no'])['status']==='pending','uncertain closure retains order');
    $closed=$trade;$closed['trade_status']='TRADE_CLOSED';$mock([$response('alipay.trade.query',$trade),$response('alipay.trade.close',['code'=>'10000','out_trade_no'=>$order['order_no']]),$response('alipay.trade.query',$closed)]);
    secureCheck($payment->settle($order['order_no'])['status']==='closed','verified closure');
    secureCheck($payment->settle($order['order_no'])['status']==='closed','idempotent settlement');
    $nonexistent=$membership->createPaymentOrder(1,$membership->plans()[1]['id'],'security_missing_order_123',$store->load())['order'];
    $absent=['code'=>'40004','msg'=>'Business Failed','sub_code'=>'ACQ.TRADE_NOT_EXIST','sub_msg'=>'Trade not exist'];
    $mock(['{"alipay_trade_query_response":'.json_encode($absent).'}']);secureReject(fn()=>$payment->settle($nonexistent['order_no']),'unsigned nonexistent response cannot close');
    $mock([$response('alipay.trade.query',$absent)]);secureReject(fn()=>$payment->settle($nonexistent['order_no']),'nonexistent trade before expiry remains blocked');secureCheck($membership->paymentOrder($nonexistent['order_no'])['status']==='pending','not-yet-expired absent trade retains pending status');
    $past=(new DateTimeImmutable('now',new DateTimeZone('Asia/Shanghai')))->modify('-1 minute')->format('Y-m-d H:i:s');$db->prepare('UPDATE membership_orders SET expires_at=? WHERE order_no=?')->execute([$past,$nonexistent['order_no']]);
    $mock([$response('alipay.trade.query',$absent)]);secureCheck($payment->settle($nonexistent['order_no'])['status']==='closed','signed nonexistent response closes only after expiry');
    // Legacy import must not deadlock pre-migration orders that belong to the same merchant.
    $snapshot=$store->row();$db->exec("UPDATE membership_orders SET status='expired' WHERE order_no='".$order['order_no']."'");$db->exec('UPDATE payment_settings SET envelope=NULL,revision=0,imported=0 WHERE id=1');
    foreach(['ALIPAY_ENABLED'=>'false','ALIPAY_ENVIRONMENT'=>'sandbox','ALIPAY_SIGN_MODE'=>'public_key','ALIPAY_APP_ID'=>'2026000000000001','ALIPAY_SELLER_ID'=>'2088000000000001','ALIPAY_PUBLIC_URL'=>'https://payment.example.invalid','ALIPAY_PRIVATE_KEY_FILE'=>$root.'/import-private.pem','ALIPAY_PUBLIC_KEY_FILE'=>$root.'/import-public.pem']as$env=>$value)putenv($env.'='.$value);
    file_put_contents($root.'/import-private.pem',$private);file_put_contents($root.'/import-public.pem',$public);
    $legacy=$store->locked(fn()=>$store->legacy());$store->locked(fn()=>$store->save($legacy,0,1,true));secureCheck($store->row()['imported']==1,'initial import preserves matching outstanding orders');
    $db->exec('UPDATE payment_settings SET envelope=NULL,revision=0,imported=0 WHERE id=1');putenv('ALIPAY_SELLER_ID=2088000000000002');secureReject(fn()=>$store->legacy(),'import rejects mismatched outstanding merchant');
    $db->prepare('UPDATE payment_settings SET envelope=?,revision=?,imported=? WHERE id=1')->execute([$snapshot['envelope'],$snapshot['revision'],$snapshot['imported']]);$db->prepare("UPDATE membership_orders SET status='closed' WHERE order_no=?")->execute([$order['order_no']]);
    $mock(['{"alipay_trade_close_response":{"code":"10000","out_trade_no":"'.$order['order_no'].'"}}']);secureReject(fn()=>(new AlipayGateway($store->runtime()))->close($membership->paymentOrder($order['order_no'])),'unsigned close response');
    $altered=$response('alipay.trade.query',$closed);$mock([str_replace('8.00','0.01',$altered)]);secureReject(fn()=>(new AlipayGateway($store->runtime()))->query($membership->paymentOrder($order['order_no'])),'tampered query response');
    $history=[];$redirectStack=\GuzzleHttp\HandlerStack::create(new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(302,['Location'=>'https://attacker.invalid/gateway.do']),new \GuzzleHttp\Psr7\Response(200,[],$response('alipay.trade.query',$closed))]));$redirectStack->push(\GuzzleHttp\Middleware::history($history));\AlibabaCloud\Tea\Tea::config(['handler'=>$redirectStack]);
    secureReject(fn()=>(new AlipayGateway($store->runtime()))->query($membership->paymentOrder($order['order_no'])),'gateway redirect rejected');secureCheck(count($history)===1&&$history[0]['request']->getUri()->getHost()==='openapi-sandbox.dl.alipaydev.com','no request to redirected gateway');

    $sslConf=$root.'/cert.cnf';file_put_contents($sslConf,"[req]\ndistinguished_name=dn\n[dn]\nCN=fixture\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
    $caKey=openssl_pkey_new(['config'=>$sslConf,'private_key_bits'=>2048]);$caCsr=openssl_csr_new(['commonName'=>'fixture-root'],$caKey,['config'=>$sslConf]);$ca=openssl_csr_sign($caCsr,null,$caKey,365,['config'=>$sslConf,'x509_extensions'=>'ca'],123);openssl_x509_export($ca,$caPem);
    $csr=openssl_csr_new(['commonName'=>'fixture-merchant'],$key,['config'=>$sslConf]);$leaf=openssl_csr_sign($csr,$ca,$caKey,30,['config'=>$sslConf,'x509_extensions'=>'leaf'],456);openssl_x509_export($leaf,$leafPem);
    $certConfig=$store->load();$certConfig['enabled']=true;$certConfig['mode']='certificate';$certConfig['app_cert']=$leafPem;$certConfig['alipay_cert']=$leafPem;$certConfig['root_cert']=$caPem;$pin=openssl_x509_fingerprint($caPem,'sha256');
    secureCheck(PaymentMaterials::validate($certConfig,[$pin],true)===[],'signed leaf certificates with pinned root');secureReject(fn()=>PaymentMaterials::validate($certConfig,[],true),'untrusted root');
    $bad=$certConfig;$bad['private_key']=$weakPem;secureReject(fn()=>PaymentMaterials::validate($bad,[$pin],true),'weak certificate private key');
    $other=openssl_pkey_new(['config'=>$openssl,'private_key_bits'=>2048]);openssl_pkey_export($other,$otherPem,null,['config'=>$openssl]);$bad=$certConfig;$bad['private_key']=$otherPem;secureReject(fn()=>PaymentMaterials::validate($bad,[$pin],true),'certificate private key mismatch');
    $expired=openssl_csr_sign($csr,$ca,$caKey,-1,['config'=>$sslConf,'x509_extensions'=>'leaf'],789);openssl_x509_export($expired,$expiredPem);$bad=$certConfig;$bad['alipay_cert']=$expiredPem;secureReject(fn()=>PaymentMaterials::validate($bad,[$pin],true),'expired certificate');
    $tampered=$certConfig;$tampered['root_cert']=$leafPem;secureReject(fn()=>PaymentMaterials::validate($tampered,[$pin],true),'substituted root');
    file_put_contents($sslConf,"\n[encryption_leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,keyEncipherment\n[unknown_leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.3.4=critical,DER:05:00\n[restricted_leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nnameConstraints=permitted;DNS:.example.invalid\n[ca_zero]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n[ca_one]\nbasicConstraints=critical,CA:TRUE,pathlen:1\nkeyUsage=critical,keyCertSign,cRLSign\n[bad_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature\n",FILE_APPEND);
    foreach(['encryption_leaf'=>'encryption-only leaf','unknown_leaf'=>'unknown critical extension','restricted_leaf'=>'unhandled name constraints']as$section=>$message){
        $restricted=openssl_csr_sign($csr,$ca,$caKey,30,['config'=>$sslConf,'x509_extensions'=>$section],790);secureCheck($restricted!==false,'generate '.$message);openssl_x509_export($restricted,$restrictedPem);
        $bad=$certConfig;$bad['alipay_cert']=$restrictedPem;secureReject(fn()=>PaymentMaterials::validate($bad,[$pin],true),$message);
    }
    $bad=$certConfig;$bad['alipay_cert']=$caPem;secureReject(fn()=>PaymentMaterials::validate($bad,[$pin],true),'CA cannot act as payment leaf');
    $limitCsr=openssl_csr_new(['commonName'=>'fixture-limit-root'],$caKey,['config'=>$sslConf]);$limitRoot=openssl_csr_sign($limitCsr,null,$caKey,365,['config'=>$sslConf,'x509_extensions'=>'ca_zero'],791);openssl_x509_export($limitRoot,$limitRootPem);
    $intermediateCsr=openssl_csr_new(['commonName'=>'fixture-intermediate'],$caKey,['config'=>$sslConf]);$intermediate=openssl_csr_sign($intermediateCsr,$limitRoot,$caKey,30,['config'=>$sslConf,'x509_extensions'=>'ca_zero'],792);openssl_x509_export($intermediate,$intermediatePem);
    $nested=openssl_csr_sign($csr,$intermediate,$caKey,30,['config'=>$sslConf,'x509_extensions'=>'leaf'],793);openssl_x509_export($nested,$nestedPem);
    $nestedConfig=$certConfig;$nestedConfig['app_cert']=$nestedPem.$intermediatePem;$nestedConfig['alipay_cert']=$nestedPem.$intermediatePem;$nestedConfig['root_cert']=$limitRootPem;
    secureReject(fn()=>PaymentMaterials::validate($nestedConfig,[openssl_x509_fingerprint($limitRootPem,'sha256')],true),'CA path length prevents intermediate');
    $limitRootOne=openssl_csr_sign($limitCsr,null,$caKey,365,['config'=>$sslConf,'x509_extensions'=>'ca_one'],794);openssl_x509_export($limitRootOne,$limitRootOnePem);$nestedConfig['root_cert']=$limitRootOnePem;
    secureCheck(PaymentMaterials::validate($nestedConfig,[openssl_x509_fingerprint($limitRootOnePem,'sha256')],true)===[],'valid intermediate within CA path length');
    $badRoot=openssl_csr_sign($caCsr,null,$caKey,365,['config'=>$sslConf,'x509_extensions'=>'bad_ca'],795);openssl_x509_export($badRoot,$badRootPem);$bad=$certConfig;$bad['root_cert']=$badRootPem;
    secureReject(fn()=>PaymentMaterials::validate($bad,[openssl_x509_fingerprint($badRootPem,'sha256')],true),'root key usage cannot sign certificates');
    $ids=PaymentMaterials::sdkCertificates($certConfig);secureCheck(strlen($ids['merchantCertSN'])===32&&strlen($ids['alipayRootCertSN'])===32,'in-memory SDK certificate identifiers');

    $oldId=$crypto->activeId();PaymentKeyCommands::rotate($db,$keyPath);$rotated=PaymentKeyStore::crypto($db);secureCheck($rotated->activeId()!==$oldId,'master rotation');
    secureCheck((new PaymentConfiguration($db,$rotated))->load()['private_key']===trim($private),'configuration restored after rotation');
    $row=$db->query('SELECT * FROM payment_admin_mfa WHERE admin_id=1')->fetch();secureCheck($rotated->open($row['envelope'],'payment-mfa','1',(int)$row['revision'])['secret']===$rebind['secret'],'MFA rotated');
    secureCheck($rotated->open($box,'purpose','record',1)['secret']==='fixture-secret','old ciphertext backup recovery');
    $rotatedStore=new PaymentConfiguration($db,$rotated);$snapshot=$rotatedStore->row();$broken=json_decode($snapshot['envelope'],true);$broken['tag']=base64_encode(random_bytes(16));$db->prepare('UPDATE payment_settings SET envelope=? WHERE id=1')->execute([json_encode($broken)]);
    secureReject(fn()=>PaymentKeyCommands::rotate($db,$keyPath),'rotation failure');secureCheck(PaymentKeyStore::crypto($db)->activeId()===$rotated->activeId(),'failed rotation retains active key');
    $db->prepare('UPDATE payment_settings SET envelope=? WHERE id=1')->execute([$snapshot['envelope']]);secureCheck((new PaymentConfiguration($db,PaymentKeyStore::crypto($db)))->load()['private_key']===trim($private),'restored original after failed rotation');
    putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/missing-keyring.json');secureCheck(AlipayGateway::fromDatabase($db)->readiness()['ready'],'database keyring works without legacy file');putenv('PAYMENT_MASTER_KEY_FILE='.$keyPath);
    if(PHP_OS_FAMILY==='Windows'){
        $copy=$root.'/keys/insecure-keyring.json';copy($keyPath,$copy);$p=proc_open(['icacls.exe',$copy,'/grant','*S-1-1-0:(R)'],[1=>['pipe','w'],2=>['pipe','w']],$pipes);foreach($pipes as$pipe){stream_get_contents($pipe);fclose($pipe);}secureCheck(proc_close($p)===0,'ACL attack fixture');secureReject(fn()=>PaymentCrypto::checkPermissions($copy),'broad key ACL rejected');
    }
    $sqlDump=json_encode($db->query('SELECT envelope FROM payment_settings')->fetchAll()).json_encode($db->query('SELECT envelope FROM payment_admin_mfa')->fetchAll()).json_encode($db->query('SELECT details FROM admin_logs')->fetchAll());
    secureCheck(!str_contains($sqlDump,'BEGIN PRIVATE')&&!str_contains($sqlDump,$secret)&&!str_contains($sqlDump,$rebind['secret']),'database and audits redacted');

    secureCheck(PaymentTransport::notification('sign_type=RSA2&app_id=123')['app_id']==='123','notification parser');
    foreach(['app_id=x&app_id=y','app%5Fid=x&app_id=y','app_id[]=x','app_id=x%ZZ','app.id=x','app_id=x%00','bad']as$raw)secureReject(fn()=>PaymentTransport::notification($raw),'malformed notification');
    $server=$_SERVER;$_SERVER['HTTP_HOST']='payment.example.invalid';$_SERVER['HTTPS']='off';$_SERVER['HTTP_X_FORWARDED_PROTO']='https';$_SERVER['REMOTE_ADDR']='203.0.113.10';putenv('PAYMENT_TRUSTED_PROXIES=');secureReject(fn()=>PaymentTransport::enforce(),'untrusted TLS forwarding');
    $_SERVER['HTTPS']='on';$_SERVER['HTTP_ORIGIN']='https://attacker.invalid';secureReject(fn()=>PaymentTransport::enforce(),'cross origin');$_SERVER=$server;
    $localSetting=(string)env('PAYMENT_ALLOW_LOCAL_HTTP','false');
    $local=$server;foreach(['HTTP_ORIGIN','HTTP_FORWARDED','HTTP_X_FORWARDED_FOR','HTTP_X_FORWARDED_HOST','HTTP_X_FORWARDED_PROTO','HTTP_SEC_FETCH_SITE']as$header)unset($local[$header]);
    $local['HTTPS']='off';$local['HTTP_HOST']='localhost';$local['REMOTE_ADDR']='127.0.0.1';$_SERVER=$local;putenv('PAYMENT_ALLOW_LOCAL_HTTP=false');
    secureReject(fn()=>PaymentTransport::enforce(),'loopback HTTP disabled by default');putenv('PAYMENT_ALLOW_LOCAL_HTTP=true');PaymentTransport::enforce();secureCheck(true,'explicit direct loopback HTTP');
    $_SERVER['HTTP_ORIGIN']='http://localhost';PaymentTransport::enforce();secureCheck(true,'same-origin local HTTP');
    $_SERVER['HTTP_HOST']='localhost:80';PaymentTransport::enforce();secureCheck(true,'default origin port canonicalization');
    $_SERVER=$local;$_SERVER['HTTP_HOST']='localhost:8080';$_SERVER['HTTP_ORIGIN']='http://localhost:8080';PaymentTransport::enforce();secureCheck(true,'local HTTP with explicit port');
    foreach([
        ['HTTP_HOST'=>'localhost:8080','HTTP_ORIGIN'=>'http://localhost:8081'],
        ['HTTP_ORIGIN'=>'https://localhost'],['HTTP_ORIGIN'=>'http://attacker.invalid'],['HTTP_ORIGIN'=>'null'],
        ['HTTP_SEC_FETCH_SITE'=>'cross-site'],['HTTP_HOST'=>'attacker.invalid'],['HTTP_HOST'=>'192.168.1.2'],['REMOTE_ADDR'=>'192.168.1.2'],
        ['HTTP_X_FORWARDED_PROTO'=>'https'],['HTTP_X_FORWARDED_FOR'=>'127.0.0.1'],['HTTP_X_FORWARDED_HOST'=>'localhost'],['HTTP_FORWARDED'=>'for=127.0.0.1'],
        ['HTTP_HOST'=>'localhost:65536']
    ]as$overrides){$_SERVER=array_replace($local,$overrides);secureReject(fn()=>PaymentTransport::enforce(),'local HTTP boundary: '.implode(',',array_keys($overrides)));}
    $_SERVER=array_replace($local,['HTTP_HOST'=>'127.0.0.1','HTTP_ORIGIN'=>'http://127.0.0.1']);PaymentTransport::enforce();secureCheck(true,'IPv4 loopback HTTP');
    $_SERVER=array_replace($local,['HTTP_HOST'=>'[::1]:8080','HTTP_ORIGIN'=>'http://[::1]:8080','REMOTE_ADDR'=>'::1']);PaymentTransport::enforce();secureCheck(true,'IPv6 loopback HTTP');
    $_SERVER=$server;putenv('PAYMENT_ALLOW_LOCAL_HTTP='.$localSetting);
    echo "Payment security: PASS ($checks checks; AEAD, JWT, MFA, challenges, rate limits, certificates, SDK, rotation, parser)\n";
}finally{$db->exec('DROP DATABASE `'.$name.'`');secureCleanup($root);}
