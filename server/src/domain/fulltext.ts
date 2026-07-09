import type { Bindings } from "../bindings";

type LibraryType = "group" | "user";

export interface FullTextRecord {
  content: string;
  indexedPages?: number;
  itemKey: string;
  totalPages?: number;
  version: number;
}

interface FullTextPayload {
  content: string;
  indexedPages?: number;
  totalPages?: number;
}

interface FullTextFailure {
  code: number;
  message: string;
}

interface FullTextWriteReport {
  failed: Record<string, FullTextFailure>;
  preconditionFailed: boolean;
  success: Record<string, string>;
  successful: Record<string, FullTextRecord>;
  version: number;
}

export interface FullTextIndexState {
  deindexed: boolean;
  reindexing: number | null;
}

interface FullTextIndexStatus {
  expectedCount?: number;
  indexedCount?: number;
  status: "deindexed" | "indexed" | "reindexing";
}

interface FullTextStore {
  clearFullText: (libraryType: LibraryType, libraryID: number) => Promise<void>;
  getContent: (
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string
  ) => Promise<FullTextRecord | null>;
  getContentMap: (
    libraryType: LibraryType,
    libraryID: number
  ) => Promise<Map<string, string>>;
  getIndexState: (
    libraryType: LibraryType,
    libraryID: number
  ) => Promise<FullTextIndexState>;
  getIndexStatus: (
    libraryType: LibraryType,
    libraryID: number
  ) => Promise<FullTextIndexStatus>;
  listVersions: (
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion?: number | null
  ) => Promise<{ versions: Record<string, number>; version: number }>;
  markReindexingForSearch: (
    libraryType: LibraryType,
    libraryID: number
  ) => Promise<boolean>;
  setIndexState: (
    libraryType: LibraryType,
    libraryID: number,
    state: Partial<FullTextIndexState>
  ) => Promise<FullTextIndexState>;
  upsertContent: (
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string,
    payload: unknown
  ) => Promise<{
    missingItem: boolean;
    record: FullTextRecord | null;
    version: number;
  }>;
  upsertContentBatch: (
    libraryType: LibraryType,
    libraryID: number,
    payloads: unknown[],
    ifUnmodifiedSinceVersion: number
  ) => Promise<FullTextWriteReport>;
}

export const createFullTextStore = (env: Bindings): FullTextStore =>
  new D1FullTextStore(env.DB);

class D1FullTextStore implements FullTextStore {
  constructor(private readonly db: D1Database) {}

  async clearFullText(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM fulltext_items WHERE library_type = ? AND library_id = ?"
      )
      .bind(libraryType, libraryID)
      .run();
  }

  async getContent(
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string
  ): Promise<FullTextRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT item_key, content, indexed_pages, total_pages, version
         FROM fulltext_items
         WHERE library_type = ? AND library_id = ? AND item_key = ?`
      )
      .bind(libraryType, libraryID, itemKey)
      .first<FullTextRow>();

    return row ? rowToFullTextRecord(row) : null;
  }

  async getContentMap(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<Map<string, string>> {
    const rows = await this.db
      .prepare(
        `SELECT item_key, content
         FROM fulltext_items
         WHERE library_type = ? AND library_id = ?`
      )
      .bind(libraryType, libraryID)
      .all<{ item_key: string; content: string }>();

    return new Map(rows.results.map((row) => [row.item_key, row.content]));
  }

  async listVersions(
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion: number | null = null
  ): Promise<{ versions: Record<string, number>; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);
    const libraryVersion = await this.getLibraryVersion(libraryType, libraryID);
    const rows = await this.db
      .prepare(
        `SELECT item_key, version
         FROM fulltext_items
         WHERE library_type = ? AND library_id = ? AND version > ?`
      )
      .bind(libraryType, libraryID, sinceVersion ?? -1)
      .all<{ item_key: string; version: number }>();

    return {
      version: libraryVersion,
      versions: Object.fromEntries(
        rows.results.map((row) => [row.item_key, row.version])
      ),
    };
  }

  async getIndexState(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<FullTextIndexState> {
    const row = await this.db
      .prepare(
        `SELECT deindexed, reindexing
         FROM fulltext_index_states
         WHERE library_type = ? AND library_id = ?`
      )
      .bind(libraryType, getFullTextIndexLibraryID(libraryType, libraryID))
      .first<{ deindexed: number; reindexing: number | null }>();

    return {
      deindexed: row?.deindexed === 1,
      reindexing: row?.reindexing ?? null,
    };
  }

  async getIndexStatus(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<FullTextIndexStatus> {
    const state = await this.getIndexState(libraryType, libraryID);
    if (state.reindexing !== null) {
      return {
        expectedCount: await this.countContent(libraryType, libraryID),
        indexedCount: 0,
        status: "reindexing",
      };
    }
    if (state.deindexed) {
      return { status: "deindexed" };
    }
    return { status: "indexed" };
  }

  async markReindexingForSearch(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<boolean> {
    const state = await this.getIndexState(libraryType, libraryID);
    const now = getUnixSeconds();
    if (state.deindexed || isStaleReindexing(state.reindexing, now)) {
      await this.setIndexState(libraryType, libraryID, {
        deindexed: false,
        reindexing: now,
      });
      return true;
    }
    return state.reindexing !== null;
  }

  async setIndexState(
    libraryType: LibraryType,
    libraryID: number,
    patch: Partial<FullTextIndexState>
  ): Promise<FullTextIndexState> {
    const current = await this.getIndexState(libraryType, libraryID);
    const next = {
      deindexed: patch.deindexed ?? current.deindexed,
      reindexing:
        patch.reindexing === undefined ? current.reindexing : patch.reindexing,
    };
    await this.db
      .prepare(
        `INSERT INTO fulltext_index_states
           (library_type, library_id, deindexed, reindexing, updated_at)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(library_type, library_id) DO UPDATE SET
           deindexed = excluded.deindexed,
           reindexing = excluded.reindexing,
           updated_at = excluded.updated_at`
      )
      .bind(
        libraryType,
        getFullTextIndexLibraryID(libraryType, libraryID),
        next.deindexed ? 1 : 0,
        next.reindexing
      )
      .run();

    return next;
  }

  async upsertContent(
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string,
    payload: unknown
  ): Promise<{
    missingItem: boolean;
    record: FullTextRecord | null;
    version: number;
  }> {
    await this.ensureLibrary(libraryType, libraryID);
    let version = await this.getLibraryVersion(libraryType, libraryID);
    if (!(await this.itemExists(libraryType, libraryID, itemKey))) {
      return {
        missingItem: true,
        record: null,
        version,
      };
    }

    const normalized = normalizeFullTextPayload(payload);
    if (!normalized) {
      return {
        missingItem: false,
        record: null,
        version,
      };
    }

    version += 1;
    await this.writeContent(
      libraryType,
      libraryID,
      itemKey,
      normalized,
      version
    );

    return {
      missingItem: false,
      record: {
        ...normalized,
        itemKey,
        version,
      },
      version,
    };
  }

  async upsertContentBatch(
    libraryType: LibraryType,
    libraryID: number,
    payloads: unknown[],
    ifUnmodifiedSinceVersion: number
  ): Promise<FullTextWriteReport> {
    await this.ensureLibrary(libraryType, libraryID);
    let version = await this.getLibraryVersion(libraryType, libraryID);
    if (version > ifUnmodifiedSinceVersion) {
      return emptyWriteReport(version, true);
    }

    const report = emptyWriteReport(version);
    for (const [index, payload] of payloads.entries()) {
      const itemKey = getPayloadItemKey(payload);
      if (!itemKey) {
        report.failed[index] = {
          code: 400,
          message: "Item key not provided",
        };
        continue;
      }
      if (!(await this.itemExists(libraryType, libraryID, itemKey))) {
        report.failed[index] = {
          code: 404,
          message: "Item not found",
        };
        continue;
      }

      const normalized = normalizeFullTextPayload(payload);
      if (!normalized) {
        report.failed[index] = {
          code: 400,
          message: "Invalid full-text content",
        };
        continue;
      }

      version += 1;
      await this.writeContent(
        libraryType,
        libraryID,
        itemKey,
        normalized,
        version
      );
      const record = {
        ...normalized,
        itemKey,
        version,
      };
      report.success[index] = itemKey;
      report.successful[index] = record;
      report.version = version;
    }

    return report;
  }

  private async ensureLibrary(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES (?, ?)"
      )
      .bind(libraryType, libraryID)
      .run();
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

  private async itemExists(
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1
         FROM items
         WHERE library_type = ? AND library_id = ? AND item_key = ? AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, itemKey)
      .first();

    return Boolean(row);
  }

  private async countContent(
    libraryType: LibraryType,
    libraryID: number
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM fulltext_items
         WHERE library_type = ? AND library_id = ?`
      )
      .bind(libraryType, libraryID)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  private async writeContent(
    libraryType: LibraryType,
    libraryID: number,
    itemKey: string,
    payload: FullTextPayload,
    version: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO fulltext_items
             (library_type, library_id, item_key, version, content, indexed_pages, total_pages, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
             version = excluded.version,
             content = excluded.content,
             indexed_pages = excluded.indexed_pages,
             total_pages = excluded.total_pages,
             updated_at = excluded.updated_at`
        )
        .bind(
          libraryType,
          libraryID,
          itemKey,
          version,
          payload.content,
          payload.indexedPages ?? null,
          payload.totalPages ?? null
        ),
      this.db
        .prepare(
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
        )
        .bind(version, libraryType, libraryID),
    ]);
  }
}

interface FullTextRow {
  content: string;
  indexed_pages: number | null;
  item_key: string;
  total_pages: number | null;
  version: number;
}

const rowToFullTextRecord = (row: FullTextRow): FullTextRecord => {
  const record: FullTextRecord = {
    content: row.content,
    itemKey: row.item_key,
    version: row.version,
  };

  if (row.indexed_pages !== null) {
    record.indexedPages = row.indexed_pages;
  }
  if (row.total_pages !== null) {
    record.totalPages = row.total_pages;
  }

  return record;
};

const emptyWriteReport = (
  version: number,
  preconditionFailed = false
): FullTextWriteReport => ({
  failed: {},
  preconditionFailed,
  success: {},
  successful: {},
  version,
});

const normalizeFullTextPayload = (payload: unknown): FullTextPayload | null => {
  if (!isPlainObject(payload) || typeof payload.content !== "string") {
    return null;
  }

  const normalized: FullTextPayload = {
    content: payload.content,
  };

  if (typeof payload.indexedPages === "number") {
    normalized.indexedPages = payload.indexedPages;
  }
  if (typeof payload.totalPages === "number") {
    normalized.totalPages = payload.totalPages;
  }

  return normalized;
};

const getPayloadItemKey = (payload: unknown): string | null =>
  isPlainObject(payload) &&
  typeof payload.key === "string" &&
  payload.key.length > 0
    ? payload.key
    : null;

const getFullTextIndexLibraryID = (
  libraryType: LibraryType,
  libraryID: number
) => (libraryType === "user" ? 0 : libraryID);

const fullTextReindexingStaleAfterSeconds = 6 * 60 * 60;

const getUnixSeconds = () => Math.floor(Date.now() / 1000);

const isStaleReindexing = (reindexing: number | null, now: number) =>
  reindexing !== null && reindexing < now - fullTextReindexingStaleAfterSeconds;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
