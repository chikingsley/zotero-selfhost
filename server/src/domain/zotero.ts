import { randomString } from "../lib/random";
import {
  validAnnotationTypes,
  validAttachmentLinkModes,
  validItemTypes,
} from "./mappings";

const keyChars = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

export const generateZoteroKey = (): string => randomString(keyChars, 8);

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return Array.from(value)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 || code === 9 || code === 10 || code === 13;
      })
      .join("");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)])
    );
  }

  return value;
};

// Zotero object payloads are open-ended field bags. Return a record so callers
// can read arbitrary fields (itemType, parentItem, ...) without narrowing to the
// literal shape of whatever object literal was passed in.
export const sanitizeZoteroData = (value: unknown): Record<string, unknown> =>
  sanitizeValue(value) as Record<string, unknown>;

const cleanCreatorName = (value: unknown): string =>
  typeof value === "string" ? value.replaceAll("\uFEFF", "").trim() : "";

const getCreatorDisplayName = (creator: unknown): string => {
  if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
    return "";
  }

  const data = creator as Record<string, unknown>;
  return (
    cleanCreatorName(data.name) ||
    cleanCreatorName(data.lastName) ||
    cleanCreatorName(data.firstName)
  );
};

export const getCreatorSummary = (
  data?: Record<string, unknown>
): string | undefined => {
  const creators = Array.isArray(data?.creators) ? data.creators : [];
  const names = creators.map(getCreatorDisplayName).filter(Boolean);
  const first = names[0];
  if (!first) {
    return;
  }
  if (names.length === 1) {
    return first;
  }
  if (names.length === 2) {
    return `${first} and ${names[1]}`;
  }

  return `${first} et al.`;
};

export const isSupportedItemType = (itemType: string): boolean =>
  itemType === "annotation" || validItemTypes.has(itemType);

export const isSupportedAttachmentLinkMode = (linkMode: string): boolean =>
  validAttachmentLinkModes.has(linkMode);

export const isSupportedAnnotationType = (annotationType: string): boolean =>
  validAnnotationTypes.has(annotationType);

export const getItemTemplate = (
  itemType: string,
  linkMode?: string,
  annotationType?: string
): Record<string, unknown> => {
  if (itemType === "note") {
    return {
      collections: [],
      itemType: "note",
      note: "",
      relations: {},
      tags: [],
    };
  }

  if (itemType === "attachment") {
    const mode = linkMode ?? "imported_file";
    const template: Record<string, unknown> = {
      collections: [],
      contentType: "",
      itemType: "attachment",
      linkMode: mode,
      note: "",
      relations: {},
      tags: [],
      title: "",
    };

    if (mode.endsWith("_url")) {
      template.url = "";
    }
    if (mode === "linked_file") {
      template.path = "";
    }
    if (mode.startsWith("imported_") || mode === "embedded_image") {
      template.filename = "";
      template.md5 = null;
      template.mtime = null;
    }
    if (mode === "embedded_image") {
      template.parentItem = "";
      delete template.title;
      delete template.url;
      delete template.accessDate;
      delete template.tags;
      delete template.collections;
      delete template.relations;
      delete template.note;
      delete template.charset;
      delete template.path;
      return template;
    }

    template.charset = "";
    return template;
  }

  if (itemType === "annotation") {
    const type = annotationType ?? "highlight";
    const position: Record<string, unknown> =
      type === "ink"
        ? { pageIndex: 0, paths: [], width: 2 }
        : { pageIndex: 0, rects: [] };
    if (type === "image") {
      position.width = 0;
      position.height = 0;
    }

    const template: Record<string, unknown> = {
      annotationColor: "",
      annotationComment: "",
      annotationPageLabel: "",
      annotationPosition: position,
      annotationSortIndex: "00000|000000|00000",
      annotationType: type,
      itemType: "annotation",
      parentItem: "",
      tags: [],
    };
    if (type === "highlight" || type === "underline") {
      template.annotationText = "";
    }
    return template;
  }

  const template: Record<string, unknown> = {
    collections: [],
    creators: [{ creatorType: "author", firstName: "", lastName: "" }],
    itemType,
    relations: {},
    tags: [],
    title: "",
  };

  if (itemType === "computerProgram") {
    template.versionNumber = "";
    template.programmingLanguage = "";
  }

  return template;
};
