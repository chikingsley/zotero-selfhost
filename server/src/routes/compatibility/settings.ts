import { parseNumericID, requireUser, requireUserWrite, requireGroup, requireGroupEdit, requireGroupAdmin, getIfUnmodifiedSinceVersion, settingHeaders, renderSettingsList, getSinceVersion, getRequestedSettingKeys, isSettingsObject, parseSettingsBody, renderSettingsWriteFailure, ensureSingleSettingPrecondition } from "./shared";
import { createSettingsStore, isAdminOnlySettingKey, type SettingFailure, type SettingPayload } from "../../settings";
import { createCompatibilityStore } from "../../storage";
import { compatibility } from "./router";


compatibility.get("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).getSetting(
    "group",
    groupID,
    c.req.param("settingKey")
  );
  if (!result) {
    return c.text("Setting not found", 404);
  }

  return c.json(result.setting, 200, settingHeaders(result.setting.version));
});


compatibility.put("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  if (isAdminOnlySettingKey(settingKey) && !canAdmin) {
    return c.text(`Only group admins can change setting '${settingKey}'`, 403);
  }

  const settingsStore = createSettingsStore(c.env);
  const existing = await settingsStore.getSetting("group", groupID, settingKey);
  const ifUnmodifiedSinceVersion = getIfUnmodifiedSinceVersion(c);
  if (ensureSingleSettingPrecondition(existing, ifUnmodifiedSinceVersion)) {
    return c.text("Precondition failed", 412);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await settingsStore.upsertSettings(
    "group",
    groupID,
    [[settingKey, body as SettingPayload]],
    null,
    canAdmin
  );
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return renderSettingsWriteFailure(c, firstFailure);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.delete("/groups/:groupID/settings/:settingKey", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  if (isAdminOnlySettingKey(settingKey) && !(await requireGroupAdmin(c, compatibilityStore, groupID))) {
    return c.text(`Only group admins can change setting '${settingKey}'`, 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "group",
    groupID,
    [settingKey],
    getIfUnmodifiedSinceVersion(c),
    true
  );
  if (result.notFound) {
    return c.text("Setting not found", 404);
  }
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireGroup(c, store, groupID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).listSettings(
    "group",
    groupID,
    getSinceVersion(c)
  );

  return renderSettingsList(c, result);
});


compatibility.post("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  const result = await createSettingsStore(c.env).upsertSettings(
    "group",
    groupID,
    Object.entries(body) as Array<[string, SettingPayload]>,
    getIfUnmodifiedSinceVersion(c),
    canAdmin
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }
  if (Object.keys(result.failed).length > 0) {
    const firstFailure = Object.values(result.failed)[0];
    if (!settingsFailuresUseWriteReport(result.failed) && firstFailure) {
      return renderSettingsWriteFailure(c, firstFailure);
    }

    return c.json(
      { failed: result.failed, successful: result.successful, unchanged: result.unchanged },
      200,
      settingHeaders(result.version)
    );
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.delete("/groups/:groupID/settings", async (c) => {
  const groupID = parseNumericID(c.req.param("groupID"));
  if (groupID === null) {
    return c.text("Invalid groupID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireGroupEdit(c, compatibilityStore, groupID))) {
    return c.text("Invalid key", 403);
  }

  const settingKeys = getRequestedSettingKeys(c);
  if (!settingKeys.length) {
    return c.text("settingKey parameter not provided", 400);
  }

  const canAdmin = await requireGroupAdmin(c, compatibilityStore, groupID);
  const restrictedKey = settingKeys.find((settingKey) => isAdminOnlySettingKey(settingKey) && !canAdmin);
  if (restrictedKey) {
    return c.text(`Only group admins can change setting '${restrictedKey}'`, 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "group",
    groupID,
    settingKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).getSetting(
    "user",
    userID,
    c.req.param("settingKey")
  );
  if (!result) {
    return c.text("Setting not found", 404);
  }

  return c.json(result.setting, 200, settingHeaders(result.setting.version));
});


compatibility.put("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const compatibilityStore = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, compatibilityStore, userID))) {
    return c.text("Invalid key", 403);
  }

  const settingKey = c.req.param("settingKey");
  const settingsStore = createSettingsStore(c.env);
  const existing = await settingsStore.getSetting("user", userID, settingKey);
  const ifUnmodifiedSinceVersion = getIfUnmodifiedSinceVersion(c);
  if (ensureSingleSettingPrecondition(existing, ifUnmodifiedSinceVersion)) {
    return c.text("Precondition failed", 412);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await settingsStore.upsertSettings(
    "user",
    userID,
    [[settingKey, body as SettingPayload]],
    null
  );
  const firstFailure = Object.values(result.failed)[0];
  if (firstFailure) {
    return renderSettingsWriteFailure(c, firstFailure);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.delete("/users/:userID/settings/:settingKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "user",
    userID,
    [c.req.param("settingKey")],
    getIfUnmodifiedSinceVersion(c),
    true
  );
  if (result.notFound) {
    return c.text("Setting not found", 404);
  }
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});


compatibility.get("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUser(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const result = await createSettingsStore(c.env).listSettings(
    "user",
    userID,
    getSinceVersion(c)
  );

  return renderSettingsList(c, result);
});


compatibility.post("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const body = await parseSettingsBody(c).catch(() => null);
  if (!isSettingsObject(body)) {
    return c.text("Invalid JSON", 400);
  }

  const result = await createSettingsStore(c.env).upsertSettings(
    "user",
    userID,
    Object.entries(body) as Array<[string, SettingPayload]>,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }
  if (Object.keys(result.failed).length > 0) {
    const firstFailure = Object.values(result.failed)[0];
    if (!settingsFailuresUseWriteReport(result.failed) && firstFailure) {
      return renderSettingsWriteFailure(c, firstFailure);
    }

    return c.json(
      { failed: result.failed, successful: result.successful, unchanged: result.unchanged },
      200,
      settingHeaders(result.version)
    );
  }

  return c.body(null, 204, settingHeaders(result.version));
});


const settingsFailuresUseWriteReport = (
  failed: Record<string, SettingFailure>
): boolean =>
  Object.values(failed).every((failure) => failure.code === 403);


compatibility.delete("/users/:userID/settings", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const store = createCompatibilityStore(c.env);
  if (!(await requireUserWrite(c, store, userID))) {
    return c.text("Invalid key", 403);
  }

  const settingKeys = getRequestedSettingKeys(c);
  if (!settingKeys.length) {
    return c.text("settingKey parameter not provided", 400);
  }

  const result = await createSettingsStore(c.env).deleteSettings(
    "user",
    userID,
    settingKeys,
    getIfUnmodifiedSinceVersion(c)
  );
  if (result.preconditionFailed) {
    return c.text("Precondition failed", 412);
  }

  return c.body(null, 204, settingHeaders(result.version));
});
