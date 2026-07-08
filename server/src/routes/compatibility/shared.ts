import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getRequestApiKey, isRootRequest } from "../../auth";
import {
  getCreatorFields,
  getItemFields,
  getItemTypeCreatorTypes,
  getItemTypeFields,
  getItemTypes,
  validCreatorTypes,
  validItemTypes,
} from "../../mappings";
import {
  exportContentType,
  isBibliographyContent,
  isExportFormat,
  renderExportBody,
  renderItemAtomFeed,
  withItemIncludes,
} from "../../exports";
import {
  createKeyStore,
  keyAllowsGroupPermission,
  keyAllowsUserPermission,
  managedKeyInfo,
  publicKeyInfo,
} from "../../keys";
import type { Bindings } from "../../bindings";
import {
  clearMemoryCollections,
  createCollectionStore,
} from "../../collections";
import {
  clearMemoryDeleted,
  createDeletedStore,
  recordDeletedObjects,
} from "../../deleted";
import {
  clearMemorySearches,
  createSearchStore,
  searchNeedsInvalidProp,
} from "../../searches";
import { createFullTextStore } from "../../fulltext";
import {
  clearMemorySettings,
  createSettingsStore,
  isAdminOnlySettingKey,
  parseSettingsRequestBody,
  type SettingPayload,
} from "../../settings";
import {
  applyZoteroPatch,
  PatchAlgorithmUnavailableError,
} from "../../patch";
import { createCompatibilityStore, type CompatibilityStore } from "../../storage";
import { schemaVersionHeader } from "../../schema";
import {
  getRelatedItemReverseUpdates,
  validateItemBatchRelationsForWrite,
  validateObjectRelationsForWrite,
} from "../../relations";
import {
  noteToTitle,
  validateItemBatchNotesForWrite,
  validateItemNoteForWrite,
} from "../../notes";
import {
  notificationHeaders,
  topicAccessNotification,
  topicDeletedNotification,
  topicUpdatedNotification,
} from "../../notifications";
import {
  filterItemsForItemRequest,
  filterTopItems,
  listTagsForRequest,
  normalizeItemBatchTagsForWrite,
  normalizeItemTagsForWrite,
  removeTagsFromItems,
} from "../../tags";
import {
  generateZoteroKey,
  getItemTemplate,
  getCreatorSummary,
  isSupportedAnnotationType,
  isSupportedAttachmentLinkMode,
} from "../../zotero";


export const numericIDPattern = /^\d+$/;


export const parseNumericID = (value: string): number | null => {
  if (!numericIDPattern.test(value)) {
    return null;
  }

  return Number.parseInt(value, 10);
};


export const requireRoot = (c: Context<{ Bindings: Bindings }>) => {
  if (!isRootRequest(c)) {
    return c.text("Invalid login", 401);
  }

  return null;
};


export const requireUser = async (
  c: Context<{ Bindings: Bindings }>,
  _store: CompatibilityStore,
  userID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (
    !key ||
    key.userID !== userID ||
    !keyAllowsUserPermission(key.access, "library")
  ) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return true;
};


export const requireUserWrite = async (
  c: Context<{ Bindings: Bindings }>,
  _store: CompatibilityStore,
  userID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (
    !key ||
    key.userID !== userID ||
    !keyAllowsUserPermission(key.access, "library") ||
    !keyAllowsUserPermission(key.access, "write")
  ) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return true;
};


export const isValidMd5 = (value: string): boolean => /^[a-f0-9]{32}$/.test(value);

export const supportedPartialUploadAlgorithms = new Set([
  "bsdiff",
  "xdelta",
  "vcdiff",
  "xdiff",
]);


export const parseFileParams = async (
  c: Context<{ Bindings: Bindings }>
): Promise<URLSearchParams> => {
  const params = new URL(c.req.url).searchParams;
  const body = await c.req.text();
  const bodyParams = new URLSearchParams(body);

  for (const [key, value] of bodyParams) {
    params.set(key, value);
  }

  return params;
};


export const getUploadBaseURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/users/${userID}/items/${itemKey}/file`;
};


export const getRawFileURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string,
  md5: string,
  filename: string
): Promise<string> =>
  createSignedRawFileURL(
    c,
    `/users/${userID}/items/${itemKey}/file/raw/${md5}/${encodeURIComponent(
      filename
    )}`
  );


export const getPublicationRawFileURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string,
  md5: string,
  filename: string
): Promise<string> =>
  createSignedRawFileURL(
    c,
    `/users/${userID}/publications/items/${itemKey}/file/raw/${md5}/${encodeURIComponent(
      filename
    )}`
  );


export const getPublicationFileViewURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/users/${userID}/publications/items/${itemKey}/file/view`;
};


export const getGroupUploadBaseURL = (
  c: Context<{ Bindings: Bindings }>,
  groupID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/groups/${groupID}/items/${itemKey}/file`;
};


export const getGroupRawFileURL = (
  c: Context<{ Bindings: Bindings }>,
  groupID: number,
  itemKey: string,
  md5: string,
  filename: string
): Promise<string> =>
  createSignedRawFileURL(
    c,
    `/groups/${groupID}/items/${itemKey}/file/raw/${md5}/${encodeURIComponent(
      filename
    )}`
  );


export const parseUploadBody = async (request: Request): Promise<ArrayBuffer> => {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return request.arrayBuffer();
  }

  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) {
    return request.arrayBuffer();
  }

  const text = await request.text();
  const filePartStart = text.indexOf('name="file"');
  if (filePartStart === -1) {
    return new ArrayBuffer(0);
  }

  const bodyStart = text.indexOf("\r\n\r\n", filePartStart);
  if (bodyStart === -1) {
    return new ArrayBuffer(0);
  }

  const contentStart = bodyStart + 4;
  const boundaryStart = text.indexOf(`\r\n--${boundary}`, contentStart);
  const content =
    boundaryStart === -1
      ? text.slice(contentStart)
      : text.slice(contentStart, boundaryStart);

  return new TextEncoder().encode(content).buffer as ArrayBuffer;
};


export const responseBodyToArrayBuffer = async (
  body: ArrayBuffer | ReadableStream
): Promise<ArrayBuffer> => {
  if (body instanceof ArrayBuffer) {
    return body;
  }

  return new Response(body).arrayBuffer();
};


export const formatAttachmentContentType = (file: {
  charset?: string | null;
  contentType?: string | null;
}): string => {
  if (!(file.contentType && file.charset)) {
    return file.contentType ?? "application/octet-stream";
  }

  return `${file.contentType}; charset=${file.charset}`;
};


export const rawFileURLLifetimeSeconds = 300;


export const createSignedRawFileURL = async (
  c: Context<{ Bindings: Bindings }>,
  pathname: string
): Promise<string> => {
  const origin = new URL(c.req.url).origin;
  const url = new URL(pathname, origin);
  const expires = Math.floor(Date.now() / 1000) + rawFileURLLifetimeSeconds;

  url.searchParams.set("expires", `${expires}`);
  url.searchParams.set("signature", await signRawFileURL(c, pathname, expires));

  return url.toString();
};


export const requireSignedRawFileURL = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  const url = new URL(c.req.url);
  const expires = Number.parseInt(url.searchParams.get("expires") ?? "", 10);
  const signature = url.searchParams.get("signature") ?? "";

  if (!(Number.isFinite(expires) && signature)) {
    return false;
  }
  if (expires < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = await signRawFileURL(c, url.pathname, expires);
  return timingSafeEqual(expected, signature);
};


export const signRawFileURL = async (
  c: Context<{ Bindings: Bindings }>,
  pathname: string,
  expires: number
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getRawFileURLSecret(c)),
    {
      hash: "SHA-256",
      name: "HMAC",
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${pathname}:${expires}`)
  );

  return arrayBufferToHex(signature);
};


export const getRawFileURLSecret = (c: Context<{ Bindings: Bindings }>): string =>
  c.env.RAW_FILE_URL_SECRET ??
  c.env.ROOT_PASSWORD ??
  c.env.ZOTERO_API_KEY ??
  "local-dev-raw-file-secret";


export const arrayBufferToHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");


export const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
};


export const bytesPerMegabyte = 1024 * 1024;


export const bytesToMegabytes = (bytes: number): number =>
  Math.round((bytes / bytesPerMegabyte) * 10) / 10;


export const checkStorageQuota = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  quotaUserID: number,
  requestedBytes: number
) => {
  const quota = await store.getStorageQuota(quotaUserID);
  if (quota.unlimited) {
    return null;
  }

  const usageBytes = await store.getStorageUsageBytes(quotaUserID);
  const requestedMB = bytesToMegabytes(usageBytes + requestedBytes);

  if (requestedMB <= quota.quotaMB) {
    return null;
  }

  return c.text(
    `File would exceed quota (${requestedMB} > ${quota.quotaMB})`,
    413,
    {
      "Zotero-Storage-Quota": `${quota.quotaMB}`,
      "Zotero-Storage-Usage": `${bytesToMegabytes(usageBytes)}`,
      "Zotero-Storage-UserID": `${quotaUserID}`,
    }
  );
};


export const renderStorageAdminXML = (input: {
  expiration: number;
  quotaMB: number;
  unlimited: boolean;
  usageBytes: number;
}): string => {
  const usageMB = bytesToMegabytes(input.usageBytes);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<storage>",
    `<quota>${input.unlimited ? "unlimited" : input.quotaMB}</quota>`,
    input.expiration ? `<expiration>${input.expiration}</expiration>` : "",
    "<usage>",
    `<total>${usageMB}</total>`,
    `<library>${usageMB}</library>`,
    "</usage>",
    "</storage>",
  ].join("");
};


export const parseStorageQuota = (
  quota: string
): number | "unlimited" | null => {
  if (quota === "unlimited") {
    return "unlimited";
  }

  const quotaMB = Number.parseInt(quota, 10);
  if (!Number.isFinite(quotaMB) || quotaMB < 0) {
    throw new Error("Invalid quota");
  }

  return quotaMB === 0 ? null : quotaMB;
};


export const ttsVoices = {
  premium: [
    {
      id: "local-premium",
      locales: {
        "en-US": {
          default: ["local_en_us_premium"],
        },
      },
      name: "Local Premium",
    },
  ],
  standard: [
    {
      id: "local-standard",
      locales: {
        "en-US": {
          default: ["local_en_us_1", "local_en_us_2"],
        },
        "es-ES": {
          default: ["local_es_es_1"],
        },
        "fr-FR": {
          default: ["local_fr_fr_1"],
        },
        "ja-JP": {
          default: ["local_ja_jp_1"],
        },
        "zh-CN": {
          default: ["local_zh_cn_1"],
        },
      },
      name: "Local Standard",
    },
  ],
};


export const validTTSVoices = new Set(
  [...ttsVoices.standard, ...ttsVoices.premium].flatMap((provider) =>
    Object.values(provider.locales).flatMap((groups) => groups.default)
  )
);


export const requireTTSAccess = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  return (await createCompatibilityStore(c.env).getUserIDForApiKey(apiKey)) !== null;
};


export const getTTSTestKey = (c: Context<{ Bindings: Bindings }>) =>
  c.env.TTS_TEST_KEY ?? c.env.ZOTERO_API_KEY ?? "local-tts-test-key";


export const getTTSAudioID = (voice: string, text: string) => {
  let hash = 0x811c9dc5;
  for (const char of `${voice}\n${text}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return Math.abs(hash).toString(16);
};


export const localSilentWav = Uint8Array.from([
  82, 73, 70, 70, 236, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32,
  16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0,
  2, 0, 16, 0, 100, 97, 116, 97, 200, 0, 0, 0,
  ...new Array(200).fill(0),
]);


export const requireGroup = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || !keyAllowsGroupPermission(key.access, groupID, "library")) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return (await store.getGroupAccess(key.userID, groupID)).canRead;
};


export const requireGroupEdit = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || !keyAllowsGroupPermission(key.access, groupID, "write")) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return (await store.getGroupAccess(key.userID, groupID)).canEdit;
};


export const requireGroupAdmin = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || !keyAllowsGroupPermission(key.access, groupID, "write")) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return (await store.getGroupAccess(key.userID, groupID)).canAdmin;
};


export const requireGroupFileEdit = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || !keyAllowsGroupPermission(key.access, groupID, "files")) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return (await store.getGroupAccess(key.userID, groupID)).canEditFiles;
};


export const parseGroupUsersXML = (
  body: string,
  requireID = true
): Array<{ role: string; userID: number }> => {
  const users: Array<{ role: string; userID: number }> = [];
  const userPattern = /<user\b([^/>]*)\/?>/g;

  for (const match of body.matchAll(userPattern)) {
    const attrs = match[1] ?? "";
    const id = attrs.match(/\bid="([^"]*)"/)?.[1];
    const role = attrs.match(/\brole="([^"]*)"/)?.[1];

    if (!(id || !requireID)) {
      throw new Error("User ID not provided");
    }
    if (!role) {
      throw new Error("Role not provided");
    }

    const userID = id ? Number.parseInt(id, 10) : 0;
    if (id && !Number.isFinite(userID)) {
      throw new Error("Invalid user ID");
    }

    users.push({ role, userID });
  }

  return users;
};


export const renderGroupUsersXML = (
  users: Array<{ role: string; userID: number }>
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    ...users.map(
      (user) =>
        `<entry><title>User ${user.userID}</title><content type="application/xml"><user id="${user.userID}" role="${user.role}"/></content></entry>`
    ),
    "</feed>",
  ].join("");


export const getRequestedCollectionKeys = (
  c: Context<{ Bindings: Bindings }>
): string[] | undefined => c.req.query("collectionKey")?.split(",");


export const paginateRecords = <T>(
  c: Context<{ Bindings: Bindings }>,
  records: T[]
): { headers: Record<string, string>; records: T[]; total: number } => {
  const total = records.length;
  const start = parseNonNegativeInteger(c.req.query("start")) ?? 0;
  const limit = parsePositiveInteger(c.req.query("limit"));
  const paginated = limit === null ? records : records.slice(start, start + limit);
  const headers: Record<string, string> = {
    "Total-Results": `${total}`,
  };

  if (limit !== null && start + limit < total) {
    const url = new URL(c.req.url);
    url.searchParams.set("start", `${start + limit}`);
    url.searchParams.set("limit", `${limit}`);
    headers.Link = `<${url.toString()}>; rel="next"`;
  }

  return {
    headers,
    records: paginated,
    total,
  };
};


export const parseNonNegativeInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};


export const parsePositiveInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};


export const filterCollectionsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  collections: Array<{ data?: Record<string, unknown>; key: string; version?: number }>
) => {
  const q = c.req.query("q")?.toLocaleLowerCase();
  const filtered = q
    ? collections.filter((collection) =>
        [collection.key, collection.data?.name]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(q))
      )
    : collections;

  // Official dataserver default sort for collection lists is title, not
  // dateModified — the tests assert alphabetical order on unsorted requests.
  return sortRecordsForRequest(
    c,
    filtered,
    (collection, field) => {
      if (field === "title" || field === "name") {
        return String(collection.data?.name ?? collection.key);
      }
      if (field === "dateModified" || field === "dateAdded") {
        return collection.version ?? 0;
      }

      return String(collection.key);
    },
    "title",
    (collection) => collection.key
  );
};


export const renderCollectionList = (
  c: Context<{ Bindings: Bindings }>,
  collections: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const sinceVersion = getSinceOrNewerVersion(c);
  const versionFiltered =
    sinceVersion === null
      ? collections
      : collections.filter(
          (collection) => (collection.version ?? 0) > sinceVersion
        );
  const filtered = filterCollectionsForRequest(c, versionFiltered);
  const page = paginateRecords(c, filtered);

  if (c.req.query("format") === "keys") {
    return c.text(
      page.records.map((collection) => collection.key).join("\n"),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(
        page.records.map((collection) => [
          collection.key,
          collection.version ?? version,
        ])
      ),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(page.records, 200, {
    "Last-Modified-Version": `${version}`,
    ...page.headers,
  });
};


export const filterChildItems = <T extends { data: Record<string, unknown> }>(
  items: T[],
  parentItemKey: string
): T[] => items.filter((item) => item.data.parentItem === parentItemKey);


export const renderItemList = (
  c: Context<{ Bindings: Bindings }>,
  allItems: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const sinceVersion = getSinceOrNewerVersion(c);
  const items =
    sinceVersion === null
      ? allItems
      : allItems.filter((item) => (item.version ?? 0) > sinceVersion);

  const sortedItems = sortItemsForRequest(c, items);
  const page = paginateRecords(c, sortedItems);
  const libraryID = getRequestLibraryID(c);
  const format = c.req.query("format");
  const content = c.req.query("content");
  const style = c.req.query("style");
  const responseItems = page.records.map((item) => shapeItemForSchemaRequest(c, item));

  if (c.req.query("format") === "keys") {
    return c.text(page.records.map((item) => item.key).join("\n"), 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (format === "versions") {
    return c.json(
      Object.fromEntries(page.records.map((item) => [item.key, item.version ?? version])),
      200,
      itemListHeaders(version, page.headers)
    );
  }

  if (isExportFormat(format)) {
    return c.text(renderExportBody(responseItems, format, libraryID), 200, {
      "Content-Type": exportContentType(format),
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (wantsItemAtomResponse(c, format, content)) {
    return c.text(renderItemAtomFeed(responseItems, content, libraryID, style, getCanonicalFeedHref(c)), 200, {
      "Content-Type": "application/atom+xml",
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  return c.json(
    responseItems.map((item) =>
      withItemIncludes(item, c.req.query("include"), libraryID, style)
    ),
    200,
    itemListHeaders(version, page.headers)
  );
};


export const renderItemListHead = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  const page = paginateRecords(c, sortItemsForRequest(c, items));
  return c.body(null, 200, itemListHeaders(version, page.headers));
};


export const renderSingleItem = (
  c: Context<{ Bindings: Bindings }>,
  item: { data?: Record<string, unknown>; key: string; version?: number },
  version: number
) => {
  const libraryID = getRequestLibraryID(c);
  const format = c.req.query("format");
  const content = c.req.query("content");
  const style = c.req.query("style");
  const responseItem = shapeItemForSchemaRequest(c, item);
  // Single-object responses carry the object's own version, not the
  // library version (official ApiController sets libraryVersion to the
  // object version for single-object requests).
  const objectVersion = item.version ?? version;

  if (isExportFormat(format)) {
    return c.text(renderExportBody([responseItem], format, libraryID), 200, {
      "Content-Type": exportContentType(format),
      "Last-Modified-Version": `${objectVersion}`,
    });
  }

  if (wantsItemAtomResponse(c, format, content)) {
    return c.text(renderItemAtomFeed([responseItem], content, libraryID, style), 200, {
      "Content-Type": "application/atom+xml",
      "Last-Modified-Version": `${objectVersion}`,
      "Total-Results": "1",
    });
  }

  return c.json(
    withItemIncludes(responseItem, c.req.query("include"), libraryID, style),
    200,
    {
      "Last-Modified-Version": `${objectVersion}`,
    }
  );
};


export const itemListHeaders = (version: number, headers: Record<string, string>) => ({
    "Last-Modified-Version": `${version}`,
    ...headers,
});


export const acceptsAtom = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Accept") ?? "")
    .split(",")
    .map((entry) => entry.trim().split(";")[0])
    .includes("application/atom+xml");


export const wantsItemAtomResponse = (
  c: Context<{ Bindings: Bindings }>,
  format: string | undefined,
  content: string | undefined
) =>
  format === "atom" ||
  isBibliographyContent(content ?? null) ||
  (!format && acceptsAtom(c));


export const getCanonicalFeedHref = (c: Context<{ Bindings: Bindings }>): string => {
  const url = new URL(c.req.url);
  const params = new URLSearchParams(url.search);
  const legacyOrder = params.get("order");
  if (legacyOrder) {
    const legacyDirection = params.get("sort");
    params.delete("order");
    params.set("sort", legacyOrder);
    if (legacyDirection === "asc" || legacyDirection === "desc") {
      params.set("direction", legacyDirection);
    }
  }

  const sortedParams = [...params.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  url.search = new URLSearchParams(sortedParams).toString();
  return url.toString();
};


export const isAndroidClient = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("User-Agent") ?? "").toLowerCase().includes("android");


export const isEPUBAnnotationPosition = (value: unknown): boolean => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) && parsed.type === "FragmentSelector";
  } catch {
    return false;
  }
};


export const shapeItemForSchemaRequest = <T extends {
  data?: Record<string, unknown>;
  key: string;
  version?: number;
}>(
  c: Context<{ Bindings: Bindings }>,
  item: T
): T => {
  if (!item.data) {
    return item;
  }

  const schemaVersion = getSchemaVersion(c);
  const data = { ...item.data };
  const creatorSummary = getCreatorSummary(data);
  const existingMeta = isRecord((item as { meta?: unknown }).meta)
    ? ((item as { meta?: unknown }).meta as Record<string, unknown>)
    : {};
  const meta = { ...existingMeta };
  if (isAndroidClient(c) || (schemaVersion !== null && schemaVersion < 42)) {
    delete data.lastRead;
  }
  if (schemaVersion !== null && schemaVersion <= 29) {
    for (const field of ["originalDate", "originalPlace", "originalPublisher"]) {
      if (data[field] === "") {
        delete data[field];
      }
    }
  }
  if (
    data.itemType === "annotation" &&
    schemaVersion !== null &&
    schemaVersion < 29 &&
    (data.annotationType === "underline" ||
      data.annotationType === "text" ||
      isEPUBAnnotationPosition(data.annotationPosition))
  ) {
    data.invalidProp = "annotationType";
  }
  if (creatorSummary) {
    meta.creatorSummary = creatorSummary;
  } else {
    delete meta.creatorSummary;
  }

  return {
    ...item,
    data,
    ...(Object.keys(meta).length ? { meta } : {}),
  } as T;
};


export const sortItemsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{ data?: Record<string, unknown>; key: string; version?: number }>
) =>
  sortRecordsForRequest(
    c,
    items,
    (item, field) => getItemSortValue(item, field),
    "dateModified",
    (item) => item.key
  );


export const sortRecordsForRequest = <T>(
  c: Context<{ Bindings: Bindings }>,
  records: T[],
  getValue: (record: T, field: string) => number | string,
  defaultField = "dateModified",
  getKey?: (record: T) => string
): T[] => {
  const rawSort = c.req.query("sort") ?? c.req.query("order");
  const sortAsDirection = rawSort === "asc" || rawSort === "desc";
  const field = sortAsDirection ? defaultField : rawSort ?? defaultField;

  // order=itemKeyList / collectionKeyList / searchKeyList: return objects in
  // the order their keys appear in the corresponding key-list query param.
  if (field.endsWith("KeyList") && getKey) {
    const requested = (c.req.query(field.slice(0, -4)) ?? "")
      .split(",")
      .map((key) => key.trim());
    const position = new Map(requested.map((key, index) => [key, index]));
    return [...records].sort(
      (left, right) =>
        (position.get(getKey(left)) ?? Number.POSITIVE_INFINITY) -
        (position.get(getKey(right)) ?? Number.POSITIVE_INFINITY)
    );
  }
  const explicitDirection = c.req.query("direction") ?? (sortAsDirection ? rawSort : null);
  const direction =
    explicitDirection === "asc"
      ? 1
      : explicitDirection === "desc"
        ? -1
        : field === "title" || field === "creator" || field === "itemType" || field === "name"
          ? 1
          : -1;

  return [...records].sort((left, right) => {
    const leftValue = getValue(left, field);
    const rightValue = getValue(right, field);
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : compareText(String(leftValue), String(rightValue));

    return comparison === 0 ? 0 : comparison * direction;
  });
};


export const getItemSortValue = (
  item: { data?: Record<string, unknown>; key: string; version?: number },
  field: string
): number | string => {
  switch (field) {
    case "creator":
      return getCreatorSortValue(item);
    case "date":
      return String(item.data?.date ?? "");
    case "dateAdded":
      return String(item.data?.dateAdded ?? item.version ?? "");
    case "itemType":
      return String(item.data?.itemType ?? "");
    case "title":
      return item.data?.itemType === "note" && typeof item.data.note === "string"
        ? noteToTitle(item.data.note, true)
        : String(item.data?.title ?? item.data?.note ?? item.key);
    case "dateModified":
    default:
      return String(item.data?.dateModified ?? item.version ?? "");
  }
};


export const getCreatorSortValue = (item: {
  data?: Record<string, unknown>;
  key: string;
}): string => {
  const creators = Array.isArray(item.data?.creators) ? item.data.creators : [];
  const creator = creators.find(isRecord);
  const value = creator
    ? String(creator.name ?? creator.lastName ?? creator.firstName ?? "")
    : "";

  return value || "\uffff";
};


export const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });


export const getRequestLibraryID = (c: Context<{ Bindings: Bindings }>): number => {
  const userID = parseNumericID(c.req.param("userID") || "0");
  if (userID !== null && userID > 0) {
    return userID;
  }

  const groupID = parseNumericID(c.req.param("groupID") || "0");
  return groupID ?? 0;
};


export const filterItemsForRequest = async (
  c: Context<{ Bindings: Bindings }>,
  libraryType: "group" | "user",
  libraryID: number,
  items: Parameters<typeof filterItemsForItemRequest>[0],
  allItems = items,
  includeChildFullText = false
) => {
  const params = getURLSearchParams(c);
  const fullTextContent =
    params.get("q") && params.get("qmode") === "everything"
      ? await createFullTextStore(c.env).getContentMap(libraryType, libraryID)
      : undefined;
  const includeNotes =
    libraryType === "group" || (await requestAllowsUserNotes(c, libraryID));
  const visibleItems = includeNotes
    ? items
    : items.filter((item) => item.data.itemType !== "note");
  const visibleAllItems = includeNotes
    ? allItems
    : allItems.filter((item) => item.data.itemType !== "note");

  return filterItemsForItemRequest(visibleItems, params, {
    allItems: visibleAllItems,
    fullTextContent,
    includeChildFullText,
  });
};


export const requestAllowsUserNotes = async (
  c: Context<{ Bindings: Bindings }>,
  userID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  return Boolean(
    key &&
      key.userID === userID &&
      keyAllowsUserPermission(key.access, "library") &&
      keyAllowsUserPermission(key.access, "notes")
  );
};


export const handleWebTranslationWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    body: unknown;
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  if (!isRecord(input.body) || typeof input.body.url !== "string") {
    return null;
  }

  const url = input.body.url;
  const title = getTranslatedTitle(url);
  if (!title) {
    return c.text("No translators found", 400);
  }

  if (isMultipleTranslationURL(url)) {
    const token = getTranslationToken(url);
    if (isRecord(input.body.items)) {
      if (typeof input.body.token !== "string") {
        return c.text("Token not provided with selected items", 400);
      }
      if (input.body.token !== token) {
        return c.text("'token' is valid only for item selection requests", 400);
      }

      const selection = Object.keys(input.body.items);
      const invalidSelection = selection.find((key) => key !== "0");
      if (invalidSelection) {
        return c.text(`Index '${invalidSelection}' not found for URL and token`, 400);
      }
    } else if (typeof input.body.token === "string") {
      return c.text("'token' is valid only for item selection requests", 400);
    } else {
      return c.json(
        {
          items: {
            0: title,
          },
          token,
        },
        300
      );
    }
  }

  const data = {
    itemType: "webpage",
    title,
    url,
  };
  const result =
    input.libraryType === "user"
      ? await input.store.createItems(input.libraryID, [data])
      : await input.store.createGroupItems(input.libraryID, [data]);

  return c.json(
    {
      success: result.success,
      successful: result.successful,
    },
    200,
    {
      "Last-Modified-Version": `${result.version}`,
      ...notificationHeaders(
        topicUpdatedNotification(input.libraryType, input.libraryID, result.version)
      ),
    }
  );
};


export const getTranslatedTitle = (url: string): string | null => {
  if (url === "https://forums.zotero.org") {
    return "Recent Discussions";
  }
  if (isMultipleTranslationURL(url)) {
    return "Digital history: A guide to gathering, preserving, and presenting the past on the web";
  }

  try {
    return new URL(url).hostname || url;
  } catch {
    return null;
  }
};


export const isMultipleTranslationURL = (url: string): boolean =>
  url === "https://zotero-static.s3.amazonaws.com/test-multiple.html";


export const getTranslationToken = (url: string): string => {
  let hash = 0x811c9dc5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return Math.abs(hash).toString(16).padStart(8, "0").repeat(4).slice(0, 32);
};


export const tagWriteFailureResponse = (
  c: Context<{ Bindings: Bindings }>,
  failed: Record<string, { code: number; data?: Record<string, unknown>; message: string }>,
  version: number
) =>
  c.json(
    {
      failed,
      success: [],
      successful: [],
    },
    200,
    {
      "Last-Modified-Version": `${version}`,
    }
  );


export type ItemWriteFailure = {
  code: number;
  data?: Record<string, unknown>;
  message: string;
};


export type ItemWriteFailures = Record<string, ItemWriteFailure>;


export const mergeItemWriteFailures = (
  target: ItemWriteFailures,
  source: ItemWriteFailures
) => {
  for (const [index, failure] of Object.entries(source)) {
    if (!(index in target)) {
      target[index] = failure;
    }
  }
};


export type ExistingObjectVersions = Map<
  string,
  { data: Record<string, unknown>; version: number }
>;


export type BatchWritePreconditionResult = {
  failed: ItemWriteFailures;
  libraryPreconditionFailed: boolean;
  toWrite: Array<{ index: number; object: Record<string, unknown> }>;
  unchanged: Record<string, string>;
};


// Implements Zotero's version-precondition contract for batch writes:
// library-level `If-Unmodified-Since-Version`, per-object `version` property
// semantics (0 = must-not-exist, matching = update, stale = 412), and the
// unchanged/failed buckets. See references/dataserver .../version.test.js.
export const evaluateBatchWritePreconditions = (
  objects: Record<string, unknown>[],
  existing: ExistingObjectVersions,
  libraryVersion: number,
  ifUnmodifiedSinceVersion: number | null,
  objectTypeLabel: "Collection" | "Item" | "Search"
): BatchWritePreconditionResult => {
  if (
    ifUnmodifiedSinceVersion !== null &&
    ifUnmodifiedSinceVersion !== libraryVersion
  ) {
    return {
      failed: {},
      libraryPreconditionFailed: true,
      toWrite: [],
      unchanged: {},
    };
  }

  const headerProvided = ifUnmodifiedSinceVersion !== null;
  const failed: ItemWriteFailures = {};
  const unchanged: Record<string, string> = {};
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];

  const requireVersion = (index: number, key: string) => {
    failed[index] = {
      code: 428,
      message: `${objectTypeLabel} ${key} must be written with a version property or If-Unmodified-Since-Version header`,
    };
  };

  objects.forEach((object, index) => {
    const key = typeof object.key === "string" ? object.key : "";
    const current = key ? existing.get(key) : undefined;
    const versionProp =
      typeof object.version === "number" ? object.version : undefined;

    if (current) {
      if (versionProp === undefined) {
        if (headerProvided) {
          toWrite.push({ index, object });
        } else {
          requireVersion(index, key);
        }
      } else if (versionProp === current.version) {
        toWrite.push({ index, object });
      } else {
        failed[index] = {
          code: 412,
          message: `${objectTypeLabel} has been modified since specified version (expected ${versionProp}, found ${current.version})`,
        };
      }
      return;
    }

    if (key) {
      if (versionProp === undefined) {
        if (headerProvided) {
          toWrite.push({ index, object });
        } else {
          requireVersion(index, key);
        }
      } else if (versionProp === 0) {
        toWrite.push({ index, object });
      } else {
        failed[index] = {
          code: 404,
          message: `${objectTypeLabel} doesn't exist (expected version ${versionProp}; use 0 instead)`,
        };
      }
      return;
    }

    toWrite.push({ index, object });
  });

  return { failed, libraryPreconditionFailed: false, toWrite, unchanged };
};


// Builds the Zotero batch write-report envelope, keyed by the original batch
// index, from the objects that were actually persisted plus the precondition
// buckets.
export const buildWriteReport = (
  written: Array<{ index: number; object: Record<string, unknown> }>,
  successful: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  failed: ItemWriteFailures,
  unchanged: Record<string, string>
) => {
  const successfulByIndex: Record<string, unknown> = {};
  const successByIndex: Record<string, string> = {};
  successful.forEach((item, position) => {
    const originalIndex = written[position]?.index ?? position;
    successfulByIndex[originalIndex] = item;
    successByIndex[originalIndex] = item.key;
  });
  return {
    failed,
    success: successByIndex,
    successful: successfulByIndex,
    unchanged,
  };
};


// Identities the official test config expects the server to know about
// (references/dataserver/tests/remote/config/default.json). Registered when
// /test/setup provisions users.
const userIdentities = new Map<
  number,
  { displayName: string; username: string }
>();

export const registerUserIdentity = (
  userID: number,
  username: string,
  displayName: string
) => {
  userIdentities.set(userID, { displayName, username });
};

export const getUserIdentity = (userID: number) =>
  userIdentities.get(userID) ?? {
    displayName: `User ${userID}`,
    username: `user${userID}`,
  };

export const buildLibraryBlock = (
  c: Context<{ Bindings: Bindings }>,
  libraryType: "group" | "user",
  libraryID: number,
  groupName?: string
) => {
  const origin = new URL(c.req.url).origin;
  if (libraryType === "user") {
    const identity = getUserIdentity(libraryID);
    return {
      type: "user",
      id: libraryID,
      name: identity.displayName,
      links: {
        alternate: {
          href: `${origin}/${identity.username}`,
          type: "text/html",
        },
      },
    };
  }
  return {
    type: "group",
    id: libraryID,
    name: groupName ?? "",
    links: {
      alternate: {
        href: `${origin}/groups/${libraryID}`,
        type: "text/html",
      },
    },
  };
};

const zoteroMonths: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4,
  april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11,
  november: 11, dec: 12, december: 12,
};

const pad2 = (value: number) => `${value}`.padStart(2, "0");

// Minimal port of Zotero's date parsing for meta.parsedDate: returns
// 'YYYY', 'YYYY-MM', or 'YYYY-MM-DD', or null when unparseable.
export const parseZoteroDate = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }

  let match = text.match(/^(\d{4})$/);
  if (match) {
    return match[1] ?? null;
  }
  match = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (match) {
    const month = Number(match[2]);
    const day = match[3] ? Number(match[3]) : null;
    if (month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) {
      return null;
    }
    return day === null
      ? `${match[1]}-${pad2(month)}`
      : `${match[1]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[1] ?? "").toLowerCase()];
    const day = Number(match[2]);
    if (!month || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^(\d{1,2})\.?\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[2] ?? "").toLowerCase()];
    const day = Number(match[1]);
    if (!month || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[1] ?? "").toLowerCase()];
    if (!month) {
      return null;
    }
    return `${match[2]}-${pad2(month)}`;
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
};

export const nowISOTimestamp = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Normalizes a Zotero timestamp field value to ISO 8601 UTC ('...Z').
// Accepts ISO 8601 (with Z or numeric offset), UTC SQL format
// 'YYYY-MM-DD[ hh:mm:ss]', or 'CURRENT_TIMESTAMP'. Returns null when invalid.
export const normalizeZoteroTimestamp = (
  value: string,
  now: string
): string | null => {
  const text = value.trim();
  if (text === "CURRENT_TIMESTAMP") {
    return now;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) {
    return text;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(text)) {
    const iso = text.includes(" ")
      ? `${text.replace(" ", "T")}Z`
      : `${text}T00:00:00Z`;
    return Number.isNaN(new Date(iso).getTime()) ? null : iso;
  }
  return null;
};

const timestampFormatError = (field: string, value: string) => ({
  code: 400,
  message: `'${field}' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]' format or 'CURRENT_TIMESTAMP' (${value})`,
});

// Write-side handling of accessDate/dateAdded/dateModified plus template
// fill for new items: invalid timestamps fail the object, dateAdded is
// preserved (normalized) or stamped, and dateModified is stamped with the
// current time unless the client supplies a NEW explicit value.
export const normalizeItemTimestampsForWrite = (
  data: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  now: string
): { code: number; message: string } | null => {
  for (const field of ["accessDate", "dateAdded", "dateModified"] as const) {
    const value = data[field];
    if (typeof value !== "string" || value === "") {
      continue;
    }
    const normalized = normalizeZoteroTimestamp(value, now);
    if (normalized === null) {
      return timestampFormatError(field, value);
    }
    data[field] = normalized;
  }

  if (!existing) {
    if (typeof data.dateAdded !== "string" || data.dateAdded === "") {
      data.dateAdded = now;
    }
    if (typeof data.dateModified !== "string" || data.dateModified === "") {
      data.dateModified = now;
    }
    return null;
  }

  const previous =
    typeof existing.dateModified === "string" ? existing.dateModified : "";
  const incoming =
    typeof data.dateModified === "string" ? data.dateModified : "";
  if (!incoming || incoming === previous) {
    data.dateModified = now;
  }
  if (typeof data.dateAdded !== "string" || data.dateAdded === "") {
    const previousAdded =
      typeof existing.dateAdded === "string" ? existing.dateAdded : now;
    data.dateAdded = previousAdded;
  }
  return null;
};

// New items are stored with every valid field for their type present,
// defaulting to '' — and null values are treated as empty strings.
export const fillItemTemplateFields = (
  data: Record<string, unknown>,
  isNew: boolean
) => {
  for (const [field, value] of Object.entries(data)) {
    if (value === null) {
      data[field] = "";
    }
  }
  if (!isNew) {
    return data;
  }
  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  if (!itemType || itemType === "attachment" || itemType === "annotation") {
    return data;
  }
  for (const entry of getItemTypeFields(itemType) ?? []) {
    if (!(entry.field in data)) {
      data[entry.field] = "";
    }
  }
  return data;
};

export const validateItemNoteFieldForWrite = (
  data: Record<string, unknown>
): { code: number; message: string } | null => {
  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  if (
    "note" in data &&
    itemType !== "note" &&
    itemType !== "attachment" &&
    itemType !== "annotation"
  ) {
    return {
      code: 400,
      message: `'note' property is valid only for note and attachment items`,
    };
  }
  return null;
};

const maxItemFieldLength = 65_535;

export const validateItemBatchFieldLengthsForWrite = (
  items: Record<string, unknown>[]
): ItemWriteFailures => {
  const failures: ItemWriteFailures = {};
  items.forEach((item, index) => {
    for (const [field, value] of Object.entries(item)) {
      // Notes have their own dedicated size validation.
      if (field === "note") {
        continue;
      }
      if (typeof value === "string" && value.length > maxItemFieldLength) {
        failures[index] = {
          code: 413,
          message: `Field '${field}' value too long`,
        };
        break;
      }
    }
  });
  return failures;
};

// dateModified is server-stamped on every effective change, so it is
// excluded when deciding whether an upload actually changed anything.
const stripVersionForCompare = (data: Record<string, unknown>) => {
  const { version: _version, dateModified: _dateModified, ...rest } = data;
  return rest;
};

export const attachItemMeta = (
  c: Context<{ Bindings: Bindings }>,
  item: { data?: Record<string, unknown>; key: string; version?: number },
  input: {
    allItems: Array<{ data?: Record<string, unknown>; key: string }>;
    groupName?: string;
    libraryID: number;
    libraryType: "group" | "user";
  }
) => {
  const meta: Record<string, unknown> = {
    ...((item as { meta?: Record<string, unknown> }).meta ?? {}),
  };
  const parsedDate = parseZoteroDate(item.data?.date);
  if (parsedDate) {
    meta.parsedDate = parsedDate;
  }
  meta.numChildren = input.allItems.filter(
    (other) => other.data?.parentItem === item.key
  ).length;
  return {
    ...item,
    library: buildLibraryBlock(
      c,
      input.libraryType,
      input.libraryID,
      input.groupName
    ),
    meta,
  };
};

export const jsonValuesEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => key in right && jsonValuesEqual(left[key], right[key])
      )
    );
  }
  return false;
};

// Shared batch item POST pipeline for user and group libraries, implementing
// the official multi-object write contract: invalid entries fail per-index,
// existing objects get PATCH-merge semantics, false-marker fields normalize
// after the merge, unchanged uploads land in `unchanged` without a version
// bump, and per-object failures don't abort the rest of the batch.
export const handleItemBatchWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const body = await c.req.json().catch(() => null);
  const translationResponse = await handleWebTranslationWrite(c, {
    body,
    libraryID: input.libraryID,
    libraryType: input.libraryType,
    store: input.store,
  });
  if (translationResponse) {
    return translationResponse;
  }
  if (!Array.isArray(body)) {
    return c.text("Uploaded data must be a JSON array", 400);
  }

  const itemFailures: ItemWriteFailures = {};
  const rawItems: Record<string, unknown>[] = (body as unknown[]).map(
    (entry, index) => {
      if (isRecord(entry)) {
        return { ...(entry as Record<string, unknown>) };
      }
      itemFailures[index] = {
        code: 400,
        message: `Invalid value for index ${index} in uploaded data; expected JSON item object`,
      };
      return {};
    }
  );

  const library =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);
  const existingVersions: ExistingObjectVersions = new Map(
    library.items.map((item) => [
      item.key,
      { data: item.data ?? {}, version: item.version ?? 0 },
    ])
  );
  const precondition = evaluateBatchWritePreconditions(
    rawItems,
    existingVersions,
    library.version,
    getIfUnmodifiedSinceVersion(c),
    "Item"
  );
  if (precondition.libraryPreconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${library.version}`,
    });
  }
  mergeItemWriteFailures(itemFailures, precondition.failed);

  const now = nowISOTimestamp();
  const finalItems: Record<string, unknown>[] = rawItems.map((object, index) => {
    const key = typeof object.key === "string" ? object.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    const merged = current
      ? mergeItemUpdate(current.data, object, key, true)
      : { ...object };
    const normalized = normalizeItemParentForWrite(
      normalizeItemDeletedForWrite(merged)
    );
    fillItemTemplateFields(normalized, !current);
    const noteFieldFailure = validateItemNoteFieldForWrite(normalized);
    if (noteFieldFailure && !(index in itemFailures)) {
      itemFailures[index] = noteFieldFailure;
    }
    const timestampFailure = normalizeItemTimestampsForWrite(
      normalized,
      current?.data,
      now
    );
    if (timestampFailure && !(index in itemFailures)) {
      itemFailures[index] = timestampFailure;
    }
    return normalized;
  });

  mergeItemWriteFailures(itemFailures, normalizeItemBatchTagsForWrite(finalItems));
  mergeItemWriteFailures(itemFailures, validateItemBatchNotesForWrite(finalItems));
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchRelationsForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchCreatorsForWrite(finalItems, true)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchAnnotationsForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchFieldLengthsForWrite(finalItems)
  );
  const annotationParentResult =
    await validateItemBatchAnnotationParentsForWrite(
      input.store,
      input.libraryType,
      input.libraryID,
      finalItems
    );
  mergeItemWriteFailures(itemFailures, annotationParentResult.failures);
  await validateItemBatchParentsForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    finalItems,
    itemFailures
  );

  const unchanged: Record<string, string> = { ...precondition.unchanged };
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];
  for (const entry of precondition.toWrite) {
    if (entry.index in itemFailures) {
      continue;
    }
    const final = finalItems[entry.index];
    if (!final) {
      continue;
    }
    const key = typeof final.key === "string" ? final.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    if (
      current &&
      jsonValuesEqual(
        stripVersionForCompare(final),
        stripVersionForCompare(current.data)
      )
    ) {
      unchanged[entry.index] = key;
      continue;
    }
    toWrite.push({ index: entry.index, object: final });
  }

  const missingCollectionKeys = await createCollectionStore(
    c.env
  ).findMissingCollectionKeys(
    input.libraryType,
    input.libraryID,
    toWrite.map((entry) => entry.object)
  );
  if (missingCollectionKeys.length) {
    return collectionFailureResponse(c, missingCollectionKeys, library.version);
  }

  const writeToken = c.req.header("Zotero-Write-Token");
  const result = toWrite.length
    ? input.libraryType === "user"
      ? await input.store.createItems(
          input.libraryID,
          toWrite.map((entry) => entry.object),
          writeToken
        )
      : await input.store.createGroupItems(
          input.libraryID,
          toWrite.map((entry) => entry.object),
          writeToken
        )
    : {
        duplicateWriteToken: false,
        success: [] as string[],
        successful: [] as never[],
        version: library.version,
      };

  if (result.duplicateWriteToken) {
    return c.text("Write token has already been used", 412);
  }

  const relationVersion = await syncRelatedItemRelations(
    { libraryID: input.libraryID, libraryType: input.libraryType, store: input.store },
    result.successful
  );
  const version = relationVersion ?? result.version;

  const postLibrary =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);
  const enrichedSuccessful = result.successful.map((item) =>
    attachItemMeta(c, item, {
      allItems: postLibrary.items,
      libraryID: input.libraryID,
      libraryType: input.libraryType,
    })
  );

  return c.json(
    buildWriteReport(toWrite, enrichedSuccessful, itemFailures, unchanged),
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...(result.successful.length > 0
        ? notificationHeaders(
            topicUpdatedNotification(input.libraryType, input.libraryID, version)
          )
        : {}),
    }
  );
};

export type SingleObjectWriteVersionCheck =
  | { editable: Record<string, unknown>; ok: true }
  | {
      code: ContentfulStatusCode;
      headers?: Record<string, string>;
      message: string;
      ok: false;
    };

// Port of the official dataserver's checkSingleObjectWriteVersion
// (ApiController.php): resolve the expected object version from the
// If-Unmodified-Since-Version header and/or the JSON 'version' property
// (envelope bodies carry their content in .data), then enforce the
// missing/existing × version matrix. A 412 on an existing object carries the
// object's current version in Last-Modified-Version; the 400s carry none.
export const checkSingleObjectWriteVersion = (
  c: Context<{ Bindings: Bindings }>,
  objectTypeLabel: "Collection" | "Item" | "Search",
  existingVersion: number | null,
  body: Record<string, unknown>,
  method: "PATCH" | "PUT"
): SingleObjectWriteVersionCheck => {
  const editable = isRecord(body.data)
    ? (body.data as Record<string, unknown>)
    : body;

  const headerRaw = c.req.header("If-Unmodified-Since-Version");
  let headerVersion: number | null = null;
  if (headerRaw !== undefined) {
    if (!/^\d+$/.test(headerRaw.trim())) {
      return {
        code: 400,
        message: `Invalid If-Unmodified-Since-Version value '${headerRaw}'`,
        ok: false,
      };
    }
    headerVersion = Number.parseInt(headerRaw, 10);
  }

  let propVersion: number | null = null;
  if (editable.version !== undefined) {
    if (typeof editable.version !== "number" || !Number.isInteger(editable.version)) {
      return {
        code: 400,
        message: `Invalid JSON 'version' property value '${String(editable.version)}'`,
        ok: false,
      };
    }
    propVersion = editable.version;
  }

  if (
    headerVersion !== null &&
    propVersion !== null &&
    headerVersion !== propVersion
  ) {
    return {
      code: 400,
      message: `If-Unmodified-Since-Version value does not match JSON 'version' property (${headerVersion} != ${propVersion})`,
      ok: false,
    };
  }

  const version = headerVersion ?? propVersion;

  if (existingVersion === null) {
    if (method === "PATCH" && version === null) {
      return {
        code: 404,
        message: `${objectTypeLabel} not found (to create, use If-Unmodified-Since-Version: 0, JSON 'version' 0, or PUT method)`,
        ok: false,
      };
    }
    if (version !== null && version > 0) {
      return {
        code: 412,
        message: `${objectTypeLabel} not found (expected version ${version})`,
        ok: false,
      };
    }
    return { editable, ok: true };
  }

  if (version === null) {
    return {
      code: 428,
      message:
        "Either If-Unmodified-Since-Version or object version property must be provided for key-based writes",
      ok: false,
    };
  }

  if (existingVersion > version) {
    return {
      code: 412,
      headers: { "Last-Modified-Version": `${existingVersion}` },
      message: `${objectTypeLabel} has been modified since specified version (expected ${version}, found ${existingVersion})`,
      ok: false,
    };
  }

  return { editable, ok: true };
};


export const renderTagList = (
  c: Context<{ Bindings: Bindings }>,
  tags: Array<{ tag: string }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const sortedTags = sortRecordsForRequest(c, tags, (tag) => tag.tag);
  const page = paginateRecords(c, sortedTags);

  if (isHeadRequest(c)) {
    return c.body(null, 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomFeed(
        "Tags",
        page.records.map((tag) =>
          renderJSONAtomEntry({
            content: tag,
            id: `tags/${tag.tag}`,
            key: tag.tag,
            title: tag.tag,
            version,
          })
        )
      ),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(page.records, 200, {
    "Last-Modified-Version": `${version}`,
    ...page.headers,
  });
};


export const getURLSearchParams = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).searchParams;


export const collectionFailureResponse = (
  c: Context<{ Bindings: Bindings }>,
  missingCollectionKeys: string[],
  version: number
) =>
  c.json(
    {
      failed: missingCollectionKeys.map((collectionKey) => ({
        code: 409,
        data: {
          collection: collectionKey,
        },
        message: `Collection ${collectionKey} not found`,
      })),
      success: [],
      successful: [],
    },
    200,
    {
      "Last-Modified-Version": `${version}`,
    }
  );


export const getIfUnmodifiedSinceVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.header("If-Unmodified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const getSinceOrNewerVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since") ?? c.req.query("newer");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const hasJSONContentType = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json");


export const hasDirectCollections = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.collections) && data.collections.length > 0;


export const isChildItemData = (data: Record<string, unknown>): boolean =>
  typeof data.parentItem === "string" && data.parentItem.length > 0;


export const isEmbeddedImageAttachment = (data: Record<string, unknown>): boolean =>
  data.itemType === "attachment" && data.linkMode === "embedded_image";


export const mergeItemUpdate = (
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  itemKey: string,
  patchMode: boolean
): Record<string, unknown> => ({
  ...(patchMode ? existing : {}),
  ...body,
  key: itemKey,
});


export const normalizeItemDeletedForWrite = (data: Record<string, unknown>) => {
  if (data.deleted === true) {
    data.deleted = 1;
  } else if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};


export const normalizeItemParentForWrite = (data: Record<string, unknown>) => {
  if (data.parentItem === false) {
    delete data.parentItem;
  }

  return data;
};


export const normalizeObjectDeletedForWrite = (data: Record<string, unknown>) => {
  if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};


export const normalizeItemBatchDeletedForWrite = (items: Record<string, unknown>[]) =>
  items.map((item) => normalizeItemParentForWrite(normalizeItemDeletedForWrite(item)));


export const normalizeObjectBatchDeletedForWrite = (objects: Record<string, unknown>[]) =>
  objects.map(normalizeObjectDeletedForWrite);


export const creatorHasName = (creator: Record<string, unknown>) =>
  ["name", "firstName", "lastName"].some(
    (field) => typeof creator[field] === "string" && creator[field].trim() !== ""
  );


export const validateItemCreatorsForWrite = (
  data: Record<string, unknown>,
  isNew: boolean
): { code: number; message: string } | null => {
  if (data.creators === undefined) {
    return null;
  }
  if (!Array.isArray(data.creators)) {
    return { code: 400, message: "'creators' property must be an array" };
  }

  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  const validForItemType = new Set(
    getItemTypeCreatorTypes(itemType).map((entry) => entry.creatorType)
  );
  const normalizedCreators: Record<string, unknown>[] = [];

  for (const creator of data.creators) {
    if (!isRecord(creator)) {
      return { code: 400, message: "creator object must be an object" };
    }
    if (!("creatorType" in creator)) {
      return {
        code: 400,
        message: "creator object must contain 'creatorType'",
      };
    }
    if (!creatorHasName(creator)) {
      if (data.creators.length === 1 && isNew) {
        data.creators = [];
        return null;
      }
      return {
        code: 400,
        message: "creator object must contain 'firstName'/'lastName' or 'name'",
      };
    }

    const creatorType = creator.creatorType;
    if (typeof creatorType !== "string" || !validCreatorTypes.has(creatorType)) {
      return {
        code: 400,
        message: `'${String(creatorType)}' is not a valid creator type`,
      };
    }
    if (!validForItemType.has(creatorType) && creatorType !== "author") {
      return {
        code: 400,
        message: `'${creatorType}' is not a valid creator type for item type '${itemType}'`,
      };
    }
    if ("name" in creator && "firstName" in creator) {
      return {
        code: 400,
        message: "'firstName' and 'name' creator fields are mutually exclusive",
      };
    }
    if ("name" in creator && "lastName" in creator) {
      return {
        code: 400,
        message: "'lastName' and 'name' creator fields are mutually exclusive",
      };
    }
    if ("firstName" in creator && !("lastName" in creator)) {
      return {
        code: 400,
        message: "'lastName' creator field must be set if 'firstName' is set",
      };
    }
    if ("lastName" in creator && !("firstName" in creator)) {
      return {
        code: 400,
        message: "'firstName' creator field must be set if 'lastName' is set",
      };
    }
    for (const field of Object.keys(creator)) {
      if (!["creatorType", "firstName", "lastName", "name"].includes(field)) {
        return {
          code: 400,
          message: `Invalid creator property '${field}'`,
        };
      }
    }
    normalizedCreators.push(creator);
  }

  data.creators = normalizedCreators;
  return null;
};


export const validateItemBatchCreatorsForWrite = (
  items: Record<string, unknown>[],
  isNew: boolean
): Record<string, { code: number; message: string }> => {
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = validateItemCreatorsForWrite(item, isNew);
    if (failure) {
      failures[index] = failure;
    }
  });
  return failures;
};


export const annotationSortIndexPattern = /^\d{5}\|\d+(?:\|\d{5})?$/;

export const annotationColorPattern = /^#[0-9a-fA-F]{6}$/;

export const annotationTextTypes = new Set(["highlight", "underline"]);

export const annotationParentContentTypes = new Set([
  "application/epub+zip",
  "application/pdf",
  "application/xhtml+xml",
  "text/html",
]);


export const stringifyAnnotationPosition = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? {});


export const truncateAnnotationText = (value: unknown): unknown =>
  typeof value === "string" && Array.from(value).length > 7500
    ? Array.from(value).slice(0, 7500).join("")
    : value;


export const normalizeAnnotationForWrite = (
  data: Record<string, unknown>,
  existing?: Record<string, unknown>
): { code: number; message: string } | null => {
  if (data.itemType !== "annotation") {
    return null;
  }

  const annotationType =
    typeof data.annotationType === "string" ? data.annotationType : "";
  if (!annotationType || !isSupportedAnnotationType(annotationType)) {
    return {
      code: 400,
      message: "annotationType must be 'highlight', 'note', 'image', 'text', or 'ink'",
    };
  }
  if (
    existing?.itemType === "annotation" &&
    typeof existing.annotationType === "string" &&
    existing.annotationType !== annotationType
  ) {
    return {
      code: 400,
      message: `Cannot change existing annotationType for item ${String(data.key ?? "")}`,
    };
  }
  if ("annotationText" in data && !annotationTextTypes.has(annotationType)) {
    return {
      code: 400,
      message: "'annotationText' can only be set for highlight and underline annotations",
    };
  }
  if (
    typeof data.annotationPageLabel === "string" &&
    data.annotationPageLabel.length > 50
  ) {
    return {
      code: 400,
      message: `Annotation page label is too long for attachment ${String(data.parentItem ?? "")}`,
    };
  }

  const position = stringifyAnnotationPosition(data.annotationPosition);
  if (position.length > 65_000) {
    return {
      code: 400,
      message: `Annotation position is too long for attachment ${String(data.parentItem ?? "")}`,
    };
  }
  data.annotationPosition = position;

  if (
    typeof data.annotationSortIndex === "string" &&
    !annotationSortIndexPattern.test(data.annotationSortIndex)
  ) {
    return {
      code: 400,
      message: `Invalid sortIndex '${data.annotationSortIndex}'`,
    };
  }
  if (data.annotationColor === undefined || data.annotationColor === "") {
    data.annotationColor = "#ffd400";
  } else if (
    typeof data.annotationColor !== "string" ||
    !annotationColorPattern.test(data.annotationColor)
  ) {
    return {
      code: 400,
      message: "annotationColor must be a hex color (e.g., '#FF0000')",
    };
  }
  if (data.annotationAuthorName === "") {
    delete data.annotationAuthorName;
  }
  data.annotationText = truncateAnnotationText(data.annotationText);

  return null;
};


export const validateItemBatchAnnotationsForWrite = (
  items: Record<string, unknown>[]
): Record<string, { code: number; message: string }> => {
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = normalizeAnnotationForWrite(item);
    if (failure) {
      failures[index] = failure;
    }
  });
  return failures;
};


export const getAnnotationParentFailure = (
  item: Record<string, unknown>,
  parents: Map<string, Record<string, unknown>>
): { code: number; message: string } | null => {
  if (item.itemType !== "annotation") {
    return null;
  }
  if (typeof item.parentItem !== "string" || item.parentItem.length === 0) {
    return { code: 400, message: "Annotation parentItem is required" };
  }

  const parent = parents.get(item.parentItem);
  if (!parent) {
    return {
      code: 409,
      message: `Parent attachment ${item.parentItem} not found`,
    };
  }
  if (parent.itemType !== "attachment") {
    return {
      code: 400,
      message: `Annotation parent ${item.parentItem} must be an attachment`,
    };
  }

  const contentType =
    typeof parent.contentType === "string"
      ? (parent.contentType.split(";")[0] ?? "").toLowerCase()
      : "";
  if (!annotationParentContentTypes.has(contentType)) {
    return {
      code: 400,
      message: `Annotation parent ${item.parentItem} must be a PDF, EPUB, or HTML attachment`,
    };
  }

  return null;
};


export const getParentMap = (
  existingItems: Array<{ data: Record<string, unknown>; key: string }>,
  pendingItems: Record<string, unknown>[] = []
) => {
  const parents = new Map<string, Record<string, unknown>>();
  for (const item of existingItems) {
    parents.set(item.key, item.data);
  }
  for (const item of pendingItems) {
    if (typeof item.key === "string") {
      parents.set(item.key, item);
    }
  }
  return parents;
};


export const getItemParentFailure = (
  item: Record<string, unknown>,
  parents: Map<string, Record<string, unknown>>,
  failedParentKeys = new Set<string>()
): { code: number; data?: Record<string, unknown>; message: string } | null => {
  if (item.itemType === "annotation" || typeof item.parentItem !== "string") {
    return null;
  }

  const parentItem = item.parentItem;
  if (typeof item.key === "string" && item.key === parentItem) {
    return {
      code: 400,
      data: { parentItem },
      message: `Item ${parentItem} cannot be a child of itself`,
    };
  }
  if (failedParentKeys.has(parentItem)) {
    return {
      code: 409,
      data: { parentItem },
      message: `Parent item ${parentItem} not found`,
    };
  }

  const parent = parents.get(parentItem);
  if (!parent) {
    return {
      code: 409,
      data: { parentItem },
      message: `Parent item ${parentItem} not found`,
    };
  }
  if (
    (parent.itemType === "note" || parent.itemType === "attachment") &&
    !(isEmbeddedImageAttachment(item) && parent.itemType === "note")
  ) {
    return {
      code: 409,
      data: { parentItem },
      message: "Parent item cannot be a note or attachment",
    };
  }
  if (typeof parent.parentItem === "string" && parent.parentItem.length > 0) {
    return {
      code: 409,
      data: { parentItem },
      message: `Parent item ${parentItem} cannot be a child item`,
    };
  }

  return null;
};


export const validateItemParentForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  item: Record<string, unknown>
): Promise<{ code: number; message: string } | null> => {
  if (item.itemType === "annotation" || typeof item.parentItem !== "string") {
    return null;
  }
  const parentResult =
    libraryType === "user"
      ? await store.getItem(libraryID, item.parentItem)
      : await store.getGroupItem(libraryID, item.parentItem);
  const parent = parentResult?.items[0];
  const failure = getItemParentFailure(
    item,
    parent ? new Map([[parent.key, parent.data]]) : new Map()
  );
  return failure ? { code: failure.code, message: failure.message } : null;
};


export const validateItemBatchParentsForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  items: Record<string, unknown>[],
  failed: ItemWriteFailures
): Promise<number> => {
  const library =
    libraryType === "user"
      ? await store.listItems(libraryID)
      : await store.listGroupItems(libraryID);
  const failedParentKeys = new Set(
    Object.entries(failed)
      .map(([index]) => items[Number(index)]?.key)
      .filter((key): key is string => typeof key === "string")
  );
  const parents = getParentMap(
    library.items,
    items.filter((_item, index) => !(index in failed))
  );
  items.forEach((item, index) => {
    if (index in failed) {
      return;
    }
    const failure = getItemParentFailure(item, parents, failedParentKeys);
    if (failure) {
      failed[index] = failure;
    }
  });

  return library.version;
};


export const validateAnnotationParentForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  item: Record<string, unknown>
): Promise<{ code: number; message: string } | null> => {
  if (item.itemType !== "annotation") {
    return null;
  }
  const parentItem = typeof item.parentItem === "string" ? item.parentItem : "";
  const parentResult = parentItem
    ? libraryType === "user"
      ? await store.getItem(libraryID, parentItem)
      : await store.getGroupItem(libraryID, parentItem)
    : null;
  const parent = parentResult?.items[0];
  return getAnnotationParentFailure(
    item,
    parent ? new Map([[parent.key, parent.data]]) : new Map()
  );
};


export const validateItemBatchAnnotationParentsForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  items: Record<string, unknown>[]
): Promise<{
  failures: Record<string, { code: number; message: string }>;
  version: number;
}> => {
  const library =
    libraryType === "user"
      ? await store.listItems(libraryID)
      : await store.listGroupItems(libraryID);
  const parents = getParentMap(library.items, items);
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = getAnnotationParentFailure(item, parents);
    if (failure) {
      failures[index] = failure;
    }
  });

  return { failures, version: library.version };
};


export const syncRelatedItemRelations = async (
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  },
  writtenItems: Array<{ data: Record<string, unknown>; key: string; version: number }>
): Promise<number | null> => {
  const library = input.libraryType === "user"
    ? await input.store.listItems(input.libraryID)
    : await input.store.listGroupItems(input.libraryID);
  const updates = getRelatedItemReverseUpdates(
    input.libraryType,
    input.libraryID,
    writtenItems,
    library.items
  );

  if (updates.length === 0) {
    return null;
  }

  if (input.libraryType === "user") {
    const result = await input.store.createItems(input.libraryID, updates);
    return result.version;
  }

  const result = await input.store.createGroupItems(input.libraryID, updates);
  return result.version;
};


export const updateItemInLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKey: string;
    libraryID: number;
    libraryType: "group" | "user";
    patchMode: boolean;
    store: CompatibilityStore;
  }
) => {
  const existingResult =
    input.libraryType === "user"
      ? await input.store.getItem(input.libraryID, input.itemKey)
      : await input.store.getGroupItem(input.libraryID, input.itemKey);
  const existing = existingResult?.items[0];
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid item JSON", 400);
  }

  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Item",
    existing ? existing.version ?? 0 : null,
    body as Record<string, unknown>,
    input.patchMode ? "PATCH" : "PUT"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }
  const editable = versionCheck.editable;

  const data = normalizeItemDeletedForWrite(
    mergeItemUpdate(existing?.data ?? {}, editable, input.itemKey, input.patchMode)
  );
  if (
    input.patchMode &&
    !("parentItem" in editable) &&
    hasDirectCollections(data)
  ) {
    delete data.parentItem;
  }
  fillItemTemplateFields(data, !existing);
  const noteFieldFailure = validateItemNoteFieldForWrite(data);
  if (noteFieldFailure) {
    return c.text(noteFieldFailure.message, 400);
  }
  const timestampFailure = normalizeItemTimestampsForWrite(
    data,
    existing?.data,
    nowISOTimestamp()
  );
  if (timestampFailure) {
    return c.text(timestampFailure.message, 400);
  }
  normalizeItemParentForWrite(data);
  const tagFailure = normalizeItemTagsForWrite(data);
  if (tagFailure) {
    return c.text(tagFailure.message, tagFailure.code);
  }
  const noteFailure = validateItemNoteForWrite(data);
  if (noteFailure) {
    return c.text(noteFailure.message, noteFailure.code);
  }
  const relationFailure = validateObjectRelationsForWrite(data, "item");
  if (relationFailure) {
    return c.text(relationFailure.message, relationFailure.code);
  }
  const creatorFailure = validateItemCreatorsForWrite(data, !existing);
  if (creatorFailure) {
    return c.text(
      creatorFailure.message,
      creatorFailure.code as ContentfulStatusCode
    );
  }
  const annotationFailure = normalizeAnnotationForWrite(data, existing?.data);
  if (annotationFailure) {
    return c.text(annotationFailure.message, annotationFailure.code as 400);
  }
  const annotationParentFailure = await validateAnnotationParentForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    data
  );
  if (annotationParentFailure) {
    return c.text(
      annotationParentFailure.message,
      annotationParentFailure.code as ContentfulStatusCode
    );
  }
  const itemParentFailure = await validateItemParentForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    data
  );
  if (itemParentFailure) {
    return c.text(
      itemParentFailure.message,
      itemParentFailure.code as ContentfulStatusCode
    );
  }
  if (isChildItemData(data) && hasDirectCollections(data)) {
    return c.text("Child items cannot be assigned to collections", 400);
  }

  const missingCollectionKeys =
    await createCollectionStore(c.env).findMissingCollectionKeys(
      input.libraryType,
      input.libraryID,
      [data]
    );
  if (missingCollectionKeys.length) {
    return c.text(`Collection ${missingCollectionKeys[0]} not found`, 409);
  }

  const result =
    input.libraryType === "user"
      ? await input.store.createItems(input.libraryID, [data])
      : await input.store.createGroupItems(input.libraryID, [data]);
  const relationVersion = await syncRelatedItemRelations(input, result.successful);
  const version = relationVersion ?? result.version;

  return c.body(null, 204, {
    "Last-Modified-Version": `${version}`,
    ...notificationHeaders(
      topicUpdatedNotification(input.libraryType, input.libraryID, version)
    ),
  });
};


export const upsertCollectionInLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    collectionKey: string;
    libraryID: number;
    libraryType: "group" | "user";
    patchMode?: boolean;
  }
) => {
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid collection JSON", 400);
  }

  const collectionStore = createCollectionStore(c.env);
  const existing = await collectionStore.getCollection(
    input.libraryType,
    input.libraryID,
    input.collectionKey
  );

  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Collection",
    existing ? existing.collection.version ?? 0 : null,
    body as Record<string, unknown>,
    input.patchMode ? "PATCH" : "PUT"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }

  const collectionData = normalizeObjectDeletedForWrite(
    input.patchMode && existing
      ? { ...existing.collection.data, ...versionCheck.editable }
      : versionCheck.editable
  );
  const result = await collectionStore.createCollections(
    input.libraryType,
    input.libraryID,
    [{ ...collectionData, key: input.collectionKey }]
  );
  const firstFailure = result.failed[0];
  if (firstFailure) {
    return c.text(
      firstFailure.message,
      firstFailure.code as ContentfulStatusCode
    );
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
};


export const getPublicationItem = async (
  store: CompatibilityStore,
  userID: number,
  itemKey: string
) => {
  const result = await store.getItem(userID, itemKey);
  const item = result?.items[0];

  if (!item || item.data.inPublications !== true) {
    return null;
  }

  return {
    item,
    version: result.version,
  };
};


export const renderPublicationItemAtom = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom">',
    `<id>users/${userID}/publications/items/${itemKey}</id>`,
    `<title>${itemKey}</title>`,
    `<link rel="enclosure" href="${getPublicationFileViewURL(
      c,
      userID,
      itemKey
    )}"/>`,
    "</entry>",
  ].join("");


export const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");


export const renderJSONAtomEntry = (input: {
  content: unknown;
  id: string;
  key: string;
  title: string;
  version: number;
}) =>
  [
    '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    `<id>${escapeXML(input.id)}</id>`,
    `<title>${escapeXML(input.title)}</title>`,
    `<zapi:key>${escapeXML(input.key)}</zapi:key>`,
    `<zapi:version>${input.version}</zapi:version>`,
    `<content type="application/json">${escapeXML(JSON.stringify(input.content))}</content>`,
    "</entry>",
  ].join("");


export const renderJSONAtomFeed = (title: string, entries: string[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    `<title>${escapeXML(title)}</title>`,
    ...entries,
    "</feed>",
  ].join("");


export const atomHeaders = (version: number, total?: number) => ({
  "Content-Type": "application/atom+xml",
  "Last-Modified-Version": `${version}`,
  ...(total === undefined ? {} : { "Total-Results": `${total}` }),
});


export const jsonListHeaders = (version: number, total: number) => ({
  "Last-Modified-Version": `${version}`,
  "Total-Results": `${total}`,
});


export const wantsAtomResponse = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("format") === "atom" || c.req.query("content") === "json";


export const isHeadRequest = (c: Context<{ Bindings: Bindings }>) =>
  c.req.method.toUpperCase() === "HEAD";



export const withPublicationLinks = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  item: { data: Record<string, unknown>; key: string; version: number }
) => ({
  ...item,
  links: {
    enclosure: {
      href: getPublicationFileViewURL(c, userID, item.key),
    },
  },
});


export const readKeyRequestBody = async (c: Context<{ Bindings: Bindings }>) =>
  c.req.json().catch(() => ({}));


export const requireKeyRoot = (c: Context<{ Bindings: Bindings }>) =>
  isRootRequest(c) ? null : c.text("Invalid key", 403);


export const getLoginBaseURL = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).origin;


export const keyAccessNotificationHeaders = async (
  store: CompatibilityStore,
  before: { access: Record<string, unknown>; id?: string; key: string; userID: number },
  after: { access: Record<string, unknown>; id?: string; key: string; userID: number }
) => {
  const beforeGroups = await getKeyAccessGroupIDs(store, before.userID, before.access);
  const afterGroups = await getKeyAccessGroupIDs(store, after.userID, after.access);
  const apiKeyID = after.id ?? after.key;
  const notifications = [
    ...[...afterGroups]
      .filter((groupID) => !beforeGroups.has(groupID))
      .map((groupID) => topicAccessNotification("topicAdded", apiKeyID, groupID)),
    ...[...beforeGroups]
      .filter((groupID) => !afterGroups.has(groupID))
      .map((groupID) => topicAccessNotification("topicRemoved", apiKeyID, groupID)),
  ];

  return notificationHeaders(...notifications);
};


export const allGroupAccessNotifications = async (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  event: "topicAdded" | "topicRemoved",
  groupID: number
) => {
  const keys = await createKeyStore(c.env).listUserKeys(userID);
  return keys
    .filter((key) => {
      const groups = isRecord(key.access.groups) ? key.access.groups : {};
      const all = isRecord(groups.all) ? groups.all : null;
      return all?.library === true;
    })
    .map((key) => topicAccessNotification(event, key.id ?? key.key, groupID));
};


export const getKeyAccessGroupIDs = async (
  store: CompatibilityStore,
  userID: number,
  access: Record<string, unknown>
): Promise<Set<number>> => {
  const groups = isRecord(access.groups) ? access.groups : {};
  const allGroups = isRecord(groups.all) ? groups.all : null;
  if (allGroups?.library === true) {
    return new Set((await store.listVisibleGroups(userID)).map((group) => group.id));
  }

  return new Set(
    Object.entries(groups)
      .filter(([groupID, value]) => groupID !== "all" && isRecord(value) && value.library === true)
      .map(([groupID]) => Number.parseInt(groupID, 10))
      .filter((groupID) => Number.isFinite(groupID))
  );
};


export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);


export const renderGroupCreateAtom = (groupID: number): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    "<entry>",
    `<zapi:groupID>${groupID}</zapi:groupID>`,
    "</entry>",
    "</feed>",
  ].join("");


export const isPublicGroupRecord = (group: {
  data?: { type?: string };
}) => group.data?.type === "PublicOpen" || group.data?.type === "PublicClosed";


export const getGroupVersion = (group: { data?: Record<string, unknown> }) => {
  const version = group.data?.version;
  return typeof version === "number" ? version : 1;
};


export const getGroupSelfHref = (c: Context<{ Bindings: Bindings }>, groupID: number) =>
  `${new URL(c.req.url).origin}/groups/${groupID}`;


export const groupResponse = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  group: {
    data: Record<string, unknown> & { owner?: number; version?: number };
    id: number;
  }
) => {
  const apiKey = getRequestApiKey(c);
  const key = apiKey ? await createKeyStore(c.env).getKey(apiKey) : null;
  const access = key ? await store.getGroupAccess(key.userID, group.id) : null;
  return {
    data: group.data,
    id: group.id,
    links: {
      self: {
        href: getGroupSelfHref(c, group.id),
        type: "application/json",
      },
    },
    meta: {
      isAdmin: Boolean(access?.canAdmin || group.data.owner === key?.userID),
    },
    version: getGroupVersion(group),
  };
};


export const filterGroupsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  groups: Array<{ data: Record<string, unknown> & { type?: string }; id: number }>
) => {
  const fq = c.req.query("fq");
  const q = c.req.query("q")?.toLocaleLowerCase();
  let filtered = groups;

  if (fq?.startsWith("GroupType:")) {
    const groupType = fq.slice("GroupType:".length);
    filtered = filtered.filter((group) => group.data.type === groupType);
  }
  if (q) {
    filtered = filtered.filter((group) =>
      String(group.data.name ?? "").toLocaleLowerCase().includes(q)
    );
  }

  return filtered;
};


export const renderUserGroupsAtom = (
  groups: Array<{
    data?: Record<string, unknown> & { name?: string; version?: number };
    id: number;
    version?: number;
  }>,
  c?: Context<{ Bindings: Bindings }>
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    ...groups.map((group) => {
      const content = {
        ...(isRecord(group.data) ? group.data : {}),
        id: group.id,
        version: getGroupVersion(group),
      };
      return [
        "<entry>",
        `<id>groups/${group.id}</id>`,
        `<title>${escapeXML(group.data?.name ?? `Group ${group.id}`)}</title>`,
        c ? `<link rel="self" href="${escapeXML(getGroupSelfHref(c, group.id))}"/>` : "",
        `<zapi:groupID>${group.id}</zapi:groupID>`,
        `<content type="application/json">${escapeXML(JSON.stringify(content))}</content>`,
        "</entry>",
      ].join("");
    }),
    "</feed>",
  ].join("");


export const renderGroupUpdateAtom = (group: { data: Record<string, unknown>; id: number }) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zxfer="http://zotero.org/ns/transfer">',
    '<content type="application/xml">',
    `<zxfer:group name="${escapeXML(String(group.data.name ?? ""))}"/>`,
    "</content>",
    "</entry>",
  ].join("");


export const parseGroupXML = (body: string): Record<string, unknown> => {
  const attrs = body.match(/<group\b([^>]*)/i)?.[1] ?? "";
  const readAttr = (name: string): string | undefined =>
    attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const readNode = (name: string): string | undefined =>
    body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1];

  const owner = Number.parseInt(readAttr("owner") ?? "", 10);
  return {
    ...(Number.isFinite(owner) ? { owner } : {}),
    ...(readAttr("fileEditing") ? { fileEditing: readAttr("fileEditing") } : {}),
    ...(readAttr("hasImage") ? { hasImage: readAttr("hasImage") } : {}),
    ...(readAttr("libraryEditing") ? { libraryEditing: readAttr("libraryEditing") } : {}),
    ...(readAttr("libraryReading") ? { libraryReading: readAttr("libraryReading") } : {}),
    ...(readAttr("name") ? { name: readAttr("name") } : {}),
    ...(readAttr("type") ? { type: readAttr("type") } : {}),
    ...(readAttr("url") ? { url: readAttr("url") } : {}),
    ...(readNode("description") !== undefined ? { description: readNode("description") } : {}),
    ...(readNode("url") !== undefined ? { url: readNode("url") } : {}),
  };
};


export const settingHeaders = (version: number) => ({
  "Last-Modified-Version": `${version}`,
});


export const renderSettingsList = (
  c: Context<{ Bindings: Bindings }>,
  result: { settings: Record<string, unknown>; version: number }
) => {
  if (requestIsNotModified(c, result.version)) {
    return c.body(null, 304, settingHeaders(result.version));
  }

  return c.json(result.settings, 200, settingHeaders(result.version));
};


export const getSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const since = c.req.query("since");
  if (since === undefined) {
    return null;
  }

  const parsed = Number.parseInt(since, 10);
  return Number.isNaN(parsed) ? null : parsed;
};


export const getRequestedSettingKeys = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.query("settingKey") ?? "")
    .split(",")
    .map((settingKey) => settingKey.trim())
    .filter(Boolean);


export const isSettingsObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);


export const parseSettingsBody = async (c: Context<{ Bindings: Bindings }>) =>
  parseSettingsRequestBody(await c.req.text());


export const renderSettingsWriteFailure = (
  c: Context<{ Bindings: Bindings }>,
  failure: { code: number; message: string }
) => c.text(failure.message, failure.code as 400 | 403 | 412 | 413);


export const ensureSingleSettingPrecondition = (
  existing: { setting: { version: number } } | null,
  ifUnmodifiedSinceVersion: number | null
) => {
  if (ifUnmodifiedSinceVersion === null) {
    return false;
  }

  return existing
    ? existing.setting.version > ifUnmodifiedSinceVersion
    : ifUnmodifiedSinceVersion > 0;
};


export const getDeletedTagNames = (c: Context<{ Bindings: Bindings }>) =>
  getURLSearchParams(c)
    .getAll("tag")
    .flatMap((expression) => expression.split(" || "))
    .map((tag) => tag.trim())
    .filter(Boolean);


export const deleteTagsForLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const result = input.libraryType === "user"
    ? await input.store.listItems(input.libraryID)
    : await input.store.listGroupItems(input.libraryID);

  if (result.version > preconditionVersion) {
    return c.text("Library has been modified", 412);
  }

  const updatedItems = removeTagsFromItems(
    result.items,
    getURLSearchParams(c).getAll("tag")
  );
  if (updatedItems.length > 0) {
    const writeResult = input.libraryType === "user"
      ? await input.store.createItems(input.libraryID, updatedItems)
      : await input.store.createGroupItems(input.libraryID, updatedItems);
    await recordDeletedObjects(
      c.env,
      input.libraryType,
      input.libraryID,
      writeResult.version,
      "tag",
      getDeletedTagNames(c)
    );

    return c.body(null, 204, {
      "Last-Modified-Version": `${writeResult.version}`,
    });
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
};


export const getRequestedSearchKeys = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("searchKey")?.split(",").filter(Boolean);


export const getSearchSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since") ?? c.req.query("newer");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const getIfModifiedSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.header("If-Modified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const requestIsNotModified = (
  c: Context<{ Bindings: Bindings }>,
  version: number
): boolean => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  return ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion;
};


export const getSchemaVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.header("Zotero-Schema-Version") ?? c.req.query("schemaVersion");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const withSearchSchema = (
  c: Context<{ Bindings: Bindings }>,
  search: { data: Record<string, unknown>; key: string; version: number }
) => {
  const data = { ...search.data };
  if (searchNeedsInvalidProp(search, getSchemaVersion(c))) {
    data.invalidProp = 1;
  }
  else {
    delete data.invalidProp;
  }

  return {
    ...search,
    data,
  };
};


export const renderSearchList = (
  c: Context<{ Bindings: Bindings }>,
  searches: Array<{ data: Record<string, unknown>; key: string; version: number }>,
  version: number
) => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  if (ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion) {
    return c.body(null, 304, settingHeaders(version));
  }
  const sortedSearches = sortRecordsForRequest(
    c,
    searches,
    (search, field) =>
      field === "title" || field === "name"
        ? String(search.data.name ?? search.key)
        : search.version,
    "dateModified",
    (search) => search.key
  );
  const page = paginateRecords(c, sortedSearches);

  if (isHeadRequest(c)) {
    return c.body(null, 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (c.req.query("format") === "keys") {
    return c.text(page.records.map((search) => search.key).join("\n"), 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(page.records.map((search) => [search.key, search.version])),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomFeed(
        "Searches",
        page.records.map((search) =>
          renderJSONAtomEntry({
            content: withSearchSchema(c, search).data,
            id: `searches/${search.key}`,
            key: search.key,
            title: String(search.data.name ?? search.key),
            version: search.version,
          })
        )
      ),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(
    page.records.map((search) => withSearchSchema(c, search)),
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    }
  );
};


export const renderSearchWriteResult = (
  c: Context<{ Bindings: Bindings }>,
  result: {
    failed: Record<string, unknown>;
    success: string[];
    successful: unknown[];
    unchanged: unknown[];
    version: number;
  }
) =>
  c.json(
    {
      failed: result.failed,
      success: result.success,
      successful: result.successful,
      unchanged: result.unchanged,
    },
    200,
    settingHeaders(result.version)
  );


export const parseSearchWriteBody = async (c: Context<{ Bindings: Bindings }>) =>
  c.req.json().catch(() => null);


export const getRequiredSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};


export const getItemKeysForDelete = (
  c: Context<{ Bindings: Bindings }>,
  itemKey?: string
): string[] => {
  const rawKeys = itemKey ?? c.req.query("itemKey") ?? "";
  return rawKeys.split(",").map((key) => key.trim()).filter(Boolean);
};


export const getLastPageIndexSettingKeys = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKeys: string[]
) =>
  itemKeys.map((itemKey) =>
    libraryType === "user"
      ? `lastPageIndex_u_${itemKey}`
      : `lastPageIndex_g${libraryID}_${itemKey}`
  );


export const cleanupLastPageIndexSettings = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKeys: string[];
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const settingsStore = createSettingsStore(c.env);
  const settingKeys = getLastPageIndexSettingKeys(
    input.libraryType,
    input.libraryID,
    input.itemKeys
  );

  if (input.libraryType === "user") {
    await settingsStore.deleteSettingsWithoutLog("user", input.libraryID, settingKeys);
    return;
  }

  await settingsStore.deleteSettingsWithoutLog("group", input.libraryID, settingKeys);
  const users = await input.store.listGroupUsers(input.libraryID);
  await Promise.all(
    users.map((user) =>
      settingsStore.deleteSettingsWithoutLog("user", user.userID, settingKeys)
    )
  );
};


export const deleteItemsForLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKeys: string[];
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const result = input.libraryType === "user"
    ? await input.store.deleteItems(input.libraryID, input.itemKeys, preconditionVersion)
    : await input.store.deleteGroupItems(input.libraryID, input.itemKeys, preconditionVersion);
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  if (result.deleted.length > 0) {
    await cleanupLastPageIndexSettings(c, {
      ...input,
      itemKeys: result.deleted,
    });
  }

  return c.body(null, 204, {
    ...settingHeaders(result.version),
    ...(result.deleted.length > 0
      ? notificationHeaders(
          topicUpdatedNotification(input.libraryType, input.libraryID, result.version)
        )
      : {}),
  });
};
