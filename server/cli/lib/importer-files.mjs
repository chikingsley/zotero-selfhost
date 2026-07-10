import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HTTPResponseError,
  parsePossibleJSON,
  requireRecord,
} from "./http.mjs";
import { saveImportState } from "./importer-state.mjs";

export const importFiles = async ({
  attachments,
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

    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), `zotero-selfhost-${attachment.key}-`)
    );
    try {
      const downloaded = await downloadAttachment({
        attachment,
        client: source,
        path: `/users/${sourceUserID}/items/${attachment.key}/file`,
        temporaryDirectory,
      });
      const alreadyPresent = await targetAttachmentMatches({
        attachment,
        client: target,
        downloaded,
        targetUserID,
      });
      if (!alreadyPresent) {
        await uploadAttachment({
          attachment,
          client: target,
          downloaded,
          targetUserID,
        });
      }
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

export const cleanMd5 = (value) =>
  String(value ?? "")
    .replaceAll('"', "")
    .trim()
    .toLowerCase();

const targetAttachmentMatches = async ({
  attachment,
  client,
  downloaded,
  targetUserID,
}) => {
  const itemResponse = await client.request(
    `/users/${targetUserID}/items/${attachment.key}`
  );
  if (itemResponse.status !== 200) {
    return false;
  }
  const item = parsePossibleJSON(await itemResponse.text());
  const itemData =
    item && typeof item === "object" && !Array.isArray(item) ? item.data : null;
  if (
    !(itemData && typeof itemData === "object" && !Array.isArray(itemData)) ||
    cleanMd5(itemData.md5) !== cleanMd5(attachment.md5)
  ) {
    return false;
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
    return false;
  }
  const targetStorageMd5 = cleanMd5(
    fileResponse.headers.get("Zotero-File-MD5") ??
      fileResponse.headers.get("ETag")
  );
  return targetStorageMd5 === downloaded.md5;
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
  const metadataHeaders = new Headers(response.headers);
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
        : await client.fetchImpl(downloadURL, {
            headers: { Accept: "application/octet-stream" },
          });
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
  const declaredStorageMd5 = cleanMd5(
    metadataHeaders.get("Zotero-File-MD5") ?? metadataHeaders.get("ETag")
  );
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
    filename: attachment.filename,
    filesize: String(downloaded.size),
    md5: cleanMd5(attachment.md5),
    mtime: String(attachment.mtime),
    params: "1",
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
  if (
    typeof authorizationBody.url !== "string" ||
    typeof authorizationBody.uploadKey !== "string"
  ) {
    throw new Error(
      `Attachment ${attachment.key} authorization did not include url/uploadKey.`
    );
  }

  const uploadURL = new URL(authorizationBody.url, client.baseURL);
  const uploadResponse = await client.fetchImpl(uploadURL, {
    body: createReadStream(downloaded.path),
    duplex: "half",
    headers: {
      "Content-Type":
        typeof authorizationBody.contentType === "string"
          ? authorizationBody.contentType
          : "application/octet-stream",
    },
    method: "POST",
  });
  if (!(uploadResponse.status === 200 || uploadResponse.status === 201)) {
    throw new HTTPResponseError(
      `Attachment ${attachment.key} upload failed (HTTP ${uploadResponse.status}).`,
      { body: await uploadResponse.text(), response: uploadResponse }
    );
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
