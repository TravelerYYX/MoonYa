<?php
require_once __DIR__ . '/Services/UserAvatar.php';
require_once __DIR__ . '/Services/UserEmailCodes.php';
require_once __DIR__ . '/Services/AppDataPaths.php';
require_once __DIR__ . '/Services/RequestHeaders.php';
require_once __DIR__ . '/Services/MembershipService.php';
error_reporting(E_ALL);
ini_set('display_errors', 0);

header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/Services/CorsPolicy.php';
applyCorsPolicy();
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// 设置会话过期时间为15天（15 * 24 * 60 * 60 = 1296000秒）
ini_set('session.gc_maxlifetime', 1296000);
ini_set('session.cookie_lifetime', 1296000);

AppDataPaths::configurePhp(); session_start();

// 如果会话已过期，重新生成会话ID以延长有效期
if (isset($_SESSION['last_activity']) && (time() - $_SESSION['last_activity'] > 1296000)) {
    session_regenerate_id(true);
}
$_SESSION['last_activity'] = time();

try {
    $config = require __DIR__ . '/config.php';
    
    $pdo = new PDO(
        "mysql:host=" . $config['db_host'] . ";dbname=" . $config['db_name'] . ";charset=utf8mb4",
        $config['db_user'],
        $config['db_pass'],
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false
        ]
    );
    
    $method = $_SERVER['REQUEST_METHOD'];
    $action = isset($_GET['action']) ? $_GET['action'] : '';
    
    if ($method === 'POST') {
        $input = json_decode(file_get_contents('php://input'), true);
        if (!is_array($input)) sendError(400, '请求格式无效');

        if ($action === 'send_code') {
            handleSendCode($input);
        } elseif ($action === 'login_code') {
            handleCodeLogin($pdo, $input);
        } elseif ($action === 'register') {
            handleRegister($pdo, $input);
        } elseif ($action === 'login') {
            handleLogin($pdo, $input);
        }
    } elseif ($method === 'GET') {
        if ($action === 'check_session') {
            handleCheckSession($pdo);
        } elseif ($action === 'logout') {
            handleLogout();
        }
    }
    
    sendError(400, '无效的请求');
} catch (InvalidArgumentException $e) {
    sendError(400, $e->getMessage());
} catch (\Throwable $e) {
    error_log('User authentication failed: ' . $e->getMessage());
    sendError(500, '操作失败，请稍后重试或联系管理员');
}

function handleRegister($pdo, $input) {
    $username = UserEmailCodes::qq((string)($input['qq'] ?? ''));
    $email = $username . '@qq.com';
    (new UserEmailCodes())->verify($username, 'register', (string)($input['challenge_id'] ?? ''), (string)($input['code'] ?? ''));

    try {
        $stmt = $pdo->prepare("SELECT id FROM users WHERE username = ? AND status != 'deleted'");
        $stmt->execute([$username]);
        if ($stmt->fetch()) {
            sendError(400, '该 QQ 号已被注册，请使用验证码登录');
        }

        if ($email !== '') {
            $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? AND status != 'deleted'");
            $stmt->execute([$email]);
            if ($stmt->fetch()) {
                sendError(400, '该邮箱已被使用');
            }
        }

        $passwordHash = null;

        $stmt = $pdo->prepare("INSERT INTO users (username, email, real_name, password, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', NOW(), NOW())");
        $stmt->execute([$username, $email !== '' ? $email : null, $username, $passwordHash]);

        $userId = $pdo->lastInsertId();
        (new MembershipService($pdo))->summary((int)$userId);

        session_regenerate_id(true);
        $_SESSION['user_id'] = $userId;
        $_SESSION['username'] = $username;
        $_SESSION['email'] = $email !== '' ? $email : null;
        $_SESSION['last_activity'] = time();

        setcookie(session_name(), session_id(), time() + 1296000, '/');

        $token = bin2hex(random_bytes(32));
        $stmt = $pdo->prepare("UPDATE users SET api_token = ?, token_created_at = NOW() WHERE id = ?");
        $stmt->execute([$token, $userId]);

        sendSuccess([
            'message' => '注册成功',
            'token' => $token,
            'expires_in' => 1296000,
            'user' => [
                'id' => $userId,
                'username' => $username,
                'email' => $email !== '' ? $email : null,
                'real_name' => $username,
                'avatar' => moonyaUserAvatar(['username'=>$username, 'email'=>$email])
            ]
        ]);
    } catch (PDOException $e) {
        sendError(500, '注册失败: ' . $e->getMessage());
    }
}

function handleSendCode(array $input): void {
    $result = (new UserEmailCodes())->send((string)($input['qq'] ?? ''), (string)($input['purpose'] ?? ''), (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
    sendSuccess($result);
}

function handleCodeLogin(PDO $pdo, array $input): void {
    $qq = UserEmailCodes::qq((string)($input['qq'] ?? ''));
    (new UserEmailCodes())->verify($qq, 'login', (string)($input['challenge_id'] ?? ''), (string)($input['code'] ?? ''));
    // QQ mailbox ownership supports pre-existing accounts registered with that email.
    $stmt = $pdo->prepare("SELECT id,username,email,real_name,status FROM users WHERE (username=? OR email=?) AND status!='deleted' ORDER BY (username=?) DESC LIMIT 2");
    $stmt->execute([$qq, $qq.'@qq.com', $qq]);
    $users = $stmt->fetchAll();
    if (!$users) sendError(404, '该 QQ 号尚未注册，请先注册');
    if (count($users) > 1) sendError(409, '该 QQ 号对应多个账号，请联系管理员处理');
    $user = $users[0];
    if ($user['status'] !== 'active') sendError(403, '该账号已被停用');
    session_regenerate_id(true);
    $_SESSION['user_id'] = $user['id'];
    $_SESSION['username'] = $user['username'];
    $_SESSION['email'] = $user['email'];
    $_SESSION['status'] = $user['status'];
    $_SESSION['last_activity'] = time();
    setcookie(session_name(), session_id(), time()+1296000, '/');
    $token = bin2hex(random_bytes(32));
    $stmt = $pdo->prepare('UPDATE users SET api_token=?,token_created_at=NOW() WHERE id=?');
    $stmt->execute([$token, $user['id']]);
    unset($user['status']);
    $user['avatar'] = moonyaUserAvatar($user);
    sendSuccess(['message'=>'登录成功', 'token'=>$token, 'expires_in'=>1296000, 'user'=>$user]);
}

function handleLogin($pdo, $input) {
    $username = trim($input['account'] ?? '');
    $password = $input['password'] ?? '';
    
    if (empty($username) || empty($password)) {
        sendError(400, '请输入账号和密码');
    }
    
    try {
        $stmt = $pdo->prepare("SELECT id, username, email, real_name, avatar, password, status FROM users WHERE (username = ? OR email = ?) AND status != 'deleted'");
        $stmt->execute([$username, $username]);
        $user = $stmt->fetch();
        
        if (!$user) {
            sendError(401, '账号或密码错误');
        }
        
        if (empty($user['password'])) {
            sendError(400, '该账号未设置密码，请使用邮箱验证码登录，或在设置中设置密码');
        }
        
        if (!password_verify($password, $user['password'])) {
            sendError(401, '账号或密码错误');
        }
        
        if ($user['status'] !== 'active') sendError(403, '该账号已被停用');
        session_regenerate_id(true);
        $_SESSION['user_id'] = $user['id'];
        $_SESSION['username'] = $user['username'];
        $_SESSION['email'] = $user['email'];
        $_SESSION['status'] = $user['status'];
        $_SESSION['last_activity'] = time();
        
        setcookie(session_name(), session_id(), time() + 1296000, '/');
        
        $token = bin2hex(random_bytes(32));
        
        $stmt = $pdo->prepare("UPDATE users SET api_token = ?, token_created_at = NOW() WHERE id = ?");
        $stmt->execute([$token, $user['id']]);
        
        sendSuccess([
            'message' => '登录成功',
            'token' => $token,
            'expires_in' => 1296000,
            'user' => [
                'id' => $user['id'],
                'username' => $user['username'],
                'email' => $user['email'],
                'real_name' => $user['real_name'],
                'avatar' => moonyaUserAvatar($user)
            ]
        ]);
    } catch (PDOException $e) {
        sendError(500, '登录失败: ' . $e->getMessage());
    }
}

function handleCheckSession($pdo) {
    $expiresIn = 1296000;
    $authorization = moonyaAuthorizationHeader();
    if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $match)) {
        $stmt = $pdo->prepare("SELECT id, IF(token_created_at IS NULL, 1296000, GREATEST(0, 1296000 - TIMESTAMPDIFF(SECOND, token_created_at, NOW()))) AS expires_in FROM users WHERE api_token = ? AND status != 'deleted' AND (token_created_at IS NULL OR token_created_at >= DATE_SUB(NOW(), INTERVAL 15 DAY)) LIMIT 1");
        $stmt->execute([trim($match[1])]);
        $identity = $stmt->fetch(PDO::FETCH_ASSOC);
        $id = $identity['id'] ?? null;
        $expiresIn = (int)($identity['expires_in'] ?? 0);
        // A supplied invalid token must never fall back to a different cookie user.
        if (!$id) { sendSuccess(['logged_in' => false]); }
        $_SESSION['user_id'] = (int)$id;
    }
    if (isset($_SESSION['user_id'])) {
        $stmt = $pdo->prepare("SELECT id, username, email, real_name, avatar FROM users WHERE id = ?");
        $stmt->execute([$_SESSION['user_id']]);
        $user = $stmt->fetch();
        
        if ($user) {
            sendSuccess([
                'logged_in' => true,
                'expires_in' => $expiresIn,
                'user' => [
                    'id' => $user['id'],
                    'username' => $user['username'],
                    'email' => $user['email'],
                    'real_name' => $user['real_name'],
                    'avatar' => moonyaUserAvatar($user)
                ]
            ]);
        } else {
            sendSuccess(['logged_in' => false]);
        }
    } else {
        sendSuccess(['logged_in' => false]);
    }
}

function handleLogout() {
    global $pdo;
    $authorization = moonyaAuthorizationHeader();
    if (preg_match('/^Bearer\s+(.+)$/i', $authorization, $match)) {
        $stmt = $pdo->prepare('UPDATE users SET api_token = NULL, token_created_at = NULL WHERE api_token = ?');
        $stmt->execute([trim($match[1])]);
    } elseif (!empty($_SESSION['user_id'])) {
        $stmt = $pdo->prepare('UPDATE users SET api_token = NULL, token_created_at = NULL WHERE id = ?');
        $stmt->execute([(int)$_SESSION['user_id']]);
    }
    session_destroy();
    sendSuccess(['message' => '已退出登录']);
}

function sendSuccess($data) {
    echo json_encode([
        'success' => true,
        'data' => $data
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

function sendError($code, $message) {
    http_response_code($code);
    echo json_encode([
        'success' => false,
        'error' => $message
    ], JSON_UNESCAPED_UNICODE);
    exit;
}
?>
