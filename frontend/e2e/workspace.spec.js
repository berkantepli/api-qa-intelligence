// The main flows of the app against e2e/target_api.py. Each test starts from an empty workspace and a
// reset target API and sets up what it needs, so a test can run alone, in any order, or be retried.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { python, TARGET_URL } from "../playwright.config.js";

// All tests share one backend database, which each test empties first (see playwright.config.js: one worker).
test.beforeEach(async ({ request }) => {
  expect((await request.delete("/api/v1/workspace")).status()).toBe(204);
  expect((await request.post(`${TARGET_URL}/__reset`)).status()).toBe(204);
  expect((await request.post("/demo/__reset")).status()).toBe(204);
});

const endpoint = (page, method, path) => page.locator(".endpoint-row").filter({ has: page.locator(".method-tag", { hasText: method }) }).filter({ has: page.getByText(path, { exact: true }) });
const nav = (page, label) => page.locator(".sidebar .nav-link").filter({ hasText: label }).click();
const check = (page, title) => page.locator(".scenario-card").filter({ has: page.getByText(title, { exact: true }) });

// The app saves to the backend in the background; a test that reloads or opens a new page waits for it.
const saved = (page, kind) => page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes(`/api/v1/workspace/${kind}/`));

async function runAll(page) {
  await page.getByRole("button", { name: "Select all" }).click();
  const run = saved(page, "runs");
  await page.getByRole("button", { name: /Run selected/ }).click();
  await expect(page.getByRole("button", { name: "View run details" })).toBeVisible();
  await run;
}

// The target URL, time limit, and credentials live in the Target & auth panel under the topbar.
async function openTarget(page) {
  await page.getByRole("button", { name: /Target & auth/ }).click();
  await expect(page.locator(".connection-panel")).toBeVisible();
}

// The risk score, criticality, trends, and imported results are shown in the advanced view.
async function showAdvanced(page) {
  await page.getByLabel("Advanced view").check();
}

// Imports the target API's contract the way a user does, and waits until it is saved.
async function importPets(page) {
  await page.goto("/");
  await page.getByPlaceholder("https://api.example.com/openapi.json").fill(`${TARGET_URL}/openapi.json`);
  const api = saved(page, "apis");
  await page.getByRole("button", { name: "Import API" }).click();
  expect((await api).status()).toBe(204);
  await expect(page.getByRole("heading", { name: "E2E Pets" })).toBeVisible();
}

// Types the path id of GET /pets/{id} (7, a pet the target knows) and waits until it is saved.
async function enterPetId(page, value = "7") {
  await endpoint(page, "GET", "/pets/{id}").click();
  const inputs = saved(page, "inputs");
  await page.getByPlaceholder("Enter id").fill(value);
  await inputs;
}

// Runs every check of one endpoint from the overview.
async function runEndpoint(page, method, path) {
  await endpoint(page, method, path).click();
  await runAll(page);
}

async function importFile(page, name, document) {
  await page.goto("/");
  await nav(page, "API specs");
  await page.getByRole("button", { name: "Import API" }).first().click();
  await page.getByRole("tab", { name: "Upload file" }).click();
  await page.locator(".import-card input[type=file]").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) });
  const api = saved(page, "apis");
  await page.locator(".import-card").getByRole("button", { name: /Import API/ }).click();
  await api;
  await expect(page.locator(".overview-heading")).toBeVisible();
}

test("imports a contract from a URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start with an API contract" })).toBeVisible();
  await expect(page.locator(".demo-offer")).toContainText("Try the built-in demo API");
  await page.getByPlaceholder("https://api.example.com/openapi.json").fill(`${TARGET_URL}/openapi.json`);
  await page.getByRole("button", { name: "Import API" }).click();

  await expect(page.getByRole("heading", { name: "E2E Pets" })).toBeVisible();
  await expect(page.locator(".endpoint-row")).toHaveCount(4);
  await expect(page.locator(".target-summary")).toContainText(TARGET_URL);
  await openTarget(page);
  await expect(page.locator(".target-field input").first()).toHaveValue(TARGET_URL);
});

test("scores how testable the contract is and opens an endpoint from a finding", async ({ page }) => {
  await importPets(page);
  const card = page.locator(".stat-card").filter({ hasText: "Contract quality" });
  await expect(card).toContainText("/ 100");
  await card.click();

  const panel = page.locator(".quality-panel");
  await expect(panel.locator(".quality-fixes")).toContainText("Add examples for required inputs");
  const finding = panel.locator(".quality-findings details").filter({ hasText: "/pets/{id}" });
  await finding.locator("summary").click();
  await expect(finding).toContainText("No example, default, or enum for id (path).");
  await finding.getByRole("button", { name: "Open endpoint" }).click();

  await expect(panel).toHaveCount(0);
  await expect(page.locator(".scenario-header h2")).toHaveText("GET /pets/{id}");
});

test("passes a correct endpoint and checks its body", async ({ page }) => {
  await importPets(page);
  await endpoint(page, "GET", "/pets").click();
  await runAll(page);

  const valid = check(page, "Valid request");
  await expect(valid.locator(".result-box")).toContainText("PASS");
  await expect(valid).toContainText("Body matches the documented schema.");
  await expect(endpoint(page, "GET", "/pets").locator(".endpoint-status-passing")).toBeVisible();
});

test("compares a check's response with its last pass", async ({ page }) => {
  await importPets(page);
  await endpoint(page, "GET", "/pets").click();
  await runAll(page);
  const valid = check(page, "Valid request");
  await expect(valid.locator(".result-box")).toContainText("PASS");
  await expect(valid.locator(".response-changes-none")).toHaveCount(0);

  // The checks are still selected; run them again.
  const again = saved(page, "runs");
  await page.getByRole("button", { name: /Run selected/ }).click();
  await again;
  await expect(valid.locator(".response-changes-none")).toContainText("Same response structure as the last pass");
});

test("explains a body that breaks the contract", async ({ page }) => {
  await importPets(page);
  await endpoint(page, "GET", "/pets/{id}").click();
  await expect(page.getByText("Complete required request details first")).toBeVisible();
  const idField = page.locator(".request-input").filter({ has: page.getByPlaceholder("Enter id") });
  await expect(idField).toHaveClass(/request-input-missing/);
  await expect(idField).toContainText("Required to run the checks.");
  await page.getByPlaceholder("Enter id").fill("7");
  await expect(idField).not.toHaveClass(/request-input-missing/);
  await runAll(page);

  const valid = check(page, "Valid request");
  await expect(valid.locator(".result-box")).toContainText("FAIL");
  await expect(valid).toContainText("$.name: required property is missing");
});

test("flags an endpoint that does not ask for its documented key", async ({ page }) => {
  await importPets(page);
  await endpoint(page, "GET", "/orders").click();
  await runAll(page);

  await expect(check(page, "Call without authentication")).toContainText("Expected HTTP 401, received HTTP 200.");
  await expect(endpoint(page, "GET", "/orders").locator(".endpoint-status-failing")).toBeVisible();
});

test("tells the backend which parameters are credentials, so it masks them", async ({ page }) => {
  const bodies = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/v1/runs/execute")) bodies.push(request.postDataJSON()); });
  await importPets(page);
  await endpoint(page, "GET", "/orders").click();
  await runAll(page);

  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) expect(body.secret_names).toEqual(["X-Key"]);
});

test("does not run checks without a usable target", async ({ page }) => {
  await importPets(page);
  await endpoint(page, "GET", "/pets").click();
  await page.getByRole("button", { name: "Select all" }).click();
  await openTarget(page);
  const target = page.locator(".target-field input").first();
  const run = page.getByRole("button", { name: /Run selected/ });

  await target.fill("");
  await expect(page.locator(".connection-status")).toContainText("No target URL");
  await expect(page.locator(".run-footer")).toContainText("Enter a Target API base URL to run checks.");
  await expect(run).toBeDisabled();

  await target.fill("not a url");
  await expect(page.locator(".connection-status")).toContainText("Invalid target URL");
  await expect(run).toBeDisabled();

  await target.fill(TARGET_URL);
  await expect(page.locator(".connection-status")).toContainText("API reachable");
  await expect(run).toBeEnabled();

  const limit = page.locator(".time-limit-field input");
  await limit.fill("0");
  await expect(page.getByText("Enter a whole number from 1 to 120000 ms.")).toBeVisible();
  await limit.blur();
  await expect(limit).toHaveValue("");
});

test("keeps the workspace after the browser is cleared", async ({ page }) => {
  await importPets(page);
  await runEndpoint(page, "GET", "/pets");
  await enterPetId(page);
  await runAll(page);
  await runEndpoint(page, "GET", "/orders");

  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.getByRole("heading", { name: "API specs" })).toBeVisible();
  const card = page.locator(".spec-card").filter({ hasText: "E2E Pets" });
  await expect(card).toContainText("3 of 4 endpoints tested");
  await expect(card).toContainText("2 failing");
  // The saved path parameter came back from the database too.
  await card.locator(".spec-card-open").click();
  await endpoint(page, "GET", "/pets/{id}").click();
  await expect(page.getByPlaceholder("Enter id")).toHaveValue("7");
});

test("explains a contract without endpoints and a collection without requests", async ({ page }) => {
  await importPets(page);
  await page.locator(".overview-heading input[type=file]").setInputFiles({ name: "empty.postman_collection.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ info: { name: "Empty", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [] })) });
  await expect(page.locator(".request-import-panel .alert")).toHaveText("The file has no API requests, so there is nothing to compare. Choose a collection that contains requests.");

  await nav(page, "API specs");
  await page.getByRole("button", { name: "Import API" }).first().click();
  await page.getByRole("tab", { name: "Upload file" }).click();
  await page.locator(".import-card input[type=file]").setInputFiles({ name: "empty-api.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ openapi: "3.0.3", info: { title: "Empty API", version: "1" }, paths: {} })) });
  await page.locator(".import-card").getByRole("button", { name: /Import API/ }).click();

  await expect(page.locator(".import-notice.error-alert")).toContainText("its contract documents no endpoints");
  await expect(page.locator(".overview-page .history-empty")).toContainText("This contract documents no endpoints");
  await expect(page.locator(".stat-card").filter({ hasText: "Runnable checks" })).toContainText("nothing to run yet");
  await expect(page.locator(".stat-card").filter({ hasText: "Contract quality" })).toContainText("document the API's endpoints under paths");
  await nav(page, "Coverage");
  await expect(page.locator(".coverage-empty")).toHaveText("This contract documents no endpoints, so there is nothing to cover yet.");
});

test("compares a Postman collection with the contract and reuses its values", async ({ page }) => {
  const collection = {
    info: { name: "E2E Postman", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "baseUrl", value: TARGET_URL }],
    item: [
      { name: "Find pet", request: { method: "GET", header: [{ key: "Authorization", value: "Bearer abcdefghijklmnop" }], url: "{{baseUrl}}/pets/9" } },
      { name: "Create pet", request: { method: "POST", url: "{{baseUrl}}/pets", body: { mode: "raw", raw: JSON.stringify({ name: "Bella", password: "x" }) } } },
      { name: "Health", request: { method: "GET", url: "{{baseUrl}}/health" } },
    ],
  };
  await importPets(page);
  await enterPetId(page);
  await page.locator(".overview-heading input[type=file]").setInputFiles({ name: "pets.postman_collection.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(collection)) });

  const panel = page.locator(".request-import-panel");
  await expect(panel).toContainText("Postman collection · 3 requests · 1 credential-like value left out");
  await expect(panel.locator(".stat-card").filter({ hasText: "Endpoints it calls" })).toContainText("2 / 4");
  await expect(panel.locator(".stat-card").filter({ hasText: "Not in the contract" })).toContainText("1");
  await expect(panel.locator("details").filter({ hasText: "Endpoints the file never calls" })).toContainText("/orders");

  // The id typed earlier (7) is kept; only the empty body field is filled.
  await panel.getByRole("button", { name: "Fill request details" }).click();
  await expect(panel.locator(".success-alert")).toContainText("Filled 1 value on 1 endpoint");
  await panel.getByRole("checkbox", { name: "Replace values I already entered" }).check();
  await panel.getByRole("button", { name: "Fill request details" }).click();
  await expect(panel.locator(".success-alert")).toContainText("Filled 1 value on 1 endpoint");

  await panel.locator("details").filter({ hasText: "Endpoints it calls" }).locator("summary").click();
  await panel.locator(".request-import-list li").filter({ hasText: "/pets/{id}" }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByPlaceholder("Enter id")).toHaveValue("9");
  await page.getByPlaceholder("Enter id").fill("7");
});

test("opens a run again with the same checks selected", async ({ page }) => {
  await importPets(page);
  await runEndpoint(page, "GET", "/orders");
  await nav(page, "Run history");
  await page.locator(".history-group-toggle").first().click();
  await page.locator(".history-run").filter({ hasText: "GET /orders" }).click();
  await expect(page.getByRole("heading", { name: "GET /orders" })).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();

  await expect(page.locator(".scenario-header h2")).toHaveText("GET /orders");
  await expect(page.locator(".scenario-card.checked")).toHaveCount(2);
});

test("runs data-changing checks in bulk only after confirmation", async ({ page }) => {
  await importPets(page);
  await nav(page, "Coverage");
  await page.locator(".coverage-run-button").click();
  const panel = page.locator(".bulk-run");
  await expect(panel.locator(".bulk-group-ready")).not.toContainText("Changes data");
  await panel.getByRole("checkbox", { name: /Include data-changing endpoints/ }).check();
  await expect(panel.locator(".bulk-group-ready")).toContainText("Changes data");

  await panel.getByRole("button", { name: /^Run \d+ checks/ }).click();
  await expect(panel.locator(".execution-confirmation")).toContainText("data-changing endpoint");
  await panel.getByRole("button", { name: "Confirm and run" }).click();

  await expect(panel).toContainText("Bulk run finished");
  await expect(page.locator(".coverage-row").filter({ hasText: "/pets" }).filter({ has: page.locator(".method-post") })).not.toContainText("Not tested");
});

test("scores each endpoint's risk and explains the score", async ({ page }) => {
  await importPets(page);
  await nav(page, "Coverage");
  // The simple view names the risks without a score.
  await expect(page.locator(".coverage-row .risk-score")).toHaveCount(0);
  await expect(page.locator(".coverage-row").filter({ has: page.locator(".method-post") }).first()).toContainText("Never tested");
  await expect(page.locator(".coverage-row").filter({ has: page.locator(".method-post") }).first()).not.toContainText("Changes data");
  await showAdvanced(page);

  const rows = page.locator(".coverage-row");
  await expect(rows.first().locator(".risk-score")).toBeVisible();
  const scores = await rows.locator(".risk-score").evaluateAll((items) => items.map((item) => Number.parseInt(item.textContent, 10)));
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  await expect(rows.filter({ has: page.locator(".method-post") }).first()).toContainText("+15 Changes data");

  await page.getByText("How the risk score works").click();
  await expect(page.locator(".risk-rules table")).toContainText("Failing in latest run");
});

test("lists the coverage gaps of an endpoint", async ({ page }) => {
  await importPets(page);
  await enterPetId(page);
  // Only the valid request runs; the wrong-type check for id, which expects 404, does not.
  await check(page, "Valid request").locator(".scenario-select").click();
  const run = saved(page, "runs");
  await page.getByRole("button", { name: /Run selected/ }).click();
  await run;
  await nav(page, "Coverage");

  const item = page.locator(".history-runs > li").filter({ has: page.locator(".coverage-row", { hasText: "/pets/{id}" }) });
  await item.locator(".coverage-gaps summary").click();
  await expect(item.locator(".coverage-gap-list")).toContainText("An invalid-value check for path parameter id has not run yet");
  await expect(item.locator(".coverage-gap-list")).toContainText("HTTP 404 is expected by a check but has never been received");
  await expect(item.locator(".coverage-gap-codes")).toContainText("200Received");
});

test("runs a flow that passes the created id to the next request", async ({ page }) => {
  await importPets(page);
  await nav(page, "Flows");
  const flow = page.locator(".flow-card").filter({ has: page.getByRole("heading", { name: "Pet lifecycle" }) });
  await expect(flow.locator(".flow-step")).toHaveCount(2);

  await flow.getByRole("button", { name: "Run flow" }).click();
  await expect(flow.locator(".execution-confirmation")).toContainText("This flow changes data.");
  await flow.getByRole("button", { name: "Confirm and run" }).click();

  // The created pet's id reaches GET /pets/{id}, whose body breaks the contract.
  await expect(flow.locator(".flow-step").nth(0)).toContainText("id = 2");
  await expect(flow.locator(".flow-step").nth(1)).toContainText("$.name: required property is missing");
  await expect(flow.locator(".flow-card-pills .history-status")).toHaveText("FAIL");

  await flow.getByRole("button", { name: "View run details" }).click();
  await expect(page.getByRole("heading", { name: "Flow: Pet lifecycle" })).toBeVisible();
  await expect(page.locator(".run-check").nth(1)).toContainText("GET http://127.0.0.1");
  await expect(page.locator(".run-check").nth(1)).toContainText("/pets/2");

  // Each step counts as a run of the endpoint it called.
  await nav(page, "Coverage");
  const row = (method, path) => page.locator(".coverage-row").filter({ has: page.locator(`.method-${method}`) }).filter({ has: page.getByText(path, { exact: true }) });
  await expect(row("post", "/pets").locator(".coverage-status")).toHaveText("Passingvia flow");
  await expect(row("get", "/pets/{id}").locator(".coverage-status")).toHaveText("Failingvia flow");

  // Trends count every check and flow step of the day, with a tooltip and a table view.
  await showAdvanced(page);
  const trends = page.locator(".trends-panel");
  const passRate = trends.locator(".trend-card").filter({ hasText: "Pass rate" });
  await expect(trends.locator(".trend-card").first()).toContainText("Endpoints tested");
  await expect(passRate.locator("strong")).toHaveText(/^\d+%$/);
  await trends.getByRole("combobox", { name: "Endpoint" }).selectOption("GET /pets/{id}");
  await trends.getByText("Show as table").click();
  await expect(trends.locator(".trends-table tbody tr")).toHaveCount(1);
  const chart = trends.locator(".trend-chart svg").first();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width - 16, box.y + 40);
  await expect(trends.locator(".trend-tooltip").first()).toContainText("checks");
  // With one endpoint picked, the API-wide coverage chart steps aside.
  await expect(trends.locator(".trend-card").filter({ hasText: "Endpoints tested" })).toHaveCount(0);
});

test("edits a flow to clean up after itself, and shows untested lifecycles on Coverage", async ({ page }) => {
  await importPets(page);
  await nav(page, "Flows");
  const flow = page.locator(".flow-card").filter({ has: page.getByRole("heading", { name: "Pet lifecycle" }) });
  await flow.getByRole("button", { name: "Edit" }).click();

  const addStep = async ({ title, method, path, codes, cleanup = false }) => {
    await flow.getByRole("button", { name: "+ Add step" }).click();
    const step = flow.locator(".flow-edit-step").last();
    await step.getByPlaceholder("Step name, such as Create a pet").fill(title);
    await step.getByRole("combobox").first().selectOption(method);
    await step.getByPlaceholder("/pets/{{petId}}").fill(path);
    await step.getByPlaceholder("200, 201").fill(codes);
    if (cleanup) await step.getByRole("checkbox", { name: /Run even after an earlier step fails/ }).check();
  };
  await addStep({ title: "Delete the pet", method: "DELETE", path: "/pets/{{id}}", codes: "204", cleanup: true });
  await addStep({ title: "Confirm the pet is gone", method: "GET", path: "/pets/{{nope}}", codes: "404" });
  // A value no earlier step saves is caught before saving.
  await expect(flow.locator(".flow-edit-step").last()).toContainText("Uses {{nope}}, which no earlier step saves.");
  await flow.locator(".flow-edit-step").last().getByPlaceholder("/pets/{{petId}}").fill("/pets/{{id}}");
  await flow.getByRole("button", { name: "Save flow" }).click();

  await expect(flow.locator(".edited-pill")).toHaveText("Edited");
  await expect(flow.locator(".flow-step")).toHaveCount(4);
  await flow.getByRole("button", { name: "Run flow" }).click();
  await expect(flow.locator(".execution-confirmation")).toContainText("The last steps delete what the flow created");
  await flow.getByRole("button", { name: "Confirm and run" }).click();

  // Reading fails on the target's schema bug; the cleanup still deletes the pet, the check after it is skipped.
  await expect(flow.locator(".flow-step").nth(2)).toContainText("HTTP 204");
  await expect(flow.locator(".flow-step").nth(2).locator(".history-status")).toHaveText("PASS");
  await expect(flow.locator(".flow-step").nth(3).locator(".history-status")).toHaveText("SKIPPED");

  await nav(page, "Coverage");
  await expect(page.locator(".stat-card").filter({ hasText: "Lifecycle flows passing" })).toContainText("0 / 1");

  await nav(page, "Flows");
  await flow.getByRole("button", { name: "Reset to suggested" }).click();
  await flow.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(flow.locator(".flow-step")).toHaveCount(2);
  await expect(flow.locator(".edited-pill")).toHaveCount(0);
});

test("imports a CLI report so CI runs count on Coverage", async ({ page }) => {
  const reportPath = join(mkdtempSync(join(tmpdir(), "api-qa-cli-")), "report.json");
  // The CLI runs from the backend folder, so a relative interpreter path is resolved first.
  const cli = spawnSync(python.includes("/") ? resolve(python) : python, ["-m", "app.cli", "run", "--spec", `${TARGET_URL}/openapi.json`, "--target", TARGET_URL, "--allow-private-network", "--endpoint", "GET /pets", "--json", reportPath], {
    cwd: "../backend", encoding: "utf-8",
  });
  expect(cli.status, cli.stderr).toBe(0);

  await importPets(page);
  await nav(page, "Coverage");
  await page.locator(".coverage-export input[type=file]").setInputFiles(reportPath);
  await expect(page.locator(".success-alert")).toContainText("Imported 1 check on 1 endpoint from the CLI report");

  await page.locator(".coverage-export input[type=file]").setInputFiles(reportPath);
  await expect(page.locator(".success-alert")).toContainText("1 run was already imported.");

  await nav(page, "Run history");
  await page.locator(".history-group-toggle").first().click();
  await expect(page.locator(".history-run").filter({ hasText: "GET /pets" }).locator(".run-source-badge")).toHaveText("CI");
});

test("imports Newman and JUnit results so other test suites count on Coverage", async ({ page }) => {
  // A real JUnit file: the CLI's report names each suite after its endpoint, such as GET /pets/{id}.
  const junitPath = join(mkdtempSync(join(tmpdir(), "api-qa-junit-")), "report.xml");
  const cli = spawnSync(python.includes("/") ? resolve(python) : python, ["-m", "app.cli", "run", "--spec", `${TARGET_URL}/openapi.json`, "--target", TARGET_URL, "--allow-private-network", "--endpoint", "GET /pets/{id}", "--param", "id=1", "--junit", junitPath], {
    cwd: "../backend", encoding: "utf-8",
  });
  expect(cli.status, cli.stderr).toBe(1);
  const newman = {
    collection: { info: { name: "Pets in Postman" } },
    run: { timings: { started: Date.now() }, executions: [
      { item: { name: "List orders" }, request: { method: "GET", url: { raw: "{{baseUrl}}/orders", path: ["orders"] } }, response: { code: 401, responseTime: 9 }, assertions: [{ assertion: "Status code is 200", error: { message: "expected 401 to equal 200" } }] },
      { item: { name: "Health" }, request: { method: "GET", url: { raw: "{{baseUrl}}/health", path: ["health"] } }, response: { code: 200, responseTime: 3 }, assertions: [] },
    ] },
  };

  await importPets(page);
  await nav(page, "Coverage");
  const input = page.locator(".coverage-export input[type=file]");
  await input.setInputFiles({ name: "newman.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(newman)) });
  await expect(page.locator(".success-alert")).toContainText("Imported 1 Newman test on 1 endpoint of E2E Pets from “Pets in Postman”. Left out 1 that matched no endpoint: GET /health.");
  await input.setInputFiles(junitPath);
  await expect(page.locator(".success-alert")).toContainText("JUnit test");

  await nav(page, "Run history");
  await page.locator(".history-group-toggle").first().click();
  const newmanRun = page.locator(".history-run").filter({ hasText: "GET /orders" }).filter({ has: page.locator(".run-source-badge", { hasText: "Newman" }) });
  await expect(page.locator(".history-run").filter({ hasText: "GET /pets/{id}" }).locator(".run-source-badge", { hasText: "JUnit" })).toBeVisible();
  await newmanRun.click();
  await expect(page.locator(".run-outcome").first()).toContainText("Status code is 200: expected 401 to equal 200");
});

test("marks an endpoint critical or not critical, and keeps the mark", async ({ page }) => {
  await importPets(page);
  await nav(page, "Coverage");
  await showAdvanced(page);
  const item = page.locator(".history-runs > li").filter({ has: page.locator(".coverage-row", { hasText: "List orders" }) });
  await expect(item.locator(".coverage-row")).toContainText("+10 Sensitive area: orders");

  await item.getByLabel("Criticality").selectOption("critical");
  await expect(item.locator(".coverage-row")).toContainText("+20 Marked critical");
  await expect(item.locator(".coverage-row")).not.toContainText("Sensitive area");

  await page.reload();
  await nav(page, "Coverage");
  const again = page.locator(".history-runs > li").filter({ has: page.locator(".coverage-row", { hasText: "List orders" }) });
  await expect(again.getByLabel("Criticality")).toHaveValue("critical");
  await again.getByLabel("Criticality").selectOption("normal");
  await expect(again.locator(".coverage-row")).not.toContainText("Marked critical");
  await expect(again.locator(".coverage-row")).not.toContainText("Sensitive area");
});

test("shows what changed when a contract is imported again", async ({ page }) => {
  const contract = await (await fetch(`${TARGET_URL}/openapi.json`)).json();
  await importFile(page, "pets-contract.json", contract);
  const changed = structuredClone(contract);
  changed.info.version = "1.1.0";
  changed.paths["/pets/{id}"].get.responses["410"] = { description: "gone" };
  delete changed.paths["/orders"];
  changed.paths["/pets/{id}"].delete = { summary: "Delete a pet", parameters: changed.paths["/pets/{id}"].get.parameters, responses: { 204: { description: "deleted" } } };
  await importFile(page, "pets-contract.json", changed);

  await expect(page.locator(".import-notice")).toContainText("1 new endpoint, 1 changed endpoint, 1 removed endpoint");
  await nav(page, "Coverage");
  const panel = page.locator(".contract-changes");
  await expect(panel).toContainText("1.0.0 → 1.1.0");
  await expect(panel).toContainText("DELETE /pets/{id}");
  await expect(panel).toContainText("response 410");
  await expect(panel).toContainText("GET /orders");
  // The backend classifies each change for clients: removing an endpoint breaks them, a new response does not.
  await expect(panel.locator(".contract-severity-summary")).toContainText("1 breaking · 0 warnings · 2 safe");
  await expect(panel.locator("li").filter({ hasText: "GET /orders" }).locator(".contract-severity")).toHaveText("Breaking");
  await expect(panel.locator("li").filter({ hasText: "GET /pets/{id}" }).first()).toContainText("New documented response.");
  // A new endpoint is scored once, as never tested; a changed one adds Changed in the contract.
  await expect(page.locator(".coverage-row").filter({ hasText: "/pets/{id}" }).filter({ has: page.locator(".method-delete") })).not.toContainText("in the contract");
  await expect(page.locator(".coverage-row").filter({ hasText: "/pets/{id}" }).filter({ has: page.locator(".method-get") })).toContainText("Changed in the contract");
});

test("matches a renamed contract by its source and offers to merge one with the same title", async ({ page }) => {
  const contract = await (await fetch(`${TARGET_URL}/openapi.json`)).json();
  await importFile(page, "pets-contract.json", contract);

  const renamed = structuredClone(contract);
  renamed.info.title = "E2E Pets Renamed";
  await importFile(page, "pets-contract.json", renamed);
  await expect(page.locator(".import-notice")).toContainText("Imported E2E Pets again, now titled E2E Pets Renamed");

  const copy = structuredClone(renamed);
  copy.paths["/pets"].get.responses["500"] = { description: "error" };
  await importFile(page, "pets-copy.json", copy);
  await expect(page.locator(".merge-offer")).toContainText("imported from pets-contract.json");
  await page.getByRole("button", { name: "Merge into it" }).click();
  await expect(page.locator(".import-notice")).toContainText("1 changed endpoint");
  await expect(page.locator(".merge-offer")).toHaveCount(0);

  await nav(page, "API specs");
  await expect(page.locator(".spec-card").filter({ hasText: "E2E Pets Renamed" })).toHaveCount(1);
});

test("opening an endpoint from Coverage scrolls the endpoint list to it", async ({ page }) => {
  const paths = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`/items${String(index).padStart(2, "0")}`, { get: { summary: `Item ${index}`, responses: { 200: { description: "ok" } } } }]));
  const contract = { openapi: "3.0.3", info: { title: "Long API", version: "1.0.0" }, servers: [{ url: TARGET_URL }], paths };
  await importFile(page, "long.json", contract);

  await nav(page, "Coverage");
  await page.locator(".coverage-row").filter({ hasText: "/items39" }).click();
  const selected = page.locator(".endpoint-list .endpoint-row.selected");
  await expect(selected).toContainText("/items39");
  const visible = await selected.evaluate((row) => {
    const list = row.closest(".endpoint-list").getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return box.top >= list.top && box.bottom <= list.bottom;
  });
  expect(visible).toBe(true);
});

test("flags a saved AI check that no longer fits the contract", async ({ page, request }) => {
  await importPets(page);
  // Leave the app first, so a background save from the open page cannot overwrite what is written next.
  await page.goto("about:blank");
  // A saved AI check normally needs an AI model; here one is written straight into the saved workspace.
  const { savedApis } = await (await request.get("/api/v1/workspace")).json();
  const position = savedApis.findIndex((api) => api.source === `${TARGET_URL}/openapi.json`);
  const api = structuredClone(savedApis[position]);
  const operation = api.overview.operations.find((item) => item.method === "GET" && item.path === "/pets/{id}");
  operation.scenarios.push({
    category: "negative",
    title: "Gone pet returns 410",
    rationale: "A deleted pet should answer 410 Gone.",
    review_required: true,
    source: "ai_edited",
    request_example: {
      method: "GET", path: "/pets/{id}", query_params: {}, form_body: false, form_fields: {},
      omitted_parameters: [], parameter_values: { "header:X-Old": "1" }, json_body: null, expected_status_codes: [410],
    },
  });
  const saved = await request.put(`/api/v1/workspace/apis/${encodeURIComponent(api.id)}`, { params: { position }, data: api });
  expect(saved.status()).toBe(204);

  await page.goto("/");
  await page.locator(".spec-card").filter({ has: page.getByText(api.title, { exact: true }) }).locator(".spec-card-open").click();
  await enterPetId(page);
  const card = check(page, "Gone pet returns 410");
  await expect(card.locator(".edited-pill")).toHaveText("AI idea · edited");
  const warning = card.locator(".stale-check");
  await expect(warning).toContainText("Review against the current contract");
  await expect(warning).toContainText("Sends header parameter X-Old, which the contract no longer has");
  await expect(warning).toContainText("Expects HTTP 410, which the contract does not document");
});

test("signs in once and sends the token to every endpoint that needs it", async ({ page, request }) => {
  const contract = await (await request.get(`${TARGET_URL}/openapi.json`)).json();
  contract.servers = [{ url: TARGET_URL }];
  contract.paths["/login"] = { post: {
    summary: "Sign in",
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { user: { type: "string", example: "qa" }, password: { type: "string", example: "wrong" } } } } } },
    responses: { 200: { description: "signed in" }, 401: { description: "wrong password" } },
  } };
  await importFile(page, "auth-contract.json", contract);

  await expect(page.locator(".connection-settings")).toContainText("no credentials");
  await openTarget(page);
  const panel = page.locator(".connection-panel");
  await expect(panel).toContainText("used by 1 endpoint");
  await panel.getByRole("button", { name: "Get a token from a sign-in request instead" }).click();
  await expect(panel.getByLabel("Sign-in endpoint")).toHaveValue("POST /login");

  // A wrong password is explained, then the right one fills X-Key for every endpoint.
  await panel.getByRole("button", { name: "Sign in" }).click();
  await expect(panel.locator(".error-alert")).toContainText("returned HTTP 401");
  await panel.getByLabel(/Request body/).fill(JSON.stringify({ user: "qa", password: "e2e-secret" }));
  await panel.getByRole("button", { name: "Sign in" }).click();
  await expect(panel.locator(".success-alert")).toContainText("Signed in (HTTP 200, token at /access_token). X-Key is set for 1 endpoint.");
  await expect(page.locator(".connection-settings")).toContainText("credentials set");
  await panel.getByRole("button", { name: "Close target and authentication" }).click();

  await endpoint(page, "GET", "/orders").click();
  await expect(page.getByPlaceholder("Using the API-wide value")).toBeVisible();
  await runAll(page);
  // The valid request carries the token; "Call without authentication" still leaves it out.
  expect(await (await request.get(`${TARGET_URL}/__order-keys`)).json()).toEqual(["e2e-token", null]);
});

test("tours the built-in demo API and finds its deliberate problems", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Try the demo API" }).click();
  await expect(page.getByRole("heading", { name: "Demo Bookstore" })).toBeVisible();
  const guide = page.locator(".demo-guide");
  await expect(guide.locator("li")).toHaveCount(8);

  // Sign in once with the prefilled demo credentials.
  await guide.getByRole("button", { name: "Open Target & auth" }).click();
  const panel = page.locator(".connection-panel");
  await panel.getByRole("button", { name: "Get a token from a sign-in request instead" }).click();
  await expect(panel.getByLabel("Sign-in endpoint")).toHaveValue("POST /auth/login");
  await panel.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(panel.locator(".success-alert")).toContainText("Authorization is set for");
  await panel.getByRole("button", { name: "Close target and authentication" }).click();

  // A price that is text breaks the schema.
  await guide.getByRole("button", { name: "Open GET /books" }).click();
  await runAll(page);
  await expect(check(page, "Valid request").locator(".result-box")).toContainText("FAIL");
  await expect(check(page, "Valid request")).toContainText("price");
  await expect(check(page, "Send the wrong type for limit").locator(".result-box")).toContainText("PASS");

  // An endpoint that documents a token but never asks for one.
  await guide.getByRole("button", { name: "Open GET /orders" }).click();
  await runAll(page);
  await expect(check(page, "Valid request").locator(".result-box")).toContainText("PASS");
  await expect(check(page, "Call without authentication").locator(".result-box")).toContainText("FAIL");

  // Validation gaps on a data-changing endpoint, after a confirmation.
  await guide.getByRole("button", { name: "Open POST /books" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /Run selected/ }).click();
  const run = saved(page, "runs");
  await page.getByRole("button", { name: "Confirm and run" }).click();
  await run;
  await expect(check(page, "Valid request").locator(".result-box")).toContainText("PASS");
  await expect(check(page, "Send the wrong type for year").locator(".result-box")).toContainText("FAIL");
  await expect(check(page, "Send an undocumented request field").locator(".result-box")).toContainText("FAIL");
  await expect(check(page, "Call without authentication").locator(".result-box")).toContainText("PASS");

  // The lifecycle flow works end to end with the same token.
  await guide.getByRole("button", { name: "Open Flows" }).click();
  const flow = page.locator(".flow-card").filter({ has: page.getByRole("heading", { name: "Book lifecycle" }) });
  await flow.getByRole("button", { name: "Run flow" }).click();
  await flow.getByRole("button", { name: "Confirm and run" }).click();
  await expect(flow.locator(".flow-card-pills .history-status")).toHaveText("PASS");

  // The access check: a second reader may replace the first reader's book but not delete it.
  const access = flow.locator(".access-check");
  await access.locator(":scope > summary").click();
  const secondSignIn = access.locator(".access-check-signin");
  await secondSignIn.locator("summary").click();
  await secondSignIn.locator("textarea").fill(JSON.stringify({ email: "second@example.com", password: "second-password" }));
  await secondSignIn.getByRole("button", { name: "Sign in as the second user" }).click();
  await expect(secondSignIn.locator(".access-check-signed-in")).toContainText("Signed in as the second user");
  await access.getByRole("button", { name: "Run access check" }).click();
  await access.getByRole("button", { name: "Confirm and run" }).click();
  await expect(access.locator(".access-verdict")).toContainText("The second user reached the first user's record");
  await expect(access.locator(".access-finding-fail")).toHaveText("The second user could change the first user's record (HTTP 200).");
  await expect(access.locator(".access-finding-pass")).toHaveText("The second user could not delete the record (HTTP 403).");
  // The second reader's token is never saved with the workspace.
  const workspace = await (await page.request.get("/api/v1/workspace")).text();
  expect(workspace).not.toContain("second-password");

  // A bulk run sends the same token: GET /me only passes when signed in.
  await nav(page, "Coverage");
  await page.locator(".coverage-run-button").click();
  const bulk = page.locator(".bulk-run");
  await bulk.getByRole("button", { name: /^Run \d+ checks/ }).click();
  await expect(bulk).toContainText("Bulk run finished");
  await expect(page.locator(".coverage-row").filter({ has: page.getByText("/me", { exact: true }) }).locator(".coverage-status")).toHaveText("Passing");

  await nav(page, "Overview");
  await page.locator(".demo-guide").getByRole("button", { name: "Reset demo data" }).click();
  await expect(page.locator(".demo-guide-note")).toHaveText("The three sample books are back.");
});

test("deletes all saved data", async ({ page }) => {
  await importPets(page);
  await nav(page, "Settings");
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByText("All saved APIs, runs, and request details were deleted.")).toBeVisible();
  await page.reload();

  await expect(page.getByRole("heading", { name: "Start with an API contract" })).toBeVisible();
});
