import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { getRequestApiKey } from "../../../domain/auth";
import {
  exportContentType,
  isBibliographyContent,
  isExportFormat,
  renderExportBody,
  renderItemAtomEntryDocument,
  renderItemAtomFeed,
  withItemIncludes,
} from "../../../domain/exports";
import { createFullTextStore } from "../../../domain/fulltext";
import { createKeyStore, keyAllowsUserPermission } from "../../../domain/keys";
import { filterItemsForItemRequest } from "../../../domain/tags";
import { getCreatorSummary } from "../../../domain/zotero";
import { parseNumericID } from "./files";
import { paginateRecords } from "./pagination";
import {
  getSchemaVersion,
  getSinceOrNewerVersion,
  requestIsNotModified,
} from "./request-versions";
import { sortItemsForRequest } from "./sorting";
import { isRecord } from "./values";

const getURLSearchParams = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).searchParams;

export const filterChildItems = <T extends { data: Record<string, unknown> }>(
  items: T[],
  parentItemKey: string
): T[] => items.filter((item) => item.data.parentItem === parentItemKey);

export const renderItemList = (
  c: Context<{ Bindings: Bindings }>,
  allItems: Array<{
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
  const items =
    sinceVersion === null
      ? allItems
      : allItems.filter((item) => (item.version ?? 0) > sinceVersion);

  const cslLibraryID = getRequestCSLLibraryID(c);
  const format = c.req.query("format");
  const content = c.req.query("content");
  const style = c.req.query("style");
  const sortedItems = sortItemsForRequest(
    c,
    items,
    wantsItemAtomResponse(c, format, content) ? "dateAdded" : "dateModified"
  );
  const page = paginateRecords(c, sortedItems);
  const responseItems = page.records.map((item) =>
    shapeItemForSchemaRequest(c, item)
  );

  if (c.req.query("format") === "keys") {
    return c.text(page.records.map((item) => item.key).join("\n"), 200, {
      "Last-Modified-Version": `${version}`,
      ...page.headers,
    });
  }

  if (format === "versions") {
    return c.json(
      Object.fromEntries(
        page.records.map((item) => [item.key, item.version ?? version])
      ),
      200,
      itemListHeaders(version, page.headers)
    );
  }

  if (isExportFormat(format)) {
    return c.text(
      renderExportBody(
        responseItems,
        format,
        cslLibraryID,
        style,
        c.req.query("locale")
      ),
      200,
      {
        "Content-Type": exportContentType(format),
        "Last-Modified-Version": `${version}`,
        ...page.headers,
      }
    );
  }

  if (wantsItemAtomResponse(c, format, content)) {
    return c.text(
      renderItemAtomFeed(
        responseItems,
        content,
        cslLibraryID,
        style,
        getCanonicalFeedHref(c)
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
    responseItems.map((item) =>
      withItemIncludes(item, c.req.query("include"), cslLibraryID, style)
    ),
    200,
    itemListHeaders(version, page.headers)
  );
};

export const renderItemListHead = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>,
  version: number
) => {
  const page = paginateRecords(c, sortItemsForRequest(c, items));
  return c.body(null, 200, itemListHeaders(version, page.headers));
};

export const renderSingleItem = (
  c: Context<{ Bindings: Bindings }>,
  item: { data?: Record<string, unknown>; key: string; version?: number },
  version: number
) => {
  const cslLibraryID = getRequestCSLLibraryID(c);
  const format = c.req.query("format");
  const content = c.req.query("content");
  const style = c.req.query("style");
  const responseItem = shapeItemForSchemaRequest(c, item);
  // Single-object responses carry the object's own version, not the
  // library version (official ApiController sets libraryVersion to the
  // object version for single-object requests).
  const objectVersion = item.version ?? version;

  if (isExportFormat(format)) {
    return c.text(
      renderExportBody(
        [responseItem],
        format,
        cslLibraryID,
        style,
        c.req.query("locale")
      ),
      200,
      {
        "Content-Type": exportContentType(format),
        "Last-Modified-Version": `${objectVersion}`,
      }
    );
  }

  if (wantsItemAtomResponse(c, format, content)) {
    return c.text(
      renderItemAtomEntryDocument(responseItem, content, cslLibraryID, style),
      200,
      {
        "Content-Type": "application/atom+xml",
        "Last-Modified-Version": `${objectVersion}`,
        "Total-Results": "1",
      }
    );
  }

  return c.json(
    withItemIncludes(responseItem, c.req.query("include"), cslLibraryID, style),
    200,
    {
      "Last-Modified-Version": `${objectVersion}`,
    }
  );
};

export const itemListHeaders = (
  version: number,
  headers: Record<string, string>
) => ({
  "Last-Modified-Version": `${version}`,
  ...headers,
});

export const acceptsAtom = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Accept") ?? "")
    .split(",")
    .map((entry) => entry.trim().split(";")[0])
    .includes("application/atom+xml");

export const wantsItemAtomResponse = (
  c: Context<{ Bindings: Bindings }>,
  format: string | undefined,
  content: string | undefined
) =>
  format === "atom" ||
  isBibliographyContent(content ?? null) ||
  (!format && acceptsAtom(c));

export const getCanonicalFeedHref = (
  c: Context<{ Bindings: Bindings }>
): string => {
  const url = new URL(c.req.url);
  const params = new URLSearchParams(url.search);
  const legacyOrder = params.get("order");
  if (legacyOrder) {
    const legacyDirection = params.get("sort");
    params.delete("order");
    params.set("sort", legacyOrder);
    if (legacyDirection === "asc" || legacyDirection === "desc") {
      params.set("direction", legacyDirection);
    }
  }

  const sortedParams = [...params.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  url.search = new URLSearchParams(sortedParams).toString();
  return url.toString();
};

export const isAndroidClient = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("User-Agent") ?? "").toLowerCase().includes("android");

export const isEPUBAnnotationPosition = (value: unknown): boolean => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return isRecord(parsed) && parsed.type === "FragmentSelector";
  } catch {
    return false;
  }
};

export const shapeItemForSchemaRequest = <
  T extends {
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  },
>(
  c: Context<{ Bindings: Bindings }>,
  item: T
): T => {
  if (!item.data) {
    return item;
  }

  const schemaVersion = getSchemaVersion(c);
  const data = { ...item.data };
  const creatorSummary = getCreatorSummary(data);
  const existingMeta = isRecord((item as { meta?: unknown }).meta)
    ? ((item as { meta?: unknown }).meta as Record<string, unknown>)
    : {};
  const meta = { ...existingMeta };
  if (isAndroidClient(c) || (schemaVersion !== null && schemaVersion < 42)) {
    delete data.lastRead;
  }
  if (schemaVersion !== null && schemaVersion <= 29) {
    for (const field of [
      "originalDate",
      "originalPlace",
      "originalPublisher",
    ]) {
      if (data[field] === "") {
        delete data[field];
      }
    }
  }
  if (
    data.itemType === "annotation" &&
    schemaVersion !== null &&
    schemaVersion < 29 &&
    (data.annotationType === "underline" ||
      data.annotationType === "text" ||
      isEPUBAnnotationPosition(data.annotationPosition))
  ) {
    data.invalidProp = "annotationType";
  }
  if (creatorSummary) {
    meta.creatorSummary = creatorSummary;
  } else {
    delete meta.creatorSummary;
  }

  return {
    ...item,
    data,
    ...(Object.keys(meta).length ? { meta } : {}),
  } as T;
};

export const getRequestLibraryID = (
  c: Context<{ Bindings: Bindings }>
): number => {
  const userID = parseNumericID(c.req.param("userID") || "0");
  if (userID !== null && userID > 0) {
    return userID;
  }

  const groupID = parseNumericID(c.req.param("groupID") || "0");
  return groupID ?? 0;
};

export const getRequestCSLLibraryID = (
  c: Context<{ Bindings: Bindings }>
): number => {
  const userID = parseNumericID(c.req.param("userID") || "0");
  return userID !== null && userID > 0 ? 0 : getRequestLibraryID(c);
};

export const filterItemsForRequest = async (
  c: Context<{ Bindings: Bindings }>,
  libraryType: "group" | "user",
  libraryID: number,
  items: Parameters<typeof filterItemsForItemRequest>[0],
  allItems = items,
  includeChildFullText = false
) => {
  const params = getURLSearchParams(c);
  let fullTextContent: Map<string, string> | undefined;
  if (params.get("q") && params.get("qmode") === "everything") {
    const fullTextStore = createFullTextStore(c.env);
    if (await fullTextStore.markReindexingForSearch(libraryType, libraryID)) {
      c.header("Zotero-Full-Text-Reindexing", "1");
      fullTextContent = new Map();
    } else {
      fullTextContent = await fullTextStore.getContentMap(
        libraryType,
        libraryID
      );
    }
  }
  const includeNotes =
    libraryType === "group" || (await requestAllowsUserNotes(c, libraryID));
  const visibleItems = includeNotes
    ? items
    : items.filter((item) => item.data.itemType !== "note");
  const visibleAllItems = includeNotes
    ? allItems
    : allItems.filter((item) => item.data.itemType !== "note");

  return filterItemsForItemRequest(visibleItems, params, {
    allItems: visibleAllItems,
    fullTextContent,
    includeChildFullText,
  });
};

export const requestAllowsUserNotes = async (
  c: Context<{ Bindings: Bindings }>,
  userID: number
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  const key = await createKeyStore(c.env).getKey(apiKey);
  return Boolean(
    key &&
      key.userID === userID &&
      keyAllowsUserPermission(key.access, "library") &&
      keyAllowsUserPermission(key.access, "notes")
  );
};
