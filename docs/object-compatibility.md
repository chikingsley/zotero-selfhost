# Object API compatibility

Status: implemented locally, not yet verified against the official remote-test slice.

## Implemented

- User and group item `PUT /items/:itemKey` can create a missing object when `If-Unmodified-Since-Version: 0` is provided.
- User and group collection `PUT /collections/:collectionKey` can create a missing object when `If-Unmodified-Since-Version: 0` is provided.
- User and group saved-search `PUT /searches/:searchKey` can create a missing object when `If-Unmodified-Since-Version: 0` is provided.
- Existing object `PUT` and `PATCH` paths still enforce object or library version preconditions.
- Collection and saved-search batch/single writes normalize `deleted=false` by removing the `deleted` property.
- Item batch/single writes normalize `deleted=true` to `1` and `deleted=false` by removing the `deleted` property, matching the official trash-state shape observed in the object tests.

## Remaining calibration

- Run the official object remote-test slice against this Worker.
- Compare exact write-report body shape for unchanged and failed object writes.
- Confirm whether relation-driven item updates alter object-test version expectations.
