# Candidate Server

This package contains the Cloudflare Worker implementation of the Zotero API v3
compatible server.

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

Current local state observed on 2026-07-09:

- `bun` and `bunx` are available.
- `wrangler` is a `devDependency` in this package and should be run through Bun
  scripts instead of relying on a global install.
- `server/.env` is the single ignored local env file. Bun loads it for package
  scripts, and Wrangler reads it for local dev variables and deploy auth.
  Non-interactive deploys work by setting `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN` there.
- `server/wrangler.jsonc` declares `secrets.required:
  ["SELFHOST_TEST_API_KEY"]` so the deploy token can live in the same file
  without becoming part of the local Worker `env` object or generated binding
  types. Real Zotero.org import keys should use a separate local variable such
  as `ZOTERO_IMPORT_API_KEY`.
- Runtime and binding types are generated with `wrangler types` into
  `worker-configuration.d.ts`; `bun run typecheck` regenerates that file before
  running TypeScript.
- Current checked tooling: TypeScript `7.0.2`, Wrangler `4.110.0`, Vitest
  `4.1.10`, Ultracite `7.9.3`.
- The repeatable real Zotero Desktop smoke is `bun run smoke:desktop`. It uses
  `/Applications/Zotero.app` with a temp profile, resets only `/test/setup`
  users on the configured endpoint, and verifies remote API state after sync.

## Source Layout

Current source ownership:

```text
server/
  src/
    index.ts                 # Worker/Hono app assembly
    bindings.ts              # Hono binding shape for Worker env values
    config.ts                # runtime config adapter
    domain/                  # Zotero/domain stores, validators, sync state
    lib/                     # low-level helpers such as diff/crypto helpers
    routes/
      health.ts
      compatibility/         # Zotero-compatible HTTP API route modules
        admin/               # test setup and TTS compatibility helpers
        auth/                # API key routes
        files/               # file upload/download/storage URL routes
        groups/              # group metadata and membership routes
        library/             # user/group library object routes
        support/             # shared compatibility route helpers
    types/                   # local declaration files for wasm modules
  migrations/
  tests/
  wrangler.jsonc
  package.json
  bun.lock
```

Project-local commands in `package.json`:

```json
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:memory": "bun scripts/serve.ts",
    "deploy": "bun run db:migrations:apply && wrangler deploy",
    "deploy:worker": "wrangler deploy",
    "deploy:dry-run": "wrangler deploy --dry-run",
    "db:migrations:apply": "wrangler d1 migrations apply DB --remote",
    "cf:types": "wrangler types",
    "cf:types:check": "wrangler types --check",
    "cf:whoami": "wrangler whoami",
    "smoke:desktop": "bun scripts/desktop-smoke.ts",
    "typecheck": "bun run cf:types && tsc --noEmit"
  },
  "devDependencies": {}
}
```

## Current Compatibility Target

The deployed Cloudflare D1/R2 path is the compatibility baseline. The latest
live official Zotero v3 run is `451 passing`, `22 pending`, `0 failing`; the
pending tests are upstream-skipped `schema` and `tts` cases.

`scripts/serve.ts` is intentionally not the production server. It runs the same
Hono app directly on Bun without D1/R2 bindings, which makes the domain stores
fall back to in-memory mode. Use it only for fast local compatibility harness
runs; use `wrangler dev` or the deployed Worker for Cloudflare-shaped behavior.

## Real Deployment Direction

Cloudflare's current Deploy to Cloudflare button flow can provision D1 and R2
from `wrangler.jsonc`, read `.env.example` for required secret prompts, and
pre-populate package scripts. This package is intentionally isolated under
`server/` so the root README can point the deploy button at that subdirectory:

<https://deploy.workers.cloudflare.com/?url=https://github.com/chikingsley/zotero-selfhost/tree/main/server>

Deployment notes:

- The source repo must be public for other users to deploy from the button.
- Keep `deploy` as migrations plus Worker deploy, and keep `deploy:worker` for
  the rare case where migrations should not run.
- Keep real secrets in Cloudflare secrets or ignored local `.env`; never put
  tokens in `wrangler.jsonc`.
- Keep private custom domains out of reusable template config. Add a custom
  domain to your own Worker after deployment.
- Keep one-owner auth for the first real release: generated admin password,
  generated initial API key, then explicit user-created API keys.
