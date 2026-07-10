import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  discoverProfile,
  parseProfilesIni,
  runNativeConnect,
  runProfileMigration,
} from "../cli-src/lib/profile.ts";

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

test("installs idempotent native account-linking preferences", async () => {
  const profileDir = join(root, "profile-connect");
  const dataDir = join(root, "data-connect");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "zotero.sqlite"), "database");
  writeFileSync(
    join(profileDir, "prefs.js"),
    `user_pref("extensions.zotero.dataDir", ${JSON.stringify(dataDir)});\n`
  );
  writeFileSync(join(profileDir, "user.js"), "// Keep this preference\n");

  const result = await runNativeConnect({
    execute: true,
    log: () => undefined,
    profileDir,
    targetURL: "https://library.example.com",
  });
  assert.equal(result.executed, true);
  assert.ok(result.backupPath && existsSync(result.backupPath));
  const contents = readFileSync(join(profileDir, "user.js"), "utf8");
  assert.match(contents, /Keep this preference/u);
  assert.match(
    contents,
    /extensions\.zotero\.api\.url.*https:\/\/library\.example\.com\//u
  );
  assert.match(
    contents,
    /extensions\.zotero\.streaming\.url.*wss:\/\/library\.example\.com\/stream/u
  );
  assert.equal(contents.match(/zotero-selfhost connect begin/gu)?.length, 1);

  await runNativeConnect({
    execute: true,
    log: () => undefined,
    profileDir,
    targetURL: "https://library.example.com",
  });
  const repeated = readFileSync(join(profileDir, "user.js"), "utf8");
  assert.equal(repeated.match(/zotero-selfhost connect begin/gu)?.length, 1);
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
