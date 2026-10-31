<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit(1);
$root = sys_get_temp_dir().'/moonya-themes-http-'.bin2hex(random_bytes(8));
foreach (['admin/api','api','Services','logs','uploads/themes','config'] as $directory) mkdir($root.'/'.$directory, 0700, true);
$source = dirname(__DIR__);
copy($source.'/admin/api/builtin_themes.php', $root.'/admin/api/builtin_themes.php');
copy($source.'/api/builtin_themes.php', $root.'/api/builtin_themes.php');
copy($source.'/Services/BuiltinThemeService.php', $root.'/Services/BuiltinThemeService.php');
copy($source.'/Services/RequestHeaders.php', $root.'/Services/RequestHeaders.php');

file_put_contents($root.'/env_loader.php', '<?php function env($key,$default=null){return $_ENV[$key]??getenv($key)?:$default;}');
$secret = str_repeat('theme-fixture-secret-', 3);
$config = '<?php return '.var_export(['jwt_secret'=>$secret,'log_path'=>$root.'/logs/'], true).';';
file_put_contents($root.'/config.php', $config);
file_put_contents($root.'/admin/config.php', $config);
file_put_contents($root.'/admin/Database.php', '<?php class Database { function __construct($config) {} function getConnection(){ $db=new PDO("sqlite:".dirname(__DIR__)."/themes.sqlite"); $db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION); $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE,PDO::FETCH_ASSOC); return $db; } }');
file_put_contents($root.'/admin/Auth.php', '<?php class Auth { function __construct($db,$config,$logger){} function authenticate($token){ return $token === "fixture-token" ? ["id"=>1,"username"=>"fixture","role"=>"admin"] : false; } function hasPermission($admin,$permission){ return true; } }');
file_put_contents($root.'/admin/Logger.php', '<?php class Logger { function __construct($config,$db){} function logAdminAction($adminId,$action,$target=null,$details=null){} }');

$_ENV['MAIN_API_DOMAIN'] = 'https://themes.example.test';
$_ENV['MOONYA_DATA_ROOT'] = $root.'/data';

$db = new PDO('sqlite:'.$root.'/themes.sqlite');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$db->exec("CREATE TABLE builtin_themes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE, name TEXT, summary TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
    colors TEXT DEFAULT '{}', blur INTEGER DEFAULT 0, shell_opacity REAL DEFAULT 0.85,
    background_kind TEXT DEFAULT 'image', background_fill TEXT DEFAULT 'cover',
    background_key TEXT DEFAULT '', thumb_key TEXT DEFAULT '',
    asset_sha256 TEXT DEFAULT '', asset_bytes INTEGER DEFAULT 0, asset_version INTEGER DEFAULT 1,
    admin_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);");
$hash = str_repeat('a', 64);
$db->exec("INSERT INTO builtin_themes (slug,name,summary,sort_order,enabled,colors,blur,shell_opacity,background_kind,background_fill,background_key,thumb_key,asset_sha256,asset_bytes,asset_version,admin_id,updated_at)
    VALUES ('forest','深林','林间',10,1,'{\"accent\":\"#7fd1a0\"}',12,0.8,'image','cover','forest/bg-$hash.webp','','$hash',2048,3,1,'2026-01-01 00:00:00')");
$db->exec("INSERT INTO builtin_themes (slug,name,summary,sort_order,enabled,colors,blur,shell_opacity,background_kind,background_fill,background_key,thumb_key,asset_sha256,asset_bytes,asset_version,admin_id,updated_at)
    VALUES ('hidden','下架主题','',20,0,'{}',0,0.85,'image','cover','hidden/bg.webp','','',0,1,1,'2026-01-01 00:00:00')");

$header = base64_encode(json_encode(['alg'=>'HS256','typ'=>'JWT']));
$payload = base64_encode(json_encode(['admin_id'=>1,'exp'=>time()+3600]));
$token = $header.'.'.$payload.'.'.base64_encode(hash_hmac('sha256',$header.'.'.$payload,$secret,true));
echo json_encode(['root'=>$root,'token'=>$token], JSON_THROW_ON_ERROR);
