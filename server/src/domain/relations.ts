import type { ItemRecord } from "./state";

type LibraryType = "group" | "user";
type RelationObjectType = "collection" | "item";

export interface RelationValidationFailure {
  code: 400;
  message: string;
}

const supportedPredicates = new Set([
  "dc:isReplacedBy",
  "dc:relation",
  "dc:replaces",
  "owl:sameAs",
]);
const collectionStringPredicates = new Set(["mendeleyDB:remoteFolderUUID"]);

export const validateObjectRelationsForWrite = (
  data: Record<string, unknown>,
  objectType: RelationObjectType
): RelationValidationFailure | null => {
  if (!("relations" in data)) {
    return null;
  }

  if (!isPlainObject(data.relations)) {
    return {
      code: 400,
      message: "'relations' property must be an object",
    };
  }

  for (const [predicate, value] of Object.entries(data.relations)) {
    if (!supportedPredicates.has(predicate)) {
      if (
        objectType === "collection" &&
        collectionStringPredicates.has(predicate)
      ) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some((entry) => typeof entry !== "string")) {
          return {
            code: 400,
            message: `'relations' values currently must be strings`,
          };
        }
        continue;
      }
      return {
        code: 400,
        message: `Unsupported predicate '${predicate}'`,
      };
    }

    const values = Array.isArray(value) ? value : [value];
    if (
      values.some(
        (entry) =>
          typeof entry !== "string" || !isZoteroObjectURI(entry, objectType)
      )
    ) {
      return {
        code: 400,
        message: `'relations' values currently must be Zotero ${objectType} URIs`,
      };
    }
  }

  normalizeRelationValues(data.relations);
  return null;
};

export const validateItemBatchRelationsForWrite = (
  objects: Record<string, unknown>[]
): Record<string, RelationValidationFailure> => {
  const failed: Record<string, RelationValidationFailure> = {};

  objects.forEach((object, index) => {
    const failure = validateObjectRelationsForWrite(object, "item");
    if (failure) {
      failed[index] = failure;
    }
  });

  return failed;
};

export const getRelatedItemReverseUpdates = (
  libraryType: LibraryType,
  libraryID: number,
  writtenItems: ItemRecord[],
  allItems: ItemRecord[]
): Record<string, unknown>[] => {
  const byKey = new Map(allItems.map((item) => [item.key, item]));
  const updates = new Map<string, Record<string, unknown>>();

  for (const source of writtenItems) {
    const sourceURI = getItemURI(libraryType, libraryID, source.key);
    for (const targetURI of getRelationValues(
      source.data.relations,
      "dc:relation"
    )) {
      const targetKey = parseSameLibraryItemKey(
        targetURI,
        libraryType,
        libraryID
      );
      if (!targetKey || targetKey === source.key) {
        continue;
      }

      const target = byKey.get(targetKey);
      if (!target) {
        continue;
      }

      const nextData = updates.get(targetKey) ?? { ...target.data };
      const relations = isPlainObject(nextData.relations)
        ? { ...nextData.relations }
        : {};
      relations["dc:relation"] = addRelationValue(
        relations["dc:relation"],
        sourceURI
      );
      nextData.relations = relations;
      nextData.key = targetKey;
      nextData.version = target.version;
      updates.set(targetKey, nextData);
    }
  }

  return [...updates.values()];
};

const normalizeRelationValues = (relations: Record<string, unknown>) => {
  for (const [predicate, value] of Object.entries(relations)) {
    if (Array.isArray(value)) {
      const unique = [
        ...new Set(
          value.filter((entry): entry is string => typeof entry === "string")
        ),
      ];
      relations[predicate] = unique.length === 1 ? unique[0] : unique;
    }
  }
};

const addRelationValue = (
  existing: unknown,
  value: string
): string | string[] => {
  const values = getRelationValues({ relation: existing }, "relation");
  if (!values.includes(value)) {
    values.push(value);
  }

  return values.length === 1 ? (values[0] ?? values) : values;
};

const getRelationValues = (relations: unknown, predicate: string): string[] => {
  if (!isPlainObject(relations)) {
    return [];
  }

  const value = relations[predicate];
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  return [];
};

const getItemURI = (
  libraryType: LibraryType,
  libraryID: number,
  itemKey: string
) =>
  libraryType === "user"
    ? `http://zotero.org/users/${libraryID}/items/${itemKey}`
    : `http://zotero.org/groups/${libraryID}/items/${itemKey}`;

const parseSameLibraryItemKey = (
  uri: string,
  libraryType: LibraryType,
  libraryID: number
): string | null => {
  const prefix =
    libraryType === "user"
      ? `http://zotero.org/users/${libraryID}/items/`
      : `http://zotero.org/groups/${libraryID}/items/`;

  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
};

const isZoteroObjectURI = (value: string, objectType: RelationObjectType) => {
  const segment = objectType === "item" ? "items" : "collections";
  return new RegExp(
    `^https?://zotero\\.org/(users|groups)/\\d+/${segment}/[A-Z0-9]{8}$`
  ).test(value);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
