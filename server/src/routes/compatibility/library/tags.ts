import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, attachItemsMeta, renderItemList, filterItemsForRequest, resolveTopLevelItems, renderTagList, getURLSearchParams, deleteTagsForLibrary } from "../shared";
import { createCollectionStore } from "../../../collections";
import { createCompatibilityStore } from "../../../storage";
import {
  filterTopItems,
  hasNegatedTagExpressions,
  itemMatchesTagFilterExpressions,
  listTagsForRequest,
} from "../../../tags";
import { compatibility } from "../router";


const requestIncludesTrashed = (c: Parameters<typeof getURLSearchParams>[0]) =>
  c.req.query("includeTrashed") === "1";


const filterTopResultsForNegatedTags = <
  T extends { data: Record<string, unknown>; key: string; version: number },
>(
  c: Parameters<typeof getURLSearchParams>[0],
  items: T[]
) => {
  const tagExpressions = getURLSearchParams(c).getAll("tag").filter(Boolean);
  if (!hasNegatedTagExpressions(tagExpressions)) {
    return items;
  }
  return items.filter((item) =>
    itemMatchesTagFilterExpressions(item, tagExpressions)
  );
};


compatibility.get("/groups/:groupID/collections/:collectionKey/items/top/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "group",
    groupID,
    c.req.param("collectionKey"),
    true
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/groups/:groupID/collections/:collectionKey/items/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "group",
    groupID,
    c.req.param("collectionKey")
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/users/:userID/collections/:collectionKey/items/top/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "user",
    userID,
    c.req.param("collectionKey"),
    true
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/users/:userID/collections/:collectionKey/items/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const collectionStore = createCollectionStore(c.env);
  const result = await collectionStore.listCollectionItems(
    "user",
    userID,
    c.req.param("collectionKey")
  );
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/groups/:groupID/items/top/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(filterTopItems(result.items), getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/groups/:groupID/items/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/users/:userID/items/top/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(filterTopItems(result.items), getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/users/:userID/items/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.get("/groups/:groupID/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.delete("/groups/:groupID/tags", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteTagsForLibrary(c, {
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});


compatibility.get("/users/:userID/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const tags = listTagsForRequest(result.items, getURLSearchParams(c));

  return renderTagList(c, tags, result.version);
});


compatibility.delete("/users/:userID/tags", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteTagsForLibrary(c, {
    libraryID: userID,
    libraryType: "user",
    store,
  });
});


compatibility.get("/groups/:groupID/items/top", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const includeTrashed = requestIncludesTrashed(c);
  const visible = includeTrashed
    ? result.items
    : result.items.filter((item) => !item.data?.deleted);
  const matched = await filterItemsForRequest(
    c,
    "group",
    groupID,
    visible,
    result.items,
    true
  );
  const topItems = filterTopResultsForNegatedTags(
    c,
    resolveTopLevelItems(matched, visible, includeTrashed)
  );
  const group = (await store.listGroups()).find(
    (candidate) => candidate.id === groupID
  );

  return renderItemList(
    c,
    await attachItemsMeta(c, topItems, {
      allItems: result.items,
      groupName:
        typeof group?.data.name === "string" ? group.data.name : undefined,
      libraryID: groupID,
      libraryType: "group",
      store,
    }),
    result.version
  );
});


compatibility.get("/groups/:groupID/items/trash", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listGroupItems(groupID);
  const trashed = result.items.filter((item) => Boolean(item.data?.deleted));
  const items = await filterItemsForRequest(
    c,
    "group",
    groupID,
    trashed,
    result.items
  );

  const group = (await store.listGroups()).find(
    (candidate) => candidate.id === groupID
  );
  return renderItemList(
    c,
    await attachItemsMeta(c, items, {
      allItems: result.items,
      groupName:
        typeof group?.data.name === "string" ? group.data.name : undefined,
      libraryID: groupID,
      libraryType: "group",
      store,
    }),
    result.version
  );
});


compatibility.get("/users/:userID/items/trash", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const trashed = result.items.filter((item) => Boolean(item.data?.deleted));
  const items = await filterItemsForRequest(
    c,
    "user",
    userID,
    trashed,
    result.items
  );

  return renderItemList(
    c,
    await attachItemsMeta(c, items, {
      allItems: result.items,
      libraryID: userID,
      libraryType: "user",
      store,
    }),
    result.version
  );
});


compatibility.get("/users/:userID/items/top", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await store.listItems(userID);
  const includeTrashed = requestIncludesTrashed(c);
  const visible = includeTrashed
    ? result.items
    : result.items.filter((item) => !item.data?.deleted);
  const matched = await filterItemsForRequest(
    c,
    "user",
    userID,
    visible,
    result.items,
    true
  );
  const topItems = filterTopResultsForNegatedTags(
    c,
    resolveTopLevelItems(matched, visible, includeTrashed)
  );

  return renderItemList(
    c,
    await attachItemsMeta(c, topItems, {
      allItems: result.items,
      libraryID: userID,
      libraryType: "user",
      store,
    }),
    result.version
  );
});
