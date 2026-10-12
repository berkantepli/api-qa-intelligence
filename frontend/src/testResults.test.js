import { describe, expect, it } from "vitest";
import { outcomeSummary } from "./runDetail.js";
import { inferCategory, matchOperation, testResultRuns, testResultsMessage } from "./testResults.js";

const operations = [
  { method: "GET", path: "/pets" },
  { method: "GET", path: "/pets/{id}" },
  { method: "GET", path: "/pets/mine" },
  { method: "GET", path: "/owners/{ownerId}/pets" },
  { method: "POST", path: "/pets" },
];
const api = { id: "pets", title: "Pets", overview: { operations } };

describe("matchOperation", () => {
  it("matches by method and the end of the path, allowing a base path", () => {
    expect(matchOperation(operations, "get", "/api/v3/pets/7").path).toBe("/pets/{id}");
    expect(matchOperation(operations, "GET", "/pets/mine").path).toBe("/pets/mine");
    expect(matchOperation(operations, "GET", "/owners/3/pets").path).toBe("/owners/{ownerId}/pets");
    expect(matchOperation(operations, "GET", "/pets/{id}").path).toBe("/pets/{id}");
    expect(matchOperation(operations, "POST", "/pets?dry=1").path).toBe("/pets");
  });

  it("finds nothing without a request line or a matching endpoint", () => {
    expect(matchOperation(operations, null, null)).toBeNull();
    expect(matchOperation(operations, "DELETE", "/pets/7")).toBeNull();
    expect(matchOperation(operations, "GET", "/stores")).toBeNull();
  });
});

describe("testResultRuns", () => {
  const parsed = {
    tool: "newman", name: "Pets collection", generated_at: "2026-10-12T09:00:00+00:00", fingerprint: "abc",
    cases: [
      { title: "List pets", method: "GET", path: "/api/pets", response_status: 200, result: "PASS", duration_ms: 40 },
      { title: "Missing pet", method: "GET", path: "/api/pets/999", response_status: 500, result: "FAIL", message: "Status code is 404: expected 500 to equal 404", duration_ms: 12 },
      { title: "Unknown", method: "GET", path: "/stores", result: "PASS" },
      { title: "Later", method: "GET", path: "/pets", result: "SKIPPED" },
    ],
  };
  const now = new Date("2026-10-12T10:00:00Z");

  it("groups matched cases into one run per endpoint and counts the rest", () => {
    const outcome = testResultRuns(parsed, api, [], now);

    expect(outcome.runs.map((run) => [run.endpoint, run.source, run.importKey, run.createdAt, run.results.map((result) => result.result)])).toEqual([
      ["GET /pets", "newman", "newman:abc", "2026-10-12T09:00:00.000Z", ["PASS"]],
      ["GET /pets/{id}", "newman", "newman:abc", "2026-10-12T09:00:00.000Z", ["FAIL"]],
    ]);
    expect(outcome.runs[1].results[0]).toMatchObject({ category: "negative", imported: "newman", response_status: 500, reason: "Status code is 404: expected 500 to equal 404" });
    expect([outcome.cases, outcome.unmatched, outcome.skipped]).toEqual([2, ["GET /stores"], 1]);
    expect(testResultsMessage(parsed, api, outcome)).toBe(
      "Imported 2 Newman tests on 2 endpoints of Pets from “Pets collection”. Left out 1 that matched no endpoint: GET /stores. 1 skipped test was left out.",
    );
  });

  it("does not import the same report twice", () => {
    const first = testResultRuns(parsed, api, [], now);
    const again = testResultRuns(parsed, api, first.runs, now);

    expect(again).toMatchObject({ runs: [], duplicate: true });
    expect(testResultsMessage(parsed, api, again)).toBe("This Newman report is already in Run history.");
  });

  it("explains how JUnit tests are matched when none match", () => {
    const junit = { tool: "junit", name: "API tests", fingerprint: "x", cases: [{ title: "creates a user", result: "PASS" }] };
    expect(testResultsMessage(junit, api, testResultRuns(junit, api, [], now))).toContain("contains a request line such as GET /pets/{id}");
  });

  it("says in run details what the other tool reported", () => {
    const [passed, failed] = testResultRuns(parsed, api, [], now).runs.map((run) => run.results[0]);
    expect(outcomeSummary(passed)).toBe("Passed in Newman with HTTP 200.");
    expect(outcomeSummary(failed)).toBe("Status code is 404: expected 500 to equal 404");
  });
});

describe("inferCategory", () => {
  it("reads the kind of test from its name, then from the status it got", () => {
    expect(inferCategory("Get pet without token", 401)).toBe("security_minded");
    expect(inferCategory("Create pet with too long name", 400)).toBe("boundary");
    expect(inferCategory("Create pet with missing name", 400)).toBe("negative");
    expect(inferCategory("Get a nonexistent pet", 404)).toBe("invalid_value");
    expect(inferCategory("List pets", 200)).toBe("happy_path");
    expect(inferCategory("Delete pet", 403)).toBe("security_minded");
    expect(inferCategory("Update pet", 409)).toBe("negative");
    expect(inferCategory("Some JUnit test", null)).toBe("imported");
    expect(inferCategory("List orders", 401, "FAIL")).toBe("imported");
    expect(inferCategory("List orders without token", 200, "FAIL")).toBe("security_minded");
  });
});
