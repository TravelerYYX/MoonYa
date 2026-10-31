CREATE TABLE IF NOT EXISTS conversation_storage_policy (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  mode ENUM('chat') NOT NULL,
  PRIMARY KEY (conversation_id),
  KEY idx_storage_user (user_id),
  CONSTRAINT fk_storage_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_storage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
