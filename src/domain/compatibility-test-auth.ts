import type { Context } from "hono";
import type { Bindings } from "../bindings";
import { verifySecret } from "../lib/secrets";

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
