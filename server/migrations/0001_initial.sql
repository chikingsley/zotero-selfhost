PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE api_keys (
  api_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  label TEXT,
  scopes_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX api_keys_user_id_idx ON api_keys(user_id);

CREATE TABLE login_sessions (
  session_token TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled')),
  user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  access_json TEXT,
  api_key TEXT REFERENCES api_keys(api_key) ON DELETE SET NULL,
  client_name TEXT NOT NULL DEFAULT 'Zotero',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX login_sessions_user_id_idx ON login_sessions(user_id);

CREATE TABLE groups (
  group_id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Private',
  library_version INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX groups_owner_user_id_idx ON groups(owner_user_id);

CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE storage_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  quota_mb INTEGER,
  unlimited INTEGER NOT NULL DEFAULT 0,
  expiration INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE libraries (
  library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
  library_id INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id)
);

CREATE TABLE collections (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  collection_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_collection_key TEXT,
  data_json TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, collection_key),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE INDEX collections_library_version_idx
  ON collections(library_type, library_id, version);

CREATE TABLE settings (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, setting_key),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE INDEX settings_library_version_idx
  ON settings(library_type, library_id, version);

CREATE TABLE searches (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  search_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, search_key),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE INDEX searches_library_version_idx
  ON searches(library_type, library_id, version);

CREATE TABLE items (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  parent_item_key TEXT,
  data_json TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, item_key),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE INDEX items_library_version_idx
  ON items(library_type, library_id, version);

CREATE INDEX items_parent_item_idx
  ON items(library_type, library_id, parent_item_key);

CREATE TABLE item_collection_memberships (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  collection_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, item_key, collection_key),
  FOREIGN KEY (library_type, library_id, item_key)
    REFERENCES items(library_type, library_id, item_key)
    ON DELETE CASCADE,
  FOREIGN KEY (library_type, library_id, collection_key)
    REFERENCES collections(library_type, library_id, collection_key)
    ON DELETE CASCADE
);

CREATE TABLE write_tokens (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  request_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, token),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE TABLE attachment_files (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT,
  content_type TEXT,
  charset TEXT,
  size_bytes INTEGER,
  md5 TEXT,
  mtime INTEGER,
  upload_state TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, item_key),
  FOREIGN KEY (library_type, library_id, item_key)
    REFERENCES items(library_type, library_id, item_key)
    ON DELETE CASCADE
);

CREATE TABLE attachment_uploads (
  upload_key TEXT PRIMARY KEY,
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  item_filename TEXT,
  content_type TEXT,
  charset TEXT,
  size_bytes INTEGER NOT NULL,
  md5 TEXT NOT NULL,
  item_md5 TEXT,
  mtime INTEGER NOT NULL,
  zip INTEGER NOT NULL DEFAULT 0,
  upload_state TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  uploaded_at TEXT,
  registered_at TEXT,
  FOREIGN KEY (library_type, library_id, item_key)
    REFERENCES items(library_type, library_id, item_key)
    ON DELETE CASCADE
);

CREATE INDEX attachment_uploads_item_idx
  ON attachment_uploads(library_type, library_id, item_key);

CREATE TABLE fulltext_items (
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  indexed_pages INTEGER,
  total_pages INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id, item_key),
  FOREIGN KEY (library_type, library_id, item_key)
    REFERENCES items(library_type, library_id, item_key)
    ON DELETE CASCADE
);

CREATE INDEX fulltext_items_library_version_idx
  ON fulltext_items(library_type, library_id, version);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_type TEXT NOT NULL,
  library_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (library_type, library_id)
    REFERENCES libraries(library_type, library_id)
    ON DELETE CASCADE
);

CREATE INDEX sync_log_library_version_idx
  ON sync_log(library_type, library_id, version);
