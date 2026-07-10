import type { Bindings } from "../../../bindings";
import { getRequestApiKey } from "../../../domain/auth";
import {
  type AttachmentFileRecord,
  type AttachmentUploadScope,
  type CompatibilityStore,
  createCompatibilityStore,
  directMultipartPartSize,
} from "../../../domain/storage";
import {
  applyZoteroPatch,
  PatchAlgorithmUnavailableError,
} from "../../../lib/patch";
import { hasR2SigningConfig, signR2PutUrl } from "../../../lib/r2-signing";
import { compatibility } from "../router";
import {
  attachItemMeta,
  checkStorageQuota,
  createSignedRawFileURL,
  escapeXML,
  formatAttachmentContentType,
  getGroupRawFileURL,
  getGroupUploadBaseURL,
  getPublicationFileViewURL,
  getPublicationItem,
  getPublicationRawFileURL,
  getRawFileURL,
  getUploadBaseURL,
  isValidMd5,
  parseFileParams,
  parseNumericID,
  parseUploadBody,
  requireGroup,
  requireGroupFileEdit,
  requireSignedRawFileURL,
  requireUser,
  requireUserWrite,
  responseBodyToArrayBuffer,
  shapeItemForSchemaRequest,
  supportedPartialUploadAlgorithms,
} from "../support";

type AttachmentUploadInput = Parameters<
  CompatibilityStore["authorizeAttachmentUpload"]
>[2];

const storedFileLinkModes = new Set([
  "embedded_image",
  "imported_file",
  "imported_url",
]);

const getSingleItemData = (
  result: Awaited<ReturnType<CompatibilityStore["getItem"]>>
) => result?.items[0]?.data ?? null;

const isStoredFileAttachmentData = (
  data: Record<string, unknown> | null
): boolean =>
  data?.itemType === "attachment" &&
  typeof data.linkMode === "string" &&
  storedFileLinkModes.has(data.linkMode);

const buildAttachmentUploadInput = (
  params: URLSearchParams,
  md5: string,
  filename: string,
  sizeBytes: number,
  mtime: string,
  zipMd5: string | null,
  zipFilename: string | null
): AttachmentUploadInput => ({
  charset: params.get("charset"),
  contentType: params.get("contentType"),
  filename: zipFilename ?? filename,
  itemFilename: zipFilename ? filename : null,
  itemMd5: zipMd5 ? md5 : null,
  md5: zipMd5 ?? md5,
  mtime: Number.parseInt(mtime, 10),
  sizeBytes,
  zip: params.get("zip") === "1" || Boolean(zipMd5),
});

const createDirectTransfer = async (
  env: Bindings,
  store: CompatibilityStore,
  uploadKey: string,
  scope: AttachmentUploadScope
) => {
  const upload = await store.prepareDirectAttachmentUpload(uploadKey, scope);
  if (!upload) {
    throw new Error("Direct attachment upload could not be prepared");
  }
  if (upload.strategy === "single") {
    const signed = await signR2PutUrl(env, upload.r2Key, {
      contentType: upload.contentType,
    });
    return {
      headers: signed.headers,
      kind: "single" as const,
      url: signed.url,
    };
  }
  if (!upload.multipartUploadId) {
    throw new Error("Direct multipart upload did not include an upload ID");
  }
  const partSizeBytes = directMultipartPartSize(upload.sizeBytes);
  const partCount = Math.ceil(upload.sizeBytes / partSizeBytes);
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1;
      const signed = await signR2PutUrl(env, upload.r2Key, {
        partNumber,
        uploadId: upload.multipartUploadId,
      });
      return {
        headers: signed.headers,
        partNumber,
        url: signed.url,
      };
    })
  );
  return {
    kind: "multipart" as const,
    partSizeBytes,
    parts,
  };
};

const parseDirectUploadParts = async (
  request: Request
): Promise<{ etag: string; partNumber: number }[] | null> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!(isRecord(body) && Array.isArray(body.parts))) {
    return null;
  }
  const parts: { etag: string; partNumber: number }[] = [];
  for (const part of body.parts) {
    if (
      !isRecord(part) ||
      typeof part.etag !== "string" ||
      !part.etag.trim() ||
      typeof part.partNumber !== "number" ||
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 1
    ) {
      return null;
    }
    parts.push({ etag: part.etag, partNumber: part.partNumber });
  }
  return parts;
};

const completeDirectUpload = async (
  request: Request,
  store: CompatibilityStore,
  uploadKey: string,
  scope: AttachmentUploadScope
): Promise<Response> => {
  const parts = await parseDirectUploadParts(request);
  if (!parts) {
    return new Response("Invalid direct upload completion body", {
      status: 400,
    });
  }
  const result = await store.completeDirectAttachmentUpload(
    uploadKey,
    scope,
    parts
  );
  if (!result.found) {
    return new Response("Upload key not found", { status: 404 });
  }
  if (result.invalidParts) {
    return new Response("Invalid multipart upload parts", { status: 400 });
  }
  if (result.sizeMismatch) {
    return new Response(
      `Uploaded object size ${result.actualSize ?? "unknown"} does not match authorization`,
      { status: 409 }
    );
  }
  return new Response(null, { status: 204 });
};

const rawAttachmentContentType = (file: AttachmentFileRecord): string =>
  file.zip ? "application/zip" : formatAttachmentContentType(file);

const attachmentDownloadHeaders = (file: AttachmentFileRecord) => ({
  "Zotero-File-Compressed": file.zip ? "Yes" : "No",
  "Zotero-File-MD5": file.md5,
  "Zotero-File-Modification-Time": `${file.mtime}`,
  "Zotero-File-Size": `${file.sizeBytes}`,
});

const redirectToAttachment = (url: string, file: AttachmentFileRecord) =>
  new Response(null, {
    headers: {
      Location: url,
      ...attachmentDownloadHeaders(file),
    },
    status: 302,
  });

const getAttachmentRawFileURL = (
  c: Parameters<typeof getRawFileURL>[0],
  scope: "g" | "p" | "u",
  id: number,
  itemKey: string,
  file: AttachmentFileRecord
): Promise<string> => {
  if (
    file.storageMd5 &&
    file.storageFilename &&
    (file.legacyStorage || file.r2Key.startsWith("files/"))
  ) {
    return createSignedRawFileURL(
      c,
      `/${file.storageMd5}/${encodeURIComponent(file.storageFilename)}`
    );
  }

  if (scope === "g") {
    return getGroupRawFileURL(c, id, itemKey, file.md5, file.filename);
  }
  if (scope === "p") {
    return getPublicationRawFileURL(c, id, itemKey, file.md5, file.filename);
  }
  return getRawFileURL(c, id, itemKey, file.md5, file.filename);
};

const rejectNonStoredAttachment = (
  data: Record<string, unknown> | null
): Response | null => {
  if (data?.itemType !== "attachment") {
    return new Response("Item is not an attachment", { status: 400 });
  }
  if (!isStoredFileAttachmentData(data)) {
    return new Response(
      "Cannot upload file for linked file/URL attachment item",
      {
        status: 400,
      }
    );
  }

  return null;
};

interface PublicationItemRecord {
  data: Record<string, unknown>;
  key: string;
  version: number;
}

const publicationRestrictedDataFields = ["collections", "relations", "tags"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVisiblePublicationItem = (item: {
  data?: Record<string, unknown>;
  key: string;
  version?: number;
}): item is PublicationItemRecord =>
  item.data?.inPublications === true && !item.data.deleted;

const sanitizePublicationData = (data: Record<string, unknown>) => {
  const sanitized = { ...data };
  for (const field of publicationRestrictedDataFields) {
    delete sanitized[field];
  }
  return sanitized;
};

const publicationItemPath = (userID: number, itemKey: string) =>
  `/users/${userID}/publications/items/${itemKey}`;

const getVisiblePublicationItems = async (
  store: CompatibilityStore,
  userID: number
) => {
  const result = await store.listItems(userID);
  return {
    items: result.items.filter(isVisiblePublicationItem),
    version: result.version,
  };
};

const attachPublicationItem = async (
  c: Parameters<typeof getRawFileURL>[0],
  store: CompatibilityStore,
  userID: number,
  item: PublicationItemRecord,
  publicationItems: PublicationItemRecord[]
) => {
  const origin = new URL(c.req.url).origin;
  const publicItem = shapeItemForSchemaRequest(c, {
    ...item,
    data: sanitizePublicationData(item.data),
  });
  const envelope = await attachItemMeta(c, publicItem, {
    allItems: publicationItems.map((candidate) => ({
      ...candidate,
      data: sanitizePublicationData(candidate.data),
    })),
    libraryID: userID,
    libraryType: "user",
    store,
  });
  const links = isRecord(envelope.links) ? { ...envelope.links } : {};
  links.self = {
    href: `${origin}${publicationItemPath(userID, item.key)}`,
    type: "application/json",
  };
  links.alternate = {
    href: `${origin}${publicationItemPath(userID, item.key)}`,
    type: "text/html",
  };

  const file = await store.getAttachmentFile(userID, item.key);
  if (file) {
    links.enclosure = {
      href: getPublicationFileViewURL(c, userID, item.key),
      type:
        file.contentType ?? item.data.contentType ?? "application/octet-stream",
    };
  }

  return {
    ...envelope,
    links,
  };
};

const renderPublicationItemAtomEntry = async (
  c: Parameters<typeof getRawFileURL>[0],
  store: CompatibilityStore,
  userID: number,
  item: PublicationItemRecord
) => {
  const origin = new URL(c.req.url).origin;
  const title = String(item.data.title || item.key);
  const file = await store.getAttachmentFile(userID, item.key);
  return [
    '<entry xmlns="http://www.w3.org/2005/Atom">',
    `<id>http://zotero.org/users/${userID}/items/${item.key}</id>`,
    `<title>${escapeXML(title)}</title>`,
    `<link rel="self" href="${escapeXML(
      `${origin}${publicationItemPath(userID, item.key)}?format=atom`
    )}"/>`,
    `<link rel="alternate" href="${escapeXML(
      `${origin}${publicationItemPath(userID, item.key)}`
    )}"/>`,
    file
      ? `<link rel="enclosure" href="${escapeXML(
          getPublicationFileViewURL(c, userID, item.key)
        )}"/>`
      : "",
    "</entry>",
  ].join("");
};

const renderPublicationItemsAtomFeed = async (
  c: Parameters<typeof getRawFileURL>[0],
  store: CompatibilityStore,
  userID: number,
  items: PublicationItemRecord[]
) => {
  const origin = new URL(c.req.url).origin;
  const self = `${origin}/users/${userID}/publications/items?format=atom`;
  const entries = await Promise.all(
    items.map((item) => renderPublicationItemAtomEntry(c, store, userID, item))
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `<id>http://zotero.org/users/${userID}/publications/items</id>`,
    `<link rel="self" href="${escapeXML(self)}"/>`,
    `<link rel="first" href="${escapeXML(self)}"/>`,
    ...entries,
    "</feed>",
  ].join("");
};

compatibility.post(
  "/groups/:groupID/items/:itemKey/file/upload/:uploadKey",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const body = await parseUploadBody(c.req.raw);
    const result = await createCompatibilityStore(c.env).storeAttachmentUpload(
      c.req.param("uploadKey"),
      body,
      c.req.header("Content-Type")
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (result.hashMismatch) {
      return c.text(
        "The Content-MD5 you specified did not match what we received",
        400
      );
    }
    if (result.sizeMismatch) {
      return c.text(
        "Your proposed upload exceeds the maximum allowed size",
        400
      );
    }

    return c.body(null, 201);
  }
);

compatibility.post(
  "/groups/:groupID/items/:itemKey/file/direct/:uploadKey/complete",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }
    const store = createCompatibilityStore(c.env);
    if (!(await requireGroupFileEdit(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }
    return completeDirectUpload(c.req.raw, store, c.req.param("uploadKey"), {
      itemKey: c.req.param("itemKey"),
      libraryID: groupID,
      libraryType: "group",
    });
  }
);

compatibility.delete(
  "/groups/:groupID/items/:itemKey/file/direct/:uploadKey",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }
    const store = createCompatibilityStore(c.env);
    if (!(await requireGroupFileEdit(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }
    return (await store.abortDirectAttachmentUpload(c.req.param("uploadKey"), {
      itemKey: c.req.param("itemKey"),
      libraryID: groupID,
      libraryType: "group",
    }))
      ? c.body(null, 204)
      : c.text("Upload key not found", 404);
  }
);

compatibility.get(
  "/groups/:groupID/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const result = await createCompatibilityStore(
      c.env
    ).getGroupAttachmentObject(groupID, c.req.param("itemKey"));

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": rawAttachmentContentType(result.file),
    });
  }
);

compatibility.get(
  "/groups/:groupID/items/:itemKey/file/view/url",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroup(c, store, groupID))) {
      return c.text("File not found", 404);
    }

    const file = await store.getGroupAttachmentFile(
      groupID,
      c.req.param("itemKey")
    );
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.text(
      await getAttachmentRawFileURL(
        c,
        "g",
        groupID,
        c.req.param("itemKey"),
        file
      )
    );
  }
);

compatibility.get("/groups/:groupID/items/:itemKey/file/view", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("File not found", 404);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getAttachmentRawFileURL(
      c,
      "g",
      groupID,
      c.req.param("itemKey"),
      file
    ),
    302
  );
});

compatibility.patch("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("File not found", 404);
  }

  const itemKey = c.req.param("itemKey");
  const itemResult = await store.getGroupItem(groupID, itemKey);
  if (!itemResult) {
    return c.text("Item not found", 404);
  }
  const nonStoredAttachmentResponse = rejectNonStoredAttachment(
    getSingleItemData(itemResult)
  );
  if (nonStoredAttachmentResponse) {
    return nonStoredAttachmentResponse;
  }

  const uploadKey = c.req.query("upload");
  if (!uploadKey) {
    return c.text("Upload key not provided", 400);
  }

  const algorithm = c.req.query("algorithm");
  if (!algorithm) {
    return c.text("Algorithm not specified", 400);
  }
  if (!supportedPartialUploadAlgorithms.has(algorithm)) {
    return c.text(`Invalid algorithm '${algorithm}'`, 400);
  }

  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  if (!ifMatch) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }
  if (!isValidMd5(ifMatch)) {
    return c.text("Invalid ETag in If-Match header", 400);
  }

  const existingFile = await store.getGroupAttachmentFile(groupID, itemKey);
  if (!existingFile) {
    return c.text("If-Match set but file does not exist", 412);
  }
  if (existingFile.md5 !== ifMatch) {
    return c.text("ETag does not match current version of file", 412);
  }

  const original = await store.getGroupAttachmentObject(groupID, itemKey);
  if (!original) {
    return c.text("File not found", 404);
  }

  let patched: ArrayBuffer;
  try {
    patched = await applyZoteroPatch(
      algorithm,
      await responseBodyToArrayBuffer(original.body),
      await c.req.raw.arrayBuffer()
    );
  } catch (error) {
    if (error instanceof PatchAlgorithmUnavailableError) {
      return c.text(
        "Partial upload patch engine is not available in the Worker runtime yet",
        501
      );
    }

    return c.text("Error applying patch", 400);
  }

  const uploadResult = await store.storeAttachmentUpload(uploadKey, patched);
  if (!uploadResult.found) {
    return c.text("Upload key not found", 400);
  }
  if (uploadResult.hashMismatch) {
    return c.text("Patched file does not match hash", 409);
  }
  if (uploadResult.sizeMismatch) {
    return c.text("Patched file size does not match", 409);
  }

  const result = await store.registerGroupAttachmentUpload(
    groupID,
    itemKey,
    uploadKey
  );
  if (!result.registered) {
    return c.text("Upload key not found", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
    "Zotero-Library-Version": `${result.version}`,
  });
});

compatibility.get("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("File not found", 404);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return redirectToAttachment(
    await getAttachmentRawFileURL(
      c,
      "g",
      groupID,
      c.req.param("itemKey"),
      file
    ),
    file
  );
});

compatibility.post("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupFileEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  const itemResult = await store.getGroupItem(groupID, itemKey);
  if (!itemResult) {
    return c.text("Item not found", 404);
  }
  const nonStoredAttachmentResponse = rejectNonStoredAttachment(
    getSingleItemData(itemResult)
  );
  if (nonStoredAttachmentResponse) {
    return nonStoredAttachmentResponse;
  }

  const params = await parseFileParams(c);
  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  const ifNoneMatch = c.req.header("If-None-Match");

  if (!(ifMatch || ifNoneMatch)) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }

  const existingFile = await store.getGroupAttachmentFile(groupID, itemKey);

  if (ifMatch) {
    if (!isValidMd5(ifMatch)) {
      return c.text("Invalid ETag in If-Match header", 400);
    }
    if (!existingFile) {
      return c.text("If-Match set but file does not exist", 412);
    }
    if (existingFile.md5 !== ifMatch) {
      return c.text("ETag does not match current version of file", 412);
    }
  } else if (ifNoneMatch !== "*") {
    return c.text("Invalid value for If-None-Match header", 400);
  } else if (existingFile) {
    return c.text("If-None-Match: * set but file exists", 412);
  }

  const uploadKey = params.get("upload");
  if (uploadKey !== null) {
    if (!uploadKey) {
      return c.text("Upload key not provided", 400);
    }

    const result = await store.registerGroupAttachmentUpload(
      groupID,
      itemKey,
      uploadKey
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (!result.registered) {
      return c.text("Remote file not found", 400);
    }

    return c.body(null, 204, {
      "Last-Modified-Version": `${result.version}`,
      "Zotero-Library-Version": `${result.version}`,
    });
  }

  const md5 = params.get("md5") ?? "";
  const filename = params.get("filename") ?? "";
  const filesize = params.get("filesize") ?? "";
  const mtime = params.get("mtime") ?? "";

  if (!md5) {
    return c.text("MD5 hash not provided", 400);
  }
  if (!isValidMd5(md5)) {
    return c.text("Invalid MD5 hash", 400);
  }
  const zipMd5 = params.get("zipMD5");
  const zipFilename = params.get("zipFilename");
  if (zipMd5 && !isValidMd5(zipMd5)) {
    return c.text("Invalid ZIP MD5 hash", 400);
  }
  if (zipMd5 && !zipFilename) {
    return c.text("ZIP filename not provided", 400);
  }
  if (zipFilename && !zipMd5) {
    return c.text("ZIP MD5 hash not provided", 400);
  }
  if (!filename) {
    return c.text("Filename not provided", 400);
  }
  if (!mtime) {
    return c.text("File modification time not provided", 400);
  }
  if (!filesize) {
    return c.text("File size not provided", 400);
  }

  const sizeBytes = Number.parseInt(filesize, 10);
  if (!Number.isFinite(sizeBytes)) {
    return c.text("Invalid file size", 400);
  }

  const uploadInput = buildAttachmentUploadInput(
    params,
    md5,
    filename,
    sizeBytes,
    mtime,
    zipMd5,
    zipFilename
  );

  const quotaUserID = await store.getGroupOwnerUserID(groupID);
  if (quotaUserID === null) {
    return c.text("Group not found", 404);
  }
  const quotaError = await checkStorageQuota(c, store, quotaUserID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const existingAssociation = await store.associateExistingGroupAttachmentFile(
    groupID,
    itemKey,
    uploadInput
  );
  if (existingAssociation.sizeMismatch) {
    return c.text("Specified file size incorrect for known file", 400);
  }
  if (existingAssociation.associated) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingAssociation.version}`,
      "Zotero-Library-Version": `${existingAssociation.version}`,
    });
  }

  const authorization = await store.authorizeGroupAttachmentUpload(
    groupID,
    itemKey,
    uploadInput,
    getGroupUploadBaseURL(c, groupID, itemKey)
  );

  if (params.get("direct") === "1") {
    if (!hasR2SigningConfig(c.env)) {
      await store.abortDirectAttachmentUpload(authorization.uploadKey, {
        itemKey,
        libraryID: groupID,
        libraryType: "group",
      });
      return c.text("Direct R2 uploads are not configured", 503);
    }
    return c.json({
      transfer: await createDirectTransfer(
        c.env,
        store,
        authorization.uploadKey,
        { itemKey, libraryID: groupID, libraryType: "group" }
      ),
      uploadKey: authorization.uploadKey,
    });
  }

  if (params.get("params") === "1") {
    return c.json({
      params: {},
      uploadKey: authorization.uploadKey,
      url: authorization.url,
    });
  }

  return c.json(authorization);
});

compatibility.post(
  "/users/:userID/items/:itemKey/file/upload/:uploadKey",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const body = await parseUploadBody(c.req.raw);
    const result = await createCompatibilityStore(c.env).storeAttachmentUpload(
      c.req.param("uploadKey"),
      body,
      c.req.header("Content-Type")
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (result.hashMismatch) {
      return c.text(
        "The Content-MD5 you specified did not match what we received",
        400
      );
    }
    if (result.sizeMismatch) {
      return c.text(
        "Your proposed upload exceeds the maximum allowed size",
        400
      );
    }

    return c.body(null, 201);
  }
);

compatibility.post(
  "/users/:userID/items/:itemKey/file/direct/:uploadKey/complete",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }
    const store = createCompatibilityStore(c.env);
    if (!(await requireUserWrite(c, store, userID))) {
      return c.text("Invalid key", 403);
    }
    return completeDirectUpload(c.req.raw, store, c.req.param("uploadKey"), {
      itemKey: c.req.param("itemKey"),
      libraryID: userID,
      libraryType: "user",
    });
  }
);

compatibility.delete(
  "/users/:userID/items/:itemKey/file/direct/:uploadKey",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }
    const store = createCompatibilityStore(c.env);
    if (!(await requireUserWrite(c, store, userID))) {
      return c.text("Invalid key", 403);
    }
    return (await store.abortDirectAttachmentUpload(c.req.param("uploadKey"), {
      itemKey: c.req.param("itemKey"),
      libraryID: userID,
      libraryType: "user",
    }))
      ? c.body(null, 204)
      : c.text("Upload key not found", 404);
  }
);

compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const result = await store.getAttachmentObject(
      userID,
      c.req.param("itemKey")
    );

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": rawAttachmentContentType(result.file),
    });
  }
);

compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/view/url",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.text(
      await getAttachmentRawFileURL(
        c,
        "p",
        userID,
        c.req.param("itemKey"),
        file
      )
    );
  }
);

compatibility.get(
  "/users/:userID/publications/items/:itemKey/file/view",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publication = await getPublicationItem(
      store,
      userID,
      c.req.param("itemKey")
    );
    if (!publication) {
      return c.text("Item not found", 404);
    }

    const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.redirect(
      await getAttachmentRawFileURL(
        c,
        "p",
        userID,
        c.req.param("itemKey"),
        file
      ),
      302
    );
  }
);

compatibility.get("/users/:userID/publications/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const publications = await getVisiblePublicationItems(store, userID);
  if (publications.items.length > 0) {
    return c.text("Publications settings are unavailable", 400);
  }

  return c.json({}, 200, {
    "Last-Modified-Version": `${publications.version}`,
  });
});

compatibility.get("/users/:userID/publications/deleted", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const result = await createCompatibilityStore(c.env).listItems(userID);
  return c.json({}, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.post("/users/:userID/publications/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }
  if (!getRequestApiKey(c)) {
    return c.text("Invalid key", 403);
  }

  return c.text("Method Not Allowed", 405, {
    Allow: "GET",
  });
});

compatibility.get("/users/:userID/publications/items/top", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const publications = await getVisiblePublicationItems(store, userID);
  const items = publications.items.filter(
    (item) => typeof item.data.parentItem !== "string"
  );
  const responseItems = await Promise.all(
    items.map((item) =>
      attachPublicationItem(c, store, userID, item, publications.items)
    )
  );

  return c.json(responseItems, 200, {
    "Last-Modified-Version": `${publications.version}`,
    "Total-Results": `${responseItems.length}`,
  });
});

compatibility.get(
  "/users/:userID/publications/items/:itemKey/children",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    const publications = await getVisiblePublicationItems(store, userID);
    const parent = publications.items.find(
      (item) => item.key === c.req.param("itemKey")
    );
    if (!parent) {
      return c.text("Item not found", 404);
    }
    const children = publications.items.filter(
      (item) => item.data.parentItem === parent.key
    );
    const responseItems = await Promise.all(
      children.map((item) =>
        attachPublicationItem(c, store, userID, item, publications.items)
      )
    );

    return c.json(responseItems, 200, {
      "Last-Modified-Version": `${publications.version}`,
      "Total-Results": `${responseItems.length}`,
    });
  }
);

compatibility.get("/users/:userID/publications/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const publications = await getVisiblePublicationItems(store, userID);
  const item = publications.items.find(
    (candidate) => candidate.key === c.req.param("itemKey")
  );
  if (!item) {
    return c.text("Item not found", 404);
  }

  if (c.req.query("format") === "atom") {
    return c.text(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        (await renderPublicationItemAtomEntry(c, store, userID, item)),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${item.version}`,
      }
    );
  }

  return c.json(
    await attachPublicationItem(c, store, userID, item, publications.items),
    200,
    {
      "Last-Modified-Version": `${item.version}`,
    }
  );
});

compatibility.get("/users/:userID/publications/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const publications = await getVisiblePublicationItems(store, userID);
  const items = publications.items;

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(items.map((item) => [item.key, item.version])),
      200,
      {
        "Last-Modified-Version": `${publications.version}`,
        "Total-Results": `${items.length}`,
      }
    );
  }

  if (c.req.query("format") === "atom") {
    return c.text(
      await renderPublicationItemsAtomFeed(c, store, userID, items),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${publications.version}`,
        "Total-Results": `${items.length}`,
      }
    );
  }

  const responseItems = await Promise.all(
    items.map((item) => attachPublicationItem(c, store, userID, item, items))
  );

  return c.json(responseItems, 200, {
    "Last-Modified-Version": `${publications.version}`,
    "Total-Results": `${responseItems.length}`,
  });
});

compatibility.get(
  "/users/:userID/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const result = await createCompatibilityStore(c.env).getAttachmentObject(
      userID,
      c.req.param("itemKey")
    );

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": rawAttachmentContentType(result.file),
    });
  }
);

compatibility.get("/users/:userID/items/:itemKey/file/view/url", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.text(
    await getAttachmentRawFileURL(c, "u", userID, c.req.param("itemKey"), file)
  );
});

compatibility.get("/users/:userID/items/:itemKey/file/view", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return redirectToAttachment(
    await getAttachmentRawFileURL(c, "u", userID, c.req.param("itemKey"), file),
    file
  );
});

compatibility.get("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getAttachmentFile(userID, c.req.param("itemKey"));
  if (!file) {
    return c.text("File not found", 404);
  }

  return redirectToAttachment(
    await getAttachmentRawFileURL(c, "u", userID, c.req.param("itemKey"), file),
    file
  );
});

compatibility.patch("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  const itemResult = await store.getItem(userID, itemKey);
  if (!itemResult) {
    return c.text("Item not found", 404);
  }
  const nonStoredAttachmentResponse = rejectNonStoredAttachment(
    getSingleItemData(itemResult)
  );
  if (nonStoredAttachmentResponse) {
    return nonStoredAttachmentResponse;
  }

  const uploadKey = c.req.query("upload");
  if (!uploadKey) {
    return c.text("Upload key not provided", 400);
  }

  const algorithm = c.req.query("algorithm");
  if (!algorithm) {
    return c.text("Algorithm not specified", 400);
  }
  if (!supportedPartialUploadAlgorithms.has(algorithm)) {
    return c.text(`Invalid algorithm '${algorithm}'`, 400);
  }

  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  if (!ifMatch) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }
  if (!isValidMd5(ifMatch)) {
    return c.text("Invalid ETag in If-Match header", 400);
  }

  const existingFile = await store.getAttachmentFile(userID, itemKey);
  if (!existingFile) {
    return c.text("If-Match set but file does not exist", 412);
  }
  if (existingFile.md5 !== ifMatch) {
    return c.text("ETag does not match current version of file", 412);
  }

  const original = await store.getAttachmentObject(userID, itemKey);
  if (!original) {
    return c.text("File not found", 404);
  }

  let patched: ArrayBuffer;
  try {
    patched = await applyZoteroPatch(
      algorithm,
      await responseBodyToArrayBuffer(original.body),
      await c.req.raw.arrayBuffer()
    );
  } catch (error) {
    if (error instanceof PatchAlgorithmUnavailableError) {
      return c.text(
        "Partial upload patch engine is not available in the Worker runtime yet",
        501
      );
    }

    return c.text("Error applying patch", 400);
  }

  const uploadResult = await store.storeAttachmentUpload(uploadKey, patched);
  if (!uploadResult.found) {
    return c.text("Upload key not found", 400);
  }
  if (uploadResult.hashMismatch) {
    return c.text("Patched file does not match hash", 409);
  }
  if (uploadResult.sizeMismatch) {
    return c.text("Patched file size does not match", 409);
  }

  const result = await store.registerAttachmentUpload(
    userID,
    itemKey,
    uploadKey
  );
  if (!result.registered) {
    return c.text("Upload key not found", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
    "Zotero-Library-Version": `${result.version}`,
  });
});

compatibility.post("/users/:userID/items/:itemKey/file", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  const itemResult = await store.getItem(userID, itemKey);
  if (!itemResult) {
    return c.text("Item not found", 404);
  }
  const nonStoredAttachmentResponse = rejectNonStoredAttachment(
    getSingleItemData(itemResult)
  );
  if (nonStoredAttachmentResponse) {
    return nonStoredAttachmentResponse;
  }

  const params = await parseFileParams(c);
  const ifMatch = c.req.header("If-Match")?.replaceAll('"', "");
  const ifNoneMatch = c.req.header("If-None-Match");

  if (!(ifMatch || ifNoneMatch)) {
    return c.text("If-Match/If-None-Match header not provided", 428);
  }

  const existingFile = await store.getAttachmentFile(userID, itemKey);

  if (ifMatch) {
    if (!isValidMd5(ifMatch)) {
      return c.text("Invalid ETag in If-Match header", 400);
    }
    if (!existingFile) {
      return c.text("If-Match set but file does not exist", 412);
    }
    if (existingFile.md5 !== ifMatch) {
      return c.text("ETag does not match current version of file", 412);
    }
  } else if (ifNoneMatch !== "*") {
    return c.text("Invalid value for If-None-Match header", 400);
  } else if (existingFile) {
    return c.text("If-None-Match: * set but file exists", 412);
  }

  const uploadKey = params.get("upload");
  if (uploadKey !== null) {
    if (!uploadKey) {
      return c.text("Upload key not provided", 400);
    }

    const result = await store.registerAttachmentUpload(
      userID,
      itemKey,
      uploadKey
    );

    if (!result.found) {
      return c.text("Upload key not found", 400);
    }
    if (!result.registered) {
      return c.text("Remote file not found", 400);
    }

    return c.body(null, 204, {
      "Last-Modified-Version": `${result.version}`,
      "Zotero-Library-Version": `${result.version}`,
    });
  }

  const md5 = params.get("md5") ?? "";
  const filename = params.get("filename") ?? "";
  const filesize = params.get("filesize") ?? "";
  const mtime = params.get("mtime") ?? "";

  if (!md5) {
    return c.text("MD5 hash not provided", 400);
  }
  if (!isValidMd5(md5)) {
    return c.text("Invalid MD5 hash", 400);
  }
  const zipMd5 = params.get("zipMD5");
  const zipFilename = params.get("zipFilename");
  if (zipMd5 && !isValidMd5(zipMd5)) {
    return c.text("Invalid ZIP MD5 hash", 400);
  }
  if (zipMd5 && !zipFilename) {
    return c.text("ZIP filename not provided", 400);
  }
  if (zipFilename && !zipMd5) {
    return c.text("ZIP MD5 hash not provided", 400);
  }
  if (!filename) {
    return c.text("Filename not provided", 400);
  }
  if (!mtime) {
    return c.text("File modification time not provided", 400);
  }
  if (!filesize) {
    return c.text("File size not provided", 400);
  }

  const sizeBytes = Number.parseInt(filesize, 10);
  if (!Number.isFinite(sizeBytes)) {
    return c.text("Invalid file size", 400);
  }

  const uploadInput = buildAttachmentUploadInput(
    params,
    md5,
    filename,
    sizeBytes,
    mtime,
    zipMd5,
    zipFilename
  );

  const quotaError = await checkStorageQuota(c, store, userID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const existingAssociation = await store.associateExistingAttachmentFile(
    userID,
    itemKey,
    uploadInput
  );
  if (existingAssociation.sizeMismatch) {
    return c.text("Specified file size incorrect for known file", 400);
  }
  if (existingAssociation.associated) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingAssociation.version}`,
      "Zotero-Library-Version": `${existingAssociation.version}`,
    });
  }

  const authorization = await store.authorizeAttachmentUpload(
    userID,
    itemKey,
    uploadInput,
    getUploadBaseURL(c, userID, itemKey)
  );

  if (params.get("direct") === "1") {
    if (!hasR2SigningConfig(c.env)) {
      await store.abortDirectAttachmentUpload(authorization.uploadKey, {
        itemKey,
        libraryID: userID,
        libraryType: "user",
      });
      return c.text("Direct R2 uploads are not configured", 503);
    }
    return c.json({
      transfer: await createDirectTransfer(
        c.env,
        store,
        authorization.uploadKey,
        { itemKey, libraryID: userID, libraryType: "user" }
      ),
      uploadKey: authorization.uploadKey,
    });
  }

  if (params.get("params") === "1") {
    return c.json({
      params: {},
      uploadKey: authorization.uploadKey,
      url: authorization.url,
    });
  }

  return c.json(authorization);
});
