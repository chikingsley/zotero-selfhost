# Zotero Self-Host Server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chikingsley/zotero-selfhost/tree/main/server)

A self-hostable Zotero API v3 compatible sync server built on Cloudflare Workers, D1, R2, and Durable Objects. The deployable product is in [`server/`](server/).

This is an independent implementation. “Zotero” is a registered trademark of the Corporation for Digital Scholarship; this project is not affiliated with or endorsed by Zotero.

## Current Status

The production server at the custom domain is running on the final Worker, D1, R2, and Durable Object resources. The personal Zotero library and attachments were imported, the real Desktop profile was migrated to that server, and ordinary Desktop synchronization is working. The legacy Cloudflare stack remains intact only as a server-side rollback target.

The latest isolated compatibility run completed with `451 passing`, `22` tests marked pending by the pinned upstream suite, and `0 application failures`. Disposable Zotero Desktop profiles have also completed metadata and attachment synchronization against the deployed D1/R2 implementation.

Version `0.1.3` is published on npm through GitHub Actions trusted publishing. Fresh-cache executions through both `npx` and `bunx` passed against the published artifact, and the corresponding GitHub Release is public and marked Latest.

See [`compatibility/candidate-status.md`](compatibility/candidate-status.md) for measured results and [`TODO.md`](TODO.md) for the remaining product work.

## What Each Desktop Command Does

`setup` and `setup --existing` operate on Cloudflare. They provision or finish configuring the Worker, D1 database, R2 bucket, Durable Object, server secrets, and first owner key. They do not open Zotero Desktop, edit a Zotero profile, or run JavaScript inside Zotero.

`connect` is the normal path for a new or unlinked Zotero profile. The person does not need a Zotero.org account. They need access to their own deployed self-host server and its owner key, which authorizes the Desktop once and is exchanged for a separate device key. With Zotero closed, `connect` writes only the custom API and streaming preferences into the selected profile's `user.js`, preserving and backing up any existing file. After Zotero reopens, the user chooses Settings → Sync → Link Account. Zotero creates a login session, opens this server's `/login` page, receives the device key, stores that key itself, and then uses Zotero's ordinary synchronization engine. The native `/login` route and `connect` command are implemented, tested, deployed, and passed a production native-login smoke test.

`import` is a one-time copy from Zotero.org into the self-hosted server. It does not delete or modify the Zotero.org library. The production import is complete.

`profile` is a special migration path for an already-populated Zotero.org Desktop profile. It creates a complete backup, switches that existing profile's sync identity and server preferences, and invokes Zotero's Run JavaScript facility to force and verify the identity transition. That JavaScript does not run during ordinary synchronization and is not used by `setup`, `setup --existing`, or the normal `connect` path.

The full live profile rollback and re-cutover drill is complete. The original backup restored the real profile to the `simonpeacocks` Zotero.org account with 414 items and 10 collections, a manual Zotero.org sync completed, and the profile then migrated back to the self-host identity `simon`. The final self-host sync completed with an empty local sync queue, and both the Desktop database and production API report 414 items and 10 collections. The drill exposed a changed Zotero 9 accessibility tree in the Run JavaScript editor; the migration runner now falls back to the editor's native paste and Command-R interaction while retaining the operation-result and full-sync verification that prevents a failed paste from being reported as success.

## Migrate An Existing Personal Library

The migration commands are dry-run by default. Use a dedicated Zotero.org API key for the one-time source read and the self-host owner key for target writes:

```bash
export ZOTERO_IMPORT_API_KEY='<zotero.org key>'
export SELFHOST_API_KEY='<self-host owner key>'

npx zotero-selfhost-server import --url https://your-worker.example.com
npx zotero-selfhost-server import --url https://your-worker.example.com \
  --recovery-manifest ~/.config/zotero-selfhost/recovery-files.json
npx zotero-selfhost-server import --url https://your-worker.example.com --execute

# Close Zotero before the execute step
npx zotero-selfhost-server profile --url https://your-worker.example.com
npx zotero-selfhost-server profile --url https://your-worker.example.com --execute
```

The `profile` command is the backed-up existing-profile migration path. For a new or unlinked Zotero profile, use native account linking instead: close Zotero, run `npx zotero-selfhost-server connect --url https://your-worker.example.com --execute`, reopen Zotero, and choose Settings → Sync → Link Account. Zotero then opens the self-hosted login page, receives its own device key, stores it, and uses its normal sync engine without Developer Tools or UI automation.

An optional version-1 recovery manifest maps unavailable attachment keys to reviewed local archive files. Relative paths resolve from the manifest:

```json
{
  "version": 1,
  "files": {
    "ABCD2345": "/path/to/recovered-book.pdf"
  }
}
```

The importer hashes these files during planning and again before upload. It does not modify Zotero.org or the local Zotero profile.

## Install

The package exposes one `zotero-selfhost` executable. Common package runners invoke the same published CLI:

```bash
npx zotero-selfhost-server setup
bunx zotero-selfhost-server setup
pnpx zotero-selfhost-server setup
yarn dlx zotero-selfhost-server setup
```

From a repository checkout today:

```bash
cd server
bun install
bun run cli -- setup
```

Before setup, create an R2 **Object Read & Write** API token scoped only to the `zotero-selfhost-attachments` bucket. Set `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in the environment (or use the CLI's corresponding `--*-file` options). These credentials stay in Worker secrets and are used only to sign short-lived, object-specific upload URLs.

`setup` authenticates with Wrangler, creates or reuses the final D1/R2 resources, applies migrations, deploys the Worker and streaming Durable Object, generates the file-URL signing secret, installs the R2 signing credentials, and returns the first owner API key. The CLI does not save the API key.

Save that owner key as `SELFHOST_API_KEY` in a private environment file with mode `0600`. With Zotero closed, configure native account linking:

```bash
npx zotero-selfhost-server connect --url https://your-worker.example.com
npx zotero-selfhost-server connect --url https://your-worker.example.com --execute
```

Then open Zotero and choose Settings → Sync → Link Account. Enter the owner API key on your own Worker's HTTPS login page. Zotero receives a separate device key; the owner key is not stored in the Zotero profile.

For a Worker created with the Deploy to Cloudflare button:

```bash
npx zotero-selfhost-server setup --existing \
  --url https://your-worker.example.workers.dev
```

The source repository is public and the deploy button points at the `server/` deployment directory. A complete fresh-account button deployment is still an explicit release test rather than a claimed completed result.

## Recovery

Client API keys are replaceable credentials; they are not the recovery root. If every owner key is lost, authenticate through the owning Cloudflare account:

```bash
npx zotero-selfhost-server recover
```

The CLI installs a temporary recovery secret, creates a replacement owner key, and removes the secret. D1 and R2 are not reset. There is no permanent root username or password.

## Storage And Sync

- D1 stores users, keys, library versions, metadata, deletions, full-text state, groups, collections, and attachment records.
- R2 stores attachment bytes.
- The self-host installation owner has unlimited logical Zotero storage quota; actual capacity and billing are governed by that installation's Cloudflare R2 account.
- Direct-capable clients upload files below 64 MiB with one presigned R2 PUT and larger files with presigned multipart PUTs. Both use the same attachment authorization and registration records. Stock Zotero retains its compatible form-POST transport because R2 does not support presigned HTML form POST.
- `ZoteroStreamHub` holds live WebSocket subscriptions only. A committed library mutation produces `topicUpdated`; clients then use their normal HTTP sync path to fetch data.
- A Zotero.org API key is an optional one-time importer input. It is not a credential for this server and is never a Worker secret.

Zotero Desktop can be pointed at a custom API server. The stock Zotero mobile apps currently hard-code Zotero's API base, so this project is building toward a first-party iPhone and iPad application that uses the server's HTTP and streaming protocols directly. The intended mobile scope includes self-hosted synchronization, offline PDF and EPUB reading, annotations, and Calibre-like metadata enrichment without making a maintained Zotero mobile fork a product dependency.

## Development And Compatibility

```bash
cd server

# Production-shaped local Worker: destructive test administration is absent
bun run dev

# Isolated compatibility Worker/resources for the official oracle and smoke
bun run dev:compatibility

# Format/lint, generated binding types, TypeScript, workerd tests, package test
bun run check

# Materialize and run the independently pinned upstream test oracle
bun run compat:setup
bun run test:oracle:smoke
```

The production Worker returns `404` for `/test/*`. The compatibility configuration uses separate Worker, D1, and R2 names and requires an explicit test administrator token.

## Documentation

- [Server package and command reference](server/README.md)
- [Cloudflare production and migration runbook](docs/cloudflare-production-runbook.md)
- [Compatibility harness](compatibility/README.md)
- [Known differences](compatibility/known-differences.md)
- [Project shape](docs/zotero-selfhost-understanding.md)

## License

MIT for this project's original code and documentation. Third-party test oracles and dependencies retain their own licenses.
