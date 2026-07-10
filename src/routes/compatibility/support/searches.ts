import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { searchNeedsInvalidProp } from "../../../domain/searches";
import { paginateRecords } from "./pagination";
import {
  getIfModifiedSinceVersion,
  getSchemaVersion,
} from "./request-versions";
import {
  isHeadRequest,
  renderJSONAtomEntry,
  renderJSONAtomFeed,
  wantsAtomResponse,
} from "./responses";
import { settingHeaders } from "./settings";
import { sortRecordsForRequest } from "./sorting";

export const getRequestedSearchKeys = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("searchKey")?.split(",").filter(Boolean);

export const withSearchSchema = (
  c: Context<{ Bindings: Bindings }>,
  search: { data: Record<string, unknown>; key: string; version: number }
) => {
  const data = { ...search.data };
  if (searchNeedsInvalidProp(search, getSchemaVersion(c))) {
    data.invalidProp = 1;
  } else {
    delete data.invalidProp;
  }

  return {
    ...search,
    data,
  };
};

export const renderSearchList = (
  c: Context<{ Bindings: Bindings }>,
  searches: Array<{
    data: Record<string, unknown>;
    key: string;
    version: number;
  }>,
  version: number
) => {
  const ifModifiedSinceVersion = getIfModifiedSinceVersion(c);
  if (ifModifiedSinceVersion !== null && version <= ifModifiedSinceVersion) {
    return c.body(null, 304, settingHeaders(version));
  }
  const sortedSearches = sortRecordsForRequest(
    c,
    searches,
    (search, field) =>
      field === "title" || field === "name"
        ? String(search.data.name ?? search.key)
        : search.version,
    "dateModified",
    (search) => search.key
  );
  const page = paginateRecords(c, sortedSearches);

  if (isHeadRequest(c)) {
    return c.body(null, 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (c.req.query("format") === "keys") {
    return c.text(page.records.map((search) => search.key).join("\n"), 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (c.req.query("format") === "versions") {
    return c.json(
      Object.fromEntries(
        page.records.map((search) => [search.key, search.version])
      ),
      200,
      {
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  if (wantsAtomResponse(c)) {
    return c.text(
      renderJSONAtomFeed(
        "Searches",
        page.records.map((search) =>
          renderJSONAtomEntry({
            content: withSearchSchema(c, search).data,
            id: `searches/${search.key}`,
            key: search.key,
            title: String(search.data.name ?? search.key),
            version: search.version,
          })
        )
      ),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  return c.json(
    page.records.map((search) => withSearchSchema(c, search)),
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    }
  );
};

export const renderSearchWriteResult = (
  c: Context<{ Bindings: Bindings }>,
  result: {
    failed: Record<string, unknown>;
    success: string[];
    successful: unknown[];
    unchanged: unknown[];
    version: number;
  }
) =>
  c.json(
    {
      failed: result.failed,
      success: result.success,
      successful: result.successful,
      unchanged: result.unchanged,
    },
    200,
    settingHeaders(result.version)
  );

export const parseSearchWriteBody = async (
  c: Context<{ Bindings: Bindings }>
) => c.req.json().catch(() => null);
