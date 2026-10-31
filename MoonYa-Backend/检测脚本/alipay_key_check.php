<?php
declare(strict_types=1);
/* 只读诊断 / 装甲补齐：支付宝 PEM 材料（私钥/公钥/证书）能否被服务端解析、类型与位数。
 * 用法：
 *   php alipay_key_check.php                                   （材料已在剪贴板，直接读）
 *   Get-Clipboard | php alipay_key_check.php                   （或管道喂入）
 *   php alipay_key_check.php <pem 文件>                        （或指定文件）
 *   php alipay_key_check.php [输入] private|public             （按“应用私钥/支付宝公钥”字段判定能否保存）
 *   php alipay_key_check.php --armor private|public            （把裸 base64 补成合法 PEM，输出到 stdout）
 *   php alipay_key_check.php --armor private|public --clip     （补好后直接写回剪贴板，推荐）
 *   php alipay_key_check.php --derive-public <私钥文件>          （从私钥反推“应用公钥”，用于和开放平台页面核对）
 *   --from-clipboard 强制从剪贴板读；--clip 把 arm/derive 结果写回剪贴板。
 * 诊断模式只打印类型/位数/结论，永不回显密钥内容。 */

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$args = array_slice($argv, 1);
$armor = in_array('--armor', $args, true);
$clip = in_array('--clip', $args, true);
$fromClipboard = in_array('--from-clipboard', $args, true);
$derivePublic = in_array('--derive-public', $args, true);
$positional = array_values(array_filter($args, static fn(string $a): bool => !str_starts_with($a, '--')));
$fileArg = null;
$expect = null;
foreach ($positional as $arg) {
    if (($arg === 'private' || $arg === 'public') && $expect === null) { $expect = $arg; continue; }
    if ($fileArg === null) $fileArg = $arg;
}
$path = $armor ? null : $fileArg;

/* 剪贴板读取：Windows 下走 PowerShell。cmd.exe 里 `<` 是重定向符号，
   所以别把材料做成文件再写 `<文件.pem>`，直接读剪贴板最省事。 */
function clipboard_read(): string {
    if (PHP_OS_FAMILY !== 'Windows') return '';
    $output = @shell_exec('powershell -NoProfile -Command "Get-Clipboard -Raw"');
    return is_string($output) ? $output : '';
}

$piped = function_exists('stream_isatty') ? !stream_isatty(STDIN) : true;
$text = false;
if ($path !== null) $text = @file_get_contents($path);
elseif ($armor && $fileArg !== null) $text = @file_get_contents($fileArg);
elseif ($piped && !$fromClipboard) $text = stream_get_contents(STDIN);
if (($text === false || trim((string) $text) === '') && $path === null) {
    $text = clipboard_read();
    if (trim($text) !== '') fwrite(STDERR, "(输入为空，已改从剪贴板读取材料)\n");
}
if ($text === false || trim((string) $text) === '') {
    fwrite(STDERR, "没有拿到材料。用法：\n  把材料复制到剪贴板后直接跑： php alipay_key_check.php [--armor private|public] [--clip]\n  或指定文件： php alipay_key_check.php <pem 文件> [private|public]\n  或管道：     Get-Clipboard | php alipay_key_check.php\n");
    exit(2);
}

/* 补齐 PEM 装甲：支付宝开放平台/密钥工具里复制出来的是裸 base64，
   服务端的 openssl_pkey_get_*() 只认 PEM，喂裸 base64 必然失败。
   这里按“能解析成功”的顺序试各种头名，输出规范化后的 PEM。 */
if ($armor) {
    if (str_contains($text, '-----BEGIN CERTIFICATE-----')) { fwrite(STDERR, "这是证书，无需补装甲。\n"); exit(1); }
    $b64 = preg_replace('/-----[^-]+-----|\s+/', '', $text);
    if ($b64 === '' || base64_decode($b64, true) === false) { fwrite(STDERR, "内容不是合法 base64。\n"); exit(1); }
    $labels = match ($expect) {
        'private' => ['PRIVATE KEY', 'RSA PRIVATE KEY'],
        'public' => ['PUBLIC KEY', 'RSA PUBLIC KEY'],
        default => ['PRIVATE KEY', 'PUBLIC KEY', 'RSA PRIVATE KEY', 'RSA PUBLIC KEY'],
    };
    foreach ($labels as $label) {
        $pem = "-----BEGIN {$label}-----\n" . rtrim(chunk_split($b64, 64, "\n"), "\n") . "\n-----END {$label}-----\n";
        $isPrivate = str_contains($label, 'PRIVATE');
        $key = $isPrivate ? @openssl_pkey_get_private($pem) : @openssl_pkey_get_public($pem);
        $details = $key ? openssl_pkey_get_details($key) : false;
        if (!$details) continue;
        $type = $details['type'] === OPENSSL_KEYTYPE_RSA ? 'RSA' : '其他类型(' . $details['type'] . ')';
        $bits = (int) ($details['bits'] ?? 0);
        $ok = $details['type'] === OPENSSL_KEYTYPE_RSA && $bits >= 2048;
        fwrite(STDERR, sprintf("识别为 %s：%s %d 位 %s\n", $isPrivate ? '私钥' : '公钥', $type, $bits, $ok ? '(服务端接受)' : '(服务端会拒绝)'));
        if ($clip) {
            $handle = @popen('clip', 'w');
            if (!$handle) { fwrite(STDERR, "写剪贴板失败（popen 不可用），请改用重定向输出到文件。\n"); exit(1); }
            fwrite($handle, $pem); pclose($handle);
            fwrite(STDOUT, "已补好 PEM 并写入剪贴板（头 {$label}，{$bits} 位）。直接到后台粘贴即可。\n");
        } else {
            fwrite(STDOUT, $pem);
        }
        exit(0);
    }
    fwrite(STDERR, "无法识别：内容按任何 PEM 头名都解析不出密钥，检查是否只复制了片段。\n");
    exit(1);
}

/* 从私钥反推「应用公钥」：开放平台页面上显示的“应用公钥”就是这个裸 base64。
   用途：确认「手上这把私钥」与「平台上登记的应用公钥」是不是同一轮生成的
   —— 生成密钥对后若没重新上传应用公钥，本地校验能过，真实支付必然验签失败。 */
if ($derivePublic) {
    $key = @openssl_pkey_get_private(trim($text));
    if (!$key && !str_contains($text, '-----BEGIN')) {
        $b64in = preg_replace('/\s+/', '', $text);
        $key = @openssl_pkey_get_private("-----BEGIN PRIVATE KEY-----\n" . rtrim(chunk_split($b64in, 64, "\n"), "\n") . "\n-----END PRIVATE KEY-----\n");
    }
    if (!$key) $key = @openssl_pkey_get_public(trim($text));
    $details = $key ? openssl_pkey_get_details($key) : false;
    if (!$details || $details['type'] !== OPENSSL_KEYTYPE_RSA) { fwrite(STDERR, "无法从这份材料推出 RSA 公钥。\n"); exit(1); }
    $b64 = preg_replace('/-----[^-]+-----|\s+/', '', $details['key']);
    if ($clip) {
        $handle = @popen('clip', 'w');
        if (!$handle) { fwrite(STDERR, "写剪贴板失败（popen 不可用），请改用重定向输出到文件。\n"); exit(1); }
        fwrite($handle, $b64); pclose($handle);
        fwrite(STDOUT, "已把应用公钥（裸 base64）写入剪贴板。\n");
    } else {
        fwrite(STDOUT, $b64 . "\n");
    }
    fwrite(STDERR, sprintf("应用公钥 %d 位，base64 %d 字符（开头 %s … 结尾 %s）。\n与开放平台页面上「应用公钥」逐字符比对。\n",
        $details['bits'], strlen($b64), substr($b64, 0, 24), substr($b64, -24)));
    exit(0);
}

$notes = [];
if (str_starts_with($text, "\xEF\xBB\xBF")) $notes[] = '内容以 UTF-8 BOM 开头（记事本另存常带），请重新复制纯文本。';

$text = str_replace(["\r\n", "\r"], "\n", $text);
$pem = trim($text);

preg_match('/-----BEGIN ([A-Z0-9 ]+)-----/', $pem, $begin);
preg_match('/-----END ([A-Z0-9 ]+)-----/', $pem, $end);
$kind = $begin[1] ?? null;

$outside = trim(preg_replace('/-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/', '', $pem));
if ($outside !== '') $notes[] = 'PEM 块之外还有多余内容（如说明文字、标签、第二个材料），服务端会解析失败：' . mb_substr($outside, 0, 40) . '…';

echo "=== 外观 ===\n";
echo 'PEM 头：', $kind !== null ? "-----BEGIN {$kind}-----" : '未找到（不是完整 PEM）', "\n";
echo 'PEM 尾：', isset($end[1]) ? "-----END {$end[1]}-----" : '未找到', "\n";
echo '字节数：', strlen($pem), "\n";
if ($kind !== null && isset($end[1]) && $kind !== $end[1]) $notes[] = "头尾类型不一致（{$kind} / {$end[1]}），复制时混入了别的内容。";
if (str_contains($pem, 'ENCRYPTED') || str_contains($pem, 'Proc-Type: 4,ENCRYPTED')) $notes[] = '检测到 ENCRYPTED 标记：私钥带口令。项目要求私钥不加密码，请用密钥工具重新导出无口令版本。';

function describe(string $label, $key, array &$notes): void {
    if ($key === false || $key === null) { echo $label, "：无法解析\n"; return; }
    $d = openssl_pkey_get_details($key);
    if (!$d) { echo $label, "：无法解析\n"; return; }
    $type = $d['type'] === OPENSSL_KEYTYPE_RSA ? 'RSA' : ($d['type'] === OPENSSL_KEYTYPE_EC ? 'EC/ECC' : '其他('.$d['type'].')');
    $ok = $d['type'] === OPENSSL_KEYTYPE_RSA && ($d['bits'] ?? 0) >= 2048;
    echo $label, '：', $type, ' ', (int)($d['bits'] ?? 0), ' 位  ', $ok ? '← 服务端接受' : '← 服务端会拒绝', "\n";
}

$private = openssl_pkey_get_private($pem);
$public = openssl_pkey_get_public($pem);
$cert = @openssl_x509_read($pem);

echo "\n=== 服务端解析 ===\n";
describe('按私钥解析', $private, $notes);
describe('按公钥解析', $public, $notes);
echo '按证书解析：', $cert !== false ? '是证书' : '不是证书', "\n";

if ($private === false && $cert !== false) {
    $notes[] = '这是【证书】，不是密钥；证书属于证书模式的“应用公钥证书/支付宝公钥证书/根证书”字段。';
} elseif ($private === false && $public !== false) {
    $notes[] = '这是【公钥】。填在“应用私钥”框会报“需要至少 2048 位的有效 RSA 密钥”——私钥框必须填私钥。';
} elseif ($private === false && $public === false && $cert === false) {
    $notes[] = '三种解析全部失败：内容不完整、含多余文字/BOM，或私钥带口令（服务端不带 passphrase 解析，必然失败）。';
}

echo "\n=== 结论 ===\n";
if ($expect === 'private' || $expect === 'public') {
    $target = $expect === 'private' ? $private : $public;
    $d = $target !== false ? openssl_pkey_get_details($target) : false;
    $pass = $d && $d['type'] === OPENSSL_KEYTYPE_RSA && ($d['bits'] ?? 0) >= 2048;
    echo $expect === 'private' ? '应用私钥' : '支付宝公钥', '字段判定：', $pass ? "通过，可以保存\n" : "不通过，服务端会报“需要至少 2048 位的有效 RSA 密钥”\n";
    if (!$pass && !$notes) $notes[] = '材料本身能解析但不符合要求（位数不足 / 不是 RSA）。';
}
if (!$notes) echo "未发现明显问题：这份材料服务端可以正常解析。\n";
else foreach ($notes as $note) echo $note, "\n";
