import type { Bindings } from "../bindings";
import type { StreamingNotification } from "./notifications";

const installationStreamHubName = "installation";

export const publishStreamingNotifications = async (
  env: Bindings,
  notifications: StreamingNotification[]
): Promise<void> => {
  if (notifications.length === 0) {
    return;
  }

  // A self-host deployment is one coordination tenant. Its hub owns only live
  // subscriptions; D1 and R2 remain the authoritative library stores.
  const hub = env.STREAM_HUB.getByName(installationStreamHubName);
  for (const notification of notifications) {
    await hub.publish(notification);
  }
};

export const getInstallationStreamHub = (env: Bindings) =>
  env.STREAM_HUB.getByName(installationStreamHubName);
