import { Hono } from "hono";
import type { Bindings } from "../bindings";
import { getBearerToken, verifySecret } from "../domain/auth";
import { createInstallationStore } from "../domain/installation";
import { createKeyStore, managedKeyInfo } from "../domain/keys";
import { getInstallationStreamHub } from "../domain/streaming";

export const selfhost = new Hono<{ Bindings: Bindings }>();

selfhost.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

selfhost.get("/stream", (c) =>
  getInstallationStreamHub(c.env).fetch(c.req.raw)
);

selfhost.get("/login", async (c) => {
  const sessionToken = readSessionToken(c.req.query("session"));
  const status = sessionToken
    ? await createKeyStore(c.env).getSessionStatus(sessionToken)
    : null;
  if (!(sessionToken && status?.status === "pending")) {
    return loginPage(c, {
      message: "This Zotero login session is invalid or has expired.",
      status: 404,
    });
  }

  return loginPage(c, { sessionToken });
});

selfhost.post("/login", async (c) => {
  const contentLength = Number.parseInt(
    c.req.header("Content-Length") ?? "0",
    10
  );
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    return loginPage(c, { message: "Invalid login request.", status: 400 });
  }

  const body = await c.req.formData().catch(() => null);
  const sessionToken = readSessionToken(body?.get("session"));
  const ownerApiKey = readLoginValue(body?.get("ownerApiKey"), 256);
  if (!(sessionToken && ownerApiKey)) {
    return loginPage(c, { message: "Invalid login request.", status: 400 });
  }

  const keyStore = createKeyStore(c.env);
  const owner = await keyStore.getKey(ownerApiKey);
  if (!owner?.isOwner) {
    return loginPage(c, {
      message: "The owner API key was not accepted.",
      sessionToken,
      status: 403,
    });
  }

  const result = await keyStore.completeSession({
    access: {
      groups: {},
      user: { files: true, library: true, notes: true, write: true },
    },
    forceUserID: true,
    sessionToken,
    userID: owner.userID,
  });
  if (result !== "completed") {
    return loginPage(c, {
      message: "This Zotero login session is invalid or has expired.",
      status: result === "missing" ? 404 : 409,
    });
  }

  return loginPage(c, { completed: true });
});

selfhost.get("/_selfhost/status", async (c) => {
  const installation = await createInstallationStore(c.env).getState();
  return c.json({
    bootstrapped: installation !== null,
    ownerUserID: installation?.ownerUserID ?? null,
    service: "zotero-selfhost",
  });
});

selfhost.post("/_selfhost/bootstrap", async (c) => {
  const authorizationError = await requireEphemeralSecret(
    c,
    c.env.BOOTSTRAP_TOKEN
  );
  if (authorizationError) {
    return authorizationError;
  }

  const body = await readSmallObject(c);
  if (!body) {
    return c.json({ error: "Invalid bootstrap request" }, 400);
  }

  const username = readUsername(body.username, "owner");
  const displayName = readString(body.displayName, "Owner", 120);
  const keyLabel = readString(body.keyLabel, "Initial owner key", 120);
  if (!(username && displayName && keyLabel)) {
    return c.json({ error: "Invalid owner profile" }, 400);
  }

  const result = await createInstallationStore(c.env).bootstrapOwner({
    displayName,
    keyLabel,
    username,
  });
  if (result.state === "already-bootstrapped") {
    return c.json({ error: "Installation is already bootstrapped" }, 409);
  }

  return c.json(
    {
      apiKey: result.apiKey,
      bootstrappedAt: result.installation.bootstrappedAt,
      ownerUserID: result.installation.ownerUserID,
      serverURL: new URL(c.req.url).origin,
    },
    201
  );
});

selfhost.post("/_selfhost/recovery/keys", async (c) => {
  const authorizationError = await requireEphemeralSecret(
    c,
    c.env.RECOVERY_TOKEN
  );
  if (authorizationError) {
    return authorizationError;
  }

  const body = await readSmallObject(c);
  if (!body) {
    return c.json({ error: "Invalid recovery request" }, 400);
  }

  const keyLabel = readString(body.keyLabel, "Recovered owner key", 120);
  if (!keyLabel) {
    return c.json({ error: "Invalid key label" }, 400);
  }

  const key = await createInstallationStore(c.env).createRecoveryKey(keyLabel);
  if (!key) {
    return c.json({ error: "Installation has not been bootstrapped" }, 409);
  }

  return c.json({ key: managedKeyInfo(key) }, 201);
});

const requireEphemeralSecret = async (
  c: Parameters<typeof getBearerToken>[0],
  expected: string | undefined
) => {
  if (!expected) {
    return c.text("Not Found", 404);
  }

  const provided = getBearerToken(c);
  if (!(provided && (await verifySecret(provided, expected)))) {
    return c.json({ error: "Invalid temporary control token" }, 403);
  }

  return null;
};

const readSmallObject = async (
  c: Parameters<typeof getBearerToken>[0]
): Promise<Record<string, unknown> | null> => {
  const contentLength = Number.parseInt(
    c.req.header("Content-Length") ?? "0",
    10
  );
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return null;
  }

  const body: unknown = await c.req.json().catch(() => null);
  return isRecord(body) ? body : null;
};

const readString = (
  value: unknown,
  fallback: string,
  maximumLength: number
): string | null => {
  const normalized = typeof value === "string" ? value.trim() : fallback;
  return normalized.length > 0 && normalized.length <= maximumLength
    ? normalized
    : null;
};

const readUsername = (value: unknown, fallback: string): string | null => {
  const username = readString(value, fallback, 64);
  return username && /^[\w.-]+$/u.test(username) ? username : null;
};

const readLoginValue = (
  value: unknown,
  maximumLength: number
): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= maximumLength
    ? value
    : null;

const readSessionToken = (value: unknown): string | null => {
  const token = readLoginValue(value, 64);
  return token && /^[a-f\d]{32}$/u.test(token) ? token : null;
};

const loginPage = (
  c: Parameters<typeof getBearerToken>[0],
  options: {
    completed?: boolean;
    message?: string;
    sessionToken?: string;
    status?: 200 | 400 | 403 | 404 | 409;
  }
) => {
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  const status = options.status ?? 200;
  const content = options.completed
    ? `<h1>Zotero connected</h1><p>The device key was installed through Zotero's native login flow. You can close this page and return to Zotero.</p>`
    : `<h1>Connect Zotero Desktop</h1><p>Enter this installation's owner API key to authorize one new Zotero Desktop device.</p>${
        options.message
          ? `<p role="alert" class="error">${escapeHTML(options.message)}</p>`
          : ""
      }${
        options.sessionToken
          ? `<form method="post" action="/login"><input type="hidden" name="session" value="${escapeHTML(options.sessionToken)}"><label for="ownerApiKey">Owner API key</label><input id="ownerApiKey" name="ownerApiKey" type="password" autocomplete="off" required><button type="submit">Connect Zotero</button></form>`
          : ""
      }`;
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zotero Self-Host Login</title><style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1.25rem;color:#202124}h1{font-size:1.75rem}label,input,button{display:block;width:100%;box-sizing:border-box}label{margin-top:1.5rem;font-weight:600}input{margin:.5rem 0 1rem;padding:.75rem;border:1px solid #9aa0a6;border-radius:.35rem}button{padding:.75rem;border:0;border-radius:.35rem;background:#b2182b;color:white;font-weight:700;cursor:pointer}.error{padding:.75rem;background:#fce8e6;color:#a50e0e;border-radius:.35rem}</style></head><body>${content}</body></html>`,
    status
  );
};

const escapeHTML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
