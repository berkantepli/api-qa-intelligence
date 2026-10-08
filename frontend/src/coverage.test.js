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
  const coverage = computeCoverage(overview, runs, Date.parse("2026-10-04T10:00:00Z"));
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
    expect(coverage.totals).toEqual({ endpoints: 4, tested: 2, coveragePercent: 50, failing: 1, untestedWrites: 2, flaky: 0, stale: 0, checksExecuted: 4 });
  });

  it("shows each category by its checks' latest outcome", () => {
    const states = Object.fromEntries(byKey["GET /pets"].categories.map((category) => [category.id, category.state]));
    expect(states).toEqual({ happy_path: "passing", negative: "passing", boundary: "none", invalid_value: "none", security_minded: "none" });
    expect(byKey["GET /pets/{id}"].categories[0].state).toBe("failing");
    expect(byKey["DELETE /pets/{id}"].categories[0].state).toBe("not_run");
  });

  it("handles a missing overview", () => {
    expect(computeCoverage(null, []).totals.coveragePercent).toBe(0);
  });
});

describe("flaky and stale endpoints", () => {
  const outcomes = (...results) => results.map((result, index) => run("GET /pets", `2026-10-0${index + 1}T10:00:00Z`, [{ title: "Valid request", category: "happy_path", result }]));

  it("flags a check whose outcome flips at least twice, not a single fix", () => {
    const flipping = computeCoverage(overview, outcomes("PASS", "FAIL", "PASS"), Date.parse("2026-10-04T00:00:00Z"));
    const fixed = computeCoverage(overview, outcomes("FAIL", "FAIL", "PASS"), Date.parse("2026-10-04T00:00:00Z"));
    const pets = (coverage) => coverage.endpoints.find((endpoint) => endpoint.key === "GET /pets");

    expect(pets(flipping).flakyChecks).toEqual(["Valid request"]);
    expect(pets(flipping).risks.map((risk) => risk.id)).toContain("flaky");
    expect(pets(fixed).flakyChecks).toEqual([]);
    expect(flipping.totals.flaky).toBe(1);
  });

  it("marks endpoints whose latest run is older than a week", () => {
    const coverage = computeCoverage(overview, outcomes("PASS"), Date.parse("2026-10-09T10:00:00Z"));
    const pets = coverage.endpoints.find((endpoint) => endpoint.key === "GET /pets");

    expect(pets.stale).toBe(true);
    expect(pets.risks.map((risk) => risk.id)).toContain("stale");
    expect(coverage.totals.stale).toBe(1);
  });
});

describe("runsForApi", () => {
  it("includes legacy runs matched by a unique title", () => {
    const runs = [{ apiId: "pets", api: "Pets" }, { api: "Pets" }, { api: "Other" }];
    expect(runsForApi(runs, "pets", [{ id: "pets", title: "Pets" }])).toHaveLength(2);
  });
});
