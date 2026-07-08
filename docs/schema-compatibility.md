# Schema compatibility

Status: partially implemented locally, not yet verified against the official item/schema remote-test slices.

## Implemented

- Compatibility responses include `Zotero-API-Version: 3`.
- Compatibility responses include `Zotero-Schema-Version` using the local current schema constant.
- The local current schema constant is `43`, matching the official grouped-search compatibility boundary already used by the saved-search routes.
- Item list and single-item renderers hide `lastRead` when `Zotero-Schema-Version` is below `42`.
- Item list and single-item renderers hide `lastRead` for Android user agents even when the requested schema version is current.
- Item renderers omit empty `originalDate`, `originalPlace`, and `originalPublisher` fields for schema version `29` and below.

## Remaining calibration

- Run the official item/schema remote-test slices against this Worker.
- Replace the local schema constant with an embedded or generated current Zotero schema manifest.
- Expand old-schema field visibility beyond the currently implemented `lastRead` and original-publication fields.
- Confirm exact old-client rejection behavior for `X-Zotero-Version` if desktop compatibility requires legacy Zotero 5 handling.
