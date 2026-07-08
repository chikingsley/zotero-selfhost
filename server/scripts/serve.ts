// Local Bun HTTP server for the candidate Worker app.
//
// Serves the same Hono app used in production, but natively on Bun with no
// `DB`/`ATTACHMENTS` bindings, which puts the compatibility store into its
// in-memory mode (see storage.ts `createCompatibilityStore`). This is the fast
// path for pointing Zotero's official remote test harness at the candidate
// without standing up workerd + D1 + R2.
import app from "../src/index";

const env = {
  ROOT_PASSWORD: process.env.ROOT_PASSWORD ?? "local-root-password",
  ROOT_USERNAME: process.env.ROOT_USERNAME ?? "root",
  RAW_FILE_URL_SECRET: process.env.RAW_FILE_URL_SECRET ?? "local-dev-secret",
};

const executionCtx = {
  waitUntil: (_promise: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const port = Number(process.env.PORT ?? 8787);

Bun.serve({
  fetch: (req) => app.fetch(req, env, executionCtx),
  idleTimeout: 120,
  port,
});

// biome-ignore lint/suspicious/noConsole: dev server startup notice
console.log(`candidate server (memory mode) on http://127.0.0.1:${port}`);
