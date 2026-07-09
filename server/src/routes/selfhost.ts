import { Hono } from "hono";
import type { Bindings } from "../bindings";
import { getBearerToken, verifySecret } from "../domain/auth";
import { createInstallationStore } from "../domain/installation";
import { managedKeyInfo } from "../domain/keys";
import { getInstallationStreamHub } from "../domain/streaming";

export const selfhost = new Hono<{ Bindings: Bindings }>();

selfhost.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

selfhost.get("/stream", (c) =>
  getInstallationStreamHub(c.env).fetch(c.req.raw)
);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
