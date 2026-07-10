import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { libraryUpdateNotificationHeaders } from "../../../domain/notifications";
import { createSettingsStore } from "../../../domain/settings";
import type { CompatibilityStore } from "../../../domain/storage";
import { getIfUnmodifiedSinceVersion } from "./request-versions";
import { settingHeaders } from "./settings";

export const getItemKeysForDelete = (
  c: Context<{ Bindings: Bindings }>,
  itemKey?: string
): string[] => {
  const rawKeys = itemKey ?? c.req.query("itemKey") ?? "";
  return rawKeys
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
};

export const getLastPageIndexSettingKeys = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKeys: string[]
) =>
  itemKeys.map((itemKey) =>
    libraryType === "user"
      ? `lastPageIndex_u_${itemKey}`
      : `lastPageIndex_g${libraryID}_${itemKey}`
  );

export const cleanupLastPageIndexSettings = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKeys: string[];
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const settingsStore = createSettingsStore(c.env);
  const settingKeys = getLastPageIndexSettingKeys(
    input.libraryType,
    input.libraryID,
    input.itemKeys
  );

  if (input.libraryType === "user") {
    await settingsStore.deleteSettingsWithoutLog(
      "user",
      input.libraryID,
      settingKeys
    );
    return;
  }

  await settingsStore.deleteSettingsWithoutLog(
    "group",
    input.libraryID,
    settingKeys
  );
  const users = await input.store.listGroupUsers(input.libraryID);
  await Promise.all(
    users.map((user) =>
      settingsStore.deleteSettingsWithoutLog("user", user.userID, settingKeys)
    )
  );
};

export const deleteItemsForLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKeys: string[];
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const result =
    input.libraryType === "user"
      ? await input.store.deleteItems(
          input.libraryID,
          input.itemKeys,
          preconditionVersion
        )
      : await input.store.deleteGroupItems(
          input.libraryID,
          input.itemKeys,
          preconditionVersion
        );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412);
  }

  if (result.deleted.length > 0) {
    await cleanupLastPageIndexSettings(c, {
      ...input,
      itemKeys: result.deleted,
    });
  }

  return c.body(null, 204, {
    ...settingHeaders(result.version),
    ...(result.deleted.length > 0
      ? libraryUpdateNotificationHeaders(
          input.libraryType,
          input.libraryID,
          result.version
        )
      : {}),
  });
};
