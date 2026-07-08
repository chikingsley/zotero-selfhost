# Permission compatibility

Status: implemented locally for the first official permissions slice, not yet verified against the official remote tests.

## Implemented

- API key `access.user.library` is now required for user-library read routes.
- API key `access.user.write` is now enforced for user tag deletion.
- API key `access.user.write` is now applied to user-library mutation routes for settings, searches, items, collections, full-text, tags, and item file mutations.
- API key `access.user.notes=false` filters note items out of user item list responses, including paginated JSON, Atom, keys, top-items, and collection item lists that use the shared item-list filter.
- API key `access.groups[groupID]`, `access.groups[0]`, and `access.groups.all` are interpreted for group library, write, and file permissions.
- Group read/edit/file-edit route guards now combine group membership/public access with the API key's group access grants.
- `GET /users/:userID/groups` now supports anonymous public group listing, keyed private visibility, `Total-Results`, JSON responses, and Zotero-shaped Atom responses for `content=json`.

## Remaining calibration

- Run the official permissions remote-test slice against this Worker.
- Decide whether note permissions should also filter single-item note reads and group-library notes.
