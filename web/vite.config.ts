import react from "@vitejs/plugin-react";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const proxyTarget = process.env.VITE_API_PROXY_TARGET;
const coverageRoot = join(
  process.env.RUNNER_TEMP ?? tmpdir(),
  "archon-coverage",
  "frontend"
);

export default defineConfig({
  plugins: [react()],
  server: proxyTarget
    ? {
        proxy: {
          "/api": {
            target: proxyTarget,
            changeOrigin: true,
          },
        },
      }
    : undefined,
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: coverageRoot,
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
