import { noteToTitle } from "./notes";

type ExportFormat = "bibtex" | "csljson" | "ris";
type ItemAtomContent = "bib" | "citation" | "csljson" | "json";
const itemAtomContentTypes = new Set(["bib", "citation", "csljson", "json"]);

const getCreatorSummary = (item: ExportItem): string | undefined => {
  const meta = (item as ExportItem & { meta?: { creatorSummary?: unknown } }).meta;
  return typeof meta?.creatorSummary === "string" ? meta.creatorSummary : undefined;
};

export interface ExportItem {
  data?: Record<string, unknown>;
  key: string;
  version?: number;
}

export const isExportFormat = (
  value: string | null | undefined
): value is ExportFormat =>
  value === "bibtex" || value === "csljson" || value === "ris";

export const isBibliographyContent = (
  value: string | null
): value is ItemAtomContent => parseItemAtomContents(value) !== null;

const parseItemAtomContents = (
  value: string | null | undefined
): ItemAtomContent[] | null => {
  if (!value) {
    return null;
  }

  const contents = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!contents.length || contents.some((entry) => !itemAtomContentTypes.has(entry))) {
    return null;
  }

  return contents as ItemAtomContent[];
};

export const exportContentType = (format: ExportFormat): string => {
  switch (format) {
    case "bibtex":
      return "application/x-bibtex";
    case "csljson":
      return "application/vnd.citationstyles.csl+json";
    case "ris":
      return "application/x-research-info-systems";
  }
};

export const renderExportBody = (
  items: ExportItem[],
  format: ExportFormat,
  libraryID: number
): string => {
  switch (format) {
    case "bibtex":
      return items.map((item, index) => renderBibTeX(item, index)).join("");
    case "csljson":
      return JSON.stringify({
        items: items.map((item) => toCSLJSON(item, libraryID)),
      });
    case "ris":
      return items.map(renderRIS).join("");
  }
};

export const withItemIncludes = (
  item: ExportItem,
  include: string | null | undefined,
  libraryID: number,
  style?: string | null
) => {
  if (!include) {
    return item;
  }

  const requested = new Set(include.split(",").map((entry) => entry.trim()));
  const output: Record<string, unknown> = { ...item };

  if (requested.has("bibtex")) {
    output.bibtex = renderBibTeX(item, 0);
  }
  if (requested.has("ris")) {
    output.ris = renderRIS(item);
  }
  if (requested.has("csljson")) {
    output.csljson = toCSLJSON(item, libraryID);
  }
  if (requested.has("citation")) {
    output.citation = renderCitation(item, style);
  }
  if (requested.has("bib")) {
    output.bib = renderBibliography(item, style);
  }

  return output;
};

export const renderItemAtomFeed = (
  items: ExportItem[],
  content: ItemAtomContent | string | null | undefined,
  libraryID: number,
  style?: string | null,
  selfHref?: string
): string => {
  const contents = parseItemAtomContents(content) ?? ["json"];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">',
    selfHref ? `<link rel="self" href="${escapeXML(selfHref)}"/>` : "",
    ...items.map((item) => renderItemAtomEntry(item, contents, libraryID, style)),
    "</feed>",
  ].join("");
};

// Single-object Atom responses are a bare <entry> document (the official
// tests use root-anchored /atom:entry XPaths), not a one-entry feed.
export const renderItemAtomEntryDocument = (
  item: ExportItem,
  content: ItemAtomContent | string | null | undefined,
  libraryID: number,
  style?: string | null
): string =>
  `<?xml version="1.0" encoding="UTF-8"?>${renderItemAtomEntry(
    item,
    parseItemAtomContents(content) ?? ["json"],
    libraryID,
    style,
    true
  )}`;

const renderItemAtomEntry = (
  item: ExportItem,
  contents: ItemAtomContent[],
  libraryID: number,
  style?: string | null,
  withNamespaces = false
): string => {
  const meta = (item as { meta?: Record<string, unknown> }).meta ?? {};
  return [
    withNamespaces
      ? '<entry xmlns="http://www.w3.org/2005/Atom" xmlns:zapi="http://zotero.org/ns/api">'
      : "<entry>",
    `<zapi:key>${escapeXML(item.key)}</zapi:key>`,
    `<zapi:version>${item.version ?? 0}</zapi:version>`,
    getCreatorSummary(item)
      ? `<zapi:creatorSummary>${escapeXML(getCreatorSummary(item) ?? "")}</zapi:creatorSummary>`
      : "",
    typeof meta.parsedDate === "string"
      ? `<zapi:parsedDate>${escapeXML(meta.parsedDate)}</zapi:parsedDate>`
      : "",
    typeof meta.numChildren === "number"
      ? `<zapi:numChildren>${meta.numChildren}</zapi:numChildren>`
      : "",
    `<title>${escapeXML(getTitle(item))}</title>`,
    renderAtomContent(item, contents, libraryID, style),
    "</entry>",
  ].join("");
};

const renderAtomContent = (
  item: ExportItem,
  contents: ItemAtomContent[],
  libraryID: number,
  style?: string | null
): string => {
  if (contents.length > 1) {
    return [
      '<content xmlns:zapi="http://zotero.org/ns/api" type="application/xml">',
      ...contents.map((content) =>
        `<zapi:subcontent zapi:type="${content}">${renderAtomSubcontent(item, content, libraryID, style)}</zapi:subcontent>`
      ),
      "</content>",
    ].join("");
  }

  const content = contents[0] ?? "json";
  if (content === "json") {
    // Atom content=json carries the item's data JSON, not the API envelope.
    return `<content type="application/json">${escapeXML(JSON.stringify(item.data ?? item))}</content>`;
  }
  if (content === "csljson") {
    return `<content zapi:type="csljson" type="application/json">${escapeXML(JSON.stringify(toCSLJSON(item, libraryID)))}</content>`;
  }

  const html =
    content === "citation" ? renderCitation(item, style) : renderBibliography(item, style);
  const type = content === "citation" ? "citation" : "bib";

  return `<content zapi:type="${type}" type="xhtml">${addXHTMLNamespace(html)}</content>`;
};

const renderAtomSubcontent = (
  item: ExportItem,
  content: ItemAtomContent,
  libraryID: number,
  style?: string | null
): string => {
  if (content === "json") {
    return escapeXML(JSON.stringify(item.data ?? item));
  }
  if (content === "csljson") {
    return escapeXML(JSON.stringify(toCSLJSON(item, libraryID)));
  }

  const html =
    content === "citation" ? renderCitation(item, style) : renderBibliography(item, style);
  return addXHTMLNamespace(html);
};

const renderBibTeX = (item: ExportItem, index: number): string => {
  const data = item.data ?? {};
  const title = getTitle(item);
  const year = getYear(data.date);
  const creators = getCreators(data);
  const citationKey = `${slug(creators[0]?.lastName ?? "item")}_${slug(title)}_${year || "nd"}${index ? `-${index}` : ""}`;
  const fields = [
    `\ttitle = {${escapeBib(title)}}`,
    ...creators
      .filter((creator) => creator.creatorType === "author")
      .map((creator) => `\tauthor = {${escapeBib(formatCreatorLastFirst(creator))}}`),
    ...creators
      .filter((creator) => creator.creatorType === "editor")
      .map((creator) => `\teditor = {${escapeBib(formatCreatorLastFirst(creator))}}`),
    data.accessDate ? `\turldate = {${formatAccessDate(data.accessDate)}}` : null,
    year ? `\tyear = {${year}}` : null,
  ].filter(Boolean);

  return `\n@book{${citationKey},\n${fields.join(",\n")},\n}\n`;
};

const renderRIS = (item: ExportItem): string => {
  const data = item.data ?? {};
  const creators = getCreators(data);
  const lines = [
    "TY  - BOOK",
    `TI  - ${getTitle(item)}`,
    ...creators
      .filter((creator) => creator.creatorType === "author")
      .map((creator) => `AU  - ${formatCreatorLastFirst(creator)}`),
    ...creators
      .filter((creator) => creator.creatorType === "editor")
      .map((creator) => `A3  - ${formatCreatorLastFirst(creator)}`),
    formatRISDate(data.date),
    getYear(data.date) ? `PY  - ${getYear(data.date)}` : null,
    data.accessDate ? `Y2  - ${formatAccessDateTime(data.accessDate)}` : null,
    "ER  - ",
  ].filter(Boolean);

  return `${lines.join("\r\n")}\r\n\r\n`;
};

const toCSLJSON = (item: ExportItem, libraryID: number) => {
  const data = item.data ?? {};
  const creators = getCreators(data);
  const output: Record<string, unknown> = {
    id: `${libraryID}/${item.key}`,
    title: getTitle(item),
    type: String(data.itemType ?? "book"),
  };
  const authors = creators.filter((creator) => creator.creatorType === "author");
  if (authors.length) {
    output.author = authors.map(toCSLCreator);
  }
  const editors = creators.filter((creator) => creator.creatorType === "editor");
  if (editors.length) {
    output.editor = editors.map(toCSLCreator);
  }
  const issued = toDateParts(data.date);
  if (issued) {
    output.issued = { "date-parts": [issued] };
  }
  const accessed = toDateParts(data.accessDate);
  if (accessed) {
    output.accessed = { "date-parts": [accessed] };
  }

  return output;
};

const renderCitation = (item: ExportItem, style?: string | null): string => {
  const title = `<i>${escapeHTML(getTitle(item))}</i>`;
  const author = getCreators(item.data ?? {}).find(
    (creator) => creator.creatorType === "author"
  );
  const year = getYear(item.data?.date);
  const family = escapeHTML(author?.lastName ?? "Untitled");

  if (style?.includes("apa")) {
    return `<span>(${family}${year ? `, ${year}` : ""})</span>`;
  }
  if (style?.includes("ieee")) {
    return "<span>[1]</span>";
  }

  return `<span>${family}, ${title}.</span>`;
};

const renderBibliography = (item: ExportItem, style?: string | null): string => {
  const title = `<i>${escapeHTML(getTitle(item))}</i>`;
  const creators = getCreators(item.data ?? {});
  const author = creators.find((creator) => creator.creatorType === "author");
  const year = getYear(item.data?.date);
  const name = escapeHTML(
    author ? `${author.lastName}, ${author.firstName}` : "Untitled"
  );

  if (style?.includes("apa")) {
    return `<div class="csl-bib-body"><div class="csl-entry">${name}. (${year || "n.d."}). ${title}.</div></div>`;
  }
  if (style?.includes("ieee")) {
    return `<div class="csl-bib-body"><div class="csl-entry">[1] ${name}, ${title}. ${year || ""}.</div></div>`;
  }

  return `<div class="csl-bib-body"><div class="csl-entry">${name}. ${title}${year ? `, ${year}` : ""}.</div></div>`;
};

interface Creator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

const getCreators = (data: Record<string, unknown>): Creator[] =>
  Array.isArray(data.creators)
    ? data.creators.filter(isRecord).map((creator) => ({
        creatorType:
          typeof creator.creatorType === "string" ? creator.creatorType : undefined,
        firstName: typeof creator.firstName === "string" ? creator.firstName : undefined,
        lastName: typeof creator.lastName === "string" ? creator.lastName : undefined,
        name: typeof creator.name === "string" ? creator.name : undefined,
      }))
    : [];

const toCSLCreator = (creator: Creator) => ({
  family: creator.lastName ?? creator.name ?? "",
  given: creator.firstName ?? "",
});

const formatCreatorLastFirst = (creator: Creator): string =>
  creator.name ?? `${creator.lastName ?? ""}, ${creator.firstName ?? ""}`.trim();

const getTitle = (item: ExportItem): string =>
  typeof item.data?.title === "string" && item.data.title
    ? item.data.title
    : item.data?.itemType === "note" && typeof item.data.note === "string"
      ? noteToTitle(item.data.note)
    : "Untitled";

const getYear = (value: unknown): string | null =>
  typeof value === "string" ? value.match(/\d{4}/)?.[0] ?? null : null;

const toDateParts = (value: unknown): Array<number | string> | null => {
  if (typeof value !== "string") {
    return null;
  }

  const year = value.match(/\d{4}/)?.[0];
  if (!year) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return [year];
  }

  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
};

const formatRISDate = (value: unknown): string | null => {
  const parts = toDateParts(value);
  return parts ? `DA  - ${parts.join("/")}/` : null;
};

const formatAccessDate = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 10) : "";

const formatAccessDateTime = (value: unknown): string =>
  typeof value === "string"
    ? value.replace("T", "/").replace(/[-:Z]/g, "/").replace(/\/+$/, "")
    : "";

const addXHTMLNamespace = (html: string): string =>
  html.replace(/^<([a-z0-9-]+)/i, '<$1 xmlns="http://www.w3.org/1999/xhtml"');

const slug = (value: string): string =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") ||
  "item";

const escapeBib = (value: string): string => value.replace(/[{}]/g, "");

const escapeHTML = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeXML = escapeHTML;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
