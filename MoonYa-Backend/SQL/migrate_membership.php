<?php
declare(strict_types=1);
// Explicit CLI migration; serving a request never runs DDL or reseeds data.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__) . '/Services/BuiltinModelService.php';
function initializeMembership(PDO $db, array $config): void {
    $db->exec((string)file_get_contents(__DIR__ . '/membership_schema.sql'));
    $insert = $db->prepare('INSERT IGNORE INTO membership_plans (code,name,price_cents,monthly_units,description,features_json,is_free,sort_order) VALUES (?,?,?,?,?,?,?,?)');
    foreach ([['free','免费版',0,100],['go','GO',800,300],['plus','Plus',4000,1500],['pro','Pro',6000,2400],['max','Max',8800,3600]] as $index => $plan) {
        [$code,$name,$price,$credits]=$plan;
        $insert->execute([$code,$name,$price,$credits*MembershipService::SCALE,'每月 '.$credits.' 积分',json_encode([['title'=>'积分额度','items'=>['每月 '.$credits.' 积分','每月重置，剩余积分不结转']]],JSON_UNESCAPED_UNICODE),(int)($code==='free'),$index]);
    }
    $caps=['provider'=>'deepseek','context_window'=>1048576,'context_window_options'=>[300000,1048576],'max_output_tokens'=>393216,'supports_images'=>true,'supports_tools'=>true,'supports_thinking'=>true,'reasoning'=>'deepseek','efforts'=>['low','high','max'],'supports_tool_choice'=>false];
    $insert=$db->prepare('INSERT IGNORE INTO builtin_models (id,label,upstream_model,endpoint,api_key,capabilities_json,multiplier_units,is_default) VALUES (?,?,?,?,?,?,?,1)');
    $insert->execute(['deepseek-flash','DeepSeek 4.1 Flash','deepseek-flash',$config['deepseek_api_url'],'@env:DEEPSEEK_API_KEY',json_encode(BuiltinModelService::capabilities($caps)),150000]);
    // Existing users are initialized once. Old tier/expiry data is deliberately not mapped.
    $service=new MembershipService($db);
    foreach ($db->query("SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM membership_accounts)")->fetchAll(PDO::FETCH_COLUMN) as $user) $service->initializeUser((int)$user);
    foreach (['vip_level','vip_expire'] as $column) {
        $q=$db->prepare("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name=?");$q->execute([$column]);
        if ($q->fetchColumn()) $db->exec('ALTER TABLE users DROP COLUMN `'.$column.'`');
    }
    $db->exec('DROP TABLE IF EXISTS vip_codes');
}
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $config = require dirname(__DIR__) . '/config.php';
    initializeMembership(MembershipService::connect($config),$config);
    fwrite(STDOUT,"会员制度迁移完成；既有配置与账户未重复发放。\n");
}
