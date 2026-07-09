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
          RAW_FILE_URL_SECRET: "runtime-test-raw-file-secret",
          ROOT_PASSWORD: "local-root-password",
          ROOT_USERNAME: "root",
          SELFHOST_TEST_API_KEY: "testkey1",
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
    setupFiles: ["./tests/apply-migrations.ts"],
  },
});
