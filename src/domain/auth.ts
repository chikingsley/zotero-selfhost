import type { Context } from "hono";
import type { Bindings } from "../bindings";
import { isCompatibilityTestAdminRequest } from "./compatibility-test-auth";
import { createKeyStore } from "./keys";

export { verifySecret } from "../lib/secrets";

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
