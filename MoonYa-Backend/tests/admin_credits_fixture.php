<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/env_loader.php';
$root = $argv[2] ?? '';
$prefix = str_replace('\\', '/', sys_get_temp_dir()).'/moonya-credits-http-';
if (!str_starts_with(str_replace('\\', '/', $root), $prefix) || !preg_match('/^moonya-credits-http-[a-f0-9]{16}$/D', basename($root))) throw new RuntimeException('Isolated credits test directory required');
putenv('MOONYA_DATA_ROOT='.$root.'/server');
require_once __DIR__.'/membership_fixture.php';
$action = $argv[1] ?? '';
[$db, $config, $name] = membershipTestDatabase($action === 'create' ? null : ($argv[3] ?? ''));
if ($action === 'create') {
    try {
        $db->exec("ALTER TABLE users ADD email VARCHAR(100), ADD real_name VARCHAR(100), ADD gender VARCHAR(20) DEFAULT 'private', ADD created_at DATETIME DEFAULT CURRENT_TIMESTAMP, ADD updated_at DATETIME DEFAULT CURRENT_TIMESTAMP");
        $db->exec("UPDATE users SET username='credit-fixture-1',email='one@example.invalid' WHERE id=1");
        $insert = $db->prepare('INSERT INTO users(id,username,email,status) VALUES(?,?,?,?)');
        for ($id = 2; $id <= 24; $id++) $insert->execute([$id, 'credit-fixture-'.$id, $id.'@example.invalid', $id === 3 ? 'banned' : ($id === 4 ? 'deleted' : 'active')]);
        $db->exec("UPDATE users SET real_name='<积分> & \"测试\"' WHERE id=2");
        $admin = $db->prepare('INSERT INTO admins(id,username,password,email,role) VALUES(?,?,?,?,?)');
        $admin->execute([2,'no-permission',password_hash('fixture-password',PASSWORD_DEFAULT),'none@example.invalid',null]);
        $admin->execute([3,'ordinary-admin',password_hash('fixture-password',PASSWORD_DEFAULT),'ordinary@example.invalid','admin']);
        $service = new MembershipService($db);
        for ($n = 0; $n < 25; $n++) $service->adjust(2, '0.000001', '分页测试', 1);
        echo json_encode(['database'=>$name]);
    } catch (Throwable $error) { $db->exec('DROP DATABASE `'.$name.'`'); throw $error; }
    exit;
}
if ($action === 'drop') { $db->exec('DROP DATABASE `'.$name.'`'); exit; }
if ($action === 'auth') {
    require_once dirname(__DIR__).'/admin/Auth.php';
    require_once dirname(__DIR__).'/admin/Logger.php';
    $adminConfig = require dirname(__DIR__).'/admin/config.php';
    echo (new Auth($db,$adminConfig,new Logger($adminConfig,$db)))->login($argv[4] ?? 'membership-fixture','fixture-password')['token'];
    exit;
}
if ($action === 'inspect') {
    echo json_encode(['balance'=>(new MembershipService($db))->summary(2)['balance'],
        'ledger'=>$db->query('SELECT * FROM credit_ledger WHERE user_id=2 ORDER BY id DESC')->fetchAll(),
        'logs'=>$db->query("SELECT * FROM admin_logs WHERE action='adjust_credits' ORDER BY id DESC")->fetchAll()]);
    exit;
}
if ($action === 'concurrent') {
    $service = new MembershipService($db);
    echo json_encode(($argv[4] ?? '') === 'adjust' ? $service->adjust(11,'0.25','并发增加',1) : $service->settle($argv[4],['prompt_tokens'=>1000,'completion_tokens'=>0]));
    exit;
}
if ($action !== 'service') throw new RuntimeException('Unknown fixture action');
$checks = 0;
function creditCheck(bool $ok, string $message): void { global $checks; $checks++; if (!$ok) throw new RuntimeException($message); }
$now = new DateTimeImmutable('2030-01-31 12:00:00',new DateTimeZone('Asia/Shanghai'));
$service = new MembershipService($db, static function() use (&$now) { return $now; });
$original = $service->summary(10);
creditCheck($service->adjust(10,'0.000001','  最小精度  ',1)['balance'] === '100.000001','Smallest fraction retained');
$last = $service->history(10)['items'][0];
creditCheck($last['details'] == ['admin_id'=>1,'reason'=>'最小精度'] && $last['delta'] === '0.000001','Reason trimmed and actor retained');
creditCheck($service->adjust(10,'-100.000001','扣至零',1)['balance'] === '0.000000','Subtract exactly to zero');
$before = $service->summary(10); $rows = $service->history(10)['total'];
foreach ([['-0.000001','过扣'],['0','零'],['-0.000000','零'],['1.0000001','超精度'],['1e2','指数'],[[],'类型'],[true,'类型'],['1','  '],['1',str_repeat('字',501)],['1000000000','超上限']] as [$delta,$reason]) {
    $rejected = false;
    try { $service->adjust(10,$delta,$reason,1); } catch (InvalidArgumentException $error) { $rejected = true; }
    creditCheck($rejected,'Invalid adjustment rejected');
    creditCheck($service->summary(10) === $before && $service->history(10)['total'] === $rows,'Rejection leaves balance and ledger unchanged');
}
creditCheck($service->adjust(10,'999999999',str_repeat('字',500),1)['balance'] === '999999999.000000','Maximum balance and reason accepted');
try { $service->adjust(10,'0.000001','超上限',1); throw new RuntimeException('Upper bound not enforced'); } catch (InvalidArgumentException $error) { creditCheck(true,'Balance above limit rejected'); }
creditCheck($service->summary(10)['period_id'] === $original['period_id'] && $service->summary(10)['period_allowance'] === '100.000000','Adjustments preserve period and allowance');
$now = $now->modify('+1 month');
creditCheck($service->summary(10)['balance'] === '100.000000','Monthly reset follows original rule');
foreach ([3,4,999] as $user) {
    foreach (['summary','adjust'] as $method) {
        try { $method === 'summary' ? $service->summary($user) : $service->adjust($user,'1','不可用用户',1); throw new RuntimeException('Unavailable user accepted'); }
        catch (InvalidArgumentException $error) { creditCheck(true,'Unavailable users rejected'); }
    }
}
$before = $service->summary(10); $rows = $service->history(10)['total'];
$db->exec("CREATE TRIGGER credit_fixture_reject BEFORE INSERT ON credit_ledger FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture ledger failure'");
try { $service->adjust(10,'1','流水失败',1); throw new RuntimeException('Ledger failure accepted'); }
catch (PDOException $error) { creditCheck(true,'Ledger failure surfaced'); }
finally { $db->exec('DROP TRIGGER credit_fixture_reject'); }
creditCheck($service->summary(10) === $before && $service->history(10)['total'] === $rows,'Ledger failure rolls back balance');
$live = new MembershipService($db);
$live->adjust(11,'-99','并发准备',1);
$model = (new BuiltinModelService($db,$config))->resolve('deepseek-flash');
$children = [];
for ($n = 0; $n < 8; $n++) {
    $operation = $n % 2 === 0 ? 'adjust' : $live->beginCall(11,$model);
    $process = proc_open([PHP_BINARY,__FILE__,'concurrent',$root,$name,$operation],[1=>['pipe','w'],2=>['pipe','w']],$pipes);
    $children[] = [$process,$pipes];
}
foreach ($children as [$process,$pipes]) {
    $output = stream_get_contents($pipes[1]); $error = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    creditCheck(proc_close($process) === 0 && is_array(json_decode($output,true)),'Concurrent process completed: '.$error);
}
creditCheck($live->summary(11)['balance'] === '1.400000','Concurrent adjustments and model charges serialize without lost updates');
echo json_encode(['checks'=>$checks]);
