import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const outputDirectory = join(packageRoot, "cli");
const outputFile = join(outputDirectory, "zotero-selfhost.mjs");

await rm(outputDirectory, { force: true, recursive: true });

if (process.argv.includes("--clean")) {
  process.exit(0);
}

await mkdir(outputDirectory, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(packageRoot, "cli-src", "zotero-selfhost.ts")],
  format: "esm",
  minify: false,
  naming: "zotero-selfhost.mjs",
  outdir: outputDirectory,
  sourcemap: "none",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("Could not build the Zotero Self-Host CLI.");
}

await chmod(outputFile, 0o755);
