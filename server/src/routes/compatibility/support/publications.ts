import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import type { CompatibilityStore } from "../../../domain/storage";
import { getPublicationFileViewURL } from "./files";

export const withPublicationLinks = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  item: { data: Record<string, unknown>; key: string; version: number }
) => ({
  ...item,
  links: {
    enclosure: {
      href: getPublicationFileViewURL(c, userID, item.key),
    },
  },
});
export const getPublicationItem = async (
  store: CompatibilityStore,
  userID: number,
  itemKey: string
) => {
  const result = await store.getItem(userID, itemKey);
  if (!result) {
    return null;
  }
  const item = result.items[0];

  if (item?.data.inPublications !== true || item?.data.deleted) {
    return null;
  }

  return {
    item,
    version: result.version,
  };
};

export const renderPublicationItemAtom = (
  c: Context<{ Bindings: Bindings }>,
  userID: number,
  itemKey: string
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom">',
    `<id>users/${userID}/publications/items/${itemKey}</id>`,
    `<title>${itemKey}</title>`,
    `<link rel="enclosure" href="${getPublicationFileViewURL(
      c,
      userID,
      itemKey
    )}"/>`,
    "</entry>",
  ].join("");
