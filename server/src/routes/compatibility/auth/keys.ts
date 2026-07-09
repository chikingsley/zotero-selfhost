import {
  getRequestApiKey,
  isAdminRequest,
  isCompatibilityTestMode,
} from "../../../domain/auth";
import {
  createKeyStore,
  managedKeyInfo,
  publicKeyInfo,
} from "../../../domain/keys";
import { createCompatibilityStore } from "../../../domain/storage";
import { compatibility } from "../router";
import {
  getLoginBaseURL,
  keyAccessNotificationHeaders,
  parseNumericID,
  readKeyRequestBody,
  requireKeyAdmin,
} from "../support";

compatibility.get("/keys/current", async (c) => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  if (!key) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    (await isAdminRequest(c)) ? managedKeyInfo(key) : publicKeyInfo(key)
  );
});

compatibility.get("/users/:userID/keys/current", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    (await isAdminRequest(c)) ? managedKeyInfo(key) : publicKeyInfo(key)
  );
});

compatibility.post("/keys/sessions", async (c) => {
  const body = await readKeyRequestBody(c);
  const result = await createKeyStore(c.env).createSession({
    currentApiKey: getRequestApiKey(c),
    loginBaseURL: getLoginBaseURL(c),
    userAgent: c.req.header("User-Agent"),
    userID: body.userID,
  });

  return c.json(result, 201);
});

compatibility.get("/keys/sessions/:sessionToken", async (c) => {
  const status = await createKeyStore(c.env).getSessionStatus(
    c.req.param("sessionToken")
  );
  if (!status) {
    return c.text("Session not found", 404);
  }

  return c.json(status);
});

compatibility.delete("/keys/sessions/:sessionToken", async (c) => {
  const result = await createKeyStore(c.env).cancelSession(
    c.req.param("sessionToken")
  );
  if (result === "missing") {
    return c.text("Session not found", 404);
  }
  if (result === "conflict") {
    return c.text("Session cannot be cancelled", 409);
  }

  return c.body(null, 204);
});

compatibility.get("/keys/sessions/:sessionToken/info", async (c) => {
  const adminError = await requireKeyAdmin(c);
  if (adminError) {
    return adminError;
  }

  const info = await createKeyStore(c.env).getSessionInfo(
    c.req.param("sessionToken")
  );
  if (!info) {
    return c.text("Session not found", 404);
  }

  return c.json(info);
});

compatibility.post("/keys/sessions/complete", async (c) => {
  const adminError = await requireKeyAdmin(c);
  if (adminError) {
    return adminError;
  }

  const result = await createKeyStore(c.env).completeSession(
    await readKeyRequestBody(c)
  );
  if (result === "invalid") {
    return c.text("Invalid session completion", 400);
  }
  if (result === "missing") {
    return c.text("Session not found", 404);
  }
  if (result === "conflict") {
    return c.text("Session cannot be completed", 409);
  }

  return c.body(null, 204);
});

compatibility.get("/keys/:apiKey", async (c) => {
  const key = await createKeyStore(c.env).getKey(c.req.param("apiKey"));
  if (!key) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    (await isAdminRequest(c)) ? managedKeyInfo(key) : publicKeyInfo(key)
  );
});

compatibility.get("/users/:userID/keys/:apiKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const key = await createKeyStore(c.env).getKey(c.req.param("apiKey"));
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    (await isAdminRequest(c)) ? managedKeyInfo(key) : publicKeyInfo(key)
  );
});

compatibility.get("/users/:userID/keys", async (c) => {
  const adminError = await requireKeyAdmin(c);
  if (adminError) {
    return adminError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keys = await createKeyStore(c.env).listUserKeys(userID);
  return c.json(keys.map(managedKeyInfo));
});

compatibility.post("/users/:userID/keys", async (c) => {
  const adminError = await requireKeyAdmin(c);
  if (adminError) {
    return adminError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const body = await readKeyRequestBody(c);
  const key = await createKeyStore(c.env).createKey({
    access: body.access,
    name: body.name,
    userID,
  });

  return c.json(managedKeyInfo(key), 201);
});

compatibility.post("/keys", async (c) => {
  if (!isCompatibilityTestMode(c.env)) {
    return c.text("Password login is not enabled", 404);
  }

  const body = await readKeyRequestBody(c);
  const keyStore = createKeyStore(c.env);
  const userID = await keyStore.resolveCredentials(body);
  if (userID === null) {
    return c.text("Invalid login", 403);
  }

  const key = await keyStore.createKey({
    access: body.access,
    name: body.name,
    userID,
  });

  return c.json(managedKeyInfo(key), 201);
});

compatibility.put("/keys/:apiKey", async (c) => {
  const apiKey = c.req.param("apiKey");
  const keyStore = createKeyStore(c.env);
  const existing = await keyStore.getKey(apiKey);
  if (!existing) {
    return c.text("Invalid key", 403);
  }

  const body = await readKeyRequestBody(c);
  const credentialUserID = isCompatibilityTestMode(c.env)
    ? await keyStore.resolveCredentials(body)
    : null;
  const requestApiKey = getRequestApiKey(c);
  const isAdmin = await isAdminRequest(c);
  if (
    !isAdmin &&
    requestApiKey !== apiKey &&
    credentialUserID !== existing.userID
  ) {
    return c.text("Invalid login", 403);
  }

  const updated = await keyStore.updateKey(apiKey, {
    access: body.access,
    name: body.name,
  });
  if (!updated) {
    return c.text("Invalid key", 403);
  }

  return c.json(
    managedKeyInfo(updated),
    200,
    await keyAccessNotificationHeaders(
      createCompatibilityStore(c.env),
      existing,
      updated
    )
  );
});

compatibility.put("/users/:userID/keys/:apiKey", async (c) => {
  const adminError = await requireKeyAdmin(c);
  if (adminError) {
    return adminError;
  }

  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keyStore = createKeyStore(c.env);
  const existing = await keyStore.getKey(c.req.param("apiKey"));
  if (!existing || existing.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  const body = await readKeyRequestBody(c);
  const updated = await keyStore.updateKey(existing.key, {
    access: body.access,
    name: body.name,
  });

  const nextKey = updated ?? existing;
  return c.json(
    managedKeyInfo(nextKey),
    200,
    await keyAccessNotificationHeaders(
      createCompatibilityStore(c.env),
      existing,
      nextKey
    )
  );
});

compatibility.delete("/keys/current", async (c) => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const deleted = await createKeyStore(c.env).deleteKey(apiKey);
  return deleted ? c.body(null, 204) : c.text("Invalid key", 403);
});

compatibility.delete("/users/:userID/keys/current", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return c.text("Invalid key", 403);
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  await keyStore.deleteKey(apiKey);
  return c.body(null, 204);
});

compatibility.delete("/keys/:apiKey", async (c) => {
  const apiKey = c.req.param("apiKey");
  const requestApiKey = getRequestApiKey(c);
  if (!((await isAdminRequest(c)) || requestApiKey === apiKey)) {
    return c.text("Invalid key", 403);
  }

  const deleted = await createKeyStore(c.env).deleteKey(apiKey);
  return deleted ? c.body(null, 204) : c.text("Invalid key", 403);
});

compatibility.delete("/users/:userID/keys/:apiKey", async (c) => {
  const userID = parseNumericID(c.req.param("userID"));
  if (userID === null) {
    return c.text("Invalid userID", 400);
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(c.req.param("apiKey"));
  if (!key || key.userID !== userID) {
    return c.text("Invalid key", 403);
  }

  await keyStore.deleteKey(key.key);
  return c.body(null, 204);
});
