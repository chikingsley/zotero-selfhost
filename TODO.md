# TODO

Active product queue. Measured protocol results live in
`compatibility/candidate-status.md`; completed implementation history lives in
`CHANGELOG.md`.

## Unreleased foundation implemented

- [x] Use final defaults: Worker `zotero-selfhost`, D1
  `zotero-selfhost-db`, and R2 `zotero-selfhost-attachments`.
- [x] Remove production root username/password fallbacks and isolate the
  official oracle's destructive administration behind
  `DEPLOYMENT_MODE=compatibility-test` plus a separate test token.
- [x] Add a one-time installation record, owner API keys, and a migration that
  preserves administrative access for existing user-1 deployments.
- [x] Add temporary-token owner bootstrap and Cloudflare-account recovery
  without resetting D1/R2.
- [x] Add the publishable `zotero-selfhost` CLI entrypoint with `setup` and
  `recover` commands usable through npm, Bun, pnpm, and Yarn runners.
- [x] Generate `FILE_URL_SIGNING_SECRET` during CLI deployment and stop using
  test or administrator credentials as signing-secret fallbacks.
- [x] Add `ZoteroStreamHub`, a hibernating WebSocket Durable Object that accepts
  Zotero streaming subscriptions and publishes committed response
  notifications.
- [x] Add workerd tests for bootstrap, recovery, owner-key administration, and
  streaming subscription/delivery.
- [x] Keep production and compatibility Wrangler resources/configuration
  separate.
- [x] Add a dry-run-first, resumable personal-library importer for collections,
  items/trash, saved searches, settings, stored files, and full text, including
  source-stability, target-inventory, key, and MD5 verification.
- [x] Add backed-up existing-profile migration with verified-import gating,
  personal-library identity rewriting, first full merge sync, and explicit
  rollback with a pre-rollback safety copy.
- [x] Add an A -> B -> A disposable Desktop harness that uses production owner
  and per-device key paths rather than destructive compatibility setup.
- [x] Add one attachment authorization/storage path with direct R2 single PUT
  below 64 MiB, direct R2 multipart PUT at or above 64 MiB, bounded importer
  retries, and the stock-Zotero form-POST compatibility transport.

## Release proof still required

- [x] Back up and migrate the legacy D1/R2 deployment to the final resource
  names, verify the imported rows and attachment bytes/hashes, deploy the final
  Worker, move the custom domain, and retain the legacy stack for rollback.
- [x] Run disposable Zotero Desktop A -> B -> A metadata and attachment
  convergence against both the fallback URL and production custom domain, then
  remove the temporary items and device keys.
- [x] Run an authenticated, non-writing inventory of the real Zotero.org
  personal library and production target: 414 items, 10 collections, 61
  verifiable stored files, 113 stored-file records without source bytes, 164
  full-text records, 48 settings, and 3 disposable target items.
- [x] Restore and verify the 4.6 GB/294-file books archive from `gmk-server`,
  review attachment-key matches, and create a private recovery manifest for
  108 files. The resulting dry run verifies 169 stored files and leaves 5
  unavailable attachment records whose metadata will still be preserved.
- [x] Explicitly accept the 5 unmatched attachment records as metadata-only or
  provide another source for them: *Trauma and the Soul* URL file, *Défi A1*,
  *Version Originale 2*, the Gemini/NotebookLM marketing guide, and the Fake
  Assistant cheat sheet.
- [x] Execute and verify the real personal-library import into the empty target
  after the final backup and smoke-tree removal: 10 collections, 414 items,
  169 files, 48 settings, and 164 full-text records verified against stable
  Zotero.org source version 1394.
- [ ] Migrate the backed-up existing Desktop profile now that the import state
  is verified, then complete a normal full merge sync and rollback check.
- [ ] Publish `zotero-selfhost-server` to npm and execute all four documented
  package-runner forms against the published artifact.
- [ ] Make the repository public and validate the Deploy to Cloudflare button
  from a fresh Cloudflare account.
- [ ] Deploy an isolated compatibility Worker with the new auth boundary and
  rerun the complete pinned official suite.
- [ ] Run the disposable Zotero Desktop smoke against the new compatibility
  deployment, including the new streaming URL.
- [ ] Extend two-Desktop acceptance so A commits, B receives `topicUpdated`
  without a manual wake-up, B performs normal sync, and files round-trip in
  both directions.
- [ ] Exercise Durable Object eviction/reconnect behavior and invalid/revoked
  key behavior.
- [ ] Add a repeatable recovery exercise that restores a current production
  D1 export and R2 backup into disposable resources and verifies the result.

## Migration and client onboarding

- [x] Implement a one-time Zotero.org personal-library importer that consumes
  `ZOTERO_IMPORT_API_KEY` locally, writes through supported server paths,
  verifies object keys and attachment hashes, and never persists either key.
- [x] Implement safe existing-profile migration: require Zotero to stop, back
  up the profile/database, install API/stream URLs and a device key, reset only
  personal-library sync history, full-sync, verify, and provide rollback.
- [x] Implement new-device key creation and A -> B -> A personal-library/file
  download verification. The production deployment run remains a release gate.
- [ ] Decide the stock-mobile strategy: upstream custom-server support, a
  maintained fork, or the future first-party app.

## Simplification after product hardening

- [ ] Split the largest D1 store and compatibility-support modules by domain
  only after migration and two-device tests cover their public behavior.
- [ ] Consolidate repeated library-version reservation, authorization, paging,
  and notification publication helpers.
- [ ] Remove remaining compatibility-only branches from production modules
  where a dedicated test adapter can preserve the pinned oracle unchanged.
- [ ] Re-measure bundle size, D1 query counts, and mutation latency after each
  consolidation pass.
