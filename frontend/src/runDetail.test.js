import { describe, expect, it } from "vitest";
import {
  formatEvidenceBody,
  groupRunsByApi,
  hasRequestEvidence,
  hasResponseEvidence,
  outcomeSummary,
  requestLine,
  sortedHeaders,
  summarizeResults,
} from "./runDetail.js";

describe("summarizeResults", () => {
  it("counts errors separately from failures", () => {
    const results = [{ result: "PASS" }, { result: "FAIL" }, { result: "ERROR" }, {}];

    expect(summarizeResults(results)).toEqual({ total: 4, passed: 1, failed: 1, errors: 2 });
  });
});

describe("formatEvidenceBody", () => {
  it("pretty-prints JSON and keeps other text as is", () => {
    expect(formatEvidenceBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatEvidenceBody("plain <html>")).toBe("plain <html>");
    expect(formatEvidenceBody("")).toBe("");
    expect(formatEvidenceBody(undefined)).toBe("");
  });
});

describe("sortedHeaders", () => {
  it("sorts header names case-insensitively", () => {
    expect(sortedHeaders({ "x-b": "2", Accept: "a", authorization: "[REDACTED]" }).map(([name]) => name))
      .toEqual(["Accept", "authorization", "x-b"]);
    expect(sortedHeaders(undefined)).toEqual([]);
  });
});

describe("requestLine", () => {
  it("prefers the recorded URL and falls back to the path", () => {
    expect(requestLine({ method: "GET", path: "/a", request_url: "http://x/a?q=1" })).toBe("GET http://x/a?q=1");
    expect(requestLine({ method: "POST", path: "/a" })).toBe("POST /a");
  });
});

describe("outcomeSummary", () => {
  it("describes pass, fail, and no-response outcomes", () => {
    expect(outcomeSummary({ result: "PASS", response_status: 200, expected_status_codes: [200] }))
      .toBe("Received HTTP 200, as expected.");
    expect(outcomeSummary({ result: "FAIL", response_status: 500, expected_status_codes: [200, 204] }))
      .toBe("Expected HTTP 200 or 204, received HTTP 500.");
    expect(outcomeSummary({ result: "ERROR", expected_status_codes: [200] }))
      .toBe("Expected HTTP 200, but no response was received.");
  });
  it("explains the response schema result when the status matched", () => {
    expect(outcomeSummary({ result: "PASS", response_status: 200, expected_status_codes: [200], schema_check: { status: "passed" } }))
      .toBe("Received HTTP 200, as expected, and the body matches the documented schema.");
    expect(outcomeSummary({ result: "FAIL", response_status: 200, expected_status_codes: [200], schema_check: { status: "failed", detail: "2 differences from the documented schema." } }))
      .toBe("Received HTTP 200, as expected, but the body does not match the documented schema: 2 differences from the documented schema.");
  });
});

describe("evidence presence", () => {
  it("detects runs saved before evidence was recorded", () => {
    const legacy = { result: "PASS", response_status: 200 };

    expect(hasRequestEvidence(legacy)).toBe(false);
    expect(hasResponseEvidence(legacy)).toBe(true);
    expect(hasRequestEvidence({ request_headers: { Accept: "a" } })).toBe(true);
    expect(hasResponseEvidence({ result: "ERROR", response_headers: {} })).toBe(false);
  });
});

describe("groupRunsByApi", () => {
  const savedApis = [{ id: "pets-id", title: "Pets" }, { id: "bugs-id", title: "Bugs" }];

  it("groups by API id, newest activity first, with check totals", () => {
    const runs = [
      { id: 1, apiId: "pets-id", api: "Pets", createdAt: "2026-10-01T10:00:00Z", results: [{ result: "PASS" }] },
      { id: 2, apiId: "bugs-id", api: "Bugs", createdAt: "2026-10-03T10:00:00Z", results: [{ result: "FAIL" }, { result: "ERROR" }] },
      { id: 3, apiId: "pets-id", api: "Pets", createdAt: "2026-10-02T10:00:00Z", results: [{ result: "FAIL" }] },
    ];

    const groups = groupRunsByApi(runs, savedApis);

    expect(groups.map((group) => group.key)).toEqual(["bugs-id", "pets-id"]);
    expect(groups[1].runs.map((run) => run.id)).toEqual([3, 1]);
    expect(groups[1].latestAt).toBe("2026-10-02T10:00:00Z");
    expect(groups[1].summary).toEqual({ total: 2, passed: 1, failed: 1, errors: 0 });
  });

  it("matches legacy runs by unique title and keeps unknown APIs separate", () => {
    const runs = [
      { id: 1, api: "Pets", createdAt: "2026-10-01T10:00:00Z", results: [] },
      { id: 2, apiId: "pets-id", api: "Pets", createdAt: "2026-10-02T10:00:00Z", results: [] },
      { id: 3, api: "Removed API", createdAt: "2026-10-03T10:00:00Z", results: [] },
    ];

    const groups = groupRunsByApi(runs, savedApis);

    expect(groups.map((group) => [group.key, group.runs.length])).toEqual([["title:Removed API", 1], ["pets-id", 2]]);
  });

  it("does not merge legacy runs when two saved APIs share a title", () => {
    const duplicates = [{ id: "a", title: "Same" }, { id: "b", title: "Same" }];
    const runs = [{ id: 1, api: "Same", createdAt: "2026-10-01T10:00:00Z", results: [] }];

    expect(groupRunsByApi(runs, duplicates)[0].key).toBe("title:Same");
  });
});
