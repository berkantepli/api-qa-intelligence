import { describe, expect, it } from "vitest";
import { checkRecords, comparisonBaselines, latestReportChecks, latestRun, previousRunOf, reportCheck, reportFileName } from "./runCompare.js";

const pass = (title, extra = {}) => ({ title, result: "PASS", duration_ms: 20, response_status: 200, expected_status_codes: [200], ...extra });
const fail = (title, extra = {}) => ({ title, result: "FAIL", duration_ms: 20, response_status: 500, expected_status_codes: [200], ...extra });
const run = (id, endpoint, createdAt, results, extra = {}) => ({ id, apiId: "a", endpoint, createdAt, results, ...extra });

const runs = [
  run(1, "GET /books", "2026-10-10T10:00:00Z", [pass("Valid request")]),
  run(2, "GET /books", "2026-10-13T10:00:00Z", [fail("Valid request")], { batchId: "b1" }),
  run(3, "GET /me", "2026-10-13T10:00:01Z", [pass("Valid request")], { batchId: "b1" }),
];

describe("checkRecords", () => {
  it("lists every result oldest first, with a reason for failures", () => {
    const records = checkRecords([runs[1], runs[0]]);
    expect(records.map((record) => [record.run_id, record.result])).toEqual([["1", "PASS"], ["2", "FAIL"]]);
    expect(records[1].message).toBe("Expected HTTP 200, received HTTP 500.");
    expect(records[0].message).toBe("");
  });
});

describe("baselines", () => {
  it("treats a whole bulk run as the latest run", () => {
    expect(latestRun(runs).map((item) => item.id)).toEqual([2, 3]);
    const [previous, day, week] = comparisonBaselines(runs, new Date("2026-10-14T12:00:00Z").getTime());
    expect(previous.before.map((item) => item.id)).toEqual([1]);
    expect(day.before.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(week.available).toBe(false);
  });

  it("finds the previous run of the same endpoint", () => {
    expect(previousRunOf(runs[1], runs).id).toBe(1);
    expect(previousRunOf(runs[2], runs)).toBeNull();
  });
});

describe("report checks", () => {
  it("carries the masked evidence and a reason", () => {
    const check = reportCheck(fail("Valid request", { method: "GET", request_url: "http://api/books", response_body: "{}", schema_check: { errors: ["$.price"] } }), "GET /books");
    expect(check).toMatchObject({ group: "GET /books", request: "GET http://api/books", schema_errors: ["$.price"], message: "Expected HTTP 200, received HTTP 500." });
  });

  it("keeps the latest result of each check", () => {
    expect(latestReportChecks(runs).map((check) => [check.group, check.result])).toEqual([["GET /books", "FAIL"], ["GET /me", "PASS"]]);
  });

  it("names the file safely", () => {
    expect(reportFileName("Demo Bookstore", "GET /books/{id}")).toBe("Demo-Bookstore-GET-books-id-report.html");
  });
});
