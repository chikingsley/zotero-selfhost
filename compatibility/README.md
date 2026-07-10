# Zotero Compatibility Harness

This directory is a test harness, not a second server implementation. It contains the code this project uses to download, pin, configure, and run Zotero's upstream black-box HTTP tests against an isolated candidate server.

## Ownership

| Location | Owner | Purpose |
| --- | --- | --- |
| `../tests/*.test.ts` | This project | Fast Cloudflare Workers-runtime tests with isolated D1, R2, Durable Object, WebSocket, and WASM behavior. |
| `oracle.ts`, `run-zotero-tests.ts`, configs, and adapters | This project | Materialize and authenticate the upstream checkout, configure a candidate target, and bridge test-only infrastructure differences. |
| `vendor/dataserver/` | Zotero upstream | Ignored checkout of `https://github.com/zotero/dataserver.git` at the exact commit in `oracle.lock.json`. |
| `vendor/dataserver/tests/remote/tests/3` | Zotero upstream | Independent Mocha assertions against the public Zotero API v3 HTTP contract. |
| `../tests/live/` | This project | Explicit tests against actual Cloudflare resources or Zotero Desktop. |

Do not edit or commit `vendor/dataserver`. The upstream test suite remains independent precisely because this project does not rewrite its assertions.

The files `fulltext-state-adapter.mjs`, `fulltext-state-loader.mjs`, and `fulltext-state-register.mjs` are ours. They redirect four upstream test-infrastructure operations that normally call DynamoDB into the isolated candidate's authenticated D1 test adapter. They do not replace Zotero's protocol assertions.

## Why The Layers Stay Separate

Workers-runtime tests answer whether our implementation works with Cloudflare's actual runtime APIs and bindings. The upstream Zotero oracle answers whether an independent client sees the HTTP behavior it expects. Live tests answer whether hosted Cloudflare services and real Zotero Desktop work together.

Merging these layers would weaken them. Our runtime tests need implementation access; the upstream oracle is valuable because it has none.

## Pinned Source Of Truth

`oracle.lock.json` records the upstream repository, ref, exact 40-character commit, schema URL, and schema SHA-256. `compat:setup` verifies all of them before running upstream code.

The ignored checkout is created at `compatibility/vendor/dataserver`. Its important upstream paths are:

- `tests/remote/run_tests`
- `tests/remote/config/default.json`
- `tests/remote/setup.js`
- `tests/remote/api3.js`
- `tests/remote/tests/3`
- `htdocs/zotero-schema/schema.json`

The upstream dependency installation uses `npm ci --ignore-scripts`. Its test-only dependency tree currently reports advisories in XML, Mocha, and transitive tooling packages. Those dependencies are never bundled into the Worker or npm CLI package. The checkout remains unmodified so dependency remediation belongs upstream.

## Commands And Safety

| Command | What it does | Writes or resets data? | Automatic? |
| --- | --- | --- | --- |
| `bun run compat:setup` | Clones or updates the ignored checkout to the locked commit, verifies the schema hash, and installs upstream test dependencies with lifecycle scripts disabled. | Writes only ignored compatibility checkout files and dependencies. | Weekly CI and manual setup. |
| `bun run compat:status` | Reports the lock, checkout, schema, dependency state, cleanliness, and latest upstream ref. | Read-only; uses the network. | Manual. |
| `bun run compat:check-upstream` | Exits unsuccessfully if Zotero's tracked upstream ref has advanced beyond our locked commit. | Read-only; uses the network. | Weekly CI. |
| `bun run compat:update` | Advances the ignored checkout, downloads the current schema, and rewrites `oracle.lock.json`. | Changes a tracked lock file and must be reviewed. | Never automatic. |
| `bun run dev:compatibility` | Applies migrations to the isolated local compatibility D1 database and starts the compatibility-test Worker. | Uses only separately named local compatibility resources. | Started by weekly CI; manual for local runs. |
| `bun run test:oracle:smoke` | Runs Zotero's upstream `general` and `version` suites against the configured candidate. | The upstream setup route resets isolated compatibility tables and test users. Never point it at production. | Weekly CI and manual. |
| `bun run test:oracle` | Runs the complete pinned Zotero v3 suite against the configured candidate. | Destructive to the configured isolated compatibility data. Never point it at production. | Manual before compatibility milestones. |
| `bun run deploy:compatibility` | Deploys the explicitly separate compatibility Worker, D1 database, and R2 bucket. | Changes live compatibility resources. | Manual and requires explicit Cloudflare authorization. |
| `bun run smoke:desktop` | Drives a disposable Zotero Desktop profile against the configured compatibility deployment. | Creates and removes disposable test records and keys. | Manual. |

The production Worker returns `404` for `/test/*` before credential handling. The destructive setup and full-text state adapters exist only when `DEPLOYMENT_MODE` is `compatibility-test` and must use isolated D1 and R2 resources.

## What Runs Automatically

Every push and pull request runs `bun run check`, which includes this project's Workers-runtime tests, CLI tests, type checks, formatting/linting, and package verification.

The weekly `Compatibility oracle` workflow performs these steps:

1. Materialize the exact pinned upstream checkout.
2. Start an isolated local compatibility Worker.
3. Run the 30 upstream `general` and `version` smoke tests.
4. Fail if Zotero's tracked upstream ref no longer matches our pin.

The weekly workflow does not run the complete upstream suite and never changes `oracle.lock.json`. A new upstream commit requires a reviewed `compat:update`, the focused smoke, the relevant protocol slices, and the complete suite before the pin change is committed.

## Local Use

Materialize and inspect the oracle once:

```bash
bun run compat:setup
bun run compat:status
```

Start the isolated candidate in one terminal:

```bash
bun run dev:compatibility
```

Run the focused upstream smoke in another terminal:

```bash
bun run test:oracle:smoke
```

Run the complete suite only when its broader runtime and destructive test-data cost is appropriate:

```bash
bun run test:oracle
```

## Configuration

`compatibility/config/candidate.ci.json` is tracked and contains only disposable localhost test values for the scheduled smoke. It contains no deployment credentials.

Create ignored local configurations from the corresponding examples:

- `compatibility/config/candidate.example.json` → `candidate.local.json`
- `compatibility/config/reference.example.json` → `reference.local.json`

The candidate config's upstream-defined `rootUsername` and `rootPassword` fields map to Basic username `compatibility` and `COMPATIBILITY_TEST_ADMIN_TOKEN`. They are test-administrator inputs required by Zotero's runner, not a production root account.

For an explicitly isolated deployed candidate, use an ignored config such as `candidate-cloudflare.local.json` with the compatibility Worker URL and compatibility R2 bucket. When `cloudflareR2FromApiToken` is enabled, the runner derives temporary S3-compatible environment values from the ignored Cloudflare token without writing R2 credentials into the repository.

The runner refuses to start when the checkout commit, origin, dependencies, schema location, or schema hash differs from `oracle.lock.json`.

## Protocol Phases

| Phase | Test areas | Purpose |
| --- | --- | --- |
| 0 | `general`, `schema`, `version` | API base behavior, schema exposure, and sync version mechanics. |
| 1 | `item`, `collection`, `tag`, `settings`, `note` | Core personal-library metadata synchronization. |
| 2 | `file` | Attachment authorization, upload, registration, view, and download behavior. |
| 3 | `annotation`, `search`, `relation`, `sort`, `params`, `cache` | Rich library behavior and query semantics. |
| 4 | `keys`, `permissions`, `loginSessions` | Authentication and access-control behavior. |
| 5 | `group`, `publications`, `fulltext`, `translation`, `tts`, `storage-admin` | Broader API coverage; `tts` remains pending upstream. |

## Results And Differences

- [`verification-history.md`](verification-history.md) records dated results from specific revisions and deployments. It is historical evidence, not automatically current status.
- [`known-differences.md`](known-differences.md) records upstream-pending cases, harness caveats, and deliberate product-scope decisions.

When recording a new result, include the date, tested commit or Worker version, target resources, exact command, passing/pending/failing counts, and whether the run was local, isolated Cloudflare, or production. Do not overwrite a measurement with an unsupported claim about the current source.
