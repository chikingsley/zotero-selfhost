import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { createKeyStore } from "../../../domain/keys";
import {
  notificationHeaders,
  topicAccessNotification,
} from "../../../domain/notifications";
import type { CompatibilityStore } from "../../../domain/storage";
import { isPublicGroupRecord } from "./groups";
import { isRecord } from "./values";

export const readKeyRequestBody = async (c: Context<{ Bindings: Bindings }>) =>
  c.req.json().catch(() => ({}));

export const getLoginBaseURL = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).origin;

export const keyAccessNotificationHeaders = async (
  store: CompatibilityStore,
  before: {
    access: Record<string, unknown>;
    id?: string;
    key: string;
    userID: number;
  },
  after: {
    access: Record<string, unknown>;
    id?: string;
    key: string;
    userID: number;
  }
) => {
  const beforeGroups = await getKeyAccessGroupIDs(
    store,
    before.userID,
    before.access,
    {
      expandAll: "visible",
    }
  );
  const afterGroups = await getKeyAccessGroupIDs(
    store,
    after.userID,
    after.access,
    {
      carryGroupIDs: beforeGroups,
      expandAll: "public-owned",
    }
  );
  const apiKeyID = after.id ?? after.key;
  const notifications = [
    ...[...afterGroups]
      .filter((groupID) => !beforeGroups.has(groupID))
      .map((groupID) =>
        topicAccessNotification("topicAdded", apiKeyID, groupID)
      ),
    ...[...beforeGroups]
      .filter((groupID) => !afterGroups.has(groupID))
      .map((groupID) =>
        topicAccessNotification("topicRemoved", apiKeyID, groupID)
      ),
  ];

  return notificationHeaders(...notifications);
};

export const allGroupAccessNotifications = async (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  event: "topicAdded" | "topicRemoved",
  groupID: number
) => {
  const keys = await createKeyStore(c.env).listUserKeys(userID);
  return keys
    .filter((key) => {
      const groups = isRecord(key.access.groups) ? key.access.groups : {};
      const all = isRecord(groups.all) ? groups.all : null;
      return all?.library === true;
    })
    .map((key) => topicAccessNotification(event, key.id ?? key.key, groupID));
};

export const getKeyAccessGroupIDs = async (
  store: CompatibilityStore,
  userID: number,
  access: Record<string, unknown>,
  options: {
    carryGroupIDs?: Iterable<number>;
    expandAll?: "public-owned" | "visible";
  } = {}
): Promise<Set<number>> => {
  const groups = isRecord(access.groups) ? access.groups : {};
  const allGroups = isRecord(groups.all) ? groups.all : null;
  if (allGroups?.library === true) {
    const visibleGroups = await store.listVisibleGroups(userID);
    const groupIDs =
      options.expandAll === "visible"
        ? visibleGroups.map((group) => group.id)
        : visibleGroups
            .filter(
              (group) =>
                isPublicGroupRecord(group) && group.data?.owner === userID
            )
            .map((group) => group.id);
    return new Set([...groupIDs, ...(options.carryGroupIDs ?? [])]);
  }

  return new Set(
    Object.entries(groups)
      .filter(
        ([groupID, value]) =>
          groupID !== "all" && isRecord(value) && value.library === true
      )
      .map(([groupID]) => Number.parseInt(groupID, 10))
      .filter((groupID) => Number.isFinite(groupID))
  );
};
