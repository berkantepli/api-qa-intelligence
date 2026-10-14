import { describe, expect, it } from "vitest";
import { flowCoverage, runsForApi } from "./coverage.js";
import { accessCheckFlow, accessCheckProblem, accessFinding, buildFlowRequest, credentialValue, dataChangingSteps, flowCredentials, flowRunEntry, missingFlowInputs, stepOperation } from "./flows.js";
import { outcomeSummary, summarizeResults } from "./runDetail.js";

const key = { name: "X-Key", location: "header", credential: true };
const queryKey = { name: "api_key", location: "query", credential: true };
const overview = {
  title: "Pets",
  operations: [
    { method: "POST", path: "/owners/{ownerId}/pets", parameters: [key] },
    { method: "GET", path: "/owners/{ownerId}/pets/{petId}", parameters: [key, queryKey] },
    { method: "DELETE", path: "/owners/{ownerId}/pets/{petId}", parameters: [] },
  ],
};
const flow = {
  id: "lifecycle:/owners/{ownerId}/pets",
  title: "Pet lifecycle",
  missing_inputs: ["ownerId"],
  steps: [
    { title: "Create a pet", role: "create", method: "POST", path: "/owners/{ownerId}/pets", query_params: {}, json_body: { name: "Rex" }, expected_status_codes: [201], extract: [{ variable: "petId", source: "response_body", pointer: "/id" }], always_run: false },
    { title: "Read the new pet", role: "read", method: "GET", path: "/owners/{ownerId}/pets/{{petId}}", query_params: { verbose: "1" }, expected_status_codes: [200], extract: [], always_run: false },
    { title: "Delete the pet (cleanup)", role: "delete", method: "DELETE", path: "/owners/{ownerId}/pets/{{petId}}", query_params: {}, expected_status_codes: [204], extract: [], always_run: true },
  ],
};

describe("flow steps and inputs", () => {
  it("finds the operation behind a step whose path holds a placeholder", () => {
    expect(stepOperation(overview, flow.steps[1])).toBe(overview.operations[1]);
  });

  it("lists each documented credential once, with the endpoints that use it", () => {
    expect(flowCredentials(overview, flow)).toEqual([
      { key: "parameter:header:X-Key", name: "X-Key", location: "header", operationKeys: ["POST /owners/{ownerId}/pets", "GET /owners/{ownerId}/pets/{petId}"] },
      { key: "parameter:query:api_key", name: "api_key", location: "query", operationKeys: ["GET /owners/{ownerId}/pets/{petId}"] },
    ]);
  });

  it("uses a credential typed for any of the flow's endpoints", () => {
    const [header] = flowCredentials(overview, flow);
    expect(credentialValue(header, { "GET /owners/{ownerId}/pets/{petId}": { "parameter:header:X-Key": "secret" } })).toBe("secret");
    expect(credentialValue(header, {})).toBe("");
  });

  it("names the path values that are still empty", () => {
    expect(missingFlowInputs(flow, {})).toEqual(["ownerId"]);
    expect(missingFlowInputs(flow, { ownerId: "  " })).toEqual(["ownerId"]);
    expect(missingFlowInputs(flow, { ownerId: "4" })).toEqual([]);
  });

  it("counts the steps that change data", () => {
    expect(dataChangingSteps(flow).map((step) => step.method)).toEqual(["POST", "DELETE"]);
  });
});

describe("buildFlowRequest", () => {
  const inputs = {
    "POST /owners/{ownerId}/pets": { "parameter:header:X-Key": "secret" },
    "GET /owners/{ownerId}/pets/{petId}": { "parameter:query:api_key": "q-secret" },
  };

  it("fills path values, keeps placeholders, and sends credentials", () => {
    const payload = buildFlowRequest(overview, flow, { targetUrl: "http://127.0.0.1:8000", maxDurationMs: 500, pathValues: { ownerId: "a b" }, inputsByOperation: inputs });

    expect(payload.base_url).toBe("http://127.0.0.1:8000");
    expect(payload.max_duration_ms).toBe(500);
    expect(payload.headers).toEqual({ "X-Key": "secret" });
    expect(payload.steps.map((step) => step.path)).toEqual(["/owners/a%20b/pets", "/owners/a%20b/pets/{{petId}}", "/owners/a%20b/pets/{{petId}}"]);
    // A query credential goes only to the steps whose endpoint documents it.
    expect(payload.steps.map((step) => step.query_params)).toEqual([{}, { verbose: "1", api_key: "q-secret" }, {}]);
    expect(payload.steps[0].extract).toEqual(flow.steps[0].extract);
  });

  it("leaves credentials out when none were typed", () => {
    const payload = buildFlowRequest(overview, flow, { targetUrl: "http://x", pathValues: { ownerId: "4" } });
    expect(payload.headers).toEqual({});
    expect(payload.steps[1].query_params).toEqual({ verbose: "1" });
  });
});

describe("flow runs in Run history", () => {
  const outcome = {
    result: "FAIL",
    steps: [
      { title: "Create a pet", role: "create", status: "PASS", saved_values: { petId: 7 }, check: { result: "PASS", method: "POST", path: "/owners/4/pets", response_status: 201, expected_status_codes: [201] } },
      { title: "Read the new pet", role: "read", status: "FAIL", reason: "Could not save {{x}}: /x in the response body has no value.", check: { result: "PASS", method: "GET", path: "/owners/4/pets/7", response_status: 200, expected_status_codes: [200] } },
      { title: "Delete the pet (cleanup)", role: "delete", status: "SKIPPED", reason: "Skipped because an earlier step did not pass.", check: null },
    ],
  };
  const entry = flowRunEntry(flow, outcome, { apiId: "pets", api: "Pets", target: "http://x", id: 1, createdAt: "2026-10-11T00:00:00Z" });

  it("turns each step into a result with its own outcome", () => {
    expect(entry).toMatchObject({ id: 1, kind: "flow", flowId: flow.id, apiId: "pets", endpoint: "Flow: Pet lifecycle" });
    expect(entry.results.map((result) => result.result)).toEqual(["PASS", "FAIL", "SKIPPED"]);
    expect(entry.results[0].saved_values).toEqual({ petId: 7 });
    expect(entry.results[2]).toMatchObject({ method: "DELETE", role: "delete", expected_status_codes: [204] });
  });

  it("counts skipped steps and explains them", () => {
    expect(summarizeResults(entry.results)).toEqual({ total: 3, passed: 1, failed: 1, errors: 0, skipped: 1 });
    expect(outcomeSummary(entry.results[1])).toBe("Could not save {{x}}: /x in the response body has no value.");
    expect(outcomeSummary(entry.results[2])).toBe("Skipped because an earlier step did not pass.");
  });

  it("keeps flow runs out of the endpoint's own runs", () => {
    const endpointRun = { id: 2, apiId: "pets", api: "Pets", endpoint: "GET /pets", results: [] };
    expect(runsForApi([entry, endpointRun], "pets", [{ id: "pets", title: "Pets" }])).toEqual([endpointRun]);
  });

  it("finds each step's endpoint by its template, not the filled path it sent", () => {
    expect(entry.results[1]).toMatchObject({ path: "/owners/4/pets/7", step_path: "/owners/{ownerId}/pets/{{petId}}" });
    expect(flowCoverage(overview, [flow], [entry]).endpoints).toEqual({
      "POST /owners/{ownerId}/pets": { status: "passing", createdAt: "2026-10-11T00:00:00Z", flowTitle: "Pet lifecycle" },
      "GET /owners/{ownerId}/pets/{petId}": { status: "failing", createdAt: "2026-10-11T00:00:00Z", flowTitle: "Pet lifecycle" },
    });
  });
});

describe("access check", () => {
  const access = accessCheckFlow(flow);
  const firstUser = { "POST /owners/{ownerId}/pets": { "parameter:header:X-Key": "key-a" }, "GET /owners/{ownerId}/pets/{petId}": { "parameter:query:api_key": "query-a" } };
  const secondUser = { "parameter:header:X-Key": "key-b", "parameter:query:api_key": "query-b" };

  it("creates as the first user, tries the record as the second, then checks and cleans up as the first", () => {
    expect(access).toMatchObject({ id: "lifecycle:/owners/{ownerId}/pets:access", title: "Access check: Pet lifecycle" });
    expect(access.steps.map((step) => [step.title, step.actor ?? null, step.expected_status_codes, step.always_run])).toEqual([
      ["Create a pet", null, [201], false],
      ["Read it as the second user", "second", [403, 404], true],
      ["Delete it as the second user", "second", [403, 404], true],
      ["Read it again as the owner", "first", [200], true],
      ["Delete the pet (cleanup)", null, [204], true],
    ]);
  });

  it("tries only the steps whose endpoint documents a credential", () => {
    // The DELETE endpoint documents no credential here, so it is public: not tried as the second user.
    expect(accessCheckFlow(flow, overview).steps.map((step) => step.title)).toEqual([
      "Create a pet", "Read it as the second user", "Read it again as the owner", "Delete the pet (cleanup)",
    ]);
    const publicRead = { ...overview, operations: overview.operations.map((operation) => ({ ...operation, parameters: [] })) };
    expect(accessCheckFlow(flow, publicRead)).toBeNull();
  });

  it("is not offered for a flow whose steps never use the created record", () => {
    expect(accessCheckFlow({ ...flow, steps: [flow.steps[0]] })).toBeNull();
  });

  it("sends the second user's credentials only on the second user's steps", () => {
    const request = buildFlowRequest(overview, access, { targetUrl: "http://x", pathValues: { ownerId: "4" }, inputsByOperation: firstUser, secondUser });

    expect(request.headers).toEqual({ "X-Key": "key-a" });
    expect(request.steps.map((step) => [step.headers["X-Key"] ?? null, step.query_params.api_key ?? null])).toEqual([
      [null, null], ["key-b", "query-b"], ["key-b", null], [null, "query-a"], [null, null],
    ]);
    expect(request.steps.every((step) => !("actor" in step))).toBe(true);
    expect(request.secret_names).toEqual(["X-Key", "api_key"]);
  });

  it("says what is missing before it can run", () => {
    expect(accessCheckProblem(overview, access, {}, secondUser)).toBe("Enter the first user's credentials under Target & auth first.");
    expect(accessCheckProblem(overview, access, firstUser, { "parameter:header:X-Key": "key-b" })).toBe("Enter the second user's api_key.");
    expect(accessCheckProblem(overview, access, firstUser, secondUser)).toBeNull();
    expect(accessCheckProblem({ operations: [] }, access, firstUser, secondUser)).toMatch(/no credentials/);
  });

  it("explains each second-user step: refused, allowed, or inconclusive", () => {
    const step = (role, status) => ({ actor: "second", role, result: "FAIL", response_status: status });
    expect(accessFinding(step("read", 404))).toEqual({ tone: "pass", text: "The second user could not read the record (HTTP 404)." });
    expect(accessFinding(step("delete", 204))).toEqual({ tone: "fail", text: "The second user could delete the first user's record (HTTP 204)." });
    expect(accessFinding(step("read", 401)).tone).toBe("unknown");
    expect(accessFinding({ ...step("read", 200), actor: "first" })).toBeNull();
    expect(accessFinding({ ...step("read", null), result: "SKIPPED" })).toBeNull();
  });

  it("keeps who sent each step in Run history", () => {
    const outcome = { result: "FAIL", steps: access.steps.map((step) => ({ title: step.title, role: step.role, status: "PASS", check: { result: "PASS", response_status: 200 } })) };
    expect(flowRunEntry(access, outcome, { apiId: "pets", api: "Pets", target: "http://x" }).results.map((result) => result.actor)).toEqual([null, "second", "second", "first", null]);
  });
});
