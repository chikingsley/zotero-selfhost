import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import {
  getItemTypeCreatorTypes,
  getItemTypeFields,
  validAttachmentLinkModes,
  validCreatorTypes,
} from "../../../domain/mappings";
import type { CompatibilityStore } from "../../../domain/storage";
import {
  isSupportedAnnotationType,
  isSupportedItemType,
} from "../../../domain/zotero";
import { isRecord, jsonValuesEqual } from "./values";
import { isEmbeddedImageAttachment } from "./write-helpers";
import type { ItemWriteFailures } from "./write-preconditions";

export const fillItemTemplateFields = (
  data: Record<string, unknown>,
  isNew: boolean
) => {
  for (const [field, value] of Object.entries(data)) {
    if (value === null) {
      data[field] = "";
    }
  }
  if (!isNew) {
    return data;
  }
  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  if (!itemType || itemType === "attachment" || itemType === "annotation") {
    return data;
  }
  for (const entry of getItemTypeFields(itemType) ?? []) {
    if (!(entry.field in data)) {
      data[entry.field] = "";
    }
  }
  return data;
};

export const validateItemNoteFieldForWrite = (
  data: Record<string, unknown>
): { code: number; message: string } | null => {
  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  if (
    "note" in data &&
    itemType !== "note" &&
    itemType !== "attachment" &&
    itemType !== "annotation"
  ) {
    return {
      code: 400,
      message: `'note' property is valid only for note and attachment items`,
    };
  }
  return null;
};

const attachmentOnlyFields = new Set([
  "charset",
  "contentType",
  "filename",
  "linkMode",
  "md5",
  "mtime",
  "path",
]);

export const validateItemTypeAndFieldUseForWrite = (
  data: Record<string, unknown>
): { code: number; message: string } | null => {
  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  if (!itemType) {
    return { code: 400, message: "'itemType' property not provided" };
  }
  if (!isSupportedItemType(itemType)) {
    return { code: 400, message: `'${itemType}' is not a valid itemType` };
  }
  if (itemType !== "attachment") {
    for (const field of attachmentOnlyFields) {
      if (field in data) {
        return {
          code: 400,
          message: `'${field}' is valid only for attachment items`,
        };
      }
    }
  }
  return null;
};

// /top semantics: a query may match any descendant; the response contains
// the matching items' top-level ancestors.
export const resolveTopLevelItems = <
  T extends { data?: Record<string, unknown>; key: string },
>(
  matched: T[],
  allItems: T[],
  includeTrashed = false
): T[] => {
  const byKey = new Map(allItems.map((item) => [item.key, item]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of matched) {
    let current = item;
    let guard = 0;
    while (
      typeof current.data?.parentItem === "string" &&
      byKey.has(current.data.parentItem) &&
      guard < 50
    ) {
      current = byKey.get(current.data.parentItem) as T;
      guard += 1;
    }
    if (!seen.has(current.key) && (includeTrashed || !current.data?.deleted)) {
      seen.add(current.key);
      out.push(current);
    }
  }
  return out;
};

export const normalizeItemLastReadForWrite = (
  data: Record<string, unknown>,
  libraryType: "group" | "user"
): { code: number; message: string } | null => {
  if (!("lastRead" in data)) {
    return null;
  }
  const value = data.lastRead;
  if (value === "" || value === null || value === false) {
    delete data.lastRead;
    return null;
  }
  if (libraryType === "group") {
    return {
      code: 400,
      message: "'lastRead' is valid only in user libraries",
    };
  }
  if (data.itemType !== "attachment") {
    return {
      code: 400,
      message: "'lastRead' is valid only for attachment items",
    };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { code: 400, message: "'lastRead' must be an integer" };
  }
  return null;
};

// Official attachment write rules: linkMode required and valid, storage
// properties only on imported/embedded linkModes, linked files only in user
// libraries, and embedded images locked to an image type under their parent.
export const validateAttachmentForWrite = (
  data: Record<string, unknown>,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  libraryType: "group" | "user"
): { code: number; message: string } | null => {
  if (data.itemType !== "attachment") {
    return null;
  }
  const linkMode = data.linkMode;
  if (typeof linkMode !== "string" || linkMode === "") {
    return { code: 400, message: "'linkMode' property not provided" };
  }
  if (!validAttachmentLinkModes.has(linkMode)) {
    return { code: 400, message: `'${linkMode}' is not a valid linkMode` };
  }
  if (libraryType === "group" && linkMode === "linked_file") {
    return {
      code: 400,
      message: "Linked files can only be added to user libraries",
    };
  }
  const allowsStorage =
    linkMode === "imported_file" ||
    linkMode === "imported_url" ||
    linkMode === "embedded_image";
  if (!allowsStorage) {
    if (data.md5) {
      return {
        code: 400,
        message:
          "'md5' is valid only for imported and embedded-image attachments",
      };
    }
    if (data.mtime) {
      return {
        code: 400,
        message:
          "'mtime' is valid only for imported and embedded-image attachments",
      };
    }
  }
  if (linkMode === "embedded_image") {
    if (
      existing &&
      "parentItem" in incoming &&
      incoming.parentItem !== existing.parentItem
    ) {
      return {
        code: 400,
        message: "Cannot change parent item of embedded-image attachment",
      };
    }
    if (typeof data.note === "string" && data.note !== "") {
      return {
        code: 400,
        message: "'note' property is not valid for embedded images",
      };
    }
    const parent = typeof data.parentItem === "string" ? data.parentItem : "";
    if (!parent) {
      return {
        code: 400,
        message: "Embedded-image attachment must have a parent item",
      };
    }
    const contentType =
      typeof data.contentType === "string" ? data.contentType : "";
    if (!contentType.startsWith("image/")) {
      return {
        code: 400,
        message: "Embedded-image attachment must have an image content type",
      };
    }
  }
  return null;
};

// Null storage properties on attachments mean "leave as-is", not "clear".
export const stripNullAttachmentStorageProps = (
  object: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
) => {
  const isAttachment =
    object.itemType === "attachment" || existing?.itemType === "attachment";
  if (!isAttachment) {
    return object;
  }
  if (object.md5 === null) {
    delete object.md5;
  }
  if (object.mtime === null) {
    delete object.mtime;
  }
  return object;
};

const maxItemFieldLength = 65_535;

export const validateItemBatchPublicationsForWrite = (
  items: Record<string, unknown>[],
  libraryType: "group" | "user"
): ItemWriteFailures => {
  const failures: ItemWriteFailures = {};
  items.forEach((item, index) => {
    if (item.inPublications !== true) {
      return;
    }
    if (libraryType === "group") {
      failures[index] = {
        code: 400,
        message: "Group items cannot be added to My Publications",
      };
      return;
    }

    const isTopLevel =
      typeof item.parentItem !== "string" || item.parentItem === "";
    if (
      isTopLevel &&
      (item.itemType === "attachment" || item.itemType === "note")
    ) {
      failures[index] = {
        code: 400,
        message:
          "Top-level notes and attachments cannot be added to My Publications",
      };
    }
  });
  return failures;
};

export const validateItemBatchFieldLengthsForWrite = (
  items: Record<string, unknown>[]
): ItemWriteFailures => {
  const failures: ItemWriteFailures = {};
  items.forEach((item, index) => {
    for (const [field, value] of Object.entries(item)) {
      // Notes have their own dedicated size validation.
      if (field === "note") {
        continue;
      }
      if (typeof value === "string" && value.length > maxItemFieldLength) {
        failures[index] = {
          code: 413,
          message: `Field '${field}' value too long`,
        };
        break;
      }
    }
  });
  return failures;
};

// dateModified is server-stamped on every effective change, so it is
// excluded when deciding whether an upload actually changed anything.
export const stripVersionForCompare = (data: Record<string, unknown>) => {
  const { version: _version, dateModified: _dateModified, ...rest } = data;
  return rest;
};

export const stripNonFieldChangesForCompare = (
  data: Record<string, unknown>
) => {
  const {
    collections: _collections,
    dateModified: _dateModified,
    inPublications: _inPublications,
    relations: _relations,
    version: _version,
    ...rest
  } = data;
  return rest;
};

export const isTmpZoteroClientDateModifiedHack = (
  c: Context<{ Bindings: Bindings }>
) => {
  const userAgent = c.req.header("User-Agent") ?? "";
  return userAgent.includes("Firefox") || userAgent.includes("Zotero");
};

export const isOnlyNonFieldItemChange = (
  next: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): boolean => {
  if (!existing) {
    return false;
  }
  if (
    jsonValuesEqual(
      stripVersionForCompare(next),
      stripVersionForCompare(existing)
    )
  ) {
    return false;
  }
  return jsonValuesEqual(
    stripNonFieldChangesForCompare(next),
    stripNonFieldChangesForCompare(existing)
  );
};

export const isFieldItemChange = (
  next: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): boolean =>
  Boolean(
    existing &&
      !jsonValuesEqual(
        stripNonFieldChangesForCompare(next),
        stripNonFieldChangesForCompare(existing)
      )
  );

export const creatorHasName = (creator: Record<string, unknown>) =>
  ["name", "firstName", "lastName"].some(
    (field) =>
      typeof creator[field] === "string" && creator[field].trim() !== ""
  );

export const validateItemCreatorsForWrite = (
  data: Record<string, unknown>,
  isNew: boolean
): { code: number; message: string } | null => {
  if (data.creators === undefined) {
    return null;
  }
  if (!Array.isArray(data.creators)) {
    return { code: 400, message: "'creators' property must be an array" };
  }

  const itemType = typeof data.itemType === "string" ? data.itemType : "";
  const validForItemType = new Set(
    getItemTypeCreatorTypes(itemType).map((entry) => entry.creatorType)
  );
  const normalizedCreators: Record<string, unknown>[] = [];

  for (const creator of data.creators) {
    if (!isRecord(creator)) {
      return { code: 400, message: "creator object must be an object" };
    }
    if (!("creatorType" in creator)) {
      return {
        code: 400,
        message: "creator object must contain 'creatorType'",
      };
    }
    if (!creatorHasName(creator)) {
      if (data.creators.length === 1 && isNew) {
        data.creators = [];
        return null;
      }
      return {
        code: 400,
        message: "creator object must contain 'firstName'/'lastName' or 'name'",
      };
    }

    const creatorType = creator.creatorType;
    if (
      typeof creatorType !== "string" ||
      !validCreatorTypes.has(creatorType)
    ) {
      return {
        code: 400,
        message: `'${String(creatorType)}' is not a valid creator type`,
      };
    }
    if (!validForItemType.has(creatorType) && creatorType !== "author") {
      return {
        code: 400,
        message: `'${creatorType}' is not a valid creator type for item type '${itemType}'`,
      };
    }
    if ("name" in creator && "firstName" in creator) {
      return {
        code: 400,
        message: "'firstName' and 'name' creator fields are mutually exclusive",
      };
    }
    if ("name" in creator && "lastName" in creator) {
      return {
        code: 400,
        message: "'lastName' and 'name' creator fields are mutually exclusive",
      };
    }
    if ("firstName" in creator && !("lastName" in creator)) {
      return {
        code: 400,
        message: "'lastName' creator field must be set if 'firstName' is set",
      };
    }
    if ("lastName" in creator && !("firstName" in creator)) {
      return {
        code: 400,
        message: "'firstName' creator field must be set if 'lastName' is set",
      };
    }
    for (const field of Object.keys(creator)) {
      if (!["creatorType", "firstName", "lastName", "name"].includes(field)) {
        return {
          code: 400,
          message: `Invalid creator property '${field}'`,
        };
      }
    }
    normalizedCreators.push(creator);
  }

  data.creators = normalizedCreators;
  return null;
};

export const validateItemBatchCreatorsForWrite = (
  items: Record<string, unknown>[],
  isNew: boolean
): Record<string, { code: number; message: string }> => {
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = validateItemCreatorsForWrite(item, isNew);
    if (failure) {
      failures[index] = failure;
    }
  });
  return failures;
};

export const annotationSortIndexPattern = /^\d{5}\|\d+(?:\|\d{5})?$/;

export const annotationColorPattern = /^#[0-9a-fA-F]{6}$/;

export const annotationTextTypes = new Set(["highlight", "underline"]);

export const annotationParentContentTypes = new Set([
  "application/epub+zip",
  "application/pdf",
  "application/xhtml+xml",
  "text/html",
]);

export const stringifyAnnotationPosition = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? {});

export const truncateAnnotationText = (value: unknown): unknown =>
  typeof value === "string" && Array.from(value).length > 7500
    ? Array.from(value).slice(0, 7500).join("")
    : value;

export const normalizeAnnotationForWrite = (
  data: Record<string, unknown>,
  existing?: Record<string, unknown>
): { code: number; message: string } | null => {
  if (data.itemType !== "annotation") {
    return null;
  }

  const annotationType =
    typeof data.annotationType === "string" ? data.annotationType : "";
  if (!(annotationType && isSupportedAnnotationType(annotationType))) {
    return {
      code: 400,
      message:
        "annotationType must be 'highlight', 'note', 'image', 'text', or 'ink'",
    };
  }
  if (
    existing?.itemType === "annotation" &&
    typeof existing.annotationType === "string" &&
    existing.annotationType !== annotationType
  ) {
    return {
      code: 400,
      message: `Cannot change existing annotationType for item ${String(data.key ?? "")}`,
    };
  }
  if ("annotationText" in data && !annotationTextTypes.has(annotationType)) {
    return {
      code: 400,
      message:
        "'annotationText' can only be set for highlight and underline annotations",
    };
  }
  if (
    typeof data.annotationPageLabel === "string" &&
    data.annotationPageLabel.length > 50
  ) {
    return {
      code: 400,
      message: `Annotation page label is too long for attachment ${String(data.parentItem ?? "")}`,
    };
  }

  const position = stringifyAnnotationPosition(data.annotationPosition);
  if (position.length > 65_000) {
    return {
      code: 400,
      message: `Annotation position is too long for attachment ${String(data.parentItem ?? "")}`,
    };
  }
  data.annotationPosition = position;

  if (
    typeof data.annotationSortIndex === "string" &&
    !annotationSortIndexPattern.test(data.annotationSortIndex)
  ) {
    return {
      code: 400,
      message: `Invalid sortIndex '${data.annotationSortIndex}'`,
    };
  }
  if (data.annotationColor === undefined || data.annotationColor === "") {
    data.annotationColor = "#ffd400";
  } else if (
    typeof data.annotationColor !== "string" ||
    !annotationColorPattern.test(data.annotationColor)
  ) {
    return {
      code: 400,
      message: "annotationColor must be a hex color (e.g., '#FF0000')",
    };
  }
  if (data.annotationAuthorName === "") {
    delete data.annotationAuthorName;
  }
  data.annotationText = truncateAnnotationText(data.annotationText);

  return null;
};

export const validateItemBatchAnnotationsForWrite = (
  items: Record<string, unknown>[]
): Record<string, { code: number; message: string }> => {
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = normalizeAnnotationForWrite(item);
    if (failure) {
      failures[index] = failure;
    }
  });
  return failures;
};

export const getAnnotationParentFailure = (
  item: Record<string, unknown>,
  parents: Map<string, Record<string, unknown>>
): { code: number; message: string } | null => {
  if (item.itemType !== "annotation") {
    return null;
  }
  if (typeof item.parentItem !== "string" || item.parentItem.length === 0) {
    return { code: 400, message: "Annotation must have a parent item" };
  }

  const parent = parents.get(item.parentItem);
  if (!parent) {
    return {
      code: 409,
      message: `Parent attachment ${item.parentItem} not found`,
    };
  }
  const contentType =
    typeof parent.contentType === "string"
      ? (parent.contentType.split(";")[0] ?? "").toLowerCase()
      : "";
  if (
    parent.itemType !== "attachment" ||
    !annotationParentContentTypes.has(contentType)
  ) {
    const annotationType =
      typeof item.annotationType === "string"
        ? item.annotationType
        : "annotation";
    return {
      code: 400,
      message: `Parent item of ${annotationType} annotation must be a PDF attachment`,
    };
  }

  return null;
};

export const getParentMap = (
  existingItems: Array<{ data: Record<string, unknown>; key: string }>,
  pendingItems: Record<string, unknown>[] = []
) => {
  const parents = new Map<string, Record<string, unknown>>();
  for (const item of existingItems) {
    parents.set(item.key, item.data);
  }
  for (const item of pendingItems) {
    if (typeof item.key === "string") {
      parents.set(item.key, item);
    }
  }
  return parents;
};

export const getItemParentFailure = (
  item: Record<string, unknown>,
  parents: Map<string, Record<string, unknown>>,
  failedParentKeys = new Set<string>()
): { code: number; data?: Record<string, unknown>; message: string } | null => {
  if (item.itemType === "annotation" || typeof item.parentItem !== "string") {
    return null;
  }

  const parentItem = item.parentItem;
  if (typeof item.key === "string" && item.key === parentItem) {
    return {
      code: 400,
      data: { parentItem },
      message: `Item ${parentItem} cannot be a child of itself`,
    };
  }
  if (failedParentKeys.has(parentItem)) {
    return {
      code: 409,
      data: { parentItem },
      message: `Parent item ${parentItem} not found`,
    };
  }

  const parent = parents.get(parentItem);
  if (!parent) {
    return {
      code: 409,
      data: { parentItem },
      message: `Parent item ${parentItem} not found`,
    };
  }
  if (
    (parent.itemType === "note" || parent.itemType === "attachment") &&
    !(isEmbeddedImageAttachment(item) && parent.itemType === "note")
  ) {
    return {
      code: 409,
      data: { parentItem },
      message: "Parent item cannot be a note or attachment",
    };
  }
  if (typeof parent.parentItem === "string" && parent.parentItem.length > 0) {
    // Child parents are allowed where the official hierarchy permits depth:
    // embedded images under (possibly child) notes, annotations under
    // (possibly child) attachments.
    const childParentAllowed =
      (isEmbeddedImageAttachment(item) && parent.itemType === "note") ||
      (item.itemType === "annotation" && parent.itemType === "attachment");
    if (!childParentAllowed) {
      return {
        code: 409,
        data: { parentItem },
        message: `Parent item ${parentItem} cannot be a child item`,
      };
    }
  }

  return null;
};

export const validateItemParentForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  item: Record<string, unknown>
): Promise<{ code: number; message: string } | null> => {
  if (item.itemType === "annotation" || typeof item.parentItem !== "string") {
    return null;
  }
  const parentResult =
    libraryType === "user"
      ? await store.getItem(libraryID, item.parentItem)
      : await store.getGroupItem(libraryID, item.parentItem);
  const parent = parentResult?.items[0];
  const failure = getItemParentFailure(
    item,
    parent ? new Map([[parent.key, parent.data]]) : new Map()
  );
  return failure ? { code: failure.code, message: failure.message } : null;
};

export const validateItemBatchParentsForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  items: Record<string, unknown>[],
  failed: ItemWriteFailures
): Promise<number> => {
  const library =
    libraryType === "user"
      ? await store.listItems(libraryID)
      : await store.listGroupItems(libraryID);
  const failedParentKeys = new Set(
    Object.entries(failed)
      .map(([index]) => items[Number(index)]?.key)
      .filter((key): key is string => typeof key === "string")
  );
  const parents = getParentMap(
    library.items,
    items.filter((_item, index) => !(index in failed))
  );
  items.forEach((item, index) => {
    if (index in failed) {
      return;
    }
    const failure = getItemParentFailure(item, parents, failedParentKeys);
    if (failure) {
      failed[index] = failure;
    }
  });

  return library.version;
};

export const validateAnnotationParentForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  item: Record<string, unknown>
): Promise<{ code: number; message: string } | null> => {
  if (item.itemType !== "annotation") {
    return null;
  }
  const parentItem = typeof item.parentItem === "string" ? item.parentItem : "";
  const parentResult = parentItem
    ? libraryType === "user"
      ? await store.getItem(libraryID, parentItem)
      : await store.getGroupItem(libraryID, parentItem)
    : null;
  const parent = parentResult?.items[0];
  return getAnnotationParentFailure(
    item,
    parent ? new Map([[parent.key, parent.data]]) : new Map()
  );
};

export const validateItemBatchAnnotationParentsForWrite = async (
  store: CompatibilityStore,
  libraryType: "group" | "user",
  libraryID: number,
  items: Record<string, unknown>[]
): Promise<{
  failures: Record<string, { code: number; message: string }>;
  version: number;
}> => {
  const library =
    libraryType === "user"
      ? await store.listItems(libraryID)
      : await store.listGroupItems(libraryID);
  const parents = getParentMap(library.items, items);
  const failures: Record<string, { code: number; message: string }> = {};
  items.forEach((item, index) => {
    const failure = getAnnotationParentFailure(item, parents);
    if (failure) {
      failures[index] = failure;
    }
  });

  return { failures, version: library.version };
};
