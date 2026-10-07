import { describe, expect, it } from "vitest";
import { computeCoverage, runsForApi } from "./coverage.js";

const happy = { category: "happy_path", title: "Valid request", request_example: {} };
const negative = { category: "negative", title: "Omit a required parameter", request_example: {} };
const overview = {
  operations: [
    { method: "GET", path: "/pets", parameters: [], scenarios: [happy, negative] },
    { method: "POST", path: "/pets", parameters: [{ name: "Authorization", credential: true }], scenarios: [happy] },
    { method: "GET", path: "/pets/{id}", parameters: [], scenarios: [happy, { category: "negative", title: "Idea", request_example: null }] },
    { method: "DELETE", path: "/pets/{id}", parameters: [], scenarios: [happy] },
  ],
};
const run = (endpoint, createdAt, results) => ({ id: createdAt, apiId: "pets", api: "Pets", endpoint, createdAt, results });

describe("computeCoverage", () => {
  const runs = [
    run("GET /pets", "2026-10-01T10:00:00Z", [{ title: "Valid request", category: "happy_path", result: "FAIL" }]),
    run("GET /pets", "2026-10-02T10:00:00Z", [{ title: "Valid request", category: "happy_path", result: "PASS" }, { title: "Omit a required parameter", category: "negative", result: "PASS" }]),
    run("GET /pets/{id}", "2026-10-03T10:00:00Z", [{ title: "Valid request", category: "happy_path", result: "ERROR" }]),
  ];
  const coverage = computeCoverage(overview, runs);
  const byKey = Object.fromEntries(coverage.endpoints.map((endpoint) => [endpoint.key, endpoint]));

  it("uses the latest run for status and counts covered runnable checks", () => {
    expect(byKey["GET /pets"]).toMatchObject({ status: "passing", runCount: 2, coveredChecks: 2, runnableChecks: 2, risks: [] });
    expect(byKey["GET /pets/{id}"].status).toBe("failing");
    expect(byKey["DELETE /pets/{id}"]).toMatchObject({ status: "untested", runCount: 0, coveredChecks: 0 });
  });

  it("flags failing, untested writes, happy-path-only, and unchecked auth", () => {
    expect(byKey["GET /pets/{id}"].risks.map((risk) => risk.id)).toEqual(["failing", "happy-only"]);
    expect(byKey["POST /pets"].risks.map((risk) => risk.id)).toEqual(["untested-write", "auth"]);
    expect(byKey["DELETE /pets/{id}"].risks.map((risk) => risk.id)).toEqual(["untested-write"]);
  });

  it("orders failing first, then untested by risk, then passing", () => {
    expect(coverage.endpoints.map((endpoint) => endpoint.key)).toEqual(["GET /pets/{id}", "POST /pets", "DELETE /pets/{id}", "GET /pets"]);
  });

  it("summarizes totals", () => {
    expect(coverage.totals).toEqual({ endpoints: 4, tested: 2, coveragePercent: 50, failing: 1, untestedWrites: 2, checksExecuted: 4 });
  });

  it("handles a missing overview", () => {
    expect(computeCoverage(null, []).totals.coveragePercent).toBe(0);
  });
});

describe("runsForApi", () => {
  it("includes legacy runs matched by a unique title", () => {
    const runs = [{ apiId: "pets", api: "Pets" }, { api: "Pets" }, { api: "Other" }];
    expect(runsForApi(runs, "pets", [{ id: "pets", title: "Pets" }])).toHaveLength(2);
  });
});
