# Creator compatibility

Status: implemented locally for creator-summary response behavior, not yet verified against the official creator remote-test slice.

## Implemented

- Item JSON responses include `meta.creatorSummary` when a creator has a non-empty display name.
- Atom item entries include `zapi:creatorSummary` when a creator summary is available.
- Creator summary formatting follows the official tested cases:
  - one creator: first creator name
  - two creators: `First and Second`
  - three or more creators: `First et al.`
- Creator display names preserve case and emoji.
- Empty UTF-8 BOM-only creator names do not produce a creator summary.
- Item writes validate `creators` as arrays and enforce `creatorType`, organization/person name shape, mutually exclusive `name` versus `firstName`/`lastName`, and valid creator properties.
- Creator type validation uses Zotero schema 41 item-type mappings, including `dataset`, `preprint`, `standard`, media types, law types, and the official `author` fallback for otherwise incompatible item types.
- Single nameless template creators are ignored on new item creation, matching Zotero's API template behavior.

## Remaining calibration

- Run the official creator remote-test slice against this Worker.
- Confirm creator-summary localization and organization/person edge cases against the official dataserver.
