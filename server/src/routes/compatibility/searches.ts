import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, getIfUnmodifiedSinceVersion, checkSingleObjectWriteVersion, normalizeObjectDeletedForWrite, normalizeObjectBatchDeletedForWrite, renderJSONAtomEntry, atomHeaders, wantsAtomResponse, isHeadRequest, settingHeaders, isSettingsObject, getRequestedSearchKeys, getSearchSinceVersion, withSearchSchema, renderSearchList, renderSearchWriteResult, parseSearchWriteBody } from "./shared";
import { createSearchStore } from "../../searches";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


compatibility.get("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch(
    "group",
    groupID,
    c.req.param("searchKey")
  );
  if (!result) {
    return c.text("Search not found", 404);
  }

  if (isHeadRequest(c)) {
    return c.body(null, 200, settingHeaders(result.search.version));
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: withSearchSchema(c, result.search).data,
        id: `searches/${result.search.key}`,
        key: result.search.key,
        title: String(result.search.data.name ?? result.search.key),
        version: result.search.version,
      }),
      200,
      atomHeaders(result.search.version)
    );
  }

  return c.json(withSearchSchema(c, result.search), 200, settingHeaders(result.search.version));
});


compatibility.put("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }
  const searchStore = createSearchStore(c.env);
  const existing = await searchStore.getSearch(
    "group",
    groupID,
    c.req.param("searchKey")
  );
  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Search",
    existing ? existing.search.version ?? 0 : null,
    body,
    "PUT"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }

  const searchData = normalizeObjectDeletedForWrite(versionCheck.editable);
  if (existing && searchData.version === undefined) {
    // The route has already validated the header-supplied version; satisfy
    // the store's per-object version guard.
    searchData.version = existing.search.version;
  }
  const result = await searchStore.upsertSearches(
    "group",
    groupID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.patch("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const searchStore = createSearchStore(c.env);
  const existing = await searchStore.getSearch(
    "group",
    groupID,
    c.req.param("searchKey")
  );
  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Search",
    existing ? existing.search.version ?? 0 : null,
    body,
    "PATCH"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }

  const searchData = normalizeObjectDeletedForWrite(
    existing
      ? { ...existing.search.data, ...versionCheck.editable }
      : versionCheck.editable
  );
  const result = await searchStore.upsertSearches(
    "group",
    groupID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.delete("/groups/:groupID/searches/:searchKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "group",
    groupID,
    [c.req.param("searchKey")],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/groups/:groupID/searches", async (c) => {
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


compatibility.post("/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!Array.isArray(body)) {
    return c.text("Expected a search array", 400);
  }

  const searches = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const result = await createSearchStore(c.env).upsertSearches(
    "group",
    groupID,
    searches,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return renderSearchWriteResult(c, result);
});


compatibility.delete("/groups/:groupID/searches", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "group",
    groupID,
    getRequestedSearchKeys(c) ?? [],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).getSearch(
    "user",
    userID,
    c.req.param("searchKey")
  );
  if (!result) {
    return c.text("Search not found", 404);
  }

  if (isHeadRequest(c)) {
    return c.body(null, 200, settingHeaders(result.search.version));
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomEntry({
        content: withSearchSchema(c, result.search).data,
        id: `searches/${result.search.key}`,
        key: result.search.key,
        title: String(result.search.data.name ?? result.search.key),
        version: result.search.version,
      }),
      200,
      atomHeaders(result.search.version)
    );
  }

  return c.json(withSearchSchema(c, result.search), 200, settingHeaders(result.search.version));
});


compatibility.put("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }
  const searchStore = createSearchStore(c.env);
  const existing = await searchStore.getSearch(
    "user",
    userID,
    c.req.param("searchKey")
  );
  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Search",
    existing ? existing.search.version ?? 0 : null,
    body,
    "PUT"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }

  const searchData = normalizeObjectDeletedForWrite(versionCheck.editable);
  if (existing && searchData.version === undefined) {
    // The route has already validated the header-supplied version; satisfy
    // the store's per-object version guard.
    searchData.version = existing.search.version;
  }
  const result = await searchStore.upsertSearches(
    "user",
    userID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.patch("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const searchStore = createSearchStore(c.env);
  const existing = await searchStore.getSearch(
    "user",
    userID,
    c.req.param("searchKey")
  );
  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Search",
    existing ? existing.search.version ?? 0 : null,
    body,
    "PATCH"
  );
  if (!versionCheck.ok) {
    return c.text(versionCheck.message, versionCheck.code, versionCheck.headers);
  }

  const searchData = normalizeObjectDeletedForWrite(
    existing
      ? { ...existing.search.data, ...versionCheck.editable }
      : versionCheck.editable
  );
  const result = await searchStore.upsertSearches(
    "user",
    userID,
    [{ ...searchData, key: c.req.param("searchKey") }],
    null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return c.text(firstFailure.message, firstFailure.code);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.delete("/users/:userID/searches/:searchKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "user",
    userID,
    [c.req.param("searchKey")],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/users/:userID/searches", async (c) => {
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


compatibility.post("/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSearchWriteBody(c);
  if (!Array.isArray(body)) {
    return c.text("Expected a search array", 400);
  }

  const searches = normalizeObjectBatchDeletedForWrite(
    body as Record<string, unknown>[]
  );
  const result = await createSearchStore(c.env).upsertSearches(
    "user",
    userID,
    searches,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return renderSearchWriteResult(c, result);
});


compatibility.delete("/users/:userID/searches", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSearchStore(c.env).deleteSearches(
    "user",
    userID,
    getRequestedSearchKeys(c) ?? [],
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});
