# Zotero saved-search compatibility

Implemented local surface:

- User and group `GET /searches`, `GET /searches/:key`, `POST /searches`, `PUT /searches/:key`, `PATCH /searches/:key`, `DELETE /searches/:key`, and multi-delete with `searchKey`.
- Memory and D1 persistence using the shared library version counter.
- Multi-write response shape with `success`, `successful`, `failed`, `unchanged`, and `Last-Modified-Version`.
- `format=keys`, `format=versions`, `searchKey`, `since`, `newer`, and `If-Modified-Since-Version` handling for search lists.
- Saved-search validation for missing/empty `name`, missing/empty `conditions`, missing/empty condition names, and missing/empty operators.
- Existing-search optimistic concurrency using object `version` plus library `If-Unmodified-Since-Version` on multi writes.
- Legacy schema protection: grouped/result-level searches emit `invalidProp` when `Zotero-Schema-Version` is below 43.
- Search single/list responses support JSON, keys, versions, minimal Atom XML with JSON content, and HEAD version headers.

Known unverified areas:

- The official remote search and version test slices have not been run against this Worker.
- Atom/HEAD behavior is implemented but has not been checked against official remote tests.
- Delete-log `/deleted` sync behavior still needs a dedicated implementation across object types.
