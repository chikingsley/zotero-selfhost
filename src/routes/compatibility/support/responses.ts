import type { Context } from "hono";
import type { Bindings } from "../../../bindings";

export const escapeXML = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const renderJSONAtomEntry = (input: {
  content: unknown;
  id: string;
  key: string;
  title: string;
  version: number;
}) =>
  [
    '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    `<id>${escapeXML(input.id)}</id>`,
    `<title>${escapeXML(input.title)}</title>`,
    `<zapi:key>${escapeXML(input.key)}</zapi:key>`,
    `<zapi:version>${input.version}</zapi:version>`,
    `<content type="application/json">${escapeXML(JSON.stringify(input.content))}</content>`,
    "</entry>",
  ].join("");

export const renderJSONAtomFeed = (title: string, entries: string[]) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    `<title>${escapeXML(title)}</title>`,
    ...entries,
    "</feed>",
  ].join("");

export const atomHeaders = (version: number, total?: number) => ({
  "Content-Type": "application/atom+xml",
  "Last-Modified-Version": `${version}`,
  ...(total === undefined ? {} : { "Total-Results": `${total}` }),
});

export const jsonListHeaders = (version: number, total: number) => ({
  "Last-Modified-Version": `${version}`,
  "Total-Results": `${total}`,
});

export const wantsAtomResponse = (c: Context<{ Bindings: Bindings }>) =>
  c.req.query("format") === "atom" || c.req.query("content") === "json";

export const isHeadRequest = (c: Context<{ Bindings: Bindings }>) =>
  c.req.method.toUpperCase() === "HEAD";
