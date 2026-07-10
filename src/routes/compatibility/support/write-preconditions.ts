import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Bindings } from "../../../bindings";
import { isRecord } from "./values";

export const tagWriteFailureResponse = (
  c: Context<{ Bindings: Bindings }>,
  failed: Record<
    string,
    { code: number; data?: Record<string, unknown>; message: string }
  >,
  version: number
) =>
  c.json(
    {
      failed,
      success: [],
      successful: [],
    },
    200,
    {
      "Last-Modified-Version": `${version}`,
    }
  );

export interface ItemWriteFailure {
  code: number;
  data?: Record<string, unknown>;
  message: string;
}

export type ItemWriteFailures = Record<string, ItemWriteFailure>;

export const mergeItemWriteFailures = (
  target: ItemWriteFailures,
  source: ItemWriteFailures
) => {
  for (const [index, failure] of Object.entries(source)) {
    if (!(index in target)) {
      target[index] = failure;
    }
  }
};

export type ExistingObjectVersions = Map<
  string,
  { data: Record<string, unknown>; version: number }
>;

export interface BatchWritePreconditionResult {
  failed: ItemWriteFailures;
  libraryPreconditionFailed: boolean;
  toWrite: Array<{ index: number; object: Record<string, unknown> }>;
  unchanged: Record<string, string>;
}

type ParsedVersionProperty =
  | { kind: "missing" }
  | { kind: "invalid"; value: unknown }
  | { kind: "valid"; version: number };

export const parseJSONVersionProperty = (
  value: unknown
): ParsedVersionProperty => {
  if (value === undefined || value === null) {
    return { kind: "missing" };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { kind: "valid", version: value };
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return { kind: "valid", version: Number.parseInt(value, 10) };
  }
  return { kind: "invalid", value };
};

// Implements Zotero's version-precondition contract for batch writes:
// library-level `If-Unmodified-Since-Version`, per-object `version` property
// semantics (0 = must-not-exist, matching = update, stale = 412), and the
// unchanged/failed buckets. See the pinned dataserver version.test.js under
// compatibility/vendor/.
export const evaluateBatchWritePreconditions = (
  objects: Record<string, unknown>[],
  existing: ExistingObjectVersions,
  libraryVersion: number,
  ifUnmodifiedSinceVersion: number | null,
  objectTypeLabel: "Collection" | "Item" | "Search"
): BatchWritePreconditionResult => {
  if (
    ifUnmodifiedSinceVersion !== null &&
    ifUnmodifiedSinceVersion !== libraryVersion
  ) {
    return {
      failed: {},
      libraryPreconditionFailed: true,
      toWrite: [],
      unchanged: {},
    };
  }

  const headerProvided = ifUnmodifiedSinceVersion !== null;
  const failed: ItemWriteFailures = {};
  const unchanged: Record<string, string> = {};
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];

  const requireVersion = (index: number, key: string) => {
    failed[index] = {
      code: 428,
      message: `${objectTypeLabel} ${key} must be written with a version property or If-Unmodified-Since-Version header`,
    };
  };

  const matchesKnownCurrentVersion = (
    version: number,
    currentVersion: number
  ): boolean => {
    if (version === currentVersion) {
      return true;
    }

    // Zotero Desktop records successful batch uploads at a later synced
    // library version than some objects' official per-object versions. File
    // sync can then advance the library again. A later client upload can carry
    // any version in that known synced range while also providing the current
    // If-Unmodified-Since-Version header.
    return (
      headerProvided &&
      ifUnmodifiedSinceVersion === libraryVersion &&
      version >= currentVersion &&
      version <= libraryVersion &&
      currentVersion <= libraryVersion
    );
  };

  objects.forEach((object, index) => {
    const key = typeof object.key === "string" ? object.key : "";
    const current = key ? existing.get(key) : undefined;
    const parsedVersion = parseJSONVersionProperty(object.version);
    if (parsedVersion.kind === "invalid") {
      failed[index] = {
        code: 400,
        message: `Invalid JSON 'version' property value '${String(parsedVersion.value)}'`,
      };
      return;
    }
    const versionProp =
      parsedVersion.kind === "valid" ? parsedVersion.version : undefined;

    if (current) {
      if (versionProp === undefined) {
        if (headerProvided) {
          toWrite.push({ index, object });
        } else {
          requireVersion(index, key);
        }
      } else if (matchesKnownCurrentVersion(versionProp, current.version)) {
        toWrite.push({ index, object });
      } else {
        failed[index] = {
          code: 412,
          message: `${objectTypeLabel} has been modified since specified version (expected ${versionProp}, found ${current.version})`,
        };
      }
      return;
    }

    if (key) {
      if (versionProp === undefined) {
        if (headerProvided) {
          toWrite.push({ index, object });
        } else {
          requireVersion(index, key);
        }
      } else if (versionProp === 0) {
        toWrite.push({ index, object });
      } else {
        failed[index] = {
          code: 404,
          message: `${objectTypeLabel} doesn't exist (expected version ${versionProp}; use 0 instead)`,
        };
      }
      return;
    }

    toWrite.push({ index, object });
  });

  return { failed, libraryPreconditionFailed: false, toWrite, unchanged };
};

// Builds the Zotero batch write-report envelope, keyed by the original batch
// index, from the objects that were actually persisted plus the precondition
// buckets.
export const buildWriteReport = (
  written: Array<{ index: number; object: Record<string, unknown> }>,
  successful: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>,
  failed: ItemWriteFailures,
  unchanged: Record<string, string>
) => {
  const successfulByIndex: Record<string, unknown> = {};
  const successByIndex: Record<string, string> = {};
  successful.forEach((item, position) => {
    const originalIndex = written[position]?.index ?? position;
    successfulByIndex[originalIndex] = item;
    successByIndex[originalIndex] = item.key;
  });
  return {
    failed,
    success: successByIndex,
    successful: successfulByIndex,
    unchanged,
  };
};

export type SingleObjectWriteVersionCheck =
  | { editable: Record<string, unknown>; ok: true }
  | {
      code: ContentfulStatusCode;
      headers?: Record<string, string>;
      message: string;
      ok: false;
    };

// Port of the official dataserver's checkSingleObjectWriteVersion
// (ApiController.php): resolve the expected object version from the
// If-Unmodified-Since-Version header and/or the JSON 'version' property
// (envelope bodies carry their content in .data), then enforce the
// missing/existing × version matrix. A 412 on an existing object carries the
// object's current version in Last-Modified-Version; the 400s carry none.
export const checkSingleObjectWriteVersion = (
  c: Context<{ Bindings: Bindings }>,
  objectTypeLabel: "Collection" | "Item" | "Search",
  existingVersion: number | null,
  body: Record<string, unknown>,
  method: "PATCH" | "PUT"
): SingleObjectWriteVersionCheck => {
  const editable = isRecord(body.data)
    ? (body.data as Record<string, unknown>)
    : body;

  const headerRaw = c.req.header("If-Unmodified-Since-Version");
  let headerVersion: number | null = null;
  if (headerRaw !== undefined) {
    if (!/^\d+$/.test(headerRaw.trim())) {
      return {
        code: 400,
        message: `Invalid If-Unmodified-Since-Version value '${headerRaw}'`,
        ok: false,
      };
    }
    headerVersion = Number.parseInt(headerRaw, 10);
  }

  let propVersion: number | null = null;
  const parsedVersion = parseJSONVersionProperty(editable.version);
  if (parsedVersion.kind === "invalid") {
    return {
      code: 400,
      message: `Invalid JSON 'version' property value '${String(parsedVersion.value)}'`,
      ok: false,
    };
  }
  if (parsedVersion.kind === "valid") {
    if (parsedVersion.version < 0) {
      return {
        code: 400,
        message: `Invalid JSON 'version' property value '${String(editable.version)}'`,
        ok: false,
      };
    }
    propVersion = parsedVersion.version;
  }

  if (
    headerVersion !== null &&
    propVersion !== null &&
    headerVersion !== propVersion
  ) {
    return {
      code: 400,
      message: `If-Unmodified-Since-Version value does not match JSON 'version' property (${headerVersion} != ${propVersion})`,
      ok: false,
    };
  }

  const version = headerVersion ?? propVersion;

  if (existingVersion === null) {
    if (method === "PATCH" && version === null) {
      return {
        code: 404,
        message: `${objectTypeLabel} not found (to create, use If-Unmodified-Since-Version: 0, JSON 'version' 0, or PUT method)`,
        ok: false,
      };
    }
    if (version !== null && version > 0) {
      return {
        code: 412,
        message: `${objectTypeLabel} not found (expected version ${version})`,
        ok: false,
      };
    }
    return { editable, ok: true };
  }

  if (version === null) {
    return {
      code: 428,
      message:
        "Either If-Unmodified-Since-Version or object version property must be provided for key-based writes",
      ok: false,
    };
  }

  if (existingVersion > version) {
    return {
      code: 412,
      headers: { "Last-Modified-Version": `${existingVersion}` },
      message: `${objectTypeLabel} has been modified since specified version (expected ${version}, found ${existingVersion})`,
      ok: false,
    };
  }

  return { editable, ok: true };
};
