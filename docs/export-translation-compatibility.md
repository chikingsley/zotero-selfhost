# Zotero export, bibliography, and translation compatibility

## Current implementation

- Item list and single item reads support `format=bibtex`, `format=ris`, and `format=csljson`.
- Item list reads support `format=versions`.
- Item list and single item reads support `include=bibtex`, `include=ris`, `include=csljson`, `include=citation`, and `include=bib`.
- Item list and single item reads support `content=citation`, `content=bib`, `content=csljson`, and `content=json` Atom responses.
- User and group item POST routes accept web-translation-style `{ "url": "..." }` payloads.
- The official single-page and multi-selection translation URLs from `translation.test.js` are handled locally.

## Known gaps

- The official bibliography, export, and translation remote-test slices have not been run against this Worker.
- Bibliography and citation rendering is deterministic local formatting, not a full CSL engine.
- BibTeX, RIS, and CSL JSON output cover common item metadata but are not complete translators for every Zotero item type and field.
- Web translation is a compatibility shim for known official-test URLs plus generic webpage fallback, not a full translator service.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/bib.test.js`
- `references/dataserver/tests/remote/tests/3/export.test.js`
- `references/dataserver/tests/remote/tests/3/translation.test.js`
