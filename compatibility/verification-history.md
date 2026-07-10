# Compatibility Verification History

This file records dated results from specific source revisions and deployments. It is not an automatically generated statement about the current branch; use the linked GitHub Actions badges and rerun the relevant command when current evidence is required.

## 2026-07-10 source checkpoint

Source commit `7993087` passed `bun run check` with 24 Workers-runtime tests and 9 Node-compatible CLI tests. Its manually dispatched weekly workflow also materialized the pinned Zotero checkout, passed the 30-test upstream `general,version` smoke against an isolated local Worker, and confirmed that the tracked upstream ref still matched the lock.

## 2026-07-10 isolated release candidate

The isolated compatibility verification ran against `https://zotero-selfhost-compatibility.cheez2012.workers.dev/`, Worker version `bbc6bf92-2a35-4f95-b865-c5189d1a0528`, D1 database `zotero-selfhost-compatibility-db`, and R2 bucket `zotero-selfhost-compatibility-attachments`. A disposable Zotero Desktop profile also completed live metadata, deleted-note, full-text, and zipped-attachment synchronization with its compatibility streaming URL enabled while an authenticated WebSocket received the committed `topicUpdated` notification.

The first diagnostic run reported `446 passing`, `22 pending`, and `5 failing` in 25 minutes. One oversized-note request ended with a transient socket close and then passed in a focused `10/10` rerun. The other four reports came from upstream full-text tests directly invoking a DynamoDB helper, which cannot operate on the candidate's D1 state and received an R2 XML response through the AWS endpoint environment.

The runner now redirects only that upstream infrastructure helper through a tracked Node loader to the compatibility deployment's authenticated `/test/fulltext-state` D1 adapter. The upstream checkout and assertions remain unchanged. The complete full-text slice then passed `15/15`, including deindex, reindex, stale-rebuild, and search-gating behavior.

Final clean complete-suite result after adding the D1 adapter: `451 passing`, `22 upstream-pending`, `0 failing` in 26 minutes. The optional host `bsdiff`, `xdelta3`, and `vcdiff` commands were unavailable, so the upstream file test skipped those CLI-generated patch variants; the same algorithms remain covered by the Workers-runtime WASM fixtures.

## 2026-07-09 Cloudflare D1/R2 live path

Real-client verification at 2026-07-09T09:04:06Z against
`https://zotero.peacockery.studio/`, Worker version
`410d4f5e-b8c9-472c-9216-6fe9e938f922`.

- Real `/Applications/Zotero.app` launched with a disposable profile under
  `/tmp/zotero-real-app-smoke`.
- Desktop smoke passed: created a book, child note, and stored-file attachment;
  synced data and files; edited the book; trashed the note; synced again.
- The smoke is now repeatable via `bun run smoke:desktop` from the repository root; the
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
bun compatibility/run-zotero-tests.ts \
  --config compatibility/config/candidate-cloudflare.local.json \
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
  credentials from the ignored `.env` token at runtime.
- The official partial-update test still skips optional local binary diff tool
  subcases when `bsdiff`, `xdelta3`, and `vcdiff` are not installed, but the
  Zotero test case itself passes.

## 2026-07-09 full official v3 live compatibility

The broad live run at 2026-07-09T09:03:43Z targeted
`https://zotero.peacockery.studio/`, Worker version
`410d4f5e-b8c9-472c-9216-6fe9e938f922`.

Command:

```bash
bun compatibility/run-zotero-tests.ts \
  --config compatibility/config/candidate-cloudflare.local.json \
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

## 2026-07-08 historical in-memory local path

Historical scores from the removed in-memory path follow. This path is no
longer executable or part of the fast regression gate.

Scores from running Zotero's official remote test suite
(`compatibility/vendor/dataserver/tests/remote/tests/3`) against the candidate server in
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
# Current local runs use `bun run dev` from the repository root and the commands documented
# in compatibility/README.md.
```

The harness needs a local-only `compatibility/vendor/dataserver/tests/remote` clone and
the current Zotero schema at
`compatibility/vendor/dataserver/htdocs/zotero-schema/schema.json`. See
`compatibility/README.md` for the refresh command.

## 2026-07-09 local Workers-runtime checkpoint

The measured fast gate at this checkpoint used the Cloudflare Workers Vitest integration with the tracked `wrangler.jsonc`, all six D1 migrations, isolated local D1/R2/Durable Object bindings, and requests through the Worker's exported `fetch()` handler.

- `23 passing`, `0 failing` across health/OpenAPI, test-user persistence,
  general item flow, D1 version preconditions, migration state, direct R2
  metadata/ranges, a complete attachment upload/register/download round trip
  through D1/R2, Zotero's serialized Atom multi-content field order, real
  bsdiff/xdelta/vcdiff WASM fixtures, and explicit unsupported-xdiff handling.
  The gate now also covers one-time owner bootstrap, Cloudflare-style owner-key
  recovery, owner administration, authenticated Zotero streaming
  subscriptions, invalid and revoked streaming keys, reconnect/resubscribe behavior, hibernated WebSocket survival across forced Durable Object eviction, and `topicUpdated` delivery through `ZoteroStreamHub`.
- Pinned official local smoke at Zotero `dataserver`
  `9b640674e94f1817513799fe82124be041b303b2`: `general,version` is `30
  passing`, `0 failing` against local Wrangler D1/R2.
- Pinned complete local run after removing the memory backends: `445 passing`,
  `22 pending`, `6 environment-only failures`. The six require an HTTPS storage
  hostname, direct AWS S3 access, or direct DynamoDB access from the upstream
  harness; no application-level D1/R2 assertion failed.
