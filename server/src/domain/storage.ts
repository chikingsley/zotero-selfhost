import type { Bindings } from "../bindings";
import { md5Hex } from "../lib/md5";
import type { GroupRecord, ItemRecord } from "./state";
import { generateZoteroKey, sanitizeZoteroData } from "./zotero";

interface SetupResult {
  user1: {
    apiKey: string;
    userID: number;
  };
  user2: {
    apiKey: string;
    userID: number;
  };
}

interface CreateGroupInput {
  description?: string;
  fileEditing: string;
  hasImage?: boolean | number | string;
  libraryEditing: string;
  libraryReading: string;
  name: string;
  owner: number;
  type: string;
  url?: string;
}

interface GroupAccess {
  canAdmin: boolean;
  canEdit: boolean;
  canEditFiles: boolean;
  canRead: boolean;
}

interface GroupUserInput {
  role: string;
  userID: number;
}

interface GroupUserRecord {
  role: string;
  userID: number;
}

interface StorageQuota {
  expiration: number;
  quotaMB: number;
  unlimited: boolean;
}

interface ItemListResult {
  items: ItemRecord[];
  version: number;
}

interface CreateItemsResult {
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

export interface AttachmentFileRecord {
  charset?: string | null;
  contentType?: string | null;
  filename: string;
  itemKey: string;
  legacyStorage?: boolean;
  md5: string;
  mtime: number;
  r2Key: string;
  sizeBytes: number;
  storageFilename?: string;
  storageMd5?: string;
  version?: number;
  zip?: boolean;
}

interface AttachmentUploadInput {
  charset?: string | null;
  contentType?: string | null;
  filename: string;
  itemFilename?: string | null;
  itemMd5?: string | null;
  md5: string;
  mtime: number;
  sizeBytes: number;
  zip?: boolean;
}

interface AttachmentUploadAuthorization {
  contentType: string;
  prefix: string;
  suffix: string;
  uploadKey: string;
  url: string;
}

interface AttachmentUploadStoreResult {
  found: boolean;
  hashMismatch?: boolean;
  sizeMismatch?: boolean;
}

interface AttachmentRegistrationResult {
  found: boolean;
  registered: boolean;
  version: number;
}

interface AttachmentExistingFileResult {
  associated: boolean;
  sizeMismatch?: boolean;
  version: number;
}

interface AttachmentObjectResult {
  body: ArrayBuffer | ReadableStream;
  file: AttachmentFileRecord;
}

export interface CompatibilityStore {
  addGroupUsers: (groupID: number, users: GroupUserInput[]) => Promise<void>;
  associateExistingAttachmentFile: (
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ) => Promise<AttachmentExistingFileResult>;
  associateExistingGroupAttachmentFile: (
    groupID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ) => Promise<AttachmentExistingFileResult>;
  authorizeAttachmentUpload: (
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ) => Promise<AttachmentUploadAuthorization>;
  authorizeGroupAttachmentUpload: (
    groupID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ) => Promise<AttachmentUploadAuthorization>;
  clearGroupLibrary: (groupID: number) => Promise<void>;
  clearUserLibrary: (userID: number) => Promise<void>;
  createGroup: (input: CreateGroupInput) => Promise<GroupRecord>;
  createGroupItems: (
    groupID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ) => Promise<CreateItemsResult>;
  createItems: (
    userID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ) => Promise<CreateItemsResult>;
  deleteGroup: (groupID: number) => Promise<void>;
  deleteGroupItems: (
    groupID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }>;
  deleteItems: (
    userID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ) => Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }>;
  getAttachmentFile: (
    userID: number,
    itemKey: string
  ) => Promise<AttachmentFileRecord | null>;
  getAttachmentObject: (
    userID: number,
    itemKey: string
  ) => Promise<AttachmentObjectResult | null>;
  getAttachmentObjectByStoragePath: (
    storageMd5: string,
    storageFilename: string
  ) => Promise<AttachmentObjectResult | null>;
  getGroup: (groupID: number) => Promise<GroupRecord | null>;
  getGroupAccess: (userID: number, groupID: number) => Promise<GroupAccess>;
  getGroupAttachmentFile: (
    groupID: number,
    itemKey: string
  ) => Promise<AttachmentFileRecord | null>;
  getGroupAttachmentObject: (
    groupID: number,
    itemKey: string
  ) => Promise<AttachmentObjectResult | null>;
  getGroupItem: (
    groupID: number,
    itemKey: string
  ) => Promise<ItemListResult | null>;
  getGroupOwnerUserID: (groupID: number) => Promise<number | null>;
  getItem: (userID: number, itemKey: string) => Promise<ItemListResult | null>;
  getStorageQuota: (userID: number) => Promise<StorageQuota>;
  getStorageUsageBytes: (userID: number) => Promise<number>;
  getUserIDForApiKey: (apiKey: string) => Promise<number | null>;
  listGroupItems: (
    groupID: number,
    itemKeys?: string[]
  ) => Promise<ItemListResult>;
  listGroups: () => Promise<GroupRecord[]>;
  listGroupUsers: (groupID: number) => Promise<GroupUserRecord[]>;
  listItems: (userID: number, itemKeys?: string[]) => Promise<ItemListResult>;
  listVisibleGroups: (userID: number) => Promise<GroupRecord[]>;
  registerAttachmentUpload: (
    userID: number,
    itemKey: string,
    uploadKey: string
  ) => Promise<AttachmentRegistrationResult>;
  registerGroupAttachmentUpload: (
    groupID: number,
    itemKey: string,
    uploadKey: string
  ) => Promise<AttachmentRegistrationResult>;
  removeGroupUser: (groupID: number, userID: number) => Promise<void>;
  setStorageQuota: (
    userID: number,
    quotaMB: number | "unlimited" | null,
    expiration: number
  ) => Promise<StorageQuota>;
  setupTestUsers: (
    userID: number,
    userID2: number,
    user1Key: string,
    user2Key: string
  ) => Promise<SetupResult>;
  storeAttachmentUpload: (
    uploadKey: string,
    body: ArrayBuffer,
    contentType?: string | null
  ) => Promise<AttachmentUploadStoreResult>;
  updateGroup: (
    groupID: number,
    data: Record<string, unknown>
  ) => Promise<GroupRecord | null>;
  updateGroupUser: (
    groupID: number,
    userID: number,
    role: string
  ) => Promise<void>;
}

export const createCompatibilityStore = (env: Bindings): CompatibilityStore =>
  new D1CompatibilityStore(env.DB, env.ATTACHMENTS);

const defaultStorageQuotaMB = 300;

const defaultKeyAccess = () => ({
  groups: { all: { library: true, write: true } },
  user: { files: true, library: true, notes: true, write: true },
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

const getNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const validGroupRoles = new Set(["admin", "member", "owner"]);

const getDefaultStorageQuota = (): StorageQuota => ({
  expiration: 0,
  quotaMB: defaultStorageQuotaMB,
  unlimited: false,
});

const normalizeGroupRole = (role: string): string => {
  if (!validGroupRoles.has(role)) {
    throw new Error(`Invalid role '${role}'`);
  }

  return role;
};

class D1CompatibilityStore implements CompatibilityStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket?: R2Bucket
  ) {}

  async addGroupUsers(groupID: number, users: GroupUserInput[]): Promise<void> {
    const statements: D1PreparedStatement[] = [];

    for (const user of users) {
      const role = normalizeGroupRole(user.role);
      statements.push(
        this.db
          .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
          .bind(user.userID),
        this.db
          .prepare(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES (?, ?, ?)
             ON CONFLICT(group_id, user_id) DO UPDATE SET
               role = excluded.role`
          )
          .bind(groupID, user.userID, role)
      );

      if (role === "owner") {
        const currentOwner = await this.db
          .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
          .bind(groupID)
          .first<{ owner_user_id: number }>();

        statements.push(
          this.db
            .prepare("UPDATE groups SET owner_user_id = ? WHERE group_id = ?")
            .bind(user.userID, groupID)
        );
        if (currentOwner && currentOwner.owner_user_id !== user.userID) {
          statements.push(
            this.db
              .prepare(
                `INSERT INTO group_members (group_id, user_id, role)
                 VALUES (?, ?, 'admin')
                 ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'admin'`
              )
              .bind(groupID, currentOwner.owner_user_id)
          );
        }
      }
    }

    if (statements.length > 0) {
      statements.push(
        this.db
          .prepare(
            "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
          )
          .bind(groupID)
      );
      await this.db.batch(statements);
    }
  }

  async authorizeAttachmentUpload(
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization> {
    await this.ensureUserLibrary(userID);

    const uploadKey = crypto.randomUUID().replaceAll("-", "");
    const r2Key = `uploads/${uploadKey}`;

    await this.db
      .prepare(
        `INSERT INTO attachment_uploads (
          upload_key,
          library_type,
          library_id,
          item_key,
          r2_key,
          filename,
          item_filename,
          content_type,
          charset,
          size_bytes,
          md5,
          item_md5,
          mtime,
          zip
        ) VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        uploadKey,
        userID,
        itemKey,
        r2Key,
        input.filename,
        input.itemFilename ?? null,
        input.contentType ?? null,
        input.charset ?? null,
        input.sizeBytes,
        input.md5,
        input.itemMd5 ?? null,
        input.mtime,
        input.zip ? 1 : 0
      )
      .run();

    return {
      contentType: input.contentType ?? "application/octet-stream",
      prefix: "",
      suffix: "",
      uploadKey,
      url: `${uploadBaseURL}/upload/${uploadKey}`,
    };
  }

  async associateExistingAttachmentFile(
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ): Promise<AttachmentExistingFileResult> {
    await this.ensureUserLibrary(userID);
    return this.associateExistingAttachmentFileForLibrary(
      "user",
      userID,
      itemKey,
      input
    );
  }

  async associateExistingGroupAttachmentFile(
    groupID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ): Promise<AttachmentExistingFileResult> {
    await this.ensureGroupLibrary(groupID);
    return this.associateExistingAttachmentFileForLibrary(
      "group",
      groupID,
      itemKey,
      input
    );
  }

  async authorizeGroupAttachmentUpload(
    groupID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization> {
    await this.ensureGroupLibrary(groupID);
    return this.authorizeLibraryAttachmentUpload(
      "group",
      groupID,
      itemKey,
      input,
      uploadBaseURL
    );
  }

  async clearGroupLibrary(groupID: number): Promise<void> {
    await this.clearLibrary("group", groupID);
  }

  async clearUserLibrary(userID: number): Promise<void> {
    await this.ensureUserLibrary(userID);
    await this.clearLibrary("user", userID);
  }

  async createGroup(input: CreateGroupInput): Promise<GroupRecord> {
    await this.ensureUserLibrary(input.owner);

    const idRow = await this.db
      .prepare("SELECT COALESCE(MAX(group_id), 0) + 1 AS id FROM groups")
      .first<{ id: number }>();
    const id = idRow?.id ?? 1;
    const group = {
      data: {
        description: input.description ?? "",
        fileEditing: input.fileEditing,
        hasImage: input.hasImage ?? 0,
        id,
        libraryEditing: input.libraryEditing,
        libraryReading: input.libraryReading,
        name: input.name,
        owner: input.owner,
        type: input.type,
        url: input.url ?? "",
        version: 1,
      },
      id,
    };

    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO groups (group_id, owner_user_id, name, type, library_version, data_json) VALUES (?, ?, ?, ?, 1, ?)"
        )
        .bind(
          id,
          input.owner,
          input.name,
          input.type,
          JSON.stringify(group.data)
        ),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('group', ?)"
        )
        .bind(id),
      this.db
        .prepare(
          "INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')"
        )
        .bind(id, input.owner),
    ]);

    return group;
  }

  async createGroupItems(
    groupID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    await this.ensureGroupLibrary(groupID);
    return this.createItemsForLibrary(
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
    return this.createItemsForLibrary(
      "user",
      userID,
      objects,
      writeToken,
      options
    );
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
    return this.deleteItemsForLibrary(
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
    return this.deleteItemsForLibrary(
      "user",
      userID,
      itemKeys,
      ifUnmodifiedSinceVersion
    );
  }

  async deleteGroup(groupID: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM groups WHERE group_id = ?").bind(groupID),
      this.db
        .prepare(
          "DELETE FROM libraries WHERE library_type = 'group' AND library_id = ?"
        )
        .bind(groupID),
    ]);
  }

  async getGroup(groupID: number): Promise<GroupRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT group_id, library_version, data_json FROM groups WHERE group_id = ?"
      )
      .bind(groupID)
      .first<D1GroupRow>();

    return row ? parseGroupRow(row) : null;
  }

  async getGroupOwnerUserID(groupID: number): Promise<number | null> {
    const row = await this.db
      .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
      .bind(groupID)
      .first<{ owner_user_id: number }>();

    return row?.owner_user_id ?? null;
  }

  async getGroupAccess(userID: number, groupID: number): Promise<GroupAccess> {
    const row = await this.db
      .prepare(
        `SELECT G.owner_user_id, G.type, G.data_json, GM.role
         FROM groups G
         LEFT JOIN group_members GM
           ON GM.group_id = G.group_id
          AND GM.user_id = ?
         WHERE G.group_id = ?`
      )
      .bind(userID, groupID)
      .first<{
        data_json: string;
        owner_user_id: number;
        role: string | null;
        type: string;
      }>();

    if (!row) {
      return {
        canAdmin: false,
        canEdit: false,
        canEditFiles: false,
        canRead: false,
      };
    }

    const data = JSON.parse(row.data_json) as GroupRecord["data"];
    const role = row.role ?? (row.owner_user_id === userID ? "owner" : null);
    const isPublic = row.type === "PublicOpen" || row.type === "PublicClosed";
    const canRead =
      Boolean(role) || (isPublic && data.libraryReading === "all");
    const canAdmin = role === "owner" || role === "admin";
    const canEdit =
      canAdmin || (role === "member" && data.libraryEditing === "members");
    const canEditFiles =
      data.fileEditing !== "none" &&
      (canAdmin || (role === "member" && data.fileEditing === "members"));

    return {
      canAdmin,
      canEdit,
      canEditFiles,
      canRead,
    };
  }

  async getItem(
    userID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    const result = await this.listItems(userID, [itemKey]);

    if (result.items.length === 0) {
      return null;
    }

    return result;
  }

  async getAttachmentFile(
    userID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null> {
    return this.getAttachmentFileForLibrary("user", userID, itemKey);
  }

  async getAttachmentObject(
    userID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null> {
    if (!this.bucket) {
      return null;
    }

    const file = await this.getAttachmentFile(userID, itemKey);
    if (!file) {
      return null;
    }

    const object = await this.bucket.get(file.r2Key);
    if (!object) {
      return null;
    }

    return {
      body: object.body,
      file,
    };
  }

  async getGroupAttachmentFile(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null> {
    return this.getAttachmentFileForLibrary("group", groupID, itemKey);
  }

  async getGroupAttachmentObject(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null> {
    return this.getAttachmentObjectForLibrary("group", groupID, itemKey);
  }

  async getAttachmentObjectByStoragePath(
    storageMd5: string,
    storageFilename: string
  ): Promise<AttachmentObjectResult | null> {
    if (!this.bucket) {
      return null;
    }

    const fileRow = await this.db
      .prepare(
        `SELECT item_key, r2_key, filename, content_type, charset, size_bytes, md5,
                mtime, storage_md5, storage_filename, zip
         FROM attachment_files
         WHERE storage_md5 = ?
           AND storage_filename = ?
           AND upload_state = 'complete'
         LIMIT 1`
      )
      .bind(storageMd5, storageFilename)
      .first<D1AttachmentFileRow>();

    if (!fileRow) {
      return null;
    }

    const file = parseAttachmentFileRow(fileRow);
    const object = await this.bucket.get(file.r2Key);
    if (!object) {
      return null;
    }

    return {
      body: object.body,
      file,
    };
  }

  async getGroupItem(
    groupID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    const result = await this.listGroupItems(groupID, [itemKey]);

    if (result.items.length === 0) {
      return null;
    }

    return result;
  }

  async getUserIDForApiKey(apiKey: string): Promise<number | null> {
    const row = await this.db
      .prepare(
        "SELECT user_id FROM api_keys WHERE api_key = ? AND revoked_at IS NULL"
      )
      .bind(apiKey)
      .first<{ user_id: number }>();

    return row?.user_id ?? null;
  }

  async getStorageQuota(userID: number): Promise<StorageQuota> {
    const row = await this.db
      .prepare(
        "SELECT quota_mb, unlimited, expiration FROM storage_accounts WHERE user_id = ?"
      )
      .bind(userID)
      .first<{
        expiration: number;
        quota_mb: number | null;
        unlimited: number;
      }>();

    if (!row) {
      return getDefaultStorageQuota();
    }

    return {
      expiration: row.expiration,
      quotaMB: row.unlimited
        ? 1_000_000
        : (row.quota_mb ?? defaultStorageQuotaMB),
      unlimited: Boolean(row.unlimited),
    };
  }

  async getStorageUsageBytes(userID: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(AF.size_bytes), 0) AS bytes
         FROM attachment_files AF
         LEFT JOIN groups G
           ON AF.library_type = 'group'
          AND AF.library_id = G.group_id
         WHERE (AF.library_type = 'user' AND AF.library_id = ?)
            OR (AF.library_type = 'group' AND G.owner_user_id = ?)`
      )
      .bind(userID, userID)
      .first<{ bytes: number }>();

    return row?.bytes ?? 0;
  }

  async listGroupUsers(groupID: number): Promise<GroupUserRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT user_id, role
         FROM group_members
         WHERE group_id = ?
         ORDER BY user_id ASC`
      )
      .bind(groupID)
      .all<{ role: string; user_id: number }>();

    return rows.results.map((row) => ({
      role: row.role,
      userID: row.user_id,
    }));
  }

  async listItems(
    userID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    await this.ensureUserLibrary(userID);

    const version = await this.getLibraryVersion("user", userID);
    const rows = itemKeys?.length
      ? await this.db
          .prepare(
            `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
             FROM items
             WHERE library_type = 'user'
               AND library_id = ?
               AND deleted_at IS NULL
               AND item_key IN (${itemKeys.map(() => "?").join(",")})
             ORDER BY version ASC`
          )
          .bind(userID, ...itemKeys)
          .all<D1ItemRow>()
      : await this.db
          .prepare(
            `SELECT item_key, version, data_json, created_by_user_id, last_modified_by_user_id
             FROM items
             WHERE library_type = 'user'
               AND library_id = ?
               AND deleted_at IS NULL
             ORDER BY version ASC`
          )
          .bind(userID)
          .all<D1ItemRow>();

    return {
      items: rows.results.map(parseItemRow),
      version,
    };
  }

  async listVisibleGroups(userID: number): Promise<GroupRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT group_id, library_version, data_json
         FROM groups G
         WHERE owner_user_id = ?
            OR type IN ('PublicOpen', 'PublicClosed')
            OR EXISTS (
              SELECT 1
              FROM group_members GM
              WHERE GM.group_id = G.group_id
                AND GM.user_id = ?
            )
         ORDER BY group_id ASC`
      )
      .bind(userID, userID)
      .all<D1GroupRow>();

    return rows.results.map(parseGroupRow);
  }

  async listGroups(): Promise<GroupRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT group_id, library_version, data_json
         FROM groups
         ORDER BY group_id ASC`
      )
      .all<D1GroupRow>();

    return rows.results.map(parseGroupRow);
  }

  async listGroupItems(
    groupID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    await this.ensureGroupLibrary(groupID);
    return this.listItemsForLibrary("group", groupID, itemKeys);
  }

  async setupTestUsers(
    userID: number,
    userID2: number,
    user1Key: string,
    user2Key: string
  ): Promise<SetupResult> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sync_log"),
      this.db.prepare("DELETE FROM attachment_uploads"),
      this.db.prepare("DELETE FROM attachment_files"),
      this.db.prepare("DELETE FROM fulltext_index_states"),
      this.db.prepare("DELETE FROM fulltext_items"),
      this.db.prepare("DELETE FROM item_collection_memberships"),
      this.db.prepare("DELETE FROM items"),
      this.db.prepare("DELETE FROM collections"),
      this.db.prepare("DELETE FROM searches"),
      this.db.prepare("DELETE FROM settings"),
      this.db.prepare("DELETE FROM write_tokens"),
      this.db.prepare("DELETE FROM group_members"),
      this.db.prepare("DELETE FROM groups"),
      this.db.prepare("DELETE FROM login_sessions"),
      this.db.prepare("DELETE FROM api_keys"),
      this.db.prepare("DELETE FROM storage_accounts"),
      this.db.prepare("DELETE FROM libraries"),
      this.db.prepare("DELETE FROM users"),
    ]);

    await this.db.batch([
      this.db.prepare("INSERT INTO users (user_id) VALUES (?)").bind(userID),
      this.db.prepare("INSERT INTO users (user_id) VALUES (?)").bind(userID2),
      this.db
        .prepare(
          "INSERT INTO api_keys (api_key, user_id, label, scopes_json) VALUES (?, ?, 'test-user-1', ?)"
        )
        .bind(user1Key, userID, JSON.stringify(defaultKeyAccess())),
      this.db
        .prepare(
          "INSERT INTO api_keys (api_key, user_id, label, scopes_json) VALUES (?, ?, 'test-user-2', ?)"
        )
        .bind(user2Key, userID2, JSON.stringify(defaultKeyAccess())),
      this.db
        .prepare(
          "INSERT INTO libraries (library_type, library_id) VALUES ('user', ?)"
        )
        .bind(userID),
      this.db
        .prepare(
          "INSERT INTO libraries (library_type, library_id) VALUES ('user', ?)"
        )
        .bind(userID2),
    ]);

    return {
      user1: {
        apiKey: user1Key,
        userID,
      },
      user2: {
        apiKey: user2Key,
        userID: userID2,
      },
    };
  }

  async registerAttachmentUpload(
    userID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult> {
    return this.registerAttachmentUploadForLibrary(
      "user",
      userID,
      itemKey,
      uploadKey
    );
  }

  async registerGroupAttachmentUpload(
    groupID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult> {
    return this.registerAttachmentUploadForLibrary(
      "group",
      groupID,
      itemKey,
      uploadKey
    );
  }

  async removeGroupUser(groupID: number, userID: number): Promise<void> {
    const owner = await this.db
      .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
      .bind(groupID)
      .first<{ owner_user_id: number }>();

    if (owner?.owner_user_id === userID) {
      return;
    }

    await this.db
      .prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
      .bind(groupID, userID)
      .run();
    await this.db
      .prepare(
        "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
      )
      .bind(groupID)
      .run();
  }

  async storeAttachmentUpload(
    uploadKey: string,
    body: ArrayBuffer,
    contentType?: string | null
  ): Promise<AttachmentUploadStoreResult> {
    const upload = await this.db
      .prepare(
        "SELECT r2_key, md5, size_bytes FROM attachment_uploads WHERE upload_key = ? AND upload_state = 'queued'"
      )
      .bind(uploadKey)
      .first<{ md5: string; r2_key: string; size_bytes: number }>();

    if (!upload) {
      return { found: false };
    }

    const itemData = await this.getUploadItemData(uploadKey);
    const uploadItemContentType = getNonEmptyString(itemData?.contentType);
    const allowS3CompatibleBinaryBody =
      uploadItemContentType === "application/pdf";

    if (!allowS3CompatibleBinaryBody && md5Hex(body) !== upload.md5) {
      return {
        found: true,
        hashMismatch: true,
      };
    }
    if (!allowS3CompatibleBinaryBody && body.byteLength !== upload.size_bytes) {
      return {
        found: true,
        sizeMismatch: true,
      };
    }

    if (!this.bucket) {
      return { found: false };
    }

    await this.bucket.put(upload.r2_key, body, {
      httpMetadata: {
        contentType: contentType ?? "application/octet-stream",
      },
    });

    await this.db
      .prepare(
        `UPDATE attachment_uploads
         SET upload_state = 'uploaded',
             uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE upload_key = ?`
      )
      .bind(uploadKey)
      .run();

    return { found: true };
  }

  async setStorageQuota(
    userID: number,
    quotaMB: number | "unlimited" | null,
    expiration: number
  ): Promise<StorageQuota> {
    await this.db
      .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
      .bind(userID)
      .run();

    if (quotaMB === null) {
      await this.db
        .prepare("DELETE FROM storage_accounts WHERE user_id = ?")
        .bind(userID)
        .run();
      return getDefaultStorageQuota();
    }

    await this.db
      .prepare(
        `INSERT INTO storage_accounts (user_id, quota_mb, unlimited, expiration)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           quota_mb = excluded.quota_mb,
           unlimited = excluded.unlimited,
           expiration = excluded.expiration,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      )
      .bind(
        userID,
        quotaMB === "unlimited" ? null : quotaMB,
        quotaMB === "unlimited" ? 1 : 0,
        expiration
      )
      .run();

    return {
      expiration,
      quotaMB: quotaMB === "unlimited" ? 1_000_000 : quotaMB,
      unlimited: quotaMB === "unlimited",
    };
  }

  async updateGroupUser(
    groupID: number,
    userID: number,
    role: string
  ): Promise<void> {
    const normalizedRole = normalizeGroupRole(role);

    await this.db
      .prepare("INSERT OR IGNORE INTO users (user_id) VALUES (?)")
      .bind(userID)
      .run();

    if (normalizedRole === "owner") {
      const currentOwner = await this.db
        .prepare("SELECT owner_user_id FROM groups WHERE group_id = ?")
        .bind(groupID)
        .first<{ owner_user_id: number }>();

      await this.db.batch([
        this.db
          .prepare(
            "UPDATE groups SET owner_user_id = ?, library_version = library_version + 1 WHERE group_id = ?"
          )
          .bind(userID, groupID),
        this.db
          .prepare(
            `INSERT INTO group_members (group_id, user_id, role)
             VALUES (?, ?, 'owner')
             ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'owner'`
          )
          .bind(groupID, userID),
        ...(currentOwner && currentOwner.owner_user_id !== userID
          ? [
              this.db
                .prepare(
                  `INSERT INTO group_members (group_id, user_id, role)
                   VALUES (?, ?, 'admin')
                   ON CONFLICT(group_id, user_id) DO UPDATE SET role = 'admin'`
                )
                .bind(groupID, currentOwner.owner_user_id),
            ]
          : []),
      ]);
      return;
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO group_members (group_id, user_id, role)
           VALUES (?, ?, ?)
           ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role`
        )
        .bind(groupID, userID, normalizedRole),
      this.db
        .prepare(
          "UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?"
        )
        .bind(groupID),
    ]);
  }

  async updateGroup(
    groupID: number,
    data: Record<string, unknown>
  ): Promise<GroupRecord | null> {
    const existing = await this.getGroup(groupID);
    if (!existing) {
      return null;
    }

    const version = existing.data.version + 1;
    const merged = {
      ...existing.data,
      ...data,
      id: groupID,
      owner:
        typeof data.owner === "number" && Number.isFinite(data.owner)
          ? data.owner
          : existing.data.owner,
      version,
    };
    await this.db
      .prepare(
        `UPDATE groups
         SET owner_user_id = ?,
             name = ?,
             type = ?,
             library_version = ?,
             data_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE group_id = ?`
      )
      .bind(
        merged.owner,
        String(merged.name ?? `Group ${groupID}`),
        String(merged.type ?? "Private"),
        version,
        JSON.stringify(merged),
        groupID
      )
      .run();

    return this.getGroup(groupID);
  }

  private async clearLibrary(
    libraryType: "group" | "user",
    libraryID: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM sync_log WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM attachment_uploads WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM attachment_files WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM fulltext_items WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM item_collection_memberships WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare("DELETE FROM items WHERE library_type = ? AND library_id = ?")
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM collections WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM searches WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM settings WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "DELETE FROM write_tokens WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
      this.db
        .prepare(
          "UPDATE libraries SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
        )
        .bind(libraryType, libraryID),
    ]);
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
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO libraries (library_type, library_id) VALUES ('group', ?)"
      )
      .bind(groupID)
      .run();
  }

  private async getLibraryVersion(
    libraryType: "group" | "user",
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
    libraryType: "group" | "user",
    libraryID: number,
    count: number,
    expectedVersion: number | null
  ): Promise<number | null> {
    if (count <= 0) {
      return this.getLibraryVersion(libraryType, libraryID);
    }

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

  private async getItemsByKeyIncludingDeleted(
    libraryType: "group" | "user",
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

  private async getUploadItemData(
    uploadKey: string
  ): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .prepare(
        `SELECT I.data_json
         FROM attachment_uploads U
         JOIN items I
           ON I.library_type = U.library_type
          AND I.library_id = U.library_id
          AND I.item_key = U.item_key
         WHERE U.upload_key = ?
           AND I.deleted_at IS NULL`
      )
      .bind(uploadKey)
      .first<{ data_json: string }>();

    return row ? (JSON.parse(row.data_json) as Record<string, unknown>) : null;
  }

  private async reservePreconditionGuard(
    libraryType: "group" | "user",
    libraryID: number,
    objectType: string,
    expectedVersion: number
  ): Promise<boolean> {
    const token = `if-unmodified:${objectType}:${expectedVersion}`;
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

  private async authorizeLibraryAttachmentUpload(
    libraryType: "group" | "user",
    libraryID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization> {
    const uploadKey = crypto.randomUUID().replaceAll("-", "");
    const r2Key = `uploads/${uploadKey}`;

    await this.db
      .prepare(
        `INSERT INTO attachment_uploads (
          upload_key,
          library_type,
          library_id,
          item_key,
          r2_key,
          filename,
          item_filename,
          content_type,
          charset,
          size_bytes,
          md5,
          item_md5,
          mtime,
          zip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        uploadKey,
        libraryType,
        libraryID,
        itemKey,
        r2Key,
        input.filename,
        input.itemFilename ?? null,
        input.contentType ?? null,
        input.charset ?? null,
        input.sizeBytes,
        input.md5,
        input.itemMd5 ?? null,
        input.mtime,
        input.zip ? 1 : 0
      )
      .run();

    return {
      contentType: input.contentType ?? "application/octet-stream",
      prefix: "",
      suffix: "",
      uploadKey,
      url: `${uploadBaseURL}/upload/${uploadKey}`,
    };
  }

  private async associateExistingAttachmentFileForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ): Promise<AttachmentExistingFileResult> {
    const existingFileRow = await this.db
      .prepare(
        `SELECT item_key, r2_key, filename, content_type, charset, size_bytes, md5,
                mtime, storage_md5, storage_filename, zip
         FROM attachment_files
         WHERE library_type = ?
           AND library_id = ?
           AND storage_md5 = ?
           AND zip = ?
         LIMIT 1`
      )
      .bind(libraryType, libraryID, input.md5, input.zip ? 1 : 0)
      .first<D1AttachmentFileRow>();

    if (!existingFileRow) {
      return {
        associated: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const existingFile = parseAttachmentFileRow(existingFileRow);
    if (existingFile.sizeBytes !== input.sizeBytes) {
      return {
        associated: false,
        sizeMismatch: true,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const sourceObject = this.bucket
      ? await this.bucket.get(existingFile.r2Key)
      : null;
    if (!(sourceObject && this.bucket)) {
      return {
        associated: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }
    const r2Key = `files/${libraryType}/${libraryID}/${itemKey}/${input.md5}`;
    await this.bucket.put(r2Key, sourceObject.body, {
      httpMetadata: {
        contentType:
          input.contentType ??
          existingFile.contentType ??
          "application/octet-stream",
      },
    });

    const version = await this.reserveLibraryVersions(
      libraryType,
      libraryID,
      1,
      null
    );
    if (version === null) {
      return {
        associated: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const itemRow = await this.db
      .prepare(
        `SELECT data_json
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND item_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, itemKey)
      .first<{ data_json: string }>();
    const existingData = itemRow
      ? (JSON.parse(itemRow.data_json) as Record<string, unknown>)
      : {};
    const contentType =
      input.contentType ??
      getNonEmptyString(existingData.contentType) ??
      existingFile.contentType ??
      null;
    const charset =
      input.charset ??
      getNonEmptyString(existingData.charset) ??
      existingFile.charset ??
      null;
    const data = sanitizeZoteroData({
      ...existingData,
      ...(charset === null ? {} : { charset }),
      ...(contentType === null ? {} : { contentType }),
      filename: input.itemFilename ?? input.filename,
      key: itemKey,
      md5: input.itemMd5 ?? input.md5,
      mtime: input.mtime,
      version,
    });

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attachment_files (
            library_type,
            library_id,
            item_key,
            r2_key,
            filename,
            content_type,
            charset,
            size_bytes,
            md5,
            mtime,
            upload_state,
            storage_md5,
            storage_filename,
            zip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
          ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
            r2_key = excluded.r2_key,
            filename = excluded.filename,
            content_type = excluded.content_type,
            charset = excluded.charset,
            size_bytes = excluded.size_bytes,
            md5 = excluded.md5,
            mtime = excluded.mtime,
            upload_state = 'complete',
            storage_md5 = excluded.storage_md5,
            storage_filename = excluded.storage_filename,
            zip = excluded.zip,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        )
        .bind(
          libraryType,
          libraryID,
          itemKey,
          r2Key,
          input.itemFilename ?? input.filename,
          contentType,
          charset,
          input.sizeBytes,
          input.itemMd5 ?? input.md5,
          input.mtime,
          input.md5,
          input.filename,
          input.zip ? 1 : 0
        ),
      this.db
        .prepare(
          `UPDATE items
           SET version = ?,
             data_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE library_type = ?
             AND library_id = ?
             AND item_key = ?`
        )
        .bind(version, JSON.stringify(data), libraryType, libraryID, itemKey),
      this.db
        .prepare(
          "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'file', 'item', ?)"
        )
        .bind(libraryType, libraryID, version, itemKey),
    ]);

    return {
      associated: true,
      version,
    };
  }

  private async deleteItemsForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{
    deleted: string[];
    preconditionFailed: boolean;
    version: number;
  }> {
    const version = await this.getLibraryVersion(libraryType, libraryID);
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
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'delete', 'item', ?)"
          )
          .bind(libraryType, libraryID, nextVersion, itemKey),
      ]),
    ]);

    return {
      deleted: existingKeys,
      preconditionFailed: false,
      version: nextVersion,
    };
  }

  private async createItemsForLibrary(
    libraryType: "group" | "user",
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
        const version = await this.getLibraryVersion(libraryType, libraryID);
        return {
          duplicateWriteToken: true,
          success: [],
          successful: [],
          version,
        };
      }
    }

    const expectedVersion = options?.ifUnmodifiedSinceVersion ?? null;
    let version = await this.getLibraryVersion(libraryType, libraryID);
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
      !(await this.reservePreconditionGuard(
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
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }
    const reservedVersion = objects.length
      ? await this.reserveLibraryVersions(
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
        version: await this.getLibraryVersion(libraryType, libraryID),
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

  private async listItemsForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    const version = await this.getLibraryVersion(libraryType, libraryID);
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

  private async getAttachmentFileForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT AF.item_key,
                AF.r2_key,
                AF.filename,
                AF.content_type,
                AF.charset,
                AF.size_bytes,
                AF.md5,
                AF.mtime,
                AF.storage_md5,
                AF.storage_filename,
                AF.zip,
                EXISTS(
                  SELECT 1
                  FROM attachment_files Legacy
                  WHERE Legacy.library_type = AF.library_type
                    AND Legacy.library_id = AF.library_id
                    AND Legacy.storage_md5 = AF.storage_md5
                    AND Legacy.storage_filename = AF.storage_filename
                    AND Legacy.r2_key = AF.storage_md5 || '/' || AF.storage_filename
                ) AS legacy_storage
         FROM attachment_files AF
         WHERE AF.library_type = ?
           AND AF.library_id = ?
           AND AF.item_key = ?`
      )
      .bind(libraryType, libraryID, itemKey)
      .first<D1AttachmentFileRow>();

    return row ? parseAttachmentFileRow(row) : null;
  }

  private async getAttachmentObjectForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null> {
    if (!this.bucket) {
      return null;
    }

    const file = await this.getAttachmentFileForLibrary(
      libraryType,
      libraryID,
      itemKey
    );
    if (!file) {
      return null;
    }

    const object = await this.bucket.get(file.r2Key);
    if (!object) {
      return null;
    }

    return {
      body: object.body,
      file,
    };
  }

  private async registerAttachmentUploadForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult> {
    const upload = await this.db
      .prepare(
        `SELECT upload_key, item_key, r2_key, filename, item_filename, content_type,
                charset, size_bytes, md5, item_md5, mtime, upload_state, zip
         FROM attachment_uploads
         WHERE upload_key = ?
           AND library_type = ?
           AND library_id = ?
           AND item_key = ?`
      )
      .bind(uploadKey, libraryType, libraryID, itemKey)
      .first<D1AttachmentUploadRow>();

    if (!upload) {
      return {
        found: false,
        registered: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    let r2Key = upload.r2_key;
    if (upload.upload_state !== "uploaded") {
      const legacyR2Key = `${upload.md5}/${upload.filename}`;
      const legacyObject = this.bucket
        ? await this.bucket.head(legacyR2Key)
        : null;
      if (!legacyObject || legacyObject.size !== upload.size_bytes) {
        return {
          found: true,
          registered: false,
          version: await this.getLibraryVersion(libraryType, libraryID),
        };
      }
      r2Key = legacyR2Key;
    }

    const version = await this.reserveLibraryVersions(
      libraryType,
      libraryID,
      1,
      null
    );
    if (version === null) {
      return {
        found: true,
        registered: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    const itemRow = await this.db
      .prepare(
        `SELECT data_json
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND item_key = ?
           AND deleted_at IS NULL`
      )
      .bind(libraryType, libraryID, itemKey)
      .first<{ data_json: string }>();
    const existingData = itemRow
      ? (JSON.parse(itemRow.data_json) as Record<string, unknown>)
      : {};
    const contentType =
      getNonEmptyString(existingData.contentType) ?? upload.content_type;
    const charset = getNonEmptyString(existingData.charset) ?? upload.charset;
    const data = sanitizeZoteroData({
      ...existingData,
      ...(charset === null ? {} : { charset }),
      ...(contentType === null ? {} : { contentType }),
      filename: upload.item_filename ?? upload.filename,
      key: itemKey,
      md5: upload.item_md5 ?? upload.md5,
      mtime: upload.mtime,
      version,
    });

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO attachment_files (
            library_type,
            library_id,
            item_key,
            r2_key,
            filename,
            content_type,
            charset,
            size_bytes,
            md5,
            mtime,
            upload_state,
            storage_md5,
            storage_filename,
            zip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
          ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
            r2_key = excluded.r2_key,
            filename = excluded.filename,
            content_type = excluded.content_type,
            charset = excluded.charset,
            size_bytes = excluded.size_bytes,
            md5 = excluded.md5,
            mtime = excluded.mtime,
            upload_state = 'complete',
            storage_md5 = excluded.storage_md5,
            storage_filename = excluded.storage_filename,
            zip = excluded.zip,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        )
        .bind(
          libraryType,
          libraryID,
          itemKey,
          r2Key,
          upload.item_filename ?? upload.filename,
          contentType,
          charset,
          upload.size_bytes,
          upload.item_md5 ?? upload.md5,
          upload.mtime,
          upload.md5,
          upload.filename,
          upload.zip ? 1 : 0
        ),
      this.db
        .prepare(
          `UPDATE items
           SET version = ?,
             data_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE library_type = ?
             AND library_id = ?
             AND item_key = ?`
        )
        .bind(version, JSON.stringify(data), libraryType, libraryID, itemKey),
      this.db
        .prepare(
          `UPDATE attachment_uploads
           SET r2_key = ?,
               upload_state = 'registered',
               registered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE upload_key = ?`
        )
        .bind(r2Key, uploadKey),
      this.db
        .prepare(
          "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'file', 'item', ?)"
        )
        .bind(libraryType, libraryID, version, itemKey),
    ]);

    return {
      found: true,
      registered: true,
      version,
    };
  }
}

interface D1GroupRow {
  data_json: string;
  group_id: number;
  library_version: number;
}

interface D1ItemRow {
  created_by_user_id?: number | null;
  data_json: string;
  item_key: string;
  last_modified_by_user_id?: number | null;
  version: number;
}

interface D1AttachmentFileRow {
  charset: string | null;
  content_type: string | null;
  filename: string;
  item_key: string;
  legacy_storage?: number | null;
  md5: string;
  mtime: number;
  r2_key: string;
  size_bytes: number;
  storage_filename?: string | null;
  storage_md5?: string | null;
  zip?: number | null;
}

interface D1AttachmentUploadRow extends D1AttachmentFileRow {
  charset: string | null;
  item_filename: string | null;
  item_md5: string | null;
  upload_key: string;
  upload_state: string;
}

const parseGroupRow = (row: D1GroupRow): GroupRecord => {
  const data = JSON.parse(row.data_json) as GroupRecord["data"];
  return {
    data: {
      ...data,
      id: row.group_id,
      version: row.library_version || data.version || 1,
    },
    id: row.group_id,
  };
};

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

const parseAttachmentFileRow = (
  row: D1AttachmentFileRow
): AttachmentFileRecord => ({
  charset: row.charset,
  contentType: row.content_type,
  filename: row.filename,
  itemKey: row.item_key,
  ...(row.legacy_storage ? { legacyStorage: true } : {}),
  md5: row.md5,
  mtime: row.mtime,
  r2Key: row.r2_key,
  sizeBytes: row.size_bytes,
  ...(row.storage_filename ? { storageFilename: row.storage_filename } : {}),
  ...(row.storage_md5 ? { storageMd5: row.storage_md5 } : {}),
  zip: Boolean(row.zip),
});
