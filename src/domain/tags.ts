import type { ItemRecord } from "./state";

type TagFailureCode = 400 | 413;

export interface TagRecord {
  meta: {
    numItems: number;
    type: number;
  };
  tag: string;
}

export interface TagValidationFailure {
  code: TagFailureCode;
  data?: Record<string, unknown>;
  message: string;
}

export interface ItemRequestFilterOptions {
  allItems?: ItemRecord[];
  fullTextContent?: Map<string, string>;
  includeChildFullText?: boolean;
}

const maxTagLength = 255;

export const normalizeItemTagsForWrite = (
  data: Record<string, unknown>
): TagValidationFailure | null => {
  if (!("tags" in data)) {
    return null;
  }

  if (!Array.isArray(data.tags)) {
    return {
      code: 400,
      message: "'tags' must be an array",
    };
  }

  const normalized: Record<string, unknown>[] = [];

  for (const tagObject of data.tags) {
    if (!isPlainObject(tagObject)) {
      return {
        code: 400,
        message: "Tag must be an object",
      };
    }

    const rawTag = tagObject.tag;
    const tag = typeof rawTag === "string" ? rawTag.trim() : "";
    if (!tag) {
      continue;
    }

    if ([...tag].length > maxTagLength) {
      return {
        code: 413,
        data: { tag: rawTag },
        message: "Tag is too long",
      };
    }

    normalized.push({
      ...tagObject,
      tag,
    });
  }

  data.tags = normalized;
  return null;
};

export const normalizeItemBatchTagsForWrite = (
  objects: Record<string, unknown>[]
): Record<string, TagValidationFailure> => {
  const failed: Record<string, TagValidationFailure> = {};

  objects.forEach((object, index) => {
    const failure = normalizeItemTagsForWrite(object);
    if (failure) {
      failed[index] = failure;
    }
  });

  return failed;
};

export const filterItemsForItemRequest = (
  items: ItemRecord[],
  params: URLSearchParams,
  options: ItemRequestFilterOptions = {}
): ItemRecord[] => {
  let filtered = items;

  const tagExpressions = params.getAll("tag").filter(Boolean);
  if (tagExpressions.length > 0) {
    filtered = filtered.filter((item) =>
      itemMatchesTagExpressions(item, tagExpressions)
    );
  }

  const q = params.get("q");
  if (q) {
    filtered = filterItemsByQuery(filtered, q, params.get("qmode"), options);
  }

  const itemKeys = params.get("itemKey")?.split(",").filter(Boolean);
  if (itemKeys?.length) {
    const requestedKeys = new Set(itemKeys);
    filtered = filtered.filter((item) => requestedKeys.has(item.key));
  }

  const itemType = params.get("itemType");
  if (itemType) {
    if (itemType.startsWith("-")) {
      const excludedItemType = itemType.slice(1);
      filtered = filtered.filter(
        (item) =>
          item.data.itemType !== excludedItemType &&
          item.data.itemType !== "annotation"
      );
    } else {
      filtered = filtered.filter((item) => item.data.itemType === itemType);
    }
  }

  return filtered;
};

export const filterTopItems = (items: ItemRecord[]): ItemRecord[] =>
  items.filter((item) => typeof item.data.parentItem !== "string");

export const listTagsForRequest = (
  items: ItemRecord[],
  params: URLSearchParams
): TagRecord[] => {
  let filteredItems = items;

  const itemTagExpressions = params.getAll("itemTag").filter(Boolean);
  if (itemTagExpressions.length > 0) {
    filteredItems = filteredItems.filter((item) =>
      itemMatchesTagExpressions(item, itemTagExpressions)
    );
  }

  const itemQ = params.get("itemQ");
  if (itemQ) {
    filteredItems = filterItemsByQuery(
      filteredItems,
      itemQ,
      params.get("itemQMode")
    );
  }

  const itemKeys = params.get("itemKey")?.split(",").filter(Boolean);
  if (itemKeys?.length) {
    const requestedKeys = new Set(itemKeys);
    filteredItems = filteredItems.filter((item) => requestedKeys.has(item.key));
  }

  const itemType = params.get("itemType");
  if (itemType) {
    filteredItems = filteredItems.filter(
      (item) => item.data.itemType === itemType
    );
  }

  const since = parseVersionParam(params.get("since") ?? params.get("newer"));
  const tagFilterExpressions = params.getAll("tag").filter(Boolean);
  const q = params.get("q");
  const qmode = params.get("qmode");
  const tags = collectTags(filteredItems);

  return tags
    .filter((tag) => since === null || tag.version > since)
    .filter(
      (tag) =>
        tagFilterExpressions.length === 0 ||
        tagNameMatchesExpressions(tag.tag, tagFilterExpressions)
    )
    .filter((tag) => !q || tagNameMatchesQuery(tag.tag, q, qmode))
    .sort((left, right) => left.tag.localeCompare(right.tag))
    .map(({ version: _version, ...tag }) => tag);
};

export const removeTagsFromItems = (
  items: ItemRecord[],
  tagExpressions: string[]
): Record<string, unknown>[] => {
  const tagNames = expandTagExpressions(tagExpressions).map((tag) =>
    tag.toLocaleLowerCase()
  );
  if (tagNames.length === 0) {
    return [];
  }

  return items.flatMap((item) => {
    const tags = getItemTags(item);
    const nextTags = tags.filter(
      (tagObject) => !tagNames.includes(tagObject.tag.toLocaleLowerCase())
    );

    if (nextTags.length === tags.length) {
      return [];
    }

    return [
      {
        ...item.data,
        key: item.key,
        tags: nextTags,
        version: item.version,
      },
    ];
  });
};

const collectTags = (
  items: ItemRecord[]
): Array<TagRecord & { version: number }> => {
  const tags = new Map<string, TagRecord & { version: number }>();

  for (const item of items) {
    for (const tagObject of getItemTags(item)) {
      const normalized = tagObject.tag.toLocaleLowerCase();
      const existing = tags.get(normalized);
      const type = typeof tagObject.type === "number" ? tagObject.type : 0;

      if (existing) {
        existing.meta.numItems += 1;
        existing.version = Math.min(existing.version, item.version);
        existing.meta.type = Math.min(existing.meta.type, type);
        continue;
      }

      tags.set(normalized, {
        meta: {
          numItems: 1,
          type,
        },
        tag: tagObject.tag,
        version: item.version,
      });
    }
  }

  return [...tags.values()];
};

const getItemTags = (
  item: ItemRecord
): Array<Record<string, unknown> & { tag: string }> => {
  if (!Array.isArray(item.data.tags)) {
    return [];
  }

  return item.data.tags.filter(
    (tagObject): tagObject is Record<string, unknown> & { tag: string } =>
      isPlainObject(tagObject) &&
      typeof tagObject.tag === "string" &&
      tagObject.tag.trim().length > 0
  );
};

const itemMatchesTagExpressions = (
  item: ItemRecord,
  expressions: string[]
): boolean => {
  const itemTags = new Set(
    getItemTags(item).map((tagObject) => tagObject.tag.toLocaleLowerCase())
  );
  const hasNegation = hasNegatedTagExpressions(expressions);

  if (hasNegation && item.data.itemType === "annotation") {
    return false;
  }

  return expressions.every((expression) =>
    expression.split(" || ").some((term) => {
      const trimmed = term.trim();
      const negated = trimmed.startsWith("-");
      const tag = (negated ? trimmed.slice(1) : trimmed).toLocaleLowerCase();

      return negated ? !itemTags.has(tag) : itemTags.has(tag);
    })
  );
};

export const hasNegatedTagExpressions = (expressions: string[]): boolean =>
  expressions.some((expression) =>
    expression.split(" || ").some((term) => term.trim().startsWith("-"))
  );

export const itemMatchesTagFilterExpressions = itemMatchesTagExpressions;

const tagNameMatchesExpressions = (
  tagName: string,
  expressions: string[]
): boolean => {
  const normalized = tagName.toLocaleLowerCase();

  return expressions.some((expression) =>
    expression
      .split(" || ")
      .some((term) => term.trim().toLocaleLowerCase() === normalized)
  );
};

const expandTagExpressions = (expressions: string[]): string[] =>
  expressions.flatMap((expression) =>
    expression
      .split(" || ")
      .map((term) => term.trim())
      .filter(Boolean)
  );

const filterItemsByQuery = (
  items: ItemRecord[],
  query: string,
  qmode?: string | null,
  options: ItemRequestFilterOptions = {}
): ItemRecord[] => {
  const normalizedQuery = query.toLocaleLowerCase();

  return items.filter((item) => {
    const searchable = [
      item.data.title,
      item.data.note,
      item.data.itemType,
      item.data.date,
      item.key,
      ...getCreatorSearchableValues(item),
      ...getFullTextSearchableValues(item, options),
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLocaleLowerCase());

    if (qmode === "startswith") {
      return searchable.some((value) => value.startsWith(normalizedQuery));
    }

    return getQueryTerms(normalizedQuery).every((term) =>
      searchable.some((value) => value.includes(term))
    );
  });
};

const getCreatorSearchableValues = (item: ItemRecord): string[] => {
  if (!Array.isArray(item.data.creators)) {
    return [];
  }

  return item.data.creators.flatMap((creator) => {
    if (!isPlainObject(creator)) {
      return [];
    }

    return [creator.name, creator.firstName, creator.lastName].filter(
      (value): value is string => typeof value === "string"
    );
  });
};

const getQueryTerms = (query: string): string[] => {
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1] ?? ""
  );
  if (phrases.length) {
    return phrases;
  }

  return query.split(/\s+/).filter(Boolean);
};

const getFullTextSearchableValues = (
  item: ItemRecord,
  options: ItemRequestFilterOptions
): string[] => {
  if (!options.fullTextContent) {
    return [];
  }

  const keys = new Set([item.key]);
  if (options.includeChildFullText) {
    for (const candidate of options.allItems ?? []) {
      if (candidate.data.parentItem === item.key) {
        keys.add(candidate.key);
      }
    }
  }

  return [...keys]
    .map((key) => options.fullTextContent?.get(key))
    .filter((value): value is string => typeof value === "string");
};

const tagNameMatchesQuery = (
  tagName: string,
  query: string,
  qmode?: string | null
): boolean => {
  const normalizedTag = tagName.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();

  return qmode === "startswith"
    ? normalizedTag.startsWith(normalizedQuery)
    : normalizedTag.includes(normalizedQuery);
};

const parseVersionParam = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const version = Number.parseInt(value, 10);
  return Number.isFinite(version) ? version : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
