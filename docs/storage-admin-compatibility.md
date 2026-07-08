# Storage admin compatibility

Status: implemented locally for the official storage-admin test cases, not yet verified against the official remote-test slice.

## Implemented

- Root-authenticated `GET /users/:userID/storageadmin` returns storage XML with quota, optional expiration, and usage totals.
- Root-authenticated `POST /users/:userID/storageadmin` accepts form-encoded `quota` and `expiration`.
- `quota=0&expiration=0` clears the storage subscription and returns the default 300 MB quota.
- Numeric quotas are persisted and returned in MB.
- `quota=unlimited` is persisted and rendered as `unlimited`.
- Quotas below current storage usage are rejected.

## Remaining calibration

- Run the official storage-admin remote-test slice against this Worker.
- Confirm exact XML shape and content type against the official dataserver.
