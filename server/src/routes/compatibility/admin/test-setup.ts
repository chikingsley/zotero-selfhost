import { clearMemoryCollections } from "../../../domain/collections";
import { clearMemoryDeleted } from "../../../domain/deleted";
import {
  clearMemoryFullTextIndexStates,
  createFullTextStore,
} from "../../../domain/fulltext";
import { clearMemorySearches } from "../../../domain/searches";
import { clearMemorySettings } from "../../../domain/settings";
import { createCompatibilityStore } from "../../../domain/storage";
import { registerUserIdentity } from "../../../domain/user-identity";
import { generateZoteroKey } from "../../../domain/zotero";
import { compatibility } from "../router";
import { requireRoot } from "../support";

compatibility.post("/test/setup", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = Number.parseInt(c.req.query("u") ?? "1", 10);
  const userID2 = Number.parseInt(c.req.query("u2") ?? "2", 10);
  // Identities from the official test config (config/default.json):
  // library envelopes report these as displayName / URL slug.
  registerUserIdentity(userID, "phpunit", "Real Name");
  registerUserIdentity(userID2, "phpunit2", "Real Name 2");
  const user1Key =
    c.env.SELFHOST_TEST_API_KEY || generateZoteroKey().toLowerCase();
  const user2Key = generateZoteroKey().toLowerCase();
  const store = createCompatibilityStore(c.env);
  clearMemoryCollections();
  clearMemoryDeleted();
  clearMemoryFullTextIndexStates();
  clearMemorySearches();
  clearMemorySettings();

  return c.json(
    await store.setupTestUsers(userID, userID2, user1Key, user2Key)
  );
});

compatibility.get("/test/fulltext-state", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
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
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
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
