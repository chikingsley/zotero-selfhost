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

## Release proof still required

- [ ] Publish `zotero-selfhost-server` to npm and execute all four documented
  package-runner forms against the published artifact.
- [ ] Make the repository public and validate the Deploy to Cloudflare button
  from a fresh Cloudflare account.
- [ ] Migrate the existing `zotero` D1/R2 deployment to the final resource
  names using backup, export/import, R2 copy, verification, and custom-domain
  cutover. Do not treat the tracked config rename as a data migration.
- [ ] Deploy an isolated compatibility Worker with the new auth boundary and
  rerun the complete pinned official suite.
- [ ] Run the disposable Zotero Desktop smoke against the new compatibility
  deployment, including the new streaming URL.
- [ ] Add a two-Desktop acceptance test: A commits, B receives `topicUpdated`,
  B performs normal sync, and files round-trip in both directions.
- [ ] Exercise Durable Object eviction/reconnect behavior and invalid/revoked
  key behavior.
- [ ] Add D1 export/restore and R2 backup/restore acceptance exercises.

## Migration and client onboarding

- [ ] Implement a one-time Zotero.org importer that consumes
  `ZOTERO_IMPORT_API_KEY` locally, writes through supported server paths,
  verifies object counts and attachment hashes, and never persists the import
  key.
- [ ] Implement safe existing-profile migration: stop/coordinate Zotero, back
  up the profile, install API/stream URLs and a device key, reset only sync
  history, upload, verify, and provide rollback.
- [ ] Implement new-device connection/key creation and full-library download
  verification.
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
