import { describe, expect, it } from "vitest";
import { reimportedApi } from "./contractDiff.js";
import { computeCoverage, flowCoverage, flowRunsForApi } from "./coverage.js";
import { draftHasSensitiveBody, draftToFlow, effectiveFlows, flowToDraft, moveStep, newFlowDraft, validateFlowDraft, withoutFlowChanges, withSavedFlow } from "./flowEditor.js";

const schema = { type: "object" };
const overview = {
  title: "Pets",
  version: "1.0",
  operations: [
    { method: "POST", path: "/pets", parameters: [], scenarios: [], response_schemas: { 201: schema } },
    { method: "GET", path: "/pets/{petId}", parameters: [], scenarios: [], response_schemas: { 200: schema } },
    { method: "DELETE", path: "/pets/{petId}", parameters: [], scenarios: [] },
  ],
};
const suggested = {
  id: "lifecycle:/pets",
  title: "Pet lifecycle",
  resource: "/pets",
  source: "inferred",
  rationale: "Creates a pet.",
  missing_inputs: [],
  notes: [],
  steps: [
    { title: "Create a pet", role: "create", method: "POST", path: "/pets", query_params: {}, headers: {}, json_body: { name: "Rex" }, expected_status_codes: [201], response_schemas: { 201: schema }, extract: [{ variable: "petId", source: "response_body", pointer: "/id", fallback: null }], always_run: false },
    { title: "Read the new pet", role: "read", method: "GET", path: "/pets/{{petId}}", query_params: { verbose: "1" }, headers: {}, json_body: null, expected_status_codes: [200], response_schemas: { 200: schema }, extract: [], always_run: false },
  ],
};
const api = { id: "pets", title: "Pets", overview: { ...overview, flows: [suggested] } };

describe("saved flows", () => {
  it("shows suggestions with edits applied, then flows the user built", () => {
    const edited = { ...suggested, title: "Pet lifecycle (edited)", edited: true };
    const custom = { ...suggested, id: "custom:1", title: "Mine", source: "custom" };
    const saved = withSavedFlow(withSavedFlow(api, edited), custom);

    expect(effectiveFlows(saved).map((flow) => flow.title)).toEqual(["Pet lifecycle (edited)", "Mine"]);
    expect(effectiveFlows(withoutFlowChanges(saved, suggested.id)).map((flow) => flow.title)).toEqual(["Pet lifecycle", "Mine"]);
    expect(effectiveFlows(withoutFlowChanges(saved, "custom:1")).map((flow) => flow.title)).toEqual(["Pet lifecycle (edited)"]);
  });

  it("keeps edits and custom flows when the contract is imported again", () => {
    const saved = withSavedFlow(api, { ...suggested, id: "custom:1", source: "custom" });
    const imported = { id: "pets", title: "Pets", importedAt: "2026-10-12T00:00:00Z", overview: { ...overview, flows: [] } };

    expect(reimportedApi(saved, imported).customFlows).toEqual(saved.customFlows);
  });
});

describe("flow drafts", () => {
  it("round-trips a flow through the editor", () => {
    const flow = draftToFlow(flowToDraft(suggested), overview, suggested);

    expect(flow.steps).toEqual(suggested.steps.map((step) => ({ ...step, extract: step.extract.map(({ fallback, ...rule }) => (fallback ? { ...rule, fallback } : rule)) })));
    expect(flow).toMatchObject({ id: suggested.id, source: "inferred", edited: true, missing_inputs: [] });
  });

  it("reports what keeps a draft from being saved", () => {
    const draft = flowToDraft(suggested);
    draft.title = " ";
    draft.steps[0] = { ...draft.steps[0], path: "pets?x=1", codesText: "20, 700", bodyText: "{oops", queryText: "novalue", extract: [{ variable: "1bad", source: "response_body", pointer: "/id" }] };
    draft.steps[1] = { ...draft.steps[1], path: "/pets/{{petId}}/{{ownerId}}" };

    expect(validateFlowDraft(draft)).toEqual({
      title: "Give the flow a name.",
      "steps.0.path": "Use an absolute path such as /pets/{{petId}}, without a query string.",
      "steps.0.queryText": "Write one name=value pair per line.",
      "steps.0.bodyText": "Enter valid JSON, or leave it empty to send no body.",
      "steps.0.codesText": "Enter one to ten status codes from 100 to 599, such as 200, 201.",
      "steps.0.extract.0": "A saved value needs a name of letters, digits, and _ that does not start with a digit.",
      "steps.1.placeholders": "Uses {{petId}}, {{ownerId}}, which no earlier step saves.",
    });
    expect(validateFlowDraft(flowToDraft(suggested))).toEqual({});
  });

  it("does not save credential-like body fields and lists unfilled path parameters", () => {
    const draft = newFlowDraft("custom:7");
    draft.title = "Owner pets";
    draft.steps[0] = { ...draft.steps[0], path: "/owners/{ownerId}/pets", bodyText: '{"name": "Rex", "password": "secret"}' };

    expect(draftHasSensitiveBody(draft)).toBe(true);
    const flow = draftToFlow(draft, overview);
    expect(flow.steps[0].json_body).toEqual({ name: "Rex" });
    expect(flow).toMatchObject({ source: "custom", edited: false, missing_inputs: ["ownerId"], rationale: "A flow you built." });
  });

  it("checks a step against the schemas of the endpoint it now calls", () => {
    const draft = flowToDraft(suggested);
    draft.steps[1] = { ...draft.steps[1], method: "POST", path: "/pets" };
    expect(draftToFlow(draft, overview, suggested).steps[1].response_schemas).toEqual({ 201: schema });
  });

  it("moves steps within bounds", () => {
    expect(moveStep(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveStep(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("lifecycle coverage", () => {
  const savedApis = [{ id: "pets", title: "Pets" }];
  const flowRun = (results, createdAt = "2026-10-12T00:00:00Z") => ({ id: createdAt, kind: "flow", flowId: suggested.id, apiId: "pets", api: "Pets", createdAt, results });

  it("flags the create endpoint of a flow that never ran", () => {
    const lifecycle = flowCoverage(overview, [suggested], []);
    const post = computeCoverage(overview, [], Date.now(), null, lifecycle).endpoints.find((endpoint) => endpoint.key === "POST /pets");

    expect(lifecycle.flows[0]).toMatchObject({ status: "untested", createKeys: ["POST /pets"] });
    expect(post.risks.map((risk) => risk.id)).toContain("lifecycle");
    expect(post.risk.factors.map((factor) => factor.label)).toContain("Lifecycle not tested");
  });

  it("counts a flow by its latest run; a skipped step counts as failing", () => {
    const runs = flowRunsForApi([
      flowRun([{ result: "PASS" }, { result: "SKIPPED" }], "2026-10-12T00:00:00Z"),
      flowRun([{ result: "PASS" }, { result: "PASS" }], "2026-10-11T00:00:00Z"),
      { id: 3, apiId: "pets", api: "Pets", endpoint: "GET /pets", results: [] },
    ], "pets", savedApis);
    const lifecycle = flowCoverage(overview, [suggested], runs);

    expect(runs).toHaveLength(2);
    expect(lifecycle.totals).toEqual({ flows: 1, passing: 0, failing: 1, untested: 0 });
    const post = computeCoverage(overview, [], Date.now(), null, lifecycle).endpoints.find((endpoint) => endpoint.key === "POST /pets");
    expect(post.risks.map((risk) => risk.id)).not.toContain("lifecycle");
  });
});
