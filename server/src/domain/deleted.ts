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

export const createDeletedStore = (env: Bindings): DeletedStore =>
  new D1DeletedStore(env.DB);

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
