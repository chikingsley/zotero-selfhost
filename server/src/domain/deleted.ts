import type { Bindings } from "../bindings";

type LibraryType = "group" | "user";
type DeletedObjectType = "collection" | "item" | "search" | "setting" | "tag";

export interface DeletedResult {
  collections: string[];
  items: string[];
  searches: string[];
  settings: string[];
  tags: string[];
}

interface DeletedStore {
  listDeleted: (
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion: number
  ) => Promise<{ deleted: DeletedResult; version: number }>;
}

interface D1DeletedRow {
  object_key: string;
  object_type: DeletedObjectType;
}

const emptyDeleted = (): DeletedResult => ({
  collections: [],
  items: [],
  searches: [],
  settings: [],
  tags: [],
});

const memoryDeleted = new Map<
  string,
  Array<{ key: string; objectType: DeletedObjectType; version: number }>
>();

export const createDeletedStore = (env: Bindings): DeletedStore =>
  env.DB ? new D1DeletedStore(env.DB) : memoryDeletedStore;

export const clearMemoryDeleted = (
  libraryType?: LibraryType,
  libraryID?: number
) => {
  if (libraryType && libraryID !== undefined) {
    memoryDeleted.delete(getMemoryDeletedLibraryKey(libraryType, libraryID));
    return;
  }

  memoryDeleted.clear();
};

export const recordMemoryDeletion = (
  libraryType: LibraryType,
  libraryID: number,
  version: number,
  objectType: DeletedObjectType,
  key: string
) => {
  const entries = getMemoryDeletedEntries(libraryType, libraryID);
  entries.push({ key, objectType, version });
};

export const recordDeletedObjects = async (
  env: Bindings,
  libraryType: LibraryType,
  libraryID: number,
  version: number,
  objectType: DeletedObjectType,
  keys: string[]
) => {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) {
    return;
  }

  if (!env.DB) {
    for (const key of uniqueKeys) {
      recordMemoryDeletion(libraryType, libraryID, version, objectType, key);
    }
    return;
  }

  const db = env.DB;
  await db.batch(
    uniqueKeys.map((key) =>
      db
        .prepare(
          "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'delete', ?, ?)"
        )
        .bind(libraryType, libraryID, version, objectType, key)
    )
  );
};

const memoryDeletedStore: DeletedStore = {
  async listDeleted(libraryType, libraryID, sinceVersion) {
    const deleted = emptyDeleted();

    for (const entry of getMemoryDeletedEntries(libraryType, libraryID)) {
      if (entry.version <= sinceVersion) {
        continue;
      }
      appendDeleted(deleted, entry.objectType, entry.key);
    }

    return {
      deleted: dedupeDeleted(deleted),
      version: Math.max(
        0,
        ...getMemoryDeletedEntries(libraryType, libraryID).map(
          (entry) => entry.version
        )
      ),
    };
  },
};

class D1DeletedStore implements DeletedStore {
  constructor(private readonly db: D1Database) {}

  async listDeleted(
    libraryType: LibraryType,
    libraryID: number,
    sinceVersion: number
  ): Promise<{ deleted: DeletedResult; version: number }> {
    const rows = await this.db
      .prepare(
        `SELECT object_type, object_key
         FROM sync_log
         WHERE library_type = ?
           AND library_id = ?
           AND operation = 'delete'
           AND version > ?
         ORDER BY version ASC`
      )
      .bind(libraryType, libraryID, sinceVersion)
      .all<D1DeletedRow>();
    const versionRow = await this.db
      .prepare(
        "SELECT version FROM libraries WHERE library_type = ? AND library_id = ?"
      )
      .bind(libraryType, libraryID)
      .first<{ version: number }>();
    const deleted = emptyDeleted();

    for (const row of rows.results ?? []) {
      appendDeleted(deleted, row.object_type, row.object_key);
    }

    return {
      deleted: dedupeDeleted(deleted),
      version: versionRow?.version ?? 0,
    };
  }
}

const appendDeleted = (
  deleted: DeletedResult,
  objectType: DeletedObjectType,
  key: string
) => {
  switch (objectType) {
    case "collection":
      deleted.collections.push(key);
      break;
    case "item":
      deleted.items.push(key);
      break;
    case "search":
      deleted.searches.push(key);
      break;
    case "setting":
      deleted.settings.push(key);
      break;
    case "tag":
      deleted.tags.push(key);
      break;
    default:
      throw new TypeError(
        `Unsupported deleted object type: ${String(objectType)}`
      );
  }
};

const dedupeDeleted = (deleted: DeletedResult): DeletedResult => ({
  collections: [...new Set(deleted.collections)],
  items: [...new Set(deleted.items)],
  searches: [...new Set(deleted.searches)],
  settings: [...new Set(deleted.settings)],
  tags: [...new Set(deleted.tags)],
});

const getMemoryDeletedLibraryKey = (
  libraryType: LibraryType,
  libraryID: number
) => `${libraryType}:${libraryID}`;

const getMemoryDeletedEntries = (
  libraryType: LibraryType,
  libraryID: number
) => {
  const key = getMemoryDeletedLibraryKey(libraryType, libraryID);
  const existing = memoryDeleted.get(key);
  if (existing) {
    return existing;
  }

  const entries: Array<{
    key: string;
    objectType: DeletedObjectType;
    version: number;
  }> = [];
  memoryDeleted.set(key, entries);
  return entries;
};
