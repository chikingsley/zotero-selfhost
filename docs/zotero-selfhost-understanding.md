# Zotero Self-Host Project Shape

## Product Boundary

The repository root is a Zotero-compatible sync authority on Cloudflare:

- Worker HTTP API and authentication;
- D1 metadata, versions, users, keys, and sync state;
- R2 attachment bytes;
- hibernating Durable Object WebSocket notifications;
- setup/recovery CLI;
- Workers-runtime characterization tests.

It is not Zotero's PHP dataserver, the Zotero Web Library, or a transparent
ongoing mirror of Zotero.org. Zotero.org becomes an optional one-time migration
source. After cutover, the self-hosted server is authoritative.

## Permanent Maintenance Surfaces

- `src/`, `migrations/`, and the root Wrangler files: deployed Worker package.
- `cli/`: the complete CLI surface, including command modules, private
  implementation, CLI tests, and its private npm bundling code.
- `src/vendor/bsdiff-wasm/`: the documented Worker-compatibility fix required
  for Zotero `bsdiff` partial attachment updates.
- `tests/`: Workers-runtime tests plus opt-in live deployment probes under `tests/live/`.
- `compatibility/`: the pinned upstream oracle, its ignored local vendor
  checkout, runner, configuration, and measured results.
- `docs/cloudflare-production-runbook.md`: deployment, recovery, backup, and
  legacy-resource cutover.
- `TODO.md`: unfinished product/release work.
- `CHANGELOG.md`: completed implementation history.

## Release Loop

1. Run `bun run check` from the repository root.
2. Run the pinned official smoke against an isolated compatibility Worker.
3. Run the complete oracle before compatibility milestones.
4. Run disposable-profile and two-device Desktop tests.
5. Exercise lost-key recovery.
6. Back up D1/R2 before import or resource cutover.
7. Report docs-only, locally implemented, deployed, migrated, and verified
   states literally.

## Next Product Layer

The importer, backed-up profile migration/rollback, production D1/R2 migration,
custom-domain cutover, recovery drill, and disposable A -> B -> A Desktop
acceptance have all been completed. The remaining release gates are the
fresh-account Deploy to Cloudflare test and passive two-client streaming/file
round-trip acceptance recorded in `TODO.md`.
