# Zotero Self-Host

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chikingsley/zotero-selfhost/tree/main/server)

Self-hostable Zotero API v3 compatible server for Cloudflare Workers, D1, and
R2. The deployable product lives in [`server/`](server/).

The method is not to guess Zotero behavior:

1. Use Zotero's official remote API tests as the acceptance oracle.
2. Build a smaller modern server with TypeScript, Bun, Hono, D1, and R2.
3. Test real clients against the deployed Worker.

## Status

The deployed Cloudflare D1/R2 path is green for the official Zotero v3 API tests
that run: `451 passing`, `22 pending`, `0 failing`. The pending cases are
upstream-skipped `schema` and `tts` tests, not current server failures. A real
Zotero Desktop smoke also passes against the live Worker.

See [compatibility/candidate-status.md](compatibility/candidate-status.md) for
the live scoreboard and
[compatibility/known-differences.md](compatibility/known-differences.md) for
deliberate deviations.

```bash
# install and run local Worker dev
cd server && bun install && bun run dev

# deploy Cloudflare Worker after applying D1 migrations
bun run deploy

# smoke the real Zotero Desktop app against the configured endpoint
bun run smoke:desktop
```

"Zotero" is a registered trademark of the Corporation for Digital
Scholarship; this project is an independent, compatible implementation and is
not affiliated with or endorsed by them.

## Self-Host Model

This is a single-owner deployment model: each deployer runs their own Worker,
D1 database, R2 bucket, root admin credentials, and API keys. There is no
central account system and no signup service controlled by this repo.

After deployment, clients need two values:

- The deployed API base URL, for example the generated `workers.dev` URL or the
  deployer's custom domain.
- A self-host API key created on that deployment, for example with root admin
  credentials:

```bash
curl -u "$ROOT_USERNAME:$ROOT_PASSWORD" \
  -X POST "$SELFHOST_URL/users/1/keys" \
  -H "content-type: application/json" \
  -d '{"name":"Desktop","access":{"user":{"library":true,"write":true,"files":true,"notes":true},"groups":{"all":{"library":true,"write":true}}}}'
```

Zotero.org API keys are separate import credentials. They can copy data from
Zotero.org into a self-hosted deployment, but they do not authenticate clients
to this server.

## License

MIT. This applies to this project's original server code and documentation, not
to Zotero's own source code or trademarks.

## Key Docs

- [Deployable server package](server/README.md)
- [Cloudflare production runbook](docs/cloudflare-production-runbook.md)
- [Compatibility status](compatibility/candidate-status.md)
- [Compatibility maintenance harness](compatibility/README.md)
- [Project-shape note](docs/zotero-selfhost-understanding.md)
- [Active TODO](TODO.md)

## Maintenance References

Third-party reference repositories are not committed. The tracked oracle lock
pins Zotero's exact `dataserver` commit and schema digest; `cd server && bun run
compat:setup` materializes the ignored checkout reproducibly. See
[compatibility/README.md](compatibility/README.md).
