<?php
declare(strict_types=1);
/**
 * 定位后台「会员订单」报错的真实原因。
 *
 * 背景：admin/api/membership_orders.php 的 catch 只对 InvalidArgumentException 回具体文案，
 * 其余异常（RuntimeException / PDOException / Error）统一被替换成
 * 「订单查询暂不可用，请检查支付迁移与商户配置」+ HTTP 503，真实原因只写进 php-error.log。
 * 也就是说：看到这条文案 ≠ 支付宝没配好。支付宝没配好的状态是在页面内联文本里显示的。
 *
 * 本脚本按同一顺序复现引导链路，逐步打印实际抛出的异常类、消息与文件行号。
 * 检查顺序（与接口一致）：
 *   1  admin/config.php（数据根/日志目录，AppDataPaths）
 *   1b jwt_secret 长度（Auth::__construct 要求 >=32 字节，否则所有 /admin/api/* 都 503）
 *   2  MembershipService::connect（数据库连接）
 *   2b Logger / Auth 构造 + 接口 require 的四个文件是否齐全
 *   3  paymentSchemaReady（支付三表）
 *   4  AlipayGateway 就绪度
 *   5  18 张必需表齐备性 + 逐表 COUNT（含 credit_ledger / credit_calls —— account() 会写它们）
 *   6  免费套餐 membership_plans.is_free=1
 *   6b 订单数据预检（plan_json / subscription_json / anchor_at 是否为空或非法）
 *   7  GET 列表路径 paymentOrders()（需 --full / &full=1，这一步才真正等效后台打开页面）
 *
 * 默认只做只读检查；加 --full 才执行第 7 步（会像后台打开页面一样规范化会员排期）。
 *
 * 用法（CLI）：php 检测脚本/membership_orders_check.php [--full]
 * 用法（浏览器）：.../检测脚本/membership_orders_check.php?token=<.env 的 ADMIN_SECRET>[&full=1]
 *   令牌不符或未设置 ADMIN_SECRET 时一律按 404 处理，不暴露文件存在。
 *   定位完成后请删除本文件。
 */
$cli = PHP_SAPI === 'cli';
if (!$cli) {
    require_once dirname(__DIR__).'/env_loader.php';
    // 令牌可用 .env 的 ADMIN_SECRET 或 JWT_SECRET（两者任一非空即可）。
    $secrets = array_values(array_filter([(string)env('ADMIN_SECRET', ''), (string)env('JWT_SECRET', '')], static fn(string $value): bool => $value !== ''));
    $token = (string)($_GET['token'] ?? '');
    $matched = false;
    foreach ($secrets as $candidate) if (hash_equals($candidate, $token)) { $matched = true; break; }
    if (!$matched) {
        // 故意回一段明文：用来区分「路径/文件问题（宝塔 404 页）」与「token 问题（这段文字）」。
        // 暴露的信息仅限本文件存在，定位完成后请删除本文件。
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo $secrets === []
            ? "[MoonYa 体检] 已经访问到本脚本，但 .env 里 ADMIN_SECRET 与 JWT_SECRET 都是空的，无法校验令牌。\n"
            : "[MoonYa 体检] 已经访问到本脚本，但 token 不符：请把 URL 里的 token 换成 .env 的 ADMIN_SECRET（或 JWT_SECRET）的值。\n";
        exit;
    }
    header('Content-Type: text/plain; charset=utf-8');
}

$full = $cli ? in_array('--full', $argv ?? [], true) : isset($_GET['full']);
$out = $cli ? STDOUT : fopen('php://output', 'w');
$err = $cli ? STDERR : $out;
$base = dirname(__DIR__);
$rows = [];
$record = static function (string $state, string $label, string $detail) use (&$rows): void {
    $rows[] = [$state, $label, $detail];
};
$fail = static function (string $label, Throwable $error) use ($record): void {
    $record('FAIL', $label, get_class($error).': '.$error->getMessage()
        .' @ '.$error->getFile().':'.$error->getLine());
};

require_once $base.'/Services/PaymentService.php';
// 接口 require 的其余文件（缺一个就是 Error，同样被兜成那句文案）。
foreach (['/Services/RequestHeaders.php', '/admin/config.php', '/admin/Logger.php', '/admin/Auth.php'] as $file) {
    if (!is_file($base.$file)) {
        $record('FAIL', '必需文件 '.$file, '文件不存在 → require 失败会抛 Error，被接口兜成「订单查询暂不可用」');
    } else {
        require_once $base.$file;
    }
}

// 1) 与接口同一份配置引导。admin/config.php 里的 AppDataPaths::directory('logs','backend')
//    在数据根不可写 / 越出 open_basedir 时抛 RuntimeException('无法创建 MoonYa 数据目录')。
$config = null;
try {
    $config = require $base.'/admin/config.php';
    $record('OK', 'admin/config.php（数据根与日志目录）',
        '日志目录 '.$config['log_path'].'；数据根来源：'.AppDataPaths::source());
} catch (Throwable $error) {
    $fail('admin/config.php（数据根与日志目录）', $error);
}

// 1b) 管理员签名密钥：Auth::__construct 要求 jwt_secret 是 >=32 字节的字符串，
//     否则抛 RuntimeException('管理员签名密钥必须至少 32 字节')。
//     这是接口里最先执行的一步，失败时所有 /admin/api/* 都会 503 + 那句兜底文案。
if ($config !== null) {
    try {
        $jwt = $config['jwt_secret'] ?? null;
        if (!is_string($jwt) || strlen($jwt) < 32) {
            throw new RuntimeException('JWT_SECRET 缺失或长度不足 32 字节（当前 '
                .(is_string($jwt) ? strlen($jwt).' 字节'.($jwt === '' ? '，即 .env 里 JWT_SECRET 为空' : '') : '不是字符串')
                .'）→ 所有 /admin/api/* 请求都会 503');
        }
        $record('OK', '管理员签名密钥 jwt_secret', '长度 '.strlen($jwt).' 字节');
    } catch (Throwable $error) {
        $fail('管理员签名密钥 jwt_secret（.env 的 JWT_SECRET）', $error);
    }
}

// 2) 数据库连接
$db = null;
if ($config !== null) {
    try {
        $db = MembershipService::connect($config);
        $db->query('SELECT 1');
        $record('OK', 'MembershipService::connect（数据库连接）',
            $config['db_user'].'@'.$config['db_host'].'/'.$config['db_name']);
    } catch (Throwable $error) {
        $db = null;
        $fail('MembershipService::connect（数据库连接）', $error);
    }
}

if ($db !== null) {
    $membership = new MembershipService($db);

    // 2b) Logger / Auth 构造：接口连上库后立刻做这两件事，异常同样被兜成那句文案。
    $logger = null;
    if (!class_exists('Logger')) {
        $record('SKIP', 'Logger 构造', 'admin/Logger.php 未加载（见上方 FAIL）');
    } else {
        try {
            $logger = new Logger($config, $db);
            $record('OK', 'Logger 构造', '日志目录 '.$config['log_path']);
        } catch (Throwable $error) {
            $fail('Logger 构造', $error);
        }
    }
    if ($logger === null) {
        $record('SKIP', 'Auth 构造（管理员鉴权）', 'Logger 构造未通过，无法复现');
    } elseif (!class_exists('Auth')) {
        $record('SKIP', 'Auth 构造（管理员鉴权）', 'admin/Auth.php 未加载（见上方 FAIL）');
    } else {
        try {
            new Auth($db, $config, $logger);
            $record('OK', 'Auth 构造（管理员鉴权）', 'jwt_secret 长度 '.strlen((string)($config['jwt_secret'] ?? '')).' 字节');
        } catch (Throwable $error) {
            $fail('Auth 构造（管理员鉴权）', $error);
        }
    }

    // 3) 支付三表：决定页面显示「需要支付迁移」还是正常查询
    try {
        $record('OK', 'paymentSchemaReady（支付三表迁移状态）',
            $membership->paymentSchemaReady() ? '已建立' : '未建立（页面只会显示「需要支付迁移」，不会报这条错误）');
    } catch (Throwable $error) {
        $fail('paymentSchemaReady（支付三表迁移状态）', $error);
    }

    // 4) 网关就绪度（readiness 内部已兜底，正常不会抛）
    try {
        $ready = AlipayGateway::fromDatabase($db)->readiness();
        $record('OK', 'AlipayGateway 就绪度',
            'ready='.var_export($ready['ready'], true).' enabled='.var_export($ready['enabled'], true)
            .' 环境='.$ready['environment'].' 模式='.$ready['mode']
            .' 缺少：'.($ready['missing'] !== [] ? implode('、', $ready['missing']) : '无'));
    } catch (Throwable $error) {
        $fail('AlipayGateway 就绪度', $error);
    }

    // 5) 逐表核对。清单覆盖整条写入链路——account() 月重置会 INSERT credit_ledger，
    //    beginCall() 会 INSERT credit_calls。这两张表原先不在检查清单里，
    //    一旦缺失就是 PDOException('Base table or view not found')，同样被兜成那句文案。
    $required = ['users', 'admins', 'admin_logs', 'builtin_models',
        'membership_plans', 'membership_accounts', 'membership_orders', 'membership_purchases',
        'credit_periods', 'credit_calls', 'credit_ledger', 'credit_transfers',
        'payment_settings', 'payment_keyring', 'payment_admin_mfa', 'payment_challenges',
        'payment_auth_attempts', 'payment_email_limits'];
    try {
        $existing = $db->query('SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()')
            ->fetchAll(PDO::FETCH_COLUMN);
        $missing = array_values(array_diff($required, $existing));
        if ($missing !== []) {
            $record('FAIL', '必需数据表齐备性',
                '缺少 '.count($missing).' 张表：'.implode('、', $missing)
                ."\n         缺失表的 SELECT/INSERT 都会抛 PDOException，被接口兜成那句文案");
        } else {
            $record('OK', '必需数据表齐备性', count($required).' 张必需表全部存在（库内共 '.count($existing).' 张）');
        }
    } catch (Throwable $error) {
        $fail('必需数据表齐备性', $error);
    }
    foreach ($required as $table) {
        try {
            $count = (int)$db->query('SELECT COUNT(*) FROM `'.$table.'`')->fetchColumn();
            $record('OK', '表 '.$table, $count.' 行');
        } catch (Throwable $error) {
            $fail('表 '.$table, $error);
        }
    }

    // 6) 免费套餐：free() 找不到会抛 RuntimeException('会员制度尚未初始化，请运行迁移脚本')
    try {
        $freeId = $db->query('SELECT id FROM membership_plans WHERE is_free=1 AND archived=0 LIMIT 1')->fetchColumn();
        if ($freeId === false) {
            throw new RuntimeException('缺少免费套餐 → initializeUser() 会抛「会员制度尚未初始化，请运行迁移脚本」');
        }
        $record('OK', '免费套餐 membership_plans.is_free=1', 'id='.$freeId);
    } catch (Throwable $error) {
        $fail('免费套餐 membership_plans.is_free=1', $error);
    }

    // 6b) 订单数据预检：paymentOrders() 会对每个订单的 user 调 initializeUser() → account()，
    //    而 MembershipService.php 是 declare(strict_types=1)：
    //      · json_decode($account['subscription_json'], …, JSON_THROW_ON_ERROR) 空值/非法 → JsonException/TypeError
    //      · $this->date($account['anchor_at']) 为 NULL      → TypeError（必须 string）
    //                                             为 '0000-00-00…' → Exception（无法解析）
    //    这些异常不是 InvalidArgumentException，同样会被接口兜成那句文案。
    try {
        $orders = $db->query('SELECT order_no,user_id,plan_json FROM membership_orders ORDER BY id DESC')
            ->fetchAll(PDO::FETCH_ASSOC);
        $problems = [];
        $warnings = [];
        foreach ($orders as $order) {
            $who = '订单 '.$order['order_no'].'（user_id='.$order['user_id'].'）';
            if (!is_string($order['plan_json']) || trim($order['plan_json']) === '') {
                $problems[] = $who.' 的 plan_json 为空 → publicOrder() 的 json_decode 会抛异常';
            } else {
                try { json_decode($order['plan_json'], true, 32, JSON_THROW_ON_ERROR); }
                catch (Throwable $error) { $problems[] = $who.' 的 plan_json 不是合法 JSON：'.$error->getMessage(); }
            }
            $account = $db->query('SELECT subscription_json,anchor_at,expires_at FROM membership_accounts WHERE user_id='.(int)$order['user_id'])
                ->fetch(PDO::FETCH_ASSOC);
            if (!$account) { $problems[] = $who.' 在 membership_accounts 里没有行 → initializeUser() 会新建（正常），若失败则是下方 warn'; continue; }
            if (!is_string($account['subscription_json']) || trim($account['subscription_json']) === '') {
                $problems[] = $who.' 的 subscription_json 为空 → account() 的 json_decode 会抛异常';
            } else {
                try { json_decode($account['subscription_json'], true, 32, JSON_THROW_ON_ERROR); }
                catch (Throwable $error) { $problems[] = $who.' 的 subscription_json 不是合法 JSON：'.$error->getMessage(); }
            }
            if ($account['anchor_at'] === null) {
                $problems[] = $who.' 的 anchor_at 为 NULL → account() 调用 date() 会抛 TypeError（strict_types）';
            } elseif (str_starts_with((string)$account['anchor_at'], '0000-00-00')) {
                // PHP 8 会把零日期解析成 -0001 年，不抛异常，但周期会被算错 → 只算 WARN。
                $warnings[] = $who.' 的 anchor_at 是零日期 '.$account['anchor_at'].'（不报错，但周期计算会错）';
            }
            if ($account['expires_at'] !== null && str_starts_with((string)$account['expires_at'], '0000-00-00')) {
                $warnings[] = $who.' 的 expires_at 是零日期 '.$account['expires_at'].'（不报错，但周期计算会错）';
            }
        }
        if ($orders === []) {
            $record('OK', '订单数据预检（plan_json / subscription_json / anchor_at）', 'membership_orders 为空，paymentOrders() 不会走到 account()');
        } elseif ($problems !== []) {
            $record('FAIL', '订单数据预检（plan_json / subscription_json / anchor_at）', implode("\n         ", $problems));
        } elseif ($warnings !== []) {
            $record('WARN', '订单数据预检（plan_json / subscription_json / anchor_at）',
                count($orders).' 条订单可正常查询，但有数据瑕疵：'."\n         ".implode("\n         ", $warnings));
        } else {
            $record('OK', '订单数据预检（plan_json / subscription_json / anchor_at）', count($orders).' 条订单的数据均可用');
        }
    } catch (Throwable $error) {
        $fail('订单数据预检（plan_json / subscription_json / anchor_at）', $error);
    }

    // 7) 可选：完整复现 GET 列表路径
    if ($full) {
        try {
            $data = $membership->paymentOrders(null, 1, '', '');
            $record('OK', 'GET 列表路径 paymentOrders()（--full）',
                '返回 '.count($data['items']).' 条 / 共 '.$data['total'].' 条');
        } catch (Throwable $error) {
            $fail('GET 列表路径 paymentOrders()（--full）', $error);
        }
    } else {
        $record('SKIP', 'GET 列表路径 paymentOrders()', $cli ? '加 --full 复现（与后台打开页面等效）' : 'URL 加 &full=1 复现（与后台打开页面等效）');
    }
}

foreach ($rows as [$state, $label, $detail]) {
    fwrite($state === 'FAIL' ? $err : $out,
        sprintf('[%-4s] %s%s', $state, $label, $detail !== '' ? "\n         ".$detail : '')."\n");
}
$failed = array_filter($rows, static fn(array $row): bool => $row[0] === 'FAIL');
fwrite($out, "\n");
if ($failed === []) {
    fwrite($out, "引导链路未复现失败。若线上仍报错，请核对 php-error.log 里最近一条 "
        ."「MoonYa membership orders:」记录的类名、文件与行号。\n");
    exit(0);
}
fwrite($err, "共 ".count($failed)." 项失败，第一个失败项即接口 503 的真实原因。\n");
exit(1);
