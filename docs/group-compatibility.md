# Zotero group compatibility

Status: implemented locally for the official group metadata slice, not yet verified against the Worker.

## Implemented

- `GET /users/:userID/groups` returns Zotero-style group wrappers with `id`, `version`, `links.self`, `meta.isAdmin`, and `data`.
- `GET /users/:userID/groups?format=versions` returns a `{ [groupID]: version }` metadata-version map.
- `GET /users/:userID/groups?content=json` returns Atom entries with `zapi:groupID`, `link rel="self"`, and top-level group metadata JSON in `atom:content`.
- Root `GET /groups?q=...` filters newly created public groups out of search until the group has items.
- `GET /groups/:groupID` returns individual group JSON with `Last-Modified-Version`.
- `GET /groups/:groupID?content=json` returns Atom with top-level group metadata JSON.
- Root `PUT /groups/:groupID` accepts Zotero group XML metadata and bumps the group metadata version.
- Memory and D1 storage preserve group `description`, `url`, `hasImage`, and metadata `version`.
- Group member add, update, and removal bump the group metadata version.

## Remaining calibration

- Run `references/dataserver/tests/remote/tests/3/group.test.js` against the Worker candidate.
- Compare exact root group-search response body shape beyond `Total-Results`.
