USE filevault;

-- Required: allow ALTERing a table when adding system versioning
SET @@session.system_versioning_alter_history = 1;

-- Add soft-delete column so deleted files are recoverable
ALTER TABLE files
    ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL DEFAULT NULL,
    ADD INDEX  IF NOT EXISTS idx_deleted_at (deleted_at);

-- Enable System-Versioned Temporal Tables on files
-- MariaDB will now automatically track every INSERT / UPDATE / DELETE
-- and lets us query historical state with FOR SYSTEM_TIME AS OF / ALL
ALTER TABLE files ADD SYSTEM VERSIONING;
