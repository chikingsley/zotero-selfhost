export interface UserIdentity {
  displayName: string;
  username: string;
}

export const getDefaultUserIdentity = (userID: number): UserIdentity =>
  userID === 1
    ? { displayName: "Real Name", username: "phpunit" }
    : userID === 2
      ? { displayName: "Real Name 2", username: "phpunit2" }
      : {
          displayName: `User ${userID}`,
          username: `user${userID}`,
        };

export const getUserIdentity = async (
  db: D1Database,
  userID: number
): Promise<UserIdentity> => {
  const fallback = getDefaultUserIdentity(userID);
  const row = await db
    .prepare(
      "SELECT username, display_name FROM users WHERE user_id = ? LIMIT 1"
    )
    .bind(userID)
    .first<{ display_name: string | null; username: string | null }>();

  return {
    displayName: row?.display_name ?? fallback.displayName,
    username: row?.username ?? fallback.username,
  };
};
