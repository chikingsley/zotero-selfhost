INSERT OR IGNORE INTO storage_accounts (
  user_id,
  quota_mb,
  unlimited,
  expiration
)
SELECT owner_user_id, NULL, 1, 0
FROM installation_state;
