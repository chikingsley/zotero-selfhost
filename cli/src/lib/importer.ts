import { resolve } from "node:path";
import {
  HTTPResponseError,
  parsePossibleJSON,
  requireRecord,
  ZoteroAPIClient,
} from "./http.ts";
import {
  headerVersion,
  inventoryObjectCount,
  orderCollections,
  orderItems,
  readInventory,
  readSnapshot,
  remapSnapshotUserIdentity,
} from "./importer-data.ts";
import {
  applyRecoveryManifest,
  cleanMd5,
  importFiles,
} from "./importer-files.ts";
import {
  defaultImportStatePath,
  loadOrCreateImportState,
  resetImportState,
  saveImportState,
} from "./importer-state.ts";

export { defaultImportStatePath, readImportState } from "./importer-state.ts";

interface ImportOptions {
  execute?: boolean;
  fetchImpl?: typeof fetch;
  includeFiles?: boolean;
  includeFulltext?: boolean;
  log?: typeof console.log;
  merge?: boolean;
  recoveryManifestPath?: string;
  resetState?: boolean;
  sourceApiKey: string;
  sourceURL?: string;
  statePath?: string;
  targetApiKey: string;
  targetURL: string;
}

export const runImport = async ({
  execute = false,
  fetchImpl = globalThis.fetch,
  includeFiles = true,
  includeFulltext = true,
  log = console.log,
  merge = false,
  recoveryManifestPath,
  resetState = false,
  sourceApiKey,
  sourceURL = "https://api.zotero.org",
  statePath = defaultImportStatePath(),
  targetApiKey,
  targetURL,
}: ImportOptions) => {
  assertSecret(sourceApiKey, "ZOTERO_IMPORT_API_KEY");
  assertSecret(targetApiKey, "SELFHOST_API_KEY");

  const source = new ZoteroAPIClient({
    apiKey: sourceApiKey,
    baseURL: sourceURL,
    fetchImpl,
  });
  const target = new ZoteroAPIClient({
    apiKey: targetApiKey,
    baseURL: targetURL,
    fetchImpl,
  });
  if (source.baseURL.origin === target.baseURL.origin) {
    throw new Error("The source and target API origins must be different.");
  }

  const [sourceKeyInfo, targetKeyInfo] = await Promise.all([
    getKeyInfo(source, "Zotero.org source"),
    getKeyInfo(target, "self-host target"),
  ]);
  await assertOwnerKey(target, targetKeyInfo.userID);

  log(`Reading Zotero.org user ${sourceKeyInfo.userID}...`);
  const sourceSnapshot = await readSnapshot(source, sourceKeyInfo.userID, {
    includeFulltext,
  });
  const snapshot = remapSnapshotUserIdentity(
    sourceSnapshot,
    sourceKeyInfo.userID,
    targetKeyInfo.userID
  );
  const recoveryFiles = recoveryManifestPath
    ? await applyRecoveryManifest({
        manifestPath: recoveryManifestPath,
        snapshot,
      })
    : new Map();
  const targetInventory = await readInventory(target, targetKeyInfo.userID);
  const targetCount = inventoryObjectCount(targetInventory);
  if (execute && targetCount > 0 && !merge) {
    throw new Error(
      `The target contains ${targetCount} sync objects. Re-run with --merge only after reviewing the dry-run inventory.`
    );
  }

  const summary = summarizeSnapshot(snapshot, {
    includeFiles,
    includeFulltext,
    recoveredAttachments: recoveryFiles.size,
    targetCount,
  });
  printSummary(summary, { execute, log, merge });
  if (!execute) {
    return { executed: false, summary };
  }

  if (resetState) {
    resetImportState(statePath);
  }
  const state = loadOrCreateImportState(statePath, {
    source: {
      libraryVersion: sourceSnapshot.libraryVersion,
      origin: source.baseURL.origin,
      userID: sourceKeyInfo.userID,
    },
    target: {
      origin: target.baseURL.origin,
      userID: targetKeyInfo.userID,
    },
  });
  state.verifiedAt = null;
  saveImportState(statePath, state);

  let targetLibraryVersion = targetInventory.libraryVersion;
  targetLibraryVersion = await writeObjectBatches({
    client: target,
    objects: orderCollections(snapshot.collections),
    path: `/users/${targetKeyInfo.userID}/collections`,
    state,
    stateKey: "collections",
    statePath,
    targetLibraryVersion,
  });
  targetLibraryVersion = await writeObjectBatches({
    client: target,
    objects: orderItems(snapshot.items),
    path: `/users/${targetKeyInfo.userID}/items`,
    state,
    stateKey: "items",
    statePath,
    targetLibraryVersion,
  });
  targetLibraryVersion = await writeObjectBatches({
    client: target,
    objects: snapshot.searches,
    path: `/users/${targetKeyInfo.userID}/searches`,
    state,
    stateKey: "searches",
    statePath,
    targetLibraryVersion,
  });
  targetLibraryVersion = await writeSettings({
    client: target,
    settings: snapshot.settings,
    state,
    statePath,
    targetLibraryVersion,
    userID: targetKeyInfo.userID,
  });

  if (includeFiles) {
    await importFiles({
      attachments: snapshot.attachments,
      recoveryFiles,
      source,
      sourceUserID: sourceKeyInfo.userID,
      state,
      statePath,
      target,
      targetUserID: targetKeyInfo.userID,
    });
  }
  if (includeFulltext) {
    await importFulltext({
      fulltextVersions: snapshot.fulltextVersions,
      source,
      sourceUserID: sourceKeyInfo.userID,
      state,
      statePath,
      target,
      targetUserID: targetKeyInfo.userID,
    });
  }

  await assertSourceUnchanged(source, sourceKeyInfo.userID, sourceSnapshot);
  const verification = await verifyImport({
    includeFiles,
    includeFulltext,
    snapshot,
    state,
    target,
    targetUserID: targetKeyInfo.userID,
  });
  state.target.libraryVersion = verification.libraryVersion;
  state.verifiedAt = new Date().toISOString();
  saveImportState(statePath, state);

  log(`\nImport verified at ${state.verifiedAt}.`);
  log(`State: ${resolve(statePath)}`);
  return { executed: true, state, summary, verification };
};

const writeObjectBatches = async ({
  client,
  objects,
  path,
  state,
  stateKey,
  statePath,
  targetLibraryVersion,
}) => {
  const completed = new Set(state.completed[stateKey]);
  const remaining = objects.filter((object) => !completed.has(object.key));
  for (const currentBatch of batches(remaining, 50)) {
    const response = await client.request(path, {
      body: JSON.stringify(currentBatch),
      headers: {
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": String(targetLibraryVersion),
        "User-Agent": "Zotero Self-Host Importer",
      },
      method: "POST",
    });
    const text = await response.text();
    const body = parsePossibleJSON(text);
    if (response.status !== 200) {
      throw new HTTPResponseError(
        `Could not write ${stateKey} (HTTP ${response.status}).`,
        { body, response }
      );
    }
    assertSuccessfulWriteReport(body, currentBatch, stateKey);
    targetLibraryVersion = headerVersion(response) ?? targetLibraryVersion + 1;
    state.completed[stateKey].push(
      ...currentBatch.map((object) => {
        const record = requireRecord(object, `${stateKey} write object`);
        if (typeof record.key !== "string") {
          throw new Error(`${stateKey} write object did not contain a key.`);
        }
        return record.key;
      })
    );
    saveImportState(statePath, state);
  }
  return targetLibraryVersion;
};

const writeSettings = async ({
  client,
  settings,
  state,
  statePath,
  targetLibraryVersion,
  userID,
}) => {
  const completed = new Set(state.completed.settings);
  const entries = Object.entries(settings).filter(
    ([key]) => !completed.has(key)
  );
  for (const currentBatch of batches(entries, 50)) {
    const body = Object.fromEntries(currentBatch);
    const response = await client.request(`/users/${userID}/settings`, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": String(targetLibraryVersion),
      },
      method: "POST",
    });
    const text = await response.text();
    if (!(response.status === 200 || response.status === 204)) {
      throw new HTTPResponseError(
        `Could not write settings (HTTP ${response.status}).`,
        { body: parsePossibleJSON(text), response }
      );
    }
    targetLibraryVersion = headerVersion(response) ?? targetLibraryVersion + 1;
    state.completed.settings.push(...currentBatch.map(([key]) => key));
    saveImportState(statePath, state);
  }
  return targetLibraryVersion;
};

const importFulltext = async ({
  fulltextVersions,
  source,
  sourceUserID,
  state,
  statePath,
  target,
  targetUserID,
}) => {
  const completed = new Set(state.completed.fulltext);
  for (const key of Object.keys(fulltextVersions).sort()) {
    if (completed.has(key)) {
      continue;
    }
    const sourceResult = await source.json(
      `/users/${sourceUserID}/items/${key}/fulltext`
    );
    const response = await target.request(
      `/users/${targetUserID}/items/${key}/fulltext`,
      {
        body: JSON.stringify(sourceResult.body),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }
    );
    if (response.status !== 204) {
      throw new HTTPResponseError(
        `Could not import full text for ${key} (HTTP ${response.status}).`,
        { body: await response.text(), response }
      );
    }
    state.completed.fulltext.push(key);
    saveImportState(statePath, state);
  }
};

const verifyImport = async ({
  includeFiles,
  includeFulltext,
  snapshot,
  state,
  target,
  targetUserID,
}) => {
  const inventory = await readInventory(target, targetUserID);
  assertKeySubset(
    snapshot.collections.map(({ key }) => key),
    inventory.collectionKeys,
    "collections"
  );
  assertKeySubset(
    snapshot.items.map(({ key }) => key),
    inventory.itemKeys,
    "items"
  );
  assertKeySubset(
    snapshot.searches.map(({ key }) => key),
    inventory.searchKeys,
    "searches"
  );
  assertKeySubset(
    Object.keys(snapshot.settings),
    inventory.settingKeys,
    "settings"
  );
  assertObjectData(snapshot.collections, inventory.collections, "collections");
  assertObjectData(snapshot.items, inventory.items, "items");
  assertObjectData(snapshot.searches, inventory.searches, "searches");
  assertSettingData(snapshot.settings, inventory.settings);

  if (includeFiles) {
    const fileState = new Map(
      state.completed.files.map((entry) => [entry.key, entry])
    );
    for (const attachment of snapshot.attachments) {
      const expected = fileState.get(attachment.key) as
        | Record<string, unknown>
        | undefined;
      if (!expected) {
        throw new Error(
          `Attachment ${attachment.key} was not recorded as imported.`
        );
      }
      const response = await target.request(
        `/users/${targetUserID}/items/${attachment.key}/file`,
        { redirect: "manual" }
      );
      if (
        !(
          response.status === 200 ||
          (response.status >= 300 && response.status < 400)
        )
      ) {
        throw new Error(
          `Attachment ${attachment.key} verification returned HTTP ${response.status}.`
        );
      }
      const md5 = cleanMd5(
        response.headers.get("Zotero-File-MD5") ?? response.headers.get("ETag")
      );
      if (typeof expected.itemMd5 !== "string") {
        throw new Error(
          `Attachment ${attachment.key} import state omitted its item MD5.`
        );
      }
      if (md5 && md5 !== expected.itemMd5) {
        throw new Error(
          `Attachment ${attachment.key} target MD5 ${md5} does not match ${expected.itemMd5}.`
        );
      }
    }
  }

  if (includeFulltext) {
    const targetResult = await target.json(
      `/users/${targetUserID}/fulltext?since=0`
    );
    const targetFulltext = requireRecord(
      targetResult.body,
      "Target full-text inventory"
    );
    assertKeySubset(
      Object.keys(snapshot.fulltextVersions),
      Object.keys(targetFulltext),
      "full-text records"
    );
  }

  return {
    attachments: includeFiles ? snapshot.attachments.length : 0,
    collections: snapshot.collections.length,
    fulltext: includeFulltext
      ? Object.keys(snapshot.fulltextVersions).length
      : 0,
    items: snapshot.items.length,
    libraryVersion: inventory.libraryVersion,
    searches: snapshot.searches.length,
    settings: Object.keys(snapshot.settings).length,
  };
};

const assertSourceUnchanged = async (client, userID, snapshot) => {
  const response = await client.request(
    `/users/${userID}/items?format=versions&includeTrashed=1`
  );
  if (response.status !== 200) {
    throw new Error(
      `Could not recheck the source library (HTTP ${response.status}).`
    );
  }
  const version = headerVersion(response);
  if (version !== null && version !== snapshot.libraryVersion) {
    throw new Error(
      `Zotero.org changed from library version ${snapshot.libraryVersion} to ${version} during import. Re-run the importer before migrating the Desktop profile.`
    );
  }
};

const getKeyInfo = async (client, label) => {
  const { body } = await client.json("/keys/current");
  const info = requireRecord(body, `${label} key check`);
  if (
    typeof info.userID !== "number" ||
    !Number.isInteger(info.userID) ||
    info.userID < 1
  ) {
    throw new Error(`${label} key check did not return a valid userID.`);
  }
  return info;
};

const assertOwnerKey = async (client, userID) => {
  const response = await client.request(`/users/${userID}/keys`);
  if (response.status !== 200) {
    throw new Error(
      "SELFHOST_API_KEY must be an owner key so the import can write all synced settings and later create per-device keys."
    );
  }
};

const summarizeSnapshot = (
  snapshot,
  { includeFiles, includeFulltext, recoveredAttachments, targetCount }
) => ({
  attachments: includeFiles ? snapshot.attachments.length : 0,
  collections: snapshot.collections.length,
  fulltext: includeFulltext ? Object.keys(snapshot.fulltextVersions).length : 0,
  items: snapshot.items.length,
  libraryVersion: snapshot.libraryVersion,
  recoveredAttachments: includeFiles ? recoveredAttachments : 0,
  searches: snapshot.searches.length,
  settings: Object.keys(snapshot.settings).length,
  targetExistingObjects: targetCount,
  unavailableAttachments: includeFiles
    ? snapshot.unavailableAttachmentKeys.length
    : 0,
});

const printSummary = (summary, { execute, log, merge }) => {
  log("\nImport inventory:");
  log(`  Source library version: ${summary.libraryVersion}`);
  log(`  Collections:            ${summary.collections}`);
  log(`  Items (including trash): ${summary.items}`);
  log(`  Stored attachments:      ${summary.attachments}`);
  log(`  Recovered archive files:  ${summary.recoveredAttachments}`);
  log(`  Unavailable stored files: ${summary.unavailableAttachments}`);
  log(`  Saved searches:          ${summary.searches}`);
  log(`  Synced settings:         ${summary.settings}`);
  log(`  Full-text records:       ${summary.fulltext}`);
  log(`  Existing target objects: ${summary.targetExistingObjects}`);
  if (summary.unavailableAttachments > 0) {
    log(
      "  Note: unavailable source files retain their attachment metadata but have no bytes to copy or verify."
    );
  }
  if (!execute) {
    log(
      "\nDry run only. Re-run with --execute after reviewing this inventory."
    );
  } else if (merge) {
    log("\nMerge mode is enabled; existing target keys will be reconciled.");
  }
};

const assertSuccessfulWriteReport = (body, objects, label) => {
  const report = requireRecord(body, `${label} write report`);
  const failed = requireRecord(report.failed ?? {}, `${label} failures`);
  if (Object.keys(failed).length > 0) {
    throw new Error(`${label} write failed: ${JSON.stringify(failed)}`);
  }
  const success = requireRecord(report.success ?? {}, `${label} success`);
  const successful = requireRecord(
    report.successful ?? {},
    `${label} successful`
  );
  const unchanged = requireRecord(report.unchanged ?? {}, `${label} unchanged`);
  const acknowledged = new Set([
    ...Object.keys(success),
    ...Object.keys(successful),
    ...Object.keys(unchanged),
  ]);
  if (objects.some((_object, index) => !acknowledged.has(String(index)))) {
    throw new Error(`${label} write report did not acknowledge every object.`);
  }
};

const assertKeySubset = (expected, actual, label) => {
  const actualKeys = new Set(actual);
  const missing = expected.filter((key) => !actualKeys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Target is missing ${missing.length} ${label}: ${missing.slice(0, 10).join(", ")}`
    );
  }
};

const assertObjectData = (expected, actual, label) => {
  const actualByKey = new Map(actual.map((object) => [object.key, object]));
  for (const expectedObject of expected) {
    const actualObject = actualByKey.get(expectedObject.key);
    const comparableExpected = comparableObject(expectedObject, label);
    const comparableActual = comparableObject(actualObject, label);
    if (
      !actualObject ||
      JSON.stringify(stableValue(comparableActual)) !==
        JSON.stringify(stableValue(comparableExpected))
    ) {
      throw new Error(
        `Target ${label} data does not match source object ${expectedObject.key}.`
      );
    }
  }
};

const comparableObject = (object, label) => {
  if (!(object && label === "items")) {
    return object;
  }
  const { dateModified: _dateModified, ...comparable } = object;
  return comparable;
};

const assertSettingData = (expected, actual) => {
  for (const [key, expectedSetting] of Object.entries(expected)) {
    if (
      JSON.stringify(stableValue(actual[key])) !==
      JSON.stringify(stableValue(expectedSetting))
    ) {
      throw new Error(`Target setting ${key} does not match the source value.`);
    }
  }
};

const stableValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
};

const batches = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
};

const assertSecret = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must not be empty.`);
  }
};
