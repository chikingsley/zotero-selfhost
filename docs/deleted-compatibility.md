# Zotero deleted-sync compatibility

Implemented local surface:

- User and group `GET /deleted?since=...` returning `collections`, `items`, `searches`, `tags`, and `settings` arrays.
- User and group `DELETE /items/:itemKey` and multi-delete `DELETE /items?itemKey=...`.
- Item delete operations update the shared library version, hide deleted items from normal item lists, remove attachment file rows, and write item delete entries.
- D1 mode reads deleted-object state from `sync_log` delete rows.
- Memory mode records item, collection, search, setting, and tag delete events for `/deleted` responses.
- Tag delete operations write tag delete-log entries at the same library version as the item tag rewrite.
- Attachment item deletion removes related `lastPageIndex_*` settings without writing settings delete-log entries.
- Test setup and user/group clear paths clear memory delete logs.

Known unverified areas:

- The official remote deleted-sync and item-delete test slices have not been run against this Worker.
- Search/collection DELETE routes existed before this slice and may still need stricter `If-Unmodified-Since-Version` parity.
