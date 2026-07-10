import { createCompatibilityStore } from "../../../domain/storage";
import { compatibility } from "../router";
import {
  filterChildItems,
  filterItemsForRequest,
  parseNumericID,
  renderItemList,
  requireGroup,
  requireUser,
} from "../support";

compatibility.get("/groups/:groupID/items/:itemKey/children", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const parent = await store.getGroupItem(groupID, c.req.param("itemKey"));
  if (!parent) {
    return c.text("Item not found", 404);
  }

  const result = await store.listGroupItems(groupID);
  const items = await filterItemsForRequest(
    c,
    "group",
    groupID,
    filterChildItems(result.items, c.req.param("itemKey")),
    result.items
  );

  return renderItemList(c, items, result.version);
});

compatibility.get("/users/:userID/items/:itemKey/children", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const parent = await store.getItem(userID, c.req.param("itemKey"));
  if (!parent) {
    return c.text("Item not found", 404);
  }

  const result = await store.listItems(userID);
  const items = await filterItemsForRequest(
    c,
    "user",
    userID,
    filterChildItems(result.items, c.req.param("itemKey")),
    result.items
  );

  return renderItemList(c, items, result.version);
});
