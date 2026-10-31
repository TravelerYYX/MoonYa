<?php
declare(strict_types=1);
/**
 * MoonYa 数据目录（AppDataPaths）部署体检（CLI）。
 *
 * 触发场景：后台/登录接口返回
 *   500 {"success":false,"error":"服务器错误: 无法创建 MoonYa 数据目录"}
 * 该文案来自 Services/AppDataPaths.php 的 mkdir($path, 0700, true) 失败。
 * 常见原因（都不是代码问题，而是服务器侧）：
 *   1) .env 里没显式配置 MOONYA_SERVER_DATA_ROOT → 回退到「站点目录的上一级」；
 *   2) 解析出的路径不在 open_basedir 白名单内（宝塔默认只放行站点目录 + /tmp）；
 *   3) 目录对 PHP 运行用户（宝塔默认 www）不可写；
 *   4) putenv 被 disable_functions 禁用：loadEnv() 无法把 .env 写进真实进程环境，
 *      裸 getenv() 恒为 false。业务代码必须走 env_loader 的 env()。
 *      这也是「CLI 下体检 PASS、网页端照样 500」的原因——CLI 的 php-cli.ini 通常不禁用 putenv。
 *
 *   php 检测脚本/data_root_check.php
 *   php -d disable_functions=putenv 检测脚本/data_root_check.php   # 强制复现 FPM 行为
 *
 * 只读探测：仅创建 AppDataPaths 自身本来就需要的子目录，不写任何业务数据。
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once dirname(__DIR__).'/env_loader.php';
require_once dirname(__DIR__).'/Services/AppDataPaths.php';

$failures = 0;
function line(string $label, bool $ok, string $detail = '', string $hint = '', bool $warn = false): void {
    global $failures;
    $mark = $ok ? 'OK  ' : ($warn ? 'WARN' : 'FAIL');
    if (!$ok && !$warn) $failures++;
    fwrite(STDOUT, sprintf("[%s] %s%s\n", $mark, $label, $detail !== '' ? ' — '.$detail : ''));
    if (!$ok && $hint !== '') fwrite(STDOUT, '       → '.$hint."\n");
}

fwrite(STDOUT, "MoonYa 数据目录部署体检\n");
fwrite(STDOUT, str_repeat('=', 60)."\n");

/* 1. 运行环境 ------------------------------------------------------------ */
fwrite(STDOUT, "\n[运行环境]\n");
line('PHP 版本', version_compare(PHP_VERSION, '8.1.0', '>='), PHP_VERSION.' / '.PHP_OS_FAMILY);
line('SAPI', true, PHP_SAPI, 'CLI 与 FPM 的 ini / open_basedir 可能不同，最终以网页端为准。');
$uid = function_exists('posix_getuid') ? posix_getuid() : null;
$uname = ($uid !== null && function_exists('posix_getpwuid')) ? (posix_getpwuid($uid)['name'] ?? '') : '';
line('PHP 进程运行用户', true, $uid === null ? '(posix 扩展不可用)' : $uid.($uname !== '' ? ' / '.$uname : ''));

$openBasedir = (string) ini_get('open_basedir');
line('open_basedir 限制', $openBasedir === '', $openBasedir === '' ? '(未设置)' : $openBasedir,
    'CLI 通常不读 .user.ini 的 open_basedir；Web(FPM) 会生效。', true);

$putenvOff = !function_exists('putenv');
line('putenv 可用（.env 能否进入真实进程环境）', !$putenvOff,
    $putenvOff ? '已被 disable_functions 禁用' : '可用',
    '禁用时 loadEnv() 只能写 $_ENV/$_SERVER：业务代码必须用 env()，裸 getenv() 会静默拿到空值。', $putenvOff);

/* 2. .env 取值通道 ------------------------------------------------------- */
fwrite(STDOUT, "\n[.env 取值通道]\n");
$envFile = dirname(__DIR__).'/.env';
line('.env 文件可读', is_file($envFile) && is_readable($envFile), $envFile,
    '部署包默认不含 .env，需按 .env.server.example 在站点根创建。');
foreach ([
    ['MOONYA_DATA_ROOT', '桌面端专用，服务器不应设置（它优先于下面那个）'],
    ['MOONYA_SERVER_DATA_ROOT', '服务器专用'],
] as [$key, $note]) {
    $raw = function_exists('getenv') ? getenv($key) : false;
    $viaEnv = trim((string) env($key, ''));
    $diverged = ($raw === false || $raw === '') && $viaEnv !== '';
    line($key, !$diverged,
        '裸 getenv()='.($raw === false ? 'false' : "'".$raw."'")
        .'，env()='.($viaEnv === '' ? '(空)' : "'".$viaEnv."'").' — '.$note,
        '两者不一致即 putenv 被禁用的典型症状：只调 getenv() 的代码会读到空值并回退默认路径。',
        $diverged);
}

/* 3. 路径来源 ------------------------------------------------------------ */
fwrite(STDOUT, "\n[路径来源]\n");
fwrite(STDOUT, sprintf("       app 根目录        : %s\n", dirname(__DIR__)));
fwrite(STDOUT, sprintf("       上一级目录        : %s\n", dirname(__DIR__, 2)));

try {
    $resolved = AppDataPaths::root();
} catch (Throwable $e) {
    line('解析数据根目录', false, $e->getMessage(), 'MOONYA_SERVER_DATA_ROOT 必须是绝对路径（Linux 以 / 开头）。');
    fwrite(STDOUT, "\n".str_repeat('=', 60)."\n结果：FAIL（{$failures} 项）\n");
    exit(1);
}
fwrite(STDOUT, sprintf("       解析后的数据根    : %s\n", $resolved));
fwrite(STDOUT, sprintf("       取值来源          : %s\n", AppDataPaths::source()));

/* 4. 目录状态 ------------------------------------------------------------ */
fwrite(STDOUT, "\n[数据根目录状态]\n");
$parentOfRoot = dirname($resolved);
line('数据根所在父目录存在', is_dir($parentOfRoot), $parentOfRoot);
line('数据根目录已存在', is_dir($resolved), $resolved,
    '不存在时 PHP 会尝试 mkdir(0700, 递归)；父目录对运行用户不可写就会失败。');
if (is_dir($resolved)) {
    line('数据根目录可写', is_writable($resolved), 'mode='.substr(sprintf('%o', fileperms($resolved)), -4)
        .($uid !== null ? ' owner_uid='.fileowner($resolved) : ''),
        '执行 chown -R www:www <数据根> && chmod 700 <数据根>。');
} else {
    line('父目录可写（用于自动建目录）', is_writable($parentOfRoot),
        $parentOfRoot.($uid !== null ? ' owner_uid='.fileowner($parentOfRoot) : ''),
        '建议手工建好数据根并 chown 给运行用户，而不是依赖自动创建。');
}

/* 5. 必需子目录逐个探测 -------------------------------------------------- */
fwrite(STDOUT, "\n[必需子目录]\n");
$required = [
    ['temp', 'php-sessions'],   // session_save_path
    ['temp', 'web-attachments'],
    ['temp', 'ocr'],
    ['temp', 'downloads'],
    ['temp', 'locks'],
    ['temp', 'relay'],
    ['temp', 'client-links'],
    ['temp', 'vision'],
    ['temp', 'client-images'],
    ['logs', 'backend'],
    ['downloads'],
    ['crawler_output'],
    ['WorkLogMedia'],
];
foreach ($required as $parts) {
    $label = implode('/', array_slice($parts, 1));
    if ($parts[0] !== 'temp') $label = implode('/', $parts);
    try {
        AppDataPaths::directory(...$parts);
        line($label, true);
    } catch (Throwable $e) {
        line($label, false, $e->getMessage());
    }
}

fwrite(STDOUT, "\n".str_repeat('=', 60)."\n");
if ($failures === 0) {
    fwrite(STDOUT, "结果：PASS（数据目录可用）\n");
    fwrite(STDOUT, "提醒：CLI 与 Web(FPM) 的 ini / open_basedir 可能不同。\n");
    fwrite(STDOUT, "      网页端仍报错时，用 php -d disable_functions=putenv 复跑本脚本。\n");
    exit(0);
}
fwrite(STDOUT, "结果：FAIL（{$failures} 项）\n\n");
fwrite(STDOUT, AppDataPaths::diagnose(AppDataPaths::path('temp', 'php-sessions'))."\n");
exit(1);
