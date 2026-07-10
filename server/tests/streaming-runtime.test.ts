import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

const compatibilityAdminAuth = `Basic ${btoa(
  "compatibility:runtime-test-admin-token"
)}`;

describe("Zotero streaming through a hibernating Durable Object", () => {
  it("authenticates a subscription and publishes committed library versions", async () => {
    const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: compatibilityAdminAuth },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };

    const upgrade = await runtimeRequest("/stream", {
      headers: { Upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(101);
    const webSocket = upgrade.webSocket;
    expect(webSocket).toBeDefined();
    if (!webSocket) {
      throw new Error("Expected a WebSocket upgrade response");
    }

    const connectedMessage = nextMessage(webSocket);
    webSocket.accept();
    expect(JSON.parse(await connectedMessage)).toEqual({
      event: "connected",
      retry: 10_000,
    });

    const subscribedMessage = nextMessage(webSocket);
    webSocket.send(
      JSON.stringify({
        action: "createSubscriptions",
        subscriptions: [
          {
            apiKey: setupBody.user1.apiKey,
            topics: ["/users/1"],
          },
        ],
      })
    );
    expect(JSON.parse(await subscribedMessage)).toEqual({
      event: "subscriptionsCreated",
      subscriptions: [
        {
          apiKey: setupBody.user1.apiKey,
          topics: ["/users/1"],
        },
      ],
    });

    const notificationMessage = nextMessage(webSocket);
    await env.STREAM_HUB.getByName("installation").publish({
      event: "topicUpdated",
      topic: "/users/1",
      version: 42,
    });
    expect(JSON.parse(await notificationMessage)).toEqual({
      event: "topicUpdated",
      topic: "/users/1",
      version: 42,
    });

    const template = await runtimeRequest("/items/new?itemType=book");
    const item = (await template.json()) as Record<string, unknown>;
    item.title = "Streaming integration";

    const committedMessage = nextMessage(webSocket);
    const create = await runtimeRequest("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(create.status).toBe(200);
    expect(JSON.parse(await committedMessage)).toEqual({
      event: "topicUpdated",
      topic: "/users/1",
      version: Number(create.headers.get("Last-Modified-Version")),
    });

    webSocket.close(1000, "test complete");
  });

  it("rejects invalid keys without accepting a subscription", async () => {
    const webSocket = await openWebSocket();
    const closed = nextClose(webSocket);

    webSocket.send(
      JSON.stringify({
        action: "createSubscriptions",
        subscriptions: [
          {
            apiKey: "invalid1",
            topics: ["/users/1"],
          },
        ],
      })
    );

    expect(await closed).toEqual({
      code: 4403,
      reason: "Invalid API key",
    });
  });

  it("removes revoked-key subscriptions while keeping the socket responsive", async () => {
    const apiKey = await setupUser();
    const webSocket = await openWebSocket();
    const subscribed = nextMessage(webSocket);
    webSocket.send(
      JSON.stringify({
        action: "createSubscriptions",
        subscriptions: [{ apiKey, topics: ["/users/1"] }],
      })
    );
    expect(JSON.parse(await subscribed)).toMatchObject({
      event: "subscriptionsCreated",
    });

    const revoke = await runtimeRequest("/keys/current", {
      headers: { Authorization: `Bearer ${apiKey}` },
      method: "DELETE",
    });
    expect(revoke.status).toBe(204);

    const unexpectedNotification = receivesMessageWithin(webSocket, 100);
    await env.STREAM_HUB.getByName("installation").publish({
      event: "topicUpdated",
      topic: "/users/1",
      version: 43,
    });
    expect(await unexpectedNotification).toBe(false);

    const pong = nextMessage(webSocket);
    webSocket.send(JSON.stringify({ action: "ping" }));
    expect(JSON.parse(await pong)).toEqual({ event: "pong" });
    webSocket.close(1000, "test complete");
  });

  it("reauthenticates subscriptions after a client reconnect", async () => {
    const apiKey = await setupUser();
    const first = await openWebSocket();
    first.close(1000, "simulate disconnect");

    const reconnected = await openWebSocket();
    const subscribed = nextMessage(reconnected);
    reconnected.send(
      JSON.stringify({
        action: "createSubscriptions",
        subscriptions: [{ apiKey, topics: ["/users/1"] }],
      })
    );
    expect(JSON.parse(await subscribed)).toMatchObject({
      event: "subscriptionsCreated",
    });

    const notification = nextMessage(reconnected);
    await env.STREAM_HUB.getByName("installation").publish({
      event: "topicUpdated",
      topic: "/users/1",
      version: 44,
    });
    expect(JSON.parse(await notification)).toEqual({
      event: "topicUpdated",
      topic: "/users/1",
      version: 44,
    });
    reconnected.close(1000, "test complete");
  });

  it("preserves hibernated subscriptions across Durable Object eviction", async () => {
    const apiKey = await setupUser();
    const webSocket = await openWebSocket();
    const subscribed = nextMessage(webSocket);
    webSocket.send(
      JSON.stringify({
        action: "createSubscriptions",
        subscriptions: [{ apiKey, topics: ["/users/1"] }],
      })
    );
    expect(JSON.parse(await subscribed)).toMatchObject({
      event: "subscriptionsCreated",
    });

    const hub = env.STREAM_HUB.getByName("installation");
    await evictDurableObject(hub);

    const notification = nextMessage(webSocket);
    await hub.publish({
      event: "topicUpdated",
      topic: "/users/1",
      version: 45,
    });
    expect(JSON.parse(await notification)).toEqual({
      event: "topicUpdated",
      topic: "/users/1",
      version: 45,
    });
    webSocket.close(1000, "test complete");
  });
});

const setupUser = async (): Promise<string> => {
  const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
    body: " ",
    headers: { Authorization: compatibilityAdminAuth },
    method: "POST",
  });
  const body = (await setup.json()) as { user1: { apiKey: string } };
  return body.user1.apiKey;
};

const openWebSocket = async (): Promise<WebSocket> => {
  const upgrade = await runtimeRequest("/stream", {
    headers: { Upgrade: "websocket" },
  });
  if (upgrade.status !== 101) {
    throw new Error(`Expected WebSocket upgrade, received ${upgrade.status}`);
  }
  const webSocket = upgrade.webSocket;
  if (!webSocket) {
    throw new Error("Expected a WebSocket upgrade response");
  }

  const connected = nextMessage(webSocket);
  webSocket.accept();
  const message = JSON.parse(await connected) as {
    event?: string;
    retry?: number;
  };
  if (message.event !== "connected" || message.retry !== 10_000) {
    throw new Error(
      `Unexpected streaming handshake: ${JSON.stringify(message)}`
    );
  }
  return webSocket;
};

const nextMessage = (webSocket: WebSocket): Promise<string> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for streaming message"));
    }, 2000);

    webSocket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        if (typeof event.data === "string") {
          resolve(event.data);
          return;
        }
        reject(new Error("Expected a text streaming message"));
      },
      { once: true }
    );
  });

const nextClose = (
  webSocket: WebSocket
): Promise<{ code: number; reason: string }> =>
  new Promise((resolve) => {
    webSocket.addEventListener(
      "close",
      (event) => resolve({ code: event.code, reason: event.reason }),
      { once: true }
    );
  });

const receivesMessageWithin = (
  webSocket: WebSocket,
  timeoutMilliseconds: number
): Promise<boolean> =>
  new Promise((resolve) => {
    const onMessage = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      webSocket.removeEventListener("message", onMessage);
      resolve(false);
    }, timeoutMilliseconds);
    webSocket.addEventListener("message", onMessage, { once: true });
  });
