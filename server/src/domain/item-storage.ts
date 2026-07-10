import type { D1LibraryVersions, LibraryType } from "./library-versions";
import type { ItemRecord } from "./state";
import { generateZoteroKey, sanitizeZoteroData } from "./zotero";

export interface ItemListResult {
  items: ItemRecord[];
  version: number;
}

export interface CreateItemsResult {
  duplicateWriteToken: boolean;
  preconditionFailed?: boolean;
  success: string[];
  successful: ItemRecord[];
  version: number;
}

export interface ItemWriteOptions {
  actorUserID?: number | null;
  ifUnmodifiedSinceVersion?: number | null;
  updateLastModifiedByUserIDByKey?: Record<string, boolean>;
}

interface D1ItemRow {
  created_by_user_id?: number | null;
  data_json: string;
  item_key: string;
  last_modified_by_user_id?: number | null;
  version: number;
}

const parseItemRow = (row: D1ItemRow): ItemRecord => ({
  ...(typeof row.created_by_user_id === "number"
    ? { createdByUserID: row.created_by_user_id }
    : {}),
  data: JSON.parse(row.data_json) as Record<string, unknown>,
  key: row.item_key,
  ...(typeof row.last_modified_by_user_id === "number"
    ? { lastModifiedByUserID: row.last_modified_by_user_id }
    : {}),
  version: row.version,
});

const getItemType = (item: ItemRecord): string =>
  typeof item.data.itemType === "string" ? item.data.itemType : "";

const isRegularItem = (item: ItemRecord): boolean => {
  const itemType = getItemType(item);
  return (
    itemType !== "attachment" &&
    itemType !== "annotation" &&
    itemType !== "note"
  );
};

const isFileAttachmentWithDescendants = (item: ItemRecord): boolean =>
  getItemType(item) === "attachment" &&
  typeof item.data.linkMode === "string" &&
  item.data.linkMode !== "embedded_image" &&
  item.data.linkMode !== "linked_url";

const isDeleteChildOfItem = (
  parent: ItemRecord,
  child: ItemRecord
): boolean => {
  if (child.data.parentItem !== parent.key) {
    return false;
  }

  const childType = getItemType(child);
  if (isRegularItem(parent)) {
    return childType === "attachment" || childType === "note";
  }
  if (getItemType(parent) === "note") {
    return childType === "attachment";
  }
  if (isFileAttachmentWithDescendants(parent)) {
    return childType === "annotation";
  }
  return false;
};

const collectItemDeleteDescendants = (
  itemsByKey: Map<string, ItemRecord>,
  parentKey: string,
  deleted: Set<string>
) => {
  const parent = itemsByKey.get(parentKey);
  if (!parent) {
    return;
  }

  for (const child of itemsByKey.values()) {
    if (!isDeleteChildOfItem(parent, child) || deleted.has(child.key)) {
      continue;
    }
    deleted.add(child.key);
    collectItemDeleteDescendants(itemsByKey, child.key, deleted);
  }
};

const expandItemDeleteKeys = (
  itemsByKey: Map<string, ItemRecord>,
  itemKeys: string[]
): string[] => {
  const deleted = new Set<string>();
  for (const itemKey of itemKeys) {
    if (!itemsByKey.has(itemKey)) {
      continue;
    }
    deleted.add(itemKey);
    collectItemDeleteDescendants(itemsByKey, itemKey, deleted);
  }
  return [...deleted];
};

export class D1ItemStorage {
  constructor(
    private readonly db: D1Database,
    private readonly libraryVersions: D1LibraryVersions,
    private readonly bucket?: R2Bucket
  ) {}

  async createGroupItems(
    groupID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    await this.ensureGroupLibrary(groupID);
    return this.createForLibrary(
      "group",
      groupID,
      objects,
      writeToken,
      options
    );
  }

  async createItems(
    userID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    await this.ensureUserLibrary(userID);
    return this.createForLibrary("user", userID, objects, writeToken, options);
  }

  async deleteGroupItems(
    groupID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    await this.ensureGroupLibrary(groupID);
    return this.deleteForLibrary(
      "group",
      groupID,
      itemKeys,
      ifUnmodifiedSinceVersion
    );
  }

  async deleteItems(
    userID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    await this.ensureUserLibrary(userID);
    return this.deleteForLibrary(
      "user",
      userID,
      itemKeys,
      ifUnmodifiedSinceVersion
    );
  }

  async getItem(
    userID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    const result = await this.listItems(userID, [itemKey]);
    return result.items.length === 0 ? null : result;
  }

  async getGroupItem(
    groupID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    const result = await this.listGroupItems(groupID, [itemKey]);
    return result.items.length === 0 ? null : result;
  }

  async listItems(
    userID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    await this.ensureUserLibrary(userID);
    return this.listForLibrary("user", userID, itemKeys);
  }

  async listGroupItems(
    groupID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    await this.ensureGroupLibrary(groupID);
    return this.listForLibrary("group", groupID, itemKeys);
  }

  private async ensureUserLibrary(userID: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
        .bind(userID),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('user', ?)"
        )
        .bind(userID),
    ]);
  }

  private async ensureGroupLibrary(groupID: number): Promise<void> {
    await this.libraryVersions.ensure("group", groupID);
  }

  private async getItemsByKeyIncludingDeleted(
    libraryType: LibraryType,
    libraryID: number,
    itemKeys: string[]
  ): Promise<Map<string, ItemRecord>> {
    if (itemKeys.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .prepare(
        `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND item_key IN (${itemKeys.map(() => "?").join(",")})`
      )
      .bind(libraryType, libraryID, ...itemKeys)
      .all<D1ItemRow>();

    return new Map(
      rows.results.map((row) => {
        const item = parseItemRow(row);
        return [item.key, item];
      })
    );
  }

  private async deleteForLibrary(
    libraryType: LibraryType,
    libraryID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    const version = await this.libraryVersions.get(libraryType, libraryID);
    if (itemKeys.length === 0) {
      return {
        deleted: [],
        preconditionFailed: false,
        version,
      };
    }

    const rows = await this.db
      .prepare(
        `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND deleted_at IS NULL
           AND item_key IN (${itemKeys.map(() => "?").join(",")})`
      )
      .bind(libraryType, libraryID, ...itemKeys)
      .all<D1ItemRow>();
    const existingItems = rows.results.map(parseItemRow);

    if (existingItems.length === 0) {
      return {
        deleted: [],
        preconditionFailed: false,
        version,
      };
    }
    if (
      existingItems.some(
        (item) =>
          ifUnmodifiedSinceVersion !== null &&
          item.version > ifUnmodifiedSinceVersion
      )
    ) {
      return {
        deleted: [],
        preconditionFailed: true,
        version,
      };
    }

    const allRows = await this.db
      .prepare(
        `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID)
      .all<D1ItemRow>();
    const itemsByKey = new Map(
      allRows.results.map((row) => {
        const item = parseItemRow(row);
        return [item.key, item];
      })
    );
    const existingKeys = expandItemDeleteKeys(itemsByKey, itemKeys);
    const placeholders = existingKeys.map(() => "?").join(",");
    const attachmentRows = await this.db
      .prepare(
        `SELECT r2_key
         FROM attachment_files
         WHERE library_type = ? AND library_id = ?
           AND item_key IN (${placeholders})`
      )
      .bind(libraryType, libraryID, ...existingKeys)
      .all<{ r2_key: string }>();
    const uploadRows = await this.db
      .prepare(
        `SELECT r2_key, multipart_upload_id, upload_state
         FROM attachment_uploads
         WHERE library_type = ? AND library_id = ?
           AND item_key IN (${placeholders})`
      )
      .bind(libraryType, libraryID, ...existingKeys)
      .all<{
        multipart_upload_id: string | null;
        r2_key: string;
        upload_state: string;
      }>();
    if (this.bucket) {
      await Promise.all(
        uploadRows.results
          .filter(
            (upload) =>
              upload.upload_state === "queued" &&
              Boolean(upload.multipart_upload_id)
          )
          .map((upload) =>
            this.bucket
              ?.resumeMultipartUpload(
                upload.r2_key,
                upload.multipart_upload_id ?? ""
              )
              .abort()
          )
      );
    }

    const nextVersion = version + 1;
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
        )
        .bind(nextVersion, libraryType, libraryID),
      ...existingKeys.flatMap((itemKey) => [
        this.db
          .prepare(
            "UPDATE items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ? AND item_key = ?"
          )
          .bind(nextVersion, libraryType, libraryID, itemKey),
        this.db
          .prepare(
            "DELETE FROM attachment_files WHERE library_type = ? AND library_id = ? AND item_key = ?"
          )
          .bind(libraryType, libraryID, itemKey),
        this.db
          .prepare(
            "DELETE FROM attachment_uploads WHERE library_type = ? AND library_id = ? AND item_key = ?"
          )
          .bind(libraryType, libraryID, itemKey),
        this.db
          .prepare(
            "DELETE FROM fulltext_items WHERE library_type = ? AND library_id = ? AND item_key = ?"
          )
          .bind(libraryType, libraryID, itemKey),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'delete', 'item', ?)"
          )
          .bind(libraryType, libraryID, nextVersion, itemKey),
      ]),
    ]);

    if (this.bucket) {
      const candidateKeys = new Set([
        ...attachmentRows.results.map((row) => row.r2_key),
        ...uploadRows.results
          .filter((upload) => upload.upload_state !== "queued")
          .map((upload) => upload.r2_key),
      ]);
      for (const r2Key of candidateKeys) {
        const remainingReference = await this.db
          .prepare("SELECT 1 FROM attachment_files WHERE r2_key = ? LIMIT 1")
          .bind(r2Key)
          .first();
        if (!remainingReference) {
          await this.bucket.delete(r2Key);
        }
      }
    }

    return {
      deleted: existingKeys,
      preconditionFailed: false,
      version: nextVersion,
    };
  }

  private async createForLibrary(
    libraryType: LibraryType,
    libraryID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    if (writeToken) {
      const duplicate = await this.db
        .prepare(
          "SELECT token FROM write_tokens WHERE library_type = ? AND library_id = ? AND token = ?"
        )
        .bind(libraryType, libraryID, writeToken)
        .first<{ token: string }>();

      if (duplicate) {
        const version = await this.libraryVersions.get(libraryType, libraryID);
        return {
          duplicateWriteToken: true,
          success: [],
          successful: [],
          version,
        };
      }
    }

    const expectedVersion = options?.ifUnmodifiedSinceVersion ?? null;
    let version = await this.libraryVersions.get(libraryType, libraryID);
    const success: string[] = [];
    const successful: ItemRecord[] = [];
    const statements: D1PreparedStatement[] = [];

    if (writeToken) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO write_tokens (library_type, library_id, token) VALUES (?, ?, ?)"
          )
          .bind(libraryType, libraryID, writeToken)
      );
    }

    const existingByKey = await this.getItemsByKeyIncludingDeleted(
      libraryType,
      libraryID,
      objects.flatMap((object) =>
        typeof object.key === "string" ? [object.key] : []
      )
    );
    if (
      expectedVersion !== null &&
      !(await this.libraryVersions.reservePrecondition(
        libraryType,
        libraryID,
        "item",
        expectedVersion
      ))
    ) {
      return {
        duplicateWriteToken: false,
        preconditionFailed: true,
        success: [],
        successful: [],
        version: await this.libraryVersions.get(libraryType, libraryID),
      };
    }
    const reservedVersion = objects.length
      ? await this.libraryVersions.reserve(
          libraryType,
          libraryID,
          objects.length,
          expectedVersion
        )
      : version;
    if (reservedVersion === null) {
      return {
        duplicateWriteToken: false,
        preconditionFailed: true,
        success: [],
        successful: [],
        version: await this.libraryVersions.get(libraryType, libraryID),
      };
    }
    version = reservedVersion - objects.length;

    for (const object of objects) {
      version += 1;
      const key =
        typeof object.key === "string" ? object.key : generateZoteroKey();
      const existing = existingByKey.get(key);
      const data = sanitizeZoteroData({
        ...object,
        key,
        version,
      });
      const itemType =
        typeof data.itemType === "string" ? data.itemType : "book";
      const actorUserID = options?.actorUserID ?? null;
      const shouldUpdateLastModifiedByUserID =
        options?.updateLastModifiedByUserIDByKey?.[key] ?? false;
      const createdByUserID =
        libraryType === "group"
          ? (existing?.createdByUserID ?? actorUserID ?? undefined)
          : undefined;
      const lastModifiedByUserID =
        libraryType === "group"
          ? existing
            ? shouldUpdateLastModifiedByUserID
              ? (actorUserID ?? existing.lastModifiedByUserID)
              : existing.lastModifiedByUserID
            : (actorUserID ?? undefined)
          : undefined;
      const item: ItemRecord = {
        ...(libraryType === "group"
          ? {
              createdByUserID,
              lastModifiedByUserID,
            }
          : {}),
        data,
        key,
        version,
      };

      statements.push(
        this.db
          .prepare(
            `INSERT INTO items (
              library_type,
              library_id,
              item_key,
              version,
              item_type,
              parent_item_key,
              data_json,
              created_by_user_id,
              last_modified_by_user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
              version = excluded.version,
              item_type = excluded.item_type,
              parent_item_key = excluded.parent_item_key,
              data_json = excluded.data_json,
              created_by_user_id = COALESCE(items.created_by_user_id, excluded.created_by_user_id),
              last_modified_by_user_id = excluded.last_modified_by_user_id,
              deleted_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          )
          .bind(
            libraryType,
            libraryID,
            key,
            version,
            itemType,
            typeof data.parentItem === "string" ? data.parentItem : null,
            JSON.stringify(data),
            createdByUserID ?? null,
            lastModifiedByUserID ?? null
          ),
        ...(existing?.data?.md5 !== undefined && data.md5 !== existing.data.md5
          ? [
              this.db
                .prepare(
                  "DELETE FROM attachment_files WHERE library_type = ? AND library_id = ? AND item_key = ?"
                )
                .bind(libraryType, libraryID, key),
            ]
          : []),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'upsert', 'item', ?)"
          )
          .bind(libraryType, libraryID, version, key)
      );

      success.push(key);
      successful.push(item);
    }

    await this.db.batch(statements);

    return {
      duplicateWriteToken: false,
      success,
      successful,
      version,
    };
  }

  private async listForLibrary(
    libraryType: LibraryType,
    libraryID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    const version = await this.libraryVersions.get(libraryType, libraryID);
    const rows = itemKeys?.length
      ? await this.db
          .prepare(
            `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
             FROM items
             WHERE library_type = ?
               AND library_id = ?
               AND deleted_at IS NULL
               AND item_key IN (${itemKeys.map(() => "?").join(",")})
             ORDER BY version ASC`
          )
          .bind(libraryType, libraryID, ...itemKeys)
          .all<D1ItemRow>()
      : await this.db
          .prepare(
            `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
             FROM items
             WHERE library_type = ?
               AND library_id = ?
               AND deleted_at IS NULL
             ORDER BY version ASC`
          )
          .bind(libraryType, libraryID)
          .all<D1ItemRow>();

    return {
      items: rows.results.map(parseItemRow),
      version,
    };
  }
}
