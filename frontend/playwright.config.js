// End-to-end tests: the built app on its backend with a throwaway database, plus a small target
// API with deliberate problems (e2e/target_api.py). Run with `npm run test:e2e` after `npm run build`.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const python = process.env.E2E_PYTHON ?? (existsSync("../.venv/bin/python") ? "../.venv/bin/python" : "python");
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "api-qa-e2e-"));
export const APP_URL = "http://127.0.0.1:8021";
export const TARGET_URL = "http://127.0.0.1:8022";

export default defineConfig({
  testDir: "e2e",
  // The tests share one backend database, so they run one after another.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // Locally the installed Chrome is used, so no browser download is needed.
    ...(process.env.CI ? {} : { channel: "chrome" }),
  },
  webServer: [
    {
      command: `${python} -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port 8021`,
      url: `${APP_URL}/health`,
      env: { API_QA_DATA_DIR: dataDir },
      reuseExistingServer: false,
    },
    {
      command: `${python} -m uvicorn target_api:app --app-dir e2e --host 127.0.0.1 --port 8022`,
      url: `${TARGET_URL}/openapi.json`,
      reuseExistingServer: false,
    },
  ],
});
