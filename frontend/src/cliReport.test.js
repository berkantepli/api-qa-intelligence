import { describe, expect, it } from "vitest";
import { cliImportMessage, cliReportRuns, matchReportApi, parseCliReport } from "./cliReport.js";

const api = { id: "pets", title: "Pets", overview: { version: "1.0", operations: [{ method: "GET", path: "/pets" }, { method: "POST", path: "/pets" }] } };
const result = (outcome, status) => ({ result: outcome, method: "GET", path: "/pets", response_status: status, expected_status_codes: [200], duration_ms: 12 });
const report = {
  api: "Pets", api_version: "1.0", target: "https://staging.example.com", tool_version: "1.2.0", generated_at: "2026-10-11T10:00:00+00:00",
  endpoints: [
    { method: "GET", path: "/pets", checks: [{ title: "Valid request", category: "happy_path", result: result("PASS", 200) }] },
    { method: "POST", path: "/pets", checks: [], skipped_reason: "Changes data; pass --include-writes to run it.", skipped_checks: ["Valid request"] },
    { method: "GET", path: "/gone", checks: [{ title: "Valid request", category: "happy_path", result: result("FAIL", 404) }] },
  ],
};

describe("parseCliReport", () => {
  it("accepts an api-qa run report and rejects other files", () => {
    expect(parseCliReport(JSON.stringify(report)).api).toBe("Pets");
    expect(() => parseCliReport("{")).toThrow("not valid JSON");
    expect(() => parseCliReport(JSON.stringify({ format: "api-qa-intelligence-workspace" }))).toThrow("not an api-qa run report");
  });
});

describe("matchReportApi", () => {
  it("matches by title, preferring the active API and then the same version", () => {
    const older = { ...api, id: "pets-old", overview: { ...api.overview, version: "0.9" } };
    expect(matchReportApi(report, [older, api])).toBe(api);
    expect(matchReportApi(report, [older, api], "pets-old")).toBe(older);
    expect(matchReportApi(report, [{ ...api, title: "Other" }])).toBeNull();
  });
});

describe("cliReportRuns", () => {
  it("turns each endpoint that ran into a CI run and skips the rest", () => {
    const outcome = cliReportRuns(report, api);

    expect(outcome.runs).toEqual([{
      id: Date.parse("2026-10-11T10:00:00Z"),
      apiId: "pets",
      api: "Pets",
      endpoint: "GET /pets",
      target: "https://staging.example.com",
      createdAt: "2026-10-11T10:00:00.000Z",
      source: "cli",
      toolVersion: "1.2.0",
      results: [{ ...result("PASS", 200), title: "Valid request", category: "happy_path", source: "contract" }],
    }]);
    expect(outcome.unknownEndpoints).toEqual(["GET /gone"]);
    expect(outcome.versionMismatch).toBe(false);
  });

  it("does not import the same report twice", () => {
    const first = cliReportRuns(report, api);
    const again = cliReportRuns(report, api, first.runs);

    expect(again.runs).toEqual([]);
    expect(again.duplicates).toBe(1);
    expect(cliImportMessage(report, api, again)).toContain("Nothing new to import from this report. 1 run was already imported.");
  });

  it("says what was imported and what was left out", () => {
    const newer = { ...report, api_version: "2.0" };
    const message = cliImportMessage(newer, api, cliReportRuns(newer, api));

    expect(message).toContain("Imported 1 check on 1 endpoint");
    expect(message).toContain("Skipped endpoints not in this API: GET /gone.");
    expect(message).toContain("The report is for version 2.0; the saved API is 1.0.");
  });

  it("imports flows that ran as flow runs", () => {
    const withFlows = {
      ...report,
      flows: [
        { id: "lifecycle:/pets", title: "Pet lifecycle", result: { result: "FAIL", steps: [
          { title: "Create a pet", role: "create", status: "PASS", saved_values: { id: 5 }, check: result("PASS", 201) },
          { title: "Read the new pet", role: "read", status: "SKIPPED", reason: "Skipped because an earlier step did not pass.", check: null },
        ] } },
        { id: "lifecycle:/orders", title: "Order lifecycle", result: null, skipped_reason: "Creates and deletes data; pass --include-writes to run it." },
      ],
    };
    const outcome = cliReportRuns(withFlows, api);
    const flowRun = outcome.runs.find((run) => run.kind === "flow");

    expect(flowRun).toMatchObject({ endpoint: "Flow: Pet lifecycle", flowId: "lifecycle:/pets", source: "cli", apiId: "pets" });
    expect(flowRun.results.map((step) => step.result)).toEqual(["PASS", "SKIPPED"]);
    expect(cliImportMessage(withFlows, api, outcome)).toContain("Imported 1 check on 1 endpoint and 1 flow");
    expect(cliReportRuns(withFlows, api, outcome.runs).duplicates).toBe(2);
  });
});
