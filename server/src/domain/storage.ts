import type { Bindings } from "../bindings";
import {
  type AttachmentExistingFileResult,
  type AttachmentFileRecord,
  type AttachmentObjectResult,
  type AttachmentRegistrationResult,
  type AttachmentUploadAuthorization,
  type AttachmentUploadInput,
  type AttachmentUploadScope,
  type AttachmentUploadStoreResult,
  D1AttachmentStorage,
  type DirectAttachmentCompletion,
  type DirectAttachmentUpload,
  type StorageQuota,
} from "./attachment-storage";
import {
  type CreateGroupInput,
  D1GroupStorage,
  type GroupAccess,
  type GroupUserInput,
  type GroupUserRecord,
} from "./group-storage";
import {
  type CreateItemsResult,
  D1ItemStorage,
  type ItemListResult,
  type ItemWriteOptions,
} from "./item-storage";
import { D1LibraryVersions } from "./library-versions";
import type { GroupRecord } from "./state";

export type {
  AttachmentFileRecord,
  AttachmentUploadScope,
  DirectAttachmentUpload,
} from "./attachment-storage";
export {
  directMultipartPartSize,
  directSinglePutThresholdBytes,
} from "./attachment-storage";

export type { ItemWriteOptions } from "./item-storage";

export interface CompatibilityStore {
  abortDirectAttachmentUpload: (
    uploadKey: string,
    scope: AttachmentUploadScope
  ) => Promise<boolean>;
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
  completeDirectAttachmentUpload: (
    uploadKey: string,
    scope: AttachmentUploadScope,
    parts: R2UploadedPart[]
  ) => Promise<DirectAttachmentCompletion>;
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
  prepareDirectAttachmentUpload: (
    uploadKey: string,
    scope: AttachmentUploadScope
  ) => Promise<DirectAttachmentUpload | null>;
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

class D1CompatibilityStore implements CompatibilityStore {
  private readonly attachments: D1AttachmentStorage;
  private readonly groups: D1GroupStorage;
  private readonly items: D1ItemStorage;

  constructor(
    private readonly db: D1Database,
    bucket?: R2Bucket
  ) {
    const libraryVersions = new D1LibraryVersions(db);
    this.attachments = new D1AttachmentStorage(db, libraryVersions, bucket);
    this.groups = new D1GroupStorage(db);
    this.items = new D1ItemStorage(db, libraryVersions, bucket);
  }

  async addGroupUsers(groupID: number, users: GroupUserInput[]): Promise<void> {
    return this.groups.addUsers(groupID, users);
  }

  async authorizeAttachmentUpload(
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization> {
    return this.attachments.authorizeAttachmentUpload(
      userID,
      itemKey,
      input,
      uploadBaseURL
    );
  }
  async associateExistingAttachmentFile(
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput
  ): Promise<AttachmentExistingFileResult> {
    return this.attachments.associateExistingAttachmentFile(
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
    return this.attachments.associateExistingGroupAttachmentFile(
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
    return this.attachments.authorizeGroupAttachmentUpload(
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
    return this.groups.create(input);
  }

  async createGroupItems(
    groupID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    return this.items.createGroupItems(groupID, objects, writeToken, options);
  }

  async createItems(
    userID: number,
    objects: Record<string, unknown>[],
    writeToken?: string,
    options?: ItemWriteOptions
  ): Promise<CreateItemsResult> {
    return this.items.createItems(userID, objects, writeToken, options);
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
    return this.items.deleteGroupItems(
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
    return this.items.deleteItems(userID, itemKeys, ifUnmodifiedSinceVersion);
  }

  async deleteGroup(groupID: number): Promise<void> {
    return this.groups.delete(groupID);
  }

  async getGroup(groupID: number): Promise<GroupRecord | null> {
    return this.groups.get(groupID);
  }

  async getGroupOwnerUserID(groupID: number): Promise<number | null> {
    return this.groups.getOwnerUserID(groupID);
  }

  async getGroupAccess(userID: number, groupID: number): Promise<GroupAccess> {
    return this.groups.getAccess(userID, groupID);
  }

  async getItem(
    userID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    return this.items.getItem(userID, itemKey);
  }

  async getAttachmentFile(
    userID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null> {
    return this.attachments.getAttachmentFile(userID, itemKey);
  }
  async getAttachmentObject(
    userID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null> {
    return this.attachments.getAttachmentObject(userID, itemKey);
  }
  async getGroupAttachmentFile(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null> {
    return this.attachments.getGroupAttachmentFile(groupID, itemKey);
  }
  async getGroupAttachmentObject(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null> {
    return this.attachments.getGroupAttachmentObject(groupID, itemKey);
  }
  async getAttachmentObjectByStoragePath(
    storageMd5: string,
    storageFilename: string
  ): Promise<AttachmentObjectResult | null> {
    return this.attachments.getAttachmentObjectByStoragePath(
      storageMd5,
      storageFilename
    );
  }
  async getGroupItem(
    groupID: number,
    itemKey: string
  ): Promise<ItemListResult | null> {
    return this.items.getGroupItem(groupID, itemKey);
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
    return this.attachments.getStorageQuota(userID);
  }
  async getStorageUsageBytes(userID: number): Promise<number> {
    return this.attachments.getStorageUsageBytes(userID);
  }
  async listGroupUsers(groupID: number): Promise<GroupUserRecord[]> {
    return this.groups.listUsers(groupID);
  }

  async listItems(
    userID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    return this.items.listItems(userID, itemKeys);
  }

  async listVisibleGroups(userID: number): Promise<GroupRecord[]> {
    return this.groups.listVisible(userID);
  }

  async listGroups(): Promise<GroupRecord[]> {
    return this.groups.list();
  }

  async listGroupItems(
    groupID: number,
    itemKeys?: string[]
  ): Promise<ItemListResult> {
    return this.items.listGroupItems(groupID, itemKeys);
  }

  async registerAttachmentUpload(
    userID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult> {
    return this.attachments.registerAttachmentUpload(
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
    return this.attachments.registerGroupAttachmentUpload(
      groupID,
      itemKey,
      uploadKey
    );
  }
  async removeGroupUser(groupID: number, userID: number): Promise<void> {
    return this.groups.removeUser(groupID, userID);
  }

  async storeAttachmentUpload(
    uploadKey: string,
    body: ArrayBuffer,
    contentType?: string | null
  ): Promise<AttachmentUploadStoreResult> {
    return this.attachments.storeAttachmentUpload(uploadKey, body, contentType);
  }
  async prepareDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope
  ): Promise<DirectAttachmentUpload | null> {
    return this.attachments.prepareDirectAttachmentUpload(uploadKey, scope);
  }
  async completeDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope,
    parts: R2UploadedPart[]
  ): Promise<DirectAttachmentCompletion> {
    return this.attachments.completeDirectAttachmentUpload(
      uploadKey,
      scope,
      parts
    );
  }
  async abortDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope
  ): Promise<boolean> {
    return this.attachments.abortDirectAttachmentUpload(uploadKey, scope);
  }
  async setStorageQuota(
    userID: number,
    quotaMB: number | "unlimited" | null,
    expiration: number
  ): Promise<StorageQuota> {
    return this.attachments.setStorageQuota(userID, quotaMB, expiration);
  }
  async updateGroupUser(
    groupID: number,
    userID: number,
    role: string
  ): Promise<void> {
    return this.groups.updateUser(groupID, userID, role);
  }

  async updateGroup(
    groupID: number,
    data: Record<string, unknown>
  ): Promise<GroupRecord | null> {
    return this.groups.update(groupID, data);
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
}
