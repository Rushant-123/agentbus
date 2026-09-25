import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/sdk/test/**/*.test.ts", "packages/cli/test/**/*.test.ts", "packages/mcp/test/**/*.test.ts"] } });
