import { parseNumericID, requireGroup, requireGroupEdit, handleItemBatchWrite, attachItemMeta, renderItemList, renderItemListHead, renderSingleItem, filterItemsForRequest, handleWebTranslationWrite, tagWriteFailureResponse, type ItemWriteFailures, mergeItemWriteFailures, collectionFailureResponse, getIfUnmodifiedSinceVersion, getSinceOrNewerVersion, hasJSONContentType, normalizeItemBatchDeletedForWrite, validateItemBatchCreatorsForWrite, validateItemBatchAnnotationsForWrite, validateItemBatchParentsForWrite, validateItemBatchAnnotationParentsForWrite, syncRelatedItemRelations } from "./shared";
import { createCollectionStore } from "../../collections";
import { createFullTextStore } from "../../fulltext";
import { createCompatibilityStore } from "../../storage";
import { validateItemBatchRelationsForWrite } from "../../relations";
import { validateItemBatchNotesForWrite } from "../../notes";
import { notificationHeaders, topicUpdatedNotification } from "../../notifications";
import { normalizeItemBatchTagsForWrite } from "../../tags";
import { compatibility } from "./router";


compatibility.get("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.getGroupItem(groupID, c.req.param("itemKey"));
  if (!result) {
    return c.text("Item not found", 404);
  }

  const item = result.items[0];
  if (!item) {
    return c.text("Item not found", 404);
  }

  const library = await store.listGroupItems(groupID);
  const group = (await store.listGroups()).find(
    (candidate) => candidate.id === groupID
  );
  return renderSingleItem(
    c,
    attachItemMeta(c, item, {
      allItems: library.items,
      groupName:
        typeof group?.data.name === "string" ? group.data.name : undefined,
      libraryID: groupID,
      libraryType: "group",
    }),
    result.version
  );
});


compatibility.get("/groups/:groupID/items/:itemKey/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const record = await createFullTextStore(c.env).getContent(
    "group",
    groupID,
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


compatibility.put("/groups/:groupID/items/:itemKey/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }
  if (!hasJSONContentType(c)) {
    return c.text("Content-Type must be application/json", 400);
  }

  const body = await c.req.json().catch(() => null);
  const result = await createFullTextStore(c.env).upsertContent(
    "group",
    groupID,
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


compatibility.get("/groups/:groupID/fulltext/index", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return c.json({ status: "indexed" });
});


compatibility.get("/groups/:groupID/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createFullTextStore(c.env).listVersions(
    "group",
    groupID,
    getSinceOrNewerVersion(c)
  );

  return c.json(result.versions, 200, {
    "Last-Modified-Version": `${result.version}`,
  });
});


compatibility.post("/groups/:groupID/fulltext", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
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
    "group",
    groupID,
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


compatibility.on("HEAD","/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listGroupItems(groupID, itemKeys);
  const items = await filterItemsForRequest(c, "group", groupID, result.items);

  return renderItemListHead(c, items, result.version);
});


compatibility.get("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const itemKeys = c.req.query("itemKey")?.split(",");
  const result = await store.listGroupItems(groupID, itemKeys);
  const items = await filterItemsForRequest(c, "group", groupID, result.items);

  return renderItemList(c, items, result.version);
});


compatibility.post("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return handleItemBatchWrite(c, {
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});
