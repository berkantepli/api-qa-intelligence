import { describe, expect, it } from "vitest";
import { computeGaps } from "./coverageGaps.js";

const operation = {
  method: "PUT",
  path: "/users/{id}",
  parameters: [
    { name: "id", location: "path", required: true, value_schema: { type: "integer" } },
    { name: "dry-run", location: "query", required: true, value_schema: { type: "boolean" } },
    { name: "Authorization", location: "header", required: true, credential: true },
  ],
  request_body_fields: [
    { name: "email", required: true, value_schema: { type: "string", format: "email" } },
    { name: "age", required: false, value_schema: { type: "integer", minimum: 0, maximum: 150 } },
    { name: "note", required: false, value_schema: { type: "string" } },
    { name: "avatar", is_file: true },
  ],
  response_codes: ["200", "404", "422", "DEFAULT"],
  scenarios: [
    { category: "happy_path", title: "Valid request", rationale: "", request_example: { expected_status_codes: [200] } },
    { category: "negative", title: "Omit a required parameter", rationale: "Send it without dry-run.", request_example: { omitted_parameters: [{ name: "dry-run", location: "query" }], expected_status_codes: [400, 422, 404] } },
    { category: "boundary", title: "Check boundary values for age", rationale: "", request_example: { expected_status_codes: [200] } },
    { category: "invalid_value", title: "Send invalid email", rationale: "", request_example: null, source: "ai" },
  ],
};
const runs = [{ results: [
  { title: "Valid request", result: "PASS", response_status: 200 },
  { title: "Omit a required parameter", result: "FAIL", response_status: 200 },
] }];

describe("computeGaps", () => {
  const gaps = computeGaps(operation, runs);
  const checks = Object.fromEntries(gaps.inputs.map((input) => [input.name, Object.fromEntries(input.checks.map((check) => [check.kind, check.state]))]));

  it("lists the checks each input calls for, leaving out credentials, files, and plain text", () => {
    expect(checks).toEqual({
      id: { invalid: "no_check" },
      "dry-run": { missing: "failing", invalid: "no_check" },
      email: { missing: "no_check", invalid: "not_runnable" },
      age: { boundary: "not_run", invalid: "no_check" },
    });
  });

  it("tracks documented response codes against what runs received", () => {
    expect(gaps.responses).toEqual([
      { code: "200", state: "received", titles: ["Valid request", "Check boundary values for age"] },
      { code: "404", state: "expected_not_received", titles: ["Omit a required parameter"] },
      { code: "422", state: "expected_not_received", titles: ["Omit a required parameter"] },
    ]);
  });

  it("explains every gap in a sentence, but not failing checks, which are a risk instead", () => {
    expect(gaps.gaps.map((gap) => gap.text)).toEqual([
      "No invalid-value check for path parameter id",
      "No invalid-value check for query parameter dry-run",
      "No check that leaves out field email",
      "An invalid-value check for field email is only an idea; convert it to a check",
      "A boundary check for field age has not run yet",
      "No invalid-value check for field age",
      "HTTP 404 is expected by a check but has never been received",
      "HTTP 422 is expected by a check but has never been received",
    ]);
  });

  it("matches a 4XX range and falls back to schema codes for older imports", () => {
    const older = computeGaps({ ...operation, response_codes: undefined, response_schemas: { "200": {}, "4XX": {} } }, [{ results: [{ title: "x", result: "PASS", response_status: 404 }] }]);

    expect(older.codesKnown).toBe(false);
    expect(older.responses.map((response) => [response.code, response.state])).toEqual([["200", "expected_not_received"], ["4XX", "received"]]);
  });

  it("has no gaps for an endpoint without inputs or codes", () => {
    expect(computeGaps({ method: "GET", path: "/health", scenarios: [] }).gaps).toEqual([]);
  });
});
