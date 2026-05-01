USE FILEHUB;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(100) NOT NULL UNIQUE,
    email      VARCHAR(255) NOT NULL UNIQUE,
    password   VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email (email)
);

-- Add user_id to files (default 0 = legacy/unowned files)
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS user_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER id,
    ADD INDEX IF NOT EXISTS idx_user_id (user_id);
