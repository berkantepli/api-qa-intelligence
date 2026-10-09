// The main flows of the app against e2e/target_api.py, in order: they share one workspace database.
import { expect, test } from "@playwright/test";
import { TARGET_URL } from "../playwright.config.js";

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
  await page.getByPlaceholder("Enter id").fill("7");
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

test("deletes all saved data", async ({ page }) => {
  await page.goto("/");
  await nav(page, "Settings");
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("button", { name: "Delete everything" }).click();
  await page.reload();

  await expect(page.getByRole("heading", { name: "Start with an API contract" })).toBeVisible();
});
