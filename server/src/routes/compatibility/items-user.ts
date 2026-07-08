import { parseNumericID, requireUser, requireUserWrite, handleItemBatchWrite, attachItemMeta, renderItemList, renderItemListHead, renderSingleItem, filterItemsForRequest, handleWebTranslationWrite, type ItemWriteFailures, mergeItemWriteFailures, type ExistingObjectVersions, evaluateBatchWritePreconditions, buildWriteReport, collectionFailureResponse, getIfUnmodifiedSinceVersion, getSinceOrNewerVersion, hasJSONContentType, normalizeItemBatchDeletedForWrite, validateItemBatchCreatorsForWrite, validateItemBatchAnnotationsForWrite, validateItemBatchParentsForWrite, validateItemBatchAnnotationParentsForWrite, syncRelatedItemRelations } from "./shared";
import { createCollectionStore } from "../../collections";
import { createFullTextStore } from "../../fulltext";
import { createCompatibilityStore } from "../../storage";
import { validateItemBatchRelationsForWrite } from "../../relations";
import { validateItemBatchNotesForWrite } from "../../notes";
import { notificationHeaders, topicUpdatedNotification } from "../../notifications";
import { normalizeItemBatchTagsForWrite } from "../../tags";
import { compatibility } from "./router";


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

  const library = await store.listItems(userID);
  return renderSingleItem(
    c,
    await attachItemMeta(c, item, {
      allItems: library.items,
      libraryID: userID,
      libraryType: "user",
      store,
    }),
    result.version
  );
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

  return handleItemBatchWrite(c, {
    libraryID: userID,
    libraryType: "user",
    store,
  });
});
