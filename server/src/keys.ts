import type { Bindings } from "./bindings";
import { getState } from "./state";

export type Access = Record<string, unknown>;

export interface KeyInfo {
  access: Access;
  dateAdded?: string;
  displayName: string;
  id?: string;
  key: string;
  lastUsed?: string;
  name?: string;
  recentIPs?: string[];
  userID: number;
  username: string;
}

type LoginSessionStatusValue = "cancelled" | "completed" | "pending";

export interface LoginSessionInfo {
  access: Access | null;
  status: LoginSessionStatusValue;
  userID: number | null;
}

export interface LoginSessionStatus {
  apiKey?: string;
  status: LoginSessionStatusValue;
  userID?: number;
  username?: string;
}

interface KeyStore {
  cancelSession(sessionToken: string): Promise<"cancelled" | "conflict" | "missing">;
  completeSession(input: {
    access?: unknown;
    sessionToken?: unknown;
    userID?: unknown;
  }): Promise<"completed" | "conflict" | "invalid" | "missing">;
  createKey(input: {
    access?: unknown;
    name?: unknown;
    userID: number;
  }): Promise<KeyInfo>;
  createSession(input: {
    currentApiKey?: string | null;
    loginBaseURL: string;
    userAgent?: string | null;
    userID?: unknown;
  }): Promise<{ loginURL: string; sessionToken: string }>;
  deleteKey(apiKey: string): Promise<boolean>;
  getKey(apiKey: string): Promise<KeyInfo | null>;
  getSessionInfo(sessionToken: string): Promise<LoginSessionInfo | null>;
  getSessionStatus(sessionToken: string): Promise<LoginSessionStatus | null>;
  listUserKeys(userID: number): Promise<KeyInfo[]>;
  recordAccess(apiKey: string): Promise<void>;
  resolveCredentials(input: unknown): Promise<number | null>;
  updateKey(apiKey: string, input: { access?: unknown; name?: unknown }): Promise<KeyInfo | null>;
}

export const createKeyStore = (env: Bindings): KeyStore =>
  env.DB ? new D1KeyStore(env.DB) : memoryKeyStore;

export const publicKeyInfo = (key: KeyInfo): KeyInfo => ({
  access: key.access,
  displayName: key.displayName,
  key: key.key,
  userID: key.userID,
  username: key.username,
});

export const managedKeyInfo = (key: KeyInfo): KeyInfo => {
  const info: KeyInfo = {
    ...key,
    dateAdded: key.dateAdded ?? new Date().toISOString(),
    recentIPs: key.lastUsed ? [] : key.recentIPs,
  };

  if (!info.lastUsed) {
    delete info.lastUsed;
  }
  if (!info.recentIPs) {
    delete info.recentIPs;
  }

  return info;
};

const getAccessObject = (
  value: unknown,
  key: string
): Record<string, unknown> | null => {
  if (!isPlainObject(value)) {
    return null;
  }

  const child = value[key];
  return isPlainObject(child) ? child : null;
};

const hasBooleanPermission = (
  value: Record<string, unknown> | null,
  permission: string
): boolean => value?.[permission] === true;

export const keyAllowsUserPermission = (
  access: Access,
  permission: "files" | "library" | "notes" | "write"
): boolean => {
  const user = getAccessObject(access, "user");
  if (permission === "library") {
    return hasBooleanPermission(user, "library") || hasBooleanPermission(user, "write");
  }
  if (permission === "files") {
    return hasBooleanPermission(user, "files") || hasBooleanPermission(user, "write");
  }

  return hasBooleanPermission(user, permission);
};

export const keyAllowsGroupPermission = (
  access: Access,
  groupID: number,
  permission: "files" | "library" | "write"
): boolean => {
  const groups = getAccessObject(access, "groups");
  const candidates = [
    getAccessObject(groups, `${groupID}`),
    getAccessObject(groups, "0"),
    getAccessObject(groups, "all"),
  ];

  if (permission === "library") {
    return candidates.some(
      (candidate) =>
        hasBooleanPermission(candidate, "library") ||
        hasBooleanPermission(candidate, "write")
    );
  }
  if (permission === "files") {
    return candidates.some(
      (candidate) =>
        hasBooleanPermission(candidate, "files") ||
        hasBooleanPermission(candidate, "write")
    );
  }

  return candidates.some((candidate) => hasBooleanPermission(candidate, "write"));
};

interface MemoryLoginSession {
  access: Access | null;
  apiKey?: string;
  clientName: string;
  sessionToken: string;
  status: LoginSessionStatusValue;
  userID: number | null;
}

const memoryLoginSessions = new Map<string, MemoryLoginSession>();

const memoryKeyStore: KeyStore = {
  async cancelSession(sessionToken) {
    const session = memoryLoginSessions.get(sessionToken);
    if (!session) {
      return "missing";
    }
    if (session.status !== "pending") {
      return "conflict";
    }

    session.status = "cancelled";
    return "cancelled";
  },

  async completeSession(input) {
    const sessionToken =
      typeof input.sessionToken === "string" ? input.sessionToken : null;
    if (!sessionToken || !isPlainObject(input.access)) {
      return "invalid";
    }

    const session = memoryLoginSessions.get(sessionToken);
    if (!session) {
      return "missing";
    }
    if (session.status !== "pending") {
      return "conflict";
    }

    const userID = session.userID ?? parsePositiveInteger(input.userID);
    if (!userID) {
      return "invalid";
    }

    const key = await this.createKey({
      access: input.access,
      name: getSessionKeyName(session.clientName),
      userID,
    });
    session.apiKey = key.key;
    session.status = "completed";
    session.userID = userID;
    session.access = key.access;
    return "completed";
  },

  async createKey(input) {
    const key = generateApiKey();
    const record = {
      access: normalizeAccess(input.access),
      dateAdded: new Date().toISOString(),
      key,
      name: normalizeName(input.name),
      userID: input.userID,
    };
    getState().apiKeys.set(key, record);
    return keyRecordToInfo(record);
  },

  async createSession(input) {
    const currentKey = input.currentApiKey
      ? await this.getKey(input.currentApiKey)
      : null;
    const requestedUserID = parsePositiveInteger(input.userID);
    const sessionToken = generateSessionToken();
    const session: MemoryLoginSession = {
      access: currentKey?.access ?? null,
      clientName: detectClientName(input.userAgent),
      sessionToken,
      status: "pending",
      userID: currentKey?.userID ?? requestedUserID,
    };
    memoryLoginSessions.set(sessionToken, session);

    return {
      loginURL: `${input.loginBaseURL}/login?session=${sessionToken}`,
      sessionToken,
    };
  },

  async deleteKey(apiKey) {
    return getState().apiKeys.delete(apiKey);
  },

  async getKey(apiKey) {
    const record = getState().apiKeys.get(apiKey);
    return record ? keyRecordToInfo(record) : null;
  },

  async getSessionInfo(sessionToken) {
    const session = memoryLoginSessions.get(sessionToken);
    return session
      ? {
          access: session.access,
          status: session.status,
          userID: session.userID,
        }
      : null;
  },

  async getSessionStatus(sessionToken) {
    const session = memoryLoginSessions.get(sessionToken);
    if (!session) {
      return null;
    }

    const status: LoginSessionStatus = {
      status: session.status,
    };
    if (session.status === "completed" && session.apiKey && session.userID) {
      status.apiKey = session.apiKey;
      status.userID = session.userID;
      status.username = getUsername(session.userID);
    }

    return status;
  },

  async listUserKeys(userID) {
    return [...getState().apiKeys.values()]
      .filter((record) => record.userID === userID)
      .map(keyRecordToInfo);
  },

  async recordAccess(apiKey) {
    const record = getState().apiKeys.get(apiKey);
    if (record) {
      record.lastUsed = new Date().toISOString();
    }
  },

  async resolveCredentials(input) {
    if (!isPlainObject(input) || typeof input.password !== "string") {
      return null;
    }

    const userID = Number(input.userID);
    if (Number.isFinite(userID) && userID > 0) {
      return userID;
    }

    return getState().apiKeys.values().next().value?.userID ?? 1;
  },

  async updateKey(apiKey, input) {
    const record = getState().apiKeys.get(apiKey);
    if (!record) {
      return null;
    }

    record.access = normalizeAccess(input.access ?? record.access);
    record.name = normalizeName(input.name ?? record.name);
    return keyRecordToInfo(record);
  },
};

class D1KeyStore implements KeyStore {
  constructor(private readonly db: D1Database) {}

  async cancelSession(sessionToken: string): Promise<"cancelled" | "conflict" | "missing"> {
    const session = await this.getSessionRow(sessionToken);
    if (!session) {
      return "missing";
    }
    if (session.status !== "pending") {
      return "conflict";
    }

    await this.db
      .prepare(
        "UPDATE login_sessions SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_token = ?"
      )
      .bind(sessionToken)
      .run();
    return "cancelled";
  }

  async completeSession(input: {
    access?: unknown;
    sessionToken?: unknown;
    userID?: unknown;
  }): Promise<"completed" | "conflict" | "invalid" | "missing"> {
    const sessionToken =
      typeof input.sessionToken === "string" ? input.sessionToken : null;
    if (!sessionToken || !isPlainObject(input.access)) {
      return "invalid";
    }

    const session = await this.getSessionRow(sessionToken);
    if (!session) {
      return "missing";
    }
    if (session.status !== "pending") {
      return "conflict";
    }

    const userID = session.user_id ?? parsePositiveInteger(input.userID);
    if (!userID) {
      return "invalid";
    }

    const key = await this.createKey({
      access: input.access,
      name: getSessionKeyName(session.client_name),
      userID,
    });
    await this.db
      .prepare(
        `UPDATE login_sessions
         SET status = 'completed',
             api_key = ?,
             user_id = ?,
             access_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE session_token = ?`
      )
      .bind(key.key, userID, JSON.stringify(key.access), sessionToken)
      .run();

    return "completed";
  }

  async createKey(input: {
    access?: unknown;
    name?: unknown;
    userID: number;
  }): Promise<KeyInfo> {
    await this.ensureUser(input.userID);
    const key = generateApiKey();
    const access = normalizeAccess(input.access);
    const name = normalizeName(input.name);
    await this.db
      .prepare(
        `INSERT INTO api_keys (api_key, user_id, label, scopes_json)
         VALUES (?, ?, ?, ?)`
      )
      .bind(key, input.userID, name, JSON.stringify(access))
      .run();

    const info = await this.getKey(key);
    if (!info) {
      throw new Error("Created API key could not be read");
    }

    return info;
  }

  async createSession(input: {
    currentApiKey?: string | null;
    loginBaseURL: string;
    userAgent?: string | null;
    userID?: unknown;
  }): Promise<{ loginURL: string; sessionToken: string }> {
    const currentKey = input.currentApiKey
      ? await this.getKey(input.currentApiKey)
      : null;
    const requestedUserID = parsePositiveInteger(input.userID);
    const userID = currentKey?.userID ?? requestedUserID ?? null;
    if (userID) {
      await this.ensureUser(userID);
    }
    const sessionToken = generateSessionToken();
    await this.db
      .prepare(
        `INSERT INTO login_sessions
           (session_token, status, user_id, access_json, client_name)
         VALUES (?, 'pending', ?, ?, ?)`
      )
      .bind(
        sessionToken,
        userID,
        currentKey ? JSON.stringify(currentKey.access) : null,
        detectClientName(input.userAgent)
      )
      .run();

    return {
      loginURL: `${input.loginBaseURL}/login?session=${sessionToken}`,
      sessionToken,
    };
  }

  async deleteKey(apiKey: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE api_key = ? AND revoked_at IS NULL"
      )
      .bind(apiKey)
      .run();

    return (result.meta.changes ?? 0) > 0;
  }

  async getKey(apiKey: string): Promise<KeyInfo | null> {
    const row = await this.db
      .prepare(
        `SELECT api_keys.api_key, api_keys.user_id, api_keys.label, api_keys.scopes_json,
                api_keys.created_at, api_keys.last_used_at, users.username, users.display_name
         FROM api_keys
         LEFT JOIN users ON users.user_id = api_keys.user_id
         WHERE api_keys.api_key = ? AND api_keys.revoked_at IS NULL`
      )
      .bind(apiKey)
      .first<KeyRow>();

    return row ? rowToKeyInfo(row) : null;
  }

  async getSessionInfo(sessionToken: string): Promise<LoginSessionInfo | null> {
    const session = await this.getSessionRow(sessionToken);
    return session
      ? {
          access: parseNullableAccess(session.access_json),
          status: session.status,
          userID: session.user_id,
        }
      : null;
  }

  async getSessionStatus(sessionToken: string): Promise<LoginSessionStatus | null> {
    const session = await this.getSessionRow(sessionToken);
    if (!session) {
      return null;
    }

    const status: LoginSessionStatus = {
      status: session.status,
    };
    if (session.status === "completed" && session.api_key && session.user_id) {
      status.apiKey = session.api_key;
      status.userID = session.user_id;
      status.username = getUsername(session.user_id);
    }

    return status;
  }

  async listUserKeys(userID: number): Promise<KeyInfo[]> {
    await this.ensureUser(userID);
    const rows = await this.db
      .prepare(
        `SELECT api_keys.api_key, api_keys.user_id, api_keys.label, api_keys.scopes_json,
                api_keys.created_at, api_keys.last_used_at, users.username, users.display_name
         FROM api_keys
         LEFT JOIN users ON users.user_id = api_keys.user_id
         WHERE api_keys.user_id = ? AND api_keys.revoked_at IS NULL
         ORDER BY api_keys.created_at`
      )
      .bind(userID)
      .all<KeyRow>();

    return rows.results.map(rowToKeyInfo);
  }

  async recordAccess(apiKey: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE api_keys SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE api_key = ? AND revoked_at IS NULL"
      )
      .bind(apiKey)
      .run();
  }

  async resolveCredentials(input: unknown): Promise<number | null> {
    if (!isPlainObject(input) || typeof input.password !== "string") {
      return null;
    }

    const username = typeof input.username === "string" ? input.username : null;
    if (username) {
      const row = await this.db
        .prepare(
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

    const fallback = await this.db
      .prepare("SELECT user_id FROM users ORDER BY user_id LIMIT 1")
      .first<{ user_id: number }>();

    return fallback?.user_id ?? 1;
  }

  async updateKey(
    apiKey: string,
    input: { access?: unknown; name?: unknown }
  ): Promise<KeyInfo | null> {
    const existing = await this.getKey(apiKey);
    if (!existing) {
      return null;
    }

    const access = normalizeAccess(input.access ?? existing.access);
    const name = normalizeName(input.name ?? existing.name);
    await this.db
      .prepare(
        "UPDATE api_keys SET label = ?, scopes_json = ? WHERE api_key = ? AND revoked_at IS NULL"
      )
      .bind(name, JSON.stringify(access), apiKey)
      .run();

    return this.getKey(apiKey);
  }

  private async ensureUser(userID: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (user_id, username, display_name)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           username = COALESCE(users.username, excluded.username),
           display_name = COALESCE(users.display_name, excluded.display_name)`
      )
      .bind(userID, getUsername(userID), getDisplayName(userID))
      .run();
  }

  private async getSessionRow(sessionToken: string): Promise<LoginSessionRow | null> {
    return this.db
      .prepare(
        `SELECT session_token, status, user_id, access_json, api_key, client_name
         FROM login_sessions
         WHERE session_token = ?`
      )
      .bind(sessionToken)
      .first<LoginSessionRow>();
  }
}

interface KeyRow {
  api_key: string;
  created_at: string;
  display_name: string | null;
  label: string | null;
  last_used_at: string | null;
  scopes_json: string | null;
  user_id: number;
  username: string | null;
}

interface LoginSessionRow {
  access_json: string | null;
  api_key: string | null;
  client_name: string;
  session_token: string;
  status: LoginSessionStatusValue;
  user_id: number | null;
}

const rowToKeyInfo = (row: KeyRow): KeyInfo => ({
  access: parseAccess(row.scopes_json),
  dateAdded: row.created_at,
  displayName: row.display_name ?? getDisplayName(row.user_id),
  id: row.api_key,
  key: row.api_key,
  lastUsed: row.last_used_at ?? undefined,
  name: row.label ?? undefined,
  userID: row.user_id,
  username: row.username ?? getUsername(row.user_id),
});

const keyRecordToInfo = (record: {
  access?: Record<string, unknown>;
  dateAdded?: string;
  key: string;
  lastUsed?: string;
  name?: string;
  userID: number;
}): KeyInfo => ({
  access: record.access ?? defaultAccess(),
  dateAdded: record.dateAdded,
  displayName: getDisplayName(record.userID),
  id: record.key,
  key: record.key,
  lastUsed: record.lastUsed,
  name: record.name,
  userID: record.userID,
  username: getUsername(record.userID),
});

const normalizeAccess = (access: unknown): Access => {
  if (!isPlainObject(access)) {
    return defaultAccess();
  }

  const normalized: Access = { ...access };
  if (isPlainObject(normalized.user)) {
    normalized.user = {
      ...normalized.user,
      files:
        typeof normalized.user.files === "boolean"
          ? normalized.user.files
          : normalized.user.library === true,
    };
  }

  return normalized;
};

const defaultAccess = (): Access => ({
  groups: {
    all: {
      library: true,
      write: true,
    },
  },
  user: {
    files: true,
    library: true,
    notes: true,
    write: true,
  },
});

const parseAccess = (value: string | null): Access => {
  if (!value) {
    return defaultAccess();
  }

  try {
    return normalizeAccess(JSON.parse(value));
  } catch {
    return defaultAccess();
  }
};

const parseNullableAccess = (value: string | null): Access | null =>
  value ? parseAccess(value) : null;

const normalizeName = (name: unknown): string | undefined =>
  typeof name === "string" && name.length > 0 ? name : undefined;

const generateApiKey = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

const generateSessionToken = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const detectClientName = (userAgent?: string | null): string => {
  const value = userAgent ?? "";
  if (/windows/i.test(value)) {
    return "Windows";
  }
  if (/linux|x11/i.test(value)) {
    return "Linux";
  }
  if (/macintosh|mac os|macos/i.test(value)) {
    return "macOS";
  }

  return "Zotero";
};

const getSessionKeyName = (clientName: string): string =>
  `Zotero ${clientName} Login`;

const parsePositiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const getUsername = (userID: number) => `user${userID}`;
const getDisplayName = (userID: number) => `User ${userID}`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
