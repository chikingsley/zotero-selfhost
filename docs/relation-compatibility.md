# Zotero relation compatibility

## Current implementation

- Item and collection writes validate that `relations` is an object.
- Supported predicates are `dc:isReplacedBy`, `dc:relation`, `dc:replaces`, and `owl:sameAs`.
- Item relation values must be Zotero item URIs.
- Collection relation values must be Zotero collection URIs.
- Single-value arrays are normalized to a scalar string.
- Same-library item `dc:relation` writes add the reverse `dc:relation` link to the target item.
- Same-batch item writes are considered when adding reverse links.

## Known gaps

- The official relation remote-test slice has not been run against this Worker.
- Relation sync currently performs a second item write when reverse links are needed, so exact version behavior still needs calibration against the official dataserver.
- Relation support is limited to Zotero URI validation and bidirectional `dc:relation`; it does not implement a separate first-class relation table.

## Reference tests to run

- `references/dataserver/tests/remote/tests/3/relation.test.js`
