# MVP Test Map

Status: initial compatibility classification.

Official source:

```text
references/dataserver/tests/remote/tests/3
```

## Phase 0: First Harness Targets

These establish the shared protocol surface before data-model work.

| Test file | Status | Why |
| --- | --- | --- |
| `general.test.js` | target first | Basic API behavior, errors, headers, and request conventions. |
| `schema.test.js` | target first | Clients need schema/version metadata before writing objects. |
| `version.test.js` | target first | Zotero sync depends on library versions and precondition behavior. |

## Phase 1: Personal Library Metadata

These are the first real server implementation target after phase 0.

| Test file | Status | Why |
| --- | --- | --- |
| `item.test.js` | MVP | Core bibliography objects. |
| `collection.test.js` | MVP | Library organization. |
| `tag.test.js` | MVP | Filtering and sync-visible metadata. |
| `note.test.js` | MVP | Zotero notes are first-class user data. |
| `settings.test.js` | MVP | Required for client/library state. |
| `object.test.js` | MVP | Shared object write/read conventions. |

## Phase 2: Attachments

| Test file | Status | Why |
| --- | --- | --- |
| `file.test.js` | MVP subset | Stored-file attachment metadata, upload registration, and view/download flow. |

## Phase 3: Rich Client Behavior

| Test file | Status | Why |
| --- | --- | --- |
| `annotation.test.js` | later-MVP | Needed for PDF reader/annotation fidelity, but after base item/file flow. |
| `search.test.js` | later | Saved searches can follow core object support. |
| `relation.test.js` | later | Cross-object relationship behavior. |
| `sort.test.js` | later | Query fidelity after object storage is stable. |
| `params.test.js` | later | Query parameter edge cases. |
| `cache.test.js` | later | HTTP/cache behavior after base routes. |
| `bib.test.js` | later | Bibliography rendering/export support. |
| `export.test.js` | later | Export formats. |
| `creator.test.js` | later | May be pulled earlier if item tests require full creator normalization. |
| `mappings.test.js` | later | Schema/mapping route parity. |

## Phase 4: Auth And Multi-Actor Behavior

| Test file | Status | Why |
| --- | --- | --- |
| `keys.test.js` | later | Full API key management after one-token model. |
| `permissions.test.js` | later | Meaningful once groups/multiple users exist. |
| `loginSessions.test.js` | later | Web auth flow, not first server sync contract. |
| `group.test.js` | later | Required for full parity but not first personal-library sync. |
| `publications.test.js` | later | Separate publication library behavior. |

## Phase 5: Non-Core Services

| Test file | Status | Why |
| --- | --- | --- |
| `fulltext.test.js` | later | Needs indexing/storage decisions. |
| `translation.test.js` | later | External translation service behavior. |
| `tts.test.js` | later | Not needed for Zotero sync compatibility. |
| `storage-admin.test.js` | later | Admin/quota tooling after file flow exists. |
| `atom.test.js` | later | Legacy/feed format compatibility. |

## Accepted Temporary Gap

The candidate server will not claim full compatibility until all official v3 tests either pass or have a documented accepted difference. The first goal is phase 0 plus phase 1 enough to support one personal library.
