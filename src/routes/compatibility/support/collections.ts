import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { paginateRecords } from "./pagination";
import {
  getSinceOrNewerVersion,
  requestIsNotModified,
} from "./request-versions";
import { sortRecordsForRequest } from "./sorting";

export const getRequestedCollectionKeys = (
  c: Context<{ Bindings: Bindings }>
): string[] | undefined => c.req.query("collectionKey")?.split(",");

export const filterCollectionsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  collections: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>
) => {
  const q = c.req.query("q")?.toLocaleLowerCase();
  const filtered = q
    ? collections.filter((collection) =>
        [collection.key, collection.data?.name]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(q))
      )
    : collections;

  // Official dataserver default sort for collection lists is title, not
  // dateModified — the tests assert alphabetical order on unsorted requests.
  return sortRecordsForRequest(
    c,
    filtered,
    (collection, field) => {
      if (field === "title" || field === "name") {
        return String(collection.data?.name ?? collection.key);
      }
      if (field === "dateModified" || field === "dateAdded") {
        return collection.version ?? 0;
      }

      return String(collection.key);
    },
    "title",
    (collection) => collection.key
  );
};

export const renderCollectionList = (
  c: Context<{ Bindings: Bindings }>,
  collections: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>,
  version: number
) => {
  if (requestIsNotModified(c, version)) {
    return c.body(null, 304, {
      "Last-Modified-Version": `${version}`,
    });
  }

  const sinceVersion = getSinceOrNewerVersion(c);
  const versionFiltered =
    sinceVersion === null
      ? collections
      : collections.filter(
          (collection) => (collection.version ?? 0) > sinceVersion
        );
  const filtered = filterCollectionsForRequest(c, versionFiltered);
  const page = paginateRecords(c, filtered);

  if (c.req.query("format") === "keys") {
    return c.text(
      page.records.map((collection) => collection.key).join("\n"),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(
        page.records.map((collection) => [
          collection.key,
          collection.version ?? version,
        ])
      ),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(page.records, 200, {
    "Last-Modified-Version": `${version}`,
    ...page.headers,
  });
};
