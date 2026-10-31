CREATE TABLE IF NOT EXISTS membership_orders (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 order_no VARCHAR(40) NOT NULL UNIQUE, user_id INT NOT NULL,
 request_key VARCHAR(80) NOT NULL, plan_id INT NOT NULL, plan_json JSON NOT NULL,
 amount_cents INT NOT NULL, app_id VARCHAR(32) NOT NULL, seller_id VARCHAR(32) NOT NULL,
 environment VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
 pending_user_id INT NULL UNIQUE, checkout_hash CHAR(64) NULL UNIQUE,
 trade_no VARCHAR(64) NULL UNIQUE, created_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
 paid_at DATETIME NULL, confirmed_at DATETIME NULL, last_checked_at DATETIME NULL,
 user_deleted_at DATETIME NULL,
 UNIQUE KEY idx_order_request (user_id,request_key), INDEX idx_order_user (user_id,id),
 INDEX idx_order_reconcile (status,last_checked_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS membership_purchases (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 order_no VARCHAR(40) NOT NULL UNIQUE, user_id INT NOT NULL, plan_json JSON NOT NULL,
 status VARCHAR(16) NOT NULL, starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL,
 schedule_anchor_at DATETIME NOT NULL,
 INDEX idx_purchase_queue (user_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_transfers (
 source_period_id BIGINT NOT NULL PRIMARY KEY, target_period_id BIGINT NOT NULL,
 order_no VARCHAR(40) NOT NULL UNIQUE, amount_units BIGINT NOT NULL,
 remaining_units BIGINT NOT NULL, created_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
