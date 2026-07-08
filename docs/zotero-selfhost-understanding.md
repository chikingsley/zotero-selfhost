# Zotero Self-Host Understanding

Status: research snapshot from 2026-07-06.

This repo is currently an evidence bundle, not one coherent implementation. The useful outcome is to split the problem into two products:

1. A deployable "self-hosted Zotero companion" that works now by using Zotero.org for metadata and self-hosted storage for PDFs.
2. A future Zotero-compatible sync server that implements enough of the Zotero Web API and storage contract for patched or configurable clients.

Those are very different sizes of work.

## Source Inventory

Local sources inspected:

| Path | Upstream | Observed status | What it contributes |
| --- | --- | --- | --- |
| `references/dataserver/` | `https://github.com/zotero/dataserver` | Commit `9b64067`, 2026-07-03 | Current official PHP Zotero Data Server: API routes, schemas, write/version semantics, S3-backed storage, full-text, permissions. |
| `references/zotero-selfhost/` | `https://github.com/foxsen/zotero-selfhost` | Commit `09bf387`, 2021-08-26; submodules not initialized locally | Old full-stack Docker packaging around official client/server/web-library, with patches for MinIO/local endpoints. |
| `references/zotprime/` | `https://github.com/FiligranHQ/zotprime` | Commit `8f5e113`, 2021-04-23; submodules not initialized locally | Older ancestor-style full on-prem package: patched client plus Dockerized server stack. |
| `references/on-prem-zotero-webui/` | `https://github.com/joonsoome/on-prem-zotero-webui` | Commit `32736f3`, 2025-12-10 | Practical newer WebDAV PDF proxy plus Zotero Web Library overlay; not a full metadata sync server. |
| `references/sources.md` | local list | User-collected links | Useful external context: official docs, Docker image, WebDAV posts, forum/reddit discussion. |

External sources checked:

- Zotero sync docs: https://www.zotero.org/support/sync
- Zotero security docs: https://www.zotero.org/support/security
- Zotero Web API v3 basics: https://www.zotero.org/support/dev/web_api/v3/basics
- Zotero Web API syncing: https://www.zotero.org/support/dev/web_api/v3/syncing
- Zotero Web API write requests: https://www.zotero.org/support/dev/web_api/v3/write_requests
- Cloudflare Deploy to Workers buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/
- Cloudflare R2 S3 API: https://developers.cloudflare.com/r2/api/s3/api/
- MinIO / AIStor: https://www.min.io/ and https://github.com/minio/minio
- Garage object storage: https://garagehq.deuxfleurs.fr/
- SeaweedFS: https://github.com/seaweedfs/seaweedfs

## The Important Boundary

Official Zotero has two sync lanes:

- Data sync: metadata, notes, tags, collections, full-text metadata, library state.
- File sync: PDFs and other attachment files.

Zotero supports WebDAV only for personal-library file syncing. Zotero's security docs state that library data and group files sync only with Zotero servers, while personal-library files can use Zotero Storage, WebDAV, or linked files. The same page says the data server is open source and can be run locally, but local operation is technically challenging and unsupported by Zotero.

That means "self-host Zotero" can mean three different things:

| Goal | What it really means | Complexity |
| --- | --- | --- |
| Self-host PDFs | Keep Zotero.org metadata, use WebDAV or filesystem storage for attachments, expose a web UI/proxy. | Low/medium. |
| Self-host official dataserver | Run the PHP/MySQL/Redis/Memcached/Elasticsearch/S3-ish stack and patch clients/web-library to point at it. | High ops burden. |
| Build a compatible server | Reimplement Zotero API/storage/sync semantics on a modern stack such as Cloudflare Workers/D1/R2. | High engineering burden, but productizable. |

## What Each Existing Project Solves

### `zotero-selfhost`

This is the closest old attempt at "full on-prem Zotero." It packages:

- MySQL 5.7
- Elasticsearch 5.3
- Redis
- Memcached
- LocalStack for SNS/SQS-like behavior
- MinIO as S3-compatible object storage
- Apache/PHP dataserver
- stream-server
- tinymce-clean-server
- phpMyAdmin
- patched Zotero client/web-library expectations

Important local files:

- `references/zotero-selfhost/docker-compose.yml`
- `references/zotero-selfhost/Dockerfile`
- `references/zotero-selfhost/config/config.inc.php`
- `references/zotero-selfhost/src/patches/dataserver/*.patch`
- `references/zotero-selfhost/src/patches/web-library/*.patch`
- `references/zotero-selfhost/src/patches/zotero-client/*.patch`

The patches show the concrete problems the author hit:

- Rate limits were too low for web-library.
- AWS SDK needed path-style S3 endpoint settings for MinIO.
- Storage upload base URLs needed local HTTP/MinIO behavior.
- Client config had hardcoded Zotero URLs.

This is useful as a proof map, but it is not a clean modern template. It depends on old Ubuntu/PHP/MySQL/Elasticsearch assumptions and patched clients.

### `zotprime`

This is the earlier full on-prem package. It is useful mainly as lineage/context for `zotero-selfhost`. It has the same fundamental shape: Dockerized server stack plus patched client build.

### `on-prem-zotero-webui`

This is much narrower and more immediately shippable. It assumes:

- Zotero Desktop remains the real write path.
- Zotero.org remains the metadata API by default.
- Attachments are synced through WebDAV into Zotero's `<key>.zip` layout.
- A FastAPI proxy reads `<key>.zip`, extracts the first PDF, caches it under `<key>/`, and streams it to the browser.
- A vendored `zotero/web-library` subtree is overlaid to route PDF opening through the proxy.

Important local files:

- `references/on-prem-zotero-webui/app/main.py`
- `references/on-prem-zotero-webui/docker-compose.yml`
- `references/on-prem-zotero-webui/Dockerfile.pdf-proxy`
- `references/on-prem-zotero-webui/Dockerfile.web-library`
- `references/on-prem-zotero-webui/app/web-library-overlay/src/js/common/proxy.js`
- `references/on-prem-zotero-webui/app/web-library-overlay/src/js/actions/attachments.js`
- `references/on-prem-zotero-webui/app/web-library-overlay/src/js/reducers/config.js`
- `references/on-prem-zotero-webui/app/web-library-overlay/src/html/index.html`

This repo has the best shape for a public "deploy this companion" project. The gap is quality hardening: the tests cover proxy path/auth basics, but not end-to-end web-library overlay routing.

## Official Dataserver Contract

The official `dataserver` route map is in `references/dataserver/include/config/routes.inc.php`. It exposes:

- `/users/:userID/items`, `/groups/:groupID/items`
- item subsets: top, trash, collection scoped, tag scoped, children
- `/collections`, `/tags`, `/searches`, `/settings`, `/deleted`
- `/keys` and login sessions for API keys
- `/fulltext` endpoints
- attachment file endpoints: `/items/:key/file`, `/file/view`, `/file/view/url`
- global item and mapping endpoints: `/itemTypes`, `/itemFields`, `/items/new`, etc.

The API contract is not just CRUD. A compatible server must model:

- Monotonic library versions via `Last-Modified-Version`.
- Conditional sync reads via `If-Modified-Since-Version`.
- Conditional writes via `If-Unmodified-Since-Version`, with `428`, `412`, and retry behavior.
- Batch writes up to 50 objects with `successful`, `unchanged`, and `failed` response maps.
- Object schemas and validation for item types, fields, creators, notes, attachments, annotations, tags, collections, saved searches, settings, and deleted objects.
- Library permissions for personal libraries and groups.
- API keys/auth, and likely an OAuth/key-creation story if exposing third-party access.
- File storage metadata separate from object storage bytes.

The official file path is also two-phase:

1. Client asks `/items/:key/file` for upload authorization with hashes, filename, size, mtime, and precondition headers.
2. Server checks quota/existing files and returns S3-style upload parameters plus an `uploadKey`.
3. Client uploads bytes to S3-compatible storage.
4. Client calls back with `upload=<uploadKey>` or `update=<uploadKey>`.
5. Server verifies remote file metadata, updates `storageFiles`/`storageFileItems`, clears the queue, and returns `Last-Modified-Version`.

That maps to R2/S3-compatible storage, but the versioned relational model must be solid.

## Storage Backends

For a deployable implementation, treat object storage as an adapter:

| Backend | Fit |
| --- | --- |
| Cloudflare R2 | Best Cloudflare-native path; S3-compatible API and direct Worker integration. |
| MinIO / AIStor | Historically common in these repos. Current MinIO GitHub README says the old `minio/minio` repository is no longer maintained and points to AIStor Free/Enterprise. Still S3-compatible, but the branding/product shift should be handled carefully in docs. |
| Garage | Good self-hosted S3-compatible option for small/medium deployments. Better fit than old MinIO if the target is lightweight home/indie self-hosting. |
| SeaweedFS | S3-compatible distributed storage option, heavier and broader in scope. Useful for large local storage systems, not the first default. |
| WebDAV | Best compatibility with stock Zotero Desktop for personal-library attachments, but not enough for full metadata/group sync. |

## Cloudflare One-Click Feasibility

Cloudflare Deploy to Workers buttons are a real fit for a modern template. Cloudflare currently supports deploy buttons that clone a public GitHub/GitLab repo, configure the Worker, build/deploy it, and auto-provision resources declared in Wrangler config. Supported resource classes include D1, R2, KV, Durable Objects, Queues, Hyperdrive, Vectorize, and secrets.

A Cloudflare template can support:

- Worker API server in TypeScript.
- D1 for relational metadata and sync versions.
- R2 for file bytes.
- Queues for async cleanup/indexing.
- Durable Objects for per-library write serialization if D1 transactions alone are not enough.
- Static web-library build served by the Worker or a separate static asset binding.

But Cloudflare is not a good host for the unmodified PHP dataserver. The official stack expects Apache/PHP, MySQL, Redis, Memcached, Elasticsearch, S3, and background-ish operational behavior. Cloudflare is a rewrite target, not a lift-and-shift target.

## Recommended Product Paths

### Path A: Ship the companion first

Goal: "Self-host your Zotero PDFs and browse them on the web."

Base it on `on-prem-zotero-webui`, not the full dataserver. Deliverables:

- Clean Docker Compose.
- Cloudflare Tunnel/reverse-proxy recipe.
- Optional Cloudflare Worker version of the PDF proxy for R2/WebDAV-backed stores.
- Hardened auth.
- Automated tests proving web-library actions open `/pdf/:key`.
- Clear docs: metadata still comes from Zotero.org; files are self-hosted.

This is the fastest public project and could be useful even before a full compatible server exists.

### Path B: Preserve the legacy full-stack package

Goal: "Run the official dataserver locally if you accept old-stack complexity."

Base it on `references/dataserver/` plus lessons from `references/zotero-selfhost/`, but modernize cautiously:

- Replace unmaintained images where possible.
- Use MariaDB/MySQL compatibility testing.
- Replace old Elasticsearch assumptions only after confirming queries.
- Make MinIO/AIStor/Garage/R2 endpoints configurable.
- Avoid patched binary clients as the only story; document exactly what must be changed in client config.

This is useful for organizations, but it is hard to make friendly.

### Path C: Build a new compatible server

Goal: "A self-hostable Zotero-compatible API and file sync service."

Recommended stack for the reusable project:

- TypeScript Worker or Node service.
- D1/SQLite/Postgres data model depending on deployment target.
- R2/S3 storage adapter.
- Explicit Zotero API v3 compatibility test suite.
- Import path from Zotero local SQLite and/or Web API export.
- Web-library overlay that can point at either Zotero.org or this self-hosted API.

This is the bigger strategic project. It should start as a compatibility subset, not a claim of full Zotero replacement.

## Minimum Viable Compatibility Subset

A realistic first compatible server should implement:

- Single-user library only.
- API key auth.
- `/users/:id/items`, `/collections`, `/tags`, `/deleted`, `/settings`.
- Read formats needed by web-library: JSON plus item/schema endpoints.
- Batch create/update/delete for items and collections.
- Version headers and conditional writes.
- Stored-file attachments for PDFs.
- `/items/:key/file/view` and upload registration.
- Import from existing Zotero export or local SQLite snapshot.

Defer:

- Groups.
- Public libraries.
- OAuth.
- Full-text indexing.
- TTS endpoints.
- Advanced search parity.
- Legacy client sync behavior.
- Patched desktop client distribution.

## Immediate Engineering Backlog

1. Add a `PROJECT_SHAPE.md` or root README that says this repo is a research bundle and links to this document.
2. Add an inventory script that records repo commits, submodule status, and key source files.
3. For `on-prem-zotero-webui`, add browser-level tests that click attachment open actions and assert the target URL uses `PDF_PROXY_BASE_URL`.
4. Remove or gate `console.log('[proxy-debug] ...')` calls before public release.
5. Audit `tryGetAttachmentURL()` in the overlay: one branch says it uses the proxy but returns `dispatch(getAttachmentUrl(...))`, which likely still contacts the upstream metadata/storage URL. Verify whether that is intentional.
6. Create a `templates/cloudflare-companion/` proof of concept: Worker + R2 proxy + static config page + Deploy to Cloudflare button.
7. Create a `compatibility/` test corpus from official Web API examples: version headers, batch writes, attachments, deleted objects.
8. Decide whether full compatibility targets stock Zotero clients, web-library only, or your own apps first. That decision changes the required surface area dramatically.

## Working Recommendation

Build Path A first and document it honestly as a self-hosted companion, not a full Zotero replacement. In parallel, start Path C as a compatibility research track with explicit tests.

The Cloudflare one-click story belongs to Path A immediately and Path C later. A first Cloudflare template should be:

```text
templates/cloudflare-companion/
  src/worker.ts
  src/pdf-proxy.ts
  src/auth.ts
  public/
  wrangler.jsonc
  package.json
  README.md
```

It should bind one R2 bucket, optionally one D1 database for attachment metadata/cache entries, and include this README button:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/<repo>&subdir=templates/cloudflare-companion)
```

For the full compatible server, do not start by porting the PHP code. Start by writing compatibility tests against the official API behavior, then implement the subset needed by web-library and your own applications.
