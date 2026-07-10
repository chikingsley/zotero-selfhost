import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../bindings";
import {
  createKeyStore,
  type KeyInfo,
  keyAllowsGroupPermission,
  keyAllowsUserPermission,
} from "../domain/keys";
import type { StreamingNotification } from "../domain/notifications";

interface StreamSubscription {
  apiKey?: string;
  automatic: boolean;
  topics: string[];
}

interface SocketAttachment {
  subscriptions: StreamSubscription[];
}

interface SubscriptionError {
  apiKey?: string;
  error: string;
  topic?: string;
}

interface SubscriptionRequest {
  apiKey?: string;
  hasTopics: boolean;
  topics: string[];
}

const maximumMessageBytes = 64 * 1024;
const maximumSubscriptions = 1000;

export class ZoteroStreamHub extends DurableObject<Bindings> {
  override fetch(request: Request): Response {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      subscriptions: [],
    } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ event: "connected", retry: 10_000 }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async publish(notification: StreamingNotification): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets()) {
      const attachment = readAttachment(webSocket);
      const removedRevokedKeys =
        await this.removeRevokedKeySubscriptions(attachment);
      const changed =
        applyAccessNotification(attachment, notification) || removedRevokedKeys;
      if (changed) {
        webSocket.serializeAttachment(attachment);
      }

      if (shouldReceive(attachment, notification)) {
        webSocket.send(JSON.stringify(notification));
      }
    }
  }

  override async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const text = decodeMessage(message);
    if (text === null) {
      webSocket.close(4400, "Invalid streaming request");
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      webSocket.close(4400, "Invalid JSON");
      return;
    }

    if (!isRecord(input) || typeof input.action !== "string") {
      webSocket.close(4400, "Invalid streaming action");
      return;
    }

    if (input.action === "createSubscriptions") {
      await this.createSubscriptions(webSocket, input.subscriptions);
      return;
    }
    if (input.action === "deleteSubscriptions") {
      this.deleteSubscriptions(webSocket, input.subscriptions);
      return;
    }
    if (input.action === "ping") {
      webSocket.send(JSON.stringify({ event: "pong" }));
      return;
    }

    webSocket.close(4400, "Unknown streaming action");
  }

  override webSocketError(webSocket: WebSocket, error: unknown): void {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        message: "streaming WebSocket error",
      })
    );
    webSocket.close(1011, "Streaming connection error");
  }

  override webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): void {
    webSocket.close(code, reason);
  }

  private async createSubscriptions(
    webSocket: WebSocket,
    value: unknown
  ): Promise<void> {
    const requests = readSubscriptionRequests(value);
    if (!requests) {
      webSocket.close(4400, "Invalid subscriptions");
      return;
    }

    const attachment = readAttachment(webSocket);
    const keyStore = createKeyStore(this.env);
    const errors: SubscriptionError[] = [];
    const responseSubscriptions: Array<{
      apiKey?: string;
      topics: string[];
    }> = [];

    for (const request of requests) {
      const key = request.apiKey ? await keyStore.getKey(request.apiKey) : null;
      if (request.apiKey && !key) {
        webSocket.close(4403, "Invalid API key");
        return;
      }
      if (request.apiKey) {
        await keyStore.recordAccess(request.apiKey);
      }

      const requestedTopics = request.hasTopics
        ? request.topics
        : key
          ? await this.getAvailableTopics(key)
          : [];
      const acceptedTopics: string[] = [];
      for (const topic of requestedTopics) {
        if (await this.canSubscribe(key, topic)) {
          acceptedTopics.push(topic);
        } else {
          errors.push({
            ...(request.apiKey ? { apiKey: request.apiKey } : {}),
            error: request.apiKey
              ? "Topic is not valid for provided API key"
              : "Topic is not accessible without an API key",
            topic,
          });
        }
      }

      const existing = attachment.subscriptions.find(
        (subscription) => subscription.apiKey === request.apiKey
      );
      if (existing) {
        existing.automatic ||= !request.hasTopics;
        existing.topics = unique([...existing.topics, ...acceptedTopics]);
      } else {
        attachment.subscriptions.push({
          ...(request.apiKey ? { apiKey: request.apiKey } : {}),
          automatic: !request.hasTopics,
          topics: unique(acceptedTopics),
        });
      }

      const current = attachment.subscriptions.find(
        (subscription) => subscription.apiKey === request.apiKey
      );
      responseSubscriptions.push({
        ...(request.apiKey ? { apiKey: request.apiKey } : {}),
        topics: current?.topics ?? [],
      });
    }

    if (countTopics(attachment) > maximumSubscriptions) {
      webSocket.close(4413, "Too many subscriptions");
      return;
    }

    webSocket.serializeAttachment(attachment);
    webSocket.send(
      JSON.stringify({
        ...(errors.length > 0 ? { errors } : {}),
        event: "subscriptionsCreated",
        subscriptions: responseSubscriptions,
      })
    );
  }

  private deleteSubscriptions(webSocket: WebSocket, value: unknown): void {
    const requests = readSubscriptionRequests(value);
    if (!requests) {
      webSocket.close(4400, "Invalid subscriptions");
      return;
    }

    const attachment = readAttachment(webSocket);
    let removed = false;
    for (const request of requests) {
      const matching = attachment.subscriptions.find(
        (subscription) => subscription.apiKey === request.apiKey
      );
      if (!matching) {
        continue;
      }

      if (!request.hasTopics || request.topics.length === 0) {
        attachment.subscriptions = attachment.subscriptions.filter(
          (subscription) => subscription !== matching
        );
        removed = true;
        continue;
      }

      const before = matching.topics.length;
      const deleted = new Set(request.topics);
      matching.topics = matching.topics.filter((topic) => !deleted.has(topic));
      matching.automatic = false;
      removed ||= matching.topics.length !== before;
    }

    if (!removed) {
      webSocket.close(4409, "Subscription does not exist");
      return;
    }

    webSocket.serializeAttachment(attachment);
    webSocket.send(JSON.stringify({ event: "subscriptionsDeleted" }));
  }

  private async canSubscribe(
    key: KeyInfo | null,
    topic: string
  ): Promise<boolean> {
    if (!key) {
      return this.canSubscribePublicly(topic);
    }

    const userTopic = /^\/users\/(\d+)(?:\/publications)?$/u.exec(topic);
    if (userTopic) {
      return (
        Number.parseInt(userTopic[1] ?? "", 10) === key.userID &&
        keyAllowsUserPermission(key.access, "library")
      );
    }

    const groupTopic = /^\/groups\/(\d+)$/u.exec(topic);
    if (!groupTopic) {
      return false;
    }
    const groupID = Number.parseInt(groupTopic[1] ?? "", 10);
    if (!keyAllowsGroupPermission(key.access, groupID, "library")) {
      return false;
    }

    const group = await this.env.DB.prepare(
      "SELECT group_id FROM groups WHERE group_id = ?"
    )
      .bind(groupID)
      .first<{ group_id: number }>();
    return group !== null;
  }

  private async canSubscribePublicly(topic: string): Promise<boolean> {
    const publicationsTopic = /^\/users\/(\d+)\/publications$/u.exec(topic);
    if (publicationsTopic) {
      const userID = Number.parseInt(publicationsTopic[1] ?? "", 10);
      const user = await this.env.DB.prepare(
        "SELECT user_id FROM users WHERE user_id = ?"
      )
        .bind(userID)
        .first<{ user_id: number }>();
      return user !== null;
    }

    const groupTopic = /^\/groups\/(\d+)$/u.exec(topic);
    if (!groupTopic) {
      return false;
    }
    const groupID = Number.parseInt(groupTopic[1] ?? "", 10);
    const group = await this.env.DB.prepare(
      "SELECT type, data_json FROM groups WHERE group_id = ?"
    )
      .bind(groupID)
      .first<{ data_json: string; type: string }>();
    if (
      !group ||
      (group.type !== "PublicOpen" && group.type !== "PublicClosed")
    ) {
      return false;
    }

    try {
      const data: unknown = JSON.parse(group.data_json);
      return isRecord(data) && data.libraryReading === "all";
    } catch {
      return false;
    }
  }

  private async getAvailableTopics(key: KeyInfo): Promise<string[]> {
    const topics: string[] = [];
    if (keyAllowsUserPermission(key.access, "library")) {
      topics.push(`/users/${key.userID}`);
    }

    const groups = await this.env.DB.prepare(
      "SELECT group_id FROM groups ORDER BY group_id"
    ).all<{ group_id: number }>();
    for (const group of groups.results) {
      if (keyAllowsGroupPermission(key.access, group.group_id, "library")) {
        topics.push(`/groups/${group.group_id}`);
      }
    }

    return topics;
  }

  private async removeRevokedKeySubscriptions(
    attachment: SocketAttachment
  ): Promise<boolean> {
    const keyStore = createKeyStore(this.env);
    const validity = new Map<string, boolean>();
    for (const subscription of attachment.subscriptions) {
      if (subscription.apiKey && !validity.has(subscription.apiKey)) {
        validity.set(
          subscription.apiKey,
          (await keyStore.getKey(subscription.apiKey)) !== null
        );
      }
    }

    const before = attachment.subscriptions.length;
    attachment.subscriptions = attachment.subscriptions.filter(
      (subscription) =>
        !subscription.apiKey || validity.get(subscription.apiKey) === true
    );
    return attachment.subscriptions.length !== before;
  }
}

const decodeMessage = (message: string | ArrayBuffer): string | null => {
  if (typeof message === "string") {
    return new TextEncoder().encode(message).byteLength <= maximumMessageBytes
      ? message
      : null;
  }
  return message.byteLength <= maximumMessageBytes
    ? new TextDecoder().decode(message)
    : null;
};

const readSubscriptionRequests = (
  value: unknown
): SubscriptionRequest[] | null => {
  if (!Array.isArray(value) || value.length > maximumSubscriptions) {
    return null;
  }

  const requests: SubscriptionRequest[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const apiKey = typeof entry.apiKey === "string" ? entry.apiKey : undefined;
    const hasTopics = Object.hasOwn(entry, "topics");
    const topics = hasTopics ? entry.topics : [];
    if (
      !((apiKey || hasTopics) && Array.isArray(topics)) ||
      topics.some((topic) => typeof topic !== "string")
    ) {
      return null;
    }

    requests.push({
      ...(apiKey ? { apiKey } : {}),
      hasTopics,
      topics,
    });
  }

  return requests;
};

const readAttachment = (webSocket: WebSocket): SocketAttachment => {
  const value: unknown = webSocket.deserializeAttachment();
  if (!(isRecord(value) && Array.isArray(value.subscriptions))) {
    return { subscriptions: [] };
  }

  const subscriptions = value.subscriptions.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.automatic !== "boolean" ||
      !Array.isArray(entry.topics) ||
      entry.topics.some((topic) => typeof topic !== "string") ||
      !(entry.apiKey === undefined || typeof entry.apiKey === "string")
    ) {
      return [];
    }

    return [
      {
        ...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
        automatic: entry.automatic,
        topics: entry.topics,
      },
    ];
  });

  return { subscriptions };
};

const applyAccessNotification = (
  attachment: SocketAttachment,
  notification: StreamingNotification
): boolean => {
  const apiKeyID =
    typeof notification.apiKeyID === "string" ? notification.apiKeyID : null;
  if (!apiKeyID) {
    return false;
  }

  const subscription = attachment.subscriptions.find(
    (entry) => entry.apiKey === apiKeyID
  );
  if (!subscription) {
    return false;
  }

  if (notification.event === "topicAdded" && subscription.automatic) {
    subscription.topics = unique([...subscription.topics, notification.topic]);
    return true;
  }
  if (notification.event === "topicRemoved") {
    const before = subscription.topics.length;
    subscription.topics = subscription.topics.filter(
      (topic) => topic !== notification.topic
    );
    return subscription.topics.length !== before;
  }

  return false;
};

const shouldReceive = (
  attachment: SocketAttachment,
  notification: StreamingNotification
): boolean => {
  if (
    notification.event === "topicAdded" ||
    notification.event === "topicRemoved"
  ) {
    return attachment.subscriptions.some(
      (subscription) => subscription.apiKey === notification.apiKeyID
    );
  }

  return attachment.subscriptions.some((subscription) =>
    subscription.topics.includes(notification.topic)
  );
};

const unique = (values: string[]): string[] => [...new Set(values)];

const countTopics = (attachment: SocketAttachment): number =>
  attachment.subscriptions.reduce(
    (total, subscription) => total + subscription.topics.length,
    0
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
