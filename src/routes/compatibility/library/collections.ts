import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { createCollectionStore } from "../../../domain/collections";
import { createCompatibilityStore } from "../../../domain/storage";
import { compatibility } from "../router";
import {
  atomHeaders,
  buildWriteReport,
  type ExistingObjectVersions,
  filterItemsForRequest,
  getIfUnmodifiedSinceVersion,
  getRequestedCollectionKeys,
  type ItemWriteFailures,
  isRecord,
  jsonValuesEqual,
  normalizeObjectDeletedForWrite,
  parseNumericID,
  renderCollectionList,
  renderItemList,
  renderJSONAtomEntry,
  requireGroup,
  requireGroupEdit,
  requireUser,
  requireUserWrite,
  upsertCollectionInLibrary,
  wantsAtomResponse,
} from "../support";

type LibraryType = "group" | "user";

const stripVersionForCompare = (data: Record<string, unknown>) => {
  const { version: _version, ...rest } = data;
  return rest;
};

const mergeWriteFailures = (
  target: ItemWriteFailures,
  source: ItemWriteFailures
) => {
  for (const [index, failure] of Object.entries(source)) {
    if (!(index in target)) {
      target[index] = failure;
    }
  }
};

const parseCollectionItemKeysBody = async (
  c: Context<{ Bindings: Bindings }>
) =>
  (await c.req.text())
    .split(/\s+/)
    .map((key) => key.trim())
    .filter(Boolean);

const updateCollectionItemMembership = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    collectionKey: string;
    libraryID: number;
    libraryType: LibraryType;
    mode: "add" | "remove";
  }
) => {
  const collectionStore = createCollectionStore(c.env);
  const collection = await collectionStore.getCollection(
    input.libraryType,
    input.libraryID,
    input.collectionKey
  );
  if (!collection) {
    return c.text("Collection not found", 404);
  }

  const itemKeys = await parseCollectionItemKeysBody(c);
  if (!itemKeys.length) {
    return c.body(null, 204, {
      "Last-Modified-Version": `${collection.version}`,
    });
  }

  const store = createCompatibilityStore(c.env);
  const result =
    input.libraryType === "user"
      ? await store.listItems(input.libraryID, itemKeys)
      : await store.listGroupItems(input.libraryID, itemKeys);
  const byKey = new Map(result.items.map((item) => [item.key, item]));
  const updates: Record<string, unknown>[] = [];

  for (const itemKey of itemKeys) {
    const item = byKey.get(itemKey);
    if (!item) {
      return c.text("Item not found", 404);
    }
    const collections = Array.isArray(item.data.collections)
      ? item.data.collections.filter(
          (key): key is string => typeof key === "string"
        )
      : [];
    const nextCollections =
      input.mode === "add"
        ? [...new Set([...collections, input.collectionKey])]
        : collections.filter((key) => key !== input.collectionKey);
    updates.push({
      ...item.data,
      collections: nextCollections,
      key: item.key,
      version: item.version,
    });
  }

  const writeResult =
    input.libraryType === "user"
      ? await store.createItems(input.libraryID, updates)
      : await store.createGroupItems(input.libraryID, updates);

  return c.body(null, 204, {
    "Last-Modified-Version": `${writeResult.version}`,
  });
};

const mapStoreFailuresToOriginalIndexes = (
  failed: ItemWriteFailures,
  written: Array<{ index: number; object: Record<string, unknown> }>
): ItemWriteFailures => {
  const mapped: ItemWriteFailures = {};
  for (const [position, failure] of Object.entries(failed)) {
    const originalIndex = written[Number(position)]?.index ?? Number(position);
    mapped[originalIndex] = failure;
  }
  return mapped;
};

const handleCollectionBatchWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: LibraryType;
  }
) => {
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body)) {
    return c.text("Uploaded data must be a JSON array", 400);
  }

  const failed: ItemWriteFailures = {};
  const rawCollections = (body as unknown[]).map((entry, index) => {
    if (isRecord(entry)) {
      return { ...entry };
    }
    failed[index] = {
      code: 400,
      message: `Invalid value for index ${index} in uploaded data; expected JSON collection object`,
    };
    return {};
  });

  const collectionStore = createCollectionStore(c.env);
  const library = await collectionStore.listCollections(
    input.libraryType,
    input.libraryID,
    undefined,
    { includeMeta: false }
  );
  const existingVersions: ExistingObjectVersions = new Map(
    library.collections.map((collection) => [
      collection.key,
      { data: collection.data ?? {}, version: collection.version ?? 0 },
    ])
  );
  const collectionPrecondition = getIfUnmodifiedSinceVersion(c);
  if (
    collectionPrecondition !== null &&
    collectionPrecondition !== library.version
  ) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${library.version}`,
    });
  }

  const finalCollections = rawCollections.map((object) => {
    const key = typeof object.key === "string" ? object.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    return current ? { ...current.data, ...object, key } : { ...object };
  });

  const unchanged: Record<string, string> = {};
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];
  for (const [index, final] of finalCollections.entries()) {
    if (index in failed) {
      continue;
    }
    const key = typeof final.key === "string" ? final.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    const comparableFinal = normalizeObjectDeletedForWrite({ ...final });
    if (
      current &&
      jsonValuesEqual(
        stripVersionForCompare(comparableFinal),
        stripVersionForCompare(current.data)
      )
    ) {
      unchanged[index] = key;
    }
    toWrite.push({ index, object: final });
  }

  const result = toWrite.length
    ? await collectionStore.createCollections(
        input.libraryType,
        input.libraryID,
        toWrite.map((entry) => entry.object),
        collectionPrecondition
      )
    : {
        failed: {} as ItemWriteFailures,
        preconditionFailed: false,
        success: [] as string[],
        successful: [] as never[],
        unchanged: [] as Array<{ key: string }>,
        version: library.version,
      };

  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${result.version}`,
    });
  }

  mergeWriteFailures(
    failed,
    mapStoreFailuresToOriginalIndexes(result.failed, toWrite)
  );

  for (const collection of result.unchanged) {
    const original = toWrite.find(
      (entry) => entry.object.key === collection.key
    );
    if (original) {
      unchanged[original.index] = collection.key;
    }
  }

  const successfulWrites = toWrite.filter(
    (entry, position) =>
      !(position in result.failed || entry.index in unchanged)
  );

  return c.json(
    buildWriteReport(successfulWrites, result.successful, failed, unchanged),
    200,
    {
      "Last-Modified-Version": `${result.version}`,
    }
  );
};

const deleteSingleCollection = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    collectionKey: string;
    libraryID: number;
    libraryType: LibraryType;
  }
) => {
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version header required", 428);
  }

  const result = await createCollectionStore(c.env).deleteCollections(
    input.libraryType,
    input.libraryID,
    [input.collectionKey],
    preconditionVersion
  );
  if (result.preconditionFailed) {
    return c.text("Collection has been modified", 412, {
      "Last-Modified-Version": `${result.version}`,
    });
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
};

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

  const objectVersion = result.collection.version ?? result.version;
  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: result.collection.data ?? {},
        id: `collections/${result.collection.key}`,
        key: result.collection.key,
        title: String(result.collection.data?.name ?? result.collection.key),
        version: objectVersion,
      }),
      200,
      atomHeaders(objectVersion)
    );
  }

  return c.json(result.collection, 200, {
    "Last-Modified-Version": `${objectVersion}`,
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

compatibility.post(
  "/groups/:groupID/collections/:collectionKey/items",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroupEdit(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    return updateCollectionItemMembership(c, {
      collectionKey: c.req.param("collectionKey"),
      libraryID: groupID,
      libraryType: "group",
      mode: "add",
    });
  }
);

compatibility.delete(
  "/groups/:groupID/collections/:collectionKey/items",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroupEdit(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    return updateCollectionItemMembership(c, {
      collectionKey: c.req.param("collectionKey"),
      libraryID: groupID,
      libraryType: "group",
      mode: "remove",
    });
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

  return handleCollectionBatchWrite(c, {
    libraryID: groupID,
    libraryType: "group",
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

compatibility.patch(
  "/groups/:groupID/collections/:collectionKey",
  async (c) => {
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
      patchMode: true,
    });
  }
);

compatibility.delete(
  "/groups/:groupID/collections/:collectionKey",
  async (c) => {
    const groupID = parseNumericID(c.req.param("groupID"));
    if (groupID === null) {
      return c.text("Invalid groupID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireGroupEdit(c, store, groupID))) {
      return c.text("Invalid key", 403);
    }

    return deleteSingleCollection(c, {
      collectionKey: c.req.param("collectionKey"),
      libraryID: groupID,
      libraryType: "group",
    });
  }
);

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

  const objectVersion = result.collection.version ?? result.version;
  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: result.collection.data ?? {},
        id: `collections/${result.collection.key}`,
        key: result.collection.key,
        title: String(result.collection.data?.name ?? result.collection.key),
        version: objectVersion,
      }),
      200,
      atomHeaders(objectVersion)
    );
  }

  return c.json(result.collection, 200, {
    "Last-Modified-Version": `${objectVersion}`,
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
    const items = await filterItemsForRequest(c, "user", userID, result.items);

    return renderItemList(c, items, result.version);
  }
);

compatibility.post(
  "/users/:userID/collections/:collectionKey/items",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireUserWrite(c, store, userID))) {
      return c.text("Invalid key", 403);
    }

    return updateCollectionItemMembership(c, {
      collectionKey: c.req.param("collectionKey"),
      libraryID: userID,
      libraryType: "user",
      mode: "add",
    });
  }
);

compatibility.delete(
  "/users/:userID/collections/:collectionKey/items",
  async (c) => {
    const userID = parseNumericID(c.req.param("userID"));
    if (userID === null) {
      return c.text("Invalid userID", 400);
    }

    const store = createCompatibilityStore(c.env);
    if (!(await requireUserWrite(c, store, userID))) {
      return c.text("Invalid key", 403);
    }

    return updateCollectionItemMembership(c, {
      collectionKey: c.req.param("collectionKey"),
      libraryID: userID,
      libraryType: "user",
      mode: "remove",
    });
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

  return handleCollectionBatchWrite(c, {
    libraryID: userID,
    libraryType: "user",
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

compatibility.patch("/users/:userID/collections/:collectionKey", async (c) => {
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
    patchMode: true,
  });
});

compatibility.delete("/users/:userID/collections/:collectionKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteSingleCollection(c, {
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
