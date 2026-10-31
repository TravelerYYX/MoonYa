CREATE TABLE IF NOT EXISTS announcements (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    blocks MEDIUMTEXT NOT NULL,
    published_title VARCHAR(200) NULL,
    published_blocks MEDIUMTEXT NULL,
    revision INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('draft','published','withdrawn') NOT NULL DEFAULT 'draft',
    admin_id INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,
    KEY idx_announcement_feed (status, published_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
