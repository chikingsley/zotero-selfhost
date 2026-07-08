import { requireRoot } from "./shared";
import { clearMemoryCollections } from "../../collections";
import { clearMemoryDeleted } from "../../deleted";
import { clearMemorySearches } from "../../searches";
import { clearMemorySettings } from "../../settings";
import { createCompatibilityStore } from "../../storage";
import { generateZoteroKey } from "../../zotero";
import { compatibility } from "./router";


compatibility.post("/test/setup", async (c) => {
  const rootError = requireRoot(c);
  if (rootError) {
    return rootError;
  }

  const userID = Number.parseInt(c.req.query("u") ?? "1", 10);
  const userID2 = Number.parseInt(c.req.query("u2") ?? "2", 10);
  const user1Key = c.env.ZOTERO_API_KEY || generateZoteroKey().toLowerCase();
  const user2Key = generateZoteroKey().toLowerCase();
  const store = createCompatibilityStore(c.env);
  clearMemoryCollections();
  clearMemoryDeleted();
  clearMemorySearches();
  clearMemorySettings();

  return c.json(
    await store.setupTestUsers(userID, userID2, user1Key, user2Key)
  );
});
