import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runtimeRequest } from "./runtime";

const compatibilityAdminAuth = `Basic ${btoa(
  "compatibility:runtime-test-admin-token"
)}`;

describe("attachment storage through the Worker runtime", () => {
  it("persists file metadata in D1 and bytes in R2", async () => {
    const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: compatibilityAdminAuth },
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
    expect(register.headers.get("Zotero-Library-Version")).toBeTruthy();
    expect(register.headers.get("Zotero-Library-Version")).toBe(
      register.headers.get("Last-Modified-Version")
    );

    const download = await runtimeRequest(`/users/1/items/${itemKey}/file`, {
      headers: { Authorization: authorization },
      redirect: "manual",
    });
    expect(download.status).toBe(302);
    expect(download.headers.get("Access-Control-Expose-Headers")).toContain(
      "Zotero-File-Modification-Time"
    );
    expect(download.headers.get("Zotero-File-Compressed")).toBe("No");
    expect(download.headers.get("Zotero-File-MD5")).toBe(
      "5d41402abc4b2a76b9719d911017c592"
    );
    expect(download.headers.get("Zotero-File-Modification-Time")).toBe(
      "1700000000000"
    );
    expect(download.headers.get("Zotero-File-Size")).toBe("5");
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

    const fulltext = await runtimeRequest(
      `/users/1/items/${itemKey}/fulltext`,
      {
        body: JSON.stringify({
          content: "hello",
          indexedChars: 5,
          totalChars: 5,
        }),
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        method: "PUT",
      }
    );
    expect(fulltext.status).toBe(204);
    const remove = await runtimeRequest(`/users/1/items/${itemKey}`, {
      headers: {
        Authorization: authorization,
        "If-Unmodified-Since-Version":
          register.headers.get("Last-Modified-Version") ?? "0",
      },
      method: "DELETE",
    });
    expect(remove.status).toBe(204);
    expect(await env.ATTACHMENTS.get(file.r2_key)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM attachment_uploads WHERE upload_key = ?"
      )
        .bind(upload.uploadKey)
        .first()
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM fulltext_items WHERE library_type = 'user' AND library_id = 1 AND item_key = ?"
      )
        .bind(itemKey)
        .first()
    ).toBeNull();
  });

  it("authorizes and completes a direct single-part R2 upload", async () => {
    const setup = await runtimeRequest("/test/setup?u=1&u2=2", {
      body: " ",
      headers: { Authorization: compatibilityAdminAuth },
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
    attachment.filename = "direct.txt";
    attachment.title = "Direct runtime attachment";
    const create = await runtimeRequest("/users/1/items", {
      body: JSON.stringify([attachment]),
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
    expect(itemKey).toBeTruthy();
    if (!itemKey) {
      throw new Error("Expected a direct attachment item key");
    }

    const authorize = await runtimeRequest(`/users/1/items/${itemKey}/file`, {
      body: new URLSearchParams({
        contentType: "text/plain",
        direct: "1",
        filename: "direct.txt",
        filesize: "5",
        md5: "5d41402abc4b2a76b9719d911017c592",
        mtime: "1700000000000",
      }),
      headers: {
        Authorization: authorization,
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      method: "POST",
    });
    expect(authorize.status).toBe(200);
    const upload = (await authorize.json()) as {
      transfer: { kind: string; url: string };
      uploadKey: string;
    };
    expect(upload.transfer.kind).toBe("single");
    expect(new URL(upload.transfer.url).hostname).toBe(
      "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
    );
    const queued = await env.DB.prepare(
      "SELECT r2_key, upload_strategy FROM attachment_uploads WHERE upload_key = ?"
    )
      .bind(upload.uploadKey)
      .first<{ r2_key: string; upload_strategy: string }>();
    expect(queued?.upload_strategy).toBe("single");
    if (!queued) {
      throw new Error("Expected a queued direct upload");
    }
    await env.ATTACHMENTS.put(queued.r2_key, "hello");

    const complete = await runtimeRequest(
      `/users/1/items/${itemKey}/file/direct/${upload.uploadKey}/complete`,
      {
        body: JSON.stringify({ parts: [] }),
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        method: "POST",
      }
    );
    expect(complete.status).toBe(204);
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
  });
});
