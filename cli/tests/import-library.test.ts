import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runImport } from "../src/commands/import-library.ts";

const attachmentBytes = Buffer.from("zotero-selfhost importer attachment\n");
const attachmentMd5 = createHash("md5").update(attachmentBytes).digest("hex");
const recoveredBytes = Buffer.from("recovered archive attachment\n");
const sourceVersion = 9;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "zotero-importer-test-"));
const statePath = join(temporaryDirectory, "import-state.json");
const recoveredPath = join(temporaryDirectory, "unavailable.pdf");
const recoveryManifestPath = join(temporaryDirectory, "recovery.json");
writeFileSync(recoveredPath, recoveredBytes);
writeFileSync(
  recoveryManifestPath,
  `${JSON.stringify({ files: { EEEE6666: recoveredPath }, version: 1 })}\n`
);
let origin: string;
let server: Server;
let targetVersion = 0;
let uploadCount = 0;
const target: {
  collections: Record<string, unknown>[];
  files: Map<string, Buffer>;
  fulltext: Record<string, unknown>;
  items: Record<string, unknown>[];
  searches: Record<string, unknown>[];
  settings: Record<string, unknown>;
  uploadParts: Map<string, Map<number, Buffer>>;
  uploads: Map<string, Buffer>;
} = {
  collections: [],
  files: new Map(),
  fulltext: {},
  items: [],
  searches: [],
  settings: {},
  uploadParts: new Map(),
  uploads: new Map(),
};

const sourceObjects = {
  collections: [
    envelope({ key: "AAAA2222", name: "Research", parentCollection: false }),
  ],
  items: [
    envelope({
      collections: ["AAAA2222"],
      itemType: "book",
      key: "BBBB3333",
      relations: {
        "dc:relation": "http://zotero.org/users/42/items/CCCC4444",
      },
      title: "Imported book",
    }),
    envelope({
      charset: "utf-8",
      contentType: "text/plain",
      filename: "attachment.txt",
      itemType: "attachment",
      key: "CCCC4444",
      linkMode: "imported_file",
      md5: attachmentMd5,
      mtime: "1700000000000",
      parentItem: "BBBB3333",
      title: "Attachment",
    }),
    envelope({
      contentType: "application/pdf",
      filename: "unavailable.pdf",
      itemType: "attachment",
      key: "EEEE6666",
      linkMode: "imported_file",
      parentItem: "BBBB3333",
      title: "Unavailable attachment",
    }),
  ],
  searches: [
    envelope({
      conditions: [
        { condition: "title", operator: "contains", value: "Imported" },
      ],
      key: "DDDD5555",
      name: "Imported search",
    }),
  ],
};

before(async () => {
  server = createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.stack : String(error));
    }
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!(address && typeof address === "object")) {
    throw new Error("Test server did not expose an address.");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  rmSync(temporaryDirectory, { force: true, recursive: true });
});

test("plans, executes, verifies, and resumes a personal-library import", async () => {
  const sourceURL = origin.replace("127.0.0.1", "localhost");
  const dryRun = await runImport({
    log: () => undefined,
    sourceApiKey: "source-key",
    sourceURL,
    statePath,
    targetApiKey: "target-owner-key",
    targetURL: origin,
  });
  assert.equal(dryRun.executed, false);
  assert.equal(dryRun.summary.items, 3);
  assert.equal(dryRun.summary.attachments, 1);
  assert.equal(dryRun.summary.unavailableAttachments, 1);
  const recoveredDryRun = await runImport({
    log: () => undefined,
    recoveryManifestPath,
    sourceApiKey: "source-key",
    sourceURL,
    statePath,
    targetApiKey: "target-owner-key",
    targetURL: origin,
  });
  assert.equal(recoveredDryRun.summary.attachments, 2);
  assert.equal(recoveredDryRun.summary.recoveredAttachments, 1);
  assert.equal(recoveredDryRun.summary.unavailableAttachments, 0);

  const imported = await runImport({
    execute: true,
    log: () => undefined,
    recoveryManifestPath,
    sourceApiKey: "source-key",
    sourceURL,
    statePath,
    targetApiKey: "target-owner-key",
    targetURL: origin,
  });
  assert.equal(imported.executed, true);
  assert.equal(target.items.length, 3);
  assert.equal(
    (target.items[0]?.relations as Record<string, string>)["dc:relation"],
    "http://zotero.org/users/1/items/CCCC4444"
  );
  assert.deepEqual(target.files.get("CCCC4444"), attachmentBytes);
  assert.deepEqual(target.files.get("EEEE6666"), recoveredBytes);
  assert.deepEqual(target.fulltext.CCCC4444, {
    content: "Indexed attachment",
    indexedChars: 18,
    totalChars: 18,
  });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.match(state.verifiedAt, /^\d{4}-/u);
  assert.equal(state.completed.files[0].storageMd5, attachmentMd5);
  assert.equal(JSON.stringify(state).includes("source-key"), false);
  assert.equal(JSON.stringify(state).includes("target-owner-key"), false);
  await assert.rejects(
    runImport({
      execute: true,
      log: () => undefined,
      sourceApiKey: "source-key",
      sourceURL,
      statePath,
      targetApiKey: "target-owner-key",
      targetURL: origin,
    }),
    /target contains/u
  );
  state.completed.files = [];
  state.verifiedAt = null;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const resumed = await runImport({
    execute: true,
    log: () => undefined,
    merge: true,
    recoveryManifestPath,
    sourceApiKey: "source-key",
    sourceURL,
    statePath,
    targetApiKey: "target-owner-key",
    targetURL: origin,
  });
  assert.equal(resumed.executed, true);
  assert.equal(target.items.length, 3);
  assert.equal(uploadCount, 2);
});

async function route(request, response) {
  const url = new URL(request.url, origin);
  const source = request.headers.host?.startsWith("localhost") === true;
  if (url.pathname === "/keys/current") {
    return json(response, 200, sourceKeyInfo(source));
  }
  if (!source && url.pathname === "/users/1/keys" && request.method === "GET") {
    return json(response, 200, []);
  }
  if (source) {
    return sourceRoute(url, request, response);
  }
  return targetRoute(url, request, response);
}

async function sourceRoute(url, request, response) {
  if (url.pathname === "/users/42/collections") {
    return objectList(response, sourceObjects.collections, sourceVersion);
  }
  if (url.pathname === "/users/42/items") {
    if (url.searchParams.get("format") === "versions") {
      return json(
        response,
        200,
        Object.fromEntries(sourceObjects.items.map((item) => [item.key, 1])),
        versionHeaders(sourceVersion)
      );
    }
    return objectList(response, sourceObjects.items, sourceVersion);
  }
  if (url.pathname === "/users/42/searches") {
    return objectList(response, sourceObjects.searches, sourceVersion);
  }
  if (url.pathname === "/users/42/settings") {
    return json(
      response,
      200,
      {
        tagColors: {
          value: [{ color: "#ff0000", name: "Important" }],
          version: 4,
        },
      },
      versionHeaders(sourceVersion)
    );
  }
  if (url.pathname === "/users/42/fulltext") {
    return json(response, 200, { CCCC4444: 8 }, versionHeaders(sourceVersion));
  }
  if (url.pathname === "/users/42/items/CCCC4444/fulltext") {
    return json(response, 200, {
      content: "Indexed attachment",
      indexedChars: 18,
      totalChars: 18,
    });
  }
  if (url.pathname === "/users/42/items/CCCC4444/file") {
    response.writeHead(200, {
      "Content-Length": attachmentBytes.length,
      "Content-Type": "text/plain",
      "Zotero-File-Compressed": "No",
      "Zotero-File-MD5": attachmentMd5,
    });
    return response.end(attachmentBytes);
  }
  return notFound(response, request);
}

async function targetRoute(url, request, response) {
  if (url.pathname === "/users/1/collections") {
    if (request.method === "POST") {
      return writeObjects(request, response, target.collections);
    }
    return objectList(
      response,
      target.collections.map(envelope),
      targetVersion
    );
  }
  if (url.pathname === "/users/1/items") {
    if (request.method === "POST") {
      return writeObjects(request, response, target.items);
    }
    return objectList(response, target.items.map(envelope), targetVersion);
  }
  const itemMatch = url.pathname.match(/^\/users\/1\/items\/([A-Z0-9]{8})$/u);
  if (itemMatch) {
    const item = target.items.find(
      (candidate) => candidate.key === itemMatch[1]
    );
    return item
      ? json(response, 200, envelope(item))
      : notFound(response, request);
  }
  if (url.pathname === "/users/1/searches") {
    if (request.method === "POST") {
      return writeObjects(request, response, target.searches);
    }
    return objectList(response, target.searches.map(envelope), targetVersion);
  }
  if (url.pathname === "/users/1/settings") {
    if (request.method === "POST") {
      Object.assign(target.settings, await requestJSON(request));
      targetVersion += 1;
      response.writeHead(204, versionHeaders(targetVersion));
      return response.end();
    }
    return json(response, 200, target.settings, versionHeaders(targetVersion));
  }
  if (url.pathname === "/users/1/fulltext") {
    return json(
      response,
      200,
      Object.fromEntries(
        Object.keys(target.fulltext).map((key) => [key, targetVersion])
      ),
      versionHeaders(targetVersion)
    );
  }
  if (
    url.pathname === "/users/1/items/CCCC4444/fulltext" &&
    request.method === "PUT"
  ) {
    target.fulltext.CCCC4444 = await requestJSON(request);
    response.statusCode = 204;
    return response.end();
  }
  const directPutMatch = url.pathname.match(
    /^\/r2\/([A-Z0-9]{8})(?:\/part\/(\d+))?$/u
  );
  if (directPutMatch && request.method === "PUT") {
    const [, key, rawPartNumber] = directPutMatch;
    const bytes = Buffer.from(await requestBytes(request));
    if (rawPartNumber) {
      const parts = target.uploadParts.get(key) ?? new Map();
      parts.set(Number(rawPartNumber), bytes);
      target.uploadParts.set(key, parts);
      response.setHeader("ETag", `"etag-${key}-${rawPartNumber}"`);
    } else {
      target.uploads.set(key, bytes);
    }
    response.statusCode = 200;
    return response.end();
  }
  const completionMatch = url.pathname.match(
    /^\/users\/1\/items\/([A-Z0-9]{8})\/file\/direct\/upload-[A-Z0-9]{8}\/complete$/u
  );
  if (completionMatch && request.method === "POST") {
    const key = completionMatch[1];
    const { parts } = await requestJSON(request);
    if (parts.length > 0) {
      const uploadedParts = target.uploadParts.get(key);
      if (!uploadedParts) {
        throw new Error(`No uploaded parts found for ${key}`);
      }
      target.uploads.set(
        key,
        Buffer.concat(
          parts.map(({ partNumber }) => uploadedParts.get(partNumber))
        )
      );
    }
    uploadCount += 1;
    response.statusCode = 204;
    return response.end();
  }
  const abortMatch = url.pathname.match(
    /^\/users\/1\/items\/([A-Z0-9]{8})\/file\/direct\/upload-[A-Z0-9]{8}$/u
  );
  if (abortMatch && request.method === "DELETE") {
    target.uploadParts.delete(abortMatch[1]);
    target.uploads.delete(abortMatch[1]);
    response.statusCode = 204;
    return response.end();
  }
  const fileMatch = url.pathname.match(
    /^\/users\/1\/items\/([A-Z0-9]{8})\/file$/u
  );
  if (fileMatch) {
    const key = fileMatch[1];
    if (request.method === "GET") {
      const file = target.files.get(key);
      if (!file) {
        return notFound(response, request);
      }
      const md5 = createHash("md5").update(file).digest("hex");
      response.writeHead(302, {
        Location: `${origin}/download/${key}`,
        "Zotero-File-MD5": md5,
      });
      return response.end();
    }
    const body = new URLSearchParams(await requestText(request));
    if (body.has("upload")) {
      const uploaded = target.uploads.get(key);
      if (!uploaded) {
        throw new Error(`No uploaded file found for ${key}`);
      }
      target.files.set(key, uploaded);
      targetVersion += 1;
      response.writeHead(204, versionHeaders(targetVersion));
      return response.end();
    }
    const partSizeBytes = 10;
    const size = Number(body.get("filesize"));
    return json(response, 200, {
      transfer:
        key === "CCCC4444"
          ? {
              headers: { "content-type": "text/plain" },
              kind: "single",
              url: `${origin}/r2/${key}`,
            }
          : {
              kind: "multipart",
              partSizeBytes,
              parts: Array.from(
                { length: Math.ceil(size / partSizeBytes) },
                (_, index) => ({
                  headers: {},
                  partNumber: index + 1,
                  url: `${origin}/r2/${key}/part/${index + 1}`,
                })
              ),
            },
      uploadKey: `upload-${key}`,
    });
  }
  return notFound(response, request);
}

async function writeObjects(request, response, destination) {
  const objects = await requestJSON(request);
  const success = {};
  const successful = {};
  const unchanged = {};
  for (const [index, object] of objects.entries()) {
    const existing = destination.find(
      (candidate) => candidate.key === object.key
    );
    if (existing) {
      Object.assign(existing, object);
      unchanged[index] = object.key;
    } else {
      destination.push(object);
      success[index] = object.key;
      successful[index] = envelope(object);
    }
  }
  targetVersion += 1;
  return json(
    response,
    200,
    { failed: {}, success, successful, unchanged },
    versionHeaders(targetVersion)
  );
}

function sourceKeyInfo(source) {
  return source
    ? {
        access: { user: { files: true, library: true } },
        displayName: "Source User",
        userID: 42,
        username: "source",
      }
    : {
        access: { user: { files: true, library: true, write: true } },
        displayName: "Owner",
        userID: 1,
        username: "owner",
      };
}

function envelope(data) {
  return { data: { ...data, version: 1 }, key: data.key, version: 1 };
}

function objectList(response, objects, version) {
  return json(response, 200, objects, {
    ...versionHeaders(version),
    "Total-Results": String(objects.length),
  });
}

function versionHeaders(version) {
  return { "Last-Modified-Version": String(version) };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function notFound(response, request) {
  response.statusCode = 404;
  response.end(`${request.method} ${request.url}`);
}

async function requestJSON(request) {
  return JSON.parse(await requestText(request));
}

async function requestText(request) {
  return (await requestBytes(request)).toString("utf8");
}

async function requestBytes(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
