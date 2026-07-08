import type { Bindings } from "./bindings";
import {
  clearLibrary,
  getLibrary,
  getState,
  type GroupRecord,
  type ItemRecord,
  resetState,
} from "./state";
import { recordMemoryDeletion } from "./deleted";
import { md5Hex } from "./md5";
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
  success: string[];
  successful: ItemRecord[];
  version: number;
}

export interface AttachmentFileRecord {
  charset?: string | null;
  contentType?: string | null;
  filename: string;
  itemKey: string;
  md5: string;
  mtime: number;
  r2Key: string;
  sizeBytes: number;
  version?: number;
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

interface AttachmentObjectResult {
  body: ArrayBuffer | ReadableStream;
  file: AttachmentFileRecord;
}

export interface CompatibilityStore {
  addGroupUsers(groupID: number, users: GroupUserInput[]): Promise<void>;
  authorizeAttachmentUpload(
    userID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization>;
  authorizeGroupAttachmentUpload(
    groupID: number,
    itemKey: string,
    input: AttachmentUploadInput,
    uploadBaseURL: string
  ): Promise<AttachmentUploadAuthorization>;
  clearGroupLibrary(groupID: number): Promise<void>;
  clearUserLibrary(userID: number): Promise<void>;
  createGroup(input: CreateGroupInput): Promise<GroupRecord>;
  createGroupItems(
    groupID: number,
    objects: Record<string, unknown>[],
    writeToken?: string
  ): Promise<CreateItemsResult>;
  createItems(
    userID: number,
    objects: Record<string, unknown>[],
    writeToken?: string
  ): Promise<CreateItemsResult>;
  deleteGroupItems(
    groupID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ): Promise<{ deleted: string[]; preconditionFailed: boolean; version: number }>;
  deleteItems(
    userID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion?: number | null
  ): Promise<{ deleted: string[]; preconditionFailed: boolean; version: number }>;
  deleteGroup(groupID: number): Promise<void>;
  getGroup(groupID: number): Promise<GroupRecord | null>;
  getGroupAccess(userID: number, groupID: number): Promise<GroupAccess>;
  getGroupOwnerUserID(groupID: number): Promise<number | null>;
  getItem(userID: number, itemKey: string): Promise<ItemListResult | null>;
  getAttachmentFile(
    userID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null>;
  getAttachmentObject(
    userID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null>;
  getGroupAttachmentFile(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentFileRecord | null>;
  getGroupAttachmentObject(
    groupID: number,
    itemKey: string
  ): Promise<AttachmentObjectResult | null>;
  getGroupItem(
    groupID: number,
    itemKey: string
  ): Promise<ItemListResult | null>;
  getUserIDForApiKey(apiKey: string): Promise<number | null>;
  getStorageQuota(userID: number): Promise<StorageQuota>;
  getStorageUsageBytes(userID: number): Promise<number>;
  listGroupItems(groupID: number, itemKeys?: string[]): Promise<ItemListResult>;
  listGroupUsers(groupID: number): Promise<GroupUserRecord[]>;
  listItems(userID: number, itemKeys?: string[]): Promise<ItemListResult>;
  listGroups(): Promise<GroupRecord[]>;
  listVisibleGroups(userID: number): Promise<GroupRecord[]>;
  removeGroupUser(groupID: number, userID: number): Promise<void>;
  registerGroupAttachmentUpload(
    groupID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult>;
  registerAttachmentUpload(
    userID: number,
    itemKey: string,
    uploadKey: string
  ): Promise<AttachmentRegistrationResult>;
  setupTestUsers(
    userID: number,
    userID2: number,
    user1Key: string,
    user2Key: string
  ): Promise<SetupResult>;
  setStorageQuota(
    userID: number,
    quotaMB: number | "unlimited" | null,
    expiration: number
  ): Promise<StorageQuota>;
  storeAttachmentUpload(
    uploadKey: string,
    body: ArrayBuffer,
    contentType?: string | null
  ): Promise<AttachmentUploadStoreResult>;
  updateGroupUser(
    groupID: number,
    userID: number,
    role: string
  ): Promise<void>;
  updateGroup(
    groupID: number,
    data: Record<string, unknown>
  ): Promise<GroupRecord | null>;
}

export const createCompatibilityStore = (
  env: Bindings
): CompatibilityStore => {
  if (env.DB) {
    return new D1CompatibilityStore(env.DB, env.ATTACHMENTS);
  }

  return memoryStore;
};

interface MemoryUploadRecord extends AttachmentUploadInput {
  body?: ArrayBuffer;
  itemKey: string;
  libraryID: number;
  libraryType: "group" | "user";
  r2Key: string;
  uploadKey: string;
}

const memoryUploads = new Map<string, MemoryUploadRecord>();
const memoryFiles = new Map<string, AttachmentFileRecord & { body: ArrayBuffer }>();
const memoryGroupMembers = new Map<number, Map<number, string>>();
const memoryStorageAccounts = new Map<number, StorageQuota>();
const defaultStorageQuotaMB = 300;

const defaultKeyAccess = () => ({
  groups: { all: { library: true, write: true } },
  user: { files: true, library: true, notes: true, write: true },
});

const getMemoryLibraryID = (libraryType: "group" | "user", libraryID: number) =>
  libraryType === "user" ? libraryID : -libraryID;

const getMemoryLibrary = (libraryType: "group" | "user", libraryID: number) =>
  getLibrary(getMemoryLibraryID(libraryType, libraryID));

const getMemoryFileKey = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKey: string
) => `${libraryType}:${libraryID}:${itemKey}`;

const deleteMemoryItems = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKeys: string[],
  ifUnmodifiedSinceVersion: number | null = null
) => {
  const library = getMemoryLibrary(libraryType, libraryID);
  if (
    ifUnmodifiedSinceVersion !== null &&
    library.version > ifUnmodifiedSinceVersion
  ) {
    return {
      deleted: [],
      preconditionFailed: true,
      version: library.version,
    };
  }

  const existingKeys = itemKeys.filter((itemKey) => library.items.has(itemKey));
  if (existingKeys.length > 0) {
    library.version += 1;
    for (const itemKey of existingKeys) {
      library.items.delete(itemKey);
      recordMemoryDeletion(libraryType, libraryID, library.version, "item", itemKey);
      memoryFiles.delete(getMemoryFileKey(libraryType, libraryID, itemKey));
    }
  }

  return {
    deleted: existingKeys,
    preconditionFailed: false,
    version: library.version,
  };
};

const memoryStore: CompatibilityStore = {
  async addGroupUsers(groupID, users) {
    const members = getMemoryGroupMembers(groupID);
    const group = getState().groups.get(groupID);

    for (const user of users) {
      const role = normalizeGroupRole(user.role);
      members.set(user.userID, role);
      if (group && role === "owner") {
        const previousOwner = group.data.owner;
        group.data.owner = user.userID;
        if (previousOwner !== user.userID) {
          members.set(previousOwner, "admin");
        }
      }
    }
    if (group && users.length > 0) {
      group.data.version += 1;
    }
  },

  async authorizeAttachmentUpload(userID, itemKey, input, uploadBaseURL) {
    const uploadKey = generateZoteroKey().toLowerCase() + generateZoteroKey();
    const r2Key = `uploads/${uploadKey}`;

    memoryUploads.set(uploadKey, {
      ...input,
      itemKey,
      libraryID: userID,
      libraryType: "user",
      r2Key,
      uploadKey,
    });

    return {
      contentType: input.contentType ?? "application/octet-stream",
      prefix: "",
      suffix: "",
      uploadKey,
      url: `${uploadBaseURL}/upload/${uploadKey}`,
    };
  },

  async authorizeGroupAttachmentUpload(groupID, itemKey, input, uploadBaseURL) {
    const uploadKey = generateZoteroKey().toLowerCase() + generateZoteroKey();
    const r2Key = `uploads/${uploadKey}`;

    memoryUploads.set(uploadKey, {
      ...input,
      itemKey,
      libraryID: groupID,
      libraryType: "group",
      r2Key,
      uploadKey,
    });

    return {
      contentType: input.contentType ?? "application/octet-stream",
      prefix: "",
      suffix: "",
      uploadKey,
      url: `${uploadBaseURL}/upload/${uploadKey}`,
    };
  },

  async clearGroupLibrary(groupID) {
    clearLibrary(getMemoryLibraryID("group", groupID));
  },

  async clearUserLibrary(userID) {
    clearLibrary(userID);
  },

  async createGroup(input) {
    const id = getState().nextGroupID;
    getState().nextGroupID += 1;

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

    getState().groups.set(id, group);
    getMemoryGroupMembers(id).set(input.owner, "owner");
    return group;
  },

  async createGroupItems(groupID, objects, writeToken) {
    return createMemoryItems("group", groupID, objects, writeToken);
  },

  async createItems(userID, objects, writeToken) {
    return createMemoryItems("user", userID, objects, writeToken);
  },

  async deleteGroupItems(groupID, itemKeys, ifUnmodifiedSinceVersion = null) {
    return deleteMemoryItems("group", groupID, itemKeys, ifUnmodifiedSinceVersion);
  },

  async deleteItems(userID, itemKeys, ifUnmodifiedSinceVersion = null) {
    return deleteMemoryItems("user", userID, itemKeys, ifUnmodifiedSinceVersion);
  },

  async deleteGroup(groupID) {
    getState().groups.delete(groupID);
    memoryGroupMembers.delete(groupID);
  },

  async getGroupAccess(userID, groupID) {
    return getMemoryGroupAccess(userID, groupID);
  },

  async getGroup(groupID) {
    return getState().groups.get(groupID) ?? null;
  },

  async getGroupOwnerUserID(groupID) {
    return getState().groups.get(groupID)?.data.owner ?? null;
  },

  async getItem(userID, itemKey) {
    return getMemoryItem("user", userID, itemKey);
  },

  async getAttachmentFile(userID, itemKey) {
    const file = memoryFiles.get(getMemoryFileKey("user", userID, itemKey));
    if (!file) {
      return null;
    }

    const { body: _body, ...metadata } = file;
    return metadata;
  },

  async getAttachmentObject(userID, itemKey) {
    const file = memoryFiles.get(getMemoryFileKey("user", userID, itemKey));
    if (!file) {
      return null;
    }

    const { body, ...metadata } = file;
    return {
      body,
      file: metadata,
    };
  },

  async getGroupAttachmentFile(groupID, itemKey) {
    const file = memoryFiles.get(getMemoryFileKey("group", groupID, itemKey));
    if (!file) {
      return null;
    }

    const { body: _body, ...metadata } = file;
    return metadata;
  },

  async getGroupAttachmentObject(groupID, itemKey) {
    const file = memoryFiles.get(getMemoryFileKey("group", groupID, itemKey));
    if (!file) {
      return null;
    }

    const { body, ...metadata } = file;
    return {
      body,
      file: metadata,
    };
  },

  async getGroupItem(groupID, itemKey) {
    return getMemoryItem("group", groupID, itemKey);
  },

  async getUserIDForApiKey(apiKey) {
    return getState().apiKeys.get(apiKey)?.userID ?? null;
  },

  async getStorageQuota(userID) {
    return memoryStorageAccounts.get(userID) ?? getDefaultStorageQuota();
  },

  async getStorageUsageBytes(userID) {
    let total = 0;

    for (const [key, file] of memoryFiles.entries()) {
      const [libraryType, libraryIDString] = key.split(":");
      const libraryID = Number.parseInt(libraryIDString ?? "", 10);

      if (libraryType === "user" && libraryID === userID) {
        total += file.sizeBytes;
      }
      if (
        libraryType === "group" &&
        getState().groups.get(libraryID)?.data.owner === userID
      ) {
        total += file.sizeBytes;
      }
    }

    return total;
  },

  async listGroupUsers(groupID) {
    const group = getState().groups.get(groupID);
    const members = getMemoryGroupMembers(groupID);
    if (group) {
      members.set(group.data.owner, "owner");
    }

    return [...members.entries()].map(([userID, role]) => ({ role, userID }));
  },

  async listItems(userID, itemKeys) {
    return listMemoryItems("user", userID, itemKeys);
  },

  async listGroupItems(groupID, itemKeys) {
    return listMemoryItems("group", groupID, itemKeys);
  },

  async listGroups() {
    return [...getState().groups.values()];
  },

  async listVisibleGroups(userID) {
    return [...getState().groups.values()].filter(
      (group) =>
        group.data.owner === userID ||
        getMemoryGroupMembers(group.id).has(userID) ||
        group.data.type === "PublicOpen" ||
        group.data.type === "PublicClosed"
    );
  },

  async setupTestUsers(userID, userID2, user1Key, user2Key) {
    resetState();
    memoryUploads.clear();
    memoryFiles.clear();
    memoryGroupMembers.clear();
    memoryStorageAccounts.clear();
    getState().apiKeys.set(user1Key, {
      access: {
        groups: { all: { library: true, write: true } },
        user: { files: true, library: true, notes: true, write: true },
      },
      dateAdded: new Date().toISOString(),
      key: user1Key,
      name: "test-user-1",
      userID,
    });
    getState().apiKeys.set(user2Key, {
      access: {
        groups: { all: { library: true, write: true } },
        user: { files: true, library: true, notes: true, write: true },
      },
      dateAdded: new Date().toISOString(),
      key: user2Key,
      name: "test-user-2",
      userID: userID2,
    });
    getLibrary(userID);
    getLibrary(userID2);

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
  },

  async registerAttachmentUpload(userID, itemKey, uploadKey) {
    return registerMemoryAttachmentUpload("user", userID, itemKey, uploadKey);
  },

  async registerGroupAttachmentUpload(groupID, itemKey, uploadKey) {
    return registerMemoryAttachmentUpload("group", groupID, itemKey, uploadKey);
  },

  async removeGroupUser(groupID, userID) {
    const group = getState().groups.get(groupID);
    if (group?.data.owner === userID) {
      return;
    }

    getMemoryGroupMembers(groupID).delete(userID);
    if (group) {
      group.data.version += 1;
    }
  },

  async storeAttachmentUpload(uploadKey, body) {
    const upload = memoryUploads.get(uploadKey);
    if (!upload) {
      return { found: false };
    }

    if (md5Hex(body) !== upload.md5) {
      return {
        found: true,
        hashMismatch: true,
      };
    }
    if (body.byteLength !== upload.sizeBytes) {
      return {
        found: true,
        sizeMismatch: true,
      };
    }

    upload.body = body;
    return { found: true };
  },

  async setStorageQuota(userID, quotaMB, expiration) {
    if (quotaMB === null) {
      memoryStorageAccounts.delete(userID);
      return getDefaultStorageQuota();
    }

    const quota = {
      expiration,
      quotaMB: quotaMB === "unlimited" ? 1_000_000 : quotaMB,
      unlimited: quotaMB === "unlimited",
    };
    memoryStorageAccounts.set(userID, quota);
    return quota;
  },

  async updateGroupUser(groupID, userID, role) {
    const normalizedRole = normalizeGroupRole(role);
    const group = getState().groups.get(groupID);
    const members = getMemoryGroupMembers(groupID);

    if (normalizedRole === "owner") {
      if (group) {
        const previousOwner = group.data.owner;
        group.data.owner = userID;
        if (previousOwner !== userID) {
          members.set(previousOwner, "admin");
        }
      }
    }

    members.set(userID, normalizedRole);
    if (group) {
      group.data.version += 1;
    }
  },

  async updateGroup(groupID, data) {
    const group = getState().groups.get(groupID);
    if (!group) {
      return null;
    }

    group.data = {
      ...group.data,
      ...data,
      id: groupID,
      owner:
        typeof data.owner === "number" && Number.isFinite(data.owner)
          ? data.owner
          : group.data.owner,
      version: group.data.version + 1,
    };
    return group;
  },
};

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

const getMemoryGroupMembers = (groupID: number): Map<number, string> => {
  const existing = memoryGroupMembers.get(groupID);
  if (existing) {
    return existing;
  }

  const members = new Map<number, string>();
  memoryGroupMembers.set(groupID, members);
  return members;
};

const getMemoryGroupAccess = (
  userID: number,
  groupID: number
): GroupAccess => {
  const group = getState().groups.get(groupID);
  if (!group) {
    return {
      canAdmin: false,
      canEdit: false,
      canEditFiles: false,
      canRead: false,
    };
  }

  const role =
    getMemoryGroupMembers(groupID).get(userID) ??
    (group.data.owner === userID ? "owner" : null);
  const isPublic =
    group.data.type === "PublicOpen" || group.data.type === "PublicClosed";
  const canRead =
    Boolean(role) || (isPublic && group.data.libraryReading === "all");
  const canAdmin = role === "owner" || role === "admin";
  const canEdit =
    canAdmin ||
    (role === "member" && group.data.libraryEditing === "members");
  const canEditFiles =
    group.data.fileEditing !== "none" &&
    (canAdmin ||
      (role === "member" && group.data.fileEditing === "members"));

  return {
    canAdmin,
    canEdit,
    canEditFiles,
    canRead,
  };
};

const createMemoryItems = (
  libraryType: "group" | "user",
  libraryID: number,
  objects: Record<string, unknown>[],
  writeToken?: string
): CreateItemsResult => {
  const library = getMemoryLibrary(libraryType, libraryID);

  if (writeToken) {
    const scopedWriteToken = `${libraryType}:${libraryID}:${writeToken}`;

    if (getState().usedWriteTokens.has(scopedWriteToken)) {
      return {
        duplicateWriteToken: true,
        success: [],
        successful: [],
        version: library.version,
      };
    }

    getState().usedWriteTokens.add(scopedWriteToken);
  }

  const success: string[] = [];
  const successful: ItemRecord[] = [];

  for (const object of objects) {
    library.version += 1;
    const key =
      typeof object.key === "string" ? object.key : generateZoteroKey();
    const data = sanitizeZoteroData({
      ...object,
      key,
      version: library.version,
    });
    const item = {
      data,
      key,
      version: library.version,
    };

    library.items.set(key, item);
    success.push(key);
    successful.push(item);
  }

  return {
    duplicateWriteToken: false,
    success,
    successful,
    version: library.version,
  };
};

const listMemoryItems = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKeys?: string[]
): ItemListResult => {
  const library = getMemoryLibrary(libraryType, libraryID);
  const items = itemKeys
    ? itemKeys
        .map((key) => library.items.get(key))
        .filter((item) => item !== undefined)
    : [...library.items.values()];

  return {
    items,
    version: library.version,
  };
};

const getMemoryItem = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKey: string
): ItemListResult | null => {
  const library = getMemoryLibrary(libraryType, libraryID);
  const item = library.items.get(itemKey);

  if (!item) {
    return null;
  }

  return {
    items: [item],
    version: library.version,
  };
};

const registerMemoryAttachmentUpload = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKey: string,
  uploadKey: string
): AttachmentRegistrationResult => {
  const upload = memoryUploads.get(uploadKey);
  const library = getMemoryLibrary(libraryType, libraryID);

  if (
    !(
      upload &&
      upload.libraryType === libraryType &&
      upload.libraryID === libraryID &&
      upload.itemKey === itemKey
    )
  ) {
    return {
      found: false,
      registered: false,
      version: library.version,
    };
  }

  if (!upload.body) {
    return {
      found: true,
      registered: false,
      version: library.version,
    };
  }

  library.version += 1;
  const existing = library.items.get(itemKey);
  if (existing) {
    existing.version = library.version;
    existing.data = sanitizeZoteroData({
      ...existing.data,
      charset: upload.charset,
      contentType: upload.contentType,
      filename: upload.itemFilename ?? upload.filename,
      md5: upload.itemMd5 ?? upload.md5,
      mtime: upload.mtime,
      version: library.version,
    });
  }

  memoryFiles.set(getMemoryFileKey(libraryType, libraryID, itemKey), {
    body: upload.body,
    charset: upload.charset,
    contentType: upload.contentType,
    filename: upload.itemFilename ?? upload.filename,
    itemKey,
    md5: upload.itemMd5 ?? upload.md5,
    mtime: upload.mtime,
    r2Key: upload.r2Key,
    sizeBytes: upload.sizeBytes,
    version: library.version,
  });
  memoryUploads.delete(uploadKey);

  return {
    found: true,
    registered: true,
    version: library.version,
  };
};

class D1CompatibilityStore implements CompatibilityStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket?: R2Bucket
  ) {}

  async addGroupUsers(
    groupID: number,
    users: GroupUserInput[]
  ): Promise<void> {
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
          .prepare("UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?")
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
    writeToken?: string
  ): Promise<CreateItemsResult> {
    await this.ensureGroupLibrary(groupID);
    return this.createItemsForLibrary("group", groupID, objects, writeToken);
  }

  async createItems(
    userID: number,
    objects: Record<string, unknown>[],
    writeToken?: string
  ): Promise<CreateItemsResult> {
    await this.ensureUserLibrary(userID);

    if (writeToken) {
      const duplicate = await this.db
        .prepare(
          "SELECT token FROM write_tokens WHERE library_type = 'user' AND library_id = ? AND token = ?"
        )
        .bind(userID, writeToken)
        .first<{ token: string }>();

      if (duplicate) {
        const version = await this.getLibraryVersion("user", userID);
        return {
          duplicateWriteToken: true,
          success: [],
          successful: [],
          version,
        };
      }
    }

    let version = await this.getLibraryVersion("user", userID);
    const success: string[] = [];
    const successful: ItemRecord[] = [];
    const statements: D1PreparedStatement[] = [];

    if (writeToken) {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO write_tokens (library_type, library_id, token) VALUES ('user', ?, ?)"
          )
          .bind(userID, writeToken)
      );
    }

    for (const object of objects) {
      version += 1;
      const key =
        typeof object.key === "string" ? object.key : generateZoteroKey();
      const data = sanitizeZoteroData({
        ...object,
        key,
        version,
      });
      const itemType =
        typeof data.itemType === "string" ? data.itemType : "book";
      const item = {
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
              data_json
            ) VALUES ('user', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
              version = excluded.version,
              item_type = excluded.item_type,
              parent_item_key = excluded.parent_item_key,
              data_json = excluded.data_json,
              deleted_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
          )
          .bind(
            userID,
            key,
            version,
            itemType,
            typeof data.parentItem === "string" ? data.parentItem : null,
            JSON.stringify(data)
          ),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES ('user', ?, ?, 'upsert', 'item', ?)"
          )
          .bind(userID, version, key)
      );

      success.push(key);
      successful.push(item);
    }

    statements.push(
      this.db
        .prepare(
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = 'user' AND library_id = ?"
        )
        .bind(version, userID)
    );

    await this.db.batch(statements);

    return {
      duplicateWriteToken: false,
      success,
      successful,
      version,
    };
  }

  async deleteGroupItems(
    groupID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{ deleted: string[]; preconditionFailed: boolean; version: number }> {
    await this.ensureGroupLibrary(groupID);
    return this.deleteItemsForLibrary("group", groupID, itemKeys, ifUnmodifiedSinceVersion);
  }

  async deleteItems(
    userID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{ deleted: string[]; preconditionFailed: boolean; version: number }> {
    await this.ensureUserLibrary(userID);
    return this.deleteItemsForLibrary("user", userID, itemKeys, ifUnmodifiedSinceVersion);
  }

  async deleteGroup(groupID: number): Promise<void> {
    await this.db
      .prepare("DELETE FROM groups WHERE group_id = ?")
      .bind(groupID)
      .run();
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
    const role =
      row.role ?? (row.owner_user_id === userID ? "owner" : null);
    const isPublic = row.type === "PublicOpen" || row.type === "PublicClosed";
    const canRead = Boolean(role) || (isPublic && data.libraryReading === "all");
    const canAdmin = role === "owner" || role === "admin";
    const canEdit =
      canAdmin ||
      (role === "member" && data.libraryEditing === "members");
    const canEditFiles =
      data.fileEditing !== "none" &&
      (canAdmin ||
        (role === "member" && data.fileEditing === "members"));

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
    const row = await this.db
      .prepare(
        `SELECT item_key, r2_key, filename, content_type, charset, size_bytes, md5, mtime
         FROM attachment_files
         WHERE library_type = 'user'
           AND library_id = ?
           AND item_key = ?`
      )
      .bind(userID, itemKey)
      .first<D1AttachmentFileRow>();

    return row ? parseAttachmentFileRow(row) : null;
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
      quotaMB: row.unlimited ? 1_000_000 : row.quota_mb ?? defaultStorageQuotaMB,
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

  async listItems(userID: number, itemKeys?: string[]): Promise<ItemListResult> {
    await this.ensureUserLibrary(userID);

    const version = await this.getLibraryVersion("user", userID);
    const rows = itemKeys?.length
      ? await this.db
          .prepare(
            `SELECT item_key, version, data_json
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
            `SELECT item_key, version, data_json
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
      this.db
        .prepare("INSERT INTO users (user_id) VALUES (?)")
        .bind(userID),
      this.db
        .prepare("INSERT INTO users (user_id) VALUES (?)")
        .bind(userID2),
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
    const upload = await this.db
      .prepare(
        `SELECT upload_key, item_key, r2_key, filename, item_filename, content_type, charset, size_bytes, md5, item_md5, mtime, upload_state
         FROM attachment_uploads
         WHERE upload_key = ?
           AND library_type = 'user'
           AND library_id = ?
           AND item_key = ?`
      )
      .bind(uploadKey, userID, itemKey)
      .first<D1AttachmentUploadRow>();

    if (!upload) {
      return {
        found: false,
        registered: false,
        version: await this.getLibraryVersion("user", userID),
      };
    }

    if (upload.upload_state !== "uploaded") {
      return {
        found: true,
        registered: false,
        version: await this.getLibraryVersion("user", userID),
      };
    }

    let version = await this.getLibraryVersion("user", userID);
    version += 1;

    const itemRow = await this.db
      .prepare(
        `SELECT data_json
         FROM items
         WHERE library_type = 'user'
           AND library_id = ?
           AND item_key = ?
           AND deleted_at IS NULL`
      )
      .bind(userID, itemKey)
      .first<{ data_json: string }>();
    const data = sanitizeZoteroData({
      ...(itemRow ? JSON.parse(itemRow.data_json) : {}),
      charset: upload.charset,
      contentType: upload.content_type,
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
            upload_state
          ) VALUES ('user', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')
          ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
            r2_key = excluded.r2_key,
            filename = excluded.filename,
            content_type = excluded.content_type,
            charset = excluded.charset,
            size_bytes = excluded.size_bytes,
            md5 = excluded.md5,
            mtime = excluded.mtime,
            upload_state = 'complete',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        )
        .bind(
          userID,
          itemKey,
          upload.r2_key,
          upload.item_filename ?? upload.filename,
          upload.content_type,
          upload.charset,
          upload.size_bytes,
          upload.item_md5 ?? upload.md5,
          upload.mtime
        ),
      this.db
        .prepare(
          `UPDATE items
           SET version = ?,
             data_json = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE library_type = 'user'
             AND library_id = ?
             AND item_key = ?`
        )
        .bind(version, JSON.stringify(data), userID, itemKey),
      this.db
        .prepare(
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = 'user' AND library_id = ?"
        )
        .bind(version, userID),
      this.db
        .prepare(
          "UPDATE attachment_uploads SET upload_state = 'registered', registered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upload_key = ?"
        )
        .bind(uploadKey),
      this.db
        .prepare(
          "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES ('user', ?, ?, 'file', 'item', ?)"
        )
        .bind(userID, version, itemKey),
    ]);

    return {
      found: true,
      registered: true,
      version,
    };
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
      .prepare("UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?")
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

    if (md5Hex(body) !== upload.md5) {
      return {
        found: true,
        hashMismatch: true,
      };
    }
    if (body.byteLength !== upload.size_bytes) {
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
        "UPDATE attachment_uploads SET upload_state = 'uploaded', uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upload_key = ?"
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
          .prepare("UPDATE groups SET owner_user_id = ?, library_version = library_version + 1 WHERE group_id = ?")
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
        .prepare("UPDATE groups SET library_version = library_version + 1 WHERE group_id = ?")
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
        .prepare(
          "DELETE FROM items WHERE library_type = ? AND library_id = ?"
        )
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
          "UPDATE libraries SET version = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
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

  private async deleteItemsForLibrary(
    libraryType: "group" | "user",
    libraryID: number,
    itemKeys: string[],
    ifUnmodifiedSinceVersion: number | null = null
  ): Promise<{ deleted: string[]; preconditionFailed: boolean; version: number }> {
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

    if (itemKeys.length === 0) {
      return {
        deleted: [],
        preconditionFailed: false,
        version,
      };
    }

    const rows = await this.db
      .prepare(
        `SELECT item_key
         FROM items
         WHERE library_type = ?
           AND library_id = ?
           AND deleted_at IS NULL
           AND item_key IN (${itemKeys.map(() => "?").join(",")})`
      )
      .bind(libraryType, libraryID, ...itemKeys)
      .all<{ item_key: string }>();
    const existingKeys = rows.results.map((row) => row.item_key);

    if (existingKeys.length === 0) {
      return {
        deleted: [],
        preconditionFailed: false,
        version,
      };
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
    writeToken?: string
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

    for (const object of objects) {
      version += 1;
      const key =
        typeof object.key === "string" ? object.key : generateZoteroKey();
      const data = sanitizeZoteroData({
        ...object,
        key,
        version,
      });
      const itemType =
        typeof data.itemType === "string" ? data.itemType : "book";
      const item = {
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
              data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
              version = excluded.version,
              item_type = excluded.item_type,
              parent_item_key = excluded.parent_item_key,
              data_json = excluded.data_json,
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
            JSON.stringify(data)
          ),
        this.db
          .prepare(
            "INSERT INTO sync_log (library_type, library_id, version, operation, object_type, object_key) VALUES (?, ?, ?, 'upsert', 'item', ?)"
          )
          .bind(libraryType, libraryID, version, key)
      );

      success.push(key);
      successful.push(item);
    }

    statements.push(
      this.db
        .prepare(
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
        )
        .bind(version, libraryType, libraryID)
    );

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
            `SELECT item_key, version, data_json
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
            `SELECT item_key, version, data_json
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
        `SELECT item_key, r2_key, filename, content_type, charset, size_bytes, md5, mtime
         FROM attachment_files
         WHERE library_type = ?
           AND library_id = ?
           AND item_key = ?`
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
        `SELECT upload_key, item_key, r2_key, filename, item_filename, content_type, charset, size_bytes, md5, item_md5, mtime, upload_state
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

    if (upload.upload_state !== "uploaded") {
      return {
        found: true,
        registered: false,
        version: await this.getLibraryVersion(libraryType, libraryID),
      };
    }

    let version = await this.getLibraryVersion(libraryType, libraryID);
    version += 1;

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
    const data = sanitizeZoteroData({
      ...(itemRow ? JSON.parse(itemRow.data_json) : {}),
      charset: upload.charset,
      contentType: upload.content_type,
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
            upload_state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')
          ON CONFLICT(library_type, library_id, item_key) DO UPDATE SET
            r2_key = excluded.r2_key,
            filename = excluded.filename,
            content_type = excluded.content_type,
            charset = excluded.charset,
            size_bytes = excluded.size_bytes,
            md5 = excluded.md5,
            mtime = excluded.mtime,
            upload_state = 'complete',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
        )
        .bind(
          libraryType,
          libraryID,
          itemKey,
          upload.r2_key,
          upload.item_filename ?? upload.filename,
          upload.content_type,
          upload.charset,
          upload.size_bytes,
          upload.item_md5 ?? upload.md5,
          upload.mtime
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
          "UPDATE libraries SET version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE library_type = ? AND library_id = ?"
        )
        .bind(version, libraryType, libraryID),
      this.db
        .prepare(
          "UPDATE attachment_uploads SET upload_state = 'registered', registered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE upload_key = ?"
        )
        .bind(uploadKey),
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
  data_json: string;
  item_key: string;
  version: number;
}

interface D1AttachmentFileRow {
  charset: string | null;
  content_type: string | null;
  filename: string;
  item_key: string;
  md5: string;
  mtime: number;
  r2_key: string;
  size_bytes: number;
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
  data: JSON.parse(row.data_json) as Record<string, unknown>,
  key: row.item_key,
  version: row.version,
});

const parseAttachmentFileRow = (
  row: D1AttachmentFileRow
): AttachmentFileRecord => ({
  charset: row.charset,
  contentType: row.content_type,
  filename: row.filename,
  itemKey: row.item_key,
  md5: row.md5,
  mtime: row.mtime,
  r2Key: row.r2_key,
  sizeBytes: row.size_bytes,
});
