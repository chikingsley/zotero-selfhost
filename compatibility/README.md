# Compatibility Plan

This folder tracks how we turn Zotero's official API behavior into a buildable compatible server.

## Source Of Truth

Primary oracle:

- `../references/dataserver/tests/remote`

Important files:

- `../references/dataserver/tests/remote/run_tests`
- `../references/dataserver/tests/remote/config/default.json`
- `../references/dataserver/tests/remote/setup.js`
- `../references/dataserver/tests/remote/api3.js`
- `../references/dataserver/tests/remote/tests/3`

The remote tests are HTTP-level tests. That makes them reusable: first against official `dataserver`, later against our candidate server.

## Test Phases

| Phase | Test areas | Purpose |
| --- | --- | --- |
| 0 | `general`, `schema`, `version` | Prove API base behavior, schema exposure, and sync version mechanics. |
| 1 | `item`, `collection`, `tag`, `settings`, `note` | Core personal-library metadata sync. |
| 2 | `file` | Stored attachments, upload registration, file view/download behavior. |
| 3 | `annotation`, `search`, `relation`, `sort`, `params`, `cache` | Rich library behavior needed by serious clients. |
| 4 | `keys`, `permissions`, `loginSessions` | Auth and access model. |
| 5 | `group`, `publications`, `fulltext`, `translation`, `tts`, `storage-admin` | Full parity or later server editions. |

## MVP Target

The first candidate server should target phases 0, 1, and the useful subset of phase 2.

That means:

- One user.
- One personal library.
- One API token.
- Items, collections, tags, notes, settings, deleted state.
- Version headers and conditional writes.
- Attachment metadata and object storage.

## Harness Strategy

Do not edit Zotero's official tests in place.

Preferred approach:

1. Run official tests against official `dataserver`.
2. Record required config and passing/failing status here.
3. Create a thin runner/config adapter for our candidate server.
4. Copy or wrap individual tests only when a test depends on official-only setup endpoints.

## Status Files To Add

Future files:

- `reference-stack-status.md`: what passes against official local dataserver.
- `candidate-status.md`: what passes against our server.
- `known-differences.md`: explicit accepted deviations.

## Runner

Use `run-zotero-tests.ts` to run Zotero's official remote tests with runtime config supplied from this folder.

Examples:

```bash
bun compatibility/run-zotero-tests.ts --target reference -- -v 3 general
bun compatibility/run-zotero-tests.ts --target candidate -- -v 3 general
```

Config files:

- `compatibility/config/reference.local.json`
- `compatibility/config/candidate.local.json`

Create them from the corresponding `.example.json` files. Local config files are ignored because they can contain test credentials or local endpoints.
