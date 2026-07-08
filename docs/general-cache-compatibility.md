# Zotero general and cache compatibility

## Current implementation

- Non-numeric user and group IDs are rejected by existing route parsers.
- `Zotero-Write-Token` duplicate protection is handled by the item write path.
- Invalid control characters are stripped by the existing Zotero data sanitizer before storage.
- Item Atom `content=csljson` responses include creator primary data for cache-sensitive clients.
- Item Atom `content=json` responses are available for official helper-style item XML reads.

## Known gaps

- The official general and cache remote-test slices have not been run against this Worker.
- Conditional cache behavior beyond version headers still needs official-test calibration.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/general.test.js`
- `references/dataserver/tests/remote/tests/3/cache.test.js`
