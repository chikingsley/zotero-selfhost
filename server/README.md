# Candidate Server

This folder is reserved for the new Zotero-compatible server implementation.

## Default Stack

Use the same Cloudflare Worker stack already used in related projects:

- TypeScript.
- Bun for package management and scripts.
- Hono / OpenAPIHono for route registration.
- Zod schemas for request/response validation.
- `/openapi.json` as a first-class generated or concrete contract.
- D1 for metadata, sync versions, auth records, and library state.
- R2 for attachment bytes and large artifacts.
- Wrangler for local dev and deploy.
- Vitest for unit/contract tests.
- Ultracite with Biome for lint/format.
- Static contract checks before live checks.
- Durable Objects only where per-library write serialization or realtime coordination is actually needed.
- Queues only where async indexing, cleanup, or import jobs need them.

## Local Tooling Truth

Current local state observed on 2026-07-06:

- Cloudflare MCP/plugin is not available in this Codex session.
- `wrangler` is not installed as a global `PATH` command.
- `bun` and `bunx` are available.
- `bunx wrangler whoami` works and is authenticated.
- `wrangler` is now a `devDependency` in this package and should be run through Bun scripts instead of relying on global installs or repeated ad hoc `bunx` downloads.
- If a one-off `bunx wrangler ...` call is used before the package exists, treat it as a bootstrap fallback only.

## Initial Shape

Do not scaffold the package before the first reference-stack test slice is understood.

Expected first modules:

```text
server/
  src/
    index.ts
    bindings.ts
    auth/
    http/
    routes/
    schemas/
    storage/
    sync/
  migrations/
  tests/
  wrangler.jsonc
  package.json
  bun.lock
```

After the package exists, initialize Ultracite/Biome inside `server/`:

```bash
bunx ultracite@latest init --linter biome
```

Then keep the project-local commands in `package.json`, for example:

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "cf:whoami": "wrangler whoami"
  },
  "devDependencies": {
    "wrangler": "^4.107.0"
  }
}
```

## First API Target

Start with the smallest useful Zotero-compatible surface:

- One user.
- One personal library.
- One API token.
- Items.
- Collections.
- Tags.
- Notes.
- Settings.
- Deleted objects.
- Version headers and conditional writes.
- Attachment metadata.
- R2-backed file storage.

## Not First

- Groups.
- Public libraries.
- OAuth.
- Full-text indexing.
- TTS.
- Translation.
- Publications.
- Advanced storage admin.
