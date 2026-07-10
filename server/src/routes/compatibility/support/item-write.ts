import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Bindings } from "../../../bindings";
import { createCollectionStore } from "../../../domain/collections";
import {
  validateItemBatchNotesForWrite,
  validateItemNoteForWrite,
} from "../../../domain/notes";
import {
  libraryUpdateNotificationHeaders,
  topicPublicationsUpdatedNotification,
} from "../../../domain/notifications";
import {
  getRelatedItemReverseUpdates,
  validateItemBatchRelationsForWrite,
  validateObjectRelationsForWrite,
} from "../../../domain/relations";
import type {
  CompatibilityStore,
  ItemWriteOptions,
} from "../../../domain/storage";
import {
  normalizeItemBatchTagsForWrite,
  normalizeItemTagsForWrite,
} from "../../../domain/tags";
import { getRequestUserID } from "./auth";
import { attachItemMeta } from "./item-meta";
import {
  fillItemTemplateFields,
  isFieldItemChange,
  isOnlyNonFieldItemChange,
  isTmpZoteroClientDateModifiedHack,
  normalizeAnnotationForWrite,
  normalizeItemLastReadForWrite,
  stripNullAttachmentStorageProps,
  stripVersionForCompare,
  validateAnnotationParentForWrite,
  validateAttachmentForWrite,
  validateItemBatchAnnotationParentsForWrite,
  validateItemBatchAnnotationsForWrite,
  validateItemBatchCreatorsForWrite,
  validateItemBatchFieldLengthsForWrite,
  validateItemBatchParentsForWrite,
  validateItemBatchPublicationsForWrite,
  validateItemCreatorsForWrite,
  validateItemNoteFieldForWrite,
  validateItemParentForWrite,
  validateItemTypeAndFieldUseForWrite,
} from "./item-validation";
import { getIfUnmodifiedSinceVersion } from "./request-versions";
import { normalizeItemTimestampsForWrite, nowISOTimestamp } from "./timestamps";
import { isRecord, jsonValuesEqual } from "./values";
import { handleWebTranslationWrite } from "./web-translation";
import {
  collectionFailureResponse,
  hasDirectCollections,
  isChildItemData,
  mergeItemUpdate,
  normalizeItemDeletedForWrite,
  normalizeItemParentForWrite,
} from "./write-helpers";
import {
  buildWriteReport,
  checkSingleObjectWriteVersion,
  type ExistingObjectVersions,
  evaluateBatchWritePreconditions,
  type ItemWriteFailures,
  mergeItemWriteFailures,
} from "./write-preconditions";

const isOnlyServerReverseRelationChange = (
  next: Record<string, unknown>,
  existing: Record<string, unknown>,
  libraryType: "group" | "user",
  libraryID: number,
  batchItems: Record<string, unknown>[]
): boolean => {
  const itemKey = typeof next.key === "string" ? next.key : "";
  if (!itemKey) {
    return false;
  }

  const withoutRelations = (data: Record<string, unknown>) => {
    const { relations: _relations, ...rest } = stripVersionForCompare(data);
    return rest;
  };
  if (!jsonValuesEqual(withoutRelations(next), withoutRelations(existing))) {
    return false;
  }

  const existingRelations = isRecord(existing.relations)
    ? existing.relations
    : {};
  const nextRelations = isRecord(next.relations) ? next.relations : {};
  const existingValues = getRelationValueSet(existingRelations["dc:relation"]);
  const nextValues = getRelationValueSet(nextRelations["dc:relation"]);
  if ([...existingValues].some((value) => !nextValues.has(value))) {
    return false;
  }

  const added = [...nextValues].filter((value) => !existingValues.has(value));
  if (!added.length) {
    return false;
  }

  const itemURI = getSameLibraryItemURI(libraryType, libraryID, itemKey);
  return added.every((targetURI) => {
    const targetKey = parseSameLibraryItemURI(
      targetURI,
      libraryType,
      libraryID
    );
    if (!targetKey) {
      return false;
    }
    const target = batchItems.find((item) => item.key === targetKey);
    const targetRelations = isRecord(target?.relations) ? target.relations : {};
    return getRelationValueSet(targetRelations["dc:relation"]).has(itemURI);
  });
};

const getRelationValueSet = (value: unknown): Set<string> => {
  if (typeof value === "string") {
    return new Set([value]);
  }
  if (Array.isArray(value)) {
    return new Set(
      value.filter((entry): entry is string => typeof entry === "string")
    );
  }
  return new Set();
};

const getSameLibraryItemURI = (
  libraryType: "group" | "user",
  libraryID: number,
  itemKey: string
) =>
  libraryType === "user"
    ? `http://zotero.org/users/${libraryID}/items/${itemKey}`
    : `http://zotero.org/groups/${libraryID}/items/${itemKey}`;

const parseSameLibraryItemURI = (
  uri: string,
  libraryType: "group" | "user",
  libraryID: number
): string | null => {
  const prefix =
    libraryType === "user"
      ? `http://zotero.org/users/${libraryID}/items/`
      : `http://zotero.org/groups/${libraryID}/items/`;
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
};

// Shared batch item POST pipeline for user and group libraries, implementing
// the official multi-object write contract: invalid entries fail per-index,
// existing objects get PATCH-merge semantics, false-marker fields normalize
// after the merge, unchanged uploads land in `unchanged` without a version
// bump, and per-object failures don't abort the rest of the batch.
export const handleItemBatchWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  const body = await c.req.json().catch(() => null);
  const translationResponse = await handleWebTranslationWrite(c, {
    body,
    libraryID: input.libraryID,
    libraryType: input.libraryType,
    store: input.store,
  });
  if (translationResponse) {
    return translationResponse;
  }
  if (!Array.isArray(body)) {
    return c.text("Uploaded data must be a JSON array", 400);
  }

  const itemFailures: ItemWriteFailures = {};
  const rawItems: Record<string, unknown>[] = (body as unknown[]).map(
    (entry, index) => {
      if (isRecord(entry)) {
        const envelopeData = isRecord(entry.data) ? entry.data : null;
        if (envelopeData) {
          return {
            ...envelopeData,
            ...(typeof entry.key === "string" ? { key: entry.key } : {}),
            ...(typeof entry.version === "number"
              ? { version: entry.version }
              : {}),
          };
        }
        return { ...(entry as Record<string, unknown>) };
      }
      itemFailures[index] = {
        code: 400,
        message: `Invalid value for index ${index} in uploaded data; expected JSON item object`,
      };
      return {};
    }
  );

  const library =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);
  const existingVersions: ExistingObjectVersions = new Map(
    library.items.map((item) => [
      item.key,
      { data: item.data ?? {}, version: item.version ?? 0 },
    ])
  );
  const precondition = evaluateBatchWritePreconditions(
    rawItems,
    existingVersions,
    library.version,
    getIfUnmodifiedSinceVersion(c),
    "Item"
  );
  if (precondition.libraryPreconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${library.version}`,
    });
  }
  mergeItemWriteFailures(itemFailures, precondition.failed);

  const now = nowISOTimestamp();
  const actorUserID =
    input.libraryType === "group" ? await getRequestUserID(c) : null;
  const tmpZoteroClientDateModifiedHack = isTmpZoteroClientDateModifiedHack(c);
  const finalItems: Record<string, unknown>[] = rawItems.map(
    (object, index) => {
      const key = typeof object.key === "string" ? object.key : "";
      const current = key ? existingVersions.get(key) : undefined;
      stripNullAttachmentStorageProps(object, current?.data);
      const merged = current
        ? mergeItemUpdate(current.data, object, key, true)
        : { ...object };
      const normalized = normalizeItemParentForWrite(
        normalizeItemDeletedForWrite(merged)
      );
      fillItemTemplateFields(normalized, !current);
      const lastReadFailure = normalizeItemLastReadForWrite(
        normalized,
        input.libraryType
      );
      if (lastReadFailure && !(index in itemFailures)) {
        itemFailures[index] = lastReadFailure;
      }
      const itemTypeFailure = validateItemTypeAndFieldUseForWrite(normalized);
      if (itemTypeFailure && !(index in itemFailures)) {
        itemFailures[index] = itemTypeFailure;
      }
      const noteFieldFailure = validateItemNoteFieldForWrite(normalized);
      if (noteFieldFailure && !(index in itemFailures)) {
        itemFailures[index] = noteFieldFailure;
      }
      const attachmentFailure = validateAttachmentForWrite(
        normalized,
        object,
        current?.data,
        input.libraryType
      );
      if (attachmentFailure && !(index in itemFailures)) {
        itemFailures[index] = attachmentFailure;
      }
      const timestampFailure = normalizeItemTimestampsForWrite(
        normalized,
        current?.data,
        now,
        {
          preserveDateModified: isOnlyNonFieldItemChange(
            normalized,
            current?.data
          ),
          tmpZoteroClientDateModifiedHack,
        }
      );
      if (timestampFailure && !(index in itemFailures)) {
        itemFailures[index] = timestampFailure;
      }
      return normalized;
    }
  );

  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchPublicationsForWrite(finalItems, input.libraryType)
  );
  mergeItemWriteFailures(
    itemFailures,
    normalizeItemBatchTagsForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchNotesForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchRelationsForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchCreatorsForWrite(finalItems, true)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchAnnotationsForWrite(finalItems)
  );
  mergeItemWriteFailures(
    itemFailures,
    validateItemBatchFieldLengthsForWrite(finalItems)
  );
  const annotationParentResult =
    await validateItemBatchAnnotationParentsForWrite(
      input.store,
      input.libraryType,
      input.libraryID,
      finalItems
    );
  mergeItemWriteFailures(itemFailures, annotationParentResult.failures);
  await validateItemBatchParentsForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    finalItems,
    itemFailures
  );

  const unchanged: Record<string, string> = { ...precondition.unchanged };
  const toWrite: Array<{ index: number; object: Record<string, unknown> }> = [];
  const updateLastModifiedByUserIDByKey: Record<string, boolean> = {};
  for (const entry of precondition.toWrite) {
    if (entry.index in itemFailures) {
      continue;
    }
    const final = finalItems[entry.index];
    if (!final) {
      continue;
    }
    const key = typeof final.key === "string" ? final.key : "";
    const current = key ? existingVersions.get(key) : undefined;
    if (
      current &&
      jsonValuesEqual(
        stripVersionForCompare(final),
        stripVersionForCompare(current.data)
      )
    ) {
      unchanged[entry.index] = key;
      continue;
    }
    if (
      key &&
      current &&
      isOnlyServerReverseRelationChange(
        final,
        current.data,
        input.libraryType,
        input.libraryID,
        toWrite.map((written) => written.object)
      )
    ) {
      unchanged[entry.index] = key;
      continue;
    }
    if (key && current && isFieldItemChange(final, current.data)) {
      updateLastModifiedByUserIDByKey[key] = true;
    }
    toWrite.push({ index: entry.index, object: final });
  }

  const missingCollectionKeys = await createCollectionStore(
    c.env
  ).findMissingCollectionKeys(
    input.libraryType,
    input.libraryID,
    toWrite.map((entry) => entry.object)
  );
  if (missingCollectionKeys.length) {
    return collectionFailureResponse(c, missingCollectionKeys, library.version);
  }

  const writeToken = c.req.header("Zotero-Write-Token");
  const writeOptions: ItemWriteOptions = {
    actorUserID,
    ifUnmodifiedSinceVersion: getIfUnmodifiedSinceVersion(c),
    updateLastModifiedByUserIDByKey,
  };
  const result = toWrite.length
    ? input.libraryType === "user"
      ? await input.store.createItems(
          input.libraryID,
          toWrite.map((entry) => entry.object),
          writeToken,
          writeOptions
        )
      : await input.store.createGroupItems(
          input.libraryID,
          toWrite.map((entry) => entry.object),
          writeToken,
          writeOptions
        )
    : {
        duplicateWriteToken: false,
        success: [] as string[],
        successful: [] as never[],
        version: library.version,
      };

  if (result.duplicateWriteToken) {
    return c.text("Write token has already been used", 412);
  }
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${result.version}`,
    });
  }

  const relationVersion = await syncRelatedItemRelations(
    {
      libraryID: input.libraryID,
      libraryType: input.libraryType,
      store: input.store,
    },
    result.successful
  );
  const version = relationVersion ?? result.version;

  const postLibrary =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);
  const enrichedSuccessful = await Promise.all(
    result.successful.map((item) =>
      attachItemMeta(c, item, {
        allItems: postLibrary.items,
        libraryID: input.libraryID,
        libraryType: input.libraryType,
        store: input.store,
      })
    )
  );

  return c.json(
    buildWriteReport(toWrite, enrichedSuccessful, itemFailures, unchanged),
    200,
    {
      "Last-Modified-Version": `${version}`,
      ...(result.successful.length > 0
        ? libraryUpdateNotificationHeaders(
            input.libraryType,
            input.libraryID,
            version,
            ...(input.libraryType === "user" &&
            result.successful.some((item) => item.data.inPublications === true)
              ? [topicPublicationsUpdatedNotification(input.libraryID)]
              : [])
          )
        : {}),
    }
  );
};

export const syncRelatedItemRelations = async (
  input: {
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  },
  writtenItems: Array<{
    data: Record<string, unknown>;
    key: string;
    version: number;
  }>
): Promise<number | null> => {
  const library =
    input.libraryType === "user"
      ? await input.store.listItems(input.libraryID)
      : await input.store.listGroupItems(input.libraryID);
  const updates = getRelatedItemReverseUpdates(
    input.libraryType,
    input.libraryID,
    writtenItems,
    library.items
  );

  if (updates.length === 0) {
    return null;
  }

  if (input.libraryType === "user") {
    const result = await input.store.createItems(input.libraryID, updates);
    return result.version;
  }

  const result = await input.store.createGroupItems(input.libraryID, updates);
  return result.version;
};

export const updateItemInLibrary = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    itemKey: string;
    libraryID: number;
    libraryType: "group" | "user";
    patchMode: boolean;
    store: CompatibilityStore;
  }
) => {
  const existingResult =
    input.libraryType === "user"
      ? await input.store.getItem(input.libraryID, input.itemKey)
      : await input.store.getGroupItem(input.libraryID, input.itemKey);
  const existing = existingResult?.items[0];
  const body = await c.req.json().catch(() => null);
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return c.text("Invalid item JSON", 400);
  }

  const versionCheck = checkSingleObjectWriteVersion(
    c,
    "Item",
    existing ? (existing.version ?? 0) : null,
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
  const editable = versionCheck.editable;

  const data = normalizeItemDeletedForWrite(
    mergeItemUpdate(
      existing?.data ?? {},
      editable,
      input.itemKey,
      input.patchMode
    )
  );
  if (
    input.patchMode &&
    !("parentItem" in editable) &&
    hasDirectCollections(data)
  ) {
    delete data.parentItem;
  }
  fillItemTemplateFields(data, !existing);
  const lastReadFailure = normalizeItemLastReadForWrite(
    data,
    input.libraryType
  );
  if (lastReadFailure) {
    return c.text(lastReadFailure.message, 400);
  }
  const itemTypeFailure = validateItemTypeAndFieldUseForWrite(data);
  if (itemTypeFailure) {
    return c.text(
      itemTypeFailure.message,
      itemTypeFailure.code as ContentfulStatusCode
    );
  }
  const noteFieldFailure = validateItemNoteFieldForWrite(data);
  if (noteFieldFailure) {
    return c.text(noteFieldFailure.message, 400);
  }
  const attachmentFailure = validateAttachmentForWrite(
    data,
    editable,
    existing?.data,
    input.libraryType
  );
  if (attachmentFailure) {
    return c.text(attachmentFailure.message, 400);
  }

  // A write that changes nothing effective must not bump the object version.
  if (
    existing &&
    jsonValuesEqual(
      stripVersionForCompare(data),
      stripVersionForCompare(existing.data ?? {})
    )
  ) {
    return c.body(null, 204, {
      "Last-Modified-Version": `${existing.version ?? 0}`,
    });
  }

  const timestampFailure = normalizeItemTimestampsForWrite(
    data,
    existing?.data,
    nowISOTimestamp(),
    {
      preserveDateModified: isOnlyNonFieldItemChange(data, existing?.data),
      tmpZoteroClientDateModifiedHack: isTmpZoteroClientDateModifiedHack(c),
    }
  );
  if (timestampFailure) {
    return c.text(timestampFailure.message, 400);
  }
  normalizeItemParentForWrite(data);
  const tagFailure = normalizeItemTagsForWrite(data);
  if (tagFailure) {
    return c.text(tagFailure.message, tagFailure.code);
  }
  const noteFailure = validateItemNoteForWrite(data);
  if (noteFailure) {
    return c.text(noteFailure.message, noteFailure.code);
  }
  const relationFailure = validateObjectRelationsForWrite(data, "item");
  if (relationFailure) {
    return c.text(relationFailure.message, relationFailure.code);
  }
  const creatorFailure = validateItemCreatorsForWrite(data, !existing);
  if (creatorFailure) {
    return c.text(
      creatorFailure.message,
      creatorFailure.code as ContentfulStatusCode
    );
  }
  const annotationFailure = normalizeAnnotationForWrite(data, existing?.data);
  if (annotationFailure) {
    return c.text(annotationFailure.message, annotationFailure.code as 400);
  }
  const annotationParentFailure = await validateAnnotationParentForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    data
  );
  if (annotationParentFailure) {
    return c.text(
      annotationParentFailure.message,
      annotationParentFailure.code as ContentfulStatusCode
    );
  }
  const itemParentFailure = await validateItemParentForWrite(
    input.store,
    input.libraryType,
    input.libraryID,
    data
  );
  if (itemParentFailure) {
    return c.text(
      itemParentFailure.message,
      itemParentFailure.code as ContentfulStatusCode
    );
  }
  if (isChildItemData(data) && hasDirectCollections(data)) {
    return c.text("Child items cannot be assigned to collections", 400);
  }

  const missingCollectionKeys = await createCollectionStore(
    c.env
  ).findMissingCollectionKeys(input.libraryType, input.libraryID, [data]);
  if (missingCollectionKeys.length) {
    return c.text(`Collection ${missingCollectionKeys[0]} not found`, 409);
  }

  const result =
    input.libraryType === "user"
      ? await input.store.createItems(input.libraryID, [data], undefined, {
          actorUserID: null,
        })
      : await input.store.createGroupItems(input.libraryID, [data], undefined, {
          actorUserID: await getRequestUserID(c),
          updateLastModifiedByUserIDByKey:
            existing && isFieldItemChange(data, existing.data)
              ? { [input.itemKey]: true }
              : {},
        });
  if (result.preconditionFailed) {
    return c.text("Library has been modified", 412, {
      "Last-Modified-Version": `${result.version}`,
    });
  }
  const relationVersion = await syncRelatedItemRelations(
    input,
    result.successful
  );
  const version = relationVersion ?? result.version;

  return c.body(null, 204, {
    "Last-Modified-Version": `${version}`,
    ...libraryUpdateNotificationHeaders(
      input.libraryType,
      input.libraryID,
      version
    ),
  });
};
