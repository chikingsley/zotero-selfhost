import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, settingHeaders, getRequiredSinceVersion, getItemKeysForDelete, deleteItemsForLibrary } from "./shared";
import { createDeletedStore } from "../../deleted";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


compatibility.get("/groups/:groupID/deleted", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const sinceVersion = getRequiredSinceVersion(c);
  if (sinceVersion === null) {
    return c.text("'since' parameter must be provided", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createDeletedStore(c.env).listDeleted(
    "group",
    groupID,
    sinceVersion
  );

  return c.json(result.deleted, 200, settingHeaders(result.version));
});


compatibility.get("/users/:userID/deleted", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const sinceVersion = getRequiredSinceVersion(c);
  if (sinceVersion === null) {
    return c.text("'since' parameter must be provided", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createDeletedStore(c.env).listDeleted(
    "user",
    userID,
    sinceVersion
  );

  return c.json(result.deleted, 200, settingHeaders(result.version));
});


compatibility.delete("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c, c.req.param("itemKey")),
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});


compatibility.delete("/groups/:groupID/items", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c),
    libraryID: groupID,
    libraryType: "group",
    store,
  });
});


compatibility.delete("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c, c.req.param("itemKey")),
    libraryID: userID,
    libraryType: "user",
    store,
  });
});


compatibility.delete("/users/:userID/items", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return deleteItemsForLibrary(c, {
    itemKeys: getItemKeysForDelete(c),
    libraryID: userID,
    libraryType: "user",
    store,
  });
});
