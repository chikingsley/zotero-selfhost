# Zotero Self-Host Server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chikingsley/zotero-selfhost/tree/main/server)

A self-hostable Zotero API v3 compatible sync server built on Cloudflare
Workers, D1, R2, and Durable Objects. The deployable product is in
[`server/`](server/).

This is an independent implementation. “Zotero” is a registered trademark of
the Corporation for Digital Scholarship; this project is not affiliated with
or endorsed by Zotero.

## Current Status

- The last deployed compatibility baseline is `451 passing`, `22` upstream-
  pending, and `0 failing` against Zotero's pinned official v3 HTTP tests.
- A disposable Zotero Desktop profile has completed metadata and attachment
  synchronization against the deployed D1/R2 implementation.
- The current unreleased server adds final resource naming, one-time owner
  bootstrap, Cloudflare-account recovery, strict compatibility-test isolation,
  Zotero-protocol WebSocket notifications, a resumable Zotero.org personal-
  library importer, backed-up Desktop profile migration/rollback, and a
  two-profile Desktop acceptance harness.
- The current deployed custom-domain installation still uses the older
  `zotero` / `zotero-attachments` resources. It has not yet been migrated to
  this unreleased resource layout.

See [`compatibility/candidate-status.md`](compatibility/candidate-status.md) for
measured results and [`TODO.md`](TODO.md) for the remaining product work.

## Migrate An Existing Personal Library

The migration commands are dry-run by default. Use a dedicated Zotero.org API
key for the one-time source read and the self-host owner key for target writes:

```bash
export ZOTERO_IMPORT_API_KEY='<zotero.org key>'
export SELFHOST_API_KEY='<self-host owner key>'

npx zotero-selfhost-server import --url https://your-worker.example.com
npx zotero-selfhost-server import --url https://your-worker.example.com --execute

# Close Zotero before the execute step
npx zotero-selfhost-server profile --url https://your-worker.example.com
npx zotero-selfhost-server profile --url https://your-worker.example.com --execute
```

`npx`/`bunx`/`pnpx`/`yarn dlx` require the package to be published (or an
explicit local directory, tarball, or Git source). The Deploy to Cloudflare
button does not depend on npm. This package is not published yet, so from this
checkout use `cd server && bun run cli -- <command>`.

## Install

The package exposes one `zotero-selfhost` executable. Once
`zotero-selfhost-server` is published, any common package runner can invoke the
same CLI:

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

`setup` authenticates with Wrangler, creates or reuses the final D1/R2
resources, applies migrations, deploys the Worker and streaming Durable Object,
generates the file-URL signing secret, and returns the first owner API key. The
CLI does not save the API key.

For a Worker created with the Deploy to Cloudflare button:

```bash
npx zotero-selfhost-server setup --existing \
  --url https://your-worker.example.workers.dev
```

The source repository must be public before unrelated Cloudflare users can use
the deploy button.

## Recovery

Client API keys are replaceable credentials; they are not the recovery root.
If every owner key is lost, authenticate through the owning Cloudflare account:

```bash
npx zotero-selfhost-server recover
```

The CLI installs a temporary recovery secret, creates a replacement owner key,
and removes the secret. D1 and R2 are not reset. There is no permanent root
username or password.

## Storage And Sync

- D1 stores users, keys, library versions, metadata, deletions, full-text state,
  groups, collections, and attachment records.
- R2 stores attachment bytes.
- `ZoteroStreamHub` holds live WebSocket subscriptions only. A committed
  library mutation produces `topicUpdated`; clients then use their normal HTTP
  sync path to fetch data.
- A Zotero.org API key is an optional one-time importer input. It is not a
  credential for this server and is never a Worker secret.

Zotero Desktop can be pointed at a custom API server. The stock Zotero mobile
apps currently require an upstream change or a fork to use a custom API base;
a future application can use this server's HTTP and streaming protocols.

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

The production Worker returns `404` for `/test/*`. The compatibility
configuration uses separate Worker, D1, and R2 names and requires an explicit
test administrator token.

## Documentation

- [Server package and command reference](server/README.md)
- [Cloudflare production and migration runbook](docs/cloudflare-production-runbook.md)
- [Compatibility harness](compatibility/README.md)
- [Known differences](compatibility/known-differences.md)
- [Project shape](docs/zotero-selfhost-understanding.md)

## License

MIT for this project's original code and documentation. Third-party test
oracles and dependencies retain their own licenses.
