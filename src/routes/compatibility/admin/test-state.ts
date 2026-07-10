interface CompatibilityTestSetupResult {
  user1: {
    apiKey: string;
    userID: number;
  };
  user2: {
    apiKey: string;
    userID: number;
  };
}

const defaultKeyAccess = () => ({
  groups: { all: { library: true, write: true } },
  user: { files: true, library: true, notes: true, write: true },
});

export const resetCompatibilityTestState = async (
  db: D1Database,
  userID: number,
  userID2: number,
  user1Key: string,
  user2Key: string
): Promise<CompatibilityTestSetupResult> => {
  await db.batch([
    db.prepare("DELETE FROM sync_log"),
    db.prepare("DELETE FROM attachment_uploads"),
    db.prepare("DELETE FROM attachment_files"),
    db.prepare("DELETE FROM fulltext_index_states"),
    db.prepare("DELETE FROM fulltext_items"),
    db.prepare("DELETE FROM item_collection_memberships"),
    db.prepare("DELETE FROM items"),
    db.prepare("DELETE FROM collections"),
    db.prepare("DELETE FROM searches"),
    db.prepare("DELETE FROM settings"),
    db.prepare("DELETE FROM write_tokens"),
    db.prepare("DELETE FROM group_members"),
    db.prepare("DELETE FROM groups"),
    db.prepare("DELETE FROM login_sessions"),
    db.prepare("DELETE FROM installation_state"),
    db.prepare("DELETE FROM api_keys"),
    db.prepare("DELETE FROM storage_accounts"),
    db.prepare("DELETE FROM libraries"),
    db.prepare("DELETE FROM users"),
  ]);

  await db.batch([
    db.prepare("INSERT INTO users (user_id) VALUES (?)").bind(userID),
    db.prepare("INSERT INTO users (user_id) VALUES (?)").bind(userID2),
    db
      .prepare(
        "INSERT INTO api_keys (api_key, user_id, label, scopes_json) VALUES (?, ?, 'test-user-1', ?)"
      )
      .bind(user1Key, userID, JSON.stringify(defaultKeyAccess())),
    db
      .prepare(
        "INSERT INTO api_keys (api_key, user_id, label, scopes_json) VALUES (?, ?, 'test-user-2', ?)"
      )
      .bind(user2Key, userID2, JSON.stringify(defaultKeyAccess())),
    db
      .prepare(
        "INSERT INTO libraries (library_type, library_id) VALUES ('user', ?)"
      )
      .bind(userID),
    db
      .prepare(
        "INSERT INTO libraries (library_type, library_id) VALUES ('user', ?)"
      )
      .bind(userID2),
  ]);

  return {
    user1: {
      apiKey: user1Key,
      userID,
    },
    user2: {
      apiKey: user2Key,
      userID: userID2,
    },
  };
};
