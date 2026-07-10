import type { Context } from "hono";
import type { Bindings } from "../../../bindings";

export const getURLSearchParams = (c: Context<{ Bindings: Bindings }>) =>
  new URL(c.req.url).searchParams;

export const collectionFailureResponse = (
  c: Context<{ Bindings: Bindings }>,
  missingCollectionKeys: string[],
  version: number
) =>
  c.json(
    {
      failed: missingCollectionKeys.map((collectionKey) => ({
        code: 409,
        data: {
          collection: collectionKey,
        },
        message: `Collection ${collectionKey} not found`,
      })),
      success: [],
      successful: [],
    },
    200,
    {
      "Last-Modified-Version": `${version}`,
    }
  );

export const hasJSONContentType = (c: Context<{ Bindings: Bindings }>) =>
  (c.req.header("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("application/json");

export const hasDirectCollections = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.collections) && data.collections.length > 0;

export const isChildItemData = (data: Record<string, unknown>): boolean =>
  typeof data.parentItem === "string" && data.parentItem.length > 0;

export const isEmbeddedImageAttachment = (
  data: Record<string, unknown>
): boolean =>
  data.itemType === "attachment" && data.linkMode === "embedded_image";

export const mergeItemUpdate = (
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  itemKey: string,
  patchMode: boolean
): Record<string, unknown> => ({
  ...(patchMode ? existing : {}),
  ...body,
  key: itemKey,
});

export const normalizeItemDeletedForWrite = (data: Record<string, unknown>) => {
  if (data.deleted === true) {
    data.deleted = 1;
  } else if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};

export const normalizeItemParentForWrite = (data: Record<string, unknown>) => {
  if (data.parentItem === false) {
    delete data.parentItem;
  }

  return data;
};

export const normalizeObjectDeletedForWrite = (
  data: Record<string, unknown>
) => {
  if (data.deleted === false) {
    delete data.deleted;
  }

  return data;
};

export const normalizeItemBatchDeletedForWrite = (
  items: Record<string, unknown>[]
) =>
  items.map((item) =>
    normalizeItemParentForWrite(normalizeItemDeletedForWrite(item))
  );

export const normalizeObjectBatchDeletedForWrite = (
  objects: Record<string, unknown>[]
) => objects.map(normalizeObjectDeletedForWrite);
