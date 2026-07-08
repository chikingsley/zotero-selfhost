# Zotero settings compatibility

Implemented local surface:

- User and group `GET /settings`, `GET /settings/:key`, `PUT /settings/:key`, `POST /settings`, `DELETE /settings/:key`, and multi-delete with `settingKey`.
- Memory and D1 persistence using the shared library version counter.
- `If-Unmodified-Since-Version` handling for single setting writes/deletes and multi-write library guards.
- `since` filtering on settings list responses.
- Official setting-name validation for `tagColors`, `feeds`, reader settings, attachment rename settings, and `lastPageIndex`/`lastRead`/`lastReadAloudPosition` patterns.
- Value validation for object, array, boolean, integer, string, and `lastPageIndex` percentage/page-number rules.
- Preservation of large raw JSON integer values in setting `value` fields by parsing oversized `value` numbers as strings.
- Group admin-only write protection for `attachmentRenameTemplate`, `autoRenameFiles`, and `autoRenameFilesFileTypes` using the local group role model.

Known unverified areas:

- The official remote settings test slice has not been run against this Worker.
- The exact Zotero writereport payload may need field-level adjustment after running official mixed-success tests.
- D1 migration application has not been validated in Wrangler.
