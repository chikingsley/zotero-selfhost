import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import type { CompatibilityStore } from "../../../domain/storage";
import { getUserIdentity } from "../../../domain/user-identity";
import { parseZoteroDate } from "./timestamps";

export const buildUserMetaBlock = async (
  c: Context<{ Bindings: Bindings }>,
  userID: number
): Promise<{
  id: number;
  links: { alternate: { href: string; type: string } };
  name: string;
  username: string;
}> => {
  const origin = new URL(c.req.url).origin;
  const identity = await getUserIdentity(c.env.DB, userID);
  return {
    id: userID,
    links: {
      alternate: {
        href: `${origin}/${identity.username}`,
        type: "text/html",
      },
    },
    name: identity.displayName,
    username: identity.username,
  };
};

export const buildLibraryBlock = async (
  c: Context<{ Bindings: Bindings }>,
  libraryType: "group" | "user",
  libraryID: number,
  groupName?: string
) => {
  const origin = new URL(c.req.url).origin;
  if (libraryType === "user") {
    const identity = await getUserIdentity(c.env.DB, libraryID);
    return {
      id: libraryID,
      links: {
        alternate: {
          href: `${origin}/${identity.username}`,
          type: "text/html",
        },
      },
      name: identity.displayName,
      type: "user",
    };
  }
  return {
    id: libraryID,
    links: {
      alternate: {
        href: `${origin}/groups/${libraryID}`,
        type: "text/html",
      },
    },
    name: groupName ?? "",
    type: "group",
  };
};

interface AttachItemMetaInput {
  allItems: Array<{ data?: Record<string, unknown>; key: string }>;
  groupName?: string;
  libraryBlock?: Awaited<ReturnType<typeof buildLibraryBlock>>;
  libraryID: number;
  libraryType: "group" | "user";
  store: CompatibilityStore;
}

export const attachItemMeta = async (
  c: Context<{ Bindings: Bindings }>,
  item: { data?: Record<string, unknown>; key: string; version?: number },
  input: AttachItemMetaInput
) => {
  const meta: Record<string, unknown> = {
    ...((item as { meta?: Record<string, unknown> }).meta ?? {}),
  };
  const parsedDate = parseZoteroDate(item.data?.date);
  if (parsedDate) {
    meta.parsedDate = parsedDate;
  }
  meta.numChildren = input.allItems.filter(
    (other) => other.data?.parentItem === item.key
  ).length;
  const createdByUserID = (item as { createdByUserID?: unknown })
    .createdByUserID;
  const lastModifiedByUserID = (
    item as {
      lastModifiedByUserID?: unknown;
    }
  ).lastModifiedByUserID;
  if (input.libraryType === "group" && typeof createdByUserID === "number") {
    meta.createdByUser = await buildUserMetaBlock(c, createdByUserID);
    if (
      typeof lastModifiedByUserID === "number" &&
      lastModifiedByUserID !== createdByUserID
    ) {
      meta.lastModifiedByUser = await buildUserMetaBlock(
        c,
        lastModifiedByUserID
      );
    } else {
      delete meta.lastModifiedByUser;
    }
  }

  const origin = new URL(c.req.url).origin;
  const basePath =
    input.libraryType === "user"
      ? `/users/${input.libraryID}`
      : `/groups/${input.libraryID}`;
  const links: Record<string, unknown> = {
    alternate: {
      href: `${origin}${basePath}/items/${item.key}`,
      type: "text/html",
    },
    self: {
      href: `${origin}${basePath}/items/${item.key}`,
      type: "application/json",
    },
  };
  // links.attachment points at the item's "best" child attachment with a
  // registered stored file.
  const childAttachments = input.allItems.filter(
    (other) =>
      other.data?.parentItem === item.key &&
      other.data?.itemType === "attachment"
  );
  for (const child of childAttachments) {
    const file =
      input.libraryType === "user"
        ? await input.store.getAttachmentFile(input.libraryID, child.key)
        : await input.store.getGroupAttachmentFile(input.libraryID, child.key);
    if (file) {
      links.attachment = {
        attachmentType:
          file.contentType ??
          child.data?.contentType ??
          "application/octet-stream",
        href: `${origin}${basePath}/items/${child.key}`,
        type: "application/json",
        // attachmentSize is only reported for single-file (non-ZIP) stored
        // attachments, matching the official server.
        ...(file.sizeBytes && !file.zip
          ? { attachmentSize: file.sizeBytes }
          : {}),
      };
      break;
    }
  }

  return {
    ...item,
    library:
      input.libraryBlock ??
      (await buildLibraryBlock(
        c,
        input.libraryType,
        input.libraryID,
        input.groupName
      )),
    links,
    meta,
  };
};

export const attachItemsMeta = async (
  c: Context<{ Bindings: Bindings }>,
  items: Array<{
    data?: Record<string, unknown>;
    key: string;
    version?: number;
  }>,
  input: AttachItemMetaInput
) => {
  const libraryBlock = await buildLibraryBlock(
    c,
    input.libraryType,
    input.libraryID,
    input.groupName
  );
  return Promise.all(
    items.map((item) => attachItemMeta(c, item, { ...input, libraryBlock }))
  );
};
