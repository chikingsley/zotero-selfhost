import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Bindings } from "../../../bindings";
import { createCollectionStore } from "../../../domain/collections";
import { normalizeObjectDeletedForWrite } from "./write-helpers";
import { checkSingleObjectWriteVersion } from "./write-preconditions";

export const upsertCollectionInLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    collectionKey: string;
    libraryID: number;
    libraryType: "group" | "user";
    patchMode?: boolean;
  }
) => {
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid collection JSON", 400);
  }

  const collectionStore = createCollectionStore(c.env);
  const existing = await collectionStore.getCollection(
    input.libraryType,
    input.libraryID,
    input.collectionKey
  );

  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Collection",
    existing ? (existing.collection.version ?? 0) : null,
    body as Record<string, unknown>,
    input.patchMode ? "PATCH" : "PUT"
  );
  if (!versionCheck.ok) {
    return c.text(
      versionCheck.message,
      versionCheck.code,
      versionCheck.headers
    );
  }

  const collectionData = normalizeObjectDeletedForWrite(
    input.patchMode && existing
      ? { ...existing.collection.data, ...versionCheck.editable }
      : versionCheck.editable
  );
  const result = await collectionStore.createCollections(
    input.libraryType,
    input.libraryID,
    [{ ...collectionData, key: input.collectionKey }],
    null
  );
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${result.version}`,
    });
  }
  const firstFailure = result.failed[0];
  if (firstFailure) {
    return c.text(
      firstFailure.message,
      firstFailure.code as ContentfulStatusCode
    );
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
};
