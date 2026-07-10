# Cloudflare Production Runbook

This document separates fresh installation, the existing legacy deployment,
and destructive compatibility testing.

## Final Production Shape

- Worker: `zotero-selfhost`
- D1: `zotero-selfhost-db`
- R2: `zotero-selfhost-attachments`
- Durable Object class: `ZoteroStreamHub`
- Binding: `STREAM_HUB`
- Runtime mode: `production`
- Required permanent secrets: `FILE_URL_SIGNING_SECRET`, `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`

Fresh installation should use the package CLI. It creates resources, applies
migrations, deploys, bootstraps one owner, and removes the temporary bootstrap
secret:

```bash
npx zotero-selfhost-server setup
```

Wrangler OAuth is the default Cloudflare deployment authentication path. Before
setup, create a separate R2 `Object Read & Write` API token scoped only to
`zotero-selfhost-attachments`, then provide its Access Key ID and Secret Access
Key through `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, plus the account ID
through `CLOUDFLARE_ACCOUNT_ID`. Do not reuse a broad Cloudflare deployment
token. Setup installs these values as Worker secrets.

## Deploy To Cloudflare Button

The root README button points at the `server/` subdirectory. Cloudflare can
provision D1, R2, and Durable Objects from the tracked Wrangler configuration
and prompt for the permanent secrets from `.env.example`.

After button deployment, finish local bootstrap with:

```bash
npx zotero-selfhost-server setup --existing \
  --url https://your-worker.example.workers.dev
```

The source repository must be public before unrelated users can deploy it. A
browser-only button cannot safely inspect or modify a local Zotero profile, so
profile migration remains a local CLI operation.

Cloudflare references:

- <https://developers.cloudflare.com/workers/platform/deploy-buttons/>
- <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>

## Owner Bootstrap And Recovery

Production has no root username/password.

- Bootstrap uses a random `BOOTSTRAP_TOKEN`, creates the installation record and
  first owner API key atomically, then deletes the token.
- Recovery uses a random `RECOVERY_TOKEN`, creates a replacement owner key, and
  deletes the token.
- The Cloudflare account is therefore the ultimate recovery authority.
- `FILE_URL_SIGNING_SECRET` signs short-lived file URLs. Rotating it invalidates
  outstanding URLs, not stored R2 objects.
- The R2 credential signs 15-minute upload URLs for one attachment object or
  multipart part. Rotating it invalidates outstanding upload URLs but does not
  alter stored objects.

## Attachment Upload Transport

Attachment storage has one authorization record, one R2 object key, and one
registration path. Direct-capable clients request `direct=1`:

- Files below 64 MiB receive one presigned R2 `PUT`.
- Files at or above 64 MiB receive 16 MiB multipart part URLs; each part can be retried
  independently, and the Worker completes the R2 multipart upload.
- The Worker verifies the completed object's exact authorized size before the
  normal Zotero file-registration request can associate it with the item.

Stock Zotero's storage protocol uploads a multipart HTML form with `POST`.
Cloudflare R2 presigned URLs support `PUT` but not presigned form `POST`, so the
existing Worker upload endpoint remains as a compatibility transport for stock
clients. It converges into the same D1/R2 records rather than a second storage
system.

Cloudflare references:

- <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- <https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/>
- <https://developers.cloudflare.com/r2/api/tokens/>

If every owner key is lost:

```bash
npx zotero-selfhost-server recover
```

The CLI stores only non-secret deployment discovery metadata. Owner/device API
keys belong in the user's password manager or client credential store.

## Compatibility Isolation

Never point `wrangler.compatibility.jsonc` at production resources.

The explicit compatibility configuration uses:

- Worker `zotero-selfhost-compatibility`
- D1 `zotero-selfhost-compatibility-db`
- R2 `zotero-selfhost-compatibility-attachments`
- `DEPLOYMENT_MODE=compatibility-test`
- `COMPATIBILITY_TEST_ADMIN_TOKEN`
- `COMPATIBILITY_TEST_API_KEY`

Only that mode allows `/test/setup`, test full-text state, legacy password key
creation, and destructive reset behavior. Production returns `404` for test
administration.

## Production Cutover And Legacy Rollback

The controlled production cutover completed on 2026-07-10. The active stack is:

- Worker `zotero-selfhost`
- D1 `zotero-selfhost-db`
- R2 `zotero-selfhost-attachments`
- Custom domain `zotero.peacockery.studio`
- Fallback URL `zotero-selfhost.cheez2012.workers.dev`

The legacy Worker `zotero`, D1 database `zotero`, and R2 bucket
`zotero-attachments` remain intact without the custom-domain association. They
are rollback resources and must not be deleted during the observation window.

Cutover verification included a portable D1 export and SQLite integrity check,
R2 byte count/MD5/ZIP verification, the full repository gate, and disposable
two-profile Zotero Desktop A-to-B-to-A convergence through both the fallback URL
and the production custom domain. Acceptance items and temporary device keys
were removed after each run.

## Backup And Restore

D1 portable export:

```bash
wrangler d1 export DB --remote --output database.sql
```

Cloudflare D1 Time Travel provides short-term point-in-time recovery; exported
SQL provides a portable backup. Review migration state before importing.

R2 supports the S3-compatible API with region `auto`. Back up the whole bucket,
including attachment and legacy storage paths, and verify object counts and
hashes after restore.

- D1 import/export:
  <https://developers.cloudflare.com/d1/best-practices/import-export-data/>
- D1 Time Travel:
  <https://developers.cloudflare.com/d1/reference/time-travel/>
- R2 with AWS CLI:
  <https://developers.cloudflare.com/r2/examples/aws/aws-cli/>

## Zotero.org Import

A Zotero.org API key is a one-time source credential, not self-host server
authentication. The local importer now:

1. Authenticates both source and target without persisting either key.
2. Inventories the personal library, including trash and full text.
3. Refuses a non-empty target unless merge mode is explicit.
4. Writes through Zotero API v3 routes in dependency order while preserving
   object keys.
5. Downloads source-available attachments to temporary files and verifies
   source/target MD5s. Attachment records whose source bytes are already
   unavailable retain their metadata and are reported separately.
6. Records resumable non-secret progress.
7. Verifies keys/counts and rechecks the source library version before marking
   the import complete.

For source attachment records whose Zotero.org bytes are unavailable, pass a
reviewed version-1 `--recovery-manifest`. It maps attachment keys to local
archive files. Planning hashes the files and reports them separately; execution
rehashes them before upload and does not modify Zotero.org.

Run the dry inventory and executable import before changing Desktop:

```bash
ZOTERO_IMPORT_API_KEY='...' SELFHOST_API_KEY='...' \
  npx zotero-selfhost-server import --url https://your-worker.example.com

ZOTERO_IMPORT_API_KEY='...' SELFHOST_API_KEY='...' \
  npx zotero-selfhost-server import --url https://your-worker.example.com --execute
```

The first profile cutover requires that verified state. It makes a local
backup, updates the personal-library API/key/stream authority through Zotero
itself, marks only that library for a full merge sync, and verifies the result.
Group libraries are preserved locally and skipped in this slice; they are not
silently deleted or claimed as migrated.

## Custom Domain Cutover

The custom domain is the stable client URL, not a separate database. It now
invokes the final `zotero-selfhost` Worker. Cloudflare treats a Worker Custom
Domain as the origin for that hostname.

For rollback, reassign `zotero.peacockery.studio` to the legacy `zotero` Worker;
do not delete or modify the final D1/R2 resources during that operation. Keep
the legacy Worker/resources until the observation window is explicitly closed.
