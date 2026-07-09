type LibraryType = "group" | "user";

export interface StreamingNotification {
  event: string;
  topic: string;
  [key: string]: number | string;
}

export const topicUpdatedNotification = (
  libraryType: LibraryType,
  libraryID: number,
  version: number
): StreamingNotification => ({
  event: "topicUpdated",
  topic:
    libraryType === "user" ? `/users/${libraryID}` : `/groups/${libraryID}`,
  version,
});

export const topicPublicationsUpdatedNotification = (
  userID: number
): StreamingNotification => ({
  event: "topicUpdated",
  topic: `/users/${userID}/publications`,
});

export const topicAccessNotification = (
  event: "topicAdded" | "topicRemoved",
  apiKeyID: string,
  groupID: number
): StreamingNotification => ({
  apiKeyID,
  event,
  topic: `/groups/${groupID}`,
});

export const topicDeletedNotification = (
  groupID: number
): StreamingNotification => ({
  event: "topicDeleted",
  topic: `/groups/${groupID}`,
});

export const notificationHeaders = (
  ...notifications: StreamingNotification[]
): Record<string, string> =>
  notifications.length
    ? {
        "zotero-debug-notifications": encodeNotifications(notifications),
      }
    : {};

export const decodeNotificationHeader = (
  value: string | null
): StreamingNotification[] => {
  if (!value) {
    return [];
  }

  try {
    const encoded: unknown = JSON.parse(atob(value));
    if (!Array.isArray(encoded)) {
      return [];
    }

    return encoded.flatMap((entry) => {
      if (typeof entry !== "string") {
        return [];
      }
      const notification: unknown = JSON.parse(entry);
      return isStreamingNotification(notification) ? [notification] : [];
    });
  } catch {
    return [];
  }
};

const isStreamingNotification = (
  value: unknown
): value is StreamingNotification => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const notification = value as Record<string, unknown>;
  return (
    typeof notification.event === "string" &&
    typeof notification.topic === "string"
  );
};

const encodeNotifications = (notifications: StreamingNotification[]): string =>
  btoa(
    JSON.stringify(
      notifications.map((notification) => JSON.stringify(notification))
    )
  );
