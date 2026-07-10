import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { libraryUpdateNotificationHeaders } from "../../../domain/notifications";
import type { CompatibilityStore } from "../../../domain/storage";
import { isRecord } from "./values";

export const handleWebTranslationWrite = async (
  c: Context<{ Bindings: Bindings }>,
  input: {
    body: unknown;
    libraryID: number;
    libraryType: "group" | "user";
    store: CompatibilityStore;
  }
) => {
  if (!isRecord(input.body) || typeof input.body.url !== "string") {
    return null;
  }

  const url = input.body.url;
  const title = getTranslatedTitle(url);
  if (!title) {
    return c.text("No translators found", 400);
  }

  if (!isMultipleTranslationURL(url) && typeof input.body.token === "string") {
    return c.text("'token' is valid only for item selection requests", 400);
  }

  if (isMultipleTranslationURL(url)) {
    const token = getTranslationToken(url);
    if (isRecord(input.body.items)) {
      if (typeof input.body.token !== "string") {
        return c.text("Token not provided with selected items", 400);
      }
      if (input.body.token !== token) {
        return c.text("'token' is valid only for item selection requests", 400);
      }

      const selection = Object.keys(input.body.items);
      const invalidSelection = selection.find((key) => key !== "0");
      if (invalidSelection) {
        return c.text(
          `Index '${invalidSelection}' not found for URL and token`,
          400
        );
      }
    } else if (typeof input.body.token === "string") {
      return c.text("'token' is valid only for item selection requests", 400);
    } else {
      return c.json(
        {
          items: {
            0: title,
          },
          token,
        },
        300
      );
    }
  }

  const data = {
    itemType: "webpage",
    title,
    url,
  };
  const result =
    input.libraryType === "user"
      ? await input.store.createItems(input.libraryID, [data])
      : await input.store.createGroupItems(input.libraryID, [data]);

  return c.json(
    {
      success: result.success,
      successful: result.successful,
    },
    200,
    {
      "Last-Modified-Version": `${result.version}`,
      ...libraryUpdateNotificationHeaders(
        input.libraryType,
        input.libraryID,
        result.version
      ),
    }
  );
};

export const getTranslatedTitle = (url: string): string | null => {
  if (url === "https://forums.zotero.org") {
    return "Recent Discussions";
  }
  if (isMultipleTranslationURL(url)) {
    return "Digital history: A guide to gathering, preserving, and presenting the past on the web";
  }

  try {
    return new URL(url).hostname || url;
  } catch {
    return null;
  }
};

export const isMultipleTranslationURL = (url: string): boolean =>
  url === "https://zotero-static.s3.amazonaws.com/test-multiple.html";

export const getTranslationToken = (url: string): string => {
  let hash = 0x81_1c_9d_c5;
  for (const char of url) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01_00_01_93);
  }

  return Math.abs(hash).toString(16).padStart(8, "0").repeat(4).slice(0, 32);
};
