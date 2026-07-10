#!/usr/bin/env node

import { runTwoProfileAcceptance } from "./commands/acceptance.ts";
import { runAdminCommand } from "./commands/admin.ts";
import { runRecoverCommand, runSetupCommand } from "./commands/cloudflare.ts";
import {
  defaultImportStatePath,
  runImport,
} from "./commands/import-library.ts";
import {
  runNativeConnect,
  runProfileMigration,
  runProfileRollback,
} from "./commands/profile.ts";
import { printHelp } from "./help.ts";
import { loadDeployment } from "./internal/deployment.ts";
import {
  assertNodeVersion,
  type CLIOptions,
  parseArguments,
  readOption,
  readOptionalOption,
  readOptionalURL,
  readSecret,
} from "./internal/options.ts";

const main = async (): Promise<void> => {
  const [command = "help", ...commandArguments] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "admin") {
    const [adminCommand, ...rawArguments] = commandArguments;
    await runAdminCommand(adminCommand, parseArguments(rawArguments));
    return;
  }

  const options = parseArguments(commandArguments);
  const commands: Record<string, (value: CLIOptions) => Promise<void>> = {
    acceptance: runAcceptanceCommand,
    connect: runConnectCommand,
    import: runImportCommand,
    profile: runProfileCommand,
    recover: runRecoverCommand,
    setup: runSetupCommand,
  };
  const handler = commands[command];
  if (!handler) {
    throw new Error(`Unknown command '${command}'. Run with --help for usage.`);
  }
  await handler(options);
};

const runConnectCommand = async (options: CLIOptions): Promise<void> => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Connect needs --url or a deployment saved by setup.");
  }
  await runNativeConnect({
    execute: options.execute === true,
    profileDir: readOptionalOption(options, "profile-dir"),
    profilesRoot: readOptionalOption(options, "profiles-root"),
    targetURL,
  });
};

const runImportCommand = async (options: CLIOptions): Promise<void> => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Import needs --url or a deployment saved by setup.");
  }
  await runImport({
    execute: options.execute === true,
    includeFiles: options["without-files"] !== true,
    includeFulltext: options["without-fulltext"] !== true,
    merge: options.merge === true,
    recoveryManifestPath: readOptionalOption(options, "recovery-manifest"),
    resetState: options["reset-state"] === true,
    sourceApiKey: readSecret({
      environmentName: "ZOTERO_IMPORT_API_KEY",
      fileOption: options["zotero-key-file"],
    }),
    sourceURL: readOption(options, "source-url", "https://api.zotero.org"),
    statePath: readOption(options, "state", defaultImportStatePath()),
    targetApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
  });
};

const runProfileCommand = async (options: CLIOptions): Promise<void> => {
  assertNodeVersion();
  if (typeof options.rollback === "string") {
    await runProfileRollback({
      backupPath: options.rollback,
      execute: options.execute === true,
    });
    return;
  }

  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error(
      "Profile migration needs --url or a deployment saved by setup."
    );
  }
  await runProfileMigration({
    backupRoot: readOptionalOption(options, "backup-root"),
    dataDir: readOptionalOption(options, "data-dir"),
    execute: options.execute === true,
    importStatePath: readOption(options, "state", defaultImportStatePath()),
    profileDir: readOptionalOption(options, "profile-dir"),
    profilesRoot: readOptionalOption(options, "profiles-root"),
    targetApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
    zoteroApp: readOptionalOption(options, "zotero-app"),
  });
};

const runAcceptanceCommand = async (options: CLIOptions): Promise<void> => {
  assertNodeVersion();
  const saved = loadDeployment();
  const targetURL = readOptionalURL(options.url ?? saved?.serverURL);
  if (!targetURL) {
    throw new Error("Acceptance needs --url or a deployment saved by setup.");
  }
  await runTwoProfileAcceptance({
    execute: options.execute === true,
    keep: options.keep === true,
    ownerApiKey: readSecret({
      environmentName: "SELFHOST_API_KEY",
      fileOption: options["api-key-file"],
    }),
    targetURL,
    temporaryRoot: readOptionalOption(options, "temporary-root"),
    zoteroApp: readOptionalOption(options, "zotero-app"),
  });
};

main().catch((error) => {
  console.error(
    `\nError: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
