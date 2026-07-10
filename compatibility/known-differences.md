# Known Differences vs the Official Dataserver

The current isolated Cloudflare D1/R2 baseline is green for every official v3 test that runs: `451 passing`, `22 pending`, `0 application failures`.

This file tracks accepted differences and harness caveats, not open failures.

## Upstream-Pending Tests

- **Schema legacy-client cases**: the official JavaScript test file marks these
  cases skipped, matching the skipped PHP originals.
- **TTS suite**: the official test harness skips the suite when `ttsTestKey` is
  not configured. The server has deterministic TTS compatibility routes, but
  real speech synthesis is not part of the current product.

## Local Harness Caveats

- **D1 full-text state adapter**: four upstream full-text assertions directly manipulate Zotero.org's DynamoDB state rather than using HTTP. When `fullTextStateAPI` is enabled, the compatibility runner redirects only that helper through a Node loader to the isolated Worker's authenticated D1 test-state endpoint. The pinned upstream checkout and its assertions remain unchanged.
- **Local Wrangler external-service cases**: the official suite directly uses AWS S3 for a small set of file setup assertions. Local Miniflare R2 has no AWS credentials or HTTPS storage hostname, so those cases remain live-deployment checks. The application-level R2 upload/download flow is covered by Workers Vitest.
- **Partial-update tools**: the official file tests skip some optional
  `bsdiff`, `xdelta3`, and `vcdiff` CLI subcases when those tools are not
  installed locally. The Worker bundles WASM support for the supported
  partial-update algorithms, and the official file test passes. Separate
  Workers-runtime fixtures execute bsdiff plus both xdelta/vcdiff names inside
  `workerd`, so the host CLI skips do not leave the deployed WASM path untested.
- **Upstream npm audit**: Zotero's pinned remote-test lock currently reports
  advisories in test-only dependencies. The managed checkout is ignored,
  excluded from Worker bundles, and installed with lifecycle scripts disabled;
  this repo does not patch the upstream oracle in place.

## Deliberate Product Scope

- **TTS**: deterministic compatibility stub unless a future product decision
  adds a real speech provider.
- **Web translation**: local compatibility behavior for the official tests; a
  production translation feature would need a real translation service decision.
- **Notifications**: API-compatible notification headers are also published to authenticated WebSocket subscribers by the hibernating `ZoteroStreamHub` Durable Object. Runtime tests force Durable Object eviction and cover reconnect, invalid keys, and revoked keys. The remaining live gate is passive notification and normal sync between two real Desktop clients; streaming does not replace the standard HTTP sync process.
