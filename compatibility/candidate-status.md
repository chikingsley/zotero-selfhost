# Candidate Server - Official Test Status

## Cloudflare D1/R2 live path

Latest real-client verification: 2026-07-09T09:04:06Z against
`https://zotero.peacockery.studio/`, Worker version
`410d4f5e-b8c9-472c-9216-6fe9e938f922`.

- Real `/Applications/Zotero.app` launched with a disposable profile under
  `/tmp/zotero-real-app-smoke`.
- Desktop smoke passed: created a book, child note, and stored-file attachment;
  synced data and files; edited the book; trashed the note; synced again.
- The smoke is now repeatable via `cd server && bun run smoke:desktop`; the
  script drives Zotero's own Run JavaScript window, waits for the app-written
  result file, then verifies remote API state.
- Outside-the-app API verification confirmed the edited title, the note in
  trash, the attachment served as `application/zip`, and full-text version data.
- An earlier desktop run exposed two client-only compatibility bugs that are now fixed:
  batch item writes accept a known synced version range when the current
  `If-Unmodified-Since-Version` header matches, and full-text batch responses
  include `successful[index].key`.

Earlier first-client official board: 2026-07-09T06:21:44Z against
`https://zotero.peacockery.studio/`, Worker version
`1e8c6b18-4e74-4280-aa1a-517911315118`.

Command:

```bash
cd server
bun ../compatibility/run-zotero-tests.ts \
  --config ../compatibility/config/candidate-cloudflare.local.json \
  -- -v 3 -t 120000 version,collection,item,file
```

| Slice | Score | Status |
| --- | --- | --- |
| version | 27/27 | green |
| collection | 15/15 | green |
| item | 109/109 | green |
| file | 22/22 | green |
| total | 173/173 | green |

Notes:

- The deployed Worker uses Cloudflare D1 and R2 bindings, not in-memory storage.
- The local ignored Cloudflare config derives R2 S3-compatible AWS SDK
  credentials from the ignored `server/.env` token at runtime.
- The official partial-update test still skips optional local binary diff tool
  subcases when `bsdiff`, `xdelta3`, and `vcdiff` are not installed, but the
  Zotero test case itself passes.

## Full official v3 live compatibility

Latest broad live run: 2026-07-09T09:03:43Z against
`https://zotero.peacockery.studio/`, Worker version
`410d4f5e-b8c9-472c-9216-6fe9e938f922`.

Command:

```bash
cd server
bun ../compatibility/run-zotero-tests.ts \
  --config ../compatibility/config/candidate-cloudflare.local.json \
  -- -v 3 -t 240000
```

Result: `451 passing`, `22 pending`, `0 failing` in 22 minutes.

The 22 pending cases are upstream-skipped tests, not active server failures:

- `schema`: 8 skipped cases.
- `tts`: 14 skipped cases.

Previously failing areas now covered green in the broad live run:

- `notifications`
- `group`
- `permissions`
- `fulltext`
- `publications`
- `keys`
- `loginSessions`
- `relation`
- `sort`
- `params`
- `atom`
- `translation`
- `bib`
- `export`

There are no known failing official v3 API slices in the latest live run.

## In-memory local path

Historical scores from the removed in-memory path follow. This path is no
longer executable or part of the fast regression gate.

Scores from running Zotero's official remote test suite
(`references/dataserver/tests/remote/tests/3`) against the candidate server in
in-memory mode (`server/scripts/serve.ts`). Last full board: 2026-07-08.

| Slice | Score | Status |
| --- | --- | --- |
| general | 3/3 | ✅ green |
| version | 27/27 | ✅ green |
| object | 16/16 | ✅ green |
| collection | 15/15 | ✅ green |
| note | 10/10 | ✅ green |
| settings | 25/25 | ✅ green |
| search | 9/9 | ✅ green |
| annotation | 20/20 | ✅ green |
| item | 109/109 | ✅ green |
| file | 19/22 | 🟡 3 remaining need external infra (see known-differences) |
| tag | 22/22 | ✅ green |

## How to reproduce

```bash
# Historical only: the former in-memory candidate is no longer available.
# Current local runs use `cd server && bun run dev` and the commands documented
# in compatibility/README.md.
```

The harness needs a local-only `references/dataserver/tests/remote` clone and
the current Zotero schema at
`references/dataserver/htdocs/zotero-schema/schema.json`. See
`compatibility/README.md` for the refresh command.

## Local Workers runtime safety net

Current fast gate: Cloudflare Workers Vitest integration with the tracked
`wrangler.jsonc`, all three D1 migrations, isolated local D1/R2 bindings, and
requests through the Worker's exported `fetch()` handler.

- `13 passing`, `0 failing` across health/OpenAPI, test-user persistence,
  general item flow, D1 version preconditions, migration state, direct R2
  metadata/ranges, a complete attachment upload/register/download round trip
  through D1/R2, Zotero's serialized Atom multi-content field order, real
  bsdiff/xdelta/vcdiff WASM fixtures, and explicit unsupported-xdiff handling.
- Pinned official local smoke at Zotero `dataserver`
  `9b640674e94f1817513799fe82124be041b303b2`: `general,version` is `30
  passing`, `0 failing` against local Wrangler D1/R2.
- Pinned complete local run after removing the memory backends: `445 passing`,
  `22 pending`, `6 environment-only failures`. The six require an HTTPS storage
  hostname, direct AWS S3 access, or direct DynamoDB access from the upstream
  harness; no application-level D1/R2 assertion failed.
