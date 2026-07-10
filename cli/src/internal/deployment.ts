import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./options.ts";

interface SavedDeployment {
  serverURL: string;
  workerName?: string;
}

const deploymentPath = (): string =>
  join(homedir(), ".config", "zotero-selfhost", "deployment.json");

export const saveDeployment = (deployment: SavedDeployment): void => {
  const path = deploymentPath();
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
};

export const loadDeployment = (): SavedDeployment | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(deploymentPath(), "utf8"));
    return isRecord(value) && typeof value.serverURL === "string"
      ? {
          serverURL: value.serverURL,
          workerName:
            typeof value.workerName === "string" ? value.workerName : undefined,
        }
      : null;
  } catch {
    return null;
  }
};
