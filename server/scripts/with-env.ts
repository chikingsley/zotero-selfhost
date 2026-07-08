import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(serverDir);

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error("Usage: bun scripts/with-env.ts <command> [...args]");
  process.exit(1);
}

const env = {
  ...readEnvFile(join(repoRoot, ".env")),
  ...readEnvFile(join(serverDir, ".dev.vars")),
  ...process.env,
};

const child = spawn(command, args, {
  cwd: serverDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const values: Record<string, string> = {};

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!(trimmed && !trimmed.startsWith("#"))) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");

    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();

    if (!key) {
      continue;
    }

    values[key] = unquote(value);
  }

  return values;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
