#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTwoProfileAcceptance } from "./lib/acceptance.ts";
import { defaultImportStatePath, runImport } from "./lib/importer.ts";
import {
  runNativeConnect,
  runProfileMigration,
  runProfileRollback,
} from "./lib/profile.ts";

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const require = createRequire(import.meta.url);
const wranglerBin = join(
  dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js"
);
const defaultWorkerName = "zotero-selfhost";
const defaultDatabaseName = "zotero-selfhost-db";
const defaultBucketName = "zotero-selfhost-attachments";

type CLIOptions = Record<string, boolean | string>;

interface WranglerRunOptions {
  allowFailure?: boolean;
  input?: string;
  interactive?: boolean;
  options?: CLIOptions;
  quiet?: boolean;
}

const main = async () => {
  const [command = "help", ...rawArguments] = process.argv.slice(2);
  const options = parseArguments(rawArguments);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "setup") {
    await setup(options);
    return;
  }
  if (command === "recover") {
    await recover(options);
    return;
  }
  if (command === "import") {
    await importLibrary(options);
    return;
  }
  if (command === "connect") {
    await connect(options);
    return;
  }
  if (command === "profile") {
    await profile(options);
    return;
  }
  if (command === "acceptance") {
    await acceptance(options);
    return;
  }

  throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
};

const connect = async (options) => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Connect needs --url or a deployment saved by setup.");
  }
  await runNativeConnect({
    execute: options.execute === true,
    profileDir: readOptionalOption(options, "profile-dir"),
    profilesRoot: readOptionalOption(options, "profiles-root"),
    targetURL,
  });
};

const importLibrary = async (options) => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Import needs --url or a deployment saved by setup.");
  }
  await runImport({
    execute: options.execute === true,
    includeFiles: options["without-files"] !== true,
    includeFulltext: options["without-fulltext"] !== true,
    merge: options.merge === true,
    recoveryManifestPath: readOptionalOption(options, "recovery-manifest"),
    resetState: options["reset-state"] === true,
    sourceApiKey: readSecret({
      environmentName: "ZOTERO_IMPORT_API_KEY",
      fileOption: options["zotero-key-file"],
    }),
    sourceURL: readOption(options, "source-url", "https://api.zotero.org"),
    statePath: readOption(options, "state", defaultImportStatePath()),
    targetApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
  });
};

const profile = async (options) => {
  assertNodeVersion();
  if (typeof options.rollback === "string") {
    await runProfileRollback({
      backupPath: options.rollback,
      execute: options.execute === true,
    });
    return;
  }

  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error(
      "Profile migration needs --url or a deployment saved by setup."
    );
  }
  await runProfileMigration({
    backupRoot: readOptionalOption(options, "backup-root"),
    dataDir: readOptionalOption(options, "data-dir"),
    execute: options.execute === true,
    importStatePath: readOption(options, "state", defaultImportStatePath()),
    profileDir: readOptionalOption(options, "profile-dir"),
    profilesRoot: readOptionalOption(options, "profiles-root"),
    targetApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
    zoteroApp: readOptionalOption(options, "zotero-app"),
  });
};

const acceptance = async (options) => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Acceptance needs --url or a deployment saved by setup.");
  }
  await runTwoProfileAcceptance({
    execute: options.execute === true,
    keep: options.keep === true,
    ownerApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
    temporaryRoot: readOptionalOption(options, "temporary-root"),
    zoteroApp: readOptionalOption(options, "zotero-app"),
  });
};

const setup = async (options) => {
  assertNodeVersion();
  await ensureCloudflareAuth(options);

  const workerName = readOption(options, "worker", defaultWorkerName);
  let serverURL = readOptionalURL(options.url);
  const existing = options.existing === true;
  const r2Credentials = readR2Credentials(options);

  if (existing) {
    configureDirectR2UploadSecrets(
      workerName,
      readOption(options, "bucket", defaultBucketName),
      r2Credentials,
      options
    );
  } else {
    const deployment = deployCloudflareStack(
      options,
      workerName,
      r2Credentials
    );
    serverURL ??= deployment.serverURL;
  }
  if (!serverURL) {
    throw new Error(
      "Could not discover the workers.dev URL. Re-run with --url https://your-worker.example.com."
    );
  }

  const bootstrapToken = generateSecret();
  putSecret("BOOTSTRAP_TOKEN", bootstrapToken, workerName, options);
  try {
    const result = await requestEphemeralControl(
      new URL("/_selfhost/bootstrap", serverURL),
      {
        body: {
          displayName: readOption(options, "display-name", "Owner"),
          keyLabel: readOption(options, "key-label", "Initial owner key"),
          username: readOption(options, "username", "owner"),
        },
        token: bootstrapToken,
      }
    );
    if (result.status === 409) {
      throw new Error(
        "This installation is already bootstrapped. Use the recover command if every owner key was lost."
      );
    }
    const apiKey = isRecord(result.body) ? result.body.apiKey : null;
    if (result.status !== 201 || typeof apiKey !== "string") {
      throw new Error(formatHTTPError("Bootstrap failed", result));
    }

    saveDeployment({ serverURL, workerName });
    printSetupResult(serverURL, apiKey);
  } finally {
    deleteSecret("BOOTSTRAP_TOKEN", workerName, options);
  }
};

const recover = async (options) => {
  assertNodeVersion();
  await ensureCloudflareAuth(options);
  const saved = loadDeployment();
  const workerName = readOption(
    options,
    "worker",
    saved?.workerName ?? defaultWorkerName
  );
  const serverURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!serverURL) {
    throw new Error("Recovery needs --url or a deployment saved by setup.");
  }

  const recoveryToken = generateSecret();
  putSecret("RECOVERY_TOKEN", recoveryToken, workerName, options);
  try {
    const result = await requestEphemeralControl(
      new URL("/_selfhost/recovery/keys", serverURL),
      {
        body: {
          keyLabel: readOption(options, "key-label", "Recovered owner key"),
        },
        token: recoveryToken,
      }
    );
    const key =
      isRecord(result.body) && isRecord(result.body.key)
        ? result.body.key.key
        : null;
    if (result.status !== 201 || typeof key !== "string") {
      throw new Error(formatHTTPError("Recovery failed", result));
    }

    console.log(
      "\nA replacement owner key was created. Existing data was not reset.\n"
    );
    console.log(`Server:  ${serverURL}`);
    console.log(`API key: ${key}`);
    console.log(
      "\nStore this key in a password manager. It is not saved by the CLI."
    );
  } finally {
    deleteSecret("RECOVERY_TOKEN", workerName, options);
  }
};

const deployCloudflareStack = (options, workerName, r2Credentials) => {
  const databaseName = readOption(options, "database", defaultDatabaseName);
  const bucketName = readOption(options, "bucket", defaultBucketName);
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "zotero-selfhost-setup-")
  );
  const configPath = join(temporaryDirectory, "wrangler.json");
  const secretsPath = join(temporaryDirectory, "deploy-secrets.env");

  try {
    console.log(`\nPreparing D1 database '${databaseName}'...`);
    const databaseID = ensureD1Database(databaseName, options);
    console.log(`Preparing R2 bucket '${bucketName}'...`);
    ensureR2Bucket(bucketName, options);

    writeFileSync(
      configPath,
      `${JSON.stringify(
        createWranglerConfig({
          bucketName,
          databaseID,
          databaseName,
          workerName,
        }),
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    console.log("Applying D1 migrations...");
    runWrangler(
      ["d1", "migrations", "apply", "DB", "--remote", "--config", configPath],
      { options }
    );

    const fileURLSigningSecret = generateSecret();
    writeFileSync(
      secretsPath,
      [
        `FILE_URL_SIGNING_SECRET=${fileURLSigningSecret}`,
        `R2_ACCESS_KEY_ID=${r2Credentials.accessKeyId}`,
        `R2_ACCOUNT_ID=${r2Credentials.accountId}`,
        `R2_SECRET_ACCESS_KEY=${r2Credentials.secretAccessKey}`,
        "",
      ].join("\n"),
      { mode: 0o600 }
    );

    console.log(`Deploying Worker '${workerName}'...`);
    const deployment = runWrangler(
      ["deploy", "--config", configPath, "--secrets-file", secretsPath],
      { options }
    );
    const serverURL = findWorkersDevURL(
      `${deployment.stdout}\n${deployment.stderr}`
    );
    return { serverURL };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
};

const ensureD1Database = (databaseName, options) => {
  const listed = runWrangler(["d1", "list", "--json"], {
    options,
    quiet: true,
  });
  const databases = parseJSONOutput(listed.stdout, "D1 database list");
  if (Array.isArray(databases)) {
    const existing = databases.find(
      (database) => isRecord(database) && database.name === databaseName
    );
    if (existing && typeof existing.uuid === "string") {
      return existing.uuid;
    }
  }

  const location = optionalFlag(options, "location");
  const created = runWrangler(["d1", "create", databaseName, ...location], {
    options,
  });
  const databaseID = `${created.stdout}\n${created.stderr}`.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu
  )?.[0];
  if (!databaseID) {
    throw new Error(
      "D1 was created, but Wrangler did not return its database ID."
    );
  }
  return databaseID;
};

const ensureR2Bucket = (bucketName, options) => {
  const info = runWrangler(["r2", "bucket", "info", bucketName, "--json"], {
    allowFailure: true,
    options,
    quiet: true,
  });
  if (info.status === 0) {
    return;
  }

  const location = optionalFlag(options, "location");
  runWrangler(["r2", "bucket", "create", bucketName, ...location], {
    options,
  });
};

const createWranglerConfig = ({
  bucketName,
  databaseID,
  databaseName,
  workerName,
}) => ({
  compatibility_date: "2026-07-09",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    {
      binding: "DB",
      database_id: databaseID,
      database_name: databaseName,
      migrations_dir: join(packageRoot, "migrations"),
    },
  ],
  durable_objects: {
    bindings: [{ class_name: "ZoteroStreamHub", name: "STREAM_HUB" }],
  },
  main: join(packageRoot, "src", "index.ts"),
  migrations: [
    { new_sqlite_classes: ["ZoteroStreamHub"], tag: "v1-stream-hub" },
  ],
  name: workerName,
  observability: { enabled: true },
  r2_buckets: [{ binding: "ATTACHMENTS", bucket_name: bucketName }],
  secrets: {
    required: [
      "FILE_URL_SIGNING_SECRET",
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_SECRET_ACCESS_KEY",
    ],
  },
  vars: { DEPLOYMENT_MODE: "production", R2_BUCKET_NAME: bucketName },
});

const readR2Credentials = (options) => ({
  accessKeyId: readSecret({
    environmentName: "R2_ACCESS_KEY_ID",
    fileOption: options["r2-access-key-id-file"],
  }),
  accountId: readSecret({
    environmentName: "CLOUDFLARE_ACCOUNT_ID",
    fileOption: options["cloudflare-account-id-file"],
  }),
  secretAccessKey: readSecret({
    environmentName: "R2_SECRET_ACCESS_KEY",
    fileOption: options["r2-secret-access-key-file"],
  }),
});

const configureDirectR2UploadSecrets = (
  workerName,
  bucketName,
  credentials,
  options
) => {
  console.log("Configuring bucket-scoped direct R2 upload credentials...");
  putSecret("R2_ACCESS_KEY_ID", credentials.accessKeyId, workerName, options);
  putSecret("R2_ACCOUNT_ID", credentials.accountId, workerName, options);
  putSecret("R2_BUCKET_NAME", bucketName, workerName, options);
  putSecret(
    "R2_SECRET_ACCESS_KEY",
    credentials.secretAccessKey,
    workerName,
    options
  );
};

const ensureCloudflareAuth = async (options) => {
  const whoami = runWrangler(["whoami"], {
    allowFailure: true,
    options,
    quiet: true,
  });
  if (whoami.status === 0) {
    return;
  }

  console.log("Opening Cloudflare login...");
  runWrangler(["login"], { interactive: true, options });
};

const putSecret = (name, value, workerName, options) => {
  runWrangler(["secret", "put", name, "--name", workerName], {
    input: `${value}\n`,
    options,
  });
};

const deleteSecret = (name, workerName, options) => {
  const result = runWrangler(["secret", "delete", name, "--name", workerName], {
    allowFailure: true,
    input: "y\n",
    options,
    quiet: true,
  });
  if (result.status !== 0) {
    console.warn(
      `Warning: could not remove temporary secret ${name}. Remove it in the Cloudflare dashboard.`
    );
  }
};

const runWrangler = (
  arguments_: string[],
  {
    allowFailure = false,
    input,
    interactive = false,
    options = {},
    quiet = false,
  }: WranglerRunOptions = {}
) => {
  const profileArguments = options.profile
    ? ["--profile", String(options.profile)]
    : [];
  const result = spawnSync(
    process.execPath,
    [wranglerBin, "--cwd", packageRoot, ...arguments_, ...profileArguments],
    interactive
      ? { stdio: "inherit" }
      : {
          encoding: "utf8",
          input,
          maxBuffer: 16 * 1024 * 1024,
        }
  );

  if (!(interactive || quiet)) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }

  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) {
    throw new Error(
      `Wrangler command failed: wrangler ${arguments_.join(" ")}`
    );
  }
  return {
    status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
};

const requestJSON = async (
  url: URL,
  { body, token }: { body: unknown; token: string }
) => {
  let response: Response;
  try {
    response = await fetch(url, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  return { body: parsed, status: response.status };
};

const requestEphemeralControl = async (url, options) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await requestJSON(url, options);
    if (result.status !== 403 && result.status !== 404) {
      return result;
    }
    if (attempt === 9) {
      return result;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  throw new Error("Ephemeral control request exhausted its retry loop.");
};

const parseArguments = (arguments_) => {
  const options = {};
  const booleanOptions = new Set([
    "execute",
    "existing",
    "keep",
    "merge",
    "reset-state",
    "without-files",
    "without-fulltext",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected argument '${argument ?? ""}'`);
    }
    const key = argument.slice(2);
    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
};

const readOption = (options, key, fallback) => {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

const readOptionalOption = (options, key) => {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const readSecret = ({ environmentName, fileOption }) => {
  if (typeof fileOption === "string") {
    const value = readFileSync(resolve(fileOption), "utf8").trim();
    if (!value) {
      throw new Error(`${fileOption} is empty.`);
    }
    return value;
  }
  const value = process.env[environmentName]?.trim();
  if (!value) {
    throw new Error(
      `${environmentName} is required. Set it in the environment or use the corresponding --*-key-file option.`
    );
  }
  return value;
};

const optionalFlag = (options, name) => {
  const value = options[name];
  return typeof value === "string" ? [`--${name}`, value] : [];
};

const readOptionalURL = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("The server URL must use HTTPS.");
  }
  return url.origin;
};

const findWorkersDevURL = (output) =>
  output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/iu)?.[0] ?? null;

const parseJSONOutput = (value, label) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Wrangler returned invalid JSON for ${label}.`, {
      cause: error,
    });
  }
};

const generateSecret = () => randomBytes(32).toString("base64url");

const deploymentPath = () =>
  join(homedir(), ".config", "zotero-selfhost", "deployment.json");

const saveDeployment = (deployment) => {
  const path = deploymentPath();
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
};

const loadDeployment = () => {
  try {
    const value = JSON.parse(readFileSync(deploymentPath(), "utf8"));
    return isRecord(value) && typeof value.serverURL === "string"
      ? value
      : null;
  } catch {
    return null;
  }
};

const printSetupResult = (serverURL, apiKey) => {
  console.log("\nZotero Self-Host Server is deployed and bootstrapped.\n");
  console.log(`API URL:       ${serverURL}`);
  console.log(`Streaming URL: ${serverURL.replace(/^http/u, "ws")}/stream`);
  console.log(`Owner API key: ${apiKey}`);
  console.log(
    "\nStore the owner key as SELFHOST_API_KEY in a private environment file (mode 0600). It is not saved by the CLI."
  );
  console.log(
    "Then run 'zotero-selfhost connect --execute' with Zotero closed."
  );
  console.log("Run 'zotero-selfhost recover' if every owner key is lost.");
};

const formatHTTPError = (prefix, result) => {
  const detail = isRecord(result.body)
    ? (result.body.error ?? result.body.message)
    : null;
  return `${prefix} (HTTP ${result.status})${typeof detail === "string" ? `: ${detail}` : ""}`;
};

const assertNodeVersion = () => {
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 20) {
    throw new Error("zotero-selfhost requires Node.js 20 or newer.");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const printHelp = () => {
  console.log(`Zotero Self-Host Server

Deploy, migrate, and verify a Zotero-compatible server on Cloudflare.

Run with any package runner:
  npx zotero-selfhost-server setup
  bunx zotero-selfhost-server setup
  pnpx zotero-selfhost-server setup
  yarn dlx zotero-selfhost-server setup

Commands:
  setup                 Provision D1/R2/DO, deploy, and create the first owner key
  setup --existing      Bootstrap an existing Deploy-to-Cloudflare installation
  recover               Create a replacement owner key through Cloudflare auth
  connect               Configure native Zotero Desktop account linking without UI automation
  import                 Plan or execute a resumable Zotero.org personal-library import
  profile                Plan or execute a backed-up Zotero Desktop profile cutover
  profile --rollback     Plan or execute restoration of a profile backup
  acceptance             Run A -> B -> A sync through two disposable Desktop profiles

Common options:
  --url <https://...>   Worker or custom-domain URL
  --worker <name>       Worker name (default: zotero-selfhost)
  --key-label <label>   Name for the newly created owner key
  --profile <name>      Wrangler authentication profile
  --location <hint>     D1/R2 location hint (for example: wnam)

Direct R2 upload credentials:
  Create an Object Read & Write R2 token scoped only to the attachment bucket.
  Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY,
  or pass each value through its corresponding --*-file option.

Migration safety:
  Connect, import, and profile commands are dry-run by default; add --execute to write.
  Put the target owner key in SELFHOST_API_KEY or --api-key-file.
  Put the one-time Zotero.org key in ZOTERO_IMPORT_API_KEY or --zotero-key-file.
  Secrets passed through environment variables or files are never saved by the CLI.
`);
};

main().catch((error) => {
  console.error(
    `\nError: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
