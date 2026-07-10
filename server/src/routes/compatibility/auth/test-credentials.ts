import type { Bindings } from "../../../bindings";
import { isCompatibilityTestMode } from "../../../domain/compatibility-test-auth";
import { createKeyStore, managedKeyInfo } from "../../../domain/keys";
import { compatibility } from "../router";
import { readKeyRequestBody } from "../support";

export const resolveCompatibilityTestUserID = async (
  env: Bindings,
  input: unknown
): Promise<number | null> => {
  if (
    !(isCompatibilityTestMode(env) && isRecord(input)) ||
    typeof input.password !== "string"
  ) {
    return null;
  }

  const username = typeof input.username === "string" ? input.username : null;
  if (username) {
    const row = await env.DB.prepare(
      `SELECT user_id
       FROM users
       WHERE username = ? OR display_name = ? OR user_id = ?
       ORDER BY user_id
       LIMIT 1`
    )
      .bind(username, username, Number.parseInt(username, 10) || -1)
      .first<{ user_id: number }>();
    if (row) {
      return row.user_id;
    }
  }

  const fallback = await env.DB.prepare(
    "SELECT user_id FROM users ORDER BY user_id LIMIT 1"
  ).first<{ user_id: number }>();

  return fallback?.user_id ?? 1;
};

compatibility.post("/keys", async (c) => {
  if (!isCompatibilityTestMode(c.env)) {
    return c.text("Password login is not enabled", 404);
  }

  const body = await readKeyRequestBody(c);
  const userID = await resolveCompatibilityTestUserID(c.env, body);
  if (userID === null) {
    return c.text("Invalid login", 403);
  }

  const key = await createKeyStore(c.env).createKey({
    access: body.access,
    name: body.name,
    userID,
  });

  return c.json(managedKeyInfo(key), 201);
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
