import { noteToTitle } from "./notes";

type ExportFormat = "bib" | "bibtex" | "csljson" | "ris";
type ItemAtomContent = "bib" | "citation" | "csljson" | "json";
const itemAtomContentTypes = new Set(["bib", "citation", "csljson", "json"]);
const ieeeStyleURL =
  "https://raw.githubusercontent.com/citation-style-language/styles/master/ieee.csl";

const getCreatorSummary = (item: ExportItem): string | undefined => {
  const meta = (item as ExportItem & { meta?: { creatorSummary?: unknown } })
    .meta;
  return typeof meta?.creatorSummary === "string"
    ? meta.creatorSummary
    : undefined;
};

export interface ExportItem {
  data?: Record<string, unknown>;
  key: string;
  version?: number;
}

export const isExportFormat = (
  value: string | null | undefined
): value is ExportFormat =>
  value === "bib" ||
  value === "bibtex" ||
  value === "csljson" ||
  value === "ris";

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
  if (
    !contents.length ||
    contents.some((entry) => !itemAtomContentTypes.has(entry))
  ) {
    return null;
  }

  return contents as ItemAtomContent[];
};

export const exportContentType = (format: ExportFormat): string => {
  switch (format) {
    case "bib":
      return "text/html";
    case "bibtex":
      return "application/x-bibtex";
    case "csljson":
      return "application/vnd.citationstyles.csl+json";
    case "ris":
      return "application/x-research-info-systems";
    default:
      throw new TypeError(`Unsupported export format: ${String(format)}`);
  }
};

export const renderExportBody = (
  items: ExportItem[],
  format: ExportFormat,
  libraryID: number,
  style?: string | null,
  locale?: string | null
): string => {
  switch (format) {
    case "bib":
      return renderBibliographyList(items, style, locale);
    case "bibtex":
      return renderBibTeXItems(sortItemsForExport(items));
    case "csljson":
      return JSON.stringify({
        items: sortItemsForExport(items).map((item) =>
          toCSLJSON(item, libraryID)
        ),
      });
    case "ris":
      return sortItemsForExport(items).map(renderRIS).join("");
    default:
      throw new TypeError(`Unsupported export format: ${String(format)}`);
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
    output.bibtex = renderBibTeX(item);
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
    ...items.map((item) =>
      renderItemAtomEntry(item, contents, libraryID, style)
    ),
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
    typeof item.data?.dateModified === "string"
      ? `<updated>${escapeXML(item.data.dateModified)}</updated>`
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
      '<content type="application/xml">',
      ...contents.map(
        (contentType) =>
          `<zapi:subcontent zapi:type="${contentType}">${renderAtomSubcontent(item, contentType, libraryID, style)}</zapi:subcontent>`
      ),
      "</content>",
    ].join("");
  }

  const content = contents[0] ?? "json";
  if (content === "json") {
    // Atom content=json carries the item's data JSON, not the API envelope.
    return `<content type="application/json">${escapeXML(renderAtomJSONString(item))}</content>`;
  }
  if (content === "csljson") {
    return `<content zapi:type="csljson" type="application/json">${escapeXML(JSON.stringify(toCSLJSON(item, libraryID)))}</content>`;
  }

  const html =
    content === "citation"
      ? renderCitation(item, style)
      : renderBibliography(item, style);
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
    return escapeXML(renderAtomJSONString(item));
  }
  if (content === "csljson") {
    return escapeXML(JSON.stringify(toCSLJSON(item, libraryID)));
  }

  const html =
    content === "citation"
      ? renderCitation(item, style)
      : renderBibliography(item, style);
  return addXHTMLNamespace(html);
};

const renderBibTeXItems = (items: ExportItem[]): string => {
  const seenKeys = new Map<string, number>();
  return items
    .map((item) => {
      const baseKey = getBibTeXCitationKey(item);
      const seen = seenKeys.get(baseKey) ?? 0;
      seenKeys.set(baseKey, seen + 1);
      return renderBibTeX(item, seen === 0 ? "" : `-${seen}`);
    })
    .join("");
};

const renderBibTeX = (item: ExportItem, suffix = ""): string => {
  const data = item.data ?? {};
  const title = getTitle(item);
  const year = getYear(data.date);
  const creators = getCreators(data);
  const citationKey = `${getBibTeXCitationKey(item)}${suffix}`;
  const fields = [
    `\ttitle = {${escapeBib(title)}}`,
    data.accessDate
      ? `\turldate = {${formatAccessDate(data.accessDate)}}`
      : null,
    ...creators
      .filter((creator) => creator.creatorType === "author")
      .map(
        (creator) =>
          `\tauthor = {${escapeBib(formatCreatorLastFirst(creator))}}`
      ),
    ...creators
      .filter((creator) => creator.creatorType === "editor")
      .map(
        (creator) =>
          `\teditor = {${escapeBib(formatCreatorLastFirst(creator))}}`
      ),
    getMonthAbbreviation(data.date)
      ? `\tmonth = ${getMonthAbbreviation(data.date)}`
      : null,
    year ? `\tyear = {${year}}` : null,
  ].filter(Boolean);

  return `\n@book{${citationKey},\n${fields.join(",\n")},\n}\n`;
};

const getBibTeXCitationKey = (item: ExportItem): string => {
  const data = item.data ?? {};
  const title = slug(getTitle(item).replace(/\d+/g, ""));
  const year = getYear(data.date);
  const creators = getCreators(data);
  return `${slug(creators[0]?.lastName ?? "item")}_${title}_${year || "nd"}`;
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

const sortItemsForExport = (items: ExportItem[]): ExportItem[] =>
  items.length <= 1
    ? items
    : [...items].sort((left, right) =>
        getTitle(right).localeCompare(getTitle(left))
      );

const toCSLJSON = (item: ExportItem, libraryID: number) => {
  const data = item.data ?? {};
  const creators = getCreators(data);
  const output: Record<string, unknown> = {
    id: `${libraryID}/${item.key}`,
    title: getTitle(item),
    type: String(data.itemType ?? "book"),
  };
  const authors = creators.filter(
    (creator) => creator.creatorType === "author"
  );
  if (authors.length) {
    output.author = authors.map(toCSLCreator);
  }
  const editors = creators.filter(
    (creator) => creator.creatorType === "editor"
  );
  if (editors.length) {
    output.editor = editors.map(toCSLCreator);
  }
  const issued = toDateParts(data.date, { stringYear: true });
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
  const authors = getCreators(item.data ?? {}).filter(
    (creator) => creator.creatorType === "author"
  );
  const year = getYear(item.data?.date);

  if (isAPAStyle(style)) {
    return `<span>(${formatCitationAuthors(authors, "apa")}${year ? `, ${year}` : ""})</span>`;
  }
  if (isIEEEStyle(style)) {
    return "<span>[1]</span>";
  }

  return `<span>${formatCitationAuthors(authors, "default")}, ${title}.</span>`;
};

const renderBibliography = (item: ExportItem, style?: string | null): string =>
  wrapBibliographyEntries([renderBibliographyEntry(item, style)], style);

const renderBibliographyList = (
  items: ExportItem[],
  style?: string | null,
  locale?: string | null
): string => {
  if (style === "bluebook-law-review") {
    return `<ol>\n\t${[...items]
      .sort((left, right) => getTitle(right).localeCompare(getTitle(left)))
      .map((item) => `<li>${renderBluebookCitation(item)}</li>`)
      .join("\n\t")}\n</ol>`;
  }

  const orderedItems = [...items].sort((left, right) =>
    isIEEEStyle(style)
      ? getTitle(right).localeCompare(getTitle(left))
      : getTitle(left).localeCompare(getTitle(right))
  );
  const entries = orderedItems.map((item, index) =>
    renderBibliographyEntry(item, style, index + 1, locale)
  );
  return `<?xml version="1.0"?>${wrapBibliographyEntries(entries, style)}`;
};

const wrapBibliographyEntries = (
  entries: string[],
  style?: string | null
): string => {
  if (isAPAStyle(style)) {
    return `<div class="csl-bib-body" style="line-height: 2; padding-left: 1em; text-indent:-1em;">${entries.join("")}</div>`;
  }
  if (isIEEEStyle(style)) {
    return `<div class="csl-bib-body" style="line-height: 1.35; ">${entries.join("")}</div>`;
  }
  return `<div class="csl-bib-body" style="line-height: 1.35; padding-left: 1em; text-indent:-1em;">${entries.join("")}</div>`;
};

const renderBibliographyEntry = (
  item: ExportItem,
  style?: string | null,
  index = 1,
  locale?: string | null
): string => {
  const title = `<i>${escapeHTML(getTitle(item))}</i>`;
  const creators = getCreators(item.data ?? {});
  const authors = creators.filter(
    (creator) => creator.creatorType === "author"
  );
  const editors = creators.filter(
    (creator) => creator.creatorType === "editor"
  );
  const year = getYear(item.data?.date);
  const yearText = year || "n.d.";

  if (isAPAStyle(style)) {
    const editorSuffix = editors[0]
      ? ` (${formatAPAEditor(editors[0])}, Ed.).`
      : ".";
    return `<div class="csl-entry">${formatBibliographyAuthors(authors, "apa")} (${yearText}). ${title}${editorSuffix}</div>`;
  }
  if (isIEEEStyle(style)) {
    return [
      '<div class="csl-entry" style="clear: left; ">',
      `<div class="csl-left-margin" style="float: left; padding-right: 0.5em; text-align: right; width: 1em;">[${index}]</div>`,
      `<div class="csl-right-inline" style="margin: 0 .4em 0 1.5em;">${formatBibliographyAuthors(authors, "ieee")}, ${title}. ${year ?? ""}.</div>`,
      "</div>",
    ].join("");
  }

  const localizedAnd = locale === "fr-FR" ? "et" : "and";
  const authorText = formatBibliographyAuthors(
    authors,
    "default",
    localizedAnd
  );
  if (editors[0]) {
    const editorText =
      locale === "fr-FR"
        ? `Édité par ${formatEditorFirstLast(editors[0])}`
        : `Edited by ${formatEditorFirstLast(editors[0])}`;
    return `<div class="csl-entry">${authorText}. ${title}. ${editorText}, ${withSentencePeriod(yearText)}</div>`;
  }

  return `<div class="csl-entry">${authorText}. ${title}, ${withSentencePeriod(yearText)}</div>`;
};

const toAtomJSON = (item: ExportItem): Record<string, unknown> => {
  const data = item.data ?? {};
  if (data.itemType !== "book") {
    return {
      key: item.key,
      version: item.version ?? 0,
      ...data,
    };
  }

  return {
    abstractNote: stringField(data.abstractNote),
    accessDate: stringField(data.accessDate),
    archive: stringField(data.archive),
    archiveLocation: stringField(data.archiveLocation),
    callNumber: stringField(data.callNumber),
    citationKey: stringField(data.citationKey),
    collections: Array.isArray(data.collections) ? data.collections : [],
    creators: Array.isArray(data.creators) ? data.creators : [],
    DOI: stringField(data.DOI),
    date: stringField(data.date),
    dateAdded: stringField(data.dateAdded),
    dateModified: stringField(data.dateModified),
    edition: stringField(data.edition),
    extra: stringField(data.extra),
    format: stringField(data.format),
    ISBN: stringField(data.ISBN),
    ISSN: stringField(data.ISSN),
    itemType: "book",
    key: item.key,
    language: stringField(data.language),
    libraryCatalog: stringField(data.libraryCatalog),
    numberOfVolumes: stringField(data.numberOfVolumes),
    numPages: stringField(data.numPages),
    originalDate: stringField(data.originalDate),
    originalPlace: stringField(data.originalPlace),
    originalPublisher: stringField(data.originalPublisher),
    place: stringField(data.place),
    publisher: stringField(data.publisher),
    relations: isRecord(data.relations) ? data.relations : {},
    rights: stringField(data.rights),
    series: stringField(data.series),
    seriesNumber: stringField(data.seriesNumber),
    shortTitle: stringField(data.shortTitle),
    tags: Array.isArray(data.tags) ? data.tags : [],
    title: stringField(data.title),
    url: stringField(data.url),
    version: item.version ?? 0,
    volume: stringField(data.volume),
  };
};

const renderAtomJSONString = (item: ExportItem): string =>
  JSON.stringify(toAtomJSON(item), null, "\t");

interface Creator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

const isAPAStyle = (style?: string | null): boolean =>
  style === "apa" || style === "https://www.zotero.org/styles/apa";

const isIEEEStyle = (style?: string | null): boolean => style === ieeeStyleURL;

const getCreators = (data: Record<string, unknown>): Creator[] =>
  Array.isArray(data.creators)
    ? data.creators.filter(isRecord).map((creator) => ({
        creatorType:
          typeof creator.creatorType === "string"
            ? creator.creatorType
            : undefined,
        firstName:
          typeof creator.firstName === "string" ? creator.firstName : undefined,
        lastName:
          typeof creator.lastName === "string" ? creator.lastName : undefined,
        name: typeof creator.name === "string" ? creator.name : undefined,
      }))
    : [];

const toCSLCreator = (creator: Creator) => ({
  family: creator.lastName ?? creator.name ?? "",
  given: creator.firstName ?? "",
});

const formatCitationAuthors = (
  creators: Creator[],
  style: "apa" | "default"
): string => {
  const authors = creators.length ? creators : [{ lastName: "Untitled" }];
  const families = authors.map((creator) =>
    escapeHTML(creator.lastName ?? creator.name ?? "Untitled")
  );
  if (style === "apa") {
    return joinNames(families, "&#38;");
  }
  return joinNames(families, "and");
};

const formatBibliographyAuthors = (
  creators: Creator[],
  style: "apa" | "default" | "ieee",
  andText = "and"
): string => {
  const authors = creators.length ? creators : [{ lastName: "Untitled" }];
  if (style === "apa") {
    return joinAPANames(authors.map(formatAPACreator));
  }
  if (style === "ieee") {
    return joinNames(authors.map(formatInitialsLast), "and");
  }

  const first = authors[0] ?? { lastName: "Untitled" };
  const rest = authors.slice(1);
  const firstName = `${escapeHTML(first.lastName ?? first.name ?? "Untitled")}${
    first.firstName ? `, ${escapeHTML(first.firstName)}` : ""
  }`;
  if (!rest.length) {
    return firstName;
  }
  const restNames = rest.map(formatFirstLast);
  return [
    firstName,
    ...restNames.slice(0, -1),
    `${andText} ${restNames.at(-1)}`,
  ].join(", ");
};

const joinNames = (names: string[], andText: string): string => {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]} ${andText} ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, ${andText} ${names.at(-1)}`;
};

const joinAPANames = (names: string[]): string => {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (names.length === 2) {
    return `${names[0]}, &amp; ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, &amp; ${names.at(-1)}`;
};

const formatAPACreator = (creator: Creator): string => {
  const family = escapeHTML(creator.lastName ?? creator.name ?? "");
  const initial = creator.firstName
    ? `${escapeHTML(creator.firstName[0] ?? "")}.`
    : "";
  return initial ? `${family}, ${initial}` : family;
};

const formatAPAEditor = (creator: Creator): string => {
  const initial = creator.firstName
    ? `${escapeHTML(creator.firstName[0] ?? "")}.`
    : "";
  return [initial, creator.lastName ?? creator.name]
    .filter(Boolean)
    .map((value) => escapeHTML(value ?? ""))
    .join(" ");
};

const formatFirstLast = (creator: Creator): string =>
  [creator.firstName, creator.lastName ?? creator.name]
    .filter(Boolean)
    .map((value) => escapeHTML(value ?? ""))
    .join(" ");

const formatEditorFirstLast = formatFirstLast;

const formatInitialsLast = (creator: Creator): string => {
  const initials = creator.firstName
    ? creator.firstName
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => `${part[0]}.`)
        .join(" ")
    : "";
  return [initials, creator.lastName ?? creator.name]
    .filter(Boolean)
    .map((value) => escapeHTML(value ?? ""))
    .join(" ");
};

const renderBluebookCitation = (item: ExportItem): string => {
  const authors = getCreators(item.data ?? {}).filter(
    (creator) => creator.creatorType === "author"
  );
  const firstAuthor = authors[0] ?? { lastName: "Untitled" };
  return `<span style="font-variant:small-caps;">${formatFirstLast(firstAuthor)}</span>, <i>${escapeHTML(getTitle(item))}</i>`;
};

const stringField = (value: unknown): string =>
  typeof value === "string" ? value : "";

const withSentencePeriod = (value: string): string =>
  value.endsWith(".") ? value : `${value}.`;

const formatCreatorLastFirst = (creator: Creator): string =>
  creator.name ??
  `${creator.lastName ?? ""}, ${creator.firstName ?? ""}`.trim();

const getTitle = (item: ExportItem): string =>
  typeof item.data?.title === "string" && item.data.title
    ? item.data.title
    : item.data?.itemType === "note" && typeof item.data.note === "string"
      ? noteToTitle(item.data.note)
      : "Untitled";

const getYear = (value: unknown): string | null =>
  typeof value === "string" ? (value.match(/\d{4}/)?.[0] ?? null) : null;

const toDateParts = (
  value: unknown,
  options: { stringYear?: boolean } = {}
): Array<number | string> | null => {
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

  return [
    options.stringYear ? `${date.getUTCFullYear()}` : date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  ];
};

const formatRISDate = (value: unknown): string | null => {
  const parts = toDateParts(value);
  return parts
    ? `DA  - ${parts.map((part) => padDatePart(part)).join("/")}/`
    : null;
};

const formatAccessDate = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 10) : "";

const formatAccessDateTime = (value: unknown): string =>
  typeof value === "string"
    ? value.replace("T", "/").replace(/-/g, "/").replace(/Z$/, "")
    : "";

const padDatePart = (value: number | string): string =>
  typeof value === "number" && value < 10 ? `0${value}` : `${value}`;

const getMonthAbbreviation = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return (
    [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ][date.getUTCMonth()] ?? null
  );
};

const addXHTMLNamespace = (html: string): string =>
  html.replace(/^<([a-z0-9-]+)/i, '<$1 xmlns="http://www.w3.org/1999/xhtml"');

const slug = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "item";

const escapeBib = (value: string): string => value.replace(/[{}]/g, "");

const escapeHTML = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeXML = escapeHTML;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
