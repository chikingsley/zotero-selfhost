ALTER TABLE api_keys
ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1));

CREATE TABLE installation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  bootstrapped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Preserve access to deployments created before one-time bootstrap existed.
-- The oldest active key for user 1 becomes the owner recovery key.
UPDATE api_keys
SET is_owner = 1
WHERE api_key = (
  SELECT api_key
  FROM api_keys
  WHERE user_id = 1 AND revoked_at IS NULL
  ORDER BY created_at, api_key
  LIMIT 1
);

INSERT INTO installation_state (singleton, owner_user_id)
SELECT 1, user_id
FROM api_keys
WHERE is_owner = 1 AND revoked_at IS NULL
ORDER BY created_at, api_key
LIMIT 1;
