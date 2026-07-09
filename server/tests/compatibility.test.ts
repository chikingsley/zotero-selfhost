import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

const compatibilityAdminAuth = `Basic ${btoa(
  "compatibility:runtime-test-admin-token"
)}`;

const request = runtimeRequest;

describe("Zotero compatibility bootstrap", () => {
  it("sets up test users and API keys", async () => {
    const response = await request("/test/setup?u=1&u2=2", {
      body: " ",
      headers: {
        Authorization: compatibilityAdminAuth,
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

    const persisted = await env.DB.prepare(
      "SELECT user_id, api_key FROM api_keys ORDER BY user_id"
    ).all<{ api_key: string; user_id: number }>();
    expect(persisted.results).toEqual([
      { api_key: body.user1.apiKey, user_id: 1 },
      { api_key: body.user2.apiKey, user_id: 2 },
    ]);
  });

  it("supports the first general-test item flow", async () => {
    const setup = await request("/test/setup?u=1&u2=2", {
      body: " ",
      headers: {
        Authorization: compatibilityAdminAuth,
      },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };

    const clear = await request("/users/1/clear", {
      body: "",
      headers: {
        Authorization: compatibilityAdminAuth,
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

  it("enforces key-write version preconditions in D1", async () => {
    const setup = await request("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: compatibilityAdminAuth },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };
    const authorization = `Bearer ${setupBody.user1.apiKey}`;

    const template = await request("/items/new?itemType=book");
    const item = (await template.json()) as Record<string, unknown>;
    item.title = "Versioned title";

    const create = await request("/users/1/items", {
      body: JSON.stringify([item]),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const createBody = (await create.json()) as {
      success: Record<string, string>;
    };
    const itemKey = createBody.success["0"];
    const createdVersion = create.headers.get("Last-Modified-Version");
    expect(itemKey).toBeTruthy();
    expect(createdVersion).toBeTruthy();
    if (!(itemKey && createdVersion)) {
      throw new Error("Expected an item key and library version");
    }

    const missingPrecondition = await request(`/users/1/items/${itemKey}`, {
      body: JSON.stringify({ title: "Missing precondition" }),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      method: "PATCH",
    });
    expect(missingPrecondition.status).toBe(428);

    const update = await request(`/users/1/items/${itemKey}`, {
      body: JSON.stringify({ title: "Updated title" }),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": createdVersion,
      },
      method: "PATCH",
    });
    expect(update.status).toBe(204);
    const updatedVersion = update.headers.get("Last-Modified-Version");
    expect(Number(updatedVersion)).toBeGreaterThan(Number(createdVersion));

    const staleUpdate = await request(`/users/1/items/${itemKey}`, {
      body: JSON.stringify({ title: "Stale title" }),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "If-Unmodified-Since-Version": createdVersion,
      },
      method: "PATCH",
    });
    expect(staleUpdate.status).toBe(412);
    expect(staleUpdate.headers.get("Last-Modified-Version")).toBe(
      updatedVersion
    );

    const row = await env.DB.prepare(
      "SELECT version, data_json FROM items WHERE library_type = 'user' AND library_id = 1 AND item_key = ?"
    )
      .bind(itemKey)
      .first<{ data_json: string; version: number }>();
    expect(row?.version).toBe(Number(updatedVersion));
    expect(JSON.parse(row?.data_json ?? "{}")).toMatchObject({
      title: "Updated title",
    });
  });
});
