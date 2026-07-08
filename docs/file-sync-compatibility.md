# Zotero file sync compatibility

## Official contract surface

Primary local references:

- `references/dataserver/tests/remote/tests/3/file.test.js`
- `references/dataserver/controllers/ItemsController.php`
- `references/dataserver/include/config/routes.inc.php`

The Zotero file sync flow is not a plain S3 API. The client talks to the Zotero
API first, then uploads bytes to the returned storage URL, then registers that
upload with the Zotero API.

## Implemented local-compatible flow

Current Worker routes support the core three-step flow for user and group
libraries:

1. `POST /users/:userID/items/:itemKey/file`
   - Requires normal Zotero API key auth.
   - Requires `If-Match` or `If-None-Match`.
   - Accepts Zotero form params: `md5`, `filename`, `filesize`, `mtime`,
     `contentType`, and `charset`.
   - Supports ZIP upload metadata with separate ZIP file hash/name and
     attachment-item hash/name.
   - Returns a Zotero-style JSON authorization object with `uploadKey`, `url`,
     `prefix`, `suffix`, and `contentType`.

2. `POST /users/:userID/items/:itemKey/file/upload/:uploadKey`
  - Verifies the uploaded body against the queued MD5 before accepting it.
  - Verifies the uploaded body length against the queued `filesize`.
  - Stores the uploaded body in the configured R2 bucket when `ATTACHMENTS`
     exists.
   - Uses in-memory bytes in direct local app tests when no R2 binding exists.
   - Supports raw body upload and the multipart `params=1` body shape used by
     Zotero's official tests.

3. `POST /users/:userID/items/:itemKey/file`
   - With `upload=<uploadKey>`, registers the uploaded object.
   - Updates item metadata fields: `md5`, `filename`, `mtime`, `contentType`,
     `charset`, and `version`.
   - Stores file metadata in D1 `attachment_files`, including charset for exact
     download `Content-Type` responses.
   - Rejects uploads that exceed the effective owner quota before issuing an
     upload key.
   - Rejects file authorization for missing attachment items.

Partial-upload route guards:

- `PATCH /users/:userID/items/:itemKey/file`
- `PATCH /groups/:groupID/items/:itemKey/file`

These routes validate the Zotero partial-upload request shape, including API-key
access, item existence, `upload`, `algorithm`, `If-Match`, current file
existence, and current MD5 match.

For `algorithm=bsdiff`, the Worker applies the patch with `bsdiff-wasm`, stores
the patched bytes through the normal queued upload path, verifies the queued
target MD5/filesize through existing upload checks, registers the upload, and
returns `204` with `Last-Modified-Version`.

For `algorithm=xdelta` and `algorithm=vcdiff`, the Worker applies the delta with
`xdelta3-wasm`, then uses the same queued-upload verification and registration
path. This matches the reference server's behavior of applying both formats via
`xdelta3`.

The `xdelta3-wasm` integration imports the compiled `.wasm` module directly and
uses the xdelta3 memory ABI inside `server/src/patch.ts`, instead of relying on
the package's generated browser wrapper to fetch a relative `.wasm` URL at
runtime. `server/wrangler.jsonc` also declares `CompiledWasm` module rules for
the patch-engine `.wasm` assets so Wrangler includes them in Worker deployments.

For `algorithm=xdiff`, the routes still return `501` after request validation
because Zotero's optional PHP `xdiff` extension path is not wired into the
Worker runtime.

Download/view routes:

- `GET /users/:userID/items/:itemKey/file`
- `GET /users/:userID/items/:itemKey/file/view`
- `GET /users/:userID/items/:itemKey/file/view/url`
- `GET /users/:userID/items/:itemKey/file/raw/:md5/:filename`
- `GET /groups/:groupID/items/:itemKey/file`
- `GET /groups/:groupID/items/:itemKey/file/view`
- `GET /groups/:groupID/items/:itemKey/file/view/url`
- `GET /groups/:groupID/items/:itemKey/file/raw/:md5/:filename`
- `GET /users/:userID/publications/items`
- `GET /users/:userID/publications/items/:itemKey`
- `GET /users/:userID/publications/items/:itemKey/file/view`
- `GET /users/:userID/publications/items/:itemKey/file/view/url`
- `GET /users/:userID/publications/items/:itemKey/file/raw/:md5/:filename`

The API routes redirect to a signed, expiring Worker raw-file URL, matching
Zotero's normal temporary-URL pattern while keeping the bytes in R2.

## Known gaps

- Partial upload patch support is implemented for the official test algorithms:
  `bsdiff`, `xdelta`, and `vcdiff`. The official compatibility slice still needs
  to be run against the candidate server before this can be treated as proven
  green behavior.
- WASM bundling is configured for the patch engines, but a Wrangler dry-run build
  still needs to prove the final Worker upload shape.
- Group member persistence and read/edit/file-edit authorization are wired.
- Owner transfer, member removal, and group user listing routes are wired.
- Publication item and file route aliases are wired for `inPublications` items.
- Storage quota admin and upload quota rejection are wired.
- Raw-file URLs are signed and expire after five minutes.
