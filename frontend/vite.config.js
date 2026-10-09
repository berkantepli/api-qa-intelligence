import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The repository's VERSION file is the single source of the app version.
const appVersion = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  // Unit tests live next to the code; browser tests in e2e/ run with Playwright.
  test: { include: ["src/**/*.test.js"] },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8001",
    },
  },
});
