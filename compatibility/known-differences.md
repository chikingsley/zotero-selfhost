# Known Differences vs the Official Dataserver

Deliberate or environment-bound deviations. Everything else is tracked as a
plain test failure in `candidate-status.md`.

## Environment-bound (not fixable in local in-memory mode)

- **HTTPS S3-style download URLs** (`file` slice): the official server
  redirects file downloads to `https://<bucket>/<hash>/…` S3 URLs. The local
  candidate serves signed HTTP URLs from its own origin. One official test
  asserts the `https://` S3 URL shape and fetches it; it needs TLS plus an
  S3-compatible store (R2/MinIO) in front of the candidate.
- **Old-style S3 filename test** (`file` slice): seeds S3 directly with the
  AWS SDK before calling the API; requires real S3 credentials.
- **`test.pdf` exists-dedupe test** (`file` slice): the harness mangles the
  binary body via string concatenation; officially the test only passes when
  S3 already holds the file from a previous run (`exists=1` short-circuit).
  On a fresh store it cannot pass; treated as a flaky oracle datapoint.

## Deliberate scope choices

- **Partial uploads (bsdiff/xdelta/vcdiff)**: implemented via WASM, but the
  official tests self-skip when the CLI tools are absent. Not part of the
  client contract (clients fall back to full-file upload).
- **TTS**: deterministic stub (voices/credits/speak/audio) — real speech
  synthesis needs a provider; no real client depends on it.
- **Web translation**: local shim answering the official test URLs; a real
  deployment would run Zotero's translation-server.
- **Notifications**: debug headers only; no SNS/stream fan-out service.
- **D1/R2 (Cloudflare) storage**: the memory store is the oracle-verified
  path today. The D1 store receives parity updates but is not yet
  oracle-tested end to end.
