import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, renderItemList, filterItemsForRequest, renderTagList, getURLSearchParams, deleteTagsForLibrary } from "./shared";
import { createCollectionStore } from "../../collections";
import { createCompatibilityStore } from "../../storage";
import { filterTopItems, listTagsForRequest } from "../../tags";
import { compatibility } from "./router";


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
  const items = await filterItemsForRequest(
    c,
    "group",
    groupID,
    filterTopItems(result.items),
    result.items,
    true
  );

  return renderItemList(c, items, result.version);
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
  const items = await filterItemsForRequest(
    c,
    "user",
    userID,
    filterTopItems(result.items),
    result.items,
    true
  );

  return renderItemList(c, items, result.version);
});
