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
    { category: "happy_path", title: "Valid request", rationale: "", request_example: { json_body: { email: "qa@example.com", age: 30 }, expected_status_codes: [200] } },
    { category: "negative", title: "Omit a required parameter", rationale: "Send it without dry-run.", request_example: { omitted_parameters: [{ name: "dry-run", location: "query" }], expected_status_codes: [400, 422, 404] } },
    { category: "boundary", title: "Check boundary values for age", rationale: "", request_example: { json_body: { email: "qa@example.com", age: 150 }, expected_status_codes: [200] } },
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

describe("matching checks to inputs", () => {
  const base = { category: "happy_path", title: "Valid request", rationale: "", request_example: { json_body: { name: "Rex", tag: "dog" }, expected_status_codes: [201] } };
  const operation = (scenarios) => ({
    method: "POST", path: "/pets/{id}",
    parameters: [{ name: "id", location: "path", required: true, value_schema: { type: "integer" } }],
    request_body_fields: [
      { name: "name", required: true, value_schema: { type: "string", maxLength: 20 } },
      { name: "tag", required: false, value_schema: { type: "string", enum: ["dog", "cat"] } },
    ],
    response_codes: ["201"],
    scenarios: [base, ...scenarios],
  });
  const states = (gaps) => Object.fromEntries(gaps.inputs.map((input) => [input.name, Object.fromEntries(input.checks.map((check) => [check.kind, check.state]))]));

  it("uses what a runnable check sends, not what its title says", () => {
    const gaps = computeGaps(operation([
      // The title names tag, but the request changes name.
      { category: "boundary", title: "Long tag", rationale: "", request_example: { json_body: { name: "x".repeat(21), tag: "dog" } } },
      { category: "negative", title: "No name", rationale: "", request_example: { json_body: { tag: "dog" } } },
      { category: "invalid_value", title: "Odd id", rationale: "", request_example: { json_body: base.request_example.json_body, parameter_values: { "path:id": "abc" } } },
    ]));

    expect(states(gaps)).toEqual({
      id: { invalid: "not_run" },
      name: { missing: "not_run", boundary: "not_run" },
      tag: { invalid: "no_check" },
    });
  });

  it("matches short, common names in words only in a clear form", () => {
    const idea = (title) => ({ category: "invalid_value", title, rationale: "", source: "ai" });
    expect(states(computeGaps(operation([idea("Send a valid pet")]))).id.invalid).toBe("no_check");
    expect(states(computeGaps(operation([idea("Pet ids are validated")]))).id.invalid).toBe("no_check");
    expect(states(computeGaps(operation([idea("Send an invalid id")]))).id.invalid).toBe("not_runnable");
    expect(states(computeGaps(operation([idea("Send letters in {id}")]))).id.invalid).toBe("not_runnable");
    expect(states(computeGaps(operation([idea("Undocumented tag value")]))).tag.invalid).toBe("not_runnable");
  });

  it("counts imported tests by their words and latest outcome", () => {
    const runs = [{ results: [
      { title: "Get pet with invalid id", category: "invalid_value", imported: "newman", result: "PASS", response_status: 404 },
      { title: "Create pet without name", category: "negative", imported: "junit", result: "FAIL" },
    ] }];
    const gaps = computeGaps(operation([]), runs);

    expect(states(gaps)).toMatchObject({ id: { invalid: "passing" }, name: { missing: "failing" } });
  });
});
