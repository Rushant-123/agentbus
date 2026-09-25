import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TESTNET: "true",
          MPP_SECRET_KEY: "test-secret-key-that-is-at-least-32-bytes-long!!",
          STRANGER_FREE_PER_DAY: "3",
          RATE_INSPACE_PER_MIN: "5",
          RATE_STRANGER_PER_MIN: "4",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
