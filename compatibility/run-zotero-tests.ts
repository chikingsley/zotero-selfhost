import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

interface RunnerArgs {
  configPath: string;
  passthrough: string[];
  target: string;
}

interface RunnerConfig extends Record<string, unknown> {
  cloudflareR2FromApiToken?: boolean;
  s3Bucket?: string;
}

const repoRoot = resolve(import.meta.dir, "..");
const remoteTestsDir = join(repoRoot, "references/dataserver/tests/remote");

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

  if (!configPath) {
    configPath = join(repoRoot, `compatibility/config/${target}.local.json`);
  } else {
    configPath = resolve(configPath);
  }

  return { configPath, passthrough, target };
};

const loadConfig = (configPath: string): RunnerConfig => {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}\nCreate it from compatibility/config/${configPath.includes("reference") ? "reference" : "candidate"}.example.json`,
    );
  }

  return JSON.parse(readFileSync(configPath, "utf8")) as RunnerConfig;
};

const withCloudflareR2Env = async (
  config: RunnerConfig,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> => {
  if (!config.cloudflareR2FromApiToken) {
    return env;
  }

  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  if (!(token && accountId)) {
    throw new Error(
      "cloudflareR2FromApiToken requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID",
    );
  }

  const tokenId = env.CLOUDFLARE_API_TOKEN_ID ?? (await getCloudflareTokenId(token));
  const secretAccessKey = createHash("sha256").update(token).digest("hex");

  return {
    ...env,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? tokenId,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? secretAccessKey,
    AWS_ENDPOINT_URL:
      env.AWS_ENDPOINT_URL ?? `https://${accountId}.r2.cloudflarestorage.com`,
    AWS_REGION: env.AWS_REGION ?? "auto",
  };
};

const getCloudflareTokenId = async (token: string): Promise<string> => {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const body = (await response.json()) as {
    success?: boolean;
    errors?: unknown[];
    result?: { id?: string };
  };

  if (!(response.ok && body.success && body.result?.id)) {
    throw new Error(
      `Unable to verify Cloudflare token for R2 S3 credentials: ${JSON.stringify(body.errors ?? [])}`,
    );
  }

  return body.result.id;
};

const main = async () => {
  const { configPath, passthrough, target } = parseArgs(Bun.argv.slice(2));
  const config = loadConfig(configPath);
  const nodeConfig = JSON.stringify(config);
  const env = await withCloudflareR2Env(config, process.env);

  console.log(`target=${target}`);
  console.log(`config=${configPath}`);
  console.log(`tests=${passthrough.length ? passthrough.join(" ") : "(all)"}`);

  const proc = Bun.spawn(["./run_tests", ...passthrough], {
    cwd: remoteTestsDir,
    env: {
      ...env,
      NODE_CONFIG: nodeConfig,
    },
    stderr: "inherit",
    stdout: "inherit",
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
};

await main();
