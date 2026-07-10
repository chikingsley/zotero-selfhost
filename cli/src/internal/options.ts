import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type CLIOptions = Record<string, boolean | string>;

export const parseArguments = (arguments_: string[]): CLIOptions => {
  const options: CLIOptions = {};
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

export const readOption = (
  options: CLIOptions,
  key: string,
  fallback: string
): string => {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
};

export const readOptionalOption = (
  options: CLIOptions,
  key: string
): string | undefined => {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const readSecret = ({
  environmentName,
  fileOption,
}: {
  environmentName: string;
  fileOption: boolean | string | undefined;
}): string => {
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

export const readOptionalURL = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("The server URL must use HTTPS.");
  }
  return url.origin;
};

export const assertNodeVersion = (): void => {
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 20) {
    throw new Error("zotero-selfhost requires Node.js 20 or newer.");
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
