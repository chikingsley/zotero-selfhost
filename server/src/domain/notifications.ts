type LibraryType = "group" | "user";

interface DebugNotification {
  event: string;
  topic: string;
  [key: string]: number | string;
}

export const topicUpdatedNotification = (
  libraryType: LibraryType,
  libraryID: number,
  version: number
): DebugNotification => ({
  event: "topicUpdated",
  topic:
    libraryType === "user" ? `/users/${libraryID}` : `/groups/${libraryID}`,
  version,
});

export const topicPublicationsUpdatedNotification = (
  userID: number
): DebugNotification => ({
  event: "topicUpdated",
  topic: `/users/${userID}/publications`,
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

export const topicDeletedNotification = (
  groupID: number
): DebugNotification => ({
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
  btoa(
    JSON.stringify(
      notifications.map((notification) => JSON.stringify(notification))
    )
  );
