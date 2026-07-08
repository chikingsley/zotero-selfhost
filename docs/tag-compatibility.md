# Zotero tag compatibility

Implemented local surface:

- User and group `GET /tags` and `DELETE /tags?tag=...`.
- User and group `GET /items/tags` and `GET /items/top/tags`.
- User and group collection-scoped `GET /collections/:key/items/tags` and `GET /collections/:key/items/top/tags`.
- Item-list `tag` filtering with AND, ` || ` OR, and `-tag` negation semantics for user/group item lists.
- Tag list filtering with `tag`, `q`, `qmode=startswith`, `since`, and `newer`.
- `itemQ`, `itemTag`, `itemKey`, and `itemType` proxy filtering for `items/tags` responses.
- Item write normalization that drops empty/whitespace-only tags and rejects invalid tag objects or tags over 255 Unicode code points.
- Tag deletion updates linked item JSON and advances item/library versions through the existing item write path.
- Tag lists support JSON, minimal Atom XML, and HEAD responses with version/total headers.

Known unverified areas:

- The official remote tag test slice has not been run against this Worker.
- Atom/HEAD behavior is implemented but has not been checked against official remote tests.
- The local item text search used by `itemQ` is intentionally minimal and may need parity work for Zotero's full item search model.
