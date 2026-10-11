// The main flows of the app against e2e/target_api.py, in order: they share one workspace database.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { python, TARGET_URL } from "../playwright.config.js";

test.describe.configure({ mode: "serial" });

const endpoint = (page, method, path) => page.locator(".endpoint-row").filter({ has: page.locator(".method-tag", { hasText: method }) }).filter({ has: page.getByText(path, { exact: true }) });
const nav = (page, label) => page.locator(".sidebar .nav-link").filter({ hasText: label }).click();
const check = (page, title) => page.locator(".scenario-card").filter({ has: page.getByText(title, { exact: true }) });

async function runAll(page) {
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: /Run selected/ }).click();
  await expect(page.getByRole("button", { name: "View run details" })).toBeVisible();
}

test("imports a contract from a URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start with an API contract" })).toBeVisible();
  await page.getByPlaceholder("https://api.example.com/openapi.json").fill(`${TARGET_URL}/openapi.json`);
  await page.getByRole("button", { name: "Import API" }).click();

  await expect(page.getByRole("heading", { name: "E2E Pets" })).toBeVisible();
  await expect(page.locator(".endpoint-row")).toHaveCount(4);
  await expect(page.locator(".target-field input").first()).toHaveValue(TARGET_URL);
});

test("passes a correct endpoint and checks its body", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Overview");
  await endpoint(page, "GET", "/pets").click();
  await runAll(page);

  const valid = check(page, "Valid request");
  await expect(valid.locator(".result-box")).toContainText("PASS");
  await expect(valid).toContainText("Body matches the documented schema.");
  await expect(endpoint(page, "GET", "/pets").locator(".endpoint-status-passing")).toBeVisible();
});

test("explains a body that breaks the contract", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Overview");
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
  await page.goto("/");
  await nav(page, "Overview");
  await endpoint(page, "GET", "/orders").click();
  await runAll(page);

  await expect(check(page, "Call without authentication")).toContainText("Expected HTTP 401, received HTTP 200.");
  await expect(endpoint(page, "GET", "/orders").locator(".endpoint-status-failing")).toBeVisible();
});

test("does not run checks without a usable target", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Overview");
  await endpoint(page, "GET", "/pets").click();
  await page.getByRole("button", { name: "Select all" }).click();
  const target = page.locator(".target-field input").first();
  const run = page.getByRole("button", { name: /Run selected/ });

  await target.fill("");
  await expect(page.locator(".connection-status")).toContainText("No target URL");
  await expect(page.getByText("Enter a Target API base URL to run checks.")).toBeVisible();
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

test("opens a run again with the same checks selected", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Run history");
  await page.locator(".history-group-toggle").first().click();
  await page.locator(".history-run").filter({ hasText: "GET /orders" }).click();
  await expect(page.getByRole("heading", { name: "GET /orders" })).toBeVisible();
  await page.getByRole("button", { name: "Run again" }).click();

  await expect(page.locator(".scenario-header h2")).toHaveText("GET /orders");
  await expect(page.locator(".scenario-card.checked")).toHaveCount(2);
});

test("runs data-changing checks in bulk only after confirmation", async ({ page }) => {
  await page.goto("/");
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
  await page.goto("/");
  await nav(page, "Coverage");

  const rows = page.locator(".coverage-row");
  await expect(rows.first().locator(".risk-score")).toBeVisible();
  const scores = await rows.locator(".risk-score").evaluateAll((items) => items.map((item) => Number.parseInt(item.textContent, 10)));
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  await expect(rows.filter({ has: page.locator(".method-post") }).first()).toContainText("+15 Changes data");

  await page.getByText("How the risk score works").click();
  await expect(page.locator(".risk-rules table")).toContainText("Failing in latest run");
});

test("lists the coverage gaps of an endpoint", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Coverage");

  const item = page.locator(".history-runs > li").filter({ has: page.locator(".coverage-row", { hasText: "/pets/{id}" }) });
  await item.locator(".coverage-gaps summary").click();
  await expect(item.locator(".coverage-gap-list")).toContainText("No invalid-value check for path parameter id");
  await expect(item.locator(".coverage-gap-list")).toContainText("HTTP 404 is documented, but no check expects it");
  await expect(item.locator(".coverage-gap-codes")).toContainText("200Received");
});

test("runs a flow that passes the created id to the next request", async ({ page }) => {
  await page.goto("/");
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
});

test("edits a flow to clean up after itself, and shows untested lifecycles on Coverage", async ({ page }) => {
  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
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

test("shows what changed when a contract is imported again", async ({ page }) => {
  const contract = await (await fetch(`${TARGET_URL}/openapi.json`)).json();
  const upload = (document) => ({ name: "pets-contract.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) });
  const importFile = async (document) => {
    await page.goto("/");
    await nav(page, "API specs");
    await page.getByRole("button", { name: "Import API" }).first().click();
    await page.getByRole("tab", { name: "Upload file" }).click();
    await page.locator(".import-card input[type=file]").setInputFiles(upload(document));
    await page.locator(".import-card").getByRole("button", { name: /Import API/ }).click();
    await expect(page.locator(".overview-heading")).toBeVisible();
  };

  await importFile(contract);
  const changed = structuredClone(contract);
  changed.info.version = "1.1.0";
  changed.paths["/pets/{id}"].get.responses["410"] = { description: "gone" };
  delete changed.paths["/orders"];
  changed.paths["/pets/{id}"].delete = { summary: "Delete a pet", parameters: changed.paths["/pets/{id}"].get.parameters, responses: { 204: { description: "deleted" } } };
  await importFile(changed);

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
  await expect(page.locator(".coverage-row").filter({ hasText: "/pets/{id}" }).filter({ has: page.locator(".method-get") })).toContainText("+15 Changed in the contract");
});

test("matches a renamed contract by its source and offers to merge one with the same title", async ({ page }) => {
  const contract = await (await fetch(`${TARGET_URL}/openapi.json`)).json();
  const importFile = async (name, document) => {
    await page.goto("/");
    await nav(page, "API specs");
    await page.getByRole("button", { name: "Import API" }).first().click();
    await page.getByRole("tab", { name: "Upload file" }).click();
    await page.locator(".import-card input[type=file]").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document)) });
    await page.locator(".import-card").getByRole("button", { name: /Import API/ }).click();
    await expect(page.locator(".overview-heading")).toBeVisible();
  };

  const renamed = structuredClone(contract);
  renamed.info.title = "E2E Pets Renamed";
  await importFile("pets-contract.json", renamed);
  await expect(page.locator(".import-notice")).toContainText("Imported E2E Pets again, now titled E2E Pets Renamed");

  const copy = structuredClone(renamed);
  copy.paths["/pets"].get.responses["500"] = { description: "error" };
  await importFile("pets-copy.json", copy);
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
  await page.goto("/");
  await nav(page, "API specs");
  await page.getByRole("button", { name: "Import API" }).first().click();
  await page.getByRole("tab", { name: "Upload file" }).click();
  await page.locator(".import-card input[type=file]").setInputFiles({ name: "long.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(contract)) });
  await page.locator(".import-card").getByRole("button", { name: /Import API/ }).click();
  await expect(page.locator(".overview-heading")).toBeVisible();

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

test("deletes all saved data", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Settings");
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByText("All saved APIs, runs, and request details were deleted.")).toBeVisible();
  await page.reload();

  await expect(page.getByRole("heading", { name: "Start with an API contract" })).toBeVisible();
});
