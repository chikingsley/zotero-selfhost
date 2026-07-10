import { fileURLToPath, URL } from "node:url";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          BOOTSTRAP_TOKEN: "runtime-bootstrap-token",
          COMPATIBILITY_TEST_ADMIN_TOKEN: "runtime-test-admin-token",
          COMPATIBILITY_TEST_API_KEY: "testkey1",
          DEPLOYMENT_MODE: "compatibility-test",
          FILE_URL_SIGNING_SECRET: "runtime-file-url-signing-secret",
          RECOVERY_TOKEN: "runtime-recovery-token",
          TEST_MIGRATIONS: await readD1Migrations(
            fileURLToPath(new URL("./migrations", import.meta.url))
          ),
        },
      },
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    })),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
