import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, getRequestedCollectionKeys, renderCollectionList, renderItemList, filterItemsForRequest, getIfUnmodifiedSinceVersion, normalizeObjectBatchDeletedForWrite, upsertCollectionInLibrary } from "./shared";
import { createCollectionStore } from "../../collections";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


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
