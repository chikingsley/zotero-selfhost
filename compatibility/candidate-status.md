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

Not yet scored (later phases): `keys`, `permissions`, `loginSessions`,
`group`, `publications`, `fulltext`, `translation`, `tts`, `storage-admin`,
`atom`, `bib`, `export`, `sort`, `params`, `cache`, `relation`, `mappings`,
`creator`, `schema` (schema self-skips upstream).

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
