import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "./http.mjs";

export const defaultZoteroApp = "/Applications/Zotero.app";

export const assertZoteroStopped = async ({ exceptProfile } = {}) => {
  const processes = await run("ps", ["aux"]);
  const matches = processes.stdout
    .split(/\r?\n/u)
    .filter((line) => line.includes("/Zotero.app/Contents/MacOS/zotero"))
    .filter(
      (line) => !(exceptProfile && line.includes(`--profile ${exceptProfile}`))
    );
  if (matches.length > 0) {
    throw new Error(
      `Zotero must be fully closed before this operation. Running processes:\n${matches.join("\n")}`
    );
  }
};

export const writeDisposableProfile = async ({
  apiURL,
  dataDir,
  profileDir,
  streamingURL,
}) => {
  await mkdir(profileDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(profileDir, "user.js"),
    [
      'user_pref("extensions.zotero.useDataDir", true);',
      `user_pref("extensions.zotero.dataDir", ${JSON.stringify(dataDir)});`,
      `user_pref("extensions.zotero.api.url", ${JSON.stringify(apiURL)});`,
      `user_pref("extensions.zotero.streaming.url", ${JSON.stringify(streamingURL)});`,
      'user_pref("extensions.zotero.streaming.enabled", true);',
      'user_pref("extensions.zotero.sync.autoSync", false);',
      'user_pref("extensions.zotero.sync.storage.enabled", true);',
      'user_pref("extensions.zotero.sync.storage.protocol", "zotero");',
      'user_pref("extensions.zotero.sync.storage.downloadMode.personal", "on-sync");',
      'user_pref("extensions.zotero.firstRun2", false);',
      'user_pref("extensions.zotero.httpServer.enabled", false);',
      'user_pref("devtools.chrome.enabled", true);',
      'user_pref("devtools.debugger.remote-enabled", true);',
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
};

export const runZoteroScript = async ({
  body,
  keepOpen = false,
  profileDir,
  timeoutMilliseconds = 240_000,
  workspace,
  zoteroApp = defaultZoteroApp,
}) => {
  if (process.platform !== "darwin") {
    throw new Error(
      "Automated Zotero profile migration currently requires macOS."
    );
  }
  if (!existsSync(zoteroApp)) {
    throw new Error(`Zotero app not found at ${zoteroApp}.`);
  }
  await mkdir(workspace, { mode: 0o700, recursive: true });
  const scriptPath = join(workspace, "operation.js");
  const resultPath = join(workspace, "result.json");
  const debugOutputPath = join(workspace, "zotero-debug.log");
  const debugErrorPath = join(workspace, "zotero-debug-error.log");
  await rm(resultPath, { force: true });
  await writeFile(scriptPath, wrapScript(body, resultPath), { mode: 0o600 });
  await Promise.all([
    writeFile(debugOutputPath, "", { mode: 0o600 }),
    writeFile(debugErrorPath, "", { mode: 0o600 }),
  ]);

  const previousClipboard = await run("pbpaste", [], {
    allowFailure: true,
  }).then((result) => result.stdout);
  try {
    await killProfile(profileDir);
    await run("open", [
      "-n",
      "-a",
      zoteroApp,
      "-o",
      debugOutputPath,
      "--stderr",
      debugErrorPath,
      "--args",
      "-ZoteroDebugText",
      "--profile",
      profileDir,
      "--new-instance",
    ]);
    await waitForProfile(profileDir);
    await openRunJavaScript();
    await submitLoader({ resultPath, scriptPath });
    return await waitForResult(resultPath, timeoutMilliseconds);
  } finally {
    await run("pbcopy", [], { allowFailure: true, input: previousClipboard });
    if (!keepOpen) {
      await killProfile(profileDir);
    }
  }
};

export const killProfile = async (profileDir) => {
  await run("pkill", ["-f", "--", `--profile ${profileDir}`], {
    allowFailure: true,
  });
};

const waitForProfile = async (profileDir) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processes = await run("ps", ["aux"]);
    if (
      processes.stdout
        .split(/\r?\n/u)
        .some((line) => line.includes(`--profile ${profileDir}`))
    ) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Zotero profile ${profileDir}.`);
};

const openRunJavaScript = async () => {
  await osascript(`
tell application "Zotero" to activate
tell application "System Events"
  tell process "Zotero"
    set frontmost to true
    repeat 120 times
      if exists menu bar item "Tools" of menu bar 1 then exit repeat
      delay 0.5
    end repeat
    if not (exists menu bar item "Tools" of menu bar 1) then error "Tools menu did not appear"
    click menu item "Run JavaScript" of menu 1 of menu item "Developer" of menu 1 of menu bar item "Tools" of menu bar 1
    repeat 120 times
      if exists window "Run JavaScript" then exit repeat
      delay 0.5
    end repeat
    if not (exists window "Run JavaScript") then error "Run JavaScript window did not appear"
  end tell
end tell
`);
};

const submitLoader = async ({ resultPath, scriptPath }) => {
  const loader = [
    "const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;",
    `const operationScriptPath = ${JSON.stringify(scriptPath)};`,
    `const operationResultPath = ${JSON.stringify(resultPath)};`,
    "Zotero.File.getContentsAsync(operationScriptPath)",
    "  .then((code) => (new AsyncFunction(code))())",
    "  .catch((error) => Zotero.File.putContentsAsync(operationResultPath, JSON.stringify({",
    "    ok: false,",
    "    message: error && error.message ? error.message : String(error),",
    "    stack: error && error.stack ? String(error.stack) : null",
    "  }, null, 2)));",
    '"zotero-selfhost operation started";',
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
};

const waitForResult = async (resultPath, timeoutMilliseconds) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      if (!result.ok) {
        throw new Error(
          `Zotero operation failed: ${result.message ?? "Unknown error"}\n${result.stack ?? ""}`
        );
      }
      return result.value;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${resultPath}.`);
};

const wrapScript = (body, resultPath) => `
const resultPath = ${JSON.stringify(resultPath)};
const writeResult = (payload) => Zotero.File.putContentsAsync(
  resultPath,
  JSON.stringify(payload, null, 2)
);
try {
  const value = await (async () => {
${body}
  })();
  await writeResult({ ok: true, value });
} catch (error) {
  await writeResult({
    ok: false,
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? String(error.stack) : null
  });
  throw error;
}
`;

const osascript = async (script) => run("osascript", [], { input: script });

const run = (command, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
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
    child.on("close", (status) => {
      if (status === 0 || options.allowFailure) {
        resolve({ status: status ?? 1, stderr, stdout });
      } else {
        reject(
          new Error(
            `${command} ${arguments_.join(" ")} failed (${status}): ${stderr.trim()}`
          )
        );
      }
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
