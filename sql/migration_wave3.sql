USE FILEHUB;

-- Folders
CREATE TABLE IF NOT EXISTS folders (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(255)    NOT NULL,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id)
);

-- Tags (unique per user)
CREATE TABLE IF NOT EXISTS tags (
    id      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    name    VARCHAR(100)    NOT NULL,
    UNIQUE KEY uq_user_tag (user_id, name)
);

-- File ↔ Tag join table
CREATE TABLE IF NOT EXISTS file_tags (
    file_id BIGINT UNSIGNED NOT NULL,
    tag_id  BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (file_id, tag_id)
);

-- Add folder_id and is_favourite to files
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS folder_id    BIGINT UNSIGNED NULL DEFAULT NULL AFTER user_id,
    ADD COLUMN IF NOT EXISTS is_favourite TINYINT(1) NOT NULL DEFAULT 0 AFTER file_type;

ALTER TABLE files
    ADD INDEX IF NOT EXISTS idx_folder_id    (folder_id),
    ADD INDEX IF NOT EXISTS idx_is_favourite (is_favourite);
