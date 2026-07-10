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
- `cli/`: authored, published CLI source and its unit tests.
- `build/`: package-build internals that are not product commands.
- `tools/recovery/`: explicit operator-only D1 and R2 recovery utilities.
- `tests/`: Workers-runtime tests plus opt-in live deployment probes under `tests/live/`.
- `compatibility/`: pinned official black-box oracle, configs, and measured
  status.
- `docs/cloudflare-production-runbook.md`: deployment, recovery, backup, and
  legacy-resource cutover.
- `TODO.md`: unfinished product/release work.
- `CHANGELOG.md`: completed implementation history.

Ignored `references/` checkouts are reproducible maintenance inputs. They are
not bundled or published.

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

The importer, backed-up personal-profile migration/rollback, and disposable
A -> B -> A Desktop harness now exist locally. The remaining critical work is
running those gates against isolated production-shaped resources, proving the
streaming wake-up path between real clients, migrating the legacy Cloudflare
D1/R2 data, and only then cutting over the custom domain. Code consolidation
follows those safety nets so splitting the large compatibility modules cannot
silently change Zotero behavior.
