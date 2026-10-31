<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/admin/Database.php';
$config = require dirname(__DIR__).'/admin/config.php';
$db = (new Database($config))->getConnection();
$db->exec((string)file_get_contents(dirname(__DIR__).'/sql/program_updates_schema.sql'));
if (!$db->query("SHOW COLUMNS FROM program_updates LIKE 'force_update'")->fetch()) {
    $db->exec('ALTER TABLE program_updates ADD COLUMN force_update TINYINT(1) NOT NULL DEFAULT 0');
}
echo "Program updates schema ready.\n";
