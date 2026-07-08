import type { Bindings } from "./bindings";
import { recordMemoryDeletion } from "./deleted";
import { getLibrary } from "./state";

type LibraryType = "group" | "user";

type SettingFailureCode = 400 | 403 | 412 | 413;

export interface SettingRecord {
  value: unknown;
  version: number;
}

export interface SettingPayload {
  value?: unknown;
  version?: unknown;
}

export interface SettingFailure {
  code: SettingFailureCode;
  data?: Record<string, unknown>;
  message: string;
}

export interface SettingWriteResult {
  changed: boolean;
  failed: Record<string, SettingFailure>;
  preconditionFailed: boolean;
  successful: Record<string, SettingRecord>;
  unchanged: Record<string, SettingRecord>;
  version: number;
}

interface SettingDeleteResult {
  deleted: string[];
  notFound: boolean;
  preconditionFailed: boolean;
  version: number;
}

interface SettingsStore {
  clearSettings(libraryType: LibraryType, libraryID: number): Promise<void>;
  deleteSettings(
    libraryType: LibraryType,
    libraryID: number,
    settingKeys: string[],
    ifUnmodifiedSinceVersion?: number | null,
    requireExisting?: boolean
  ): Promise<SettingDeleteResult>;
  deleteSettingsWithoutLog(
    libraryType: LibraryType,
    libraryID: number,
    settingKeys: string[]
  ): Promise<void>;
  getSetting(
    libraryType: LibraryType,
    libraryID: number,
    settingKey: string
  ): Promise<{ setting: SettingRecord; version: number } | null>;
  listSettings(
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion?: number | null
  ): Promise<{ settings: Record<string, SettingRecord>; version: number }>;
  upsertSettings(
    libraryType: LibraryType,
    libraryID: number,
    entries: Array<[string, SettingPayload]>,
    ifUnmodifiedSinceVersion?: number | null,
    canWriteAdminSettings?: boolean
  ): Promise<SettingWriteResult>;
}

interface D1SettingRow {
  setting_key: string;
  value_json: string;
  version: number;
}

const maxValueLength = 1_000_000;
const allowedSettingNames = new Set([
  "attachmentRenameTemplate",
  "autoRenameFiles",
  "autoRenameFilesFileTypes",
  "feeds",
  "readerCustomThemes",
  "tagColors",
]);
const adminOnlySettingNames = new Set([
  "attachmentRenameTemplate",
  "autoRenameFiles",
  "autoRenameFilesFileTypes",
]);

export const createSettingsStore = (env: Bindings): SettingsStore =>
  env.DB ? new D1SettingsStore(env.DB) : memorySettingsStore;

export const isAdminOnlySettingKey = (settingKey: string): boolean =>
  adminOnlySettingNames.has(settingKey);

export const parseSettingsRequestBody = (body: string): unknown => {
  const bigintSafeBody = body.replace(
    /("value"\s*:\s*)(-?\d{16,})(?=\s*[,}\]])/g,
    '$1"$2"'
  );

  return JSON.parse(bigintSafeBody);
};

const memorySettings = new Map<string, Map<string, SettingRecord>>();

export const clearMemorySettings = (
  libraryType?: LibraryType,
  libraryID?: number
) => {
  if (libraryType && libraryID !== undefined) {
    memorySettings.delete(getMemorySettingsLibraryKey(libraryType, libraryID));
    return;
  }

  memorySettings.clear();
};

const memorySettingsStore: SettingsStore = {
  async clearSettings(libraryType, libraryID) {
    clearMemorySettings(libraryType, libraryID);
  },

  async deleteSettings(
    libraryType,
    libraryID,
    settingKeys,
    ifUnmodifiedSinceVersion = null,
    requireExisting = false
  ) {
    const settings = getMemorySettings(libraryType, libraryID);
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const existing = settingKeys.filter((settingKey) => settings.has(settingKey));

    if (requireExisting && existing.length === 0) {
      return {
        deleted: [],
        notFound: true,
        preconditionFailed: false,
        version: library.version,
      };
    }

    if (
      ifUnmodifiedSinceVersion !== null &&
      existing.some(
        (settingKey) =>
          (settings.get(settingKey)?.version ?? 0) > ifUnmodifiedSinceVersion
      )
    ) {
      return {
        deleted: [],
        notFound: false,
        preconditionFailed: true,
        version: library.version,
      };
    }

    if (existing.length > 0) {
      library.version += 1;
      for (const settingKey of existing) {
        settings.delete(settingKey);
        recordMemoryDeletion(libraryType, libraryID, library.version, "setting", settingKey);
      }
    }

    return {
      deleted: existing,
      notFound: false,
      preconditionFailed: false,
      version: library.version,
    };
  },

  async deleteSettingsWithoutLog(libraryType, libraryID, settingKeys) {
    const settings = getMemorySettings(libraryType, libraryID);
    for (const settingKey of settingKeys) {
      settings.delete(settingKey);
    }
  },

  async getSetting(libraryType, libraryID, settingKey) {
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const setting = getMemorySettings(libraryType, libraryID).get(settingKey);

    return setting
      ? {
          setting,
          version: library.version,
        }
      : null;
  },

  async listSettings(libraryType, libraryID, sinceVersion = null) {
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const settings: Record<string, SettingRecord> = {};

    for (const [settingKey, setting] of getMemorySettings(libraryType, libraryID)) {
      if (sinceVersion !== null && setting.version <= sinceVersion) {
        continue;
      }
      settings[settingKey] = setting;
    }

    return {
      settings,
      version: library.version,
    };
  },

  async upsertSettings(
    libraryType,
    libraryID,
    entries,
    ifUnmodifiedSinceVersion = null,
    canWriteAdminSettings = true
  ) {
    const settings = getMemorySettings(libraryType, libraryID);
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const result = createSettingWriteResult(library.version);

    if (
      ifUnmodifiedSinceVersion !== null &&
      library.version > ifUnmodifiedSinceVersion
    ) {
      result.preconditionFailed = true;
      return result;
    }

    // Official checkJSONObjectVersion: a per-setting 'version' property lower
    // than the stored setting's version fails the whole request with 412.
    for (const [settingKey, payload] of entries) {
      const requestedVersion = payload?.version;
      if (typeof requestedVersion === "number") {
        const current = settings.get(settingKey);
        if (current && current.version > requestedVersion) {
          result.preconditionFailed = true;
          return result;
        }
      }
    }

    const changes: Array<[string, unknown, number]> = [];

    entries.forEach(([settingKey, payload], index) => {
      const failure = validateSettingWrite(
        libraryType,
        settingKey,
        payload,
        canWriteAdminSettings
      );
      if (failure) {
        result.failed[index] = failure;
        return;
      }

      const value = payload.value;
      const existing = settings.get(settingKey);
      if (existing && settingValuesEqual(existing.value, value)) {
        result.unchanged[index] = existing;
        return;
      }

      changes.push([settingKey, value, index]);
    });

    if (changes.length === 0) {
      return result;
    }

    library.version += 1;
    result.changed = true;
    result.version = library.version;

    for (const [settingKey, value, index] of changes) {
      const setting = {
        value,
        version: library.version,
      };
      settings.set(settingKey, setting);
      result.successful[index] = setting;
    }

    return result;
  },
};

class D1SettingsStore implements SettingsStore {
  constructor(private readonly db: D1Database) {}

  async clearSettings(libraryType: LibraryType, libraryID: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM settings WHERE library_type = ? AND library_id = ?")
      .bind(libraryType, libraryID)
      .run();
  }

  async deleteSettings(
    libraryType: LibraryType,
    libraryID: number,
    settingKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null,
    requireExisting = false
  ): Promise<SettingDeleteResult> {
    await this.ensureLibrary(libraryType, libraryID);
    const existing = await this.getSettingsByKey(libraryType, libraryID, settingKeys);
    const version = await this.getLibraryVersion(libraryType, libraryID);
    const existingKeys = settingKeys.filter((settingKey) => existing.has(settingKey));

    if (requireExisting && existingKeys.length === 0) {
      return {
        deleted: [],
        notFound: true,
        preconditionFailed: false,
        version,
      };
    }

    if (
      ifUnmodifiedSinceVersion !== null &&
      existingKeys.some(
        (settingKey) =>
          (existing.get(settingKey)?.version ?? 0) > ifUnmodifiedSinceVersion
      )
    ) {
      return {
        deleted: [],
        notFound: false,
        preconditionFailed: true,
        version,
      };
    }

    if (existingKeys.length === 0) {
      return {
        deleted: [],
        notFound: false,
        preconditionFailed: false,
        version,
      };
    }

    const nextVersion = await this.bumpLibraryVersion(libraryType, libraryID);
    await this.db.batch(
      existingKeys.flatMap((settingKey) => [
        this.db
          .prepare(
            "DELETE FROM settings WHERE library_type = ? AND library_id = ? AND setting_key = ?"
          )
          .bind(libraryType, libraryID, settingKey),
        this.db
          .prepare(
            `INSERT INTO sync_log
             (library_type, library_id, version, operation, object_type, object_key)
             VALUES (?, ?, ?, 'delete', 'setting', ?)`
          )
          .bind(libraryType, libraryID, nextVersion, settingKey),
      ])
    );

    return {
      deleted: existingKeys,
      notFound: false,
      preconditionFailed: false,
      version: nextVersion,
    };
  }

  async deleteSettingsWithoutLog(
    libraryType: LibraryType,
    libraryID: number,
    settingKeys: string[]
  ): Promise<void> {
    await this.ensureLibrary(libraryType, libraryID);
    if (settingKeys.length === 0) {
      return;
    }

    await this.db
      .prepare(
        `DELETE FROM settings
         WHERE library_type = ?
           AND library_id = ?
           AND setting_key IN (${settingKeys.map(() => "?").join(",")})`
      )
      .bind(libraryType, libraryID, ...settingKeys)
      .run();
  }

  async getSetting(
    libraryType: LibraryType,
    libraryID: number,
    settingKey: string
  ): Promise<{ setting: SettingRecord; version: number } | null> {
    await this.ensureLibrary(libraryType, libraryID);
    const row = await this.db
      .prepare(
        `SELECT setting_key, value_json, version
         FROM settings
         WHERE library_type = ?
           AND library_id = ?
           AND setting_key = ?`
      )
      .bind(libraryType, libraryID, settingKey)
      .first<D1SettingRow>();

    if (!row) {
      return null;
    }

    return {
      setting: rowToSetting(row),
      version: await this.getLibraryVersion(libraryType, libraryID),
    };
  }

  async listSettings(
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion: number | null = null
  ): Promise<{ settings: Record<string, SettingRecord>; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);
    const query = sinceVersion === null
      ? `SELECT setting_key, value_json, version
         FROM settings
         WHERE library_type = ? AND library_id = ?
         ORDER BY setting_key`
      : `SELECT setting_key, value_json, version
         FROM settings
         WHERE library_type = ? AND library_id = ? AND version > ?
         ORDER BY setting_key`;
    const statement = this.db.prepare(query);
    const rows = sinceVersion === null
      ? await statement.bind(libraryType, libraryID).all<D1SettingRow>()
      : await statement.bind(libraryType, libraryID, sinceVersion).all<D1SettingRow>();
    const settings: Record<string, SettingRecord> = {};

    for (const row of rows.results ?? []) {
      settings[row.setting_key] = rowToSetting(row);
    }

    return {
      settings,
      version: await this.getLibraryVersion(libraryType, libraryID),
    };
  }

  async upsertSettings(
    libraryType: LibraryType,
    libraryID: number,
    entries: Array<[string, SettingPayload]>,
    ifUnmodifiedSinceVersion: number | null = null,
    canWriteAdminSettings = true
  ): Promise<SettingWriteResult> {
    await this.ensureLibrary(libraryType, libraryID);
    const version = await this.getLibraryVersion(libraryType, libraryID);
    const result = createSettingWriteResult(version);

    if (ifUnmodifiedSinceVersion !== null && version > ifUnmodifiedSinceVersion) {
      result.preconditionFailed = true;
      return result;
    }

    const existing = await this.getSettingsByKey(
      libraryType,
      libraryID,
      entries.map(([settingKey]) => settingKey)
    );
    const changes: Array<[string, unknown, number]> = [];

    entries.forEach(([settingKey, payload], index) => {
      const failure = validateSettingWrite(
        libraryType,
        settingKey,
        payload,
        canWriteAdminSettings
      );
      if (failure) {
        result.failed[index] = failure;
        return;
      }

      const value = payload.value;
      const current = existing.get(settingKey);
      if (current && settingValuesEqual(current.value, value)) {
        result.unchanged[index] = current;
        return;
      }

      changes.push([settingKey, value, index]);
    });

    if (changes.length === 0) {
      return result;
    }

    const nextVersion = await this.bumpLibraryVersion(libraryType, libraryID);
    await this.db.batch(
      changes.flatMap(([settingKey, value]) => [
        this.db
          .prepare(
            `INSERT INTO settings
             (library_type, library_id, setting_key, value_json, version, updated_at)
             VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(library_type, library_id, setting_key)
             DO UPDATE SET
               value_json = excluded.value_json,
               version = excluded.version,
               updated_at = excluded.updated_at`
          )
          .bind(libraryType, libraryID, settingKey, JSON.stringify(value), nextVersion),
        this.db
          .prepare(
            `INSERT INTO sync_log
             (library_type, library_id, version, operation, object_type, object_key)
             VALUES (?, ?, ?, 'upsert', 'setting', ?)`
          )
          .bind(libraryType, libraryID, nextVersion, settingKey),
      ])
    );

    result.changed = true;
    result.version = nextVersion;
    for (const [settingKey, value, index] of changes) {
      result.successful[index] = {
        value,
        version: nextVersion,
      };
    }

    return result;
  }

  private async bumpLibraryVersion(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `UPDATE libraries
         SET version = version + 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE library_type = ? AND library_id = ?
         RETURNING version`
      )
      .bind(libraryType, libraryID)
      .first<{ version: number }>();

    return row?.version ?? this.getLibraryVersion(libraryType, libraryID);
  }

  private async ensureLibrary(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<void> {
    const statements = [
      this.db
        .prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES (?, ?)"
        )
        .bind(libraryType, libraryID),
    ];

    if (libraryType === "user") {
      statements.unshift(
        this.db
          .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
          .bind(libraryID)
      );
    }

    await this.db.batch(statements);
  }

  private async getLibraryVersion(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT version FROM libraries WHERE library_type = ? AND library_id = ?"
      )
      .bind(libraryType, libraryID)
      .first<{ version: number }>();

    return row?.version ?? 0;
  }

  private async getSettingsByKey(
    libraryType: LibraryType,
    libraryID: number,
    settingKeys: string[]
  ): Promise<Map<string, SettingRecord>> {
    if (settingKeys.length === 0) {
      return new Map();
    }

    const placeholders = settingKeys.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `SELECT setting_key, value_json, version
         FROM settings
         WHERE library_type = ?
           AND library_id = ?
           AND setting_key IN (${placeholders})`
      )
      .bind(libraryType, libraryID, ...settingKeys)
      .all<D1SettingRow>();
    const settings = new Map<string, SettingRecord>();

    for (const row of rows.results ?? []) {
      settings.set(row.setting_key, rowToSetting(row));
    }

    return settings;
  }
}

const createSettingWriteResult = (version: number): SettingWriteResult => ({
  changed: false,
  failed: {},
  preconditionFailed: false,
  successful: {},
  unchanged: {},
  version,
});

const getMemoryLibraryID = (libraryType: LibraryType, libraryID: number) =>
  libraryType === "user" ? libraryID : -libraryID;

const getMemorySettingsLibraryKey = (libraryType: LibraryType, libraryID: number) =>
  `${libraryType}:${libraryID}`;

const getMemorySettings = (libraryType: LibraryType, libraryID: number) => {
  const key = getMemorySettingsLibraryKey(libraryType, libraryID);
  const existing = memorySettings.get(key);
  if (existing) {
    return existing;
  }

  const settings = new Map<string, SettingRecord>();
  memorySettings.set(key, settings);
  return settings;
};

const rowToSetting = (row: D1SettingRow): SettingRecord => ({
  value: JSON.parse(row.value_json),
  version: row.version,
});

const validateSettingWrite = (
  libraryType: LibraryType,
  settingKey: string,
  payload: SettingPayload,
  canWriteAdminSettings: boolean
): SettingFailure | null => {
  if (libraryType === "group" && isAdminOnlySettingKey(settingKey) && !canWriteAdminSettings) {
    return {
      code: 403,
      message: `Only group admins can change setting '${settingKey}'`,
    };
  }

  if (!isSettingPayload(payload) || !("value" in payload)) {
    return {
      code: 400,
      message: "Setting object must include 'value'",
    };
  }

  return validateSettingValue(libraryType, settingKey, payload.value);
};

const validateSettingValue = (
  libraryType: LibraryType,
  settingKey: string,
  value: unknown
): SettingFailure | null => {
  if (!isAllowedSettingName(settingKey)) {
    return {
      code: 400,
      message: `Unsupported setting '${settingKey}'`,
    };
  }

  const encodedLength = typeof value === "string"
    ? value.length
    : JSON.stringify(value)?.length ?? 0;
  if (encodedLength > maxValueLength) {
    return {
      code: 413,
      message: `'value' cannot be longer than ${maxValueLength} characters`,
    };
  }

  const baseName = settingKey.match(/^[a-z]+/i)?.[0] ?? settingKey;

  if (libraryType === "group" && (baseName === "lastPageIndex" || baseName === "lastRead")) {
    return {
      code: 400,
      message: `${baseName} can only be set in user library`,
    };
  }

  switch (baseName) {
    case "feeds":
    case "lastReadAloudPosition":
      if (!isPlainObject(value)) {
        return {
          code: 400,
          message: "'value' must be an object",
        };
      }
      return null;

    case "readerCustomThemes":
    case "tagColors":
      if (!Array.isArray(value)) {
        return {
          code: 400,
          message: "'value' must be an array",
        };
      }
      if (value.length === 0) {
        return {
          code: 400,
          message: "'value' array cannot be empty",
        };
      }
      return null;

    case "lastRead":
      if (!Number.isInteger(value)) {
        return {
          code: 400,
          message: "'value' must be an integer",
        };
      }
      return null;

    case "autoRenameFiles":
      if (typeof value !== "boolean") {
        return {
          code: 400,
          message: "'value' must be a boolean",
        };
      }
      return null;

    case "lastPageIndex":
      return validateLastPageIndex(value);

    default:
      if (typeof value !== "string") {
        return {
          code: 400,
          message: "'value' must be a string",
        };
      }
      if (value === "") {
        return {
          code: 400,
          message: "'value' cannot be empty",
        };
      }
      return null;
  }
};

const validateLastPageIndex = (value: unknown): SettingFailure | null => {
  if (typeof value === "string") {
    if (value === "") {
      return {
        code: 400,
        message: "'value' cannot be empty",
      };
    }
    return null;
  }

  if (Number.isInteger(value)) {
    return null;
  }

  if (typeof value !== "number") {
    return {
      code: 400,
      message: "'value' must be an integer, string, or decimal",
    };
  }

  if (value < 0 || value > 100) {
    return {
      code: 400,
      message: "Decimal value must be between 0 and 100",
    };
  }

  if (!isOneDecimalPlace(value)) {
    return {
      code: 400,
      message: "Decimal value must be to one decimal place",
    };
  }

  return null;
};

const isAllowedSettingName = (settingKey: string): boolean =>
  allowedSettingNames.has(settingKey) ||
  /^lastPageIndex_(u|g[0-9]+)_[A-Z0-9]{8}$/.test(settingKey) ||
  /^lastRead_(g[0-9]+)_[A-Z0-9]{8}$/.test(settingKey) ||
  /^lastReadAloudPosition_(u|g[0-9]+)_[A-Z0-9]{8}$/.test(settingKey);

const isOneDecimalPlace = (value: number): boolean =>
  Math.abs(value * 10 - Math.round(value * 10)) < Number.EPSILON;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSettingPayload = (value: unknown): value is SettingPayload =>
  isPlainObject(value);

const settingValuesEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
