<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/sql/migrate_membership.php';
function membershipTestDatabase(?string $name=null): array {
    require_once dirname(__DIR__).'/env_loader.php';
    // A deterministic isolated fixture key; never changes the real .env.
    putenv('JWT_SECRET='.hash('sha256','moonya-isolated-membership-admin-key'));
    $config=require dirname(__DIR__).'/config.php';
    if (!in_array($config['db_host'],['localhost','127.0.0.1','::1'],true)) throw new RuntimeException('Tests require local MySQL');
    $db=new PDO('mysql:host='.$config['db_host'].';charset=utf8mb4',$config['db_user'],$config['db_pass'],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    if ($name!==null && !preg_match('/^moonya_membership_test_[a-f0-9]{12}$/D',$name)) throw new RuntimeException('Invalid test database');
    if ($name===null) {
        $name='moonya_membership_test_'.bin2hex(random_bytes(6));
        $db->exec('CREATE DATABASE `'.$name.'` CHARACTER SET utf8mb4');
        $db->exec('USE `'.$name.'`');
        $db->exec("CREATE TABLE users (id INT PRIMARY KEY,username VARCHAR(50) DEFAULT 'fixture',status VARCHAR(20) DEFAULT 'active',api_token VARCHAR(100),token_created_at DATETIME NULL,ban_reason TEXT,ban_until DATETIME NULL,ulid VARCHAR(26)) ENGINE=InnoDB");
        $db->exec("INSERT INTO users (id,api_token) VALUES (1,'fixture-user')");
        initializeMembership($db,$config);
        require_once dirname(__DIR__).'/admin/Database.php';
        $adminConfig=require dirname(__DIR__).'/admin/config.php';$adminConfig['db_name']=$name;
        $adminDatabase=new Database($adminConfig);$adminDatabase->getConnection();$adminDatabase->initializeTables();
        $db->prepare('INSERT INTO admins (id,username,password,email,role) VALUES (1,?,?,?,?)')->execute(['membership-fixture',password_hash('fixture-password',PASSWORD_DEFAULT),'fixture@example.invalid','super_admin']);
    } else $db->exec('USE `'.$name.'`');
    $config['db_name']=$name;
    return [$db,$config,$name];
}
if (realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__) {
    [$db,$config,$name]=membershipTestDatabase(($argv[1]??'')==='create'?null:($argv[2]??''));
    switch ($argv[1]??'') {
        case 'create':
            $db->prepare("UPDATE builtin_models SET endpoint=?,api_key='fixture-key' WHERE id='deepseek-flash'")->execute([$argv[2]]);
            echo $name;break;
        case 'drop': $db->exec('DROP DATABASE `'.$name.'`');break;
        case 'auth':
            require_once dirname(__DIR__).'/admin/Auth.php';require_once dirname(__DIR__).'/admin/Logger.php';
            $adminConfig=require dirname(__DIR__).'/admin/config.php';
            echo (new Auth($db,$adminConfig,new Logger($adminConfig,$db)))->login('membership-fixture','fixture-password')['token'];break;
        case 'logs': echo json_encode($db->query('SELECT action,details FROM admin_logs ORDER BY id')->fetchAll());break;
        case 'inspect': echo json_encode(['account'=>(new MembershipService($db))->summary(1),'calls'=>$db->query('SELECT c.status,c.cost_units,c.charged_units FROM credit_calls c JOIN credit_ledger l ON l.call_id=c.id ORDER BY l.id')->fetchAll()]);break;
        case 'adjust': echo json_encode((new MembershipService($db))->adjust(1,$argv[3],'integration test',1));break;
        case 'settle':
            $clock=new DateTimeImmutable($argv[4],new DateTimeZone('Asia/Shanghai'));
            $service=new MembershipService($db,fn()=>$clock);
            echo json_encode($service->settle($argv[3],['prompt_tokens'=>1000,'completion_tokens'=>0]));break;
        default: throw new RuntimeException('Unknown fixture action');
    }
}
