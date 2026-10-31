<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/Services/WebAttachmentService.php';

function attachmentAssert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$pdo = new PDO('sqlite::memory:', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->sqliteCreateFunction('NOW', static fn(): string => '2026-09-13 12:00:00');
$pdo->exec('CREATE TABLE chat_attachments (
    id TEXT PRIMARY KEY, user_id INTEGER, batch_id TEXT, original_name TEXT, relative_path TEXT,
    extension TEXT, category TEXT, mime_type TEXT, size_bytes INTEGER, provider TEXT,
    provider_file_id TEXT, local_path TEXT, extracted_path TEXT, status TEXT,
    error_message TEXT, expires_at TEXT, deleted_at TEXT
)');
$config = ['web_attachments' => [
    'max_files' => 100, 'max_images' => 600,
    'max_file_size' => 5 * 1024 * 1024, 'max_image_size' => 32 * 1024 * 1024,
    'ttl_seconds' => 5400, 'max_extracted_chars' => 500000,
    'provider_connect_timeout_seconds' => 1, 'provider_timeout_seconds' => 1,
    'categories' => ['image' => ['png'], 'video' => [], 'audio' => [], 'document' => ['txt']],
]];
$service = new WebAttachmentService($pdo, $config);
$rows = [
    ['11111111-1111-4111-8111-111111111111', 7, 'ready', '2026-09-14 12:00:00'],
    ['22222222-2222-4222-8222-222222222222', 8, 'ready', '2026-09-14 12:00:00'],
    ['33333333-3333-4333-8333-333333333333', 7, 'ready', '2026-09-12 12:00:00'],
];
$insert = $pdo->prepare("INSERT INTO chat_attachments
    (id,user_id,batch_id,original_name,relative_path,extension,category,mime_type,size_bytes,provider,local_path,status,expires_at)
    VALUES (?,?, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a.png','a.png','png','image','image/png',68,'local','C:/tmp/a.png',?,?)");
foreach ($rows as [$id, $owner, $status, $expires]) $insert->execute([$id, $owner, $status, $expires]);

attachmentAssert(count($service->resolveOwned(7, [$rows[0][0]])) === 1, 'Owned ready attachment was not resolved');
foreach ([[$rows[1][0], 'ownership'], [$rows[2][0], 'expiry']] as [$id, $case]) {
    try {
        $service->resolveOwned(7, [$id]);
        throw new RuntimeException("{$case} validation was bypassed");
    } catch (RuntimeException $error) {
        attachmentAssert(str_contains($error->getMessage(), '不存在、已过期或无权访问'), "{$case} error is not readable");
    }
}

echo "web attachment vision contract: PASS\n";
