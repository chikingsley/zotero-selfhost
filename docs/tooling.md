# Tooling defaults

These are the repo-owned defaults for the compatible server work.

- Package manager: Bun.
- Runtime target: Cloudflare Workers.
- Durable Cloudflare CLI dependency: `wrangler` in `server/package.json`.
- App framework: Hono/OpenAPIHono.
- Validation/schema layer: Zod.
- Formatting/linting: Ultracite with Biome.
- Prefer committed package dependencies and `bun run` scripts over ad hoc global installs.
- Use `bunx` only for one-off project initialization or explicit user-requested tool bootstrapping.

Local coding does not require a Cloudflare MCP/plugin. Deployment automation can use Wrangler directly once the Cloudflare resources and bindings are created.
