import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const resolvePackageRoot = (moduleURL: string): string => {
  const moduleDirectory = dirname(fileURLToPath(moduleURL));
  const bundled =
    basename(moduleDirectory) === "cli" &&
    basename(dirname(moduleDirectory)) === "dist";
  return bundled
    ? resolve(moduleDirectory, "..", "..")
    : resolve(moduleDirectory, "..", "..", "..");
};
