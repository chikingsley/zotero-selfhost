import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { normalizeOrigin, requireRecord, ZoteroAPIClient } from "./http.mjs";
import { defaultImportStatePath, readImportState } from "./importer.mjs";
import {
  assertZoteroStopped,
  defaultZoteroApp,
  runZoteroScript,
} from "./zotero-desktop.mjs";

export const runProfileMigration = async ({
  backupRoot,
  dataDir: explicitDataDir,
  execute = false,
  fetchImpl = globalThis.fetch,
  importStatePath = defaultImportStatePath(),
  log = console.log,
  profileDir: explicitProfileDir,
  profilesRoot,
  targetApiKey,
  targetURL,
  zoteroApp = defaultZoteroApp,
}) => {
  assertSecret(targetApiKey, "SELFHOST_API_KEY");
  const target = new ZoteroAPIClient({
    apiKey: targetApiKey,
    baseURL: targetURL,
    fetchImpl,
  });
  const keyResult = await target.json("/keys/current");
  const keyInfo = requireRecord(keyResult.body, "Self-host key check");
  if (!Number.isInteger(keyInfo.userID) || keyInfo.userID < 1) {
    throw new Error("The self-host key did not return a valid userID.");
  }
  const ownerCheck = await target.request(`/users/${keyInfo.userID}/keys`);
  if (ownerCheck.status !== 200) {
    throw new Error(
      "SELFHOST_API_KEY must be an owner key so profile migration can create a replaceable device key."
    );
  }

  const profile = discoverProfile({
    dataDir: explicitDataDir,
    profileDir: explicitProfileDir,
    profilesRoot,
  });
  const state = readImportState(importStatePath);
  const importVerified = Boolean(
    state?.verifiedAt &&
      state.target?.origin === target.baseURL.origin &&
      state.target?.userID === keyInfo.userID
  );
  const plan = {
    apiURL: target.baseURL.href,
    backupRoot: backupRoot ?? join(homedir(), "Zotero Self-Host Backups"),
    dataDir: profile.dataDir,
    importStatePath: resolve(importStatePath),
    importVerified,
    profileDir: profile.profileDir,
    sourceUserID: state?.source?.userID ?? null,
    streamingURL: streamingURL(target.baseURL),
    targetUserID: keyInfo.userID,
    targetUsername: keyInfo.username,
  };
  printPlan(plan, { execute, log });
  if (!execute) {
    return { executed: false, plan };
  }
  if (!importVerified) {
    throw new Error(
      "Profile migration requires a verified importer state for this target. Complete 'zotero-selfhost import --execute' first."
    );
  }

  await assertZoteroStopped();
  const backup = backupProfile({
    backupRoot: plan.backupRoot,
    dataDir: profile.dataDir,
    profileDir: profile.profileDir,
    profilesRoot: profile.profilesRoot,
  });
  const workspace = mkdtempSync(join(tmpdir(), "zotero-selfhost-profile-"));
  const apiKeyPath = join(workspace, "device-api-key");
  let deviceKey = null;

  try {
    deviceKey = await createDeviceKey(target, keyInfo.userID);
    writeFileSync(apiKeyPath, deviceKey.key, { mode: 0o600 });
    chmodSync(apiKeyPath, 0o600);
    const result = await runZoteroScript({
      body: profileMigrationScript({
        apiKeyPath,
        apiURL: plan.apiURL,
        displayName:
          typeof keyInfo.displayName === "string"
            ? keyInfo.displayName
            : keyInfo.username,
        expectedSourceUserID: plan.sourceUserID,
        streamingURL: plan.streamingURL,
        targetUserID: keyInfo.userID,
        username: keyInfo.username,
      }),
      profileDir: profile.profileDir,
      workspace,
      zoteroApp,
    });
    log("\nProfile migration and first full sync completed.");
    log(`Backup: ${backup.path}`);
    return {
      backup,
      deviceKeyLabel: deviceKey.name,
      executed: true,
      plan,
      result,
    };
  } catch (error) {
    if (deviceKey) {
      await target
        .request(`/users/${keyInfo.userID}/keys/${deviceKey.key}`, {
          method: "DELETE",
        })
        .catch(() => null);
    }
    throw new Error(
      `The profile migration did not complete. The pre-migration backup is at ${backup.path}. The original attachment directory was not modified by the CLI. ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

const createDeviceKey = async (client, userID) => {
  const { body } = await client.json(
    `/users/${userID}/keys`,
    {
      body: JSON.stringify({
        access: {
          groups: {},
          user: { files: true, library: true, notes: true, write: true },
        },
        name: `Migrated Zotero Desktop profile ${new Date().toISOString()}`,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    [201]
  );
  const key = requireRecord(body, "Device key creation");
  if (typeof key.key !== "string") {
    throw new Error("Device key creation did not return an API key.");
  }
  return key;
};

export const runProfileRollback = async ({
  backupPath,
  execute = false,
  log = console.log,
}) => {
  const absoluteBackupPath = resolve(backupPath);
  const manifest = readBackupManifest(absoluteBackupPath);
  const plan = {
    backupPath: absoluteBackupPath,
    dataDir: manifest.dataDir,
    profileDir: manifest.profileDir,
  };
  log("\nProfile rollback plan:");
  log(`  Backup: ${plan.backupPath}`);
  log(`  Profile: ${plan.profileDir}`);
  log(`  Database directory: ${plan.dataDir}`);
  if (!execute) {
    log("\nDry run only. Add --execute to restore this backup.");
    return { executed: false, plan };
  }

  await assertZoteroStopped();
  verifyBackup(absoluteBackupPath, manifest);
  const safetyPath = `${absoluteBackupPath}-pre-rollback-${timestamp()}`;
  mkdirSync(safetyPath, { mode: 0o700, recursive: true });
  if (existsSync(manifest.profileDir)) {
    cpSync(manifest.profileDir, join(safetyPath, "profile"), {
      recursive: true,
    });
  }
  const currentDatabaseFiles = listDatabaseFiles(manifest.dataDir);
  if (currentDatabaseFiles.length > 0) {
    mkdirSync(join(safetyPath, "data"), { recursive: true });
    for (const path of currentDatabaseFiles) {
      cpSync(path, join(safetyPath, "data", basename(path)));
    }
  }

  const displacedProfile = `${manifest.profileDir}.selfhost-displaced-${timestamp()}`;
  renameSync(manifest.profileDir, displacedProfile);
  try {
    cpSync(join(absoluteBackupPath, "profile"), manifest.profileDir, {
      recursive: true,
    });
    for (const path of listDatabaseFiles(manifest.dataDir)) {
      rmSync(path, { force: true });
    }
    for (const filename of manifest.databaseFiles) {
      cpSync(
        join(absoluteBackupPath, "data", filename),
        join(manifest.dataDir, filename)
      );
    }
    rmSync(displacedProfile, { force: true, recursive: true });
  } catch (error) {
    for (const path of listDatabaseFiles(manifest.dataDir)) {
      rmSync(path, { force: true });
    }
    const safetyDataPath = join(safetyPath, "data");
    if (existsSync(safetyDataPath)) {
      for (const filename of readdirSync(safetyDataPath)) {
        cpSync(
          join(safetyDataPath, filename),
          join(manifest.dataDir, filename)
        );
      }
    }
    rmSync(manifest.profileDir, { force: true, recursive: true });
    renameSync(displacedProfile, manifest.profileDir);
    throw error;
  }

  log("\nProfile rollback completed.");
  log(`Pre-rollback safety copy: ${safetyPath}`);
  return { executed: true, plan, safetyPath };
};

export const discoverProfile = ({
  dataDir: explicitDataDir,
  profileDir: explicitProfileDir,
  profilesRoot: explicitProfilesRoot,
} = {}) => {
  const profilesRoot = resolve(explicitProfilesRoot ?? defaultProfilesRoot());
  const profileDir = explicitProfileDir
    ? resolve(explicitProfileDir)
    : resolveDefaultProfile(profilesRoot);
  if (!existsSync(profileDir)) {
    throw new Error(`Zotero profile not found at ${profileDir}.`);
  }
  const dataDir = resolve(
    explicitDataDir ??
      readConfiguredDataDir(profileDir) ??
      join(homedir(), "Zotero")
  );
  if (!existsSync(join(dataDir, "zotero.sqlite"))) {
    throw new Error(
      `Zotero database not found at ${join(dataDir, "zotero.sqlite")}.`
    );
  }
  return { dataDir, profileDir, profilesRoot };
};

export const parseProfilesIni = (contents) => {
  const sections = [];
  let current = null;
  for (const originalLine of contents.split(/\r?\n/u)) {
    const line = originalLine.trim();
    if (!(line && !line.startsWith(";") && !line.startsWith("#"))) {
      continue;
    }
    const section = line.match(/^\[([^\n]+)\]$/u)?.[1];
    if (section) {
      current = { name: section, values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf("=");
    if (current && separator > 0) {
      current.values[line.slice(0, separator).trim()] = line
        .slice(separator + 1)
        .trim();
    }
  }
  return sections;
};

const resolveDefaultProfile = (profilesRoot) => {
  const iniPath = join(profilesRoot, "profiles.ini");
  if (!existsSync(iniPath)) {
    throw new Error(`Zotero profiles.ini not found at ${iniPath}.`);
  }
  const sections = parseProfilesIni(readFileSync(iniPath, "utf8"));
  const installDefault = sections.find((section) =>
    section.name.startsWith("Install")
  )?.values.Default;
  const profile = sections.find(
    (section) =>
      section.name.startsWith("Profile") &&
      (section.values.Default === "1" || section.values.Path === installDefault)
  );
  const path = profile?.values.Path ?? installDefault;
  if (!path) {
    throw new Error("No default Zotero profile is declared in profiles.ini.");
  }
  const isRelative = profile?.values.IsRelative !== "0";
  return isRelative && !isAbsolute(path) ? join(profilesRoot, path) : path;
};

const readConfiguredDataDir = (profileDir) => {
  const contents = ["prefs.js", "user.js"]
    .map((filename) => join(profileDir, filename))
    .filter(existsSync)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  let configured = null;
  const pattern =
    /user_pref\(\s*"extensions\.zotero\.dataDir"\s*,\s*("(?:\\.|[^"\\])*")\s*\);/gu;
  for (const match of contents.matchAll(pattern)) {
    try {
      configured = JSON.parse(match[1]);
    } catch {
      // Ignore malformed preference lines and use Zotero's default data path.
    }
  }
  return typeof configured === "string" && configured ? configured : null;
};

const backupProfile = ({ backupRoot, dataDir, profileDir, profilesRoot }) => {
  const path = join(resolve(backupRoot), `zotero-profile-${timestamp()}`);
  mkdirSync(path, { mode: 0o700, recursive: true });
  cpSync(profileDir, join(path, "profile"), { recursive: true });
  mkdirSync(join(path, "data"), { recursive: true });
  const databasePaths = listDatabaseFiles(dataDir);
  for (const databasePath of databasePaths) {
    cpSync(databasePath, join(path, "data", basename(databasePath)));
  }
  const profilesIni = join(profilesRoot, "profiles.ini");
  if (existsSync(profilesIni)) {
    cpSync(profilesIni, join(path, "profiles.ini"));
  }

  const files = listFiles(path).map((filePath) => ({
    path: filePath.slice(path.length + 1),
    sha256: hashFile(filePath),
    size: lstatSync(filePath).size,
  }));
  const manifest = {
    createdAt: new Date().toISOString(),
    databaseFiles: databasePaths.map(basename),
    dataDir,
    files,
    profileDir,
    profilesRoot,
    version: 1,
  };
  writeFileSync(
    join(path, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { manifest, path };
};

const readBackupManifest = (backupPath) => {
  const path = join(backupPath, "manifest.json");
  if (!existsSync(path)) {
    throw new Error(`Backup manifest not found at ${path}.`);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (
    manifest?.version !== 1 ||
    typeof manifest.profileDir !== "string" ||
    typeof manifest.dataDir !== "string" ||
    !Array.isArray(manifest.databaseFiles) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`Backup manifest at ${path} is invalid.`);
  }
  return manifest;
};

const verifyBackup = (backupPath, manifest) => {
  for (const file of manifest.files) {
    const path = join(backupPath, file.path);
    if (!(existsSync(path) && hashFile(path) === file.sha256)) {
      throw new Error(`Backup verification failed for ${file.path}.`);
    }
  }
};

const listDatabaseFiles = (dataDir) => {
  if (!existsSync(dataDir)) {
    return [];
  }
  return readdirSync(dataDir)
    .filter((filename) => filename.startsWith("zotero.sqlite"))
    .map((filename) => join(dataDir, filename))
    .filter((path) => lstatSync(path).isFile());
};

const listFiles = (root) => {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile() && entry.name !== "manifest.json") {
      files.push(path);
    }
  }
  return files;
};

const hashFile = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const defaultProfilesRoot = () => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Zotero");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Zotero");
  }
  return join(homedir(), ".zotero", "zotero");
};

const streamingURL = (apiURL) => {
  const url = normalizeOrigin(apiURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream";
  return url.href;
};

const printPlan = (plan, { execute, log }) => {
  log("\nZotero profile migration plan:");
  log(`  Profile:          ${plan.profileDir}`);
  log(`  Data directory:   ${plan.dataDir}`);
  log(`  API URL:          ${plan.apiURL}`);
  log(`  Streaming URL:    ${plan.streamingURL}`);
  log(`  Target identity:  ${plan.targetUsername} (${plan.targetUserID})`);
  if (plan.sourceUserID) {
    log(`  Imported identity: ${plan.sourceUserID}`);
  }
  log(`  Verified import:  ${plan.importVerified ? "yes" : "no"}`);
  log(`  Backup root:      ${plan.backupRoot}`);
  if (!execute) {
    log(
      "\nDry run only. Add --execute after the import is verified and Zotero is closed."
    );
  }
};

const profileMigrationScript = ({
  apiKeyPath,
  apiURL,
  displayName,
  expectedSourceUserID,
  streamingURL: streamURL,
  targetUserID,
  username,
}) => `
    if (Zotero.Sync.Runner.syncInProgress) {
      throw new Error("A Zotero sync is already in progress");
    }
    const apiKey = (await Zotero.File.getContentsAsync(${JSON.stringify(apiKeyPath)})).trim();
    const userLibraryID = Zotero.Libraries.userLibraryID;
    const library = Zotero.Libraries.get(userLibraryID);
    const previousUserID = Zotero.Users.getCurrentUserID();
    if (
      previousUserID &&
      ${JSON.stringify(expectedSourceUserID)} &&
      previousUserID !== ${JSON.stringify(expectedSourceUserID)} &&
      previousUserID !== ${targetUserID}
    ) {
      throw new Error(
        "This profile belongs to Zotero user " + previousUserID +
        ", but the verified import belongs to user " + ${JSON.stringify(expectedSourceUserID)}
      );
    }
    const previousAutoSync = Zotero.Prefs.get("sync.autoSync");
    const groups = Zotero.Groups.getAll();

    Zotero.Prefs.set("sync.autoSync", false);
    Zotero.Prefs.set("api.url", ${JSON.stringify(apiURL)});
    Zotero.Prefs.set("streaming.url", ${JSON.stringify(streamURL)});
    Zotero.Prefs.set("streaming.enabled", true);
    Zotero.Prefs.set("sync.storage.enabled", true);
    Zotero.Prefs.set("sync.storage.protocol", "zotero");
    Zotero.Prefs.set("sync.storage.downloadMode.personal", "on-sync");
    const skipped = new Set(JSON.parse(Zotero.Prefs.get("sync.librariesToSkip") || "[]"));
    for (const group of groups) {
      skipped.add("G" + group.id);
    }
    skipped.delete("L" + userLibraryID);
    Zotero.Prefs.set("sync.librariesToSkip", JSON.stringify([...skipped]));

    await Zotero.DB.executeTransaction(async () => {
      if (previousUserID && previousUserID !== ${targetUserID}) {
        await Zotero.Relations.updateUser(previousUserID, ${targetUserID});
        await Zotero.Notes.updateUser(previousUserID, ${targetUserID});
      }
      await Zotero.Users.setCurrentUserID(${targetUserID});
      await Zotero.Users.setCurrentUsername(${JSON.stringify(username)});
      await Zotero.Users.setCurrentName(${JSON.stringify(displayName)});
      library.libraryVersion = -1;
      library.storageVersion = -1;
      await library.save();
    });
    await Zotero.Sync.Data.Local.setAPIKey(apiKey);
    await Zotero.Sync.Runner.sync({
      background: false,
      fileLibraries: [userLibraryID],
      firstInSession: true,
      fullTextLibraries: [userLibraryID],
      libraries: [userLibraryID],
      stopOnError: true,
      onError: (error) => { throw error; }
    });
    Zotero.Prefs.set("sync.autoSync", previousAutoSync);
    return {
      apiURL: Zotero.Prefs.get("api.url"),
      groupLibrariesPreservedLocally: groups.length,
      libraryVersion: library.libraryVersion,
      storageVersion: library.storageVersion,
      streamingURL: Zotero.Prefs.get("streaming.url"),
      userID: Zotero.Users.getCurrentUserID(),
      username: Zotero.Users.getCurrentUsername()
    };
`;

const timestamp = () =>
  new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

const assertSecret = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must not be empty.`);
  }
};
