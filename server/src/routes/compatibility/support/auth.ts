import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { getRequestApiKey, isAdminRequest } from "../../../domain/auth";
import {
  isCompatibilityTestAdminRequest,
  isCompatibilityTestMode,
} from "../../../domain/compatibility-test-auth";
import {
  createKeyStore,
  keyAllowsGroupPermission,
  keyAllowsUserPermission,
} from "../../../domain/keys";
import type { CompatibilityStore } from "../../../domain/storage";

type CompatibilityContext = Context<{ Bindings: Bindings }>;
type GroupCapability = "canAdmin" | "canEdit" | "canEditFiles" | "canRead";
type GroupKeyPermission = "files" | "library" | "write";
type UserKeyPermission = "library" | "write";

export const requireAdmin = async (c: CompatibilityContext) => {
  if (!(await isAdminRequest(c))) {
    return c.text("Invalid login", 401);
  }

  return null;
};

export const requireCompatibilityTestAdmin = async (
  c: CompatibilityContext
) => {
  if (!isCompatibilityTestMode(c.env)) {
    return c.text("Not Found", 404);
  }
  if (!(await isCompatibilityTestAdminRequest(c))) {
    return c.text("Invalid test administrator token", 401);
  }

  return null;
};

export const requireUser = async (
  c: CompatibilityContext,
  _store: CompatibilityStore,
  userID: number
): Promise<boolean> => {
  // The owner key can administer any library in its own deployment.
  if (await isAdminRequest(c)) {
    return true;
  }
  return requireUserPermissions(c, userID, ["library"]);
};

export const requireUserWrite = async (
  c: CompatibilityContext,
  _store: CompatibilityStore,
  userID: number
): Promise<boolean> => requireUserPermissions(c, userID, ["library", "write"]);

export const getRequestUserID = async (
  c: CompatibilityContext
): Promise<number | null> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return null;
  }

  return (await createKeyStore(c.env).getKey(apiKey))?.userID ?? null;
};

export const requireGroup = async (
  c: CompatibilityContext,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> =>
  requireGroupPermission(c, store, groupID, "library", "canRead");

export const requireGroupEdit = async (
  c: CompatibilityContext,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> =>
  requireGroupPermission(c, store, groupID, "write", "canEdit");

export const requireGroupAdmin = async (
  c: CompatibilityContext,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> =>
  requireGroupPermission(c, store, groupID, "write", "canAdmin");

export const requireGroupFileEdit = async (
  c: CompatibilityContext,
  store: CompatibilityStore,
  groupID: number
): Promise<boolean> =>
  requireGroupPermission(c, store, groupID, "files", "canEditFiles");

export const requireKeyAdmin = async (c: CompatibilityContext) =>
  (await isAdminRequest(c)) ? null : c.text("Invalid key", 403);

const requireUserPermissions = async (
  c: CompatibilityContext,
  userID: number,
  permissions: UserKeyPermission[]
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (
    !key ||
    key.userID !== userID ||
    permissions.some(
      (permission) => !keyAllowsUserPermission(key.access, permission)
    )
  ) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  return true;
};

const requireGroupPermission = async (
  c: CompatibilityContext,
  store: CompatibilityStore,
  groupID: number,
  keyPermission: GroupKeyPermission,
  capability: GroupCapability
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const keyStore = createKeyStore(c.env);
  const key = await keyStore.getKey(apiKey);
  if (!(key && keyAllowsGroupPermission(key.access, groupID, keyPermission))) {
    return false;
  }

  await keyStore.recordAccess(apiKey);
  const access = await store.getGroupAccess(key.userID, groupID);
  return access[capability];
};
