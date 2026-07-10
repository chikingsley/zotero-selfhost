import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { getRequestApiKey } from "../../../domain/auth";
import { createKeyStore } from "../../../domain/keys";
import type { CompatibilityStore } from "../../../domain/storage";
import { escapeXML } from "./responses";
import { isRecord } from "./values";

export const renderGroupCreateAtom = (groupID: number): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    "<entry>",
    `<zapi:groupID>${groupID}</zapi:groupID>`,
    "</entry>",
    "</feed>",
  ].join("");

export const isPublicGroupRecord = (group: { data?: { type?: string } }) =>
  group.data?.type === "PublicOpen" || group.data?.type === "PublicClosed";

export const getGroupVersion = (group: { data?: Record<string, unknown> }) => {
  const version = group.data?.version;
  return typeof version === "number" ? version : 1;
};

export const getGroupSelfHref = (
  c: Context<{ Bindings: Bindings }>,
  groupID: number
) => `${new URL(c.req.url).origin}/groups/${groupID}`;

export const groupResponse = async (
  c: Context<{ Bindings: Bindings }>,
  store: CompatibilityStore,
  group: {
    data: Record<string, unknown> & { owner?: number; version?: number };
    id: number;
  }
) => {
  const apiKey = getRequestApiKey(c);
  const key = apiKey ? await createKeyStore(c.env).getKey(apiKey) : null;
  const access = key ? await store.getGroupAccess(key.userID, group.id) : null;
  return {
    data: group.data,
    id: group.id,
    links: {
      self: {
        href: getGroupSelfHref(c, group.id),
        type: "application/json",
      },
    },
    meta: {
      isAdmin: Boolean(access?.canAdmin || group.data.owner === key?.userID),
    },
    version: getGroupVersion(group),
  };
};

export const filterGroupsForRequest = (
  c: Context<{ Bindings: Bindings }>,
  groups: Array<{
    data: Record<string, unknown> & { type?: string };
    id: number;
  }>
) => {
  const fq = c.req.query("fq");
  const q = c.req.query("q")?.toLocaleLowerCase();
  let filtered = groups;

  if (fq?.startsWith("GroupType:")) {
    const groupType = fq.slice("GroupType:".length);
    filtered = filtered.filter((group) => group.data.type === groupType);
  }
  if (q) {
    filtered = filtered.filter((group) =>
      String(group.data.name ?? "")
        .toLocaleLowerCase()
        .includes(q)
    );
  }

  return filtered;
};

export const renderUserGroupsAtom = (
  groups: Array<{
    data?: Record<string, unknown> & { name?: string; version?: number };
    id: number;
    version?: number;
  }>,
  c?: Context<{ Bindings: Bindings }>
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    ...groups.map((group) => {
      const content = {
        ...(isRecord(group.data) ? group.data : {}),
        id: group.id,
        version: getGroupVersion(group),
      };
      return [
        "<entry>",
        `<id>groups/${group.id}</id>`,
        `<title>${escapeXML(group.data?.name ?? `Group ${group.id}`)}</title>`,
        c
          ? `<link rel="self" href="${escapeXML(getGroupSelfHref(c, group.id))}"/>`
          : "",
        `<zapi:groupID>${group.id}</zapi:groupID>`,
        `<content type="application/json">${escapeXML(JSON.stringify(content))}</content>`,
        "</entry>",
      ].join("");
    }),
    "</feed>",
  ].join("");

export const renderGroupUpdateAtom = (group: {
  data: Record<string, unknown>;
  id: number;
}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zxfer="http://zotero.org/ns/transfer">',
    '<content type="application/xml">',
    `<zxfer:group name="${escapeXML(String(group.data.name ?? ""))}"/>`,
    "</content>",
    "</entry>",
  ].join("");

export const parseGroupXML = (body: string): Record<string, unknown> => {
  const attrs = body.match(/<group\b([^>]*)/i)?.[1] ?? "";
  const readAttr = (name: string): string | undefined =>
    attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const readNode = (name: string): string | undefined =>
    body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1];

  const owner = Number.parseInt(readAttr("owner") ?? "", 10);
  return {
    ...(Number.isFinite(owner) ? { owner } : {}),
    ...(readAttr("fileEditing")
      ? { fileEditing: readAttr("fileEditing") }
      : {}),
    ...(readAttr("hasImage") ? { hasImage: readAttr("hasImage") } : {}),
    ...(readAttr("libraryEditing")
      ? { libraryEditing: readAttr("libraryEditing") }
      : {}),
    ...(readAttr("libraryReading")
      ? { libraryReading: readAttr("libraryReading") }
      : {}),
    ...(readAttr("name") ? { name: readAttr("name") } : {}),
    ...(readAttr("type") ? { type: readAttr("type") } : {}),
    ...(readAttr("url") ? { url: readAttr("url") } : {}),
    ...(readNode("description") === undefined
      ? {}
      : { description: readNode("description") }),
    ...(readNode("url") === undefined ? {} : { url: readNode("url") }),
  };
};
