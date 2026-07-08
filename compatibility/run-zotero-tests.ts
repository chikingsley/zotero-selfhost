import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface RunnerArgs {
  configPath: string;
  passthrough: string[];
  target: string;
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

const loadConfig = (configPath: string): string => {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing config file: ${configPath}\nCreate it from compatibility/config/${configPath.includes("reference") ? "reference" : "candidate"}.example.json`,
    );
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  return JSON.stringify(parsed);
};

const main = async () => {
  const { configPath, passthrough, target } = parseArgs(Bun.argv.slice(2));
  const nodeConfig = loadConfig(configPath);

  console.log(`target=${target}`);
  console.log(`config=${configPath}`);
  console.log(`tests=${passthrough.length ? passthrough.join(" ") : "(all)"}`);

  const proc = Bun.spawn(["./run_tests", ...passthrough], {
    cwd: remoteTestsDir,
    env: {
      ...process.env,
      NODE_CONFIG: nodeConfig,
    },
    stderr: "inherit",
    stdout: "inherit",
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
};

await main();
