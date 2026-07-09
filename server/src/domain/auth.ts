import type { Context } from "hono";
import type { Bindings } from "../bindings";
import { getState } from "./state";

const decodeBasicAuth = (authorization: string): [string, string] | null => {
  if (!authorization.toLowerCase().startsWith("basic ")) {
    return null;
  }

  const encoded = authorization.slice("basic ".length).trim();
  const decoded = atob(encoded);
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return null;
  }

  return [decoded.slice(0, separator), decoded.slice(separator + 1)];
};

export const isRootRequest = (c: Context<{ Bindings: Bindings }>): boolean => {
  const authorization = c.req.header("Authorization");
  if (!authorization) {
    return false;
  }

  const credentials = decodeBasicAuth(authorization);
  if (!credentials) {
    return false;
  }

  const [username, password] = credentials;
  const expectedUsername = c.env.ROOT_USERNAME ?? "root";
  const expectedPassword = c.env.ROOT_PASSWORD ?? "local-root-password";
  return username === expectedUsername && password === expectedPassword;
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

export const authenticateUser = (
  c: Context<{ Bindings: Bindings }>,
  userID: number
): boolean => {
  const key = getRequestApiKey(c);
  if (!key) {
    return false;
  }

  return getState().apiKeys.get(key)?.userID === userID;
};
