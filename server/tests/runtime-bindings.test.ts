import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Workers runtime bindings", () => {
  it("applies every D1 migration to an isolated database", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "api_keys",
        "attachment_files",
        "d1_migrations",
        "fulltext_index_states",
        "items",
        "libraries",
        "users",
      ])
    );

    const migrations = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id"
    ).all<{ name: string }>();
    expect(migrations.results.map((row) => row.name)).toEqual([
      "0001_initial.sql",
      "0002_d1_item_audit_and_file_metadata.sql",
      "0003_fulltext_index_state.sql",
    ]);
  });

  it("uses a local R2 binding with metadata and range reads", async () => {
    await env.ATTACHMENTS.put("runtime-binding.txt", "runtime", {
      customMetadata: { source: "vitest" },
      httpMetadata: { contentType: "text/plain" },
    });

    const object = await env.ATTACHMENTS.get("runtime-binding.txt");
    expect(object?.customMetadata).toEqual({ source: "vitest" });
    expect(object?.httpMetadata?.contentType).toBe("text/plain");
    expect(await object?.text()).toBe("runtime");

    const range = await env.ATTACHMENTS.get("runtime-binding.txt", {
      range: { length: 3, offset: 1 },
    });
    expect(await range?.text()).toBe("unt");
  });
});
