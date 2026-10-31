<?php
declare(strict_types=1);

/** Only explicitly created Chat conversations may enter cloud history. */
final class ConversationStoragePolicy
{
    public const SCHEMA = <<<'SQL'
CREATE TABLE IF NOT EXISTS conversation_storage_policy (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  mode ENUM('chat') NOT NULL,
  PRIMARY KEY (conversation_id),
  KEY idx_storage_user (user_id),
  CONSTRAINT fk_storage_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_storage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL;

    public function __construct(private PDO $pdo)
    {
        $pdo->exec(self::SCHEMA);
    }

    public function registerChat(int $userId, int $conversationId): void
    {
        $this->pdo->prepare('INSERT INTO conversation_storage_policy (conversation_id, user_id, mode) VALUES (?, ?, ?)')
            ->execute([$conversationId, $userId, 'chat']);
    }

    public function isChat(int $userId, int $conversationId): bool
    {
        $stmt = $this->pdo->prepare("SELECT 1 FROM conversation_storage_policy WHERE conversation_id=? AND user_id=? AND mode='chat'");
        $stmt->execute([$conversationId, $userId]);
        return $stmt->fetchColumn() !== false;
    }
}
