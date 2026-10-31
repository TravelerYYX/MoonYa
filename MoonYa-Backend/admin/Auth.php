<?php
class Auth {
    private $db;
    private $jwtSecret;
    private $logger;

    public function __construct($db, $config, $logger) {
        if (!is_string($config['jwt_secret'] ?? null) || strlen($config['jwt_secret']) < 32) {
            throw new RuntimeException('管理员签名密钥必须至少 32 字节');
        }
        $this->db = $db;
        $this->jwtSecret = $config['jwt_secret'];
        $this->logger = $logger;
    }

    public function authenticate($token) {
        if (empty($token)) {
            return null;
        }

        try {
            $payload = $this->decodeToken($token);
            if (!$payload || !isset($payload['admin_id'])) {
                return null;
            }

            $stmt = $this->db->prepare("SELECT id, username, email, role FROM admins WHERE id = ?");
            $stmt->execute([$payload['admin_id']]);
            $admin = $stmt->fetch();

            return $admin ?: null;
        } catch (Exception $e) {
            $this->logger->log('ERROR', 'Authentication failed', ['error' => $e->getMessage()]);
            return null;
        }
    }

    public function login($username, $password) {
        $stmt = $this->db->prepare("SELECT id, username, password, email, role FROM admins WHERE username = ?");
        $stmt->execute([$username]);
        $admin = $stmt->fetch();

        if (!$admin || !password_verify($password, $admin['password'])) {
            $this->logger->log('WARNING', 'Failed login attempt', ['username' => $username]);
            return null;
        }

        $token = $this->generateToken($admin);
        $this->logger->log('INFO', 'Admin logged in', ['admin_id' => $admin['id']]);
        return [
            'token' => $token,
            'admin' => [
                'id' => $admin['id'],
                'username' => $admin['username'],
                'email' => $admin['email'],
                'role' => $admin['role']
            ]
        ];
    }

    private function generateToken($admin) {
        $header = base64_encode(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
        $payload = base64_encode(json_encode([
            'admin_id' => $admin['id'],
            'username' => $admin['username'],
            'role' => $admin['role'],
            'exp' => time() + (24 * 60 * 60)
        ]));
        $signature = hash_hmac('sha256', $header . '.' . $payload, $this->jwtSecret, true);
        $signature = base64_encode($signature);
        return $header . '.' . $payload . '.' . $signature;
    }

    private function decodeToken($token) {
        if (!is_string($token) || strlen($token) > 8192) return null;
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }

        list($header, $payload, $signature) = $parts;
        // Retain the shell's existing base64 token format, but decode canonically.
        $decodedHeader = base64_decode($header, true);
        $decodedPayload = base64_decode($payload, true);
        $decodedSignature = base64_decode($signature, true);
        if ($decodedHeader === false || $decodedPayload === false || $decodedSignature === false ||
            base64_encode($decodedHeader) !== $header || base64_encode($decodedPayload) !== $payload ||
            base64_encode($decodedSignature) !== $signature || strlen($decodedSignature) !== 32) return null;
        $claims = json_decode($decodedHeader, true);
        if (!is_array($claims) || ($claims['alg'] ?? null) !== 'HS256' || ($claims['typ'] ?? null) !== 'JWT') return null;
        $expectedSignature = hash_hmac('sha256', $header . '.' . $payload, $this->jwtSecret, true);
        if (!hash_equals($expectedSignature, $decodedSignature)) {
            return null;
        }

        $decoded = json_decode($decodedPayload, true);
        if (!is_array($decoded) || !is_int($decoded['exp'] ?? null) || $decoded['exp'] <= time() ||
            $decoded['exp'] > time() + 86400 || !is_int($decoded['admin_id'] ?? null) || $decoded['admin_id'] < 1) {
            return null;
        }

        return $decoded;
    }

    public function hasPermission($admin, $permission) {
        if (!$admin) return false;
        if ($admin['role'] === 'super_admin') return true;
        if ($admin['role'] !== 'admin') return false;
        $adminPermissions = [
            'view_users',
            'edit_users',
            'ban_users',
            'unban_users'
        ];
        return in_array($permission, $adminPermissions);
    }
}
