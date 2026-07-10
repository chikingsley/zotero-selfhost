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
- Required permanent secret: `FILE_URL_SIGNING_SECRET`

Fresh installation should use the package CLI. It creates resources, applies
migrations, deploys, bootstraps one owner, and removes the temporary bootstrap
secret:

```bash
npx zotero-selfhost-server setup
```

Wrangler OAuth is the default Cloudflare authentication path. A manually
created broad Cloudflare API token is not part of normal onboarding.

## Deploy To Cloudflare Button

The root README button points at the `server/` subdirectory. Cloudflare can
provision D1, R2, and Durable Objects from the tracked Wrangler configuration
and prompt for `FILE_URL_SIGNING_SECRET` from `.env.example`.

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

## Existing Legacy Deployment

The currently measured custom-domain deployment predates the final naming:

- Worker `zotero`
- D1 `zotero`
- R2 `zotero-attachments`
- Custom domain `zotero.peacockery.studio`

Changing tracked names does not move its data. D1 and R2 resource names are not
an in-place application-level rename. Use a controlled cutover:

1. Export/backup legacy D1 and inventory R2.
2. Create the final D1/R2 resources without touching the legacy Worker.
3. Apply current migrations to the final D1.
4. Import legacy D1 data and copy every R2 object.
5. Verify row counts, library versions, object counts, and attachment hashes.
6. Deploy `zotero-selfhost` with the final bindings.
7. Run HTTP oracle, recovery, attachment, streaming, and two-device smoke tests.
8. Move the custom domain only after all checks pass.
9. Retain legacy resources for a defined rollback window.

Do not run a fresh empty final Worker behind the existing custom domain.

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
5. Downloads attachments to temporary files and verifies source/target MD5s.
6. Records resumable non-secret progress.
7. Verifies keys/counts and rechecks the source library version before marking
   the import complete.

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

The custom domain is the stable client URL, not a separate database. “Move the
custom domain” means changing Cloudflare's Custom Domain association so the
same hostname invokes the final `zotero-selfhost` Worker instead of the legacy
`zotero` Worker. Cloudflare treats a Worker Custom Domain as the origin for
that hostname.

Do this only after the final D1/R2 resources contain verified data and the
isolated Worker passes recovery, import, attachment, streaming, and two-profile
tests. Moving it earlier would keep the friendly URL but point every client at
an empty or incomplete authority. The legacy Worker/resources remain the
rollback target during the defined observation window.
