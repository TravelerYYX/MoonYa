<?php
declare(strict_types=1);
/**
 * MoonYa 数据库结构体检（CLI）。
 *
 * 触发场景：后台/接口返回 500，文案形如
 *   {"success":false,"error":"公告服务暂时不可用，请确认数据库迁移已完成"}
 *   {"success":false,"error":"内置主题暂不可用"}
 * 这些是各接口 catch(Throwable) 的**兜底文案**，真实原因几乎总是
 *   SQLSTATE[42S02] 1146 Table 'ai_system.xxx' doesn't exist
 * ——即功能代码已上线，但对应的建表脚本没有执行。
 *
 * 本项目的迁移约定：
 *   建表语句放 sql/<feature>_schema.sql，执行入口是 tools/migrate_<feature>.php
 *   （早期功能放在 sql/migrate_<feature>.php）。没有统一的自动迁移，
 *   新增 feature 时三处都要补：sql/*.sql + 执行入口 + admin/Database.php 的 initializeTables()。
 *
 *   php 检测脚本/db_schema_check.php
 *   php 检测脚本/db_schema_check.php --verbose
 *
 * 只读探测：仅 SELECT / SHOW / information_schema 查询，不建表、不改数据。
 * 修复动作一律只打印命令，由人执行。
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once dirname(__DIR__).'/env_loader.php';
require_once dirname(__DIR__).'/admin/Database.php';

$verbose = in_array('--verbose', $argv ?? [], true);
$root    = dirname(__DIR__);
$failures = 0;

function line(string $label, bool $ok, string $detail = '', string $hint = '', bool $warn = false): void {
    global $failures;
    $mark = $ok ? 'OK  ' : ($warn ? 'WARN' : 'FAIL');
    if (!$ok && !$warn) $failures++;
    fwrite(STDOUT, sprintf("[%s] %s%s\n", $mark, $label, $detail !== '' ? ' — '.$detail : ''));
    if (!$ok && $hint !== '') fwrite(STDOUT, '       → '.$hint."\n");
}

/** 去掉 SQL 注释，避免注释里的 FROM xxx 被当成真引用。 */
function stripSqlComments(string $sql): string {
    $sql = preg_replace('~/\*.*?\*/~s', ' ', $sql) ?? $sql;
    return preg_replace('~(--|#)[^\n]*~', ' ', $sql) ?? $sql;
}

/** 从一份 SQL 文本里收集 CREATE TABLE 的目标表名。 */
function schemaTables(string $sql): array {
    $out = [];
    if (preg_match_all('~CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z_][a-zA-Z0-9_]*)`?~i', $sql, $m)) {
        foreach ($m[1] as $t) $out[strtolower($t)] = true;
    }
    return array_keys($out);
}

fwrite(STDOUT, "MoonYa 数据库结构体检\n");
fwrite(STDOUT, str_repeat('=', 62)."\n");

/* 1. 连接 ---------------------------------------------------------------- */
$db = null;
try {
    $config = require $root.'/admin/config.php';
    $db = (new Database($config))->getConnection();
    fwrite(STDOUT, sprintf("目标库：%s @ %s（用户 %s）\n",
        (string)$config['db_name'], (string)$config['db_host'], (string)$config['db_user'] !== '' ? (string)$config['db_user'] : '(空)'));
} catch (Throwable $e) {
    fwrite(STDOUT, "\n[连接]\n");
    line('连接数据库', false, $e->getMessage(), '检查 .env 的 DB_HOST/DB_NAME/DB_USER/DB_PASS（必须走 env()，裸 getenv() 在 FPM 下恒空）。');
    fwrite(STDOUT, "\n".str_repeat('=', 62)."\n结果：FAIL（无法连接，后续检查跳过）\n");
    exit(1);
}

$existing = [];
foreach ($db->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $t) $existing[strtolower((string)$t)] = true;

/* 2. 声明式体检：sql/*_schema.sql 是否都已执行 ---------------------------- */
fwrite(STDOUT, "\n[建表脚本执行情况]\n");
$schemaFiles = glob($root.'/sql/*_schema.sql') ?: [];
sort($schemaFiles);
$deferred = [];
foreach ($schemaFiles as $file) {
    $base  = basename($file, '_schema.sql');           // announcements
    $sql   = (string)file_get_contents($file);
    $want  = schemaTables($sql);
    if ($want === []) continue;
    $missing = array_values(array_filter($want, static fn(string $t): bool => !isset($existing[$t])));
    // 执行入口：优先 tools/migrate_<x>.php，其次 sql/migrate_<x>.php
    $runner = null;
    foreach (["/tools/migrate_{$base}.php", "/sql/migrate_{$base}.php"] as $cand) {
        if (is_file($root.$cand)) { $runner = 'php '.ltrim($cand, '/'); break; }
    }
    $label = basename($file);
    if ($missing === []) {
        line($label, true, sprintf('已执行（%d 张表）', count($want)));
        continue;
    }
    $deferred[] = $base;
    line($label, false,
        sprintf('缺 %d 张表：%s', count($missing), implode(', ', $missing)),
        $runner !== null
            ? "执行：{$runner}"
            : '没有找到对应执行入口（tools/migrate_'.$base.'.php）。手工执行该 SQL 文件，并补上执行入口。');
}

/* 3. 启发式体检：自家代码引用但库中不存在的表 ----------------------------- */
fwrite(STDOUT, "\n[代码引用但库中不存在的表]\n");
$scanDirs = ['Services', 'api', 'admin', 'script', 'api/client', '.'];
$files = [];
foreach ($scanDirs as $dir) {
    $path = $root.'/'.$dir;
    if (!is_dir($path)) continue;
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS)
    );
    foreach ($it as $f) {
        /** @var SplFileInfo $f */
        if ($f->getExtension() !== 'php') continue;
        $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($root) + 1));
        // 排除第三方、测试、迁移脚本自身所在目录
        if (preg_match('~^(vendor|tests|artifacts|sql|tools|检测脚本)/~', $rel)) continue;
        if ($dir === '.' && str_contains($rel, '/')) continue;   // 根目录只看一层
        $files[$rel] = $f->getPathname();
    }
}
ksort($files);

$refs = [];
$selfProvisioned = [];
$pat  = '~(?<![a-zA-Z0-9_$`.])(FROM|INTO|UPDATE|JOIN)\s+`?([a-zA-Z_][a-zA-Z0-9_]{2,})`?~i';
// 天然不是表的词：SQL 关键字、系统库、时间函数（列定义里的 ON UPDATE CURRENT_TIMESTAMP 会被误捕）
$notTables = ['dual', 'information_schema', 'performance_schema', 'mysql', 'sys', 'select', 'values', 'set', 'where',
              'current_timestamp', 'utc_timestamp', 'localtime', 'now'];
foreach ($files as $rel => $abs) {
    $src = stripSqlComments((string)file_get_contents($abs));
    // 服务层会在构造时 CREATE TABLE IF NOT EXISTS 自建表：这类缺表不是故障，按需自动补。
    if (preg_match_all('~CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?~i', $src, $sp)) {
        foreach ($sp[1] as $t) $selfProvisioned[strtolower($t)] = $rel;
    }
    if (preg_match_all($pat, $src, $m, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
        foreach ($m as $set) {
            $verb = strtoupper($set[1][0]);
            $name = strtolower($set[2][0]);
            if (in_array($name, $notTables, true)) continue;
            if (!str_contains($name, '_') && !in_array($name, ['users', 'admins', 'messages', 'conversations', 'agents', 'favorites', 'music', 'webpages', 'personality'], true)) continue;
            // 排除 "ON DUPLICATE KEY UPDATE col=VALUES(col)" —— 那是列名
            if ($verb === 'UPDATE') {
                $before = substr($src, max(0, (int)$set[1][1] - 12), 12);
                if (preg_match('~KEY\s+$~i', $before)) continue;
            }
            // 排除自然语言：表名后紧跟 : 或 = 或 " 说明它是句子/错误消息的一部分
            $after = ltrim(substr($src, (int)$set[2][1] + strlen($set[2][0]), 3));
            if ($after !== '' && ($after[0] === ':' || $after[0] === '=')) continue;
            $refs[$name][$rel] = true;
        }
    }
}
$missingRefs = array_filter(array_keys($refs), static fn(string $t): bool => !isset($existing[$t]));
sort($missingRefs);
$realMissing = [];
$selfMissing = [];
foreach ($missingRefs as $t) {
    if (isset($selfProvisioned[$t])) { $selfMissing[$t] = $selfProvisioned[$t]; continue; }
    $realMissing[] = $t;
}
if ($verbose && $selfMissing !== []) {
    fwrite(STDOUT, "       以下表缺失但由代码自建（首次使用该功能时自动补建，非故障）：\n");
    foreach ($selfMissing as $t => $rel) fwrite(STDOUT, "         · {$t}  ({$rel})\n");
}
if ($realMissing === [] && $missingRefs === []) {
    line('全部表均存在', true, sprintf('代码引用 %d 张表', count($refs)));
} elseif ($realMissing === []) {
    line('无「无自建逻辑且缺失」的表', true,
        sprintf('代码引用 %d 张表，其中 %d 张缺失但由代码自建', count($refs), count($selfMissing)));
} else {
    foreach ($realMissing as $t) {
        $where = array_slice(array_keys($refs[$t]), 0, 2);
        line($t, false, '引用位置：'.implode(', ', $where),
            '无自建逻辑，需从旧库/迁移脚本建表；若功能已停用可忽略。', true);
    }
    fwrite(STDOUT, sprintf("       共 %d 张表无自建逻辑且缺失（WARN：多为已停用的多智能体/执行链功能，确认后再补）。\n", count($realMissing)));
}

if ($verbose) {
    fwrite(STDOUT, "\n[已存在但本次未被代码引用的表]\n");
    $used = array_keys($refs);
    $extra = array_values(array_filter(array_keys($existing), static fn(string $t): bool => !in_array($t, $used, true)));
    sort($extra);
    fwrite(STDOUT, '       '.implode(', ', $extra)."\n");
}

/* 4. 结论 ---------------------------------------------------------------- */
fwrite(STDOUT, "\n".str_repeat('=', 62)."\n");
if ($failures === 0 && $deferred === []) {
    fwrite(STDOUT, "结果：PASS（建表脚本均已执行）\n");
    exit(0);
}
fwrite(STDOUT, "结果：FAIL（{$failures} 个脚本未执行）\n\n");
fwrite(STDOUT, "修复（按顺序执行，先建被引用的表再建带外键的表）：\n");
foreach ($deferred as $base) {
    fwrite(STDOUT, "  php tools/migrate_{$base}.php\n");
}
exit(1);
