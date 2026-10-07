import { describe, expect, it } from "vitest";
import { duplicatePairKey, findDuplicateScenarios, findSameRequest, scenarioConcept } from "./duplicates.js";

const contract = (title, rationale, extra = {}) => ({ source: "contract", category: "negative", title, rationale, ...extra });
const idea = (title, rationale, category = "negative") => ({ source: "ai", category, title, rationale, request_example: null });
const omitParameter = contract(
  "Omit a required parameter",
  "Send the request without required parameter(s): batch_id; check that the API rejects it with a validation response.",
  { request_example: { omitted_parameters: [{ name: "batch_id", location: "path" }], expected_status_codes: [400, 422, 404] } },
);

describe("findDuplicateScenarios", () => {
  it("flags an AI idea that tests the same missing parameter as a contract check", () => {
    const scenarios = [omitParameter, idea("Call the endpoint without batch_id", "Leave out the required batch_id path parameter and expect a client error.")];

    expect(findDuplicateScenarios(scenarios, { targetNames: ["batch_id"] })).toEqual([
      { keep: 0, drop: 1, reason: { kind: "same-idea", text: "Both test a missing required input (batch_id)." } },
    ]);
  });

  it("keeps ideas that test the same concept on different targets", () => {
    const scenarios = [
      idea("Send an invalid title", "Use a malformed title value.", "invalid_value"),
      idea("Send an invalid description", "Use a malformed description value.", "invalid_value"),
    ];

    expect(findDuplicateScenarios(scenarios, { targetNames: ["title", "description"] })).toEqual([]);
  });

  it("flags an edited check that sends exactly the same request as a contract check", () => {
    const edited = { ...omitParameter, source: "ai_edited", category: "security_minded", title: "Edited copy", rationale: "Different words entirely." };

    expect(findDuplicateScenarios([omitParameter, edited])).toEqual([
      { keep: 0, drop: 1, reason: { kind: "same-request", text: "Both send the same request and expect the same status." } },
    ]);
  });

  it("flags near-identical wording between AI ideas and drops the later one", () => {
    const scenarios = [
      idea("Reject requests with an expired session cookie", "Expired session cookie values must be refused.", "security_minded"),
      idea("Reject an expired session cookie", "Requests carrying an expired session cookie must be refused.", "security_minded"),
    ];

    const [pair] = findDuplicateScenarios(scenarios);
    expect(pair).toMatchObject({ keep: 0, drop: 1, reason: { kind: "similar-wording" } });
  });

  it("does not flag the distinct ideas seen in real Run data", () => {
    const scenarios = [
      contract("Valid request", "Send a request that follows the documented parameters and request schema, then check a documented success response.", { category: "happy_path" }),
      omitParameter,
      { ...idea("Validate that invalid or non-existent batch_id returns appropriate HTTP status and error message", "Ensure the endpoint handles malformed or non-existent batch IDs gracefully without exposing internal system details.", "security_minded"), source: "ai_edited" },
      idea("Test for injection or path traversal attempts via batch_id parameter", "Verify that the endpoint rejects or sanitizes malicious path segments in the batch_id to prevent directory traversal or injection attacks.", "security_minded"),
      idea("Confirm rate limiting or throttling behavior when multiple concurrent requests are made with the same batch_id", "Ensure the system prevents abuse by limiting the number of requests per time window for a given batch_id.", "security_minded"),
    ];

    expect(findDuplicateScenarios(scenarios, { targetNames: ["batch_id"] })).toEqual([]);
  });

  it("flags the overlaps a real Ollama answer produced for Petstore GET /pet/findByStatus", () => {
    const scenarios = [
      contract("Valid request", "Send a request that follows the documented parameters and request schema, then check a documented success response.", { category: "happy_path" }),
      contract("Omit a required parameter", "Send the request without required parameter(s): status; check that the API rejects it with a validation response."),
      contract("Call without authentication", "Omit the documented authentication credentials and verify that protected data or actions are not exposed.", { category: "security_minded" }),
      idea("Validate absence of unauthorized access without Authorization header", "Ensure the endpoint enforces authentication for sensitive operations, even if not explicitly required.", "security_minded"),
      idea("Test with invalid status value (e.g., 'invalid_status')", "Verify the API returns appropriate error response for unrecognized status filters.", "boundary"),
      idea("Test with empty status parameter", "Confirm the API rejects requests lacking required query parameters with a clear validation error."),
    ];

    expect(findDuplicateScenarios(scenarios, { targetNames: ["status", "Authorization"] })).toEqual([
      { keep: 1, drop: 5, reason: { kind: "same-idea", text: "Both test a missing required input (status)." } },
      { keep: 2, drop: 3, reason: { kind: "same-idea", text: "Both test missing or invalid authentication." } },
    ]);
  });

  it("never compares two contract checks and respects ignored pairs", () => {
    const twin = { ...omitParameter };
    const aiCopy = idea("Call the endpoint without batch_id", "Leave out the required batch_id parameter.");

    expect(findDuplicateScenarios([omitParameter, twin])).toEqual([]);
    expect(findDuplicateScenarios([omitParameter, aiCopy], { targetNames: ["batch_id"], ignoredPairs: [duplicatePairKey(omitParameter, aiCopy)] })).toEqual([]);
  });
});

describe("scenarioConcept", () => {
  it.each([
    ["Confirm rate limiting", "rate-limit"],
    ["Test for SQL injection in name", "injection"],
    ["Call without authentication", "auth"],
    ["Omit a required request field", "missing-required"],
    ["Check boundary values for age", "boundary"],
    ["Send an undocumented value for kind", "invalid-value"],
    ["Valid request", null],
  ])("classifies %s", (title, concept) => {
    expect(scenarioConcept({ title, rationale: "" })?.id ?? null).toBe(concept);
  });
});

describe("findSameRequest", () => {
  const valid = { source: "contract", title: "Valid request", request_example: { query_params: {}, form_fields: {}, omitted_parameters: [], json_body: null, expected_status_codes: [200] } };

  it("matches a request that changes nothing, whatever status it expects", () => {
    const edited = { query_params: {}, form_fields: {}, omitted_parameters: [], parameter_values: {}, json_body: null, expected_status_codes: [401] };

    expect(findSameRequest(edited, [valid])?.title).toBe("Valid request");
  });

  it("does not match once a parameter is sent empty, omitted, or overridden", () => {
    const base = { query_params: {}, form_fields: {}, json_body: null, expected_status_codes: [200] };

    expect(findSameRequest({ ...base, parameter_values: { "query:status": "" } }, [valid])).toBeNull();
    expect(findSameRequest({ ...base, omitted_parameters: [{ name: "status", location: "query" }] }, [valid])).toBeNull();
    expect(findSameRequest({ ...base, parameter_values: { "query:status": "sold" } }, [valid])).toBeNull();
  });

  it("skips the scenario being edited", () => {
    expect(findSameRequest(valid.request_example, [valid], 0)).toBeNull();
  });
});
