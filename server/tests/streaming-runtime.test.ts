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
});

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
