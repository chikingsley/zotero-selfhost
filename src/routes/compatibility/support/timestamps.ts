const zoteroMonths: Record<string, number> = {
  apr: 4,
  april: 4,
  aug: 8,
  august: 8,
  dec: 12,
  december: 12,
  feb: 2,
  february: 2,
  jan: 1,
  january: 1,
  jul: 7,
  july: 7,
  jun: 6,
  june: 6,
  mar: 3,
  march: 3,
  may: 5,
  nov: 11,
  november: 11,
  oct: 10,
  october: 10,
  sep: 9,
  sept: 9,
  september: 9,
};

const pad2 = (value: number) => `${value}`.padStart(2, "0");

// Minimal port of Zotero's date parsing for meta.parsedDate: returns
// 'YYYY', 'YYYY-MM', or 'YYYY-MM-DD', or null when unparseable.
export const parseZoteroDate = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }

  let match = text.match(/^(\d{4})$/);
  if (match) {
    return match[1] ?? null;
  }
  match = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (match) {
    const month = Number(match[2]);
    const day = match[3] ? Number(match[3]) : null;
    if (month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) {
      return null;
    }
    return day === null
      ? `${match[1]}-${pad2(month)}`
      : `${match[1]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[1] ?? "").toLowerCase()];
    const day = Number(match[2]);
    if (!month || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^(\d{1,2})\.?\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[2] ?? "").toLowerCase()];
    const day = Number(match[1]);
    if (!month || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  match = text.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (match) {
    const month = zoteroMonths[(match[1] ?? "").toLowerCase()];
    if (!month) {
      return null;
    }
    return `${match[2]}-${pad2(month)}`;
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    return `${match[3]}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
};

export const nowISOTimestamp = (): string =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Normalizes a Zotero timestamp field value to ISO 8601 UTC ('...Z').
// Accepts ISO 8601 (with Z or numeric offset), UTC SQL format
// 'YYYY-MM-DD[ hh:mm:ss]', or 'CURRENT_TIMESTAMP'. Returns null when invalid.
export const normalizeZoteroTimestamp = (
  value: string,
  now: string
): string | null => {
  const text = value.trim();
  if (text === "CURRENT_TIMESTAMP") {
    return now;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text)) {
    return text;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(text)) {
    const iso = text.includes(" ")
      ? `${text.replace(" ", "T")}Z`
      : `${text}T00:00:00Z`;
    return Number.isNaN(new Date(iso).getTime()) ? null : iso;
  }
  return null;
};

const timestampFormatError = (field: string, value: string) => ({
  code: 400,
  message: `'${field}' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]' format or 'CURRENT_TIMESTAMP' (${value})`,
});

// Write-side handling of accessDate/dateAdded/dateModified plus template
// fill for new items: invalid timestamps fail the object, dateAdded is
// preserved (normalized) or stamped, and dateModified is stamped with the
// current time unless the client supplies a NEW explicit value.
export const normalizeItemTimestampsForWrite = (
  data: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  now: string,
  options: {
    preserveDateModified?: boolean;
    tmpZoteroClientDateModifiedHack?: boolean;
  } = {}
): { code: number; message: string } | null => {
  for (const field of ["accessDate", "dateAdded", "dateModified"] as const) {
    const value = data[field];
    if (typeof value !== "string" || value === "") {
      continue;
    }
    const normalized = normalizeZoteroTimestamp(value, now);
    if (normalized === null) {
      return timestampFormatError(field, value);
    }
    data[field] = normalized;
  }

  if (!existing) {
    if (typeof data.dateAdded !== "string" || data.dateAdded === "") {
      data.dateAdded = now;
    }
    if (typeof data.dateModified !== "string" || data.dateModified === "") {
      data.dateModified = now;
    }
    return null;
  }

  const previous =
    typeof existing.dateModified === "string" ? existing.dateModified : "";
  const incoming =
    typeof data.dateModified === "string" ? data.dateModified : "";
  if (options.preserveDateModified) {
    data.dateModified = incoming || previous || now;
  } else if (options.tmpZoteroClientDateModifiedHack && incoming) {
    data.dateModified = incoming;
  } else if (!incoming || incoming === previous) {
    data.dateModified = now;
  }
  if (typeof data.dateAdded !== "string" || data.dateAdded === "") {
    const previousAdded =
      typeof existing.dateAdded === "string" ? existing.dateAdded : now;
    data.dateAdded = previousAdded;
  }
  return null;
};

// New items are stored with every valid field for their type present,
// defaulting to '' — and null values are treated as empty strings.
