import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  HTTPResponseError,
  parsePossibleJSON,
  requireRecord,
} from "./http.mjs";
import { saveImportState } from "./importer-state.mjs";

export const importFiles = async ({
  attachments,
  recoveryFiles = new Map(),
  source,
  sourceUserID,
  state,
  statePath,
  target,
  targetUserID,
}) => {
  const completed = new Set(state.completed.files.map((entry) => entry.key));
  for (const attachment of attachments) {
    if (completed.has(attachment.key)) {
      continue;
    }

    const existingTarget = await getTargetAttachmentState({
      attachment,
      client: target,
      targetUserID,
    });
    if (existingTarget) {
      state.completed.files.push(existingTarget);
      saveImportState(statePath, state);
      continue;
    }

    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), `zotero-selfhost-${attachment.key}-`)
    );
    try {
      const recovery = recoveryFiles.get(attachment.key);
      const downloaded = recovery
        ? await readRecoveredAttachment({ attachment, recovery })
        : await downloadAttachment({
            attachment,
            client: source,
            path: `/users/${sourceUserID}/items/${attachment.key}/file`,
            temporaryDirectory,
          });
      await uploadAttachment({
        attachment,
        client: target,
        downloaded,
        targetUserID,
      });
      state.completed.files.push({
        itemMd5: attachment.md5,
        key: attachment.key,
        size: downloaded.size,
        storageMd5: downloaded.md5,
      });
      saveImportState(statePath, state);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
};

export const applyRecoveryManifest = async ({ manifestPath, snapshot }) => {
  const absoluteManifestPath = resolve(manifestPath);
  const parsed = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  const files = requireRecord(parsed.files, "Recovery manifest files");
  if (parsed.version !== 1) {
    throw new Error("Recovery manifest version must be 1.");
  }

  const unavailable = new Set(snapshot.unavailableAttachmentKeys);
  const items = new Map(snapshot.items.map((item) => [item.key, item]));
  const recoveryFiles = new Map();
  for (const [key, configuredPath] of Object.entries(files)) {
    if (!unavailable.has(key)) {
      throw new Error(
        `Recovery manifest key ${key} is not an unavailable stored attachment in this source inventory.`
      );
    }
    if (typeof configuredPath !== "string" || !configuredPath.trim()) {
      throw new Error(`Recovery manifest path for ${key} is empty.`);
    }
    const path = isAbsolute(configuredPath)
      ? resolve(configuredPath)
      : resolve(dirname(absoluteManifestPath), configuredPath);
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      throw new Error(`Recovered attachment ${key} is not a regular file.`);
    }
    const item = items.get(key);
    if (!item) {
      throw new Error(
        `Recovered attachment ${key} is missing from the snapshot.`
      );
    }
    const md5 = await hashFile(path);
    item.md5 = md5;
    item.mtime = Math.trunc(metadata.mtimeMs);
    snapshot.attachments.push(item);
    recoveryFiles.set(key, {
      md5,
      path,
      size: metadata.size,
    });
  }
  snapshot.unavailableAttachmentKeys =
    snapshot.unavailableAttachmentKeys.filter((key) => !recoveryFiles.has(key));
  return recoveryFiles;
};

export const cleanMd5 = (value) =>
  String(value ?? "")
    .replaceAll('"', "")
    .trim()
    .toLowerCase();

const getTargetAttachmentState = async ({
  attachment,
  client,
  targetUserID,
}) => {
  const itemResponse = await client.request(
    `/users/${targetUserID}/items/${attachment.key}`
  );
  if (itemResponse.status !== 200) {
    return null;
  }
  const item = parsePossibleJSON(await itemResponse.text());
  const itemData =
    item && typeof item === "object" && !Array.isArray(item) ? item.data : null;
  if (
    !(itemData && typeof itemData === "object" && !Array.isArray(itemData)) ||
    cleanMd5(itemData.md5) !== cleanMd5(attachment.md5)
  ) {
    return null;
  }

  const fileResponse = await client.request(
    `/users/${targetUserID}/items/${attachment.key}/file`,
    { redirect: "manual" }
  );
  if (
    !(
      fileResponse.status === 200 ||
      (fileResponse.status >= 300 && fileResponse.status < 400)
    )
  ) {
    return null;
  }
  const targetStorageMd5 = cleanMd5(
    fileResponse.headers.get("Zotero-File-MD5") ??
      fileResponse.headers.get("ETag")
  );
  if (targetStorageMd5 !== cleanMd5(attachment.md5)) {
    return null;
  }
  const size = Number(fileResponse.headers.get("Zotero-File-Size"));
  return {
    itemMd5: cleanMd5(attachment.md5),
    key: attachment.key,
    size: Number.isFinite(size) ? size : 0,
    storageMd5: targetStorageMd5,
  };
};

const downloadAttachment = async ({
  attachment,
  client,
  path,
  temporaryDirectory,
}) => {
  let response = await client.request(path, {
    headers: { Accept: "application/octet-stream" },
    redirect: "manual",
  });
  let metadataHeaders = new Headers(response.headers);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new Error(
        `Attachment ${attachment.key} redirected without a Location header.`
      );
    }
    const downloadURL = new URL(location, client.baseURL);
    response =
      downloadURL.origin === client.baseURL.origin
        ? await client.request(downloadURL, {
            headers: { Accept: "application/octet-stream" },
          })
        : await fetchExternalWithRetry(
            client,
            downloadURL,
            { headers: { Accept: "application/octet-stream" } },
            attachment.key
          );
  }
  if (
    response.status === 404 &&
    attachment.linkMode === "imported_url" &&
    typeof attachment.url === "string"
  ) {
    const originalURL = new URL(attachment.url);
    if (originalURL.protocol === "https:" || originalURL.protocol === "http:") {
      await response.body?.cancel();
      response = await fetchExternalWithRetry(
        client,
        originalURL,
        { headers: { Accept: "application/octet-stream" } },
        attachment.key
      );
      metadataHeaders = new Headers(response.headers);
    }
  }
  if (response.status !== 200 || !response.body) {
    throw new HTTPResponseError(
      `Could not download attachment ${attachment.key} (HTTP ${response.status}).`,
      { body: await response.text(), response }
    );
  }

  for (const [key, value] of response.headers) {
    if (!metadataHeaders.has(key)) {
      metadataHeaders.set(key, value);
    }
  }
  const pathOnDisk = join(temporaryDirectory, "attachment.bin");
  const handle = await open(pathOnDisk, "w", 0o600);
  const hash = createHash("md5");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      size += bytes.byteLength;
      await handle.write(bytes);
    }
  } finally {
    await handle.close();
  }

  const md5 = hash.digest("hex");
  const declaredStorageHash = cleanMd5(
    metadataHeaders.get("Zotero-File-MD5") ?? metadataHeaders.get("ETag")
  );
  const declaredStorageMd5 = /^[a-f\d]{32}$/u.test(declaredStorageHash)
    ? declaredStorageHash
    : "";
  if (declaredStorageMd5 && declaredStorageMd5 !== md5) {
    throw new Error(
      `Attachment ${attachment.key} downloaded with MD5 ${md5}, expected ${declaredStorageMd5}.`
    );
  }
  const compressed =
    metadataHeaders.get("Zotero-File-Compressed")?.toLowerCase() === "yes";
  if (!compressed && cleanMd5(attachment.md5) !== md5) {
    throw new Error(
      `Attachment ${attachment.key} content does not match item MD5 ${attachment.md5}.`
    );
  }

  return {
    compressed,
    md5,
    path: pathOnDisk,
    size,
    storageFilename:
      filenameFromDisposition(metadataHeaders.get("Content-Disposition")) ??
      (compressed ? `${attachment.filename}.zip` : attachment.filename),
  };
};

const readRecoveredAttachment = async ({ attachment, recovery }) => {
  const metadata = await stat(recovery.path);
  const md5 = await hashFile(recovery.path);
  if (metadata.size !== recovery.size || md5 !== recovery.md5) {
    throw new Error(
      `Recovered attachment ${attachment.key} changed after the import inventory was prepared.`
    );
  }
  if (cleanMd5(attachment.md5) !== md5) {
    throw new Error(
      `Recovered attachment ${attachment.key} does not match its prepared MD5.`
    );
  }
  return {
    compressed: false,
    md5,
    path: recovery.path,
    size: metadata.size,
    storageFilename: attachment.filename,
  };
};

const hashFile = async (path) => {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const uploadAttachment = async ({
  attachment,
  client,
  downloaded,
  targetUserID,
}) => {
  const path = `/users/${targetUserID}/items/${attachment.key}/file`;
  const parameters = new URLSearchParams({
    charset: stringValue(attachment.charset),
    contentType: stringValue(attachment.contentType),
    direct: "1",
    filename: attachment.filename,
    filesize: String(downloaded.size),
    md5: cleanMd5(attachment.md5),
    mtime: String(attachment.mtime),
  });
  if (downloaded.compressed) {
    parameters.set("zip", "1");
    parameters.set("zipFilename", downloaded.storageFilename);
    parameters.set("zipMD5", downloaded.md5);
  }
  for (const [key, value] of [...parameters]) {
    if (!value) {
      parameters.delete(key);
    }
  }

  const authorization = await client.json(
    path,
    {
      body: parameters,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      method: "POST",
    },
    [200]
  );
  const authorizationBody = requireRecord(
    authorization.body,
    `Attachment ${attachment.key} authorization`
  );
  if (authorizationBody.exists === 1) {
    return;
  }
  if (typeof authorizationBody.uploadKey !== "string") {
    throw new Error(
      `Attachment ${attachment.key} authorization did not include uploadKey.`
    );
  }

  try {
    const parts = await uploadDirectTransfer({
      attachment,
      client,
      downloaded,
      transfer: authorizationBody.transfer,
    });
    const completionPath = `${path}/direct/${authorizationBody.uploadKey}/complete`;
    const completionResponse = await client.request(completionPath, {
      body: JSON.stringify({ parts }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (completionResponse.status !== 204) {
      throw new HTTPResponseError(
        `Attachment ${attachment.key} direct upload completion failed (HTTP ${completionResponse.status}).`,
        {
          body: await completionResponse.text(),
          response: completionResponse,
        }
      );
    }
  } catch (error) {
    await client
      .request(`${path}/direct/${authorizationBody.uploadKey}`, {
        method: "DELETE",
      })
      .catch(() => undefined);
    throw error;
  }

  const registration = new URLSearchParams({
    upload: authorizationBody.uploadKey,
  });
  const registrationResponse = await client.request(path, {
    body: registration,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    method: "POST",
  });
  if (registrationResponse.status !== 204) {
    throw new HTTPResponseError(
      `Attachment ${attachment.key} registration failed (HTTP ${registrationResponse.status}).`,
      {
        body: await registrationResponse.text(),
        response: registrationResponse,
      }
    );
  }
};

const uploadDirectTransfer = async ({
  attachment,
  client,
  downloaded,
  transfer,
}) => {
  const transferRecord = requireRecord(
    transfer,
    `Attachment ${attachment.key} direct transfer`
  );
  if (transferRecord.kind === "single") {
    const url = requireURL(transferRecord.url, attachment.key);
    const headers = requireStringHeaders(
      transferRecord.headers,
      attachment.key
    );
    await putFileRangeWithRetry({
      attachmentKey: attachment.key,
      client,
      end: downloaded.size - 1,
      headers,
      path: downloaded.path,
      start: 0,
      url,
    });
    return [];
  }
  if (
    transferRecord.kind !== "multipart" ||
    !Number.isSafeInteger(transferRecord.partSizeBytes) ||
    transferRecord.partSizeBytes < 1 ||
    !Array.isArray(transferRecord.parts)
  ) {
    throw new Error(
      `Attachment ${attachment.key} direct transfer is not valid.`
    );
  }

  const completedParts = [];
  for (const [index, rawPart] of transferRecord.parts.entries()) {
    const part = requireRecord(
      rawPart,
      `Attachment ${attachment.key} multipart part ${index + 1}`
    );
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber !== index + 1
    ) {
      throw new Error(
        `Attachment ${attachment.key} multipart part numbers are not contiguous.`
      );
    }
    const start = index * transferRecord.partSizeBytes;
    const end = Math.min(
      downloaded.size - 1,
      start + transferRecord.partSizeBytes - 1
    );
    const response = await putFileRangeWithRetry({
      attachmentKey: attachment.key,
      client,
      end,
      headers: requireStringHeaders(part.headers, attachment.key),
      path: downloaded.path,
      start,
      url: requireURL(part.url, attachment.key),
    });
    const etag = response.headers.get("ETag");
    if (!etag) {
      throw new Error(
        `Attachment ${attachment.key} multipart part ${part.partNumber} did not return an ETag.`
      );
    }
    completedParts.push({ etag, partNumber: part.partNumber });
  }
  return completedParts;
};

const putFileRangeWithRetry = async ({
  attachmentKey,
  client,
  end,
  headers,
  path,
  start,
  url,
}) => {
  const contentLength = end - start + 1;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await client.fetchImpl(url, {
        body:
          contentLength === 0
            ? createReadStream(path)
            : createReadStream(path, { end, start }),
        duplex: "half",
        headers: { ...headers, "Content-Length": String(contentLength) },
        method: "PUT",
      });
      if (response.ok) {
        return response;
      }
      const body = await response.text();
      if (response.status < 500 && response.status !== 429) {
        throw new HTTPResponseError(
          `Attachment ${attachmentKey} direct R2 upload failed (HTTP ${response.status}).`,
          { body, response }
        );
      }
      if (attempt === 4) {
        throw new HTTPResponseError(
          `Attachment ${attachmentKey} direct R2 upload failed after retries (HTTP ${response.status}).`,
          { body, response }
        );
      }
    } catch (error) {
      if (error instanceof HTTPResponseError) {
        throw error;
      }
      if (attempt === 4) {
        throw new Error(
          `Attachment ${attachmentKey} direct R2 upload failed after retries: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        );
      }
    }
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, 250 * 2 ** attempt)
    );
  }
  throw new Error(`Attachment ${attachmentKey} direct R2 upload failed.`);
};

const fetchExternalWithRetry = async (client, url, init, attachmentKey) => {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await client.fetchImpl(url, init);
      if (response.status < 500 && response.status !== 429) {
        return response;
      }
      lastError = new Error(
        `External download returned HTTP ${response.status}`
      );
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 250 * 2 ** attempt)
      );
    }
  }
  throw new Error(
    `Could not download attachment ${attachmentKey} after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { cause: lastError }
  );
};

const requireStringHeaders = (value, attachmentKey) => {
  const record = requireRecord(
    value,
    `Attachment ${attachmentKey} direct transfer headers`
  );
  const headers = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue !== "string") {
      throw new Error(
        `Attachment ${attachmentKey} direct transfer header ${key} is invalid.`
      );
    }
    headers[key] = headerValue;
  }
  return headers;
};

const requireURL = (value, attachmentKey) => {
  if (typeof value !== "string") {
    throw new Error(
      `Attachment ${attachmentKey} direct transfer URL is invalid.`
    );
  }
  return new URL(value);
};

const filenameFromDisposition = (value) => {
  if (!value) {
    return null;
  }
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    return decodeURIComponent(encoded);
  }
  return value.match(/filename="?([^";]+)"?/iu)?.[1] ?? null;
};

const stringValue = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
