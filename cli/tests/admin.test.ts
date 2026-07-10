import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAdminCommand } from "../src/commands/admin.ts";
import { restoreD1 } from "../src/internal/d1-recovery.ts";
import { resolvePackageRoot } from "../src/internal/package-root.ts";
import { copyR2, emptyR2Drill } from "../src/internal/r2-recovery.ts";

test("resolves the package root from source and bundled CLI locations", () => {
  assert.equal(
    resolvePackageRoot("file:///repo/cli/src/commands/cloudflare.ts"),
    "/repo"
  );
  assert.equal(
    resolvePackageRoot("file:///repo/dist/cli/zotero-selfhost.mjs"),
    "/repo"
  );
});

test("rejects unknown administrative commands before reading credentials", async () => {
  await assert.rejects(
    runAdminCommand("unknown", {}),
    /Unknown admin command/u
  );
});

test("refuses same-bucket R2 copies before contacting Cloudflare", async () => {
  await assert.rejects(
    copyR2({
      accountID: "account",
      apiToken: "token",
      destinationBucket: "attachments",
      sourceBucket: "attachments",
    }),
    /must be different/u
  );
});

test("refuses to empty an ordinary R2 bucket before contacting Cloudflare", async () => {
  await assert.rejects(
    emptyR2Drill({
      accountID: "account",
      apiToken: "token",
      bucket: "production-attachments",
    }),
    /not named as a restore drill/u
  );
});

test("restores and verifies a SQL backup through parameterized D1 queries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zotero-d1-test-"));
  const inputPath = join(directory, "backup.sql");
  const originalFetch = globalThis.fetch;
  const statements: string[] = [];
  await writeFile(
    inputPath,
    [
      "CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
      "INSERT INTO records VALUES (1, 'one'), (2, 'two');",
      "CREATE INDEX records_name ON records (name);",
      "",
    ].join("\n")
  );

  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { sql: string };
    statements.push(request.sql);
    return Response.json({
      result: [
        {
          results: request.sql.startsWith("SELECT count(*)")
            ? [{ count: 2 }]
            : [],
          success: true,
        },
      ],
      success: true,
    });
  }) as typeof fetch;

  try {
    await restoreD1({
      accountID: "account",
      apiToken: "token",
      databaseID: "database",
      inputPath,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { force: true, recursive: true });
  }

  assert.ok(statements.some((sql) => sql.startsWith("CREATE TABLE records")));
  assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO "records"')));
  assert.ok(
    statements.some((sql) => sql.startsWith("CREATE INDEX records_name"))
  );
  assert.ok(statements.some((sql) => sql.startsWith("SELECT count(*)")));
});
