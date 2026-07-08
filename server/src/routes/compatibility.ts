import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getRequestApiKey, isRootRequest } from "../auth";
import {
  getCreatorFields,
  getItemFields,
  getItemTypeCreatorTypes,
  getItemTypeFields,
  getItemTypes,
  validCreatorTypes,
  validItemTypes,
} from "../mappings";
import {
  exportContentType,
  isBibliographyContent,
  isExportFormat,
  renderExportBody,
  renderItemAtomFeed,
  withItemIncludes,
} from "../exports";
import {
  createKeyStore,
  keyAllowsGroupPermission,
  keyAllowsUserPermission,
  managedKeyInfo,
  publicKeyInfo,
} from "../keys";
import type { Bindings } from "../bindings";
import {
  clearMemoryCollections,
  createCollectionStore,
} from "../collections";
import {
  clearMemoryDeleted,
  createDeletedStore,
  recordDeletedObjects,
} from "../deleted";
import {
  clearMemorySearches,
  createSearchStore,
  searchNeedsInvalidProp,
} from "../searches";
import { createFullTextStore } from "../fulltext";
import {
  clearMemorySettings,
  createSettingsStore,
  isAdminOnlySettingKey,
  parseSettingsRequestBody,
  type SettingPayload,
} from "../settings";
import {
  applyZoteroPatch,
  PatchAlgorithmUnavailableError,
} from "../patch";
import { createCompatibilityStore, type CompatibilityStore } from "../storage";
import { schemaVersionHeader } from "../schema";
import {
  getRelatedItemReverseUpdates,
  validateItemBatchRelationsForWrite,
  validateObjectRelationsForWrite,
} from "../relations";
import {
  noteToTitle,
  validateItemBatchNotesForWrite,
  validateItemNoteForWrite,
} from "../notes";
import {
  notificationHeaders,
  topicAccessNotification,
  topicDeletedNotification,
  topicUpdatedNotification,
} from "../notifications";
import {
  filterItemsForItemRequest,
  filterTopItems,
  listTagsForRequest,
  normalizeItemBatchTagsForWrite,
  normalizeItemTagsForWrite,
  removeTagsFromItems,
} from "../tags";
import {
  generateZoteroKey,
  getItemTemplate,
  getCreatorSummary,
  isSupportedAnnotationType,
  isSupportedAttachmentLinkMode,
} from "../zotero";

export const compatibility = new Hono<{ Bindings: Bindings }>();

compatibility.use("*", async (c, next) => {
  await next();
  c.header("Zotero-API-Version", "3");
  c.header("Zotero-Schema-Version", schemaVersionHeader());
});

const numericIDPattern = /^\d+$/;

const parseNumericID = (value: string): number | null => {
  if (!numericIDPattern.test(value)) {
    return null;
  }

  return Number.parseInt(value, 10);
};

const requireRoot = (c: Context<{ Bindings: Bindings }>) => {
  if (!isRootRequest(c)) {
    return c.text("Invalid login", 401);
  }

  return null;
};

const requireUser = async (
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

const requireUserWrite = async (
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

const isValidMd5 = (value: string): boolean => /^[a-f0-9]{32}$/.test(value);
const supportedPartialUploadAlgorithms = new Set([
  "bsdiff",
  "xdelta",
  "vcdiff",
  "xdiff",
]);

const parseFileParams = async (
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

const getUploadBaseURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/users/${userID}/items/${itemKey}/file`;
};

const getRawFileURL = (
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

const getPublicationRawFileURL = (
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

const getPublicationFileViewURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/users/${userID}/publications/items/${itemKey}/file/view`;
};

const getGroupUploadBaseURL = (
  c: Context<{ Bindings: Bindings }>,
  groupID: number,
  itemKey: string
): string => {
  const url = new URL(c.req.url);
  return `${url.origin}/groups/${groupID}/items/${itemKey}/file`;
};

const getGroupRawFileURL = (
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

const parseUploadBody = async (request: Request): Promise<ArrayBuffer> => {
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

const responseBodyToArrayBuffer = async (
  body: ArrayBuffer | ReadableStream
): Promise<ArrayBuffer> => {
  if (body instanceof ArrayBuffer) {
    return body;
  }

  return new Response(body).arrayBuffer();
};

const formatAttachmentContentType = (file: {
  charset?: string | null;
  contentType?: string | null;
}): string => {
  if (!(file.contentType && file.charset)) {
    return file.contentType ?? "application/octet-stream";
  }

  return `${file.contentType}; charset=${file.charset}`;
};

const rawFileURLLifetimeSeconds = 300;

const createSignedRawFileURL = async (
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

const requireSignedRawFileURL = async (
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

const signRawFileURL = async (
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

const getRawFileURLSecret = (c: Context<{ Bindings: Bindings }>): string =>
  c.env.RAW_FILE_URL_SECRET ??
  c.env.ROOT_PASSWORD ??
  c.env.ZOTERO_API_KEY ??
  "local-dev-raw-file-secret";

const arrayBufferToHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
};

const bytesPerMegabyte = 1024 * 1024;

const bytesToMegabytes = (bytes: number): number =>
  Math.round((bytes / bytesPerMegabyte) * 10) / 10;

const checkStorageQuota = async (
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

const renderStorageAdminXML = (input: {
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

const parseStorageQuota = (
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

const ttsVoices = {
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

const validTTSVoices = new Set(
  [...ttsVoices.standard, ...ttsVoices.premium].flatMap((provider) =>
    Object.values(provider.locales).flatMap((groups) => groups.default)
  )
);

const requireTTSAccess = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  return (await createCompatibilityStore(c.env).getUserIDForApiKey(apiKey)) !== null;
};

const getTTSTestKey = (c: Context<{ Bindings: Bindings }>) =>
  c.env.TTS_TEST_KEY ?? c.env.ZOTERO_API_KEY ?? "local-tts-test-key";

const getTTSAudioID = (voice: string, text: string) => {
  let hash = 0x811c9dc5;
  for (const char of `${voice}\n${text}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return Math.abs(hash).toString(16);
};

const localSilentWav = Uint8Array.from([
  82, 73, 70, 70, 236, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32,
  16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0,
  2, 0, 16, 0, 100, 97, 116, 97, 200, 0, 0, 0,
  ...new Array(200).fill(0),
]);

const requireGroup = async (
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

const requireGroupEdit = async (
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

const requireGroupAdmin = async (
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

const requireGroupFileEdit = async (
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

const parseGroupUsersXML = (
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

const renderGroupUsersXML = (
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

const getRequestedCollectionKeys = (
  c: Context<{ Bindings: Bindings }>
): string[] | undefined => c.req.query("collectionKey")?.split(",");

const paginateRecords = <T>(
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

const parseNonNegativeInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const filterCollectionsForRequest = (
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

  return sortRecordsForRequest(c, filtered, (collection, field) => {
    if (field === "title" || field === "name") {
      return String(collection.data?.name ?? collection.key);
    }
    if (field === "dateModified" || field === "dateAdded") {
      return collection.version ?? 0;
    }

    return String(collection.key);
  });
};

const renderCollectionList = (
  c: Context<{ Bindings: Bindings }>,
  collections: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const filtered = filterCollectionsForRequest(c, collections);
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

  return c.json(page.records, 200, {
    "Last-Modified-Version": `${version}`,
    ...page.headers,
  });
};

const filterChildItems = <T extends { data: Record<string, unknown> }>(
  items: T[],
  parentItemKey: string
): T[] => items.filter((item) => item.data.parentItem === parentItemKey);

const renderItemList = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

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

const renderItemListHead = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{ data?: Record<string, unknown>; key: string; version?: number }>,
  version: number
) => {
  const page = paginateRecords(c, sortItemsForRequest(c, items));
  return c.body(null, 200, itemListHeaders(version, page.headers));
};

const renderSingleItem = (
  c: Context<{ Bindings: Bindings }>,
  item: { data?: Record<string, unknown>; key: string; version?: number },
  version: number
) => {
  const libraryID = getRequestLibraryID(c);
  const format = c.req.query("format");
  const content = c.req.query("content");
  const style = c.req.query("style");
  const responseItem = shapeItemForSchemaRequest(c, item);

  if (isExportFormat(format)) {
    return c.text(renderExportBody([responseItem], format, libraryID), 200, {
      "Content-Type": exportContentType(format),
      "Last-Modified-Version": `${version}`,
    });
  }

  if (wantsItemAtomResponse(c, format, content)) {
    return c.text(renderItemAtomFeed([responseItem], content, libraryID, style), 200, {
      "Content-Type": "application/atom+xml",
      "Last-Modified-Version": `${version}`,
      "Total-Results": "1",
    });
  }

  return c.json(
    withItemIncludes(responseItem, c.req.query("include"), libraryID, style),
    200,
    {
      "Last-Modified-Version": `${version}`,
    }
  );
};

const itemListHeaders = (version: number, headers: Record<string, string>) => ({
    "Last-Modified-Version": `${version}`,
    ...headers,
});

const acceptsAtom = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Accept") ?? "")
    .split(",")
    .map((entry) => entry.trim().split(";")[0])
    .includes("application/atom+xml");

const wantsItemAtomResponse = (
  c: Context<{ Bindings: Bindings }>,
  format: string | undefined,
  content: string | undefined
) =>
  format === "atom" ||
  isBibliographyContent(content ?? null) ||
  (!format && acceptsAtom(c));

const getCanonicalFeedHref = (c: Context<{ Bindings: Bindings }>): string => {
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

const isAndroidClient = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("User-Agent") ?? "").toLowerCase().includes("android");

const isEPUBAnnotationPosition = (value: unknown): boolean => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) && parsed.type === "FragmentSelector";
  } catch {
    return false;
  }
};

const shapeItemForSchemaRequest = <T extends {
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

const sortItemsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{ data?: Record<string, unknown>; key: string; version?: number }>
) =>
  sortRecordsForRequest(c, items, (item, field) => getItemSortValue(item, field));

const sortRecordsForRequest = <T>(
  c: Context<{ Bindings: Bindings }>,
  records: T[],
  getValue: (record: T, field: string) => number | string
): T[] => {
  const rawSort = c.req.query("sort") ?? c.req.query("order");
  const sortAsDirection = rawSort === "asc" || rawSort === "desc";
  const field = sortAsDirection ? "dateModified" : rawSort ?? "dateModified";
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

const getItemSortValue = (
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

const getCreatorSortValue = (item: {
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

const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

const getRequestLibraryID = (c: Context<{ Bindings: Bindings }>): number => {
  const userID = parseNumericID(c.req.param("userID") || "0");
  if (userID !== null && userID > 0) {
    return userID;
  }

  const groupID = parseNumericID(c.req.param("groupID") || "0");
  return groupID ?? 0;
};

const filterItemsForRequest = async (
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

const requestAllowsUserNotes = async (
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

const handleWebTranslationWrite = async (
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

const getTranslatedTitle = (url: string): string | null => {
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

const isMultipleTranslationURL = (url: string): boolean =>
  url === "https://zotero-static.s3.amazonaws.com/test-multiple.html";

const getTranslationToken = (url: string): string => {
  let hash = 0x811c9dc5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }

  return Math.abs(hash).toString(16).padStart(8, "0").repeat(4).slice(0, 32);
};

const tagWriteFailureResponse = (
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

type ItemWriteFailure = {
  code: number;
  data?: Record<string, unknown>;
  message: string;
};

type ItemWriteFailures = Record<string, ItemWriteFailure>;

const mergeItemWriteFailures = (
  target: ItemWriteFailures,
  source: ItemWriteFailures
) => {
  for (const [index, failure] of Object.entries(source)) {
    if (!(index in target)) {
      target[index] = failure;
    }
  }
};

type ExistingObjectVersions = Map<
  string,
  { data: Record<string, unknown>; version: number }
>;

type BatchWritePreconditionResult = {
  failed: ItemWriteFailures;
  libraryPreconditionFailed: boolean;
  toWrite: Array<{ index: number; object: Record<string, unknown> }>;
  unchanged: Record<string, string>;
};

// Implements Zotero's version-precondition contract for batch writes:
// library-level `If-Unmodified-Since-Version`, per-object `version` property
// semantics (0 = must-not-exist, matching = update, stale = 412), and the
// unchanged/failed buckets. See references/dataserver .../version.test.js.
const evaluateBatchWritePreconditions = (
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
const buildWriteReport = (
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

const renderTagList = (
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

const getURLSearchParams = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).searchParams;

const collectionFailureResponse = (
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

const getIfUnmodifiedSinceVersion = (
  c: Context<{ Bindings: Bindings }>
): number | null => {
  const value = c.req.header("If-Unmodified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const getSinceOrNewerVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since") ?? c.req.query("newer");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const hasJSONContentType = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json");

const hasDirectCollections = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.collections) && data.collections.length > 0;

const isChildItemData = (data: Record<string, unknown>): boolean =>
  typeof data.parentItem === "string" && data.parentItem.length > 0;

const isEmbeddedImageAttachment = (data: Record<string, unknown>): boolean =>
  data.itemType === "attachment" && data.linkMode === "embedded_image";

const mergeItemUpdate = (
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  itemKey: string,
  patchMode: boolean
): Record<string, unknown> => ({
  ...(patchMode ? existing : {}),
  ...body,
  key: itemKey,
});

const normalizeItemDeletedForWrite = (data: Record<string, unknown>) => {
  if (data.deleted === true) {
    data.deleted = 1;
  } else if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};

const normalizeItemParentForWrite = (data: Record<string, unknown>) => {
  if (data.parentItem === false) {
    delete data.parentItem;
  }

  return data;
};

const normalizeObjectDeletedForWrite = (data: Record<string, unknown>) => {
  if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};

const normalizeItemBatchDeletedForWrite = (items: Record<string, unknown>[]) =>
  items.map((item) => normalizeItemParentForWrite(normalizeItemDeletedForWrite(item)));

const normalizeObjectBatchDeletedForWrite = (objects: Record<string, unknown>[]) =>
  objects.map(normalizeObjectDeletedForWrite);

const creatorHasName = (creator: Record<string, unknown>) =>
  ["name", "firstName", "lastName"].some(
    (field) => typeof creator[field] === "string" && creator[field].trim() !== ""
  );

const validateItemCreatorsForWrite = (
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

const validateItemBatchCreatorsForWrite = (
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

const annotationSortIndexPattern = /^\d{5}\|\d+(?:\|\d{5})?$/;
const annotationColorPattern = /^#[0-9a-fA-F]{6}$/;
const annotationTextTypes = new Set(["highlight", "underline"]);
const annotationParentContentTypes = new Set([
  "application/epub+zip",
  "application/pdf",
  "application/xhtml+xml",
  "text/html",
]);

const stringifyAnnotationPosition = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? {});

const truncateAnnotationText = (value: unknown): unknown =>
  typeof value === "string" && Array.from(value).length > 7500
    ? Array.from(value).slice(0, 7500).join("")
    : value;

const normalizeAnnotationForWrite = (
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

const validateItemBatchAnnotationsForWrite = (
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

const getAnnotationParentFailure = (
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

const getParentMap = (
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

const getItemParentFailure = (
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

const validateItemParentForWrite = async (
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

const validateItemBatchParentsForWrite = async (
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

const validateAnnotationParentForWrite = async (
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

const validateItemBatchAnnotationParentsForWrite = async (
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

const syncRelatedItemRelations = async (
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

const updateItemInLibrary = async (
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
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid item JSON", 400);
  }

  if (!existing && (input.patchMode || preconditionVersion !== 0)) {
    return c.text("Item not found", 404);
  }

  if (
    existing &&
    preconditionVersion !== null &&
    existing.version > preconditionVersion
  ) {
    return c.text("Object has been modified", 412);
  }

  const data = normalizeItemDeletedForWrite(
    mergeItemUpdate(
      existing?.data ?? {},
      body as Record<string, unknown>,
      input.itemKey,
      input.patchMode
    )
  );
  if (input.patchMode && !("parentItem" in body) && hasDirectCollections(data)) {
    delete data.parentItem;
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

const upsertCollectionInLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    collectionKey: string;
    libraryID: number;
    libraryType: "group" | "user";
  }
) => {
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid collection JSON", 400);
  }

  const collectionStore = createCollectionStore(c.env);
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  const existing = await collectionStore.getCollection(
    input.libraryType,
    input.libraryID,
    input.collectionKey
  );

  if (!existing && preconditionVersion !== 0) {
    return c.text("Collection not found", 404);
  }
  if (
    existing &&
    preconditionVersion !== null &&
    existing.collection.version > preconditionVersion
  ) {
    return c.text("Collection has been modified", 412);
  }

  const collectionData = normalizeObjectDeletedForWrite(
    body as Record<string, unknown>
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

const getPublicationItem = async (
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

const renderPublicationItemAtom = (
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

const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const renderJSONAtomEntry = (input: {
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

const renderJSONAtomFeed = (title: string, entries: string[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    `<title>${escapeXML(title)}</title>`,
    ...entries,
    "</feed>",
  ].join("");

const atomHeaders = (version: number, total?: number) => ({
  "Content-Type": "application/atom+xml",
  "Last-Modified-Version": `${version}`,
  ...(total === undefined ? {} : { "Total-Results": `${total}` }),
});

const jsonListHeaders = (version: number, total: number) => ({
  "Last-Modified-Version": `${version}`,
  "Total-Results": `${total}`,
});

const wantsAtomResponse = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("format") === "atom" || c.req.query("content") === "json";

const isHeadRequest = (c: Context<{ Bindings: Bindings }>) =>
  c.req.method.toUpperCase() === "HEAD";


const withPublicationLinks = (
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

compatibility.post("/test/setup", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = Number.parseInt(c.req.query("u") ?? "1", 10);
  const userID2 = Number.parseInt(c.req.query("u2") ?? "2", 10);
  const user1Key = c.env.ZOTERO_API_KEY || generateZoteroKey().toLowerCase();
  const user2Key = generateZoteroKey().toLowerCase();
  const store = createCompatibilityStore(c.env);
  clearMemoryCollections();
  clearMemoryDeleted();
  clearMemorySearches();
  clearMemorySettings();

  return c.json(
    await store.setupTestUsers(userID, userID2, user1Key, user2Key)
  );
});

compatibility.get("/tts/voices", (c) => c.json(ttsVoices));

compatibility.get("/tts/credits", (c) =>
  c.json({
    premiumCreditsRemaining: 1_000_000,
    standardCreditsRemaining: 1_000_000,
  })
);

compatibility.post("/tts/speak", async (c) => {
  if (!(await requireTTSAccess(c))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) {
    return c.text("Invalid JSON", 400);
  }
  if (body.test !== getTTSTestKey(c)) {
    return c.text("Invalid test key", 403);
  }
  if (typeof body.voice !== "string") {
    return c.text("Voice not provided", 400);
  }
  if (typeof body.text !== "string") {
    return c.text("Text not provided", 400);
  }
  if (!validTTSVoices.has(body.voice)) {
    return c.text("Invalid voice", 400);
  }

  const url = new URL(c.req.url);
  const audioID = getTTSAudioID(body.voice, body.text);
  return c.redirect(`${url.origin}/tts/audio/${audioID}.wav`, 302);
});

compatibility.get("/tts/audio/:audioID", (c) =>
  c.body(localSilentWav.buffer.slice(0), 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "audio/wav",
  })
);

const readKeyRequestBody = async (c: Context<{ Bindings: Bindings }>) =>
  c.req.json().catch(() => ({}));

const requireKeyRoot = (c: Context<{ Bindings: Bindings }>) =>
  isRootRequest(c) ? null : c.text("Invalid key", 403);

const getLoginBaseURL = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).origin;

const keyAccessNotificationHeaders = async (
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

const allGroupAccessNotifications = async (
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

const getKeyAccessGroupIDs = async (
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const renderGroupCreateAtom = (groupID: number): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    "<entry>",
    `<zapi:groupID>${groupID}</zapi:groupID>`,
    "</entry>",
    "</feed>",
  ].join("");

const isPublicGroupRecord = (group: {
  data?: { type?: string };
}) => group.data?.type === "PublicOpen" || group.data?.type === "PublicClosed";

const getGroupVersion = (group: { data?: Record<string, unknown> }) => {
  const version = group.data?.version;
  return typeof version === "number" ? version : 1;
};

const getGroupSelfHref = (c: Context<{ Bindings: Bindings }>, groupID: number) =>
  `${new URL(c.req.url).origin}/groups/${groupID}`;

const groupResponse = async (
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

const filterGroupsForRequest = (
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

const renderUserGroupsAtom = (
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

const renderGroupUpdateAtom = (group: { data: Record<string, unknown>; id: number }) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zxfer="http://zotero.org/ns/transfer">',
    '<content type="application/xml">',
    `<zxfer:group name="${escapeXML(String(group.data.name ?? ""))}"/>`,
    "</content>",
    "</entry>",
  ].join("");

const parseGroupXML = (body: string): Record<string, unknown> => {
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

compatibility.get("/keys/current", async (c) => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  if (!key) {
    return c.text("Invalid key", 403);
  }

  return c.json(publicKeyInfo(key));
});

compatibility.get("/users/:userID/keys/current", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  return c.json(publicKeyInfo(key));
});

compatibility.post("/keys/sessions", async (c) => {
  const body = await readKeyRequestBody(c);
  const result = await createKeyStore(c.env).createSession({
    currentApiKey: getRequestApiKey(c),
    loginBaseURL: getLoginBaseURL(c),
    userAgent: c.req.header("User-Agent"),
    userID: body.userID,
  });

  return c.json(result, 201);
});

compatibility.get("/keys/sessions/:sessionToken", async (c) => {
  const status = await createKeyStore(c.env).getSessionStatus(
    c.req.param("sessionToken")
  );
  if (!status) {
    return c.text("Session not found", 404);
  }

  return c.json(status);
});

compatibility.delete("/keys/sessions/:sessionToken", async (c) => {
  const result = await createKeyStore(c.env).cancelSession(
    c.req.param("sessionToken")
  );
  if (result === "missing") {
    return c.text("Session not found", 404);
  }
  if (result === "conflict") {
    return c.text("Session cannot be cancelled", 409);
  }

  return c.body(null, 204);
});

compatibility.get("/keys/sessions/:sessionToken/info", async (c) => {
  const rootError = requireKeyRoot(c);
  if (rootError) {
    return rootError;
  }

  const info = await createKeyStore(c.env).getSessionInfo(
    c.req.param("sessionToken")
  );
  if (!info) {
    return c.text("Session not found", 404);
  }

  return c.json(info);
});

compatibility.post("/keys/sessions/complete", async (c) => {
  const rootError = requireKeyRoot(c);
  if (rootError) {
    return rootError;
  }

  const result = await createKeyStore(c.env).completeSession(
    await readKeyRequestBody(c)
  );
  if (result === "invalid") {
    return c.text("Invalid session completion", 400);
  }
  if (result === "missing") {
    return c.text("Session not found", 404);
  }
  if (result === "conflict") {
    return c.text("Session cannot be completed", 409);
  }

  return c.body(null, 204);
});

compatibility.get("/keys/:apiKey", async (c) => {
  const key = await createKeyStore(c.env).getKey(c.req.param("apiKey"));
  if (!key) {
    return c.text("Invalid key", 403);
  }

  return c.json(publicKeyInfo(key));
});

compatibility.get("/users/:userID/keys/:apiKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const key = await createKeyStore(c.env).getKey(c.req.param("apiKey"));
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  return c.json(publicKeyInfo(key));
});

compatibility.get("/users/:userID/keys", async (c) => {
  const rootError = requireKeyRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keys = await createKeyStore(c.env).listUserKeys(userID);
  return c.json(keys.map(managedKeyInfo));
});

compatibility.post("/users/:userID/keys", async (c) => {
  const rootError = requireKeyRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const body = await readKeyRequestBody(c);
  const key = await createKeyStore(c.env).createKey({
    access: body.access,
    name: body.name,
    userID,
  });

  return c.json(managedKeyInfo(key), 201);
});

compatibility.post("/keys", async (c) => {
  const body = await readKeyRequestBody(c);
  const keyStore = createKeyStore(c.env);
  const userID = await keyStore.resolveCredentials(body);
  if (userID === null) {
    return c.text("Invalid login", 403);
  }

  const key = await keyStore.createKey({
    access: body.access,
    name: body.name,
    userID,
  });

  return c.json(managedKeyInfo(key), 201);
});

compatibility.put("/keys/:apiKey", async (c) => {
  const apiKey = c.req.param("apiKey");
  const keyStore = createKeyStore(c.env);
  const existing = await keyStore.getKey(apiKey);
  if (!existing) {
    return c.text("Invalid key", 403);
  }

  const body = await readKeyRequestBody(c);
  const credentialUserID = await keyStore.resolveCredentials(body);
  const requestApiKey = getRequestApiKey(c);
  if (
    !isRootRequest(c) &&
    requestApiKey !== apiKey &&
    credentialUserID !== existing.userID
  ) {
    return c.text("Invalid login", 403);
  }

  const updated = await keyStore.updateKey(apiKey, {
    access: body.access,
    name: body.name,
  });
  if (!updated) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    managedKeyInfo(updated),
    200,
    await keyAccessNotificationHeaders(
      createCompatibilityStore(c.env),
      existing,
      updated
    )
  );
});

compatibility.put("/users/:userID/keys/:apiKey", async (c) => {
  const rootError = requireKeyRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keyStore = createKeyStore(c.env);
  const existing = await keyStore.getKey(c.req.param("apiKey"));
  if (!existing || existing.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  const body = await readKeyRequestBody(c);
  const updated = await keyStore.updateKey(existing.key, {
    access: body.access,
    name: body.name,
  });

  const nextKey = updated ?? existing;
  return c.json(
    managedKeyInfo(nextKey),
    200,
    await keyAccessNotificationHeaders(
      createCompatibilityStore(c.env),
      existing,
      nextKey
    )
  );
});

compatibility.delete("/keys/current", async (c) => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const deleted = await createKeyStore(c.env).deleteKey(apiKey);
  return deleted ? c.body(null, 204) : c.text("Invalid key", 403);
});

compatibility.delete("/users/:userID/keys/current", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  await keyStore.deleteKey(apiKey);
  return c.body(null, 204);
});

compatibility.delete("/keys/:apiKey", async (c) => {
  const apiKey = c.req.param("apiKey");
  const requestApiKey = getRequestApiKey(c);
  if (!(isRootRequest(c) || requestApiKey === apiKey)) {
    return c.text("Invalid key", 403);
  }

  const deleted = await createKeyStore(c.env).deleteKey(apiKey);
  return deleted ? c.body(null, 204) : c.text("Invalid key", 403);
});

compatibility.delete("/users/:userID/keys/:apiKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(c.req.param("apiKey"));
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  await keyStore.deleteKey(key.key);
  return c.body(null, 204);
});

const settingHeaders = (version: number) => ({
  "Last-Modified-Version": `${version}`,
});

const renderSettingsList = (
  c: Context<{ Bindings: Bindings }>,
  result: { settings: Record<string, unknown>; version: number }
) => {
  if (requestIsNotModified(c, result.version)) {
    return c.body(null, 304, settingHeaders(result.version));
  }

  return c.json(result.settings, 200, settingHeaders(result.version));
};

const getSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const since = c.req.query("since");
  if (since === undefined) {
    return null;
  }

  const parsed = Number.parseInt(since, 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const getRequestedSettingKeys = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.query("settingKey") ?? "")
    .split(",")
    .map((settingKey) => settingKey.trim())
    .filter(Boolean);

const isSettingsObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSettingsBody = async (c: Context<{ Bindings: Bindings }>) =>
  parseSettingsRequestBody(await c.req.text());

const renderSettingsWriteFailure = (
  c: Context<{ Bindings: Bindings }>,
  failure: { code: number; message: string }
) => c.text(failure.message, failure.code as 400 | 403 | 412 | 413);

const ensureSingleSettingPrecondition = (
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

compatibility.get("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).getSetting(
    "group",
    groupID,
    c.req.param("settingKey")
  );
  if (!result) {
    return c.text("Setting not found", 404);
  }

  return c.json(result.setting, 200, settingHeaders(result.setting.version));
});

compatibility.put("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  if (isAdminOnlySettingKey(settingKey) && !canAdmin) {
    return c.text(`Only group admins can change setting '${settingKey}'`, 403);
  }

  const settingsStore = createSettingsStore(c.env);
  const existing = await settingsStore.getSetting("group", groupID, settingKey);
  const ifUnmodifiedSinceVersion = getIfUnmodifiedSinceVersion(c);
  if (ensureSingleSettingPrecondition(existing, ifUnmodifiedSinceVersion)) {
    return c.text("Precondition failed", 412);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await settingsStore.upsertSettings(
    "group",
    groupID,
    [[settingKey, body as SettingPayload]],
    null,
    canAdmin
  );
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return renderSettingsWriteFailure(c, firstFailure);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  if (isAdminOnlySettingKey(settingKey) && !(await requireGroupAdmin(c, compatibilityStore, groupID))) {
    return c.text(`Only group admins can change setting '${settingKey}'`, 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "group",
    groupID,
    [settingKey],
    getIfUnmodifiedSinceVersion(c),
    true
  );
  if (result.notFound) {
    return c.text("Setting not found", 404);
  }
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).listSettings(
    "group",
    groupID,
    getSinceVersion(c)
  );

  return renderSettingsList(c, result);
});

compatibility.post("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  const result = await createSettingsStore(c.env).upsertSettings(
    "group",
    groupID,
    Object.entries(body) as Array<[string, SettingPayload]>,
    getIfUnmodifiedSinceVersion(c),
    canAdmin
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }
  if (Object.keys(result.failed).length > 0) {
    return c.json(
      { failed: result.failed, successful: result.successful, unchanged: result.unchanged },
      200,
      settingHeaders(result.version)
    );
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKeys = getRequestedSettingKeys(c);
  if (!settingKeys.length) {
    return c.text("settingKey parameter not provided", 400);
  }

  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  const restrictedKey = settingKeys.find((settingKey) => isAdminOnlySettingKey(settingKey) && !canAdmin);
  if (restrictedKey) {
    return c.text(`Only group admins can change setting '${restrictedKey}'`, 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "group",
    groupID,
    settingKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).getSetting(
    "user",
    userID,
    c.req.param("settingKey")
  );
  if (!result) {
    return c.text("Setting not found", 404);
  }

  return c.json(result.setting, 200, settingHeaders(result.setting.version));
});

compatibility.put("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, compatibilityStore, userID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  const settingsStore = createSettingsStore(c.env);
  const existing = await settingsStore.getSetting("user", userID, settingKey);
  const ifUnmodifiedSinceVersion = getIfUnmodifiedSinceVersion(c);
  if (ensureSingleSettingPrecondition(existing, ifUnmodifiedSinceVersion)) {
    return c.text("Precondition failed", 412);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await settingsStore.upsertSettings(
    "user",
    userID,
    [[settingKey, body as SettingPayload]],
    null
  );
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return renderSettingsWriteFailure(c, firstFailure);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "user",
    userID,
    [c.req.param("settingKey")],
    getIfUnmodifiedSinceVersion(c),
    true
  );
  if (result.notFound) {
    return c.text("Setting not found", 404);
  }
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).listSettings(
    "user",
    userID,
    getSinceVersion(c)
  );

  return renderSettingsList(c, result);
});

compatibility.post("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await createSettingsStore(c.env).upsertSettings(
    "user",
    userID,
    Object.entries(body) as Array<[string, SettingPayload]>,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }
  if (Object.keys(result.failed).length > 0) {
    return c.json(
      { failed: result.failed, successful: result.successful, unchanged: result.unchanged },
      200,
      settingHeaders(result.version)
    );
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const settingKeys = getRequestedSettingKeys(c);
  if (!settingKeys.length) {
    return c.text("settingKey parameter not provided", 400);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "user",
    userID,
    settingKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

const getDeletedTagNames = (c: Context<{ Bindings: Bindings }>) =>
  getURLSearchParams(c)
    .getAll("tag")
    .flatMap((expression) => expression.split(" || "))
    .map((tag) => tag.trim())
    .filter(Boolean);

const deleteTagsForLibrary = async (
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

compatibility.get("/groups/:groupID/collections/:collectionKey/items/top/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "group",
    groupID,
    c.req.param("collectionKey"),
    true
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/groups/:groupID/collections/:collectionKey/items/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "group",
    groupID,
    c.req.param("collectionKey")
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/users/:userID/collections/:collectionKey/items/top/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "user",
    userID,
    c.req.param("collectionKey"),
    true
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/users/:userID/collections/:collectionKey/items/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "user",
    userID,
    c.req.param("collectionKey")
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/groups/:groupID/items/top/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(filterTopItems(result.items), getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/groups/:groupID/items/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/users/:userID/items/top/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(filterTopItems(result.items), getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/users/:userID/items/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.get("/groups/:groupID/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.delete("/groups/:groupID/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteTagsForLibrary(c, {
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});

compatibility.get("/users/:userID/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.delete("/users/:userID/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteTagsForLibrary(c, {
    libraryID: userID,
    libraryType: "user",
    store,
  });
});

compatibility.get("/groups/:groupID/items/top", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const items = await filterItemsForRequest(
    c,
    "group",
    groupID,
    filterTopItems(result.items),
    result.items,
    true
  );

  return renderItemList(c, items, result.version);
});

compatibility.get("/users/:userID/items/top", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const items = await filterItemsForRequest(
    c,
    "user",
    userID,
    filterTopItems(result.items),
    result.items,
    true
  );

  return renderItemList(c, items, result.version);
});

const getRequestedSearchKeys = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("searchKey")?.split(",").filter(Boolean);

const getSearchSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since") ?? c.req.query("newer");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const getIfModifiedSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.header("If-Modified-Since-Version");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const requestIsNotModified = (
  c: Context<{ Bindings: Bindings }>,
  version: number
): boolean => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  return ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion;
};

const getSchemaVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.header("Zotero-Schema-Version") ?? c.req.query("schemaVersion");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const withSearchSchema = (
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

const renderSearchList = (
  c: Context<{ Bindings: Bindings }>,
  searches: Array<{ data: Record<string, unknown>; key: string; version: number }>,
  version: number
) => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  if (ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion) {
    return c.body(null, 304, settingHeaders(version));
  }
  const sortedSearches = sortRecordsForRequest(c, searches, (search, field) =>
    field === "title" || field === "name"
      ? String(search.data.name ?? search.key)
      : search.version
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

const renderSearchWriteResult = (
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

const parseSearchWriteBody = async (c: Context<{ Bindings: Bindings }>) =>
  c.req.json().catch(() => null);

compatibility.get("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch(
    "group",
    groupID,
    c.req.param("searchKey")
  );
  if (!result) {
    return c.text("Search not found", 404);
  }

  if (isHeadRequest(c)) {
    return c.body(null, 200, settingHeaders(result.search.version));
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: withSearchSchema(c, result.search).data,
        id: `searches/${result.search.key}`,
        key: result.search.key,
        title: String(result.search.data.name ?? result.search.key),
        version: result.search.version,
      }),
      200,
      atomHeaders(result.search.version)
    );
  }

  return c.json(withSearchSchema(c, result.search), 200, settingHeaders(result.search.version));
});

compatibility.put("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }
  const searchStore = createSearchStore(c.env);
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  const existing = await searchStore.getSearch(
    "group",
    groupID,
    c.req.param("searchKey")
  );
  if (!existing && preconditionVersion !== 0) {
    return c.text("Search not found", 404);
  }

  const searchData = normalizeObjectDeletedForWrite(body);
  const result = await searchStore.upsertSearches(
    "group",
    groupID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    existing ? preconditionVersion : null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.patch("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const searchData = normalizeObjectDeletedForWrite(body);
  const result = await createSearchStore(c.env).upsertSearches(
    "group",
    groupID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "group",
    groupID,
    [c.req.param("searchKey")],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("group", groupID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});

compatibility.post("/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!Array.isArray(body)) {
    return c.text("Expected a search array", 400);
  }

  const searches = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const result = await createSearchStore(c.env).upsertSearches(
    "group",
    groupID,
    searches,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return renderSearchWriteResult(c, result);
});

compatibility.delete("/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "group",
    groupID,
    getRequestedSearchKeys(c) ?? [],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch(
    "user",
    userID,
    c.req.param("searchKey")
  );
  if (!result) {
    return c.text("Search not found", 404);
  }

  if (isHeadRequest(c)) {
    return c.body(null, 200, settingHeaders(result.search.version));
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: withSearchSchema(c, result.search).data,
        id: `searches/${result.search.key}`,
        key: result.search.key,
        title: String(result.search.data.name ?? result.search.key),
        version: result.search.version,
      }),
      200,
      atomHeaders(result.search.version)
    );
  }

  return c.json(withSearchSchema(c, result.search), 200, settingHeaders(result.search.version));
});

compatibility.put("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }
  const searchStore = createSearchStore(c.env);
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  const existing = await searchStore.getSearch(
    "user",
    userID,
    c.req.param("searchKey")
  );
  if (!existing && preconditionVersion !== 0) {
    return c.text("Search not found", 404);
  }

  const searchData = normalizeObjectDeletedForWrite(body);
  const result = await searchStore.upsertSearches(
    "user",
    userID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    existing ? preconditionVersion : null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.patch("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const searchData = normalizeObjectDeletedForWrite(body);
  const result = await createSearchStore(c.env).upsertSearches(
    "user",
    userID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.delete("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "user",
    userID,
    [c.req.param("searchKey")],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

compatibility.get("/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("user", userID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});

compatibility.post("/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!Array.isArray(body)) {
    return c.text("Expected a search array", 400);
  }

  const searches = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const result = await createSearchStore(c.env).upsertSearches(
    "user",
    userID,
    searches,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return renderSearchWriteResult(c, result);
});

compatibility.delete("/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "user",
    userID,
    getRequestedSearchKeys(c) ?? [],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});

const getRequiredSinceVersion = (c: Context<{ Bindings: Bindings }>): number | null => {
  const value = c.req.query("since");
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const getItemKeysForDelete = (
  c: Context<{ Bindings: Bindings }>,
  itemKey?: string
): string[] => {
  const rawKeys = itemKey ?? c.req.query("itemKey") ?? "";
  return rawKeys.split(",").map((key) => key.trim()).filter(Boolean);
};

const getLastPageIndexSettingKeys = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKeys: string[]
) =>
  itemKeys.map((itemKey) =>
    libraryType === "user"
      ? `lastPageIndex_u_${itemKey}`
      : `lastPageIndex_g${libraryID}_${itemKey}`
  );

const cleanupLastPageIndexSettings = async (
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

const deleteItemsForLibrary = async (
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

compatibility.get("/groups/:groupID/deleted", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const sinceVersion = getRequiredSinceVersion(c);
  if (sinceVersion === null) {
    return c.text("'since' parameter must be provided", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createDeletedStore(c.env).listDeleted(
    "group",
    groupID,
    sinceVersion
  );

  return c.json(result.deleted, 200, settingHeaders(result.version));
});

compatibility.get("/users/:userID/deleted", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const sinceVersion = getRequiredSinceVersion(c);
  if (sinceVersion === null) {
    return c.text("'since' parameter must be provided", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createDeletedStore(c.env).listDeleted(
    "user",
    userID,
    sinceVersion
  );

  return c.json(result.deleted, 200, settingHeaders(result.version));
});

compatibility.delete("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c, c.req.param("itemKey")),
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});

compatibility.delete("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c),
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});

compatibility.delete("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c, c.req.param("itemKey")),
    libraryID: userID,
    libraryType: "user",
    store,
  });
});

compatibility.delete("/users/:userID/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c),
    libraryID: userID,
    libraryType: "user",
    store,
  });
});


compatibility.on("HEAD","/groups/:groupID/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.on("HEAD","/users/:userID/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});

compatibility.on("HEAD","/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch("group", groupID, c.req.param("searchKey"));
  if (!result) {
    return c.text("Search not found", 404);
  }

  return c.body(null, 200, settingHeaders(result.search.version));
});

compatibility.on("HEAD","/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("group", groupID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});

compatibility.on("HEAD","/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch("user", userID, c.req.param("searchKey"));
  if (!result) {
    return c.text("Search not found", 404);
  }

  return c.body(null, 200, settingHeaders(result.search.version));
});

compatibility.on("HEAD","/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("user", userID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});


compatibility.get("/groups/:groupID/items/:itemKey/children", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const parent = await store.getGroupItem(groupID, c.req.param("itemKey"));
  if (!parent) {
    return c.text("Item not found", 404);
  }

  const result = await store.listGroupItems(groupID);
  const items = await filterItemsForRequest(
    c,
    "group",
    groupID,
    filterChildItems(result.items, c.req.param("itemKey")),
    result.items
  );

  return renderItemList(c, items, result.version);
});

compatibility.get("/users/:userID/items/:itemKey/children", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const parent = await store.getItem(userID, c.req.param("itemKey"));
  if (!parent) {
    return c.text("Item not found", 404);
  }

  const result = await store.listItems(userID);
  const items = await filterItemsForRequest(
    c,
    "user",
    userID,
    filterChildItems(result.items, c.req.param("itemKey")),
    result.items
  );

  return renderItemList(c, items, result.version);
});

compatibility.get("/itemTypes", (c) =>
  c.json(getItemTypes(c.req.query("locale") ?? "en-US"))
);

compatibility.get("/itemFields", (c) => c.json(getItemFields()));

compatibility.get("/itemTypeFields", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }

  const fields = getItemTypeFields(itemType);
  if (!fields || itemType === "annotation") {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  return c.json(fields);
});

compatibility.get("/itemTypeCreatorTypes", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }
  if (!validItemTypes.has(itemType) || itemType === "annotation") {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  return c.json(getItemTypeCreatorTypes(itemType));
});

compatibility.get("/creatorFields", (c) => c.json(getCreatorFields()));

compatibility.get("/items/new", (c) => {
  const itemType = c.req.query("itemType");
  if (!itemType) {
    return c.text("'itemType' not provided", 400);
  }

  if (itemType !== "annotation" && !validItemTypes.has(itemType)) {
    return c.text(`Invalid item type '${itemType}'`, 400);
  }

  const linkMode = c.req.query("linkMode");
  if (itemType === "attachment") {
    if (!linkMode) {
      return c.text("linkMode required for itemType=attachment", 400);
    }
    if (!isSupportedAttachmentLinkMode(linkMode)) {
      return c.text(`Invalid linkMode '${linkMode}'`, 400);
    }
  }

  const annotationType = c.req.query("annotationType");
  if (itemType === "annotation") {
    if (!annotationType) {
      return c.text("annotationType required for itemType=annotation", 400);
    }
    if (!isSupportedAnnotationType(annotationType)) {
      return c.text(`Invalid annotationType '${annotationType}'`, 400);
    }
  }

  return c.json(getItemTemplate(itemType, linkMode, annotationType));
});

compatibility.get("/groups/:groupID/collections/:collectionKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createCollectionStore(c.env).getCollection(
    "group",
    groupID,
    c.req.param("collectionKey")
  );
  if (!result) {
    return c.text("Collection not found", 404);
  }

  return c.json(result.collection, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.get(
  "/groups/:groupID/collections/:collectionKey/items/top",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroup(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    const collectionStore = createCollectionStore(c.env);
    const collection = await collectionStore.getCollection(
      "group",
      groupID,
      c.req.param("collectionKey")
    );
    if (!collection) {
      return c.text("Collection not found", 404);
    }

    const result = await collectionStore.listCollectionItems(
      "group",
      groupID,
      c.req.param("collectionKey"),
      true
    );
    const allResult = await collectionStore.listCollectionItems(
      "group",
      groupID,
      c.req.param("collectionKey")
    );
    const items = await filterItemsForRequest(
      c,
      "group",
      groupID,
      result.items,
      allResult.items,
      true
    );

    return renderItemList(c, items, result.version);
  }
);

compatibility.get(
  "/groups/:groupID/collections/:collectionKey/items",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroup(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    const collectionStore = createCollectionStore(c.env);
    const collection = await collectionStore.getCollection(
      "group",
      groupID,
      c.req.param("collectionKey")
    );
    if (!collection) {
      return c.text("Collection not found", 404);
    }

    const result = await collectionStore.listCollectionItems(
      "group",
      groupID,
      c.req.param("collectionKey")
    );
    const items = await filterItemsForRequest(
      c,
      "group",
      groupID,
      result.items
    );

    return renderItemList(c, items, result.version);
  }
);

compatibility.get("/groups/:groupID/collections", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createCollectionStore(c.env).listCollections(
    "group",
    groupID,
    getRequestedCollectionKeys(c)
  );

  return renderCollectionList(c, result.collections, result.version);
});

compatibility.post("/groups/:groupID/collections", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ error: "Expected a collection array" }, 400);
  }

  const collections = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const result = await createCollectionStore(c.env).createCollections(
    "group",
    groupID,
    collections
  );

  return c.json(result, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.put("/groups/:groupID/collections/:collectionKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return upsertCollectionInLibrary(c, {
    collectionKey: c.req.param("collectionKey"),
    libraryID: groupID,
    libraryType: "group",
  });
});

compatibility.delete("/groups/:groupID/collections", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const collectionKeys = getRequestedCollectionKeys(c);
  if (!collectionKeys?.length) {
    return c.text("Collection key not provided", 400);
  }

  const result = await createCollectionStore(c.env).deleteCollections(
    "group",
    groupID,
    collectionKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Collection has been modified", 412);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.get("/users/:userID/collections/:collectionKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createCollectionStore(c.env).getCollection(
    "user",
    userID,
    c.req.param("collectionKey")
  );
  if (!result) {
    return c.text("Collection not found", 404);
  }

  return c.json(result.collection, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.get(
  "/users/:userID/collections/:collectionKey/items/top",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireUser(c, store, userID))) {
      return c.text("Invalid key", 403);
    }

    const collectionStore = createCollectionStore(c.env);
    const collection = await collectionStore.getCollection(
      "user",
      userID,
      c.req.param("collectionKey")
    );
    if (!collection) {
      return c.text("Collection not found", 404);
    }

    const result = await collectionStore.listCollectionItems(
      "user",
      userID,
      c.req.param("collectionKey"),
      true
    );
    const allResult = await collectionStore.listCollectionItems(
      "user",
      userID,
      c.req.param("collectionKey")
    );
    const items = await filterItemsForRequest(
      c,
      "user",
      userID,
      result.items,
      allResult.items,
      true
    );

    return renderItemList(c, items, result.version);
  }
);

compatibility.get(
  "/users/:userID/collections/:collectionKey/items",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireUser(c, store, userID))) {
      return c.text("Invalid key", 403);
    }

    const collectionStore = createCollectionStore(c.env);
    const collection = await collectionStore.getCollection(
      "user",
      userID,
      c.req.param("collectionKey")
    );
    if (!collection) {
      return c.text("Collection not found", 404);
    }

    const result = await collectionStore.listCollectionItems(
      "user",
      userID,
      c.req.param("collectionKey")
    );
    const items = await filterItemsForRequest(
      c,
      "user",
      userID,
      result.items
    );

    return renderItemList(c, items, result.version);
  }
);

compatibility.get("/users/:userID/collections", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createCollectionStore(c.env).listCollections(
    "user",
    userID,
    getRequestedCollectionKeys(c)
  );

  return renderCollectionList(c, result.collections, result.version);
});

compatibility.post("/users/:userID/collections", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.json({ error: "Expected a collection array" }, 400);
  }

  const collections = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const collectionStore = createCollectionStore(c.env);
  const collectionLibrary = await collectionStore.listCollections("user", userID);
  const collectionPrecondition = getIfUnmodifiedSinceVersion(c);
  if (
    collectionPrecondition !== null &&
    collectionPrecondition !== collectionLibrary.version
  ) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${collectionLibrary.version}`,
    });
  }
  const result = await collectionStore.createCollections(
    "user",
    userID,
    collections
  );

  return c.json(result, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.put("/users/:userID/collections/:collectionKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return upsertCollectionInLibrary(c, {
    collectionKey: c.req.param("collectionKey"),
    libraryID: userID,
    libraryType: "user",
  });
});

compatibility.delete("/users/:userID/collections", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const collectionKeys = getRequestedCollectionKeys(c);
  if (!collectionKeys?.length) {
    return c.text("Collection key not provided", 400);
  }

  const result = await createCollectionStore(c.env).deleteCollections(
    "user",
    userID,
    collectionKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Collection has been modified", 412);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.patch("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: groupID,
    libraryType: "group",
    patchMode: true,
    store,
  });
});

compatibility.put("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: groupID,
    libraryType: "group",
    patchMode: false,
    store,
  });
});

compatibility.patch("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: userID,
    libraryType: "user",
    patchMode: true,
    store,
  });
});

compatibility.put("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: userID,
    libraryType: "user",
    patchMode: false,
    store,
  });
});

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

compatibility.get(
  "/groups/:groupID/items/:itemKey/file/raw/:md5/:filename",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const result =
      await createCompatibilityStore(c.env).getGroupAttachmentObject(
        groupID,
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
      "Content-Type": formatAttachmentContentType(result.file),
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
      return c.text("Invalid key", 403);
    }

    const file = await store.getGroupAttachmentFile(
      groupID,
      c.req.param("itemKey")
    );
    if (!file) {
      return c.text("File not found", 404);
    }

    return c.text(
      await getGroupRawFileURL(
        c,
        groupID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
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
    return c.text("Invalid key", 403);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getGroupRawFileURL(c, groupID, c.req.param("itemKey"), file.md5, file.filename),
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
    return c.text("Invalid key", 403);
  }

  const itemKey = c.req.param("itemKey");
  if (!(await store.getGroupItem(groupID, itemKey))) {
    return c.text("Item not found", 404);
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
  });
});

compatibility.get("/groups/:groupID/items/:itemKey/file", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const file = await store.getGroupAttachmentFile(
    groupID,
    c.req.param("itemKey")
  );
  if (!file) {
    return c.text("File not found", 404);
  }

  return c.redirect(
    await getGroupRawFileURL(c, groupID, c.req.param("itemKey"), file.md5, file.filename),
    302
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
  if (!(await store.getGroupItem(groupID, itemKey))) {
    return c.text("Item not found", 404);
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

  if (existingFile && existingFile.md5 === md5) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingFile.version ?? 0}`,
    });
  }

  const quotaUserID = await store.getGroupOwnerUserID(groupID);
  if (quotaUserID === null) {
    return c.text("Group not found", 404);
  }
  const quotaError = await checkStorageQuota(c, store, quotaUserID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const authorization = await store.authorizeGroupAttachmentUpload(
    groupID,
    itemKey,
    {
      charset: params.get("charset"),
      contentType: params.get("contentType"),
      filename: zipFilename ?? filename,
      itemFilename: zipFilename ? filename : null,
      itemMd5: zipMd5 ? md5 : null,
      md5: zipMd5 ?? md5,
      mtime: Number.parseInt(mtime, 10),
      sizeBytes,
      zip: params.get("zip") === "1" || Boolean(zipMd5),
    },
    getGroupUploadBaseURL(c, groupID, itemKey)
  );

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

    const result = await store.getAttachmentObject(userID, c.req.param("itemKey"));

    if (!(await requireSignedRawFileURL(c))) {
      return c.text("Invalid file URL", 403);
    }

    if (!result || result.file.md5 !== c.req.param("md5")) {
      return c.text("File not found", 404);
    }

    return c.body(result.body, 200, {
      "Content-Disposition": `inline; filename="${result.file.filename}"`,
      "Content-Type": formatAttachmentContentType(result.file),
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
      await getPublicationRawFileURL(
        c,
        userID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
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
      await getPublicationRawFileURL(
        c,
        userID,
        c.req.param("itemKey"),
        file.md5,
        file.filename
      ),
      302
    );
  }
);

compatibility.get("/users/:userID/publications/items/:itemKey", async (c) => {
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

  if (c.req.query("format") === "atom") {
    return c.text(
      renderPublicationItemAtom(c, userID, c.req.param("itemKey")),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${publication.version}`,
      }
    );
  }

  return c.json(
    withPublicationLinks(c, userID, publication.item),
    200,
    {
      "Last-Modified-Version": `${publication.version}`,
    }
  );
});

compatibility.get("/users/:userID/publications/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const result = await createCompatibilityStore(c.env).listItems(userID);
  const items = result.items.filter((item) => item.data.inPublications === true);

  if (c.req.query("format") === "atom") {
    return c.text(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        ...items.map((item) =>
          renderPublicationItemAtom(c, userID, item.key)
        ),
        "</feed>",
      ].join(""),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${result.version}`,
        "Total-Results": `${items.length}`,
      }
    );
  }

  return c.json(items.map((item) => withPublicationLinks(c, userID, item)), 200, {
    "Last-Modified-Version": `${result.version}`,
    "Total-Results": `${items.length}`,
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
      "Content-Type": formatAttachmentContentType(result.file),
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
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename)
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

  return c.redirect(
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename),
    302
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

  return c.redirect(
    await getRawFileURL(c, userID, c.req.param("itemKey"), file.md5, file.filename),
    302
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
  if (!(await store.getItem(userID, itemKey))) {
    return c.text("Item not found", 404);
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

  const result = await store.registerAttachmentUpload(userID, itemKey, uploadKey);
  if (!result.registered) {
    return c.text("Upload key not found", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
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
  if (!(await store.getItem(userID, itemKey))) {
    return c.text("Item not found", 404);
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

  if (existingFile && existingFile.md5 === md5) {
    return c.json({ exists: 1 }, 200, {
      "Last-Modified-Version": `${existingFile.version ?? 0}`,
    });
  }

  const quotaError = await checkStorageQuota(c, store, userID, sizeBytes);
  if (quotaError) {
    return quotaError;
  }

  const authorization = await store.authorizeAttachmentUpload(
    userID,
    itemKey,
    {
      charset: params.get("charset"),
      contentType: params.get("contentType"),
      filename: zipFilename ?? filename,
      itemFilename: zipFilename ? filename : null,
      itemMd5: zipMd5 ? md5 : null,
      md5: zipMd5 ?? md5,
      mtime: Number.parseInt(mtime, 10),
      sizeBytes,
      zip: params.get("zip") === "1" || Boolean(zipMd5),
    },
    getUploadBaseURL(c, userID, itemKey)
  );

  if (params.get("params") === "1") {
    return c.json({
      params: {},
      uploadKey: authorization.uploadKey,
      url: authorization.url,
    });
  }

  return c.json(authorization);
});

compatibility.get("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.getGroupItem(groupID, c.req.param("itemKey"));
  if (!result) {
    return c.text("Item not found", 404);
  }

  const item = result.items[0];
  if (!item) {
    return c.text("Item not found", 404);
  }

  return renderSingleItem(c, item, result.version);
});

compatibility.get("/groups/:groupID/items/:itemKey/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const record = await createFullTextStore(c.env).getContent(
    "group",
    groupID,
    c.req.param("itemKey")
  );
  if (!record) {
    return c.text("Full-text content not found", 404);
  }

  const { itemKey: _itemKey, version, ...body } = record;
  return c.json(body, 200, {
    "Last-Modified-Version": `${version}`,
  });
});

compatibility.put("/groups/:groupID/items/:itemKey/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }
  if (!hasJSONContentType(c)) {
    return c.text("Content-Type must be application/json", 400);
  }

  const body = await c.req.json().catch(() => null);
  const result = await createFullTextStore(c.env).upsertContent(
    "group",
    groupID,
    c.req.param("itemKey"),
    body
  );
  if (result.missingItem) {
    return c.text("Item not found", 404);
  }
  if (!result.record) {
    return c.text("Invalid full-text content", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.get("/groups/:groupID/fulltext/index", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return c.json({ status: "indexed" });
});

compatibility.get("/groups/:groupID/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createFullTextStore(c.env).listVersions(
    "group",
    groupID,
    getSinceOrNewerVersion(c)
  );

  return c.json(result.versions, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.post("/groups/:groupID/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }
  if (!hasJSONContentType(c)) {
    return c.text("Content-Type must be application/json", 400);
  }
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.text("Expected a full-text content array", 400);
  }

  const result = await createFullTextStore(c.env).upsertContentBatch(
    "group",
    groupID,
    body,
    preconditionVersion
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.json(
    {
      failed: result.failed,
      success: result.success,
      successful: result.successful,
    },
    200,
    {
      "Last-Modified-Version": `${result.version}`,
    }
  );
});

compatibility.on("HEAD","/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listGroupItems(groupID, itemKeys);
  const items = await filterItemsForRequest(c, "group", groupID, result.items);

  return renderItemListHead(c, items, result.version);
});

compatibility.get("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listGroupItems(groupID, itemKeys);
  const items = await filterItemsForRequest(c, "group", groupID, result.items);

  return renderItemList(c, items, result.version);
});

compatibility.post("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  const translationResponse = await handleWebTranslationWrite(c, {
    body,
    libraryID: groupID,
    libraryType: "group",
    store,
  });
  if (translationResponse) {
    return translationResponse;
  }
  if (!Array.isArray(body)) {
    return c.json({ error: "Expected an item array" }, 400);
  }

  const items = normalizeItemBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const itemFailures: ItemWriteFailures = {};
  mergeItemWriteFailures(itemFailures, normalizeItemBatchTagsForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchNotesForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchRelationsForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchCreatorsForWrite(items, true));
  mergeItemWriteFailures(itemFailures, validateItemBatchAnnotationsForWrite(items));
  const annotationParentResult = await validateItemBatchAnnotationParentsForWrite(
    store,
    "group",
    groupID,
    items
  );
  mergeItemWriteFailures(itemFailures, annotationParentResult.failures);
  const parentVersion = await validateItemBatchParentsForWrite(
    store,
    "group",
    groupID,
    items,
    itemFailures
  );
  if (Object.keys(itemFailures).length) {
    return tagWriteFailureResponse(c, itemFailures, parentVersion);
  }

  const missingCollectionKeys =
    await createCollectionStore(c.env).findMissingCollectionKeys(
      "group",
      groupID,
      items
    );
  if (missingCollectionKeys.length) {
    const library = await store.listGroupItems(groupID);
    return collectionFailureResponse(c, missingCollectionKeys, library.version);
  }

  const result = await store.createGroupItems(
    groupID,
    items,
    c.req.header("Zotero-Write-Token")
  );

  if (result.duplicateWriteToken) {
    return c.text("Write token has already been used", 412);
  }

  const relationVersion = await syncRelatedItemRelations(
    { libraryID: groupID, libraryType: "group", store },
    result.successful
  );
  const version = relationVersion ?? result.version;

  return c.json(
    {
      success: result.success,
      successful: result.successful,
    },
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...(result.successful.length > 0
        ? notificationHeaders(topicUpdatedNotification("group", groupID, version))
        : {}),
    }
  );
});

compatibility.get("/users/:userID/groups", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const allGroups = await store.listVisibleGroups(userID);
  const apiKey = getRequestApiKey(c);
  const key = apiKey ? await createKeyStore(c.env).getKey(apiKey) : null;
  const visibleGroups =
    key?.userID === userID && keyAllowsUserPermission(key.access, "library")
      ? allGroups.filter(
          (group) =>
            (isPublicGroupRecord(group) && group.data.owner === userID) ||
            keyAllowsGroupPermission(key.access, group.id, "library")
        )
      : allGroups.filter(
          (group) => isPublicGroupRecord(group) && group.data.owner === userID
        );
  const groups = filterGroupsForRequest(c, visibleGroups as Array<{ data: Record<string, unknown> & { type?: string }; id: number }>);
  const headers = { "Total-Results": `${groups.length}` };

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(groups.map((group) => [group.id, getGroupVersion(group)])),
      200,
      headers
    );
  }

  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    const responseGroups = await Promise.all(
      groups.map((group) => groupResponse(c, store, group))
    );
    return c.text(renderUserGroupsAtom(responseGroups, c), 200, {
      "Content-Type": "application/atom+xml",
      ...headers,
    });
  }

  const responseGroups = await Promise.all(
    groups.map((group) => groupResponse(c, store, group))
  );
  return c.json(responseGroups, 200, headers);
});

compatibility.get("/groups", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const store = createCompatibilityStore(c.env);
  let groups = filterGroupsForRequest(
    c,
    (await store.listGroups()) as Array<{ data: Record<string, unknown> & { type?: string }; id: number }>
  );
  const q = c.req.query("q");
  if (q) {
    const populated = await Promise.all(
      groups.map(async (group) => ({
        group,
        hasItems: (await store.listGroupItems(group.id)).items.length > 0,
      }))
    );
    groups = populated.filter((entry) => entry.hasItems).map((entry) => entry.group);
  }
  const headers = { "Total-Results": `${groups.length}` };

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(groups.map((group) => [group.id, getGroupVersion(group)])),
      200,
      headers
    );
  }

  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    return c.text(renderUserGroupsAtom(groups, c), 200, {
      "Content-Type": "application/atom+xml",
      ...headers,
    });
  }

  return c.json(groups, 200, headers);
});

compatibility.get("/groups/:groupID", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const group = await store.getGroup(groupID);
  if (!group) {
    return c.text("Group not found", 404);
  }
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const response = await groupResponse(c, store, group);
  if (c.req.query("content") === "json" || c.req.query("format") === "atom") {
    return c.text(renderUserGroupsAtom([response], c), 200, {
      "Content-Type": "application/atom+xml",
      "Last-Modified-Version": `${getGroupVersion(group)}`,
      "Total-Results": "1",
    });
  }

  return c.json(response, 200, {
    "Last-Modified-Version": `${getGroupVersion(group)}`,
  });
});

compatibility.put("/groups/:groupID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const group = await createCompatibilityStore(c.env).updateGroup(
    groupID,
    parseGroupXML(await c.req.text())
  );
  if (!group) {
    return c.text("Group not found", 404);
  }

  return c.text(renderGroupUpdateAtom(group), 200, {
    "Content-Type": "application/atom+xml",
    "Last-Modified-Version": `${getGroupVersion(group)}`,
  });
});

compatibility.get("/users/:userID/storageadmin", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  const quota = await store.getStorageQuota(userID);
  const usageBytes = await store.getStorageUsageBytes(userID);

  return c.text(renderStorageAdminXML({ ...quota, usageBytes }), 200, {
    "Content-Type": "application/xml",
  });
});

compatibility.post("/users/:userID/storageadmin", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const params = new URLSearchParams(await c.req.text());
  const quotaValue = params.get("quota");
  const expirationValue = params.get("expiration");

  if (quotaValue === null) {
    return c.text("Quota not provided", 400);
  }
  if (expirationValue === null) {
    return c.text("Expiration not provided", 400);
  }

  const expiration = Number.parseInt(expirationValue, 10);
  if (!Number.isFinite(expiration)) {
    return c.text("Invalid expiration", 400);
  }

  let quotaInput: number | "unlimited" | null;
  try {
    quotaInput = parseStorageQuota(quotaValue);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid quota", 400);
  }

  const store = createCompatibilityStore(c.env);
  const currentUsageBytes = await store.getStorageUsageBytes(userID);
  if (
    typeof quotaInput === "number" &&
    bytesToMegabytes(currentUsageBytes) > quotaInput
  ) {
    return c.text("Cannot set quota below current usage", 409);
  }

  const quota = await store.setStorageQuota(userID, quotaInput, expiration);

  return c.text(renderStorageAdminXML({ ...quota, usageBytes: currentUsageBytes }), 200, {
    "Content-Type": "application/xml",
  });
});

compatibility.post("/groups", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const data = parseGroupXML(await c.req.text());
  const owner = typeof data.owner === "number" && Number.isFinite(data.owner) ? data.owner : 1;
  const readString = (name: string, fallback: string) =>
    typeof data[name] === "string" ? data[name] : fallback;

  const store = createCompatibilityStore(c.env);
  const group = await store.createGroup({
    description: readString("description", ""),
    fileEditing: readString("fileEditing", "none"),
    hasImage:
      typeof data.hasImage === "boolean" ||
      typeof data.hasImage === "number" ||
      typeof data.hasImage === "string"
        ? data.hasImage
        : 0,
    libraryEditing: readString("libraryEditing", "members"),
    libraryReading: readString("libraryReading", "members"),
    name: readString("name", "Test Group"),
    owner,
    type: readString("type", "Private"),
    url: readString("url", ""),
  });
  const notifications = await allGroupAccessNotifications(
    c,
    group.data.owner,
    "topicAdded",
    group.id
  );

  return c.text(renderGroupCreateAtom(group.id), 201, {
    "Content-Type": "application/atom+xml",
    Location: `${new URL(c.req.url).origin}/groups/${group.id}`,
    ...notificationHeaders(...notifications),
  });
});

compatibility.post("/groups/:groupID/users", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  let users: Array<{ role: string; userID: number }>;
  try {
    users = parseGroupUsersXML(await c.req.text(), false);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid XML", 400);
  }

  try {
    await createCompatibilityStore(c.env).addGroupUsers(groupID, users);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid role", 400);
  }
  const notifications = (
    await Promise.all(
      users.map((user) =>
        allGroupAccessNotifications(c, user.userID, "topicAdded", groupID)
      )
    )
  ).flat();

  return c.text(renderGroupUsersXML(users), 200, {
    "Content-Type": "application/atom+xml",
    ...notificationHeaders(...notifications),
  });
});

compatibility.get("/groups/:groupID/users", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const users = await createCompatibilityStore(c.env).listGroupUsers(groupID);

  return c.text(renderGroupUsersXML(users), 200, {
    "Content-Type": "application/atom+xml",
  });
});

compatibility.put("/groups/:groupID/users/:userID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  const userID = parseNumericID(c.req.param("userID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  let users: Array<{ role: string; userID: number }>;
  try {
    users = parseGroupUsersXML(await c.req.text());
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid XML", 400);
  }

  const user = users[0];
  if (!user) {
    return c.text("User not provided", 400);
  }
  if (user.userID && user.userID !== userID) {
    return c.text(`User ID ${user.userID} does not match user ID ${userID}`, 400);
  }

  try {
    await createCompatibilityStore(c.env).updateGroupUser(
      groupID,
      userID,
      user.role
    );
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "Invalid role", 400);
  }

  return c.text(renderGroupUsersXML([{ ...user, userID }]), 200, {
    "Content-Type": "application/atom+xml",
  });
});

compatibility.delete("/groups/:groupID/users/:userID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  const userID = parseNumericID(c.req.param("userID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  await createCompatibilityStore(c.env).removeGroupUser(groupID, userID);
  return c.body(null, 204, {
    ...notificationHeaders(
      ...(await allGroupAccessNotifications(c, userID, "topicRemoved", groupID))
    ),
  });
});

compatibility.delete("/groups/:groupID", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  await createCompatibilityStore(c.env).deleteGroup(groupID);
  return c.body(null, 204, {
    ...notificationHeaders(topicDeletedNotification(groupID)),
  });
});

compatibility.post("/groups/:groupID/clear", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  await createCompatibilityStore(c.env).clearGroupLibrary(groupID);
  await createFullTextStore(c.env).clearFullText("group", groupID);
  await createSearchStore(c.env).clearSearches("group", groupID);
  await createSettingsStore(c.env).clearSettings("group", groupID);
  clearMemoryCollections("group", groupID);
  clearMemoryDeleted("group", groupID);
  clearMemorySearches("group", groupID);
  clearMemorySettings("group", groupID);
  return c.body(null, 204);
});

compatibility.post("/users/:userID/clear", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  await createCompatibilityStore(c.env).clearUserLibrary(userID);
  await createFullTextStore(c.env).clearFullText("user", userID);
  await createSearchStore(c.env).clearSearches("user", userID);
  await createSettingsStore(c.env).clearSettings("user", userID);
  clearMemoryCollections("user", userID);
  clearMemoryDeleted("user", userID);
  clearMemorySearches("user", userID);
  clearMemorySettings("user", userID);
  return c.body(null, 204);
});

compatibility.get("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.getItem(userID, c.req.param("itemKey"));
  if (!result) {
    return c.text("Item not found", 404);
  }

  const item = result.items[0];
  if (!item) {
    return c.text("Item not found", 404);
  }

  return renderSingleItem(c, item, result.version);
});

compatibility.get("/users/:userID/items/:itemKey/fulltext", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const record = await createFullTextStore(c.env).getContent(
    "user",
    userID,
    c.req.param("itemKey")
  );
  if (!record) {
    return c.text("Full-text content not found", 404);
  }

  const { itemKey: _itemKey, version, ...body } = record;
  return c.json(body, 200, {
    "Last-Modified-Version": `${version}`,
  });
});

compatibility.put("/users/:userID/items/:itemKey/fulltext", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }
  if (!hasJSONContentType(c)) {
    return c.text("Content-Type must be application/json", 400);
  }

  const body = await c.req.json().catch(() => null);
  const result = await createFullTextStore(c.env).upsertContent(
    "user",
    userID,
    c.req.param("itemKey"),
    body
  );
  if (result.missingItem) {
    return c.text("Item not found", 404);
  }
  if (!result.record) {
    return c.text("Invalid full-text content", 400);
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.get("/users/:userID/fulltext/index", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return c.json({ status: "indexed" });
});

compatibility.get("/users/:userID/fulltext", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createFullTextStore(c.env).listVersions(
    "user",
    userID,
    getSinceOrNewerVersion(c)
  );

  return c.json(result.versions, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});

compatibility.post("/users/:userID/fulltext", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }
  if (!hasJSONContentType(c)) {
    return c.text("Content-Type must be application/json", 400);
  }
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.text("Expected a full-text content array", 400);
  }

  const result = await createFullTextStore(c.env).upsertContentBatch(
    "user",
    userID,
    body,
    preconditionVersion
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.json(
    {
      failed: result.failed,
      success: result.success,
      successful: result.successful,
    },
    200,
    {
      "Last-Modified-Version": `${result.version}`,
    }
  );
});

compatibility.on("HEAD","/users/:userID/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listItems(userID, itemKeys);
  const items = await filterItemsForRequest(c, "user", userID, result.items);

  return renderItemListHead(c, items, result.version);
});

compatibility.get("/users/:userID/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listItems(userID, itemKeys);
  const items = await filterItemsForRequest(c, "user", userID, result.items);

  return renderItemList(c, items, result.version);
});

compatibility.post("/users/:userID/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  const translationResponse = await handleWebTranslationWrite(c, {
    body,
    libraryID: userID,
    libraryType: "user",
    store,
  });
  if (translationResponse) {
    return translationResponse;
  }
  if (!Array.isArray(body)) {
    return c.json({ error: "Expected an item array" }, 400);
  }

  const items = normalizeItemBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );

  const library = await store.listItems(userID);
  const existingVersions: ExistingObjectVersions = new Map(
    library.items.map((item) => [
      item.key,
      { data: item.data ?? {}, version: item.version ?? 0 },
    ])
  );
  const precondition = evaluateBatchWritePreconditions(
    items,
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

  const itemFailures: ItemWriteFailures = { ...precondition.failed };
  mergeItemWriteFailures(itemFailures, normalizeItemBatchTagsForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchNotesForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchRelationsForWrite(items));
  mergeItemWriteFailures(itemFailures, validateItemBatchCreatorsForWrite(items, true));
  mergeItemWriteFailures(itemFailures, validateItemBatchAnnotationsForWrite(items));
  const annotationParentResult = await validateItemBatchAnnotationParentsForWrite(
    store,
    "user",
    userID,
    items
  );
  mergeItemWriteFailures(itemFailures, annotationParentResult.failures);
  await validateItemBatchParentsForWrite(store, "user", userID, items, itemFailures);

  const toWrite = precondition.toWrite.filter(
    (entry) => !(entry.index in itemFailures)
  );

  const missingCollectionKeys = await createCollectionStore(
    c.env
  ).findMissingCollectionKeys(
    "user",
    userID,
    toWrite.map((entry) => entry.object)
  );
  if (missingCollectionKeys.length) {
    return collectionFailureResponse(c, missingCollectionKeys, library.version);
  }

  const writeToken = c.req.header("Zotero-Write-Token");
  const result = toWrite.length
    ? await store.createItems(
        userID,
        toWrite.map((entry) => entry.object),
        writeToken
      )
    : {
        duplicateWriteToken: false,
        success: [],
        successful: [],
        version: library.version,
      };

  if (result.duplicateWriteToken) {
    return c.text("Write token has already been used", 412);
  }

  const relationVersion = await syncRelatedItemRelations(
    { libraryID: userID, libraryType: "user", store },
    result.successful
  );
  const version = relationVersion ?? result.version;

  return c.json(
    buildWriteReport(
      toWrite,
      result.successful,
      itemFailures,
      precondition.unchanged
    ),
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...(result.successful.length > 0
        ? notificationHeaders(topicUpdatedNotification("user", userID, version))
        : {}),
    }
  );
});
