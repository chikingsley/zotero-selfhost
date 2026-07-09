# Compatibility Plan

This folder tracks how we turn Zotero's official API behavior into a buildable compatible server.

## Source Of Truth

Primary oracle, materialized locally when needed:

- `../references/dataserver/tests/remote`
- `oracle.lock.json` pins the exact upstream commit and public schema digest.

Important files:

- `../references/dataserver/tests/remote/run_tests`
- `../references/dataserver/tests/remote/config/default.json`
- `../references/dataserver/tests/remote/setup.js`
- `../references/dataserver/tests/remote/api3.js`
- `../references/dataserver/tests/remote/tests/3`

The remote tests are HTTP-level tests. That makes them reusable: first against official `dataserver`, later against our candidate server.

`references/` is intentionally not committed. It is generated maintenance
input, not product source. Bootstrap the exact tracked oracle from `server/`:

```bash
bun run compat:setup
bun run compat:status
```

`compat:setup` checks out the locked commit, runs `npm ci --ignore-scripts`
against Zotero's upstream package lock, and installs only the schema matching
the tracked SHA-256. `compat:status` compares the pin, checkout, schema,
dependencies, and current upstream ref without changing them.

The current upstream test lock reports npm advisories in its test-only XML,
Mocha, and transitive tooling dependencies. Those packages remain confined to
the ignored oracle checkout, are never bundled into the Worker, and install
with lifecycle scripts disabled. Dependency remediation belongs upstream so
the oracle remains an unmodified Zotero test suite.

To intentionally advance the oracle:

```bash
bun run compat:update
bun run test:oracle:smoke
bun run test:oracle
```

`compat:update` advances the lock only after the new checkout and schema can be
materialized. Run the official suite before recording a new score in
`candidate-status.md`.

The complete upstream suite intentionally remains complete. Against local
Wrangler it currently reports six environment-only failures: one HTTPS storage
URL assertion, one direct AWS S3 fixture operation, and four direct DynamoDB
full-text state operations. Those are verified against the live Cloudflare
candidate; local application-level D1/R2 behavior is covered by Workers Vitest.

## Safety Layers

| Layer | Command | Purpose |
| --- | --- | --- |
| Workers runtime | `cd server && bun run test:runtime` | Fast tests inside `workerd` with isolated D1/R2 and real migrations. |
| Official Zotero oracle | `bun run test:oracle:smoke` / `bun run test:oracle` | Unmodified upstream black-box HTTP compatibility tests. |
| Live client | `bun run smoke:desktop` | Real Zotero Desktop sync against the configured deployment. |

The official Mocha suite stays upstream-owned. Do not translate it into Vitest;
the Workers Vitest suite characterizes this implementation, while the pinned
upstream suite remains an independent oracle.

## Test Phases

| Phase | Test areas | Purpose |
| --- | --- | --- |
| 0 | `general`, `schema`, `version` | Prove API base behavior, schema exposure, and sync version mechanics. |
| 1 | `item`, `collection`, `tag`, `settings`, `note` | Core personal-library metadata sync. |
| 2 | `file` | Stored attachments, upload registration, file view/download behavior. |
| 3 | `annotation`, `search`, `relation`, `sort`, `params`, `cache` | Rich library behavior needed by serious clients. |
| 4 | `keys`, `permissions`, `loginSessions` | Auth and access model. |
| 5 | `group`, `publications`, `fulltext`, `translation`, `tts`, `storage-admin` | Covered by the broad official v3 run; `tts` is pending/skipped upstream. |

## Current Target

The deployed candidate currently targets the full official v3 API suite against
Cloudflare D1/R2, with all non-pending tests green.

The remaining work is product packaging around that compatible API:

- Real deployment onboarding/auth decisions.
- License and public naming/trademark decisions.
- Optional web UI work. Zotero Desktop is configurable against the candidate API;
  the official Zotero Web Library is not a drop-in self-hosted client.

## Harness Strategy

Do not edit Zotero's official tests in place.

Preferred approach:

1. Keep the official checkout pinned and unmodified.
2. Run the fast Workers-runtime suite on every `bun run check`.
3. Run focused official slices while refactoring their corresponding behavior.
4. Run the complete official suite before compatibility milestones.
5. Copy no upstream assertions; add local characterization tests only for this
   implementation's Worker/D1/R2 integration.

## Status Files

- `candidate-status.md`: latest measured live and local compatibility status.
- `known-differences.md`: accepted deviations and harness caveats.

## Runner

Use `run-zotero-tests.ts` to run Zotero's official remote tests with runtime config supplied from this folder.

Examples:

```bash
# One-time oracle setup
cd server && bun run compat:setup

# Terminal 1: local Worker with pending D1 migrations applied
bun run dev

# Terminal 2: score it against Zotero's official tests
bun run test:oracle:smoke
```

Config files:

- `compatibility/config/reference.local.json`
- `compatibility/config/candidate.local.json`

Create them from the corresponding `.example.json` files. Local config files
are ignored because they can contain test credentials or local endpoints. The
runner refuses to start if the checkout commit, dependencies, or schema differ
from `oracle.lock.json`.

For the deployed Cloudflare D1/R2 candidate, use an ignored config such as
`compatibility/config/candidate-cloudflare.local.json` with the live
`apiURLPrefix`, `s3Bucket`, `awsRegion: "auto"`, and
`cloudflareR2FromApiToken: true`. Run the harness from `server/` so Bun loads
the ignored `server/.env`; the harness derives temporary AWS SDK environment
variables from the Cloudflare token without writing R2 secrets into the repo.
