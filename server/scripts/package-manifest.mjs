import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, "package.json");
const backupPath = join(packageRoot, ".package.json.prepack");
const phase = process.argv[2];

if (phase === "prepack") {
  if (existsSync(backupPath)) {
    renameSync(backupPath, manifestPath);
  }

  const original = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(original);
  writeFileSync(backupPath, original, { mode: 0o600 });

  // Bun's patch declaration belongs to this source checkout. The published
  // package bundles the already patched dependency, so exposing the local
  // patch path would make bunx try to reapply a file outside the install root.
  delete manifest.patchedDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(manifestPath, 0o644);
} else if (phase === "postpack") {
  if (!existsSync(backupPath)) {
    throw new Error("Cannot restore package.json: prepack backup is missing");
  }
  renameSync(backupPath, manifestPath);
  chmodSync(manifestPath, 0o644);
} else {
  throw new Error(`Unknown package-manifest phase '${phase ?? ""}'`);
}
