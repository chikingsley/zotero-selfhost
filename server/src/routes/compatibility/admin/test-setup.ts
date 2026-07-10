import { createFullTextStore } from "../../../domain/fulltext";
import { generateZoteroKey } from "../../../domain/zotero";
import { compatibility } from "../router";
import { requireCompatibilityTestAdmin } from "../support";
import { resetCompatibilityTestState } from "./test-state";

compatibility.post("/test/setup", async (c) => {
  const adminError = await requireCompatibilityTestAdmin(c);
  if (adminError) {
    return adminError;
  }

  const userID = Number.parseInt(c.req.query("u") ?? "1", 10);
  const userID2 = Number.parseInt(c.req.query("u2") ?? "2", 10);
  const user1Key =
    c.env.COMPATIBILITY_TEST_API_KEY || generateZoteroKey().toLowerCase();
  const user2Key = generateZoteroKey().toLowerCase();
  return c.json(
    await resetCompatibilityTestState(
      c.env.DB,
      userID,
      userID2,
      user1Key,
      user2Key
    )
  );
});

compatibility.get("/test/fulltext-state", async (c) => {
  const adminError = await requireCompatibilityTestAdmin(c);
  if (adminError) {
    return adminError;
  }

  const { libraryID, libraryType } = readFullTextStateTarget({
    libraryID: c.req.query("libraryID"),
    libraryType: c.req.query("libraryType"),
  });
  return c.json(
    await createFullTextStore(c.env).getIndexState(libraryType, libraryID)
  );
});

compatibility.post("/test/fulltext-state", async (c) => {
  const adminError = await requireCompatibilityTestAdmin(c);
  if (adminError) {
    return adminError;
  }

  const body = await c.req.json().catch(() => ({}));
  const { libraryID, libraryType } = readFullTextStateTarget(body);
  const patch: { deindexed?: boolean; reindexing?: number | null } = {};

  if (typeof body.deindexed === "boolean") {
    patch.deindexed = body.deindexed;
  }
  if (typeof body.reindexing === "number" && Number.isFinite(body.reindexing)) {
    patch.reindexing = Math.trunc(body.reindexing);
  } else if (body.reindexing === null || body.reindexing === false) {
    patch.reindexing = null;
  }

  return c.json(
    await createFullTextStore(c.env).setIndexState(
      libraryType,
      libraryID,
      patch
    )
  );
});

const readFullTextStateTarget = (input: unknown) => {
  const record = isRecord(input) ? input : {};
  const libraryType = record.libraryType === "group" ? "group" : "user";
  const parsed = Number.parseInt(String(record.libraryID ?? "0"), 10);

  return {
    libraryID: Number.isFinite(parsed) ? parsed : 0,
    libraryType,
  } as const;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
