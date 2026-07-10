import { md5Hex } from "../lib/md5";
import type { D1LibraryVersions, LibraryType } from "./library-versions";
import { sanitizeZoteroData } from "./zotero";

export interface StorageQuota {
  expiration: number;
  quotaMB: number;
  unlimited: boolean;
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

export interface AttachmentUploadInput {
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

export interface AttachmentUploadAuthorization {
  contentType: string;
  prefix: string;
  r2Key: string;
  sizeBytes: number;
  suffix: string;
  uploadKey: string;
  url: string;
}

export interface DirectAttachmentUpload {
  contentType: string;
  found: boolean;
  multipartUploadId?: string;
  r2Key: string;
  sizeBytes: number;
  strategy: "multipart" | "single";
}

export interface AttachmentUploadScope {
  itemKey: string;
  libraryID: number;
  libraryType: LibraryType;
}

export interface DirectAttachmentCompletion {
  actualSize?: number;
  found: boolean;
  invalidParts?: boolean;
  sizeMismatch?: boolean;
}

export interface AttachmentUploadStoreResult {
  found: boolean;
  hashMismatch?: boolean;
  sizeMismatch?: boolean;
}

export interface AttachmentRegistrationResult {
  found: boolean;
  registered: boolean;
  version: number;
}

export interface AttachmentExistingFileResult {
  associated: boolean;
  sizeMismatch?: boolean;
  version: number;
}

export interface AttachmentObjectResult {
  body: ArrayBuffer | ReadableStream;
  file: AttachmentFileRecord;
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

const defaultStorageQuotaMB = 300;
export const directSinglePutThresholdBytes = 64 * 1024 * 1024;
const directMultipartBasePartBytes = 16 * 1024 * 1024;
const r2MaximumMultipartParts = 10_000;

export const directMultipartPartSize = (sizeBytes: number): number => {
  const minimumForPartLimit = Math.ceil(sizeBytes / r2MaximumMultipartParts);
  const mebibyte = 1024 * 1024;
  const roundedForPartLimit =
    Math.ceil(minimumForPartLimit / mebibyte) * mebibyte;
  return Math.max(directMultipartBasePartBytes, roundedForPartLimit);
};

const getNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const getDefaultStorageQuota = (): StorageQuota => ({
  expiration: 0,
  quotaMB: defaultStorageQuotaMB,
  unlimited: false,
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

export class D1AttachmentStorage {
  constructor(
    private readonly db: D1Database,
    private readonly libraryVersions: D1LibraryVersions,
    private readonly bucket?: R2Bucket
  ) {}

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
      r2Key,
      sizeBytes: input.sizeBytes,
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

  async prepareDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope
  ): Promise<DirectAttachmentUpload | null> {
    const upload = await this.db
      .prepare(
        `SELECT r2_key, content_type, size_bytes, upload_strategy,
                multipart_upload_id
         FROM attachment_uploads
         WHERE upload_key = ? AND upload_state = 'queued'
           AND library_type = ? AND library_id = ? AND item_key = ?`
      )
      .bind(uploadKey, scope.libraryType, scope.libraryID, scope.itemKey)
      .first<{
        content_type: string | null;
        multipart_upload_id: string | null;
        r2_key: string;
        size_bytes: number;
        upload_strategy: string;
      }>();
    if (!(upload && this.bucket)) {
      return null;
    }

    const strategy =
      upload.size_bytes <= directSinglePutThresholdBytes
        ? "single"
        : "multipart";
    let multipartUploadId = upload.multipart_upload_id;
    if (strategy === "multipart" && !multipartUploadId) {
      const multipart = await this.bucket.createMultipartUpload(upload.r2_key, {
        httpMetadata: {
          contentType: upload.content_type ?? "application/octet-stream",
        },
      });
      multipartUploadId = multipart.uploadId;
    }
    await this.db
      .prepare(
        `UPDATE attachment_uploads
         SET upload_strategy = ?, multipart_upload_id = ?
         WHERE upload_key = ? AND upload_state = 'queued'`
      )
      .bind(strategy, multipartUploadId, uploadKey)
      .run();

    return {
      contentType: upload.content_type ?? "application/octet-stream",
      found: true,
      ...(multipartUploadId ? { multipartUploadId } : {}),
      r2Key: upload.r2_key,
      sizeBytes: upload.size_bytes,
      strategy,
    };
  }

  async completeDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope,
    parts: R2UploadedPart[]
  ): Promise<DirectAttachmentCompletion> {
    const upload = await this.db
      .prepare(
        `SELECT r2_key, size_bytes, upload_strategy, multipart_upload_id
         FROM attachment_uploads
         WHERE upload_key = ? AND upload_state = 'queued'
           AND library_type = ? AND library_id = ? AND item_key = ?`
      )
      .bind(uploadKey, scope.libraryType, scope.libraryID, scope.itemKey)
      .first<{
        multipart_upload_id: string | null;
        r2_key: string;
        size_bytes: number;
        upload_strategy: string;
      }>();
    if (!(upload && this.bucket)) {
      return { found: false };
    }

    let object: R2Object | null;
    if (upload.upload_strategy === "single") {
      object = await this.bucket.head(upload.r2_key);
    } else if (
      upload.upload_strategy === "multipart" &&
      upload.multipart_upload_id
    ) {
      const expectedPartCount = Math.ceil(
        upload.size_bytes / directMultipartPartSize(upload.size_bytes)
      );
      const normalizedParts = [...parts]
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({
          etag: part.etag.replace(/^"|"$/gu, ""),
          partNumber: part.partNumber,
        }));
      if (
        normalizedParts.length !== expectedPartCount ||
        !normalizedParts.every(
          (part, index) => part.partNumber === index + 1 && part.etag.length > 0
        )
      ) {
        return { found: true, invalidParts: true };
      }
      object = await this.bucket
        .resumeMultipartUpload(upload.r2_key, upload.multipart_upload_id)
        .complete(normalizedParts);
    } else {
      return { found: true, invalidParts: true };
    }

    if (!object) {
      return { found: true };
    }
    if (object.size !== upload.size_bytes) {
      await this.bucket.delete(upload.r2_key);
      return {
        actualSize: object.size,
        found: true,
        sizeMismatch: true,
      };
    }
    await this.db
      .prepare(
        `UPDATE attachment_uploads
         SET upload_state = 'uploaded',
             uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE upload_key = ?`
      )
      .bind(uploadKey)
      .run();
    return { actualSize: object.size, found: true };
  }

  async abortDirectAttachmentUpload(
    uploadKey: string,
    scope: AttachmentUploadScope
  ): Promise<boolean> {
    const upload = await this.db
      .prepare(
        `SELECT r2_key, multipart_upload_id
         FROM attachment_uploads
         WHERE upload_key = ? AND upload_state = 'queued'
           AND library_type = ? AND library_id = ? AND item_key = ?`
      )
      .bind(uploadKey, scope.libraryType, scope.libraryID, scope.itemKey)
      .first<{ multipart_upload_id: string | null; r2_key: string }>();
    if (!(upload && this.bucket)) {
      return false;
    }
    if (upload.multipart_upload_id) {
      await this.bucket
        .resumeMultipartUpload(upload.r2_key, upload.multipart_upload_id)
        .abort();
    }
    await this.db
      .prepare(
        `DELETE FROM attachment_uploads
         WHERE upload_key = ? AND library_type = ? AND library_id = ?
           AND item_key = ?`
      )
      .bind(uploadKey, scope.libraryType, scope.libraryID, scope.itemKey)
      .run();
    return true;
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
    return this.libraryVersions.get(libraryType, libraryID);
  }

  private async reserveLibraryVersions(
    libraryType: "group" | "user",
    libraryID: number,
    count: number,
    expectedVersion: number | null
  ): Promise<number | null> {
    return this.libraryVersions.reserve(
      libraryType,
      libraryID,
      count,
      expectedVersion
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
      r2Key,
      sizeBytes: input.sizeBytes,
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
