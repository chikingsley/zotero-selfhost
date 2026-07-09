# Known Differences vs the Official Dataserver

The current deployed Cloudflare D1/R2 baseline is green for every official v3
test that runs: `451 passing`, `22 pending`, `0 failing`.

This file tracks accepted differences and harness caveats, not open failures.

## Upstream-Pending Tests

- **Schema legacy-client cases**: the official JavaScript test file marks these
  cases skipped, matching the skipped PHP originals.
- **TTS suite**: the official test harness skips the suite when `ttsTestKey` is
  not configured. The server has deterministic TTS compatibility routes, but
  real speech synthesis is not part of the current product.

## Local Harness Caveats

- **In-memory `file` slice**: the fast local memory server cannot satisfy the
  S3/R2-specific file tests that require real object storage credentials and URL
  shapes. The deployed Cloudflare D1/R2 path is the compatibility baseline for
  file behavior.
- **Partial-update tools**: the official file tests skip some optional
  `bsdiff`, `xdelta3`, and `vcdiff` CLI subcases when those tools are not
  installed locally. The Worker bundles WASM support for the supported
  partial-update algorithms, and the official file test passes.

## Deliberate Product Scope

- **TTS**: deterministic compatibility stub unless a future product decision
  adds a real speech provider.
- **Web translation**: local compatibility behavior for the official tests; a
  production translation feature would need a real translation service decision.
- **Notifications**: API-compatible notification headers are implemented for
  the official tests. A separate realtime/SNS-style fan-out service is not part
  of the current server product.
