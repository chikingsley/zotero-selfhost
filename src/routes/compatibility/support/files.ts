import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { verifySecret } from "../../../domain/auth";
import type { CompatibilityStore } from "../../../domain/storage";

export const numericIDPattern = /^\d+$/;

export const parseNumericID = (value: string): number | null => {
  if (!numericIDPattern.test(value)) {
    return null;
  }

  return Number.parseInt(value, 10);
};

export const isValidMd5 = (value: string): boolean =>
  /^[a-f0-9]{32}$/.test(value);

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
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  const bodyParams = new URLSearchParams();

  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    for (const [key, value] of form) {
      if (typeof value === "string") {
        bodyParams.set(key, value);
      }
    }
  } else {
    const body = await c.req.text();
    const parsed = new URLSearchParams(body);
    for (const [key, value] of parsed) {
      bodyParams.set(key, value);
    }
  }

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
  createStorageStyleRawFileURL(c, "u", userID, itemKey, md5, filename);

export const getPublicationRawFileURL = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string,
  md5: string,
  filename: string
): Promise<string> =>
  createStorageStyleRawFileURL(c, "p", userID, itemKey, md5, filename);

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
  createStorageStyleRawFileURL(c, "g", groupID, itemKey, md5, filename);

export const parseUploadBody = async (
  request: Request
): Promise<ArrayBuffer> => {
  const contentType = request.headers.get("Content-Type") ?? "";

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return request.arrayBuffer();
  }

  const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
  if (!boundary) {
    return request.arrayBuffer();
  }

  // Parse on raw bytes: decoding as text corrupts binary payloads (ZIPs).
  const bytes = new Uint8Array(await request.arrayBuffer());
  const encoder = new TextEncoder();
  const findBytes = (needle: Uint8Array, from: number): number => {
    outer: for (let i = from; i <= bytes.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) {
        if (bytes[i + j] !== needle[j]) {
          continue outer;
        }
      }
      return i;
    }
    return -1;
  };

  const filePartStart = findBytes(encoder.encode('name="file"'), 0);
  if (filePartStart === -1) {
    return new ArrayBuffer(0);
  }

  const bodyStart = findBytes(encoder.encode("\r\n\r\n"), filePartStart);
  if (bodyStart === -1) {
    return new ArrayBuffer(0);
  }

  const contentStart = bodyStart + 4;
  const boundaryStart = findBytes(
    encoder.encode(`\r\n--${boundary}`),
    contentStart
  );
  const content =
    boundaryStart === -1
      ? bytes.slice(contentStart)
      : bytes.slice(contentStart, boundaryStart);

  return content.buffer as ArrayBuffer;
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

type StorageStyleRawFileScope = "g" | "p" | "u";

export interface StorageStyleRawFileLocator {
  id: number;
  itemKey: string;
  scope: StorageStyleRawFileScope;
}

export const createStorageStyleRawFileURL = async (
  c: Context<{ Bindings: Bindings }>,
  scope: StorageStyleRawFileScope,
  id: number,
  itemKey: string,
  md5: string,
  filename: string
): Promise<string> => {
  const origin = new URL(c.req.url).origin;
  const locator = encodeURIComponent(`${scope}:${id}:${itemKey}`);
  const digest = await createStorageStyleRawFileDigest(c, locator, md5);
  return new URL(
    `/${locator}/${digest}/${encodeURIComponent(filename)}`,
    origin
  ).toString();
};

export const createStorageStyleRawFileDigest = async (
  c: Context<{ Bindings: Bindings }>,
  encodedLocator: string,
  md5: string
): Promise<string> => signRawFileURLPayload(c, `${encodedLocator}:${md5}`);

export const signRawFileURLPayload = async (
  c: Context<{ Bindings: Bindings }>,
  payload: string
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getFileURLSigningSecret(c)),
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
    new TextEncoder().encode(payload)
  );

  return arrayBufferToHex(signature);
};

export const parseStorageStyleRawFileLocator = (
  encodedLocator: string
): StorageStyleRawFileLocator | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedLocator);
  } catch {
    return null;
  }

  const [scope, idText, itemKey, ...extra] = decoded.split(":");
  if (extra.length || !(scope === "g" || scope === "p" || scope === "u")) {
    return null;
  }

  const id = Number.parseInt(idText ?? "", 10);
  if (!Number.isFinite(id) || id <= 0 || !itemKey) {
    return null;
  }

  return { id, itemKey, scope };
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
  return verifySecret(signature, expected);
};

export const signRawFileURL = async (
  c: Context<{ Bindings: Bindings }>,
  pathname: string,
  expires: number
): Promise<string> => signRawFileURLPayload(c, `${pathname}:${expires}`);

export const getFileURLSigningSecret = (
  c: Context<{ Bindings: Bindings }>
): string => c.env.FILE_URL_SIGNING_SECRET;

export const arrayBufferToHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

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
