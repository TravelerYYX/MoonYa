-- Membership balances use millionths of a point; prices use CNY cents.
CREATE TABLE IF NOT EXISTS membership_plans (
 id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(100) NOT NULL,
 price_cents INT NOT NULL, monthly_units BIGINT NOT NULL,
 description VARCHAR(500) NOT NULL DEFAULT '', features_json JSON NOT NULL,
 is_free TINYINT NOT NULL DEFAULT 0, enabled TINYINT NOT NULL DEFAULT 1,
 archived TINYINT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS membership_accounts (
 user_id INT NOT NULL PRIMARY KEY, plan_id INT NOT NULL, subscription_json JSON NOT NULL,
 anchor_at DATETIME NOT NULL, expires_at DATETIME NULL, current_period_id BIGINT NULL,
 revision BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_periods (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
 starts_at DATETIME NOT NULL, ends_at DATETIME NOT NULL, allowance_units BIGINT NOT NULL,
 balance_units BIGINT NOT NULL, INDEX idx_credit_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_calls (
 id CHAR(36) NOT NULL PRIMARY KEY, user_id INT NOT NULL, period_id BIGINT NOT NULL,
 model_id VARCHAR(128) NOT NULL, multiplier_units BIGINT NOT NULL,
 input_tokens BIGINT NULL, output_tokens BIGINT NULL, cost_units BIGINT NOT NULL DEFAULT 0,
 charged_units BIGINT NOT NULL DEFAULT 0, status VARCHAR(32) NOT NULL DEFAULT 'running',
 created_at DATETIME NOT NULL, settled_at DATETIME NULL, INDEX idx_calls_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS credit_ledger (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, period_id BIGINT NOT NULL,
 call_id CHAR(36) NULL UNIQUE, kind VARCHAR(32) NOT NULL, delta_units BIGINT NOT NULL,
 balance_units BIGINT NOT NULL, details_json JSON NOT NULL, created_at DATETIME NOT NULL,
 INDEX idx_ledger_user (user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS builtin_models (
 id VARCHAR(128) NOT NULL PRIMARY KEY, label VARCHAR(128) NOT NULL,
 upstream_model VARCHAR(128) NOT NULL, endpoint VARCHAR(2048) NOT NULL,
 api_key TEXT NOT NULL, capabilities_json JSON NOT NULL, multiplier_units BIGINT NOT NULL,
 enabled TINYINT NOT NULL DEFAULT 1, archived TINYINT NOT NULL DEFAULT 0,
 is_default TINYINT NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
