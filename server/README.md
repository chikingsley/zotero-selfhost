# Zotero Self-Host Server Package

This package contains the Cloudflare Worker, D1 migrations, R2 file storage,
Zotero streaming Durable Object, runtime tests, and deployment/recovery CLI.

## Resource Defaults

| Resource | Default |
| --- | --- |
| Worker | `zotero-selfhost` |
| D1 | `zotero-selfhost-db` |
| R2 | `zotero-selfhost-attachments` |
| Durable Object class | `ZoteroStreamHub` |
| Durable Object binding | `STREAM_HUB` |
| Health service | `zotero-selfhost` |

`wrangler.jsonc` is reusable production configuration and intentionally omits a
personal D1 UUID. `wrangler.compatibility.jsonc` uses separate resource names
and is the only configuration that enables destructive compatibility setup.

## Package Runners

The npm package has one executable, `zotero-selfhost`. Because it is the only
binary, all common runners resolve the same command:

```bash
npx zotero-selfhost-server setup
bunx zotero-selfhost-server setup
pnpx zotero-selfhost-server setup
yarn dlx zotero-selfhost-server setup
```

The package is not published yet. From this checkout use:

```bash
bun run cli -- setup
bun run cli -- recover
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
9. Saves only Worker name/URL under
   `~/.config/zotero-selfhost/deployment.json`; it does not save API keys.

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

`recover` authenticates through Wrangler, uploads a random temporary
`RECOVERY_TOKEN`, creates another owner key, and deletes the token. It does not
delete users, library metadata, or R2 files.

## Credentials

- `FILE_URL_SIGNING_SECRET`: permanent Worker-only secret for short-lived file
  URLs. It can be rotated without deleting files.
- `BOOTSTRAP_TOKEN`: temporary and accepted only before installation state
  exists.
- `RECOVERY_TOKEN`: temporary and accepted only to create a replacement owner
  key on an initialized installation.
- API keys: per-client credentials stored by the self-hosted server.
- `ZOTERO_IMPORT_API_KEY`: future one-time local importer input, never a Worker
  secret.

There is no production root username/password. Legacy password-style `/keys`
creation is available only in explicit compatibility-test mode because the
pinned upstream oracle exercises it.

## Streaming

Clients connect to `wss://<worker>/stream`, receive `connected`, and send the
standard Zotero `createSubscriptions` message. The hibernating Durable Object
stores subscriptions as WebSocket attachments. Existing mutation responses
already contain Zotero notification metadata; middleware publishes those
events only after a D1/R2 write has completed.

The Durable Object does not contain authoritative library data. A
`topicUpdated` message tells a client to run the normal HTTP synchronization
algorithm.

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

`bun run check` runs Ultracite/Biome, generated Wrangler binding types,
TypeScript, the independent compatibility-runner typecheck, Workers Vitest, and
an npm package dry-run.

## Runtime Safety Net

Workers Vitest applies every tracked D1 migration and supplies isolated D1, R2,
Durable Object, and compatibility-only bindings. Coverage includes:

- health/OpenAPI and generated bindings;
- D1 version/precondition behavior;
- D1/R2 attachment upload/register/download;
- one-time bootstrap, duplicate-bootstrap rejection, owner-key administration,
  and recovery;
- Zotero streaming authentication and event delivery;
- bundled bsdiff/xdelta/vcdiff WASM execution.

The independently pinned Zotero oracle stays outside Vitest so it remains an
unmodified black-box test suite.
