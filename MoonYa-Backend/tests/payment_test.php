<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
require_once dirname(__DIR__).'/Services/PaymentService.php';
require_once dirname(__DIR__).'/vendor/autoload.php';
$checks=0;
function paymentCheck(bool $value,string $message): void {global $checks;$checks++;if(!$value)throw new RuntimeException($message);}
function paymentRejects(Closure $action,string $message): void {try{$action();}catch(Throwable $e){paymentCheck(true,$message);return;}throw new RuntimeException('Expected rejection: '.$message);}

/** Only tests install this adapter. Production has no fake gateway environment switch. */
final class SimulatedPaymentGateway implements PaymentGateway {
    public array $trades=[];public bool $fail=false;
    public function __construct(private AlipayGateway $real) {}
    public function configuration(): array {return $this->real->configuration();}
    public function readiness(): array {return $this->real->readiness();}
    public function checkout(array $order): string {return $this->real->checkout($order);}
    public function verifyNotification(array $parameters): bool {return $this->real->verifyNotification($parameters);}
    public function query(array $order): ?array {if($this->fail)throw new RuntimeException('simulated network failure');return $this->trades[$order['order_no']]??null;}
    public function close(array $order): bool {if($this->fail)throw new RuntimeException('simulated network failure');$this->trades[$order['order_no']]['trade_status']='TRADE_CLOSED';return true;}
}
[$db,$config,$name]=membershipTestDatabase();
$tmp=sys_get_temp_dir().'/moonya-payment-'.bin2hex(random_bytes(8));mkdir($tmp,0700);
try {
    $opensslConfig=dirname(__DIR__).'/ssl/openssl.cnf';
    $key=openssl_pkey_new(['config'=>$opensslConfig,'private_key_bits'=>2048,'private_key_type'=>OPENSSL_KEYTYPE_RSA]);
    if(!$key)throw new RuntimeException('Cannot generate temporary RSA key');
    openssl_pkey_export($key,$private,null,['config'=>$opensslConfig]);
    $public=openssl_pkey_get_details($key)['key'];file_put_contents($tmp.'/private.pem',$private);file_put_contents($tmp.'/public.pem',$public);
    $merchant=['enabled'=>true,'environment'=>'sandbox','mode'=>'public_key','app_id'=>'2026000000000001','seller_id'=>'2088000000000001','private_key_file'=>$tmp.'/private.pem','public_key_file'=>$tmp.'/public.pem','app_cert_file'=>'','alipay_cert_file'=>'','root_cert_file'=>'','public_url'=>'https://payment.example.invalid'];
    $merchant['private_key']=$private;$merchant['public_key']=$public;
    $real=new AlipayGateway($merchant);$gateway=new SimulatedPaymentGateway($real);
    $before=$db->query('SELECT balance_units FROM credit_periods ORDER BY id')->fetchAll();
    initializePayments($db);initializePayments($db);
    paymentCheck($before===$db->query('SELECT balance_units FROM credit_periods ORDER BY id')->fetchAll(),'migration retains balances');
    $db->exec('INSERT INTO users(id,api_token) VALUES(2,"second-user"),(3,"third-user"),(4,"fourth-user"),(5,"fifth-user"),(6,"sixth-user"),(7,"seventh-user"),(8,"eighth-user")');
    $now=new DateTimeImmutable('2024-01-31 12:00:00',new DateTimeZone('Asia/Shanghai'));
    $membership=new MembershipService($db,static function()use(&$now){return $now;});$payment=new PaymentService($membership,$gateway);$plans=$membership->plans();
    paymentCheck(array_column($plans,'tier_rank')===[0,1,2,3,4],'known tiers');
    $sign=function(array $parameters)use($key):array {
        $parameters['sign_type']='RSA2';$sorted=$parameters;unset($sorted['sign'],$sorted['sign_type']);ksort($sorted);
        $content=implode('&',array_map(fn($k)=>$k.'='.$sorted[$k],array_keys($sorted)));
        openssl_sign($content,$signature,$key,OPENSSL_ALGO_SHA256);$parameters['sign']=base64_encode($signature);return $parameters;
    };
    $evidence=function(array $order)use($merchant,&$now):array{return ['app_id'=>$merchant['app_id'],'seller_id'=>$merchant['seller_id'],'out_trade_no'=>$order['order_no'],'trade_no'=>'20240000'.substr(hash('sha256',$order['order_no']),0,24),'total_amount'=>PaymentService::amount($order['amount_cents']),'trade_status'=>'TRADE_SUCCESS','gmt_payment'=>$now->format('Y-m-d H:i:s')];};
    $buy=function(int $user,int $plan)use($payment,$sign,$evidence):array{$created=$payment->create($user,$plan,bin2hex(random_bytes(16)));return $payment->notify($sign($evidence($created['order'])));};
    $first=$payment->create(2,$plans[1]['id'],'first_order_request_123');$again=$payment->create(2,$plans[1]['id'],'first_order_request_123');
    paymentCheck($first['order']['order_no']===$again['order']['order_no'],'request retry is idempotent');
    paymentRejects(fn()=>$payment->create(2,$plans[2]['id'],'another_order_request_123'),'one pending order');
    paymentRejects(fn()=>$payment->create(2,$plans[2]['id'],'first_order_request_123'),'key cannot change plan');
    parse_str(parse_url($again['checkout_url'],PHP_URL_QUERY),$query);$form=$payment->checkout($query['token']);
    paymentCheck(str_contains($form,'FAST_INSTANT_TRADE_PAY')&&str_contains($form,'time_expire')&&str_contains($form,'seller_id')&&!str_contains($form,$private),'real SDK checkout form, expiry and no private key');
    // Verify the actual outgoing SDK form signature with OpenSSL, independently of SDK signing.
    $doc=new DOMDocument();@$doc->loadHTML('<meta charset="utf-8">'.$form);$fields=[];foreach($doc->getElementsByTagName('input')as$input)if($input->getAttribute('name'))$fields[$input->getAttribute('name')]=$input->getAttribute('value');
    $signature=$fields['sign'];unset($fields['sign']);ksort($fields);$content=implode('&',array_map(fn($k)=>$k.'='.$fields[$k],array_keys($fields)));
    paymentCheck(openssl_verify($content,base64_decode($signature),$public,OPENSSL_ALGO_SHA256)===1,'real SDK request signature');
    paymentRejects(fn()=>$membership->paymentOrder($first['order']['order_no'],3),'order belongs to user');
    $params=$evidence($first['order']);$bad=$sign($params);$bad['total_amount']='0.01';paymentRejects(fn()=>$payment->notify($bad),'tampered notification');
    foreach(['app_id'=>'2026000000000099','seller_id'=>'2088000000000099','total_amount'=>'0.01','trade_no'=>'!invalid']as$field=>$value){$bad=$params;$bad[$field]=$value;paymentRejects(fn()=>$payment->notify($sign($bad)),'signed mismatched '.$field);}
    paymentCheck($membership->summary(2)['plan']['is_free'],'invalid payments do not grant');
    $paid=$payment->notify($sign($params));$a=$membership->summary(2);
    paymentCheck($a['balance']==='300.000000'&&$a['expires_at']==='2024-02-29 12:00:00','first purchase excludes free balance and leap expiry');
    $ledger=$membership->history(2);$payment->notify($sign($params));paymentCheck($ledger===$membership->history(2),'duplicate notification no extra ledger');
    paymentRejects(fn()=>$payment->checkout($query['token']),'paid checkout token revoked');
    $renew=$buy(2,$plans[1]['id']);$renew2=$buy(2,$plans[1]['id']);
    $a=$membership->summary(2);paymentCheck($a['balance']==='300.000000'&&count($a['queued_purchases'])===2,'renewal queues without resetting');
    paymentCheck($a['queued_purchases'][0]['ends_at']==='2024-03-31 12:00:00'&&$a['queued_purchases'][1]['ends_at']==='2024-04-30 12:00:00','anniversary survives February');
    $model=['id'=>'fixture','multiplier_units'=>1000000];$call=$membership->beginCall(2,$model);
    $membership->adjust(2,'-100','test spend',1);$now=$now->modify('+10 days');$upgrade=$buy(2,$plans[2]['id']);$a=$membership->summary(2);
    paymentCheck($a['balance']==='1700.000000'&&$a['expires_at']==='2024-03-10 12:00:00','upgrade combines remaining 200 and new 1500; resets duration');
    paymentCheck($a['queued_purchases'][0]['starts_at']===$a['expires_at'],'existing queue shifts after upgrade');
    $higher=$buy(2,$plans[3]['id']);paymentCheck($membership->summary(2)['balance']==='4100.000000','multiple upgrades retain balance');
    paymentCheck($membership->settle($call,['prompt_tokens'=>1000,'completion_tokens'=>0])['account']['balance']==='4099.000000','pre-upgrade call follows transfer chain');
    $membership->settle($call,['prompt_tokens'=>1000,'completion_tokens'=>0]);paymentCheck($membership->summary(2)['balance']==='4099.000000','late settle is idempotent');
    $downgrade=$buy(2,$plans[1]['id']);paymentCheck($downgrade['purchase']['status']==='queued','downgrade joins queue');
    $membership->grant(2,$plans[3]['id'],'2024-04-15 09:00:00',1);$a=$membership->summary(2);
    paymentCheck(count($a['queued_purchases'])===3&&$a['queued_purchases'][0]['starts_at']==='2024-04-15 09:00:00','admin grant preserves paid queue');
    $membership->adjust(2,'1','adjust without queue change',1);paymentCheck($membership->summary(2)['queued_purchases']===$a['queued_purchases'],'adjust does not shift queue');
    $now=new DateTimeImmutable('2024-04-15 09:00:00',new DateTimeZone('Asia/Shanghai'));$a=$membership->summary(2);
    paymentCheck($a['plan']['code']==='go'&&$a['balance']==='300.000000','queued plan becomes active with fresh monthly allowance');
    $now=new DateTimeImmutable('2024-06-20 09:00:00',new DateTimeZone('Asia/Shanghai'));$a=$membership->summary(2);
    paymentCheck($a['plan']['code']==='go'&&$a['balance']==='300.000000'&&$a['period_start']==='2024-06-15 09:00:00','offline skips expired queued periods');
    $now=new DateTimeImmutable('2024-08-20 09:00:00',new DateTimeZone('Asia/Shanghai'));paymentCheck($membership->summary(2)['plan']['is_free'],'queue exhausted returns free');
    $late=$payment->create(3,$plans[1]['id'],'late_payment_request_123');$now=$now->modify('+31 minutes');
    $gateway->trades[$late['order']['order_no']]=$evidence($late['order']);paymentCheck($payment->sync($late['order']['order_no'],3)['status']==='paid','late successful trade honored despite local expiry');
    $missed=$payment->create(4,$plans[2]['id'],'missed_notify_request_123');$gateway->trades[$missed['order']['order_no']]=$evidence($missed['order']);
    paymentCheck($payment->sync($missed['order']['order_no'],4)['purchase']['status']==='active','query compensates missing callback');
    $waiting=$payment->create(5,$plans[1]['id'],'network_failure_request_123');$gateway->fail=true;paymentRejects(fn()=>$payment->sync($waiting['order']['order_no'],5),'network failure retry');$gateway->fail=false;
    paymentCheck($membership->paymentOrder($waiting['order']['order_no'])['status']==='pending','network error retains pending state');
    $duplicate=$evidence($waiting['order']);$duplicate['trade_no']=$params['trade_no'];paymentRejects(fn()=>$payment->notify($sign($duplicate)),'provider trade reused across orders');
    paymentCheck($membership->paymentOrder($waiting['order']['order_no'])['status']==='pending'&&$membership->summary(5)['plan']['is_free'],'duplicate rollback atomic');
    $closed=$evidence($waiting['order']);$closed['trade_status']='TRADE_CLOSED';$payment->notify($sign($closed));paymentCheck($membership->paymentOrder($waiting['order']['order_no'])['pending_user_id']===null,'closed releases pending slot');
    $p=$membership->plans()[1];$p['monthly_credits']='301';$p['price_cents']=899;$membership->savePlan($p);
    $frozen=$payment->create(6,$p['id'],'snapshot_payment_request_123');$p['monthly_credits']='999';$p['enabled']=false;$membership->savePlan($p);$membership->deletePlan($p['id']);
    $payment->notify($sign($evidence($frozen['order'])));paymentCheck($membership->summary(6)['balance']==='301.000000','paid snapshot survives edit stop archive');
    $fresh=$plans[2];$fresh['id']=0;$fresh['code']='custom';$fresh['name']='Custom';$fresh['tier_rank']=20;$custom=$membership->savePlan($fresh);
    $unranked=$custom;$unranked['id']=0;$unranked['code']='unranked';unset($unranked['tier_rank']);paymentRejects(fn()=>$membership->savePlan($unranked),'new plan requires rank');
    $custom['tier_rank']=2;paymentRejects(fn()=>$membership->savePlan($custom),'tier rank unique');
    $disabled=$merchant;$disabled['enabled']=false;paymentCheck(!(new PaymentService($membership,new AlipayGateway($disabled)))->availability()['purchase_enabled'],'disabled config gates purchase');
    $missing=$merchant;$missing['private_key']='';paymentCheck(!(new AlipayGateway($missing))->readiness()['ready'],'missing config gates purchase');
    // Exercise the real SDK query response verification without touching Alipay's network.
    $raw=$membership->paymentOrder($missed['order']['order_no']);$body=json_encode(['code'=>'10000','msg'=>'Success','out_trade_no'=>$raw['order_no'],'trade_no'=>'2024000099999999','total_amount'=>'40.00','trade_status'=>'TRADE_SUCCESS','send_pay_date'=>$now->format('Y-m-d H:i:s')],JSON_UNESCAPED_SLASHES);
    openssl_sign($body,$sig,$key,OPENSSL_ALGO_SHA256);$response='{"alipay_trade_query_response":'.$body.',"sign":"'.base64_encode($sig).'"}';
    \AlibabaCloud\Tea\Tea::config(['handler'=>\GuzzleHttp\HandlerStack::create(new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(200,[],$response)]))]);
    paymentCheck($real->query($raw)['total_amount']==='40.00','official SDK verified query response');
    \AlibabaCloud\Tea\Tea::config(['handler'=>\GuzzleHttp\HandlerStack::create(new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(200,[],str_replace('40.00','0.01',$response))]))]);
    paymentRejects(fn()=>$real->query($raw),'SDK rejects altered query response');
    file_put_contents($tmp.'/cert.cnf',"[req]\ndistinguished_name=dn\n[dn]\nCN=fixture\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n");
    $certConfig=['config'=>$tmp.'/cert.cnf','digest_alg'=>'sha256','x509_extensions'=>'ca'];
    $csr=openssl_csr_new(['commonName'=>'Payment Test Certificate'],$key,$certConfig);
    $certificate=openssl_csr_sign($csr,null,$key,365,$certConfig,123);openssl_x509_export($certificate,$certificatePem);
    $leafCsr=openssl_csr_new(['commonName'=>'Payment Merchant Certificate'],$key,$certConfig);
    $leafCertificate=openssl_csr_sign($leafCsr,$certificate,$key,365,['config'=>$tmp.'/cert.cnf','digest_alg'=>'sha256','x509_extensions'=>'leaf'],124);openssl_x509_export($leafCertificate,$leafPem);
    file_put_contents($tmp.'/cert.pem',$certificatePem);
    $certMerchant=$merchant;$certMerchant['mode']='certificate';
    $certMerchant['_pins']=[openssl_x509_fingerprint($certificatePem,'sha256')];
    foreach(['app_cert_file','alipay_cert_file','root_cert_file']as$field)$certMerchant[$field]=$tmp.'/cert.pem';
    $certMerchant['app_cert']=$leafPem;$certMerchant['alipay_cert']=$leafPem;$certMerchant['root_cert']=$certificatePem;
    $certGateway=new AlipayGateway($certMerchant);
    paymentCheck($certGateway->readiness()['ready'],'certificate configuration valid');
    paymentCheck($certGateway->verifyNotification($sign($params)),'certificate notification verifies real signature');
    $certForm=$certGateway->checkout($raw);paymentCheck(str_contains($certForm,'app_cert_sn')&&str_contains($certForm,'alipay_root_cert_sn'),'certificate checkout contains certificate identifiers');
    $buy(7,$plans[2]['id']);$oldCall=$membership->beginCall(7,$model);$buy(7,$plans[3]['id']);
    $membership->settle($oldCall,['prompt_tokens'=>2000000,'completion_tokens'=>0]);
    paymentCheck($membership->summary(7)['balance']==='2400.000000','late source calls cannot consume more than the transferred allowance');
    $startCall=$membership->beginCall(7,$model);$buy(7,$plans[4]['id']);$now=$now->modify('+2 months');
    $newBalance=$membership->summary(7)['balance'];$membership->settle($startCall,['prompt_tokens'=>1000,'completion_tokens'=>0]);
    paymentCheck($membership->summary(7)['balance']===$newBalance,'late calls after expiry cannot spend fresh free period');
    $buy(8,$plans[2]['id']);$samePlan=$membership->plans()[1];$samePlan['tier_rank']=21;$membership->savePlan($samePlan);
    paymentCheck($buy(8,$plans[2]['id'])['purchase']['status']==='queued','same plan remains renewal after catalog rank edit');
    $db->exec("UPDATE users SET status='banned' WHERE id=8");paymentRejects(fn()=>$payment->create(8,$plans[3]['id'],'banned_request_123456'),'banned user cannot create orders');
    $fingerprint=$db->query('SELECT user_id,plan_id,anchor_at,expires_at,current_period_id,revision FROM membership_accounts ORDER BY user_id')->fetchAll();initializePayments($db);initializePayments($db);
    paymentCheck($fingerprint===$db->query('SELECT user_id,plan_id,anchor_at,expires_at,current_period_id,revision FROM membership_accounts ORDER BY user_id')->fetchAll(),'migration never resets paid accounts');
    echo "Payment integration: PASS ($checks checks; isolated MySQL, real RSA2 and SDK, rules, snapshots, retries, transfers)\n";
} finally {
    $db->exec('DROP DATABASE `'.$name.'`');
    foreach(glob($tmp.'/*')as$file)unlink($file);rmdir($tmp);
}
