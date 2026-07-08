import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, getIfUnmodifiedSinceVersion, checkSingleObjectWriteVersion, normalizeObjectDeletedForWrite, renderJSONAtomEntry, atomHeaders, wantsAtomResponse, isHeadRequest, settingHeaders, isSettingsObject, getRequestedSearchKeys, getSearchSinceVersion, withSearchSchema, renderSearchList, parseSearchWriteBody, buildWriteReport, evaluateBatchWritePreconditions, isRecord, jsonValuesEqual, type ExistingObjectVersions, type ItemWriteFailures } from "../shared";
import { createSearchStore } from "../../../searches";
import { createCompatibilityStore } from "../../../storage";
import { compatibility } from "../router";

type LibraryType = "group" | "user";

const stripVersionForCompare = (data: Record<string, unknown>) => {
  const { version: _version, ...rest } = data;
  return rest;
};

const mergeWriteFailures = (
  target: ItemWriteFailures,
  source: ItemWriteFailures
) => {
  for (const [index, failure] of Object.entries(source)) {
    if (!(index in target)) {
      target[index] = failure;
    }
  }
};

const mapStoreFailuresToOriginalIndexes = (
  failed: ItemWriteFailures,
  written: Array<{ index: number; object: Record<string, unknown> }>
): ItemWriteFailures => {
  const mapped: ItemWriteFailures = {};
  for (const [position, failure] of Object.entries(failed)) {
    const originalIndex = written[Number(position)]?.index ?? Number(position);
    mapped[originalIndex] = failure;
  }
  return mapped;
};

const handleSearchBatchWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: LibraryType;
  }
) => {
  const body = await parseSearchWriteBody(c);
  if (!Array.isArray(body)) {
    return c.text("Uploaded data must be a JSON array", 400);
  }

  const failed: ItemWriteFailures = {};
  const rawSearches = (body as unknown[]).map((entry, index) => {
    if (isRecord(entry)) {
      return { ...entry };
    }
    failed[index] = {
      code: 400,
      message: `Invalid value for index ${index} in uploaded data; expected JSON search object`,
    };
    return {};
  });

  const searchStore = createSearchStore(c.env);
  const library = await searchStore.listSearches(input.libraryType, input.libraryID);
  const existingVersions: ExistingObjectVersions = new Map(
    library.searches.map((search) => [
      search.key,
      { data: search.data ?? {}, version: search.version ?? 0 },
    ])
  );
  const precondition = evaluateBatchWritePreconditions(
    rawSearches,
    existingVersions,
    library.version,
    getIfUnmodifiedSinceVersion(c),
    "Search"
  );
  if (precondition.libraryPreconditionFailed) {
    return c.text("Library has been modified", 412, settingHeaders(library.version));
  }
  mergeWriteFailures(failed, precondition.failed);

  const finalSearches = rawSearches.map((object) => {
    const key = typeof object.key === "string" ? object.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    return current
      ? { ...current.data, ...object, key }
      : { ...object };
  });

  const unchanged: Record<string, string> = { ...precondition.unchanged };
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];
  for (const entry of precondition.toWrite) {
    if (entry.index in failed) {
      continue;
    }
    const final = finalSearches[entry.index];
    if (!final) {
      continue;
    }
    const key = typeof final.key === "string" ? final.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    const comparableFinal = normalizeObjectDeletedForWrite({ ...final });
    if (
      current &&
      jsonValuesEqual(
        stripVersionForCompare(comparableFinal),
        stripVersionForCompare(current.data)
      )
    ) {
      unchanged[entry.index] = key;
      continue;
    }
    toWrite.push({ index: entry.index, object: final });
  }

  const result = toWrite.length
    ? await searchStore.upsertSearches(
        input.libraryType,
        input.libraryID,
        toWrite.map((entry) => entry.object),
        getIfUnmodifiedSinceVersion(c)
      )
    : {
        failed: {} as ItemWriteFailures,
        preconditionFailed: false,
        success: [] as string[],
        successful: [] as never[],
        unchanged: [] as never[],
        version: library.version,
      };
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412, settingHeaders(result.version));
  }

  mergeWriteFailures(
    failed,
    mapStoreFailuresToOriginalIndexes(result.failed, toWrite)
  );

  const successfulWrites = toWrite.filter(
    (_entry, position) => !(position in result.failed)
  );

  return c.json(
    buildWriteReport(successfulWrites, result.successful, failed, unchanged),
    200,
    settingHeaders(result.version)
  );
};

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

  return handleSearchBatchWrite(c, {
    libraryID: groupID,
    libraryType: "group",
  });
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

  return handleSearchBatchWrite(c, {
    libraryID: userID,
    libraryType: "user",
  });
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
