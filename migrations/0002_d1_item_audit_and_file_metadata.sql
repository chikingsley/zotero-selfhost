ALTER TABLE items ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE items ADD COLUMN last_modified_by_user_id INTEGER;

ALTER TABLE attachment_files ADD COLUMN storage_md5 TEXT;
ALTER TABLE attachment_files ADD COLUMN storage_filename TEXT;
ALTER TABLE attachment_files ADD COLUMN zip INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS attachment_files_storage_idx
  ON attachment_files(library_type, library_id, storage_md5, zip);
