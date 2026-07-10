import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface RunnerArgs {
  configPath: string;
  passthrough: string[];
  target: string;
}

interface RunnerConfig extends Record<string, unknown> {
  cloudflareR2FromApiToken?: boolean;
  fullTextStateAPI?: boolean;
  s3Bucket?: string;
}

interface OracleLock {
  commit: string;
  repository: string;
  schema: { sha256: string };
}

const repoRoot = resolve(import.meta.dir, "..");
const remoteTestsDir = join(repoRoot, "references/dataserver/tests/remote");
const oracleLockPath = join(repoRoot, "compatibility/oracle.lock.json");
const schemaPath = join(
  repoRoot,
  "references/dataserver/htdocs/zotero-schema/schema.json"
);
const fullTextStateRegisterPath = join(
  repoRoot,
  "compatibility/fulltext-state-register.mjs"
);

const assertOracleReady = () => {
  if (!existsSync(join(remoteTestsDir, "run_tests"))) {
    throw new Error(
      "The pinned Zotero oracle is not installed. Run `bun run compat:setup`."
    );
  }

  const lock = JSON.parse(readFileSync(oracleLockPath, "utf8")) as OracleLock;
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: resolve(remoteTestsDir, "../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  const checkoutCommit = new TextDecoder().decode(git.stdout).trim();
  if (git.exitCode !== 0 || checkoutCommit !== lock.commit) {
    throw new Error(
      `Zotero oracle checkout mismatch: expected ${lock.commit}, found ${checkoutCommit || "unreadable"}. Run \`bun run compat:setup\`.`
    );
  }

  const origin = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: resolve(remoteTestsDir, "../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  const checkoutOrigin = new TextDecoder().decode(origin.stdout).trim();
  if (origin.exitCode !== 0 || checkoutOrigin !== lock.repository) {
    throw new Error(
      `Zotero oracle origin mismatch: expected ${lock.repository}, found ${checkoutOrigin || "unreadable"}. Run \`bun run compat:setup\`.`
    );
  }

  if (!existsSync(join(remoteTestsDir, "node_modules"))) {
    throw new Error(
      "Zotero oracle dependencies are missing. Run `bun run compat:setup`."
    );
  }
  if (!existsSync(schemaPath)) {
    throw new Error(
      "The pinned Zotero schema is missing. Run `bun run compat:setup`."
    );
  }
  const schemaDigest = createHash("sha256")
    .update(readFileSync(schemaPath))
    .digest("hex");
  if (schemaDigest !== lock.schema.sha256) {
    throw new Error(
      `Zotero schema mismatch: expected ${lock.schema.sha256}, found ${schemaDigest}. Run \`bun run compat:setup\`.`
    );
  }
};

const parseArgs = (args: string[]): RunnerArgs => {
  let target = "candidate";
  let configPath = "";
  const passthrough: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--target") {
      target = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--config") {
      configPath = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg === "--") {
      passthrough.push(...args.slice(index + 1));
      break;
    }

    passthrough.push(arg);
  }

  if (configPath) {
    configPath = resolve(configPath);
  } else {
    configPath = join(repoRoot, `compatibility/config/${target}.local.json`);
  }

  return { configPath, passthrough, target };
};

const loadConfig = (configPath: string): RunnerConfig => {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}\nCreate it from compatibility/config/${configPath.includes("reference") ? "reference" : "candidate"}.example.json`
    );
  }

  return JSON.parse(readFileSync(configPath, "utf8")) as RunnerConfig;
};

const withCloudflareR2Env = async (
  config: RunnerConfig,
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> => {
  if (!config.cloudflareR2FromApiToken) {
    return env;
  }

  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  if (!(token && accountId)) {
    throw new Error(
      "cloudflareR2FromApiToken requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID"
    );
  }

  const tokenId =
    env.CLOUDFLARE_API_TOKEN_ID ?? (await getCloudflareTokenId(token));
  const secretAccessKey = createHash("sha256").update(token).digest("hex");

  return {
    ...env,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? tokenId,
    AWS_ENDPOINT_URL:
      env.AWS_ENDPOINT_URL ?? `https://${accountId}.r2.cloudflarestorage.com`,
    AWS_REGION: env.AWS_REGION ?? "auto",
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? secretAccessKey,
  };
};

const getCloudflareTokenId = async (token: string): Promise<string> => {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const body = (await response.json()) as {
    success?: boolean;
    errors?: unknown[];
    result?: { id?: string };
  };

  if (!(response.ok && body.success && body.result?.id)) {
    throw new Error(
      `Unable to verify Cloudflare token for R2 S3 credentials: ${JSON.stringify(body.errors ?? [])}`
    );
  }

  return body.result.id;
};

const main = async () => {
  assertOracleReady();
  const { configPath, passthrough, target } = parseArgs(Bun.argv.slice(2));
  const config = loadConfig(configPath);
  const nodeConfig = JSON.stringify(config);
  const env = await withCloudflareR2Env(config, process.env);
  const nodeOptions = [
    env.NODE_OPTIONS,
    config.fullTextStateAPI
      ? `--import=${fullTextStateRegisterPath}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  console.log(`target=${target}`);
  console.log(`config=${configPath}`);
  console.log(`tests=${passthrough.length ? passthrough.join(" ") : "(all)"}`);

  const proc = Bun.spawn(["./run_tests", ...passthrough], {
    cwd: remoteTestsDir,
    env: {
      ...env,
      NODE_CONFIG: nodeConfig,
      NODE_OPTIONS: nodeOptions,
    },
    stderr: "inherit",
    stdout: "inherit",
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
};

await main();
