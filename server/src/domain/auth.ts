import type { Context } from "hono";
import type { Bindings } from "../bindings";
import { createKeyStore } from "./keys";

const compatibilityAdminUsername = "compatibility";

const decodeBasicAuth = (authorization: string): [string, string] | null => {
  if (!authorization.toLowerCase().startsWith("basic ")) {
    return null;
  }

  try {
    const encoded = authorization.slice("basic ".length).trim();
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator === -1) {
      return null;
    }

    return [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return null;
  }
};

export const isCompatibilityTestMode = (env: Bindings): boolean =>
  env.DEPLOYMENT_MODE === "compatibility-test";

export const verifySecret = async (
  provided: string,
  expected: string
): Promise<boolean> => {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
};

export const isCompatibilityTestAdminRequest = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  const expected = c.env.COMPATIBILITY_TEST_ADMIN_TOKEN;
  if (!(isCompatibilityTestMode(c.env) && expected)) {
    return false;
  }

  const headerToken = c.req.header("X-Selfhost-Test-Token");
  if (headerToken) {
    return verifySecret(headerToken, expected);
  }

  const authorization = c.req.header("Authorization");
  if (!authorization) {
    return false;
  }

  const credentials = decodeBasicAuth(authorization);
  if (!credentials) {
    return false;
  }

  const [username, password] = credentials;
  return (
    username === compatibilityAdminUsername &&
    (await verifySecret(password, expected))
  );
};

export const isAdminRequest = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  if (await isCompatibilityTestAdminRequest(c)) {
    return true;
  }

  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  return key?.isOwner === true;
};

export const getRequestApiKey = (
  c: Context<{ Bindings: Bindings }>
): string | null => {
  const zoteroApiKey = c.req.header("Zotero-API-Key");
  if (zoteroApiKey) {
    return zoteroApiKey;
  }

  const queryKey = c.req.query("key");
  if (queryKey) {
    return queryKey;
  }

  const authorization = c.req.header("Authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim();
  }

  return null;
};

export const getBearerToken = (
  c: Context<{ Bindings: Bindings }>
): string | null => {
  const authorization = c.req.header("Authorization");
  return authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : null;
};
