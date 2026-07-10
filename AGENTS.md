# Zotero Self-Host Agent Guide

## Purpose

This repository is an independent Zotero API v3 compatible synchronization server for Cloudflare Workers. D1 stores library and account state, R2 stores attachment bytes, and `ZoteroStreamHub` provides authenticated change notifications through a Durable Object.

Keep the product boundary clear: this is the deployable server, its Node-compatible setup and migration CLI, and its compatibility and release safety nets. It is not Zotero's upstream dataserver and it is not an official Zotero project.

## Sources Of Truth

- `README.md` is concise human onboarding and must not become a deployment diary.
- `TODO.md` contains open work only.
- `CHANGELOG.md` contains completed work and release history.
- `compatibility/verification-history.md` contains dated evidence from specific commits and deployments. Never describe those measurements as current unless they were rerun for the current revision.
- `docs/cloudflare-production-runbook.md` owns detailed deployment, migration, backup, recovery, and cutover procedures.
- `docs/cli.md` owns complete CLI and operator details.

Write readable Markdown paragraphs without fixed-column hard wrapping. Use tables only when they make ownership, commands, or safety distinctions easier to scan.

## Repository Shape

- `src/`: deployed Worker, routes, domain behavior, D1/R2 storage, streaming, and the documented `bsdiff-wasm` Worker adaptation under `src/vendor`.
- `migrations/`: the real D1 schema applied in production and runtime tests.
- `cli/src/commands/`: user-facing CLI command implementations.
- `cli/src/internal/`: private CLI implementation.
- `cli/tests/`: Node-compatible CLI tests.
- `cli/build/`: npm bundling internals. Generated `dist/` output must not remain in the worktree.
- `tests/*.test.ts`: this project's Cloudflare Workers-runtime tests.
- `tests/live/`: explicit live deployment and real-client probes; these are not ordinary unit tests.
- `compatibility/`: this project's harness around an independently pinned Zotero oracle.
- `compatibility/vendor/dataserver/`: ignored upstream Zotero checkout. Do not edit or commit it.
- `.agents/skills/deploy-zotero-selfhost/`: portable agent-assisted installation procedure, not repository implementation policy.

## Test Boundaries

Do not merge the test layers.

1. Workers-runtime tests are authored here and run inside `workerd` through `@cloudflare/vitest-pool-workers`. They use isolated D1, R2, Durable Object, WebSocket, and WASM behavior.
2. CLI tests are authored here and run under Node to preserve the published package contract.
3. The compatibility harness is authored here, but the assertions under `compatibility/vendor/dataserver/tests/remote` belong to Zotero upstream. Keep the checkout pinned and unmodified.
4. Live tests touch actual Cloudflare resources or Zotero Desktop and must remain explicit rather than joining the default local gate.

The production Worker must return `404` for `/test/*`. Destructive compatibility administration may exist only when `DEPLOYMENT_MODE` is `compatibility-test` and only against isolated resources.

## Development Commands

- Install exactly: `bun install --frozen-lockfile`
- Full local gate: `bun run check`
- Workers-runtime tests: `bun run test:runtime`
- CLI tests: `bun run test:cli`
- Package verification: `bun run test:package`
- Deployment build without deployment: `bun run deploy:dry-run`
- Materialize the pinned Zotero checkout: `bun run compat:setup`
- Focused upstream smoke: `bun run test:oracle:smoke`
- Complete upstream suite: `bun run test:oracle`
- Inspect whether the upstream pin moved: `bun run compat:check-upstream`

Run `bun run check` before handing off any code change. Run `bun run deploy:dry-run` for Worker/configuration changes. Run the relevant upstream oracle slice when changing public Zotero protocol behavior. Never claim a live or full-oracle result from code shape alone.

## Implementation Rules

- Use generated Wrangler binding types and preserve the binding names in `wrangler.jsonc`.
- Use D1, R2, and Durable Object bindings inside the Worker rather than Cloudflare REST calls.
- Do not add in-memory production fallbacks that bypass the real storage behavior.
- Stream or sign large attachment transfers; do not buffer unbounded files in Worker memory.
- Await every Promise or deliberately attach it to the Workers execution context.
- Keep request state out of mutable module globals.
- Preserve Zotero protocol headers, version preconditions, write-token behavior, and batch-report shapes.
- Add focused Workers-runtime coverage for behavior changes and independent oracle coverage when the external contract changes.
- Do not weaken the documented `bsdiff-wasm` patch or remove it unless its Worker runtime tests pass with an upstream replacement.

## Security And Data Safety

- Never commit, print, or copy actual Cloudflare tokens, R2 credentials, owner/device keys, Zotero.org keys, private attachment URLs, or library content into documentation, fixtures, issues, or logs.
- Use `.env` or explicit private key files locally and Wrangler secrets in deployed Workers.
- Treat `import`, `profile`, recovery, D1 restore, R2 copy, compatibility setup, and live smoke operations according to their documented safety boundaries. Keep dry-run defaults intact.
- Never point the upstream compatibility suite or destructive test routes at production resources.
- Do not rotate, revoke, delete, migrate, or deploy external resources unless the user explicitly authorizes that operation.

## Change Hygiene

- Preserve unrelated user changes in a dirty worktree.
- Keep public names consistent with `zotero-selfhost`, `zotero-selfhost-db`, and `zotero-selfhost-attachments` unless a reviewed migration changes them.
- Update `CHANGELOG.md` for completed user-visible work and `TODO.md` only for genuinely open work.
- When moving files, update scripts, documentation, tests, package contents, and ignored paths in the same change.
- Report local, CI, published, deployed, and live-verified states literally; none implies another.

## Agent-Assisted Deployment

When the task is to install, connect, import, or recover an end-user deployment rather than modify this repository, load `.agents/skills/deploy-zotero-selfhost/SKILL.md` and follow its dry-run and secret-handling rules.
