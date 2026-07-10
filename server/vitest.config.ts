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
          R2_ACCESS_KEY_ID: "runtime-r2-access-key-id",
          R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          R2_BUCKET_NAME: "zotero-selfhost-attachments",
          R2_SECRET_ACCESS_KEY: "runtime-r2-secret-access-key",
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
