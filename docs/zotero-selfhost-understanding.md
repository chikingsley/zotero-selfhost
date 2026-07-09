# Zotero Self-Host Understanding

This is the short project-shape note after the compatibility work moved from
research into a working Cloudflare server.

## What This Project Is

This repo now has one primary product:

- `server/`: a Cloudflare Workers/D1/R2 implementation of the Zotero API v3
  surface, validated against Zotero's official remote API tests and a real
  Zotero Desktop smoke.

The current measured baseline is in `compatibility/candidate-status.md`.

## What This Project Is Not

This is not a vendored copy of Zotero's official PHP `dataserver`, and it should
not ship cloned reference repositories. Those references were useful for
research and parity work, but they are local maintenance inputs, not product
source.

This is also not the official Zotero Web Library. Zotero Desktop can be pointed
at this API; a browser UI would be a separate product layer.

## Maintenance Inputs

When compatibility needs to be refreshed, clone the official Zotero dataserver
test oracle locally under `references/dataserver/`. That folder is ignored by
Git. The commands live in `compatibility/README.md`.

The permanent maintenance surfaces are:

- `server/`: product code, migrations, tests, Worker config.
- `compatibility/`: official-test runner, configs, status, accepted
  differences.
- `docs/cloudflare-production-runbook.md`: deployment, backup, import, and
  release notes.

## Keeping It Current

Use this loop when Zotero, Cloudflare, or dependencies move:

1. Update package dependencies and check `bun outdated`.
2. Refresh local Zotero official tests under ignored `references/dataserver/`.
3. Run targeted compatibility slices locally with `bun run dev:memory`.
4. Run the full official suite against the deployed Cloudflare D1/R2 path.
5. Run `bun run smoke:desktop` against the target endpoint.
6. Before risky migrations or imports, use D1 Time Travel/export and R2
   S3-compatible backup tooling.

## Product Direction

The next product work is packaging, not API compatibility:

- Public docs use the descriptive `Zotero Self-Host` name with an explicit
  non-affiliation disclaimer.
- Single-owner auth/onboarding: deployer-owned root credentials, local API
  keys, no central account service.
- Deploy to Cloudflare button pointed at the isolated `server/` package.
- Optional importer from Zotero.org using a user-provided Zotero API key.
- Optional web UI if this becomes more than a compatible sync server.
