import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const importStateVersion = 1;

export const defaultImportStatePath = () =>
  join(homedir(), ".config", "zotero-selfhost", "import-state.json");

export const readImportState = (statePath = defaultImportStatePath()) => {
  try {
    return JSON.parse(readFileSync(resolve(statePath), "utf8"));
  } catch {
    return null;
  }
};

export const loadOrCreateImportState = (statePath, expected) => {
  const existing = readImportState(statePath);
  if (existing) {
    if (
      existing.version !== importStateVersion ||
      existing.source?.origin !== expected.source.origin ||
      existing.source?.userID !== expected.source.userID ||
      existing.target?.origin !== expected.target.origin ||
      existing.target?.userID !== expected.target.userID
    ) {
      throw new Error(
        `Import state at ${resolve(statePath)} belongs to another migration. Use --reset-state to replace it.`
      );
    }
    if (existing.source.libraryVersion !== expected.source.libraryVersion) {
      throw new Error(
        `The source library is now version ${expected.source.libraryVersion}, but the resumable state captured ${existing.source.libraryVersion}. Use --reset-state after reviewing the changed source.`
      );
    }
    return existing;
  }

  return {
    completed: {
      collections: [],
      files: [],
      fulltext: [],
      items: [],
      searches: [],
      settings: [],
    },
    createdAt: new Date().toISOString(),
    source: expected.source,
    target: expected.target,
    verifiedAt: null,
    version: importStateVersion,
  };
};

export const saveImportState = (statePath, state) => {
  const absolutePath = resolve(statePath);
  mkdirSync(dirname(absolutePath), { mode: 0o700, recursive: true });
  const temporaryPath = `${absolutePath}.tmp`;
  const descriptor = openSync(temporaryPath, "w", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, absolutePath);
  chmodSync(absolutePath, 0o600);
};

export const resetImportState = (statePath) => {
  rmSync(resolve(statePath), { force: true });
};
