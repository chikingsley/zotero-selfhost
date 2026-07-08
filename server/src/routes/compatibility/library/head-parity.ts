import { parseNumericID, requireUser, requireGroup, renderTagList, getURLSearchParams, settingHeaders, getRequestedSearchKeys, getSearchSinceVersion, renderSearchList } from "../shared";
import { createSearchStore } from "../../../searches";
import { createCompatibilityStore } from "../../../storage";
import { listTagsForRequest } from "../../../tags";
import { compatibility } from "../router";



compatibility.on("HEAD","/groups/:groupID/tags", async (c) => {
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


compatibility.on("HEAD","/users/:userID/tags", async (c) => {
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


compatibility.on("HEAD","/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch("group", groupID, c.req.param("searchKey"));
  if (!result) {
    return c.text("Search not found", 404);
  }

  return c.body(null, 200, settingHeaders(result.search.version));
});


compatibility.on("HEAD","/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("group", groupID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});


compatibility.on("HEAD","/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch("user", userID, c.req.param("searchKey"));
  if (!result) {
    return c.text("Search not found", 404);
  }

  return c.body(null, 200, settingHeaders(result.search.version));
});


compatibility.on("HEAD","/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).listSearches("user", userID, {
    searchKeys: getRequestedSearchKeys(c),
    sinceVersion: getSearchSinceVersion(c),
  });

  return renderSearchList(c, result.searches, result.version);
});
