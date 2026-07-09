import type { Bindings } from "../bindings";
import { generateZoteroKey, sanitizeZoteroData } from "./zotero";

type LibraryType = "group" | "user";

type SearchFailureCode = 400 | 404 | 412 | 413 | 428;

export interface SearchRecord {
  data: Record<string, unknown>;
  key: string;
  version: number;
}

export interface SearchFailure {
  code: SearchFailureCode;
  data?: Record<string, unknown>;
  message: string;
}

export interface SearchWriteResult {
  failed: Record<string, SearchFailure>;
  success: string[];
  successful: SearchRecord[];
  unchanged: SearchRecord[];
  version: number;
}

interface SearchStore {
  clearSearches: (libraryType: LibraryType, libraryID: number) => Promise<void>;
  deleteSearches: (
    libraryType: LibraryType,
    libraryID: number,
    searchKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }>;
  getSearch: (
    libraryType: LibraryType,
    libraryID: number,
    searchKey: string
  ) => Promise<{ search: SearchRecord; version: number } | null>;
  listSearches: (
    libraryType: LibraryType,
    libraryID: number,
    options?: { searchKeys?: string[]; sinceVersion?: number | null }
  ) => Promise<{ searches: SearchRecord[]; version: number }>;
  upsertSearches: (
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<SearchWriteResult & { preconditionFailed: boolean }>;
}

interface D1SearchRow {
  data_json: string;
  search_key: string;
  version: number;
}

export const createSearchStore = (env: Bindings): SearchStore =>
  new D1SearchStore(env.DB);

export const searchNeedsInvalidProp = (
  search: SearchRecord,
  schemaVersion?: number | null
): boolean => {
  if (!schemaVersion || schemaVersion >= 43) {
    return false;
  }

  return (
    Array.isArray(search.data.conditions) &&
    search.data.conditions.some(
      (condition) =>
        isPlainObject(condition) &&
        ["groupStart", "groupEnd", "resultLevel", "titleCreatorYear"].includes(
          String(condition.condition)
        )
    )
  );
};

class D1SearchStore implements SearchStore {
  constructor(private readonly db: D1Database) {}

  async clearSearches(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<void> {
    await this.db
      .prepare("DELETE FROM searches WHERE library_type = ? AND library_id = ?")
      .bind(libraryType, libraryID)
      .run();
  }

  async deleteSearches(
    libraryType: LibraryType,
    libraryID: number,
    searchKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    await this.ensureLibrary(libraryType, libraryID);
    const version = await this.getLibraryVersion(libraryType, libraryID);
    if (
      ifUnmodifiedSinceVersion !== null &&
      version > ifUnmodifiedSinceVersion
    ) {
      return {
        deleted: [],
        preconditionFailed: true,
        version,
      };
    }

    const existing = await this.getSearchesByKey(
      libraryType,
      libraryID,
      searchKeys
    );
    const existingKeys = searchKeys.filter((searchKey) =>
      existing.has(searchKey)
    );
    if (existingKeys.length === 0) {
      return {
        deleted: [],
        preconditionFailed: false,
        version,
      };
    }

    const nextVersion = await this.bumpLibraryVersion(libraryType, libraryID);
    await this.db.batch(
      existingKeys.flatMap((searchKey) => [
        this.db
          .prepare(
            "DELETE FROM searches WHERE library_type = ? AND library_id = ? AND search_key = ?"
          )
          .bind(libraryType, libraryID, searchKey),
        this.db
          .prepare(
            `INSERT INTO sync_log
             (library_type, library_id, version, operation, object_type, object_key)
             VALUES (?, ?, ?, 'delete', 'search', ?)`
          )
          .bind(libraryType, libraryID, nextVersion, searchKey),
      ])
    );

    return {
      deleted: existingKeys,
      preconditionFailed: false,
      version: nextVersion,
    };
  }

  async getSearch(
    libraryType: LibraryType,
    libraryID: number,
    searchKey: string
  ): Promise<{ search: SearchRecord; version: number } | null> {
    await this.ensureLibrary(libraryType, libraryID);
    const row = await this.db
      .prepare(
        `SELECT search_key, version, data_json
         FROM searches
         WHERE library_type = ? AND library_id = ? AND search_key = ?`
      )
      .bind(libraryType, libraryID, searchKey)
      .first<D1SearchRow>();

    return row
      ? {
          search: parseSearchRow(row),
          version: await this.getLibraryVersion(libraryType, libraryID),
        }
      : null;
  }

  async listSearches(
    libraryType: LibraryType,
    libraryID: number,
    options: { searchKeys?: string[]; sinceVersion?: number | null } = {}
  ): Promise<{ searches: SearchRecord[]; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);
    const where = ["library_type = ?", "library_id = ?"];
    const params: unknown[] = [libraryType, libraryID];

    if (options.searchKeys?.length) {
      where.push(
        `search_key IN (${options.searchKeys.map(() => "?").join(",")})`
      );
      params.push(...options.searchKeys);
    }
    if (options.sinceVersion !== null && options.sinceVersion !== undefined) {
      where.push("version > ?");
      params.push(options.sinceVersion);
    }

    const rows = await this.db
      .prepare(
        `SELECT search_key, version, data_json
         FROM searches
         WHERE ${where.join(" AND ")}
         ORDER BY version ASC`
      )
      .bind(...params)
      .all<D1SearchRow>();

    return {
      searches: rows.results.map(parseSearchRow),
      version: await this.getLibraryVersion(libraryType, libraryID),
    };
  }

  async upsertSearches(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<SearchWriteResult & { preconditionFailed: boolean }> {
    await this.ensureLibrary(libraryType, libraryID);
    const version = await this.getLibraryVersion(libraryType, libraryID);
    const result = createSearchWriteResult(version);

    if (
      ifUnmodifiedSinceVersion !== null &&
      version > ifUnmodifiedSinceVersion
    ) {
      return {
        ...result,
        preconditionFailed: true,
      };
    }
    if (
      ifUnmodifiedSinceVersion !== null &&
      !(await this.reservePreconditionGuard(
        libraryType,
        libraryID,
        ifUnmodifiedSinceVersion
      ))
    ) {
      return {
        ...result,
        preconditionFailed: true,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const existing = await this.getSearchesByKey(
      libraryType,
      libraryID,
      objects.flatMap((object) =>
        typeof object.key === "string" ? [object.key] : []
      )
    );

    for (const [index, object] of objects.entries()) {
      const key =
        typeof object.key === "string" ? object.key : generateZoteroKey();
      const current = existing.get(key);
      const failure = validateSearchWrite(object, current);
      if (failure) {
        result.failed[index] = failure;
        continue;
      }

      const compareData = sanitizeSearchData(key, version + 1, object, current);
      if (
        current &&
        searchDataEqualIgnoringVersion(current.data, compareData)
      ) {
        result.unchanged.push(current);
        continue;
      }

      const nextVersion = await this.bumpLibraryVersion(libraryType, libraryID);
      const data = sanitizeSearchData(key, nextVersion, object, current);
      const record = {
        data,
        key,
        version: nextVersion,
      };
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO searches
             (library_type, library_id, search_key, version, data_json, updated_at)
             VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(library_type, library_id, search_key)
             DO UPDATE SET
               version = excluded.version,
               data_json = excluded.data_json,
               updated_at = excluded.updated_at`
          )
          .bind(libraryType, libraryID, key, nextVersion, JSON.stringify(data)),
        this.db
          .prepare(
            `INSERT INTO sync_log
             (library_type, library_id, version, operation, object_type, object_key)
             VALUES (?, ?, ?, 'upsert', 'search', ?)`
          )
          .bind(libraryType, libraryID, nextVersion, key),
      ]);

      result.success.push(key);
      result.successful.push(record);
      result.version = nextVersion;
    }

    return {
      ...result,
      preconditionFailed: false,
    };
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

  private async reservePreconditionGuard(
    libraryType: LibraryType,
    libraryID: number,
    expectedVersion: number
  ): Promise<boolean> {
    const token = `if-unmodified:search:${expectedVersion}`;
    const row = await this.db
      .prepare(
        `INSERT INTO write_tokens (library_type, library_id, token)
         VALUES (?, ?, ?)
         ON CONFLICT(library_type, library_id, token) DO NOTHING
         RETURNING token`
      )
      .bind(libraryType, libraryID, token)
      .first<{ token: string }>();

    return Boolean(row);
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

  private async getSearchesByKey(
    libraryType: LibraryType,
    libraryID: number,
    searchKeys: string[]
  ): Promise<Map<string, SearchRecord>> {
    if (searchKeys.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .prepare(
        `SELECT search_key, version, data_json
         FROM searches
         WHERE library_type = ?
           AND library_id = ?
           AND search_key IN (${searchKeys.map(() => "?").join(",")})`
      )
      .bind(libraryType, libraryID, ...searchKeys)
      .all<D1SearchRow>();
    const searches = new Map<string, SearchRecord>();

    for (const row of rows.results ?? []) {
      const search = parseSearchRow(row);
      searches.set(search.key, search);
    }

    return searches;
  }
}

const createSearchWriteResult = (version: number): SearchWriteResult => ({
  failed: {},
  success: [],
  successful: [],
  unchanged: [],
  version,
});

const validateSearchWrite = (
  object: Record<string, unknown>,
  existing?: SearchRecord
): SearchFailure | null => {
  const requestedVersion =
    typeof object.version === "number" ? object.version : null;

  if (existing) {
    if (requestedVersion === null) {
      return {
        code: 428,
        message: "Search version not provided",
      };
    }
    if (requestedVersion === 0 || requestedVersion < existing.version) {
      return {
        code: 412,
        message: "Search has been modified",
      };
    }
  } else if (requestedVersion !== null && requestedVersion > 0) {
    return {
      code: 404,
      message: `Search doesn't exist (expected version ${requestedVersion}; use 0 instead)`,
    };
  }

  const data = {
    ...(existing?.data ?? {}),
    ...object,
  };

  if (typeof data.name !== "string" || data.name.trim() === "") {
    return {
      code: 400,
      message: "Search name cannot be empty",
    };
  }
  if (data.name.length > 255) {
    return {
      code: 413,
      message: "Search name cannot be longer than 255 characters",
    };
  }

  if (!Array.isArray(data.conditions) || data.conditions.length === 0) {
    return {
      code: 400,
      message: "'conditions' cannot be empty",
    };
  }

  for (const condition of data.conditions) {
    if (!isPlainObject(condition)) {
      return {
        code: 400,
        message: "Search condition must be an object",
      };
    }
    if (!("condition" in condition)) {
      return {
        code: 400,
        message: "'condition' property not provided for search condition",
      };
    }
    if (typeof condition.condition !== "string" || condition.condition === "") {
      return {
        code: 400,
        message: "Search condition cannot be empty",
      };
    }
    if (!("operator" in condition)) {
      return {
        code: 400,
        message: "'operator' property not provided for search condition",
      };
    }
    if (typeof condition.operator !== "string" || condition.operator === "") {
      return {
        code: 400,
        message: "Search operator cannot be empty",
      };
    }
  }

  return null;
};

const sanitizeSearchData = (
  key: string,
  version: number,
  object: Record<string, unknown>,
  existing?: SearchRecord
): Record<string, unknown> => {
  const data = sanitizeZoteroData({
    ...(existing?.data ?? {}),
    ...object,
    key,
    version,
  });

  if (data.deleted === false || data.deleted === 0) {
    delete data.deleted;
  } else if (data.deleted === true || data.deleted === 1) {
    data.deleted = true;
  }

  return data;
};

const searchDataEqualIgnoringVersion = (
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean => {
  const { version: _leftVersion, ...leftComparable } = left;
  const { version: _rightVersion, ...rightComparable } = right;

  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
};

const parseSearchRow = (row: D1SearchRow): SearchRecord => ({
  data: JSON.parse(row.data_json),
  key: row.search_key,
  version: row.version,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
