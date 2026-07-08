# Zotero query parameter compatibility

## Current implementation

- Item, collection, tag, and search list responses support `start` and `limit` pagination.
- Paginated list responses preserve existing query parameters in `Link: <...>; rel="next"`.
- Item, collection, tag, and search list responses preserve `Total-Results`.
- Item lists support `sort`/`order` and `direction` for common fields including `title`, `creator`, `itemType`, `date`, `dateAdded`, and `dateModified`.
- Collection, tag, and search lists support basic title/name/key sorting.
- Item quick search covers title, note, item type, date, key, creators, and uploaded full-text content.
- Item quick search supports multiple independent words and quoted phrases.
- Collection quick search supports `q` over collection name/key.

## Known gaps

- The official sort and params remote-test slices have not been run against this Worker.
- Sorting is Worker-native and approximate for some Zotero-specific fields.
- Pagination has been centralized for common list renderers, but less common list endpoints may still need endpoint-specific parity checks.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/sort.test.js`
- `references/dataserver/tests/remote/tests/3/params.test.js`
