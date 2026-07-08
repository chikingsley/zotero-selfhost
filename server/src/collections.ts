import type { Bindings } from "./bindings";
import { recordMemoryDeletion } from "./deleted";
import { validateObjectRelationsForWrite } from "./relations";
import { getLibrary, type ItemRecord } from "./state";
import { generateZoteroKey, sanitizeZoteroData } from "./zotero";

type LibraryType = "group" | "user";

export interface CollectionRecord {
  data: Record<string, unknown>;
  key: string;
  meta: {
    numCollections: number;
    numItems: number;
  };
  version: number;
}

interface CollectionWriteResult {
  failed: Record<string, {
    code: number;
    data?: Record<string, unknown>;
    message: string;
  }>;
  success: string[];
  successful: CollectionRecord[];
  unchanged: CollectionRecord[];
  version: number;
}

interface CollectionStore {
  createCollections(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[]
  ): Promise<CollectionWriteResult>;
  deleteCollections(
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }>;
  findMissingCollectionKeys(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[]
  ): Promise<string[]>;
  getCollection(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<{ collection: CollectionRecord; version: number } | null>;
  listCollections(
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys?: string[]
  ): Promise<{ collections: CollectionRecord[]; version: number }>;
  listCollectionItems(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    topOnly?: boolean
  ): Promise<{ items: ItemRecord[]; version: number }>;
}

export const createCollectionStore = (env: Bindings): CollectionStore =>
  env.DB ? new D1CollectionStore(env.DB) : memoryCollectionStore;

const memoryCollections = new Map<string, Map<string, CollectionRecord>>();

export const clearMemoryCollections = (
  libraryType?: LibraryType,
  libraryID?: number
) => {
  if (libraryType && libraryID !== undefined) {
    memoryCollections.delete(getMemoryCollectionLibraryKey(libraryType, libraryID));
    return;
  }

  memoryCollections.clear();
};

const memoryCollectionStore: CollectionStore = {
  async createCollections(libraryType, libraryID, objects) {
    const collections = getMemoryCollections(libraryType, libraryID);
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const result: CollectionWriteResult = {
      failed: {},
      success: [],
      successful: [],
      unchanged: [],
      version: library.version,
    };

    for (const [index, object] of objects.entries()) {
      const existing =
        typeof object.key === "string" ? collections.get(object.key) : undefined;
      const key = typeof object.key === "string" ? object.key : generateZoteroKey();
      const parentCollection = normalizeParentCollection(
        object.parentCollection,
        existing?.data.parentCollection
      );
      const name = normalizeCollectionName(object.name, existing?.data.name);

      const validation = validateCollectionInput(
        name,
        parentCollection,
        (parentKey) => collections.has(parentKey)
      );
      if (validation) {
        result.failed[index] = validation;
        continue;
      }
      const relationValidation = validateObjectRelationsForWrite(
        object,
        "collection"
      );
      if (relationValidation) {
        result.failed[index] = relationValidation;
        continue;
      }

      library.version += 1;
      const data = sanitizeCollectionData({
        ...(existing?.data ?? {}),
        ...object,
        key,
        name,
        parentCollection,
        version: library.version,
      });
      const record = withMemoryCollectionMeta(libraryType, libraryID, {
        data,
        key,
        meta: {
          numCollections: 0,
          numItems: 0,
        },
        version: library.version,
      });

      collections.set(key, record);
      result.version = library.version;

      if (existing && collectionDataIsUnchanged(existing.data, data)) {
        result.unchanged.push(record);
      } else {
        result.success.push(key);
        result.successful.push(record);
      }

      if (parentCollection && isMemoryCollectionDescendant(collections, key, parentCollection)) {
        const parent = collections.get(parentCollection);
        if (parent) {
          parent.version = library.version;
          parent.data = sanitizeCollectionData({
            ...parent.data,
            parentCollection: false,
            version: library.version,
          });
        }
      }
    }

    return result;
  },

  async deleteCollections(
    libraryType,
    libraryID,
    collectionKeys,
    ifUnmodifiedSinceVersion = null
  ) {
    const collections = getMemoryCollections(libraryType, libraryID);
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const deleted = new Set<string>();

    for (const collectionKey of collectionKeys) {
      collectMemoryCollectionDescendants(collections, collectionKey, deleted);
    }

    if (
      ifUnmodifiedSinceVersion !== null &&
      [...deleted].some(
        (collectionKey) =>
          (collections.get(collectionKey)?.version ?? 0) >
          ifUnmodifiedSinceVersion
      )
    ) {
      return {
        deleted: [],
        preconditionFailed: true,
        version: library.version,
      };
    }

    if (deleted.size) {
      library.version += 1;
    }

    for (const collectionKey of deleted) {
      collections.delete(collectionKey);
      recordMemoryDeletion(libraryType, libraryID, library.version, "collection", collectionKey);
    }

    return {
      deleted: [...deleted],
      preconditionFailed: false,
      version: library.version,
    };
  },

  async findMissingCollectionKeys(libraryType, libraryID, objects) {
    const collections = getMemoryCollections(libraryType, libraryID);
    const requested = extractCollectionKeys(objects);

    return requested.filter((collectionKey) => !collections.has(collectionKey));
  },

  async getCollection(libraryType, libraryID, collectionKey) {
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const collection = getMemoryCollections(libraryType, libraryID).get(collectionKey);

    return collection
      ? {
          collection: withMemoryCollectionMeta(libraryType, libraryID, collection),
          version: library.version,
        }
      : null;
  },

  async listCollections(libraryType, libraryID, collectionKeys) {
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const collections = [...getMemoryCollections(libraryType, libraryID).values()]
      .filter((collection) => !collectionKeys || collectionKeys.includes(collection.key))
      .map((collection) =>
        withMemoryCollectionMeta(libraryType, libraryID, collection)
      );

    if (collectionKeys) {
      collections.sort(
        (left, right) =>
          collectionKeys.indexOf(left.key) - collectionKeys.indexOf(right.key)
      );
    } else {
      collections.sort((left, right) => left.version - right.version);
    }

    return {
      collections,
      version: library.version,
    };
  },

  async listCollectionItems(libraryType, libraryID, collectionKey, topOnly = false) {
    const library = getLibrary(getMemoryLibraryID(libraryType, libraryID));
    const items = [...library.items.values()].filter((item) =>
      itemBelongsToCollection(item, collectionKey, [...library.items.values()], topOnly)
    );

    return {
      items,
      version: library.version,
    };
  },
};

class D1CollectionStore implements CollectionStore {
  constructor(private readonly db: D1Database) {}

  async createCollections(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[]
  ): Promise<CollectionWriteResult> {
    await this.ensureLibrary(libraryType, libraryID);
    let version = await this.getLibraryVersion(libraryType, libraryID);
    const result: CollectionWriteResult = {
      failed: {},
      success: [],
      successful: [],
      unchanged: [],
      version,
    };

    for (const [index, object] of objects.entries()) {
      const existing =
        typeof object.key === "string"
          ? await this.getCollectionRecord(libraryType, libraryID, object.key)
          : null;
      const key = typeof object.key === "string" ? object.key : generateZoteroKey();
      const parentCollection = normalizeParentCollection(
        object.parentCollection,
        existing?.data.parentCollection
      );
      const name = normalizeCollectionName(object.name, existing?.data.name);
      const validation = validateCollectionInput(name, false, () => true);
      if (validation) {
        result.failed[index] = validation;
        continue;
      }
      const relationValidation = validateObjectRelationsForWrite(
        object,
        "collection"
      );
      if (relationValidation) {
        result.failed[index] = relationValidation;
        continue;
      }
      if (
        parentCollection &&
        !(await this.collectionExists(libraryType, libraryID, parentCollection))
      ) {
        result.failed[index] = {
          code: 409,
          data: {
            collection: parentCollection,
          },
          message: `Parent collection ${parentCollection} not found`,
        };
        continue;
      }

      version += 1;
      const data = sanitizeCollectionData({
        ...(existing?.data ?? {}),
        ...object,
        key,
        name,
        parentCollection,
        version,
      });

      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO collections (
              library_type,
              library_id,
              collection_key,
              version,
              parent_collection_key,
              data_json
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(library_type, library_id, collection_key) DO UPDATE SET
              version = excluded.version,
              parent_collection_key = excluded.parent_collection_key,
              data_json = excluded.data_json,
              deleted_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          )
          .bind(
            libraryType,
            libraryID,
            key,
            version,
            parentCollection || null,
            JSON.stringify(data)
          ),
        this.db
          .prepare(
            "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
          )
          .bind(version, libraryType, libraryID),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'upsert', 'collection', ?)"
          )
          .bind(libraryType, libraryID, version, key),
      ]);

      if (
        parentCollection &&
        (await this.collectionIsDescendant(
          libraryType,
          libraryID,
          key,
          parentCollection
        ))
      ) {
        await this.moveCollectionToRoot(
          libraryType,
          libraryID,
          parentCollection,
          version
        );
      }

      const record = await this.getCollectionRecord(libraryType, libraryID, key);
      if (!record) {
        continue;
      }

      result.version = version;
      if (existing && collectionDataIsUnchanged(existing.data, data)) {
        result.unchanged.push(record);
      } else {
        result.success.push(key);
        result.successful.push(record);
      }
    }

    return result;
  }

  async deleteCollections(
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    await this.ensureLibrary(libraryType, libraryID);

    const deleted = new Set<string>();
    for (const collectionKey of collectionKeys) {
      await this.collectD1CollectionDescendants(
        libraryType,
        libraryID,
        collectionKey,
        deleted
      );
    }

    if (!deleted.size) {
      return {
        deleted: [],
        preconditionFailed: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    if (
      ifUnmodifiedSinceVersion !== null &&
      (await this.collectionSubtreeHasVersionAfter(
        libraryType,
        libraryID,
        [...deleted],
        ifUnmodifiedSinceVersion
      ))
    ) {
      return {
        deleted: [],
        preconditionFailed: true,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const version = (await this.getLibraryVersion(libraryType, libraryID)) + 1;
    for (const collectionKey of deleted) {
      await this.db
        .prepare(
          `UPDATE collections
           SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE library_type = ?
             AND library_id = ?
             AND collection_key = ?`
        )
        .bind(libraryType, libraryID, collectionKey)
        .run();
      await this.db
        .prepare(
          "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'delete', 'collection', ?)"
        )
        .bind(libraryType, libraryID, version, collectionKey)
        .run();
    }

    await this.db
      .prepare(
        "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
      )
      .bind(version, libraryType, libraryID)
      .run();

    return {
      deleted: [...deleted],
      preconditionFailed: false,
      version,
    };
  }

  async findMissingCollectionKeys(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[]
  ): Promise<string[]> {
    const missing: string[] = [];

    for (const collectionKey of extractCollectionKeys(objects)) {
      if (!(await this.collectionExists(libraryType, libraryID, collectionKey))) {
        missing.push(collectionKey);
      }
    }

    return missing;
  }

  async getCollection(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<{ collection: CollectionRecord; version: number } | null> {
    await this.ensureLibrary(libraryType, libraryID);
    const collection = await this.getCollectionRecord(
      libraryType,
      libraryID,
      collectionKey
    );

    return collection
      ? {
          collection,
          version: await this.getLibraryVersion(libraryType, libraryID),
        }
      : null;
  }

  async listCollections(
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys?: string[]
  ): Promise<{ collections: CollectionRecord[]; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);

    const rows = collectionKeys?.length
      ? await this.db
          .prepare(
            `SELECT collection_key, version, data_json
             FROM collections
             WHERE library_type = ?
               AND library_id = ?
               AND deleted_at IS NULL
               AND collection_key IN (${collectionKeys.map(() => "?").join(",")})`
          )
          .bind(libraryType, libraryID, ...collectionKeys)
          .all<D1CollectionRow>()
      : await this.db
          .prepare(
            `SELECT collection_key, version, data_json
             FROM collections
             WHERE library_type = ?
               AND library_id = ?
               AND deleted_at IS NULL
             ORDER BY version ASC`
          )
          .bind(libraryType, libraryID)
          .all<D1CollectionRow>();

    const collections = await Promise.all(
      rows.results.map((row) =>
        this.parseCollectionRow(libraryType, libraryID, row)
      )
    );

    if (collectionKeys) {
      collections.sort(
        (left, right) =>
          collectionKeys.indexOf(left.key) - collectionKeys.indexOf(right.key)
      );
    }

    return {
      collections,
      version: await this.getLibraryVersion(libraryType, libraryID),
    };
  }

  async listCollectionItems(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    topOnly = false
  ): Promise<{ items: ItemRecord[]; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);

    const rows = await this.db
      .prepare(
        `SELECT item_key, version, data_json
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND deleted_at IS NULL
         ORDER BY version ASC`
      )
      .bind(libraryType, libraryID)
      .all<D1ItemRow>();
    const items = rows.results.map(parseItemRow);

    return {
      items: items.filter((item) =>
        itemBelongsToCollection(item, collectionKey, items, topOnly)
      ),
      version: await this.getLibraryVersion(libraryType, libraryID),
    };
  }

  private async collectionExists(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT collection_key
         FROM collections
         WHERE library_type = ?
           AND library_id = ?
           AND collection_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, collectionKey)
      .first<{ collection_key: string }>();

    return Boolean(row);
  }

  private async collectionIsDescendant(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    possibleDescendantKey: string
  ): Promise<boolean> {
    let current: string | false = possibleDescendantKey;
    const seen = new Set<string>();

    while (current && !seen.has(current)) {
      if (current === collectionKey) {
        return true;
      }
      seen.add(current);
      const row = (await this.db
        .prepare(
          `SELECT parent_collection_key
           FROM collections
           WHERE library_type = ?
             AND library_id = ?
             AND collection_key = ?
             AND deleted_at IS NULL`
        )
        .bind(libraryType, libraryID, current)
        .first()) as { parent_collection_key: string | null } | null;
      current = row?.parent_collection_key ?? false;
    }

    return false;
  }

  private async collectionSubtreeHasVersionAfter(
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys: string[],
    version: number
  ): Promise<boolean> {
    if (!collectionKeys.length) {
      return false;
    }

    const row = await this.db
      .prepare(
        `SELECT collection_key
         FROM collections
         WHERE library_type = ?
           AND library_id = ?
           AND collection_key IN (${collectionKeys.map(() => "?").join(",")})
           AND deleted_at IS NULL
           AND version > ?
         LIMIT 1`
      )
      .bind(libraryType, libraryID, ...collectionKeys, version)
      .first<{ collection_key: string }>();

    return Boolean(row);
  }

  private async collectD1CollectionDescendants(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    output: Set<string>
  ): Promise<void> {
    if (output.has(collectionKey)) {
      return;
    }
    if (!(await this.collectionExists(libraryType, libraryID, collectionKey))) {
      return;
    }

    output.add(collectionKey);
    const children = await this.db
      .prepare(
        `SELECT collection_key
         FROM collections
         WHERE library_type = ?
           AND library_id = ?
           AND parent_collection_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, collectionKey)
      .all<{ collection_key: string }>();

    for (const child of children.results) {
      await this.collectD1CollectionDescendants(
        libraryType,
        libraryID,
        child.collection_key,
        output
      );
    }
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

  private async getCollectionRecord(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<CollectionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT collection_key, version, data_json
         FROM collections
         WHERE library_type = ?
           AND library_id = ?
           AND collection_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, collectionKey)
      .first<D1CollectionRow>();

    return row ? this.parseCollectionRow(libraryType, libraryID, row) : null;
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

  private async getNumChildCollections(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM collections
         WHERE library_type = ?
           AND library_id = ?
           AND parent_collection_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, collectionKey)
      .first<{ count: number }>();

    return row?.count ?? 0;
  }

  private async getNumCollectionItems(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ): Promise<number> {
    const rows = await this.db
      .prepare(
        `SELECT item_key, version, data_json
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID)
      .all<D1ItemRow>();
    const items = rows.results.map(parseItemRow);

    return items.filter((item) =>
      itemBelongsToCollection(item, collectionKey, items, false)
    ).length;
  }

  private async moveCollectionToRoot(
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    version: number
  ): Promise<void> {
    const record = await this.getCollectionRecord(libraryType, libraryID, collectionKey);
    if (!record) {
      return;
    }

    const data = sanitizeCollectionData({
      ...record.data,
      parentCollection: false,
      version,
    });

    await this.db
      .prepare(
        `UPDATE collections
         SET parent_collection_key = NULL,
           version = ?,
           data_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE library_type = ?
           AND library_id = ?
           AND collection_key = ?`
      )
      .bind(version, JSON.stringify(data), libraryType, libraryID, collectionKey)
      .run();
  }

  private async parseCollectionRow(
    libraryType: LibraryType,
    libraryID: number,
    row: D1CollectionRow
  ): Promise<CollectionRecord> {
    return {
      data: JSON.parse(row.data_json),
      key: row.collection_key,
      meta: {
        numCollections: await this.getNumChildCollections(
          libraryType,
          libraryID,
          row.collection_key
        ),
        numItems: await this.getNumCollectionItems(
          libraryType,
          libraryID,
          row.collection_key
        ),
      },
      version: row.version,
    };
  }
}

interface D1CollectionRow {
  collection_key: string;
  data_json: string;
  version: number;
}

interface D1ItemRow {
  data_json: string;
  item_key: string;
  version: number;
}

const getMemoryLibraryID = (libraryType: LibraryType, libraryID: number) =>
  libraryType === "user" ? libraryID : -libraryID;

const getMemoryCollectionLibraryKey = (
  libraryType: LibraryType,
  libraryID: number
) => `${libraryType}:${libraryID}`;

const getMemoryCollections = (
  libraryType: LibraryType,
  libraryID: number
): Map<string, CollectionRecord> => {
  const key = getMemoryCollectionLibraryKey(libraryType, libraryID);
  const existing = memoryCollections.get(key);
  if (existing) {
    return existing;
  }

  const collections = new Map<string, CollectionRecord>();
  memoryCollections.set(key, collections);
  return collections;
};

const withMemoryCollectionMeta = (
  libraryType: LibraryType,
  libraryID: number,
  record: CollectionRecord
): CollectionRecord => {
  const collections = [...getMemoryCollections(libraryType, libraryID).values()];
  const items = [...getLibrary(getMemoryLibraryID(libraryType, libraryID)).items.values()];

  return {
    ...record,
    meta: {
      numCollections: collections.filter(
        (collection) => collection.data.parentCollection === record.key
      ).length,
      numItems: items.filter((item) =>
        itemBelongsToCollection(item, record.key, items, false)
      ).length,
    },
  };
};

const isMemoryCollectionDescendant = (
  collections: Map<string, CollectionRecord>,
  collectionKey: string,
  possibleDescendantKey: string
): boolean => {
  let current: string | false = possibleDescendantKey;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    if (current === collectionKey) {
      return true;
    }
    seen.add(current);
    current =
      (collections.get(current)?.data.parentCollection as string | false) ??
      false;
  }

  return false;
};

const collectMemoryCollectionDescendants = (
  collections: Map<string, CollectionRecord>,
  collectionKey: string,
  output: Set<string>
) => {
  if (output.has(collectionKey) || !collections.has(collectionKey)) {
    return;
  }

  output.add(collectionKey);
  for (const collection of collections.values()) {
    if (collection.data.parentCollection === collectionKey) {
      collectMemoryCollectionDescendants(collections, collection.key, output);
    }
  }
};

const normalizeCollectionName = (
  input: unknown,
  fallback: unknown
): string | null => {
  if (typeof input === "string") {
    return input;
  }
  if (typeof fallback === "string") {
    return fallback;
  }

  return null;
};

const normalizeParentCollection = (
  input: unknown,
  fallback: unknown
): string | false => {
  if (input === false || input === null || input === "") {
    return false;
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof fallback === "string") {
    return fallback;
  }

  return false;
};

const validateCollectionInput = (
  name: string | null,
  parentCollection: string | false,
  parentExists: (parentKey: string) => boolean
) => {
  if (name === null) {
    return {
      code: 400,
      message: "Collection name not provided",
    };
  }
  if (name.length > 255) {
    return {
      code: 413,
      message: "Collection name too long",
    };
  }
  if (parentCollection && !parentExists(parentCollection)) {
    return {
      code: 409,
      data: {
        collection: parentCollection,
      },
      message: `Parent collection ${parentCollection} not found`,
    };
  }

  return null;
};

const sanitizeCollectionData = (
  input: Record<string, unknown>
): Record<string, unknown> => {
  const data = sanitizeZoteroData({
    ...input,
    parentCollection: input.parentCollection || false,
    relations:
      input.relations && typeof input.relations === "object"
        ? input.relations
        : {},
  });

  if (data.deleted === false || data.deleted === 0) {
    delete data.deleted;
  } else if (data.deleted === true || data.deleted === 1) {
    data.deleted = true;
  }

  return data;
};

const collectionDataIsUnchanged = (
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): boolean => {
  const { version: _previousVersion, ...previousComparable } = previous;
  const { version: _nextVersion, ...nextComparable } = next;

  return JSON.stringify(previousComparable) === JSON.stringify(nextComparable);
};

const extractCollectionKeys = (objects: Record<string, unknown>[]): string[] => {
  const collectionKeys = new Set<string>();

  for (const object of objects) {
    if (!Array.isArray(object.collections)) {
      continue;
    }

    for (const collectionKey of object.collections) {
      if (typeof collectionKey === "string") {
        collectionKeys.add(collectionKey);
      }
    }
  }

  return [...collectionKeys];
};

const itemBelongsToCollection = (
  item: ItemRecord,
  collectionKey: string,
  allItems: ItemRecord[],
  topOnly: boolean
): boolean => {
  const collections = item.data.collections;
  const direct =
    Array.isArray(collections) && collections.includes(collectionKey);

  if (topOnly) {
    return direct && !item.data.parentItem;
  }
  if (direct) {
    return true;
  }
  if (typeof item.data.parentItem !== "string") {
    return false;
  }

  const parent = allItems.find(
    (candidate) => candidate.key === item.data.parentItem
  );
  const parentCollections = parent?.data.collections;
  return (
    Array.isArray(parentCollections) &&
    parentCollections.includes(collectionKey)
  );
};

const parseItemRow = (row: D1ItemRow): ItemRecord => ({
  data: JSON.parse(row.data_json),
  key: row.item_key,
  version: row.version,
});
