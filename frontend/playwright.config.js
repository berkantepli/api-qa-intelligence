// End-to-end tests: the built app on its backend with a throwaway database, plus a small target
// API with deliberate problems (e2e/target_api.py). Run with `npm run test:e2e` after `npm run build`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const python = process.env.E2E_PYTHON ?? (existsSync("../.venv/bin/python") ? "../.venv/bin/python" : "python");
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "api-qa-e2e-"));

// Two ports the system reports free right now, so test runs on one machine (for example from parallel
// work sessions) do not start servers on each other's ports. The config is loaded again in each worker,
// so the ports go into the environment once and every load reads the same ones; E2E_APP_PORT and
// E2E_TARGET_PORT also pin them by hand.
function freePorts(count) {
  const script = `const net = require("net");
const servers = Array.from({ length: ${count} }, () => net.createServer());
Promise.all(servers.map((server) => new Promise((done) => server.listen(0, "127.0.0.1", done))))
  .then(() => { console.log(servers.map((server) => server.address().port).join(" ")); servers.forEach((server) => server.close()); });`;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim().split(" ");
}
if (!process.env.E2E_APP_PORT || !process.env.E2E_TARGET_PORT) {
  [process.env.E2E_APP_PORT, process.env.E2E_TARGET_PORT] = freePorts(2);
}
const appPort = process.env.E2E_APP_PORT;
const targetPort = process.env.E2E_TARGET_PORT;
export const APP_URL = `http://127.0.0.1:${appPort}`;
export const TARGET_URL = `http://127.0.0.1:${targetPort}`;

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
      command: `${python} -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port ${appPort}`,
      url: `${APP_URL}/health`,
      env: { API_QA_DATA_DIR: dataDir },
      reuseExistingServer: false,
    },
    {
      command: `${python} -m uvicorn target_api:app --app-dir e2e --host 127.0.0.1 --port ${targetPort}`,
      url: `${TARGET_URL}/openapi.json`,
      reuseExistingServer: false,
    },
  ],
});
