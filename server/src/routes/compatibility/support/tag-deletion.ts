import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { recordDeletedObjects } from "../../../domain/deleted";
import type { CompatibilityStore } from "../../../domain/storage";
import { removeTagsFromItems } from "../../../domain/tags";
import { getIfUnmodifiedSinceVersion } from "./request-versions";

const getURLSearchParams = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).searchParams;

export const getDeletedTagNames = (c: Context<{ Bindings: Bindings }>) =>
  getURLSearchParams(c)
    .getAll("tag")
    .flatMap((expression) => expression.split(" || "))
    .map((tag) => tag.trim())
    .filter(Boolean);

export const deleteTagsForLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const preconditionVersion = getIfUnmodifiedSinceVersion(c);
  if (preconditionVersion === null) {
    return c.text("If-Unmodified-Since-Version not provided", 428);
  }

  const result =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);

  if (result.version > preconditionVersion) {
    return c.text("Library has been modified", 412);
  }

  const updatedItems = removeTagsFromItems(
    result.items,
    getURLSearchParams(c).getAll("tag")
  );
  if (updatedItems.length > 0) {
    const writeResult =
      input.libraryType === "user"
        ? await input.store.createItems(input.libraryID, updatedItems)
        : await input.store.createGroupItems(input.libraryID, updatedItems);
    await recordDeletedObjects(
      c.env,
      input.libraryType,
      input.libraryID,
      writeResult.version,
      "tag",
      getDeletedTagNames(c)
    );

    return c.body(null, 204, {
      "Last-Modified-Version": `${writeResult.version}`,
    });
  }

  return c.body(null, 204, {
    "Last-Modified-Version": `${result.version}`,
  });
};
