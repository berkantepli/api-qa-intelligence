import { describe, expect, it } from "vitest";
import {
  formatEvidenceBody,
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
