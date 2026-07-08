import { parseNumericID, requireUserWrite, requireGroupEdit, updateItemInLibrary } from "./shared";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


compatibility.patch("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: groupID,
    libraryType: "group",
    patchMode: true,
    store,
  });
});


compatibility.put("/groups/:groupID/items/:itemKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: groupID,
    libraryType: "group",
    patchMode: false,
    store,
  });
});


compatibility.patch("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: userID,
    libraryType: "user",
    patchMode: true,
    store,
  });
});


compatibility.put("/users/:userID/items/:itemKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  return updateItemInLibrary(c, {
    itemKey: c.req.param("itemKey"),
    libraryID: userID,
    libraryType: "user",
    patchMode: false,
    store,
  });
});
