# Zotero note and child-item compatibility

Implemented local surface:

- Note templates include `note`, `tags`, `collections`, and `relations` fields.
- Note writes preserve HTML and UTF-8 content through item JSON storage.
- Oversized note content is rejected with an object-level 413 write failure.
- Note titles for Atom/list sorting are derived from note HTML using Zotero-style first-line extraction without rewriting stored note content.
- User and group `GET /items/:itemKey/children` list direct child items from `data.parentItem`.
- Child item routes support existing item list filters and `format=keys` through the shared item-list renderer.

Known unverified areas:

- The official remote note and child-item test slices have not been run against this Worker.
- Note HTML sanitization is compatibility-minimal and does not yet fully mirror Zotero's cleaner.
