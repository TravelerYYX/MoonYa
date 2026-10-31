<?php
declare(strict_types=1);
require_once __DIR__.'/membership_fixture.php';
require_once dirname(__DIR__).'/sql/migrate_payments.php';
ob_start();
foreach(['ai_system_mysql8_schema.sql','数据库.sql'] as $file) {
    [$db,$config,$database]=membershipTestDatabase();
    try {
        $db->exec('SET FOREIGN_KEY_CHECKS=0');
        foreach($db->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $table)$db->exec('DROP TABLE `'.str_replace('`','``',$table).'`');
        $sql=(string)file_get_contents(dirname(__DIR__).'/sql/'.$file);
        $sql=str_replace('`ai_system`','`'.$database.'`',$sql);
        // Source schema must not select/create any database other than the isolated fixture.
        preg_match_all('/^\s*(?:CREATE\s+DATABASE(?:\s+IF\s+NOT\s+EXISTS)?|USE)\s+`([^`]+)`/im',$sql,$matches);
        foreach($matches[1] as $name)if($name!==$database)throw new RuntimeException('Unexpected database in import');
        $db->exec($sql);
        if($db->query("SHOW TABLES LIKE 'payment_email_limits'")->fetchColumn()!=='payment_email_limits')throw new RuntimeException('Import missing email send limits');
        initializeMembership($db,$config);
        $balances=$db->query('SELECT id,balance_units FROM credit_periods ORDER BY id')->fetchAll();
        initializePayments($db);initializePayments($db);
        if($balances!==$db->query('SELECT id,balance_units FROM credit_periods ORDER BY id')->fetchAll())throw new RuntimeException('Payment migration changed balances');
        if((int)$db->query('SELECT COUNT(*) FROM membership_orders')->fetchColumn()!==0)throw new RuntimeException('Payment migration created orders');
        if(array_map('intval',$db->query('SELECT tier_rank FROM membership_plans ORDER BY sort_order,id')->fetchAll(PDO::FETCH_COLUMN))!==[0,1,2,3,4])throw new RuntimeException('Missing payment ranks');
        if($db->query("SHOW COLUMNS FROM users LIKE 'vip_%'")->fetchAll()!==[])throw new RuntimeException('Old user fields');
        if($db->query("SHOW TABLES LIKE 'vip_codes'")->fetchAll()!==[])throw new RuntimeException('Old code table');
        if((int)$db->query('SELECT COUNT(*) FROM membership_plans')->fetchColumn()!==5)throw new RuntimeException('Missing catalog');
        echo $file.": import and migration PASS\n";
    } finally {
        if($db->inTransaction())$db->rollBack();
        $db->exec('DROP DATABASE `'.$database.'`');
    }
}
