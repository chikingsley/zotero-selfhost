ALTER TABLE attachment_uploads ADD COLUMN upload_strategy TEXT NOT NULL DEFAULT 'proxy';
ALTER TABLE attachment_uploads ADD COLUMN multipart_upload_id TEXT;
