import { requireRecord } from "./http.mjs";

const storedFileLinkModes = new Set([
  "embedded_image",
  "imported_file",
  "imported_url",
]);

export const readSnapshot = async (client, userID, { includeFulltext }) => {
  const [collectionPage, itemPage, searchPage, settingsResult] =
    await Promise.all([
      readAllPages(client, `/users/${userID}/collections`),
      readAllPages(client, `/users/${userID}/items`, {
        includeTrashed: "1",
      }),
      readAllPages(client, `/users/${userID}/searches`),
      client.json(`/users/${userID}/settings`),
    ]);

  const observedVersions = new Set([
    collectionPage.libraryVersion,
    itemPage.libraryVersion,
    searchPage.libraryVersion,
    headerVersion(settingsResult.response),
  ]);
  observedVersions.delete(null);
  if (observedVersions.size !== 1) {
    throw new Error(
      "The source library changed while it was being read. Wait for Zotero.org sync to finish and retry."
    );
  }

  const collections = collectionPage.objects.map(editableObject);
  const items = itemPage.objects.map(editableObject);
  const searches = searchPage.objects.map(editableObject);
  const settings = normalizeSettings(settingsResult.body);
  const attachmentCandidates = items.filter(isStoredAttachmentCandidate);
  const invalidAttachment = attachmentCandidates.find(
    (attachment) => !isStoredAttachment(attachment)
  );
  if (invalidAttachment) {
    throw new Error(
      `Stored attachment ${invalidAttachment.key} is missing filename, mtime, or MD5 metadata and cannot be verified.`
    );
  }
  let fulltextVersions = {};
  if (includeFulltext) {
    const result = await client.json(`/users/${userID}/fulltext?since=0`);
    fulltextVersions = requireRecord(result.body, "Full-text inventory");
  }

  return {
    attachments: attachmentCandidates,
    collections,
    fulltextVersions,
    items,
    libraryVersion: [...observedVersions][0] ?? 0,
    searches,
    settings,
  };
};

export const readInventory = async (client, userID) => {
  const [collections, items, searches, settings] = await Promise.all([
    readAllPages(client, `/users/${userID}/collections`),
    readAllPages(client, `/users/${userID}/items`, { includeTrashed: "1" }),
    readAllPages(client, `/users/${userID}/searches`),
    client.json(`/users/${userID}/settings`),
  ]);
  const versions = [
    collections.libraryVersion,
    items.libraryVersion,
    searches.libraryVersion,
    headerVersion(settings.response),
  ].filter((value) => value !== null);
  const normalizedSettings = normalizeSettings(settings.body);
  return {
    collectionKeys: objectKeys(collections.objects),
    collections: collections.objects.map(editableObject),
    itemKeys: objectKeys(items.objects),
    items: items.objects.map(editableObject),
    libraryVersion: Math.max(0, ...versions),
    searches: searches.objects.map(editableObject),
    searchKeys: objectKeys(searches.objects),
    settingKeys: Object.keys(normalizedSettings),
    settings: normalizedSettings,
  };
};

export const remapSnapshotUserIdentity = (
  snapshot,
  sourceUserID,
  targetUserID
) => {
  if (sourceUserID === targetUserID) {
    return snapshot;
  }
  const remap = (object) =>
    remapUserIdentityValue(object, sourceUserID, targetUserID);
  const items = snapshot.items.map(remap);
  return {
    ...snapshot,
    attachments: items.filter(isStoredAttachment),
    collections: snapshot.collections.map(remap),
    items,
    searches: snapshot.searches.map(remap),
    settings: remap(snapshot.settings),
  };
};

export const orderCollections = (collections) =>
  dependencyOrder(collections, (collection) =>
    typeof collection.parentCollection === "string"
      ? collection.parentCollection
      : null
  );

export const orderItems = (items) =>
  dependencyOrder(items, (item) =>
    typeof item.parentItem === "string" ? item.parentItem : null
  );

export const headerVersion = (response) => {
  const value = Number.parseInt(
    response.headers.get("Last-Modified-Version") ?? "",
    10
  );
  return Number.isFinite(value) ? value : null;
};

export const inventoryObjectCount = (inventory) =>
  inventory.collectionKeys.length +
  inventory.itemKeys.length +
  inventory.searchKeys.length +
  inventory.settingKeys.length;

const readAllPages = async (client, path, extraParameters = {}) => {
  const objects = [];
  let libraryVersion = null;
  let start = 0;

  while (true) {
    const url = new URL(path, client.baseURL);
    url.searchParams.set("format", "json");
    url.searchParams.set("include", "data");
    url.searchParams.set("limit", "100");
    url.searchParams.set("start", String(start));
    for (const [key, value] of Object.entries(extraParameters)) {
      url.searchParams.set(key, value);
    }

    const { body, response } = await client.json(url);
    if (!Array.isArray(body)) {
      throw new Error(`${url.pathname} did not return a JSON array.`);
    }
    const pageVersion = headerVersion(response);
    if (libraryVersion === null) {
      libraryVersion = pageVersion;
    } else if (pageVersion !== null && pageVersion !== libraryVersion) {
      throw new Error(
        `The library changed while reading ${url.pathname}; retry from a stable source.`
      );
    }
    objects.push(...body);

    const total = Number.parseInt(
      response.headers.get("Total-Results") ?? String(objects.length),
      10
    );
    if (body.length === 0 || objects.length >= total) {
      break;
    }
    start += body.length;
  }

  return { libraryVersion: libraryVersion ?? 0, objects };
};

const editableObject = (envelope) => {
  const record = requireRecord(envelope, "API object");
  const data = requireRecord(record.data, "API object data");
  const key = typeof data.key === "string" ? data.key : record.key;
  if (typeof key !== "string") {
    throw new Error("An API object did not contain a key.");
  }
  const editable = structuredClone(data);
  editable.key = key;
  delete editable.version;
  if (editable.itemType === "attachment") {
    if (typeof editable.md5 === "string") {
      editable.md5 = editable.md5.toLowerCase();
    }
    if (typeof editable.mtime === "string" && /^\d+$/u.test(editable.mtime)) {
      editable.mtime = Number.parseInt(editable.mtime, 10);
    }
  }
  return editable;
};

const normalizeSettings = (body) => {
  const settings = requireRecord(body, "Settings inventory");
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => {
      const setting = requireRecord(value, `Setting ${key}`);
      return [key, { value: setting.value }];
    })
  );
};

const remapUserIdentityValue = (value, sourceUserID, targetUserID) => {
  if (typeof value === "string") {
    return value
      .replaceAll(
        `http://zotero.org/users/${sourceUserID}/`,
        `http://zotero.org/users/${targetUserID}/`
      )
      .replaceAll(
        `http%3A%2F%2Fzotero.org%2Fusers%2F${sourceUserID}%2F`,
        `http%3A%2F%2Fzotero.org%2Fusers%2F${targetUserID}%2F`
      );
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      remapUserIdentityValue(entry, sourceUserID, targetUserID)
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        remapUserIdentityValue(entry, sourceUserID, targetUserID),
      ])
    );
  }
  return value;
};

const dependencyOrder = (objects, parentKey) => {
  const pending = new Map(objects.map((object) => [object.key, object]));
  const ordered = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [key, object] of pending) {
      const parent = parentKey(object);
      if (!(parent && pending.has(parent))) {
        ordered.push(object);
        pending.delete(key);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new Error("The source contains a cyclic parent relationship.");
    }
  }
  return ordered;
};

const isStoredAttachment = (item) =>
  isStoredAttachmentCandidate(item) &&
  typeof item.filename === "string" &&
  typeof item.md5 === "string" &&
  (typeof item.mtime === "number" || typeof item.mtime === "string");

const isStoredAttachmentCandidate = (item) =>
  item.itemType === "attachment" &&
  typeof item.linkMode === "string" &&
  storedFileLinkModes.has(item.linkMode);

const objectKeys = (objects) =>
  objects
    .map((object) =>
      object && typeof object === "object"
        ? (object.key ?? object.data?.key)
        : null
    )
    .filter((key) => typeof key === "string");
