export interface NoteValidationFailure {
  code: 413;
  message: string;
}

const maxNoteLength = 500_000;
const maxNoteTitleLength = 79;

export const noteToTitle = (note: string, ignoreNewline = false): string => {
  if (!note) {
    return "";
  }

  const text = decodeHTMLEntities(
    Array.from(note)
      .slice(0, maxNoteTitleLength * 5)
      .join("")
      .replace(/<\/p>[\s]*<p>/gi, "</p>\n<p>")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<[^>]*>/g, "")
  );
  let title = utf8Strcut(text, maxNoteTitleLength);
  if (ignoreNewline) {
    title = collapsePhpWhitespace(title);
  } else {
    const newline = title.indexOf("\n");
    if (newline !== -1) {
      title = title.slice(0, newline);
    }
  }

  return title;
};

export const validateItemNoteForWrite = (
  data: Record<string, unknown>
): NoteValidationFailure | null => {
  if (data.itemType !== "note" || typeof data.note !== "string") {
    return null;
  }

  if ([...data.note].length <= maxNoteLength) {
    data.note = sanitizeNote(data.note);
    return null;
  }

  return {
    code: 413,
    message: `Note '${getNotePreview(data.note)}...' too long`,
  };
};

export const validateItemBatchNotesForWrite = (
  objects: Record<string, unknown>[]
): Record<string, NoteValidationFailure> => {
  const failed: Record<string, NoteValidationFailure> = {};

  objects.forEach((object, index) => {
    const failure = validateItemNoteForWrite(object);
    if (failure) {
      failed[index] = failure;
    }
  });

  return failed;
};

const getNotePreview = (note: string): string => {
  const trimmed = phpTrim(note);
  let excerpt = trimZoteroWhitespace(noteToTitle(trimmed, true));

  if (!excerpt) {
    excerpt = trimZoteroWhitespace(
      decodeHTMLEntities(
        collapsePhpWhitespace(
          Array.from(trimmed).slice(0, maxNoteTitleLength).join("")
        )
      )
    );
  }

  return escapePreview(excerpt);
};

const decodeHTMLEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );

const collapsePhpWhitespace = (value: string): string =>
  value.replace(/[ \t\n\r\f\v]+/g, " ");

const phpTrim = (value: string): string =>
  value.replace(/^[ \t\n\r\v\0]+|[ \t\n\r\v\0]+$/g, "");

const trimZoteroWhitespace = (value: string): string =>
  value.replace(/^[ \t\n\r\v\0\u00a0]+|[ \t\n\r\v\0\u00a0]+$/gu, "");

const utf8Strcut = (value: string, maxBytes: number): string => {
  let bytes = 0;
  let output = "";

  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    output += character;
  }

  return output;
};

const escapePreview = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const sanitizeNote = (note: string): string => {
  if (phpTrim(note) === "") {
    return note;
  }

  return note.replace(/<([a-z][\w:-]*)\s+>/gi, "<$1>");
};
