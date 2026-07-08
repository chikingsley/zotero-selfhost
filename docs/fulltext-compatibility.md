# Zotero full-text compatibility

## Current implementation

- User and group `GET /fulltext` version maps with `since` and `newer` filtering.
- User and group batch `POST /fulltext` writes with JSON content-type checks and `If-Unmodified-Since-Version` enforcement.
- User and group `GET /items/:itemKey/fulltext` content reads.
- User and group `PUT /items/:itemKey/fulltext` content writes.
- User and group `GET /fulltext/index` reports `{ "status": "indexed" }`.
- D1 persistence through the `fulltext_items` table.
- Memory mode shares the existing user/group library version counter.
- `qmode=everything` item search includes uploaded full-text content.
- `/items/top` full-text search can return the top-level parent item when a child attachment matches.

## Known gaps

- The official full-text remote-test slice has not been run against this Worker.
- The official DynamoDB/Lambda deindexed and reindexing state machine is not implemented.
- Full-text search is direct D1/memory content matching, not an external asynchronous search index.
- Exact full-text write-report payload parity still needs comparison against the official dataserver.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/fulltext.test.js`
