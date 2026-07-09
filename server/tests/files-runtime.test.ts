import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

const rootAuth = `Basic ${btoa("root:local-root-password")}`;

describe("attachment storage through the Worker runtime", () => {
  it("persists file metadata in D1 and bytes in R2", async () => {
    const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: rootAuth },
      method: "POST",
    });
    const setupBody = (await setup.json()) as {
      user1: { apiKey: string };
    };
    const authorization = `Bearer ${setupBody.user1.apiKey}`;

    const template = await runtimeRequest(
      "/items/new?itemType=attachment&linkMode=imported_file"
    );
    const attachment = (await template.json()) as Record<string, unknown>;
    attachment.filename = "hello.txt";
    attachment.title = "Runtime attachment";

    const create = await runtimeRequest("/users/1/items", {
      body: JSON.stringify([attachment]),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(create.status).toBe(200);
    const createBody = (await create.json()) as {
      success: Record<string, string>;
    };
    const itemKey = createBody.success["0"];
    expect(itemKey).toBeTruthy();
    if (!itemKey) {
      throw new Error("Expected an attachment item key");
    }

    const uploadRequest = await runtimeRequest(
      `/users/1/items/${itemKey}/file`,
      {
        body: new URLSearchParams({
          contentType: "text/plain",
          filename: "hello.txt",
          filesize: "5",
          md5: "5d41402abc4b2a76b9719d911017c592",
          mtime: "1700000000000",
          params: "1",
        }),
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
          "If-None-Match": "*",
        },
        method: "POST",
      }
    );
    expect(uploadRequest.status).toBe(200);
    const upload = (await uploadRequest.json()) as {
      uploadKey: string;
      url: string;
    };

    const uploadBody = await runtimeRequest(upload.url, {
      body: "hello",
      headers: { "Content-Type": "text/plain" },
      method: "POST",
    });
    expect(uploadBody.status).toBe(201);

    const register = await runtimeRequest(`/users/1/items/${itemKey}/file`, {
      body: new URLSearchParams({ upload: upload.uploadKey }),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      method: "POST",
    });
    expect(register.status).toBe(204);

    const download = await runtimeRequest(`/users/1/items/${itemKey}/file`, {
      headers: { Authorization: authorization },
      redirect: "manual",
    });
    expect(download.status).toBe(302);
    const location = download.headers.get("Location");
    expect(location).toBeTruthy();
    if (!location) {
      throw new Error("Expected a signed attachment URL");
    }

    const raw = await runtimeRequest(location);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("text/plain");
    expect(await raw.text()).toBe("hello");

    const file = await env.DB.prepare(
      "SELECT r2_key, md5, filename, size_bytes FROM attachment_files WHERE library_type = 'user' AND library_id = 1 AND item_key = ?"
    )
      .bind(itemKey)
      .first<{
        filename: string;
        md5: string;
        r2_key: string;
        size_bytes: number;
      }>();
    expect(file).toMatchObject({
      filename: "hello.txt",
      md5: "5d41402abc4b2a76b9719d911017c592",
      size_bytes: 5,
    });
    expect(file?.r2_key).toBeTruthy();
    if (!file?.r2_key) {
      throw new Error("Expected persisted R2 object metadata");
    }

    const r2Object = await env.ATTACHMENTS.get(file.r2_key);
    expect(await r2Object?.text()).toBe("hello");
  });
});
