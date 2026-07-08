# Candidate Server — Official Test Status

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

## Later-phase slices (scored 2026-07-08, not yet driven to green)

| Slice | Score | | Slice | Score |
| --- | --- | --- | --- | --- |
| mappings | 11/11 ✅ | | keys | 6/9 |
| creator | 6/6 ✅ | | permissions | 6/9 |
| cache | 1/1 ✅ | | loginSessions | 16/19 |
| storage-admin | 2/2 ✅ | | relation | 10/13 |
| notifications | 8/11 | | sort | 6/8 |
| fulltext | 11/15 | | params | 6/8 |
| atom | 4/5 | | translation | 2/3 |
| group | 2/7 | | bib | 0/11 |
| publications | 10/32 | | export | 0/3 |

Largest later-phase gaps: `bib`/`export` (real CSL citation rendering vs the
current deterministic shims), `publications`, and `group` admin flows.
`schema` self-skips upstream.

## How to reproduce

```bash
# 1. boot the candidate (in-memory mode)
cd server && bun scripts/serve.ts &

# 2. run a slice (config: compatibility/config/candidate.local.json)
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 version

# subset of a slice via mocha grep
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 -g "trash" item
```

The harness needs `references/dataserver/tests/remote` cloned and
`npm install`ed, plus the current Zotero schema at
`references/dataserver/htdocs/zotero-schema/schema.json`
(`curl -sL https://api.zotero.org/schema -o …/schema.json`).
