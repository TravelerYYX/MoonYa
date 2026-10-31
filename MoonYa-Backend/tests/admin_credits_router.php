<?php
declare(strict_types=1);
$name = getenv('MOONYA_CREDITS_TEST_DATABASE');
$root = getenv('MOONYA_CREDITS_TEST_ROOT');
if (!is_string($name) || !preg_match('/^moonya_membership_test_[a-f0-9]{12}$/D',$name) || !is_string($root) ||
    !str_starts_with(str_replace('\\','/',$root),str_replace('\\','/',sys_get_temp_dir()).'/moonya-credits-http-') ||
    !preg_match('/^moonya-credits-http-[a-f0-9]{16}$/D',basename($root))) throw new RuntimeException('Isolated credits fixture required');
require_once dirname(__DIR__).'/env_loader.php';
foreach (['DB_NAME'=>$name,'MOONYA_DATA_ROOT'=>$root.'/server','JWT_SECRET'=>hash('sha256','moonya-isolated-membership-admin-key')] as $key=>$value) {
    putenv($key.'='.$value); $_ENV[$key]=$value; $_SERVER[$key]=$value;
}
$path = parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH);
if ($path === '/ready') { header('Content-Type: application/json'); echo '{"ready":true}'; return; }
if ($path === '/admin/api/users.php') { require dirname(__DIR__).'/admin/api/users.php'; return; }
if ($path === '/admin/dashboard.php') { require dirname(__DIR__).'/admin/dashboard.php'; return; }
if (str_starts_with($path,'/admin/assets/') && preg_match('~^/admin/assets/[a-z-]+\.(?:js|css)$~D',$path)) return false;
http_response_code(404);
