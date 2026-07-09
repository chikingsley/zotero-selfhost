import { describe, expect, it } from "vitest";
import app from "../src/index";

const rootAuth = `Basic ${btoa("root:local-root-password")}`;

const request = (path: string, init?: RequestInit) =>
  app.request(path, init, {
    ROOT_PASSWORD: "local-root-password",
    ROOT_USERNAME: "root",
  });

describe("Zotero compatibility bootstrap", () => {
  it("sets up test users and API keys", async () => {
    const response = await request("/test/setup?u=1&u2=2", {
      body: " ",
      headers: {
        Authorization: rootAuth,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user1: { apiKey: string; userID: number };
      user2: { apiKey: string; userID: number };
    };
    expect(body.user1.userID).toBe(1);
    expect(body.user1.apiKey).toHaveLength(8);
    expect(body.user2.userID).toBe(2);
  });

  it("supports the first general-test item flow", async () => {
    const setup = await request("/test/setup?u=1&u2=2", {
      body: " ",
      headers: {
        Authorization: rootAuth,
      },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };

    const clear = await request("/users/1/clear", {
      body: "",
      headers: {
        Authorization: rootAuth,
      },
      method: "POST",
    });
    expect(clear.status).toBe(204);

    const invalidUser = await request("/users/foo/items", {
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
      },
    });
    expect(invalidUser.status).toBe(400);

    const template = await request("/items/new?itemType=book");
    expect(template.status).toBe(200);
    const item = (await template.json()) as Record<string, unknown>;
    item.title = "A\u0000A";
    item.creators = [{ creatorType: "author", name: "B\u0001B" }];
    item.tags = [{ tag: "C\u0002C" }];

    const token = "same-write-token";
    const create = await request("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
        "Content-Type": "application/json",
        "Zotero-Write-Token": token,
      },
      method: "POST",
    });
    expect(create.status).toBe(200);
    // Official write reports key `success` by batch index, not as an array.
    const createBody = (await create.json()) as {
      success: Record<string, string>;
    };
    expect(Object.keys(createBody.success)).toHaveLength(1);
    const createdKey = createBody.success["0"];
    expect(createdKey).toBeTruthy();

    const fullText = await request("/users/1/fulltext", {
      body: JSON.stringify([
        {
          content: "Desktop full-text upload",
          indexedChars: 24,
          key: createdKey,
          totalChars: 24,
        },
      ]),
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version":
          create.headers.get("Last-Modified-Version") ?? "",
      },
      method: "POST",
    });
    expect(fullText.status).toBe(200);
    expect(fullText.headers.get("Last-Modified-Version")).toBeTruthy();
    const fullTextBody = (await fullText.json()) as {
      successful: Record<string, { itemKey: string; key: string }>;
      unchanged: Record<string, string>;
    };
    const uploadedFullText = fullTextBody.successful["0"];
    expect(uploadedFullText).toBeDefined();
    if (!uploadedFullText) {
      throw new Error("Expected full-text upload result");
    }
    expect(uploadedFullText.itemKey).toBe(createdKey);
    expect(uploadedFullText.key).toBe(createdKey);
    expect(fullTextBody.unchanged).toEqual({});

    const duplicateToken = await request("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
        "Content-Type": "application/json",
        "Zotero-Write-Token": token,
      },
      method: "POST",
    });
    expect(duplicateToken.status).toBe(412);

    const fetched = await request(`/users/1/items/${createdKey}?format=json`, {
      headers: {
        Authorization: `Bearer ${setupBody.user1.apiKey}`,
      },
    });
    const fetchedBody = (await fetched.json()) as {
      data: {
        creators: [{ name: string }];
        tags: [{ tag: string }];
        title: string;
      };
    };
    expect(fetchedBody.data.title).toBe("AA");
    expect(fetchedBody.data.creators[0].name).toBe("BB");
    expect(fetchedBody.data.tags[0].tag).toBe("CC");
  });
});
