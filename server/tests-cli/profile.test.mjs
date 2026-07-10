import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  discoverProfile,
  parseProfilesIni,
  runProfileMigration,
} from "../cli/lib/profile.mjs";

const root = mkdtempSync(join(tmpdir(), "zotero-profile-test-"));

after(() => {
  rmSync(root, { force: true, recursive: true });
});

test("parses profiles.ini and discovers a custom Zotero data directory", () => {
  const sections = parseProfilesIni(`
[Profile0]
Name=default
IsRelative=1
Path=Profiles/abc.default
Default=1
`);
  assert.equal(sections[0].values.Path, "Profiles/abc.default");

  const profileDir = join(root, "Profiles", "abc.default");
  const dataDir = join(root, "custom-data");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(root, "profiles.ini"),
    "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\nDefault=1\n"
  );
  writeFileSync(
    join(profileDir, "prefs.js"),
    `user_pref("extensions.zotero.dataDir", ${JSON.stringify(dataDir)});\n`
  );
  writeFileSync(join(dataDir, "zotero.sqlite"), "database");

  const discovered = discoverProfile({ profilesRoot: root });
  assert.equal(discovered.profileDir, profileDir);
  assert.equal(discovered.dataDir, dataDir);
});

test("plans a profile cutover only when import state matches the owner target", async () => {
  const profileDir = join(root, "profile-plan");
  const dataDir = join(root, "data-plan");
  const statePath = join(root, "import-state.json");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "zotero.sqlite"), "database");

  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/keys/current") {
      response.end(
        JSON.stringify({
          displayName: "Owner",
          userID: 1,
          username: "owner",
        })
      );
      return;
    }
    if (request.url === "/users/1/keys") {
      response.end("[]");
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const targetURL = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      statePath,
      JSON.stringify({
        source: { userID: 42 },
        target: { origin: targetURL, userID: 1 },
        verifiedAt: new Date().toISOString(),
      })
    );
    const result = await runProfileMigration({
      dataDir,
      importStatePath: statePath,
      log: () => undefined,
      profileDir,
      targetApiKey: "owner-key",
      targetURL,
    });
    assert.equal(result.executed, false);
    assert.equal(result.plan.importVerified, true);
    assert.equal(result.plan.sourceUserID, 42);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
