<?php
declare(strict_types=1);
require_once __DIR__ . '/../Services/ConversationStoragePolicy.php';
require_once __DIR__ . '/../Services/WorkLocalAttachment.php';

function check(bool $value, string $message): void
{
    if (!$value) throw new RuntimeException($message);
}

// Execute the actual policy against a deterministic PDO adapter. No production database is touched.
final class PolicyStatement extends PDOStatement
{
    private mixed $result = false;
    public function __construct(private PolicyPdo $db, private string $sql) {}
    public function execute(?array $params = null): bool
    {
        if (str_starts_with($this->sql, 'INSERT')) {
            $this->db->rows[(int)$params[0]] = ['user' => (int)$params[1], 'mode' => $params[2]];
        } else {
            $row = $this->db->rows[(int)$params[0]] ?? null;
            $this->result = $row && $row['user'] === (int)$params[1] && $row['mode'] === 'chat' ? 1 : false;
        }
        return true;
    }
    public function fetchColumn(int $column = 0): mixed { return $this->result; }
}
final class PolicyPdo extends PDO
{
    public array $rows = [];
    public array $schema = [];
    public function __construct() {}
    public function exec(string $statement): int|false { $this->schema[] = $statement; return 0; }
    public function prepare(string $query, array $options = []): PDOStatement|false { return new PolicyStatement($this, $query); }
}
$db = new PolicyPdo();
$policy = new ConversationStoragePolicy($db);
check(!$policy->isChat(2, 1), 'legacy conversations must not be automatically classified as Chat');
check($db->rows === [], 'schema initialization must not backfill unknown history');
$policy->registerChat(2, 1);
check($policy->isChat(2, 1), 'explicit Chat registration must permit its owner');
check(!$policy->isChat(7, 1), 'another user must not read or mutate the Chat history');
check(!$policy->isChat(2, 9), 'an unregistered Work/legacy id must remain local');

$png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD6sAAAAASUVORK5CYII=';
$resolved = WorkLocalAttachment::resolve([
    ['name' => 'local.png', 'category' => 'image', 'data_url' => $png, 'order' => 1],
    ['name' => 'local.txt', 'category' => 'document', 'text' => 'all original local text'],
], 'low');
check($resolved['parts'][0]['image_url']['url'] === $png, 'local image bytes must be preserved');
check($resolved['parts'][0]['image_url']['detail'] === 'low', 'inference detail must follow the request');
check(str_contains($resolved['texts'][0], 'all original local text'), 'document text must remain complete');
foreach ([null, [['category' => 'image', 'data_url' => 'https://cloud.invalid/image.png']], [['category' => 'image', 'data_url' => 'data:image/png;base64,AAAA']], [['category' => 'audio']]] as $invalid) {
    $threw = false;
    try { WorkLocalAttachment::resolve($invalid, 'high'); } catch (InvalidArgumentException $error) { $threw = true; }
    check($threw, 'invalid or unsupported local attachments must fail without a cloud fallback');
}
$threw = false;
try { DeepSeekVision::describeImageInfo([8193, 1, IMAGETYPE_PNG], 'too-large.png'); }
catch (RuntimeException $error) { $threw = true; }
check($threw, 'native and inline images must share the existing model dimension validation');

echo "work local storage policy: PASS\n";
