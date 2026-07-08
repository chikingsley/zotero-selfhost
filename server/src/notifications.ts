type LibraryType = "group" | "user";

interface DebugNotification {
  [key: string]: number | string;
  event: string;
  topic: string;
}

export const topicUpdatedNotification = (
  libraryType: LibraryType,
  libraryID: number,
  version: number
): DebugNotification => ({
  event: "topicUpdated",
  topic: libraryType === "user" ? `/users/${libraryID}` : `/groups/${libraryID}`,
  version,
});

export const topicAccessNotification = (
  event: "topicAdded" | "topicRemoved",
  apiKeyID: string,
  groupID: number
): DebugNotification => ({
  apiKeyID,
  event,
  topic: `/groups/${groupID}`,
});

export const topicDeletedNotification = (groupID: number): DebugNotification => ({
  event: "topicDeleted",
  topic: `/groups/${groupID}`,
});

export const notificationHeaders = (
  ...notifications: DebugNotification[]
): Record<string, string> =>
  notifications.length
    ? {
        "zotero-debug-notifications": encodeNotifications(notifications),
      }
    : {};

const encodeNotifications = (notifications: DebugNotification[]): string =>
  btoa(JSON.stringify(notifications.map((notification) => JSON.stringify(notification))));
