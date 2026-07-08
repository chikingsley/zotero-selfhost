# Version compatibility

Status: implemented locally for conditional list reads and related existing version paths, not yet verified against the official remote-test slice.

## Implemented

- Item, collection, tag, search, and settings list endpoints return `304 Not Modified` when `If-Modified-Since-Version` is greater than or equal to the current library version.
- Existing list responses continue to include `Last-Modified-Version`.
- Existing `since` and `newer` filtering remains routed through the object/tag/search/settings list stores.
- Existing write paths continue to use `If-Unmodified-Since-Version` and object-version properties where implemented by the backing stores.

## Remaining calibration

- Run the official version remote-test slice against this Worker.
- Compare exact write-report failures for missing/existing objects with version headers and version properties.
- Confirm `Last-Modified-Version` behavior on all `400`, `412`, and batch failure responses.
- Confirm concurrent write behavior against D1 transactions and memory mode.
