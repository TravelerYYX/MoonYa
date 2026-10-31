<?php
declare(strict_types=1);
require_once __DIR__ . '/AppDataPaths.php';
require_once __DIR__ . '/RequestHeaders.php';

final class TeamAuth
{
    public static function connect(array $config): PDO
    {
        return new PDO(
            'mysql:host=' . $config['db_host'] . ';dbname=' . $config['db_name'] . ';charset=utf8mb4',
            $config['db_user'],
            $config['db_pass'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    }

    public static function requireUser(PDO $pdo): int
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            AppDataPaths::configurePhp(); session_start();
        }

        $token = self::bearerToken();
        if ($token !== null) {
            unset($_SESSION['user_id']);
            $stmt = $pdo->prepare("SELECT id, token_created_at FROM users WHERE api_token = ? AND status != 'deleted' LIMIT 1");
            $stmt->execute([$token]);
            $user = $stmt->fetch();
            if ($user) {
                $createdAt = $user['token_created_at'] ?? null;
                if ($createdAt === null || (time() - strtotime((string)$createdAt)) <= 1296000) {
                    $_SESSION['user_id'] = (int)$user['id'];
                }
            }
        }

        $userId = (int)($_SESSION['user_id'] ?? 0);
        // Long-running SSE requests and approval POSTs must not block each other.
        session_write_close();

        if ($userId <= 0) {
            throw new RuntimeException('AUTH_REQUIRED');
        }
        return $userId;
    }

    public static function bearerToken(): ?string
    {
        $header = moonyaAuthorizationHeader();
        if (!is_string($header) || !preg_match('/^Bearer\s+(.+)$/i', trim($header), $matches)) {
            return null;
        }
        $token = trim($matches[1]);
        return $token === '' ? null : $token;
    }
}

