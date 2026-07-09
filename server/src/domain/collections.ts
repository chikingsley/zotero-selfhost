import type { Bindings } from "../bindings";
import { validateObjectRelationsForWrite } from "./relations";
import type { ItemRecord } from "./state";
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
  failed: Record<
    string,
    {
      code: number;
      data?: Record<string, unknown>;
      message: string;
    }
  >;
  preconditionFailed?: boolean;
  success: string[];
  successful: CollectionRecord[];
  unchanged: CollectionRecord[];
  version: number;
}

interface CollectionStore {
  createCollections: (
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<CollectionWriteResult>;
  deleteCollections: (
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }>;
  findMissingCollectionKeys: (
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[]
  ) => Promise<string[]>;
  getCollection: (
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string
  ) => Promise<{ collection: CollectionRecord; version: number } | null>;
  listCollectionItems: (
    libraryType: LibraryType,
    libraryID: number,
    collectionKey: string,
    topOnly?: boolean
  ) => Promise<{ items: ItemRecord[]; version: number }>;
  listCollections: (
    libraryType: LibraryType,
    libraryID: number,
    collectionKeys?: string[],
    options?: { includeMeta?: boolean }
  ) => Promise<{ collections: CollectionRecord[]; version: number }>;
}

export const createCollectionStore = (env: Bindings): CollectionStore =>
  new D1CollectionStore(env.DB);

class D1CollectionStore implements CollectionStore {
  constructor(private readonly db: D1Database) {}

  async createCollections(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<CollectionWriteResult> {
    await this.ensureLibrary(libraryType, libraryID);
    let version = await this.getLibraryVersion(libraryType, libraryID);
    const result: CollectionWriteResult = {
      failed: {},
      preconditionFailed: false,
      success: [],
      successful: [],
      unchanged: [],
      version,
    };

    if (
      ifUnmodifiedSinceVersion !== null &&
      version !== ifUnmodifiedSinceVersion
    ) {
      return {
        ...result,
        preconditionFailed: true,
      };
    }

    let expectedVersionForNextWrite = ifUnmodifiedSinceVersion;

    for (const [index, object] of objects.entries()) {
      const existing =
        typeof object.key === "string"
          ? await this.getCollectionRecord(libraryType, libraryID, object.key)
          : null;
      const key =
        typeof object.key === "string" ? object.key : generateZoteroKey();
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

      const nextVersion = version + 1;
      const data = sanitizeCollectionData({
        ...(existing?.data ?? {}),
        ...object,
        key,
        name,
        parentCollection,
        version: nextVersion,
      });

      if (
        expectedVersionForNextWrite !== null &&
        !(await this.reservePreconditionGuard(
          libraryType,
          libraryID,
          expectedVersionForNextWrite
        ))
      ) {
        return {
          ...result,
          preconditionFailed: true,
          version: await this.getLibraryVersion(libraryType, libraryID),
        };
      }
      const reservedVersion = await this.reserveLibraryVersions(
        libraryType,
        libraryID,
        1,
        expectedVersionForNextWrite
      );
      expectedVersionForNextWrite = null;
      if (reservedVersion === null) {
        return {
          ...result,
          preconditionFailed: true,
          version: await this.getLibraryVersion(libraryType, libraryID),
        };
      }
      version = reservedVersion;
      data.version = version;

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

      const record: CollectionRecord = {
        data,
        key,
        meta: {
          numCollections: 0,
          numItems: 0,
        },
        version,
      };

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

    const version = await this.reserveLibraryVersions(
      libraryType,
      libraryID,
      1,
      ifUnmodifiedSinceVersion
    );
    if (version === null) {
      return {
        deleted: [],
        preconditionFailed: true,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }
    await this.db.batch(
      [...deleted].flatMap((collectionKey) => [
        this.db
          .prepare(
            `UPDATE collections
             SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE library_type = ?
               AND library_id = ?
               AND collection_key = ?`
          )
          .bind(libraryType, libraryID, collectionKey),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'delete', 'collection', ?)"
          )
          .bind(libraryType, libraryID, version, collectionKey),
      ])
    );

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
      if (
        !(await this.collectionExists(libraryType, libraryID, collectionKey))
      ) {
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
    collectionKeys?: string[],
    options: { includeMeta?: boolean } = {}
  ): Promise<{ collections: CollectionRecord[]; version: number }> {
    await this.ensureLibrary(libraryType, libraryID);
    const includeMeta = options.includeMeta !== false;

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
        this.parseCollectionRow(libraryType, libraryID, row, includeMeta)
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

    const rows = await this.db
      .prepare(
        `WITH RECURSIVE subtree(collection_key) AS (
           SELECT collection_key
           FROM collections
           WHERE library_type = ?
             AND library_id = ?
             AND collection_key = ?
             AND deleted_at IS NULL
           UNION ALL
           SELECT C.collection_key
           FROM collections C
           JOIN subtree S ON C.parent_collection_key = S.collection_key
           WHERE C.library_type = ?
             AND C.library_id = ?
             AND C.deleted_at IS NULL
         )
         SELECT collection_key FROM subtree`
      )
      .bind(libraryType, libraryID, collectionKey, libraryType, libraryID)
      .all<{ collection_key: string }>();

    for (const row of rows.results) {
      output.add(row.collection_key);
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

  private async reserveLibraryVersions(
    libraryType: LibraryType,
    libraryID: number,
    count: number,
    expectedVersion: number | null
  ): Promise<number | null> {
    const row =
      expectedVersion === null
        ? await this.db
            .prepare(
              `UPDATE libraries
               SET version = version + ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE library_type = ? AND library_id = ?
               RETURNING version`
            )
            .bind(count, libraryType, libraryID)
            .first<{ version: number }>()
        : await this.db
            .prepare(
              `UPDATE libraries
               SET version = version + ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE library_type = ? AND library_id = ? AND version = ?
               RETURNING version`
            )
            .bind(count, libraryType, libraryID, expectedVersion)
            .first<{ version: number }>();

    return row?.version ?? null;
  }

  private async reservePreconditionGuard(
    libraryType: LibraryType,
    libraryID: number,
    expectedVersion: number
  ): Promise<boolean> {
    const token = `if-unmodified:collection:${expectedVersion}`;
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
    const record = await this.getCollectionRecord(
      libraryType,
      libraryID,
      collectionKey
    );
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
      .bind(
        version,
        JSON.stringify(data),
        libraryType,
        libraryID,
        collectionKey
      )
      .run();
  }

  private async parseCollectionRow(
    libraryType: LibraryType,
    libraryID: number,
    row: D1CollectionRow,
    includeMeta = true
  ): Promise<CollectionRecord> {
    return {
      data: JSON.parse(row.data_json),
      key: row.collection_key,
      meta: includeMeta
        ? {
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
          }
        : {
            numCollections: 0,
            numItems: 0,
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
    parentCollection: input.parentCollection,
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

const extractCollectionKeys = (
  objects: Record<string, unknown>[]
): string[] => {
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
