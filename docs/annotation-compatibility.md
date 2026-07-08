# Annotation compatibility

Status: partially implemented locally, not yet verified against the official annotation remote-test slice.

## Implemented

- Annotation item writes normalize `annotationPosition` to a JSON string.
- Annotation item writes reject `annotationText` for non-highlight/non-underline annotation types.
- Annotation item updates reject changes to an existing annotation's `annotationType`.
- Missing or empty `annotationColor` defaults to Zotero yellow `#ffd400`.
- Invalid annotation colors are rejected.
- Invalid annotation sort indexes are rejected.
- Annotation page labels longer than 50 characters are rejected.
- Annotation positions longer than the local 65 KB compatibility limit are rejected.
- Annotation text is truncated to 7,500 characters.
- Empty `annotationAuthorName` is omitted.
- Older schema responses mark EPUB-style annotation positions and newer annotation types with `invalidProp`.
- Annotation writes require an existing parent attachment with PDF, EPUB, or HTML content type.

## Remaining calibration

- Run the official annotation remote-test slice against this Worker.
- Confirm exact sort-index validation for PDF, EPUB, and HTML annotation parents.
- Confirm exact annotation position length threshold against the official dataserver.
