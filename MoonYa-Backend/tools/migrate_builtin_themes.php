<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once dirname(__DIR__).'/admin/Database.php';
$config = require dirname(__DIR__).'/admin/config.php';
$db = (new Database($config))->getConnection();
$db->exec((string)file_get_contents(dirname(__DIR__).'/sql/builtin_themes_schema.sql'));
echo "Builtin themes schema ready.\n";
