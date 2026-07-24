import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const proxyTarget = process.env.VITE_API_PROXY_TARGET;

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
  },
});
