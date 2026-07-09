import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

interface RunOptions {
  allowFailure?: boolean;
  cwd?: string;
  input?: string;
}

interface SmokeResult {
  attachmentKey: string;
  itemKey: string;
  noteKey: string;
  ok: true;
  title: string;
}

const args = new Set(process.argv.slice(2));
const endpoint =
  getArgValue("--endpoint") ?? "https://zotero.peacockery.studio/";
const normalizedEndpoint = `${endpoint.replace(/\/+$/, "")}/`;
const baseURL = normalizedEndpoint.replace(/\/+$/, "");
const zoteroApp = getArgValue("--zotero-app") ?? "/Applications/Zotero.app";
const tmpRoot = getArgValue("--tmp") ?? "/tmp/zotero-real-app-smoke";
const keepOpen = args.has("--keep-open");
const allowExistingZotero = args.has("--allow-existing-zotero");
const profileDir = join(tmpRoot, "profile");
const dataDir = join(tmpRoot, "data");
const apiKeyPath = join(tmpRoot, "api-key");
const resultPath = join(tmpRoot, "result.json");
const scriptPath = join(tmpRoot, "desktop-smoke.js");
const sourcePath = join(tmpRoot, "source.txt");

const rootUsername = process.env.ROOT_USERNAME ?? "root";
const rootPassword = process.env.ROOT_PASSWORD ?? "local-root-password";

await main();

async function main() {
  if (!existsSync(zoteroApp)) {
    throw new Error(`Zotero app not found at ${zoteroApp}`);
  }

  await assertNoOtherZotero();
  await killTempZotero();
  await resetTempRoot();
  await writeProfilePrefs();
  await writeDesktopSmokeScript();
  await setupRemoteTestUser();

  const previousClipboard = await run("pbpaste", [], {
    allowFailure: true,
  }).then((result) => result.stdout);

  try {
    await run("open", [
      "-n",
      "-a",
      zoteroApp,
      "--args",
      "--profile",
      profileDir,
      "--new-instance",
    ]);
    await waitForZoteroProcess();
    await openRunJavaScript();
    await runLoaderInZotero();
    const smoke = await waitForSmokeResult();
    const remote = await verifyRemote(smoke);

    console.log(
      JSON.stringify(
        {
          endpoint: normalizedEndpoint,
          ok: true,
          remote,
          resultPath,
          smoke,
          worker: baseURL,
        },
        null,
        2
      )
    );
  } finally {
    await run("pbcopy", [], { allowFailure: true, input: previousClipboard });
    if (!keepOpen) {
      await killTempZotero();
    }
  }
}

async function assertNoOtherZotero() {
  const ps = await run("ps", ["aux"]);
  const zoteroProcesses = ps.stdout
    .split(/\r?\n/)
    .filter((line) =>
      line.includes("/Applications/Zotero.app/Contents/MacOS/zotero")
    )
    .filter((line) => !line.includes(`--profile ${profileDir}`));

  if (zoteroProcesses.length && !allowExistingZotero) {
    throw new Error(
      [
        "Another Zotero process is already running.",
        "Close it first, or rerun with --allow-existing-zotero if you know the UI automation will target the temp instance.",
        ...zoteroProcesses,
      ].join("\n")
    );
  }
}

async function killTempZotero() {
  await run("pkill", ["-f", `zotero --profile ${profileDir}`], {
    allowFailure: true,
  });
}

async function resetTempRoot() {
  await rm(profileDir, { force: true, recursive: true });
  await rm(dataDir, { force: true, recursive: true });
  await rm(resultPath, { force: true });
  await rm(apiKeyPath, { force: true });
  await rm(sourcePath, { force: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
}

async function writeProfilePrefs() {
  await writeFile(
    join(profileDir, "user.js"),
    [
      'user_pref("extensions.zotero.useDataDir", true);',
      `user_pref("extensions.zotero.dataDir", "${dataDir}");`,
      `user_pref("extensions.zotero.api.url", "${normalizedEndpoint}");`,
      'user_pref("extensions.zotero.sync.server.username", "phpunit");',
      'user_pref("extensions.zotero.sync.autoSync", false);',
      'user_pref("extensions.zotero.sync.storage.enabled", true);',
      'user_pref("extensions.zotero.sync.storage.protocol", "zfs");',
      'user_pref("extensions.zotero.sync.storage.downloadMode.personal", "on-sync");',
      'user_pref("extensions.zotero.firstRun2", false);',
      'user_pref("extensions.zotero.httpServer.enabled", false);',
      'user_pref("devtools.chrome.enabled", true);',
      'user_pref("devtools.debugger.remote-enabled", true);',
      "",
    ].join("\n")
  );
}

async function writeDesktopSmokeScript() {
  await writeFile(scriptPath, desktopSmokeBody(), { mode: 0o600 });
}

async function setupRemoteTestUser() {
  const credentials = Buffer.from(`${rootUsername}:${rootPassword}`).toString(
    "base64"
  );
  const response = await fetch(`${baseURL}/test/setup?u=1&u2=2`, {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `test setup failed: ${response.status} ${await response.text()}`
    );
  }

  const body = (await response.json()) as {
    user1?: { apiKey?: string; userID?: number };
  };
  const apiKey = body.user1?.apiKey;
  if (!apiKey) {
    throw new Error("test setup response did not include user1.apiKey");
  }
  await writeFile(apiKeyPath, apiKey, { mode: 0o600 });
}

async function waitForZoteroProcess() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ps = await run("ps", ["aux"]);
    if (
      ps.stdout
        .split(/\r?\n/)
        .some((line) => line.includes(`zotero --profile ${profileDir}`))
    ) {
      return;
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for temp Zotero process");
}

async function openRunJavaScript() {
  await osascript(`
tell application "Zotero" to activate
tell application "System Events"
  tell process "Zotero"
    set frontmost to true
    repeat 60 times
      if exists menu bar item "Tools" of menu bar 1 then exit repeat
      delay 0.5
    end repeat
    if not (exists menu bar item "Tools" of menu bar 1) then error "Tools menu did not appear"
    click menu item "Run JavaScript" of menu 1 of menu item "Developer" of menu 1 of menu bar item "Tools" of menu bar 1
    repeat 60 times
      if exists window "Run JavaScript" then exit repeat
      delay 0.5
    end repeat
    if not (exists window "Run JavaScript") then error "Run JavaScript window did not appear"
  end tell
end tell
`);
}

async function runLoaderInZotero() {
  // Avoid depending on Zotero's "Run as async function" checkbox state.
  const loader = [
    "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
    `const smokeScriptPath = ${JSON.stringify(scriptPath)};`,
    `const smokeResultPath = ${JSON.stringify(resultPath)};`,
    "Zotero.File.getContentsAsync(smokeScriptPath)",
    "  .then((code) => (new AsyncFunction(code))())",
    "  .catch((e) => Zotero.File.putContentsAsync(smokeResultPath, JSON.stringify({",
    "    ok: false,",
    "    message: e && e.message ? e.message : String(e),",
    "    name: e && e.name ? e.name : null,",
    "    stack: e && e.stack ? String(e.stack) : null",
    "  }, null, 2)));",
    '"zotero-selfhost desktop smoke started";',
  ].join("\n");

  await run("pbcopy", [], { input: loader });
  await osascript(`
tell application "System Events"
  tell process "Zotero"
    set frontmost to true
    keystroke "a" using command down
    keystroke "v" using command down
    keystroke "r" using command down
  end tell
end tell
`);
}

async function waitForSmokeResult(): Promise<SmokeResult> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (existsSync(resultPath)) {
      const result = JSON.parse(await readFile(resultPath, "utf8")) as
        | SmokeResult
        | { message?: string; ok: false; stack?: string };
      if (!result.ok) {
        throw new Error(
          `Zotero desktop smoke failed: ${result.message}\n${result.stack ?? ""}`
        );
      }
      return result;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${resultPath}`);
}

async function verifyRemote(smoke: SmokeResult) {
  const apiKey = (await readFile(apiKeyPath, "utf8")).trim();
  const [item, trash, file, fulltext] = await Promise.all([
    apiRequest(
      `/users/1/items/${smoke.itemKey}?format=json&include=data`,
      apiKey
    ),
    apiRequest("/users/1/items/trash?format=json&include=data", apiKey),
    apiRequest(`/users/1/items/${smoke.attachmentKey}/file/view`, apiKey),
    apiRequest("/users/1/fulltext", apiKey),
  ]);

  const trashBody = Array.isArray(trash.body) ? trash.body : [];
  const trashedNote = trashBody.find(
    (entry) => entry?.key === smoke.noteKey && entry?.data?.deleted
  );

  const remote = {
    attachmentContentType: file.contentType,
    attachmentLooksZipped: file.text.startsWith("PK"),
    fulltextBody: fulltext.body,
    fulltextStatus: fulltext.status,
    itemStatus: item.status,
    itemTitle: item.body?.data?.title,
    noteInTrash: Boolean(trashedNote),
    trashStatus: trash.status,
  };

  if (remote.itemTitle !== smoke.title) {
    throw new Error(`Remote item title mismatch: ${remote.itemTitle}`);
  }
  if (!remote.noteInTrash) {
    throw new Error("Remote trash did not include the smoked note");
  }
  if (!(file.status === 200 && remote.attachmentLooksZipped)) {
    throw new Error(`Remote attachment verification failed: ${file.status}`);
  }

  return remote;
}

async function apiRequest(path: string, apiKey: string) {
  const response = await fetch(`${baseURL}${path}`, {
    headers: {
      "Zotero-API-Key": apiKey,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Leave non-JSON bodies as text.
  }

  return {
    body,
    contentType: response.headers.get("content-type"),
    status: response.status,
    text,
  };
}

function desktopSmokeBody(): string {
  return String.raw`
const resultPath = ${JSON.stringify(resultPath)};
const sourcePath = ${JSON.stringify(sourcePath)};

async function writeResult(payload) {
  await Zotero.File.putContentsAsync(resultPath, JSON.stringify(payload, null, 2));
}

try {
  const startedAt = new Date().toISOString();
  const apiKey = (await Zotero.File.getContentsAsync(${JSON.stringify(apiKeyPath)})).trim();

  Zotero.Prefs.set("sync.server.username", "phpunit");
  Zotero.Prefs.set("sync.storage.enabled", true);
  Zotero.Prefs.set("sync.storage.protocol", "zfs");
  Zotero.Prefs.set("sync.storage.downloadMode.personal", "on-sync");
  Zotero.Prefs.set("sync.autoSync", false);
  await Zotero.Users.setCurrentUserID(1);
  await Zotero.Users.setCurrentUsername("phpunit");
  await Zotero.Users.setName(1, "Real Name");
  await Zotero.Sync.Data.Local.setAPIKey(apiKey);

  await Zotero.File.putContentsAsync(
    sourcePath,
    "Real Zotero desktop smoke attachment " + startedAt + "\n"
  );

  const book = new Zotero.Item("book");
  book.libraryID = Zotero.Libraries.userLibraryID;
  book.setField("title", "Real Zotero desktop smoke " + startedAt);
  book.setField("publisher", "zotero-selfhost");
  book.setField("date", "2026");
  await book.saveTx();

  const note = new Zotero.Item("note");
  note.libraryID = Zotero.Libraries.userLibraryID;
  note.parentID = book.id;
  note.setNote("<p>Real Zotero desktop smoke note " + startedAt + "</p>");
  await note.saveTx();

  const attachment = await Zotero.Attachments.importFromFile({
    file: sourcePath,
    libraryID: Zotero.Libraries.userLibraryID,
    parentItemID: book.id
  });

  await Zotero.Sync.Runner.sync({
    background: false,
    firstInSession: true,
    stopOnError: true,
    onError: (e) => {
      throw e;
    }
  });

  const editedTitle = "Real Zotero desktop smoke " + startedAt + " edited";
  book.setField("title", editedTitle);
  await book.saveTx();
  note.deleted = true;
  await note.saveTx();

  await Zotero.Sync.Runner.sync({
    background: false,
    firstInSession: false,
    stopOnError: true,
    onError: (e) => {
      throw e;
    }
  });

  await writeResult({
    ok: true,
    startedAt,
    endpoint: Zotero.Prefs.get("api.url"),
    userID: Zotero.Users.getCurrentUserID(),
    username: Zotero.Users.getCurrentUsername(),
    libraryVersion: Zotero.Libraries.get(Zotero.Libraries.userLibraryID).libraryVersion,
    storageVersion: Zotero.Libraries.get(Zotero.Libraries.userLibraryID).storageVersion,
    itemKey: book.key,
    noteKey: note.key,
    attachmentKey: attachment.key,
    title: editedTitle,
    noteDeletedLocally: note.deleted,
    attachmentFilename: attachment.attachmentFilename
  });
  return "zotero-selfhost desktop smoke passed";
} catch (e) {
  await writeResult({
    ok: false,
    message: e && e.message ? e.message : String(e),
    name: e && e.name ? e.name : null,
    stack: e && e.stack ? String(e.stack) : null
  });
  throw e;
}
`;
}

function getArgValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
}

async function osascript(script: string) {
  await run("osascript", [], { input: script });
}

function run(command: string, commandArgs: string[], options: RunOptions = {}) {
  return new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ stderr, stdout });
        return;
      }
      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} exited with ${code}\n${stdout}\n${stderr}`
        )
      );
    });

    if (options.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.input);
    }
  });
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
