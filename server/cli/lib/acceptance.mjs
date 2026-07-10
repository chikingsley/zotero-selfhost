import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOrigin, requireRecord, ZoteroAPIClient } from "./http.mjs";
import {
  assertZoteroStopped,
  defaultZoteroApp,
  runZoteroScript,
  writeDisposableProfile,
} from "./zotero-desktop.mjs";

export const runTwoProfileAcceptance = async ({
  execute = false,
  fetchImpl = globalThis.fetch,
  keep = false,
  log = console.log,
  ownerApiKey,
  targetURL,
  temporaryRoot,
  zoteroApp = defaultZoteroApp,
}) => {
  assertSecret(ownerApiKey, "SELFHOST_API_KEY");
  const target = new ZoteroAPIClient({
    apiKey: ownerApiKey,
    baseURL: targetURL,
    fetchImpl,
  });
  const keyResult = await target.json("/keys/current");
  const owner = requireRecord(keyResult.body, "Owner key check");
  if (!Number.isInteger(owner.userID) || owner.userID < 1) {
    throw new Error("The owner key did not return a valid userID.");
  }
  const ownerCheck = await target.request(`/users/${owner.userID}/keys`);
  if (ownerCheck.status !== 200) {
    throw new Error("SELFHOST_API_KEY must be an owner key.");
  }

  const plan = {
    apiURL: target.baseURL.href,
    profilePasses: ["A uploads", "B downloads and edits", "A downloads edit"],
    streamingURL: streamingURL(target.baseURL),
    userID: owner.userID,
    username: owner.username,
  };
  log("\nTwo-profile Zotero Desktop acceptance plan:");
  log(`  API URL:       ${plan.apiURL}`);
  log(`  Streaming URL: ${plan.streamingURL}`);
  log(`  Identity:      ${plan.username} (${plan.userID})`);
  log("  Passes:        A upload -> B download/edit -> A convergence");
  if (!execute) {
    log(
      "\nDry run only. Add --execute with Zotero closed to run disposable profiles."
    );
    return { executed: false, plan };
  }

  await assertZoteroStopped();
  const root = temporaryRoot
    ? join(temporaryRoot, `zotero-two-profile-${Date.now()}`)
    : mkdtempSync(join(tmpdir(), "zotero-selfhost-two-profile-"));
  mkdirSync(root, { mode: 0o700, recursive: true });
  const deviceKeys = [];
  let succeeded = false;
  try {
    const deviceA = await createDeviceKey(
      target,
      owner.userID,
      "Acceptance profile A"
    );
    deviceKeys.push(deviceA.key);
    const deviceB = await createDeviceKey(
      target,
      owner.userID,
      "Acceptance profile B"
    );
    deviceKeys.push(deviceB.key);
    const paths = await prepareProfiles({
      apiURL: plan.apiURL,
      deviceA,
      deviceB,
      root,
      streamingURL: plan.streamingURL,
    });
    const marker = `zotero-selfhost-${Date.now()}`;
    writeFileSync(paths.sourceFile, `Two-profile attachment ${marker}\n`, {
      mode: 0o600,
    });

    const passA = await runZoteroScript({
      body: createPassAScript({
        apiKeyPath: paths.keyA,
        marker,
        sourceFile: paths.sourceFile,
        userID: owner.userID,
        username: owner.username,
      }),
      profileDir: paths.profileA,
      workspace: paths.workspaceA1,
      zoteroApp,
    });
    const passB = await runZoteroScript({
      body: createPassBScript({
        apiKeyPath: paths.keyB,
        itemKey: passA.itemKey,
        marker,
        userID: owner.userID,
        username: owner.username,
      }),
      profileDir: paths.profileB,
      workspace: paths.workspaceB,
      zoteroApp,
    });
    const passA2 = await runZoteroScript({
      body: createPassA2Script({
        apiKeyPath: paths.keyA,
        expectedTitle: passB.title,
        itemKey: passA.itemKey,
        marker,
        userID: owner.userID,
        username: owner.username,
      }),
      profileDir: paths.profileA,
      workspace: paths.workspaceA2,
      zoteroApp,
    });
    const cleanup = await target.request(
      `/users/${owner.userID}/items/${passA.itemKey}`,
      {
        headers: {
          "If-Unmodified-Since-Version": String(passA2.libraryVersion),
        },
        method: "DELETE",
      }
    );
    if (cleanup.status !== 204) {
      throw new Error(
        `Acceptance item cleanup failed (HTTP ${cleanup.status}): ${await cleanup.text()}`
      );
    }
    succeeded = true;
    log("\nTwo disposable Zotero profiles converged successfully.");
    return {
      executed: true,
      itemKey: passA.itemKey,
      passes: { aUpload: passA, aVerify: passA2, bEdit: passB },
      plan,
      temporaryRoot: keep ? root : null,
    };
  } catch (error) {
    throw new Error(
      `Two-profile acceptance failed. Disposable evidence is retained at ${root}. ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  } finally {
    await Promise.allSettled(
      deviceKeys.map((key) =>
        target.request(`/users/${owner.userID}/keys/${key}`, {
          method: "DELETE",
        })
      )
    );
    if (succeeded && !keep) {
      rmSync(root, { force: true, recursive: true });
    }
  }
};

const createDeviceKey = async (client, userID, name) => {
  const { body } = await client.json(
    `/users/${userID}/keys`,
    {
      body: JSON.stringify({
        access: {
          groups: {},
          user: { files: true, library: true, notes: true, write: true },
        },
        name,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    [201]
  );
  const key = requireRecord(body, `${name} key creation`);
  if (typeof key.key !== "string") {
    throw new Error(`${name} key creation did not return a key.`);
  }
  return key;
};

const prepareProfiles = async ({
  apiURL,
  deviceA,
  deviceB,
  root,
  streamingURL: streamURL,
}) => {
  const paths = {
    dataA: join(root, "data-a"),
    dataB: join(root, "data-b"),
    keyA: join(root, "key-a"),
    keyB: join(root, "key-b"),
    profileA: join(root, "profile-a"),
    profileB: join(root, "profile-b"),
    sourceFile: join(root, "source.txt"),
    workspaceA1: join(root, "run-a-upload"),
    workspaceA2: join(root, "run-a-verify"),
    workspaceB: join(root, "run-b-edit"),
  };
  await Promise.all([
    writeDisposableProfile({
      apiURL,
      dataDir: paths.dataA,
      profileDir: paths.profileA,
      streamingURL: streamURL,
    }),
    writeDisposableProfile({
      apiURL,
      dataDir: paths.dataB,
      profileDir: paths.profileB,
      streamingURL: streamURL,
    }),
  ]);
  writeFileSync(paths.keyA, deviceA.key, { mode: 0o600 });
  writeFileSync(paths.keyB, deviceB.key, { mode: 0o600 });
  return paths;
};

const createPassAScript = ({
  apiKeyPath,
  marker,
  sourceFile,
  userID,
  username,
}) => `
    await configure(${JSON.stringify(apiKeyPath)}, ${userID}, ${JSON.stringify(username)});
    const book = new Zotero.Item("book");
    book.libraryID = Zotero.Libraries.userLibraryID;
    book.setField("title", ${JSON.stringify(`Two-profile acceptance ${marker}`)});
    book.setField("publisher", "zotero-selfhost");
    await book.saveTx();
    const attachment = await Zotero.Attachments.importFromFile({
      file: ${JSON.stringify(sourceFile)},
      libraryID: Zotero.Libraries.userLibraryID,
      parentItemID: book.id
    });
    await syncUserLibrary(true);
    return {
      attachmentKey: attachment.key,
      itemKey: book.key,
      libraryVersion: Zotero.Libraries.userLibrary.libraryVersion,
      title: book.getField("title")
    };

    async function configure(path, id, name) {
      const key = (await Zotero.File.getContentsAsync(path)).trim();
      await Zotero.Users.setCurrentUserID(id);
      await Zotero.Users.setCurrentUsername(name);
      await Zotero.Users.setCurrentName(name);
      await Zotero.Sync.Data.Local.setAPIKey(key);
    }
    async function syncUserLibrary(firstInSession) {
      const libraryID = Zotero.Libraries.userLibraryID;
      await Zotero.Sync.Runner.sync({
        background: false,
        fileLibraries: [libraryID],
        firstInSession,
        fullTextLibraries: [libraryID],
        libraries: [libraryID],
        stopOnError: true,
        onError: (error) => { throw error; }
      });
    }
`;

const createPassBScript = ({
  apiKeyPath,
  itemKey,
  marker,
  userID,
  username,
}) => `
    await configure(${JSON.stringify(apiKeyPath)}, ${userID}, ${JSON.stringify(username)});
    await syncUserLibrary(true);
    const book = await Zotero.Items.getByLibraryAndKeyAsync(
      Zotero.Libraries.userLibraryID,
      ${JSON.stringify(itemKey)}
    );
    if (!book) throw new Error("Profile B did not download the item");
    const attachmentID = book.getAttachments()[0];
    const attachment = Zotero.Items.get(attachmentID);
    if (!attachment) throw new Error("Profile B did not download attachment metadata");
    const path = await attachment.getFilePathAsync();
    if (!path) throw new Error("Profile B did not download the attachment file");
    const contents = await Zotero.File.getContentsAsync(path);
    if (!contents.includes(${JSON.stringify(marker)})) {
      throw new Error("Profile B attachment content mismatch");
    }
    const title = ${JSON.stringify(`Two-profile acceptance ${marker} edited by B`)};
    book.setField("title", title);
    await book.saveTx();
    await syncUserLibrary(false);
    return {
      attachmentKey: attachment.key,
      itemKey: book.key,
      libraryVersion: Zotero.Libraries.userLibrary.libraryVersion,
      title
    };

    async function configure(path, id, name) {
      const key = (await Zotero.File.getContentsAsync(path)).trim();
      await Zotero.Users.setCurrentUserID(id);
      await Zotero.Users.setCurrentUsername(name);
      await Zotero.Users.setCurrentName(name);
      await Zotero.Sync.Data.Local.setAPIKey(key);
    }
    async function syncUserLibrary(firstInSession) {
      const libraryID = Zotero.Libraries.userLibraryID;
      await Zotero.Sync.Runner.sync({
        background: false,
        fileLibraries: [libraryID],
        firstInSession,
        fullTextLibraries: [libraryID],
        libraries: [libraryID],
        stopOnError: true,
        onError: (error) => { throw error; }
      });
    }
`;

const createPassA2Script = ({
  apiKeyPath,
  expectedTitle,
  itemKey,
  marker,
  userID,
  username,
}) => `
    await configure(${JSON.stringify(apiKeyPath)}, ${userID}, ${JSON.stringify(username)});
    await syncUserLibrary(true);
    const book = await Zotero.Items.getByLibraryAndKeyAsync(
      Zotero.Libraries.userLibraryID,
      ${JSON.stringify(itemKey)}
    );
    if (!book) throw new Error("Profile A lost the item");
    const title = book.getField("title");
    if (title !== ${JSON.stringify(expectedTitle)}) {
      throw new Error("Profile A did not receive Profile B's edit");
    }
    const attachment = Zotero.Items.get(book.getAttachments()[0]);
    const path = attachment && await attachment.getFilePathAsync();
    if (!path) throw new Error("Profile A attachment file is missing");
    const contents = await Zotero.File.getContentsAsync(path);
    if (!contents.includes(${JSON.stringify(marker)})) {
      throw new Error("Profile A attachment content changed unexpectedly");
    }
    return {
      attachmentKey: attachment.key,
      itemKey: book.key,
      libraryVersion: Zotero.Libraries.userLibrary.libraryVersion,
      title
    };

    async function configure(path, id, name) {
      const key = (await Zotero.File.getContentsAsync(path)).trim();
      await Zotero.Users.setCurrentUserID(id);
      await Zotero.Users.setCurrentUsername(name);
      await Zotero.Users.setCurrentName(name);
      await Zotero.Sync.Data.Local.setAPIKey(key);
    }
    async function syncUserLibrary(firstInSession) {
      const libraryID = Zotero.Libraries.userLibraryID;
      await Zotero.Sync.Runner.sync({
        background: false,
        fileLibraries: [libraryID],
        firstInSession,
        fullTextLibraries: [libraryID],
        libraries: [libraryID],
        stopOnError: true,
        onError: (error) => { throw error; }
      });
    }
`;

const streamingURL = (apiURL) => {
  const url = normalizeOrigin(apiURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/stream";
  return url.href;
};

const assertSecret = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required and must not be empty.`);
  }
};
