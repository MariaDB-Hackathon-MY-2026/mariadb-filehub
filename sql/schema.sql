CREATE DATABASE IF NOT EXISTS FILEHUB CHARACTER SET utf8mb4;
USE FILEHUB;

CREATE TABLE IF NOT EXISTS files (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    r2_key         VARCHAR(512)  NOT NULL UNIQUE,
    filename       VARCHAR(512)  NOT NULL,
    mime_type      VARCHAR(128)  NOT NULL DEFAULT 'application/octet-stream',
    size_bytes     BIGINT        NOT NULL DEFAULT 0,
    file_type      ENUM('pdf','docx','image','audio','code','other') NOT NULL DEFAULT 'other',
    extracted_text MEDIUMTEXT    NULL,
    embedding      VECTOR(1536)  NOT NULL,
    uploaded_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_uploaded_at (uploaded_at),
    INDEX idx_filename (filename(128)),
    INDEX idx_size_bytes (size_bytes),
    INDEX idx_file_type (file_type),
    VECTOR INDEX idx_embedding (embedding)
);
