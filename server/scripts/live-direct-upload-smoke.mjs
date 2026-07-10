#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ZoteroAPIClient } from "../cli/lib/http.mjs";

const apiKey = process.env.SELFHOST_API_KEY_FILE
  ? readFileSync(process.env.SELFHOST_API_KEY_FILE, "utf8").trim()
  : process.env.SELFHOST_TEST_API_KEY?.trim();
const baseURL =
  process.env.SELFHOST_URL?.trim() ?? "https://zotero.peacockery.studio";
if (!apiKey) {
  throw new Error("SELFHOST_API_KEY_FILE or SELFHOST_TEST_API_KEY is required");
}

const client = new ZoteroAPIClient({ apiKey, baseURL });
const owner = await client.json("/keys/current");
const userID = owner.body.userID;
if (!Number.isSafeInteger(userID)) {
  throw new Error("The production key did not return a user ID");
}

const smallBytes = Buffer.from("direct-r2-smoke\n");
const largeSize = 100 * 1024 * 1024 + 1;
const zeroChunk = Buffer.alloc(16 * 1024 * 1024);
const largeHash = createHash("md5");
for (let remaining = largeSize; remaining > 0; ) {
  const size = Math.min(remaining, zeroChunk.byteLength);
  largeHash.update(zeroChunk.subarray(0, size));
  remaining -= size;
}

const uploads = [
  {
    bytes: smallBytes,
    contentType: "text/plain",
    filename: "direct-r2-small-smoke.txt",
    md5: createHash("md5").update(smallBytes).digest("hex"),
    size: smallBytes.byteLength,
    title: "Disposable direct R2 small smoke",
  },
  {
    contentType: "application/octet-stream",
    filename: "direct-r2-multipart-smoke.bin",
    md5: largeHash.digest("hex"),
    size: largeSize,
    title: "Disposable direct R2 multipart smoke",
  },
];

const createdKeys = [];
let latestVersion = null;
try {
  const templateResponse = await client.json(
    "/items/new?itemType=attachment&linkMode=imported_file"
  );
  const template = templateResponse.body;
  const items = uploads.map((upload) => ({
    ...template,
    contentType: upload.contentType,
    filename: upload.filename,
    linkMode: "imported_file",
    md5: upload.md5,
    mtime: Date.now(),
    title: upload.title,
  }));
  const create = await client.json(
    `/users/${userID}/items`,
    {
      body: JSON.stringify(items),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    [200]
  );
  for (const index of ["0", "1"]) {
    const key = create.body.success?.[index];
    if (typeof key !== "string") {
      throw new Error(`Could not create disposable attachment ${index}`);
    }
    createdKeys.push(key);
  }
  latestVersion = Number(create.response.headers.get("Last-Modified-Version"));

  for (const [index, upload] of uploads.entries()) {
    const itemKey = createdKeys[index];
    const path = `/users/${userID}/items/${itemKey}/file`;
    const authorization = await client.json(
      path,
      {
        body: new URLSearchParams({
          contentType: upload.contentType,
          direct: "1",
          filename: upload.filename,
          filesize: String(upload.size),
          md5: upload.md5,
          mtime: String(Date.now()),
        }),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "If-None-Match": "*",
        },
        method: "POST",
      },
      [200]
    );
    const { transfer, uploadKey } = authorization.body;
    if (!(transfer && typeof uploadKey === "string")) {
      throw new Error(`Upload authorization for ${itemKey} was incomplete`);
    }

    const completedParts = [];
    if (transfer.kind === "single") {
      await putWithRetry(transfer.url, transfer.headers, upload.bytes);
    } else if (transfer.kind === "multipart") {
      for (const part of transfer.parts) {
        const start = (part.partNumber - 1) * transfer.partSizeBytes;
        const size = Math.min(transfer.partSizeBytes, upload.size - start);
        const response = await putWithRetry(
          part.url,
          part.headers,
          zeroChunk.subarray(0, size)
        );
        const etag = response.headers.get("ETag");
        if (!etag) {
          throw new Error(`Multipart part ${part.partNumber} omitted its ETag`);
        }
        completedParts.push({ etag, partNumber: part.partNumber });
      }
    } else {
      throw new Error(`Unexpected direct upload strategy for ${itemKey}`);
    }

    const complete = await client.request(
      `${path}/direct/${uploadKey}/complete`,
      {
        body: JSON.stringify({ parts: completedParts }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
    if (complete.status !== 204) {
      throw new Error(`Direct completion failed: ${complete.status}`);
    }
    const register = await client.request(path, {
      body: new URLSearchParams({ upload: uploadKey }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      method: "POST",
    });
    if (register.status !== 204) {
      throw new Error(`Direct registration failed: ${register.status}`);
    }
    latestVersion = Number(register.headers.get("Last-Modified-Version"));
    const file = await client.request(path, { redirect: "manual" });
    if (
      file.status !== 302 ||
      Number(file.headers.get("Zotero-File-Size")) !== upload.size ||
      file.headers.get("Zotero-File-MD5") !== upload.md5
    ) {
      throw new Error(`Registered attachment ${itemKey} did not verify`);
    }
    console.log(
      `${transfer.kind}: ${upload.size} bytes uploaded and verified (${itemKey})`
    );
  }
} finally {
  if (createdKeys.length > 0) {
    if (!Number.isSafeInteger(latestVersion)) {
      const inventory = await client.request(`/users/${userID}/items?limit=1`);
      latestVersion = Number(inventory.headers.get("Last-Modified-Version"));
    }
    const cleanup = await client.request(
      `/users/${userID}/items?itemKey=${createdKeys.join(",")}`,
      {
        headers: {
          "If-Unmodified-Since-Version": String(latestVersion),
        },
        method: "DELETE",
      }
    );
    if (cleanup.status !== 204) {
      console.error(
        `Warning: disposable upload cleanup failed (${cleanup.status})`
      );
    }
  }
}

async function putWithRetry(url, headers, body) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { body, headers, method: "PUT" });
      if (response.ok) {
        return response;
      }
      lastError = new Error(`R2 PUT failed: ${response.status}`);
      if (response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError;
}
