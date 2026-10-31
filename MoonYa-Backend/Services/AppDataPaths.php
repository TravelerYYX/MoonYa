<?php
declare(strict_types=1);

/** Server-owned session, log and temporary data; independent of desktop services. */
final class AppDataPaths
{
    private static ?string $root = null;
    private static string $source = '';

    public static function configurePhp(): void
    {
        if (session_status() !== PHP_SESSION_ACTIVE) session_save_path(self::directory('temp', 'php-sessions'));
        ini_set('error_log', self::directory('logs', 'backend') . DIRECTORY_SEPARATOR . 'php-error.log');
    }
    public static function root(): string
    {
        if (self::$root !== null) return self::$root;
        require_once dirname(__DIR__) . '/env_loader.php';
        // 必须经 env() 读取：宝塔等环境常把 putenv 写进 disable_functions，
        // 此时 loadEnv() 只能写入 $_ENV / $_SERVER，直接 getenv() 恒为 false，
        // 会静默丢掉 .env 里的 MOONYA_SERVER_DATA_ROOT 并回退到默认目录。
        $configured = trim((string) env('MOONYA_DATA_ROOT', ''));
        if ($configured !== '') {
            self::$source = 'MOONYA_DATA_ROOT';
            return self::$root = rtrim($configured, '/\\');
        }
        // Server deployments never probe a client runtime over loopback.
        $serverRoot = trim((string) env('MOONYA_SERVER_DATA_ROOT', ''));
        if ($serverRoot !== '') {
            $path = $serverRoot;
            self::$source = 'MOONYA_SERVER_DATA_ROOT';
        } else {
            $path = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . 'moonya-server-data';
            self::$source = '默认（站点目录的上一级）';
        }
        if (!preg_match('~^(?:[A-Za-z]:[\\\\/]|/)~', $path)) throw new RuntimeException('MOONYA_SERVER_DATA_ROOT 必须是绝对路径');
        return self::$root = rtrim($path, '/\\');
    }
    /** 数据根取值来源，仅供排障输出使用。 */
    public static function source(): string { self::root(); return self::$source; }
    public static function path(string ...$parts): string { return self::root() . DIRECTORY_SEPARATOR . implode(DIRECTORY_SEPARATOR, $parts); }
    public static function directory(string ...$parts): string
    {
        $path = self::path(...$parts);
        if (!is_dir($path) && !mkdir($path, 0700, true) && !is_dir($path)) {
            error_log(self::diagnose($path));
            throw new RuntimeException('无法创建 MoonYa 数据目录');
        }
        return $path;
    }
    /**
     * 数据目录创建失败时的自检快照，写入 error_log 供服务器排障。
     * 不对外返回（避免在接口响应中泄露服务器绝对路径）。
     */
    public static function diagnose(string $path): string
    {
        $root = '';
        $source = '';
        try { $root = self::root(); $source = self::$source; } catch (Throwable $e) { $source = '解析失败：' . $e->getMessage(); }
        $parent = dirname($path);
        $user = '未知';
        if (function_exists('posix_getuid') && function_exists('posix_getpwuid')) {
            $uid = posix_getuid();
            $user = $uid . '/' . (posix_getpwuid($uid)['name'] ?? '?');
        }
        $basedir = (string) ini_get('open_basedir');
        return implode("\n", [
            'MoonYa 数据目录不可用',
            '  目标路径     : ' . $path,
            '  数据根       : ' . $root . '（来源：' . $source . '）',
            '  app 根目录   : ' . dirname(__DIR__),
            '  运行用户     : ' . $user,
            '  父目录       : ' . $parent . '（存在=' . (is_dir($parent) ? '是' : '否')
                . '，可写=' . (is_dir($parent) && is_writable($parent) ? '是' : '否') . '）',
            '  open_basedir : ' . ($basedir !== '' ? $basedir : '(未设置)'),
            '  排查         : php 检测脚本/data_root_check.php',
            '  修复         : 数据根须在 open_basedir 白名单内且对运行用户可写'
                . '（chown -R www:www <数据根> && chmod 700 <数据根>），并在 .env 显式指定 MOONYA_SERVER_DATA_ROOT。',
        ]);
    }
}
