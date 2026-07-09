# Compatibility Plan

This folder tracks how we turn Zotero's official API behavior into a buildable compatible server.

## Source Of Truth

Primary oracle, cloned locally when needed:

- `../references/dataserver/tests/remote`

Important files:

- `../references/dataserver/tests/remote/run_tests`
- `../references/dataserver/tests/remote/config/default.json`
- `../references/dataserver/tests/remote/setup.js`
- `../references/dataserver/tests/remote/api3.js`
- `../references/dataserver/tests/remote/tests/3`

The remote tests are HTTP-level tests. That makes them reusable: first against official `dataserver`, later against our candidate server.

`references/` is intentionally not committed. It is local maintenance input,
not product source. To refresh the oracle:

```bash
mkdir -p references
git clone https://github.com/zotero/dataserver references/dataserver
cd references/dataserver/tests/remote && npm install
curl -sL https://api.zotero.org/schema \
  -o ../../htdocs/zotero-schema/schema.json
```

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

1. Run official tests against official `dataserver`.
2. Record required config and passing/failing status here.
3. Create a thin runner/config adapter for our candidate server.
4. Copy or wrap individual tests only when a test depends on official-only setup endpoints.

## Status Files

- `candidate-status.md`: latest measured live and local compatibility status.
- `known-differences.md`: accepted deviations and harness caveats.

## Runner

Use `run-zotero-tests.ts` to run Zotero's official remote tests with runtime config supplied from this folder.

Examples:

```bash
# Terminal 1: fast in-memory candidate
cd server && bun run dev:memory

# Terminal 2: score it against Zotero's official tests
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 general
```

Config files:

- `compatibility/config/reference.local.json`
- `compatibility/config/candidate.local.json`

Create them from the corresponding `.example.json` files. Local config files are ignored because they can contain test credentials or local endpoints.

For the deployed Cloudflare D1/R2 candidate, use an ignored config such as
`compatibility/config/candidate-cloudflare.local.json` with the live
`apiURLPrefix`, `s3Bucket`, `awsRegion: "auto"`, and
`cloudflareR2FromApiToken: true`. Run the harness from `server/` so Bun loads
the ignored `server/.env`; the harness derives temporary AWS SDK environment
variables from the Cloudflare token without writing R2 secrets into the repo.
