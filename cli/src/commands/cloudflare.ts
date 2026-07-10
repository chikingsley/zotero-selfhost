import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadDeployment, saveDeployment } from "../internal/deployment.ts";
import {
  assertNodeVersion,
  type CLIOptions,
  isRecord,
  readOption,
  readOptionalURL,
  readSecret,
} from "../internal/options.ts";
import { resolvePackageRoot } from "../internal/package-root.ts";

const packageRoot = resolvePackageRoot(import.meta.url);
const require = createRequire(import.meta.url);
const wranglerBin = join(
  dirname(require.resolve("wrangler/package.json")),
  "bin",
  "wrangler.js"
);
const defaultWorkerName = "zotero-selfhost";
const defaultDatabaseName = "zotero-selfhost-db";
const defaultBucketName = "zotero-selfhost-attachments";

interface WranglerRunOptions {
  allowFailure?: boolean;
  input?: string;
  interactive?: boolean;
  options?: CLIOptions;
  quiet?: boolean;
}

export const runSetupCommand = async (options: CLIOptions): Promise<void> => {
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

export const runRecoverCommand = async (options: CLIOptions): Promise<void> => {
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

const optionalFlag = (options, name) => {
  const value = options[name];
  return typeof value === "string" ? [`--${name}`, value] : [];
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
