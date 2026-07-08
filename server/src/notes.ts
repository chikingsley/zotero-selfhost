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
    note
      .slice(0, maxNoteTitleLength * 5)
      .replace(/<\/p>[\s]*<p>/gi, "</p>\n<p>")
      .replace(/<[^>]*>/g, "")
  );
  let title = Array.from(text).slice(0, maxNoteTitleLength).join("");
  if (ignoreNewline) {
    title = title.replace(/\s+/g, " ");
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
  const withoutBlankLeadingLines = note
    .replace(/^(\s|<p>&nbsp;<\/p>)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return withoutBlankLeadingLines.slice(0, 80);
};

const decodeHTMLEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
