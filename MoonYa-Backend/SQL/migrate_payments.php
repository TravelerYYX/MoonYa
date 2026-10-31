<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/Services/MembershipService.php';
require_once __DIR__.'/migrate_payment_security.php';

function initializePayments(PDO $db): void {
    $column=$db->query("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='membership_plans' AND column_name='tier_rank'")->fetchColumn();
    if (!$column) $db->exec('ALTER TABLE membership_plans ADD COLUMN tier_rank INT NULL UNIQUE');
    // Only known seed codes have a defined rank. Never infer custom ranks from price.
    $set=$db->prepare('UPDATE membership_plans SET tier_rank=? WHERE code=? AND tier_rank IS NULL');
    foreach (['free','go','plus','pro','max'] as $rank=>$code) $set->execute([$rank,$code]);
    $db->exec((string)file_get_contents(__DIR__.'/payment_schema.sql'));
    $deletedColumn=$db->query("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='membership_orders' AND column_name='user_deleted_at'")->fetchColumn();
    if (!$deletedColumn) $db->exec('ALTER TABLE membership_orders ADD COLUMN user_deleted_at DATETIME NULL');
    initializePaymentSecurity($db);
    $db->beginTransaction();
    try {
        $rows=$db->query('SELECT a.user_id,a.subscription_json,p.tier_rank FROM membership_accounts a JOIN membership_plans p ON p.id=a.plan_id FOR UPDATE')->fetchAll(PDO::FETCH_ASSOC);
        $update=$db->prepare('UPDATE membership_accounts SET subscription_json=? WHERE user_id=?');
        foreach ($rows as $row) {
            $snapshot=json_decode($row['subscription_json'],true,32,JSON_THROW_ON_ERROR);
            if (!isset($snapshot['tier_rank'])) {
                $snapshot['tier_rank']=$row['tier_rank']===null?null:(int)$row['tier_rank'];
                $update->execute([json_encode($snapshot,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$row['user_id']]);
            }
        }
        $db->commit();
    } catch (Throwable $error) { $db->rollBack(); throw $error; }
}
if (realpath($_SERVER['SCRIPT_FILENAME']??'')===__FILE__) {
    $config=require dirname(__DIR__).'/config.php';
    initializePayments(MembershipService::connect($config));
    fwrite(STDOUT,"支付迁移完成；原价格、积分、余额和已购权益均保留。\n");
}
