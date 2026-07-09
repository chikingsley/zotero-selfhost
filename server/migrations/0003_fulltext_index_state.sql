CREATE TABLE IF NOT EXISTS fulltext_index_states (
  library_type TEXT NOT NULL CHECK (library_type IN ('user', 'group')),
  library_id INTEGER NOT NULL,
  deindexed INTEGER NOT NULL DEFAULT 0,
  reindexing INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (library_type, library_id)
);
