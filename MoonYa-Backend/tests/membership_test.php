<?php
declare(strict_types=1);
require_once dirname(__DIR__) . '/sql/migrate_membership.php';
require_once dirname(__DIR__) . '/Services/ClientConfig.php';
require_once dirname(__DIR__) . '/Services/BuiltinBilling.php';
function check(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function rejects(Closure $action, string $message): void { try { $action(); } catch (InvalidArgumentException|CreditsExhausted $error) { return; } throw new RuntimeException($message); }
$config=require dirname(__DIR__).'/config.php';
// This test creates and removes its own local database. Never change ai_system or a remote database.
if (!in_array($config['db_host'],['localhost','127.0.0.1','::1'],true)) throw new RuntimeException('Use a local MySQL test server');
$db=new PDO('mysql:host='.$config['db_host'].';charset=utf8mb4',$config['db_user'],$config['db_pass'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
$database='moonya_membership_test_'.bin2hex(random_bytes(6));
$db->exec('CREATE DATABASE `'.$database.'` CHARACTER SET utf8mb4');
try {
    $db->exec('USE `'.$database.'`');
    $db->exec("CREATE TABLE users (id INT PRIMARY KEY,status VARCHAR(20) DEFAULT 'active') ENGINE=InnoDB");
    initializeMembership($db,$config);
    $now=new DateTimeImmutable('2024-01-31 12:34:56',new DateTimeZone('Asia/Shanghai'));
    $service=new MembershipService($db,static function()use(&$now){return $now;});
    $db->exec('INSERT INTO users (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8)');
    $plans=$service->plans();check(count($plans)===5,'five initial plans');
    check(array_column($plans,'price_cents')===[0,800,4000,6000,8800],'prices in CNY cents');
    check(array_map(fn($p)=>(int)$p['monthly_credits'],$plans)===[100,300,1500,2400,3600],'monthly allowances');
    $a=$service->summary(1);check($a['balance']==='100.000000'&&$a['resets_at']==='2024-02-29 12:34:56','leap year anniversary');
    check($a['period_allowance']==='100.000000','summary exposes actual period allowance');
    $model=(new BuiltinModelService($db,$config))->resolve('deepseek-flash');check((int)$model['multiplier_units']===150000,'seed multiplier');
    $id=$service->beginCall(1,$model);
    $settlement=$service->settle($id,['prompt_tokens'=>700,'completion_tokens'=>300,'prompt_cache_hit_tokens'=>500,'completion_tokens_details'=>['reasoning_tokens'=>100]]);
    check($settlement['account']['balance']==='99.850000','1000 tokens cost 0.15, without double counting cache or reasoning');
    check($settlement['account']['period_allowance']==='100.000000','usage does not change period allowance');
    check($service->settle($id,['prompt_tokens'=>90000,'completion_tokens'=>90000])['account']['balance']==='99.850000','replay cannot debit twice');
    $id=$service->beginCall(1,$model);check($service->settle($id,null,'cancelled')['account']['balance']==='99.850000','missing usage is free');
    check($db->query("SELECT COUNT(*) FROM credit_calls WHERE status='usage_missing'")->fetchColumn()==1,'missing usage journal');
    $id=$service->beginCall(1,$model);$service->settle($id,['prompt_tokens'=>1000,'completion_tokens'=>0],'failed');
    check($service->summary(1)['balance']==='99.700000','failed requests with real usage still debit');
    rejects(fn()=>$service->adjust(1,'-999','invalid',1),'negative balance refused');
    $now=$now->modify('+29 days');$a=$service->summary(1);check($a['balance']==='100.000000'&&$a['resets_at']==='2024-03-31 12:34:56','Feb resets back to Jan31 anniversary');
    $now=new DateTimeImmutable('2025-01-31 12:34:56',new DateTimeZone('Asia/Shanghai'));
    $a=$service->summary(2);check($a['resets_at']==='2025-02-28 12:34:56','non-leap year month end');
    $pending=$service->beginCall(2,$model);$old=$a['period_id'];
    $now=new DateTimeImmutable('2025-05-31 12:34:56',new DateTimeZone('Asia/Shanghai'));
    $a=$service->summary(2);check($a['balance']==='100.000000'&&$a['resets_at']==='2025-06-30 12:34:56','offline months do not accumulate');
    check($service->settle($pending,['prompt_tokens'=>1000,'completion_tokens'=>0])['account']['balance']==='100.000000','old calls cannot debit refreshed points');
    check($db->query('SELECT balance_units FROM credit_periods WHERE id='.$old)->fetchColumn()==99850000,'old period receives settlement');
    $pro=$plans[3];$a=$service->grant(3,$pro['id'],'2025-08-31 12:34:56',1);check($a['balance']==='2400.000000','grant resets');
    rejects(fn()=>$service->grant(3,$pro['id'],'2025-02-31 00:00:00',1),'invalid date must not roll into another month');
    $pending=$service->beginCall(3,$model);$service->grant(3,$plans[1]['id'],null,1);
    check($service->settle($pending,['prompt_tokens'=>1000,'completion_tokens'=>0])['account']['balance']==='300.000000','switch isolates pending calls');
    $edited=$pro;$edited['monthly_credits']='1';$edited['enabled']=false;$service->savePlan($edited);
    $a=$service->grant(4,$plans[2]['id'],'2025-08-31 12:34:56',1);
    $plus=$plans[2];$plus['monthly_credits']='10';$plus['enabled']=false;$service->savePlan($plus);
    rejects(fn()=>$service->grant(5,$plus['id'],null,1),'disabled plans refuse new grant');
    $now=new DateTimeImmutable('2025-06-30 12:34:56',new DateTimeZone('Asia/Shanghai'));
    check($service->summary(4)['balance']==='1500.000000','existing subscription snapshot survives disable and allowance edits');
    check($service->summary(4)['period_allowance']==='1500.000000','period allowance survives catalog edits');
    $service->deletePlan($plus['id']);check($service->summary(4)['plan']['name']==='Plus','archive retains existing subscription');
    rejects(fn()=>$service->deletePlan($plans[0]['id']),'free cannot be deleted');
    $now=new DateTimeImmutable('2025-08-31 12:34:56',new DateTimeZone('Asia/Shanghai'));
    $a=$service->summary(4);check($a['plan']['is_free']&&$a['balance']==='100.000000'&&$a['resets_at']==='2025-09-30 12:34:56','expiry grants free period anchored to expiry');
    $service->adjust(5,'-99.9','small remainder',1);
    $c1=$service->beginCall(5,$model);$c2=$service->beginCall(5,$model);
    check($service->settle($c1,['prompt_tokens'=>1000,'completion_tokens'=>0])['exhausted'],'quota exhaustion');
    check($service->settle($c2,['prompt_tokens'=>1000,'completion_tokens'=>0])['account']['balance']==='0.000000','overlapping calls cap charges at zero');
    rejects(fn()=>$service->beginCall(5,$model),'zero balance blocks next call');
    check($db->query("SELECT SUM(charged_units) FROM credit_calls WHERE user_id=5")->fetchColumn()==100000,'charged points capped');
    $service->adjust(6,'-99.5','concurrent settlement fixture',1);
    $children=[];
    for($n=0;$n<8;$n++) {
        $call=$service->beginCall(6,$model);
        $pipes=[];
        $process=proc_open([PHP_BINARY,__DIR__.'/membership_fixture.php','settle',$database,$call,$now->format('Y-m-d H:i:s')],[1=>['pipe','w'],2=>['pipe','w']],$pipes);
        $children[]=[$process,$pipes];
    }
    foreach($children as [$process,$pipes]) {
        $output=stream_get_contents($pipes[1]);$error=stream_get_contents($pipes[2]);fclose($pipes[1]);fclose($pipes[2]);
        check(proc_close($process)===0,'concurrent settlement failed: '.$error);
        check(is_array(json_decode($output,true)),'concurrent settlement response');
    }
    check($service->summary(6)['balance']==='0.000000','simultaneous processes cannot overdraw');
    check((int)$db->query('SELECT SUM(charged_units) FROM credit_calls WHERE user_id=6')->fetchColumn()===500000,'concurrent charges bounded by original balance');
    $models=new BuiltinModelService($db,$config);
    $models->save(['id'=>'fixture','label'=>'Fixture','upstream_model'=>'supplier-real','endpoint'=>'https://example.invalid/v1/chat/completions','api_key'=>'secret-test-key','multiplier'=>'0.25','enabled'=>true,'is_default'=>true,'capabilities'=>['context_window'=>8192,'max_output_tokens'=>1024,'supports_tools'=>true]]);
    $list=$models->list();$public=moonyaClientConfig($config,$list);
    check($public['modelGroups']['deepseek']['default']==='fixture','backend-selected default');
    check(!str_contains(json_encode($public),'secret-test-key')&&!str_contains(json_encode($models->list(true)),'secret-test-key'),'no public/admin credential serialization');
    check($public['modelGroups']['deepseek']['models'][0]['multiplier']==='0.250000','real multiplier');
    $fixture=['id'=>'fixture','label'=>'Fixture','upstream_model'=>'supplier-real','endpoint'=>'https://example.invalid/v1/chat/completions','api_key'=>'secret-test-key','multiplier'=>'0','enabled'=>true,'is_default'=>true,'capabilities'=>['context_window'=>8192,'max_output_tokens'=>1024,'supports_tools'=>true]];
    $models->save($fixture);
    $freeModel=$models->resolve('fixture');
    check((int)$freeModel['multiplier_units']===0,'zero multiplier is saved');
    check($models->list(true)[0]['multiplier']==='0.000000','zero multiplier survives admin reload');
    $balance=$service->summary(1)['balance'];
    $freeCall=$service->beginCall(1,$freeModel);
    check($service->settle($freeCall,['prompt_tokens'=>1000,'completion_tokens'=>500])['account']['balance']===$balance,'zero multiplier usage does not debit credits');
    check((int)$db->query("SELECT cost_units FROM credit_calls WHERE id=".$db->quote($freeCall))->fetchColumn()===0,'zero multiplier cost is zero');
    rejects(fn()=>$models->save(array_replace($fixture,['multiplier'=>'-0.01'])),'negative multiplier refused');
    rejects(fn()=>$models->save(array_replace($fixture,['multiplier'=>'1000.01'])),'multiplier above 1000 refused');
    $wire=BuiltinBilling::payload(['model'=>'fixture','messages'=>[],'max_tokens'=>9000,'thinking'=>['type'=>'enabled'],'reasoning_effort'=>'high','stream'=>true],$models->resolve('fixture'));
    check($wire['model']==='supplier-real'&&$wire['max_tokens']===1024&&!isset($wire['thinking']),'upstream mapping and capabilities');
    $models->delete('fixture');check($models->list()[0]['id']==='deepseek-flash','default fallback');
    rejects(fn()=>$models->resolve('fixture'),'archived model refused');
    // Idempotent DDL, seeding, backfill and complete removal of the old schema.
    $before=$service->summary(1);$db->exec("INSERT INTO users(id,status) VALUES(9,'banned')");$db->exec('ALTER TABLE users ADD COLUMN vip_level INT DEFAULT 0, ADD COLUMN vip_expire DATETIME NULL');
    $db->exec('CREATE TABLE vip_codes (id INT)');initializeMembership($db,$config);initializeMembership($db,$config);
    check($db->query("SHOW COLUMNS FROM users LIKE 'vip_%'")->fetchAll()===[],'old columns removed');
    check($db->query("SHOW TABLES LIKE 'vip_codes'")->fetchAll()===[],'old codes removed');
    check((int)$db->query('SELECT COUNT(*) FROM membership_accounts WHERE user_id=9')->fetchColumn()===1,'banned existing users initialize once');
    // A fresh service using the frozen clock proves migration did not reset existing balances.
    check($service->summary(5)['balance']==='0.000000','migration never re-grants an initialized zero balance');
    check(count($models->list())===1&&count($service->plans())===3,'migration preserves archived/disabled catalog');
    echo "Membership MySQL integration: PASS (pricing, periods, actual usage, idempotency, overlapping calls, snapshots, migration, catalog secrecy)\n";
} finally {
    if (!preg_match('/^moonya_membership_test_[a-f0-9]{12}$/',$database)) throw new RuntimeException('Unexpected test database');
    $db->exec('DROP DATABASE `'.$database.'`');
}
