<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentService.php';
require_once dirname(__DIR__).'/Services/PaymentKeyCommands.php';
function paymentFixtureInitializeKey(string $root): string {
    paymentFixtureRoot($root);$directory=$root.'/keys';mkdir($directory,0700);
    if(PHP_OS_FAMILY==='Windows'){
        $script='$ErrorActionPreference="Stop"; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false); foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,"S-1-5-18","S-1-5-32-544")){ $s=New-Object System.Security.Principal.SecurityIdentifier($sid);$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,"FullControl","ContainerInherit,ObjectInherit","None","Allow"))) };[System.IO.Directory]::SetAccessControl($env:MOONYA_FIXTURE_KEYS,$a)';
        $environment=getenv();$environment['MOONYA_FIXTURE_KEYS']=$directory;
        $p=proc_open(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',base64_encode(iconv('UTF-8','UTF-16LE',$script))],[1=>['pipe','w'],2=>['pipe','w']],$pipes,null,$environment,['bypass_shell'=>true]);
        $out=stream_get_contents($pipes[1]);fclose($pipes[1]);$err=stream_get_contents($pipes[2]);fclose($pipes[2]);if(proc_close($p)!==0)throw new RuntimeException('Fixture ACL failed: '.$err);
    }
    $path=$directory.'/master-keyring.json';PaymentKeyCommands::initialize($path);putenv('PAYMENT_MASTER_KEY_FILE='.$path);return $path;
}
function paymentFixtureMerchant(string $root): array {
    return ['enabled'=>true,'environment'=>'sandbox','mode'=>'public_key','app_id'=>'2026000000000001','seller_id'=>'2088000000000001','private_key'=>(string)file_get_contents($root.'/private.pem'),'public_key'=>(string)file_get_contents($root.'/public.pem'),'app_cert'=>'','alipay_cert'=>'','root_cert'=>'','public_url'=>'https://payment.example.invalid'];
}
function paymentFixtureRoot(string $root): string {
    $expected=str_replace('\\','/',sys_get_temp_dir()).'/moonya-payment-http-';$normalized=str_replace('\\','/',$root);
    if(!str_starts_with($normalized,$expected)||!preg_match('/^moonya-payment-http-[a-f0-9]{16}$/D',basename($normalized)))throw new RuntimeException('Invalid test directory');
    return $root;
}
function paymentFixtureSign(array $params,string $root): array {
    $sorted=$params;unset($sorted['sign'],$sorted['sign_type']);ksort($sorted);
    $content=implode('&',array_map(fn($k)=>$k.'='.$sorted[$k],array_keys($sorted)));
    openssl_sign($content,$signature,(string)file_get_contents($root.'/private.pem'),OPENSSL_ALGO_SHA256);
    return $params+['sign_type'=>'RSA2','sign'=>base64_encode($signature)];
}
if(realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__){
    $action=$argv[1]??'';
    if($action==='create'){
        [$db,$config,$name]=membershipTestDatabase();$root=null;
        try {
        initializePayments($db);
        $db->exec("UPDATE admins SET email='fixture-admin@moonya.cn' WHERE id=1");
        $db->exec("INSERT INTO users (id,api_token) VALUES(2,'fixture-other-user')");
        $root=sys_get_temp_dir().'/moonya-payment-http-'.bin2hex(random_bytes(8));mkdir($root,0700);
        $openssl=dirname(__DIR__).'/ssl/openssl.cnf';$key=openssl_pkey_new(['config'=>$openssl,'private_key_bits'=>2048]);openssl_pkey_export($key,$private,null,['config'=>$openssl]);
        file_put_contents($root.'/private.pem',$private);file_put_contents($root.'/public.pem',openssl_pkey_get_details($key)['key']);
        $tlsCsr=openssl_csr_new(['commonName'=>'localhost'],$key,['config'=>$openssl]);$tlsCert=openssl_csr_sign($tlsCsr,null,$key,1,['config'=>$openssl],1);openssl_x509_export($tlsCert,$tlsPem);file_put_contents($root.'/tls.pem',$tlsPem);
        $master=paymentFixtureInitializeKey($root);$store=new PaymentConfiguration($db);$merchant=paymentFixtureMerchant($root);$input=$merchant;
        $input['revision']=0;$store->locked(fn()=>$store->save($store->candidate($input),0,1));
        require_once dirname(__DIR__).'/admin/Auth.php';require_once dirname(__DIR__).'/admin/Logger.php';
        $adminConfig=require dirname(__DIR__).'/admin/config.php';$auth=new Auth($db,$adminConfig,new Logger($adminConfig,$db));$token=$auth->login('membership-fixture','fixture-password')['token'];
        $db->prepare('INSERT INTO admins(username,password,email,role) VALUES(?,?,?,?)')->execute(['ordinary-payment-admin',password_hash('fixture-password',PASSWORD_DEFAULT),'ordinary@example.invalid','admin']);
        $ordinary=$auth->login('ordinary-payment-admin','fixture-password')['token'];
        echo json_encode(['database'=>$name,'root'=>$root,'admin_token'=>$token,'ordinary_token'=>$ordinary]);exit;
        } catch(Throwable $error) {
            $db->exec('DROP DATABASE `'.$name.'`');
            if($root!==null)foreach(['private.pem','public.pem']as$file)if(is_file($root.'/'.$file))unlink($root.'/'.$file);
            throw $error;
        }
    }
    $name=$argv[2]??'';$root=paymentFixtureRoot($argv[3]??'');[$db,$config]=membershipTestDatabase($name);
    $membership=new MembershipService($db);$merchant=paymentFixtureMerchant($root);
    switch($action){
        case 'probe_sandbox_environment':
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$gateway=AlipayGateway::fromDatabase($db,'sandbox');$store=new PaymentConfiguration($db);
            $store->locked(function()use($store){$next=$store->load();$next['environment']='production';$store->save($next,(int)$store->row()['revision'],1);});
            try{$gateway->withCurrent(fn()=>true);echo json_encode(['rejected'=>false]);}catch(RuntimeException $error){echo json_encode(['rejected'=>true]);}break;
        case 'set_payment_environment':
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$store=new PaymentConfiguration($db);$input=json_decode(stream_get_contents(STDIN),true,8,JSON_THROW_ON_ERROR);
            $store->locked(function()use($store,$input){$next=$store->load();$next['environment']=$input['environment'];$store->save($next,(int)$store->row()['revision'],1);});echo '{}';break;
        case 'smtp_tls_probe':
            require_once dirname(__DIR__).'/Services/PaymentEmailMailer.php';
            $input=json_decode(stream_get_contents(STDIN),true,8,JSON_THROW_ON_ERROR);$port=$input['port']??null;if(!is_int($port)||$port<1||$port>65535)throw new RuntimeException('Invalid fixture SMTP port');
            foreach(['SMTP_HOST'=>'localhost','SMTP_PORT'=>(string)$port,'SMTP_USER'=>'fixture-mailer@moonya.cn','SMTP_PASS'=>'isolated-fixture-password','SMTP_FROM'=>'fixture-mailer@moonya.cn','SMTP_ENCRYPTION'=>'smtps','SMTP_CA_FILE'=>'']as$key=>$value)putenv($key.'='.$value);
            try{(new PaymentEmailMailer())->checkConnection();echo json_encode(['rejected'=>false]);}catch(PaymentMailUnavailable $error){echo json_encode(['rejected'=>true]);}break;
        case 'clear_email_limits':$db->exec('DELETE FROM payment_email_limits');echo '{}';break;
        case 'disable_email':$db->exec("UPDATE admins SET email='' WHERE id=1");echo '{}';break;
        case 'seed_unsettled':
            $plan=$membership->plans()[1];$numbers=[];
            foreach([1,2]as$user){$created=$membership->createPaymentOrder($user,$plan['id'],bin2hex(random_bytes(16)),$merchant);$numbers[]=$created['order']['order_no'];}
            $db->prepare("UPDATE membership_orders SET status='expired',pending_user_id=NULL,checkout_hash=NULL WHERE order_no=?")->execute([$numbers[1]]);echo json_encode($numbers);break;
        case 'reset_for_import':$db->exec('UPDATE payment_settings SET envelope=NULL,revision=0,imported=0 WHERE id=1');$db->exec('DELETE FROM payment_auth_attempts');echo '{}';break;
        case 'authorize_password':
            require_once dirname(__DIR__).'/Services/PaymentPasswordSecurity.php';
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$store=new PaymentConfiguration($db);$security=new PaymentPasswordSecurity($db,$store);$input=json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);
            try{$authorized=$store->locked(fn()=>$security->authorize(1,$input['challenge_id'],$input['password']));echo json_encode(['success'=>true,'type'=>$authorized['type']]);}catch(Throwable $error){echo json_encode(['success'=>false]);}break;
        case 'authorize_email':
            require_once dirname(__DIR__).'/Services/PaymentEmailSecurity.php';
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$store=new PaymentConfiguration($db);$security=new PaymentEmailSecurity($db,$store);$input=json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);
            try{$authorized=$store->locked(fn()=>$security->authorize(1,$input['challenge_id'],$input['code']));echo json_encode(['success'=>true,'type'=>$authorized['type']]);}catch(Throwable $error){echo json_encode(['success'=>false]);}break;
        case 'query_tls':
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$input=json_decode(stream_get_contents(STDIN),true,8,JSON_THROW_ON_ERROR);$port=$input['port']??null;if(!is_int($port)||$port<1||$port>65535)throw new RuntimeException('Invalid fixture TLS port');
            $stack=\GuzzleHttp\HandlerStack::create();$stack->push(static function(callable $handler)use($port){return static function($request,array $options)use($handler,$port){return $handler($request->withUri(new \GuzzleHttp\Psr7\Uri('https://127.0.0.1:'.$port.'/gateway.do')),$options);};});\AlibabaCloud\Tea\Tea::config(['handler'=>$stack]);
            try{$gateway=AlipayGateway::fromDatabase($db);$gateway->query(['app_id'=>$merchant['app_id'],'seller_id'=>$merchant['seller_id'],'environment'=>$merchant['environment'],'order_no'=>'MY20261003123456fixture']);echo json_encode(['rejected'=>false]);}catch(Throwable $error){echo json_encode(['rejected'=>true,'certificate_error'=>str_contains(strtolower($error->getMessage()),'certificate')]);}break;
        case 'render_page':
            $_SERVER['HTTPS']='on';$_SERVER['HTTP_HOST']='payment.example.invalid';unset($_SERVER['HTTP_ORIGIN']);
            ob_start();require dirname(__DIR__).'/admin/dashboard.php';$html=ob_get_clean();echo json_encode(['html'=>$html]);break;
        case 'seed_mfa':
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$store=new PaymentConfiguration($db);$security=new PaymentAdminSecurity($db,$store,static fn()=>time()-30);
            $bootstrap=$store->locked(fn()=>$security->bootstrap(1));$enroll=$store->locked(fn()=>$security->beginEnrollment(1,'fixture-password',$bootstrap));$otp=\OTPHP\TOTP::create($enroll['secret'],30,'sha1',6);
            $store->locked(fn()=>$security->authorize(1,$enroll['challenge_id'],'fixture-password',$otp->at(time()-30)));
            echo json_encode(['code'=>$otp->at(time()),'next_code'=>$otp->at(time()+30),'secret'=>$enroll['secret']]);break;
        case 'authorize':
            putenv('PAYMENT_MASTER_KEY_FILE='.$root.'/keys/master-keyring.json');$store=new PaymentConfiguration($db);$security=new PaymentAdminSecurity($db,$store);$input=json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);
            try{$authorized=$store->locked(fn()=>$security->authorize(1,$input['challenge_id'],'fixture-password',$input['code']));echo json_encode(['success'=>true,'type'=>$authorized['type']]);}catch(Throwable $error){echo json_encode(['success'=>false]);}break;
        case 'sign':echo json_encode(paymentFixtureSign(json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR),$root));break;
        case 'notify':$payment=new PaymentService($membership,new AlipayGateway($merchant));echo json_encode($payment->notify(json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR)));break;
        case 'query_response':
            $trade=json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);$body=json_encode(['code'=>'10000','msg'=>'Success','out_trade_no'=>$trade['out_trade_no'],'trade_no'=>$trade['trade_no'],'total_amount'=>$trade['total_amount'],'trade_status'=>$trade['trade_status'],'send_pay_date'=>$trade['gmt_payment']],JSON_UNESCAPED_SLASHES);
            openssl_sign($body,$sig,(string)file_get_contents($root.'/private.pem'),OPENSSL_ALGO_SHA256);file_put_contents($root.'/query.json','{"alipay_trade_query_response":'.$body.',"sign":"'.base64_encode($sig).'"}');echo '{}';break;
        case 'inspect':echo json_encode(['orders'=>$db->query('SELECT order_no,status FROM membership_orders ORDER BY id')->fetchAll(),'purchases'=>(int)$db->query('SELECT COUNT(*) FROM membership_purchases')->fetchColumn(),'logs'=>$db->query('SELECT action,details FROM admin_logs ORDER BY id')->fetchAll(),'account'=>$membership->summary(1)]);break;
        case 'cleanup':
            $db->exec('DROP DATABASE `'.$name.'`');
            // Only these known fixture files are removed. Session files are retained in a temp test directory.
            foreach(['private.pem','public.pem','query.json','tls.pem']as$file)if(is_file($root.'/'.$file))unlink($root.'/'.$file);
            if(is_file($root.'/keys/master-keyring.json'))unlink($root.'/keys/master-keyring.json');if(is_dir($root.'/keys'))rmdir($root.'/keys');
            break;
        default:throw new RuntimeException('Unknown fixture action');
    }
}
