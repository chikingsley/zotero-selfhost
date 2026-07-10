# Zotero Self-Host Server Package

This package contains the Cloudflare Worker, D1 migrations, R2 file storage, Zotero streaming Durable Object, runtime tests, and deployment/migration CLI.

## Resource Defaults

| Resource               | Default                       |
| ---------------------- | ----------------------------- |
| Worker                 | `zotero-selfhost`             |
| D1                     | `zotero-selfhost-db`          |
| R2                     | `zotero-selfhost-attachments` |
| Durable Object class   | `ZoteroStreamHub`             |
| Durable Object binding | `STREAM_HUB`                  |
| Health service         | `zotero-selfhost`             |

`wrangler.jsonc` is reusable production configuration and intentionally omits a personal D1 UUID. `wrangler.compatibility.jsonc` uses separate resource names and is the only configuration that enables destructive compatibility setup.

## Package Runners

The npm package has one executable, `zotero-selfhost`. Because it is the only binary, all common runners resolve the same command:

```bash
npx zotero-selfhost-server setup
bunx zotero-selfhost-server setup
pnpx zotero-selfhost-server setup
yarn dlx zotero-selfhost-server setup
```

Version `0.1.3` is public on npm and includes the current native account-linking, import, migration, recovery, and acceptance behavior. To run the source checkout directly:

```bash
bun run cli -- setup
bun run cli -- recover
bun run cli -- connect
```

### `setup`

The default command:

1. Verifies or opens Wrangler OAuth login.
2. Creates or reuses the named D1 database and R2 bucket.
3. Applies all D1 migrations.
4. Deploys the Worker and `ZoteroStreamHub` migration.
5. Uploads an automatically generated `FILE_URL_SIGNING_SECRET`.
6. Installs a temporary `BOOTSTRAP_TOKEN`.
7. Creates user 1 and the first owner API key.
8. Deletes the temporary token.
9. Saves only Worker name/URL under `~/.config/zotero-selfhost/deployment.json`; it does not save API keys.

Useful options:

```text
--url <https://...>       Explicit workers.dev or custom-domain URL
--worker <name>           Worker override
--database <name>         D1 override
--bucket <name>           R2 override
--location <hint>         D1/R2 location hint
--username <name>         Initial owner username
--display-name <name>     Initial owner display name
--key-label <label>       Initial/recovered owner key label
--profile <name>          Wrangler authentication profile
--existing                Skip provisioning/deploy and bootstrap an existing Worker
```

### `recover`

`recover` authenticates through Wrangler, uploads a random temporary `RECOVERY_TOKEN`, creates another owner key, and deletes the token. It does not delete users, library metadata, or R2 files.

## Credentials

- `FILE_URL_SIGNING_SECRET`: permanent Worker-only secret for short-lived file URLs. It can be rotated without deleting files.
- `BOOTSTRAP_TOKEN`: temporary and accepted only before installation state exists.
- `RECOVERY_TOKEN`: temporary and accepted only to create a replacement owner key on an initialized installation.
- API keys: per-client credentials stored by the self-hosted server.
- `ZOTERO_IMPORT_API_KEY`: one-time local Zotero.org source input, never a Worker secret or persisted credential.
- `SELFHOST_API_KEY`: local owner credential used by import, profile migration, and acceptance commands. Store it in a private environment file with mode `0600` or use `--api-key-file`; it is not stored by the CLI.

There is no production root username/password. Legacy password-style `/keys` creation is available only in explicit compatibility-test mode because the pinned upstream oracle exercises it.

## Import And Desktop Migration

### Native Desktop connection

For a new or unlinked profile, native account linking is the primary path:

```bash
npx zotero-selfhost-server connect --url https://your-worker.example.com
npx zotero-selfhost-server connect --url https://your-worker.example.com --execute
```

The command is dry-run-first and requires Zotero to be closed before `--execute`. It preserves existing `user.js` content, backs that file up when present, and installs only the custom API and streaming preferences. Reopen Zotero, choose Settings → Sync → Link Account, and enter the owner key on the self-hosted HTTPS login page. No Zotero.org account is required: the self-host owner key authorizes the installation once, and Zotero creates and stores a separate device key through its native session API. No Developer Tools or UI automation is involved.

### Existing personal-library migration

Migration is intentionally two-phase. First copy and verify the Zotero.org personal library while the existing Desktop profile still points to Zotero.org. Only then back up and switch that profile:

```bash
export ZOTERO_IMPORT_API_KEY='<dedicated Zotero.org read key>'
export SELFHOST_API_KEY='<self-host owner key>'

# Inventory only; no target writes
npx zotero-selfhost-server import --url https://your-worker.example.com

# Resumable metadata, settings, attachment, and full-text import
npx zotero-selfhost-server import --url https://your-worker.example.com --execute

# Discover the current profile and print the backup/cutover plan
npx zotero-selfhost-server profile --url https://your-worker.example.com

# With Zotero fully closed: back up, install API/key/stream settings, force a
# full merge sync, and verify the resulting profile
npx zotero-selfhost-server profile --url https://your-worker.example.com --execute
```

The importer preserves collection/item/search keys, rewrites personal-library Zotero URIs to the self-host user identity, includes trashed items, and checks attachment MD5s. It refuses a non-empty target unless `--merge` is explicit. State under `~/.config/zotero-selfhost/import-state.json` contains progress and hashes but no credentials, so interrupted attachment imports can resume.

Profile migration requires that verified state. It copies the full Firefox/Zotero profile plus `zotero.sqlite*` files, changes only the personal library's sync authority/history, preserves attachment files, and leaves local group libraries in place but skipped because group migration is not part of this personal-library slice. Restore is explicit and also keeps a pre-rollback safety copy:

```bash
npx zotero-selfhost-server profile --rollback '/path/to/backup'
npx zotero-selfhost-server profile --rollback '/path/to/backup' --execute
```

Finally, the macOS acceptance command creates two short-lived device keys and two disposable Zotero profiles. A uploads metadata and a file, B downloads and edits them, and A downloads B's change. It never invokes `/test/setup` and revokes the temporary keys afterward:

```bash
npx zotero-selfhost-server acceptance --url https://your-worker.example.com
npx zotero-selfhost-server acceptance --url https://your-worker.example.com --execute
```

## Streaming

Clients connect to `wss://<worker>/stream`, receive `connected`, and send the standard Zotero `createSubscriptions` message. The hibernating Durable Object stores subscriptions as WebSocket attachments. Existing mutation responses already contain Zotero notification metadata; middleware publishes those events only after a D1/R2 write has completed.

The Durable Object does not contain authoritative library data. A `topicUpdated` message tells a client to run the normal HTTP synchronization algorithm.

## Commands

```bash
# Production-shaped local Worker; /test/* returns 404
bun run dev

# Isolated destructive oracle/smoke environment
bun run dev:compatibility

# Production deployment
bun run deploy

# Explicit compatibility deployment using separate D1/R2 resources
bun run deploy:compatibility

# Full local gate
bun run check

# Worker-only compile/deployment validation
bun run deploy:dry-run
```

`bun run check` runs Ultracite/Biome, generated Wrangler binding types, TypeScript, the independent compatibility-runner typecheck, Workers Vitest, and an npm package dry-run.

### Recovery drill

Maintainers can restore a D1 SQL export into a newly created, empty disposable database without writing to production. The fallback restore uses parameterized D1 queries, so it does not depend on Cloudflare's temporary bulk-import upload host:

```sh
bun run restore:d1 <disposable-database-id> /path/to/database.sql
```

R2 backup and restore copies stay inside Cloudflare and verify every key and byte size. Single-part objects also retain and verify their content ETag; multipart ETags are transfer identifiers and are not expected to remain stable after a server-side copy:

```sh
bun run copy:r2 zotero-selfhost-attachments <backup-bucket>
bun run copy:r2 <backup-bucket> <disposable-restore-bucket>
```

After verification, the cleanup command deliberately refuses to empty any bucket whose name does not contain `-restore-drill-`:

```sh
bun run empty:r2-drill <disposable-restore-bucket>
bunx wrangler r2 bucket delete <disposable-restore-bucket>
bunx wrangler d1 delete <disposable-database-name> --skip-confirmation
```

## Runtime Safety Net

Workers Vitest applies every tracked D1 migration and supplies isolated D1, R2, Durable Object, and compatibility-only bindings. Coverage includes:

- health/OpenAPI and generated bindings;
- D1 version/precondition behavior;
- D1/R2 attachment upload/register/download;
- one-time bootstrap, duplicate-bootstrap rejection, owner-key administration, and recovery;
- Zotero streaming authentication and event delivery;
- bundled bsdiff/xdelta/vcdiff WASM execution.

The independently pinned Zotero oracle stays outside Vitest so it remains an unmodified black-box test suite.
