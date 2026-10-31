<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/env_loader.php';
$name=getenv('MOONYA_TEST_DATABASE');
if(!is_string($name)||!preg_match('/^moonya_membership_test_[a-f0-9]{12}$/D',$name))throw new RuntimeException('Isolated test database required');
putenv('DB_NAME='.$name);$_ENV['DB_NAME']=$name;$_SERVER['DB_NAME']=$name;
putenv('JWT_SECRET='.hash('sha256','moonya-isolated-membership-admin-key'));
switch(parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH)) {
    case '/proxy':require dirname(__DIR__).'/api/model_proxy.php';break;
    case '/chat':require dirname(__DIR__).'/api.php';break;
    case '/plans':require dirname(__DIR__).'/admin/api/membership_plans.php';break;
    case '/models':require dirname(__DIR__).'/admin/api/builtin_models.php';break;
    case '/users':require dirname(__DIR__).'/admin/api/users.php';break;
    case '/catalog':require dirname(__DIR__).'/api/client_config.php';break;
    case '/membership':require dirname(__DIR__).'/api/membership.php';break;
    default:header('Content-Type: application/json');echo '{"ready":true}';
}
