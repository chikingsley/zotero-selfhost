# Zotero Self-Host Server

[![CI](https://github.com/chikingsley/zotero-selfhost/actions/workflows/ci.yml/badge.svg)](https://github.com/chikingsley/zotero-selfhost/actions/workflows/ci.yml)
[![Compatibility oracle](https://github.com/chikingsley/zotero-selfhost/actions/workflows/compatibility.yml/badge.svg)](https://github.com/chikingsley/zotero-selfhost/actions/workflows/compatibility.yml)
[![npm](https://img.shields.io/npm/v/zotero-selfhost-server)](https://www.npmjs.com/package/zotero-selfhost-server)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chikingsley/zotero-selfhost)

## What It Is

Zotero Self-Host Server is an independent, self-hostable implementation of the Zotero API v3 synchronization protocol. It runs on Cloudflare Workers and uses D1 for library metadata, R2 for attachment bytes, and a Durable Object for live change notifications.

The server is designed for people who want Zotero Desktop synchronization and attachment storage under their own Cloudflare account. It can start with a new Desktop profile or copy an existing personal library from Zotero.org without deleting or modifying the source library.

“Zotero” is a registered trademark of the Corporation for Digital Scholarship. This project is not affiliated with or endorsed by Zotero.

## Maturity And Known Limitations

Version `0.1.3` is published on npm. The core personal-library API, Desktop synchronization, attachment transfer, import, owner recovery, and Cloudflare deployment path are implemented and have passed Workers-runtime, upstream Zotero protocol, and real-client verification.

The project is still pre-1.0. A fresh-account Deploy to Cloudflare acceptance run and a passive two-client notification/file round trip remain explicit release checks. Stock Zotero mobile applications do not support selecting an arbitrary API server, so mobile access requires a future compatible client rather than this server alone.

Open release work is recorded in [`TODO.md`](TODO.md). Completed changes are recorded in [`CHANGELOG.md`](CHANGELOG.md). Dated compatibility evidence is recorded in [`compatibility/verification-history.md`](compatibility/verification-history.md); it is evidence from specific revisions and deployments, not a promise that every historical count describes the current commit.

## Quick Start

You need a Cloudflare account, Node.js 20 or newer or Bun, and an R2 Object Read & Write token scoped to the attachment bucket. Put credentials in a private environment file or pass them through the CLI's `--*-file` options; do not commit them.

```bash
export CLOUDFLARE_ACCOUNT_ID='<account id>'
export R2_ACCESS_KEY_ID='<bucket-scoped R2 access key>'
export R2_SECRET_ACCESS_KEY='<bucket-scoped R2 secret>'

npx zotero-selfhost-server setup
```

The setup command authenticates with Cloudflare through Wrangler, creates or reuses the D1 database and R2 bucket, applies migrations, deploys the Worker and Durable Object, installs Worker secrets, and returns the first owner API key. The CLI does not save that key; store it in a password manager and in a private `SELFHOST_API_KEY` environment variable when another command needs it.

If the Deploy to Cloudflare button created the resources first, finish initialization with:

```bash
npx zotero-selfhost-server setup --existing \
  --url https://your-worker.example.workers.dev
```

## Connect Zotero Desktop

For a new or currently unlinked profile, close Zotero and run the connection command once as a dry run, then execute it:

```bash
npx zotero-selfhost-server connect --url https://your-worker.example.com
npx zotero-selfhost-server connect --url https://your-worker.example.com --execute
```

Reopen Zotero and choose **Settings → Sync → Link Account**. Zotero opens the login page on your own Worker. Enter the owner API key there; the server creates a separate device key that Zotero stores and uses for ordinary synchronization.

The connection command backs up and updates the selected profile's `user.js`. It does not run JavaScript inside Zotero and does not copy an existing Zotero.org library.

## Migrate An Existing Library

Create a dedicated Zotero.org API key with read access to the personal library. The import command copies metadata, settings, available attachments, and full-text state into the self-hosted server. It does not delete or modify Zotero.org.

```bash
export ZOTERO_IMPORT_API_KEY='<one-time Zotero.org key>'
export SELFHOST_API_KEY='<self-host owner key>'

# Inventory and plan only
npx zotero-selfhost-server import --url https://your-worker.example.com

# Perform the resumable import
npx zotero-selfhost-server import --url https://your-worker.example.com --execute
```

If the existing Desktop profile is already populated and linked to Zotero.org, complete the server import first. Then close Zotero, inspect the backed-up profile cutover plan, and execute it:

```bash
npx zotero-selfhost-server profile --url https://your-worker.example.com
npx zotero-selfhost-server profile --url https://your-worker.example.com --execute
```

The profile command is a specialized migration path. It creates a complete backup before changing the existing profile's server identity, and it supports restoring that backup with `profile --rollback <backup-path> --execute`.

## Commands

| Command | Purpose |
| --- | --- |
| `setup` | Provision and deploy a new Cloudflare installation, then create the first owner key. |
| `setup --existing` | Finish secrets and owner initialization after Deploy to Cloudflare provisioned the resources. |
| `connect` | Configure a new or unlinked Zotero Desktop profile for the self-hosted server. |
| `import` | Plan or execute a resumable, non-destructive copy from Zotero.org. |
| `profile` | Back up and migrate an already-populated Desktop profile after the server import. |
| `profile --rollback` | Restore a backup created by the profile migration command. |
| `recover` | Use Cloudflare account authentication to create a replacement owner key without resetting D1 or R2. |
| `acceptance` | Run an A → B → A synchronization check with disposable Desktop profiles. |
| `admin restore-d1` | Restore and verify a D1 SQL backup. Available from the current repository source and planned for the next package release. |
| `admin copy-r2` | Copy and verify every object between two R2 buckets. Available from the current repository source and planned for the next package release. |
| `admin empty-r2-drill` | Empty only an explicitly named restore-drill bucket. Available from the current repository source and planned for the next package release. |

All migration commands are dry-run-first. Add `--execute` only after reviewing their plan. Run the current source checkout with `bun run cli -- <command>`; use `npx`, `bunx`, `pnpx`, or `yarn dlx` for published releases.

## How Storage And Synchronization Work

- D1 stores users, API keys, library versions, metadata, deletions, settings, groups, collections, full-text state, and attachment records.
- R2 stores attachment bytes. The installation's actual storage capacity and billing are governed by its Cloudflare account.
- Small direct-capable uploads use one signed R2 PUT. Larger direct-capable uploads use signed multipart PUTs. Stock Zotero retains its compatible form-POST upload transport.
- `ZoteroStreamHub` holds authenticated WebSocket subscriptions. A committed mutation emits `topicUpdated`; clients then use the normal HTTP synchronization protocol to retrieve changes.
- A Zotero.org API key is an optional, one-time importer credential. It is never a Worker secret and is not required for a new self-hosted library.

## Testing Model

The test layers deliberately remain separate because they catch different failures.

| Layer | Ownership | What it proves | Normal trigger |
| --- | --- | --- | --- |
| `tests/*.test.ts` | This project | The Worker runs inside Cloudflare's `workerd` runtime with isolated D1, R2, Durable Object, WebSocket, and WASM behavior. | Every `bun run check` and CI push. |
| `cli/tests` | This project | The Node-compatible CLI plans, imports, migrates, packages, and refuses unsafe recovery operations correctly. | Every `bun run check` and CI push. |
| `compatibility/*.ts` and `*.mjs` | This project | The pinned upstream checkout is authentic and the external test runner can target the isolated candidate safely. | Weekly smoke and manual oracle runs. |
| `compatibility/vendor/dataserver/tests/remote` | Zotero upstream | The server's public HTTP behavior matches Zotero's own independent assertions. | A 30-test weekly smoke; the complete suite is manual before compatibility milestones. |
| `tests/live` | This project | Real Cloudflare resources and real Zotero Desktop behavior work end to end. | Explicit manual release verification. |

The production Worker returns `404` for `/test/*`. Destructive setup helpers exist only in the separately configured compatibility-test Worker and its isolated data resources.

From a source checkout:

```bash
bun install --frozen-lockfile

# Formatting, linting, generated bindings, TypeScript, Workers runtime,
# CLI tests, and npm package verification
bun run check

# Download the exact pinned Zotero oracle and run its focused smoke
bun run compat:setup
bun run test:oracle:smoke

# Run the complete pinned upstream suite against an isolated candidate
bun run test:oracle

# Confirm the Worker still packages for deployment without deploying it
bun run deploy:dry-run
```

See [`compatibility/README.md`](compatibility/README.md) for ownership, safety, and command details.

## Recovery And Security

Client and owner API keys are replaceable credentials; they are not the recovery root. If every owner key is lost, `recover` authenticates through the owning Cloudflare account, installs a temporary recovery secret, creates a replacement owner key, and removes the temporary secret. It does not reset library data.

Keep Cloudflare, R2, owner, device, and Zotero.org credentials out of source control and command output. Use Worker secrets for deployed credentials and private environment or key files for local commands. Production must never enable compatibility-test bindings or expose destructive `/test/*` routes.

The complete backup, restore, import, and cutover procedure is in [`docs/cloudflare-production-runbook.md`](docs/cloudflare-production-runbook.md).

## Documentation And Support

- [`docs/cli.md`](docs/cli.md) — complete CLI and operator reference.
- [`docs/cloudflare-production-runbook.md`](docs/cloudflare-production-runbook.md) — deployment, import, recovery, backup, restore, and custom-domain operations.
- [`compatibility/README.md`](compatibility/README.md) — test ownership, the pinned Zotero oracle, and safe reproduction commands.
- [`compatibility/known-differences.md`](compatibility/known-differences.md) — upstream-pending cases and deliberate scope decisions.
- [`compatibility/verification-history.md`](compatibility/verification-history.md) — dated measured results from specific revisions and deployments.
- [`TODO.md`](TODO.md) — open work only.
- [`CHANGELOG.md`](CHANGELOG.md) — completed work and release history.

Coding agents should read [`AGENTS.md`](AGENTS.md). Agents helping someone deploy and connect an installation can use the portable [`deploy-zotero-selfhost` skill](.agents/skills/deploy-zotero-selfhost/SKILL.md).

Use [GitHub Issues](https://github.com/chikingsley/zotero-selfhost/issues) for reproducible defects and support requests. Do not include API keys, Cloudflare tokens, private library content, or attachment URLs in an issue.

## License

MIT for this project's original code and documentation. Third-party dependencies and the ignored upstream Zotero test checkout retain their own licenses.
