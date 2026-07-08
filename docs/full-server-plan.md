# Full Zotero-Compatible Server Plan

Status: working plan from 2026-07-06.

## Decision

Run Zotero's official `dataserver` first.

That reference stack is not necessarily the final product. It is the fastest way to see the real behavior of Zotero's API, storage flow, versioning, and tests. Then we build our own compatible server against that behavior.

## Clarification: No Account Needed Yet

We do not need your Zotero account, API token, or Mac app login for the first phase.

Those become useful later when we test against the public Zotero API or real desktop/web clients. The first phase uses the official server source and its own test setup.

Observed local state on 2026-07-06:

- Zotero Desktop is installed.
- Zotero local profiles exist.
- Zotero sync preferences exist.
- No Zotero password needs to be read or handled by Codex.
- Public Zotero API comparison can use an API key later if needed.

## Clarification: Zotero Is Not Blocking Us

"Unsupported" means Zotero does not package or support self-hosted dataserver deployments for normal users. It does not mean they technically block local use of the open-source server.

The practical issues are:

- The official server expects multiple infrastructure services.
- The client and web-library have assumptions about official Zotero endpoints.
- File upload URLs and S3-compatible storage need careful config.
- Old self-host repos solved parts of this with patches.
- We need a repeatable modern setup and a compatibility map.

## Phase 1: Reference Stack

Goal: run official `references/dataserver` locally and prove selected official tests can talk to it.

Work:

- Identify required services: MySQL/MariaDB, Redis, Memcached, Elasticsearch, S3-compatible storage, and any test-only setup paths.
- Create a local runbook for booting and resetting the reference stack.
- Use `references/dataserver/tests/remote` as the first HTTP behavior oracle.
- Start with a tiny test subset, not the whole suite.

Success:

- A local URL serves the official API.
- `test/setup` can reset users/libraries and generate test API keys.
- A small v3 test slice runs against the reference stack.

## Phase 2: Compatibility Map

Goal: convert Zotero's test suite into a build plan.

Work:

- Classify each `references/dataserver/tests/remote/tests/3/*.test.js` file as MVP, later, or skip.
- Record required endpoints, headers, response bodies, and persistence behavior.
- Identify which tests require groups, full-text, TTS, translation, publications, or other non-MVP services.

Success:

- We know the smallest server that can support real useful sync.
- We know what to defer without lying about compatibility.

## Phase 3: Candidate Server

Goal: build a small compatible server that passes the MVP compatibility slice.

Initial scope:

- Cloudflare Worker on the usual Bun + Hono/OpenAPIHono + Zod + D1 + R2 + Wrangler + Vitest + Ultracite/Biome stack.
- Wrangler should be a project-local Bun dev dependency in `server/`, with `bun run deploy`/`bun run dev` scripts, rather than a global binary assumption.
- Single user.
- Single personal library.
- One API token model.
- Items, collections, tags, notes, settings, deleted objects.
- Version headers and conditional writes.
- Attachment metadata and file storage.
- R2/S3-compatible object storage adapter.

Deferred:

- Groups.
- Public libraries.
- OAuth.
- Full-text indexing.
- TTS.
- Translation.
- Publications.
- Advanced admin/storage endpoints.

## Phase 4: Real Clients

Goal: connect actual clients after the API behavior is known.

Targets:

- Zotero Web Library first, because it is easier to configure and observe.
- Zotero Desktop second, because it may require endpoint/config changes.
- Your other applications in parallel once the server API is stable.

## Cadence

- `TODO.md`: active queue only.
- `docs/`: durable explanations, runbooks, decisions, and findings.
- `compatibility/`: test phases, status, harness notes, and API contract notes.
- `references/`: source inventory and notes about upstream repos/docs.
- `CHANGELOG.md`: completed user-facing or repo-facing changes.

Use this flow:

```text
TODO item -> implementation/research -> docs or compatibility update -> changelog entry
```

## What To Ask The User For Later

Not needed now:

- Zotero account credentials.
- Zotero API token.
- Mac app login.

Needed later:

- A throwaway Zotero account for public API comparison.
- A sample library with items, PDFs, tags, notes, and annotations.
- Permission to test the Mac app against a local endpoint.
