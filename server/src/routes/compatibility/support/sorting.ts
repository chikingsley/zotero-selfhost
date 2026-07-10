import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { noteToTitle } from "../../../domain/notes";
import { isRecord } from "./values";

export const sortItemsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>,
  defaultField = "dateModified"
) =>
  sortRecordsForRequest(
    c,
    items,
    (item, field) => getItemSortValue(item, field),
    defaultField,
    (item) => item.key
  );

export const sortRecordsForRequest = <T>(
  c: Context<{ Bindings: Bindings }>,
  records: T[],
  getValue: (record: T, field: string) => number | string,
  defaultField = "dateModified",
  getKey?: (record: T) => string
): T[] => {
  const sortParam = c.req.query("sort");
  const orderParam = c.req.query("order");
  const directionParam = c.req.query("direction");
  const sortIsDirection = sortParam === "asc" || sortParam === "desc";
  const orderIsDirection = orderParam === "asc" || orderParam === "desc";
  const field =
    sortParam && !sortIsDirection
      ? sortParam
      : orderParam && !orderIsDirection
        ? orderParam
        : defaultField;

  // order=itemKeyList / collectionKeyList / searchKeyList: return objects in
  // the order their keys appear in the corresponding key-list query param.
  if (field.endsWith("KeyList") && getKey) {
    const requested = (c.req.query(field.slice(0, -4)) ?? "")
      .split(",")
      .map((key) => key.trim());
    const position = new Map(requested.map((key, index) => [key, index]));
    return [...records].sort(
      (left, right) =>
        (position.get(getKey(left)) ?? Number.POSITIVE_INFINITY) -
        (position.get(getKey(right)) ?? Number.POSITIVE_INFINITY)
    );
  }
  const explicitDirection =
    directionParam ??
    (sortIsDirection ? sortParam : null) ??
    (orderIsDirection ? orderParam : null);
  const direction =
    explicitDirection === "asc"
      ? 1
      : explicitDirection === "desc"
        ? -1
        : field === "title" ||
            field === "creator" ||
            field === "itemType" ||
            field === "name"
          ? 1
          : -1;

  return [...records].sort((left, right) => {
    const leftValue = getValue(left, field);
    const rightValue = getValue(right, field);
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : compareText(String(leftValue), String(rightValue));

    return comparison === 0 ? 0 : comparison * direction;
  });
};

export const getItemSortValue = (
  item: { data?: Record<string, unknown>; key: string; version?: number },
  field: string
): number | string => {
  switch (field) {
    case "creator":
      return getCreatorSortValue(item);
    case "date":
      return getDateSortValue(item.data?.date);
    case "dateAdded":
      return String(item.data?.dateAdded ?? item.version ?? "");
    case "itemType":
      return String(item.data?.itemType ?? "");
    case "title":
      return item.data?.itemType === "note" &&
        typeof item.data.note === "string"
        ? noteToTitle(item.data.note, true)
        : String(item.data?.title ?? item.data?.note ?? item.key);
    default:
      return String(item.data?.dateModified ?? item.version ?? "");
  }
};

export const getCreatorSortValue = (item: {
  data?: Record<string, unknown>;
  key: string;
}): string => {
  const creators = Array.isArray(item.data?.creators) ? item.data.creators : [];
  const creator = creators.find(isRecord);
  const value = creator
    ? String(creator.name ?? creator.lastName ?? creator.firstName ?? "")
    : "";

  return value || "\uffff";
};

export const getDateSortValue = (value: unknown): number | string => {
  if (typeof value !== "string" || value.trim() === "") {
    return "";
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : value;
};

export const compareText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
