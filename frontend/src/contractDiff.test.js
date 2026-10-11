import { describe, expect, it } from "vitest";
import { diffOverviews, operationChanges, pendingChange, reimportedApi } from "./contractDiff.js";

const getPet = {
  method: "GET", path: "/pets/{id}",
  parameters: [{ name: "id", location: "path", required: true, field_type: "integer", value_schema: { type: "integer" } }],
  response_codes: ["200", "404"], response_schemas: { 200: { type: "object", required: ["id"] } },
  scenarios: [{ title: "Valid request", category: "happy_path", source: "contract" }],
};
const createPet = {
  method: "POST", path: "/pets", request_body_content_type: "application/json", request_body_required: true,
  request_body_fields: [{ name: "name", required: true, field_type: "string", value_schema: { type: "string", maxLength: 50 } }],
  response_codes: ["201"], scenarios: [],
};
const v1 = { version: "1.0", operations: [getPet, createPet, { method: "DELETE", path: "/pets/{id}", response_codes: ["204"], scenarios: [] }] };
const v2 = {
  version: "1.1",
  operations: [
    { ...getPet, response_codes: ["200"], response_schemas: { 200: { type: "object", required: ["id", "name"] } },
      parameters: [...getPet.parameters, { name: "fields", location: "query", required: false, field_type: "string", value_schema: { type: "string" } }] },
    { ...createPet, request_body_fields: [
      { name: "name", required: true, field_type: "string", value_schema: { type: "string", maxLength: 30 } },
      { name: "tag", required: true, field_type: "string", value_schema: { type: "string", enum: ["dog", "cat"] } },
    ] },
    { method: "GET", path: "/pets", response_codes: ["200"], scenarios: [] },
  ],
};

describe("operationChanges", () => {
  it("describes parameter, body, and response changes as sentences", () => {
    expect(operationChanges(getPet, v2.operations[0])).toEqual([
      "New parameter fields (query)",
      "Response 404 was removed",
      "Response 200 body schema changed",
    ]);
    expect(operationChanges(createPet, v2.operations[1])).toEqual([
      "body field name maxLength changed from 50 to 30",
      "New required body field tag",
    ]);
  });

  it("notices required, credential, and request body changes", () => {
    const before = { parameters: [{ name: "key", location: "header", required: false }], request_body_content_type: null };
    const after = { parameters: [{ name: "key", location: "header", required: true, credential: true }], request_body_content_type: "application/json", request_body_required: true };

    expect(operationChanges(before, after)).toEqual([
      "parameter key (header) is now required",
      "parameter key (header) is now a credential",
      "New request body (application/json)",
      "Request body is now required",
    ]);
  });
});

describe("diffOverviews", () => {
  it("lists new, removed, and changed endpoints", () => {
    expect(diffOverviews(v1, v2, "2026-10-11T12:00:00.000Z")).toMatchObject({
      comparedAt: "2026-10-11T12:00:00.000Z", fromVersion: "1.0", toVersion: "1.1",
      added: ["GET /pets"], removed: ["DELETE /pets/{id}"],
      changed: [{ key: "GET /pets/{id}" }, { key: "POST /pets" }],
    });
  });

  it("is null when nothing changed", () => {
    expect(diffOverviews(v1, structuredClone(v1))).toBeNull();
  });
});

describe("pendingChange", () => {
  const changes = diffOverviews(v1, v2, "2026-10-11T12:00:00.000Z");

  it("applies to new and changed endpoints until they run again", () => {
    expect(pendingChange(changes, "GET /pets")).toEqual({ type: "added", changes: [] });
    expect(pendingChange(changes, "POST /pets", "2026-10-11T11:00:00Z").type).toBe("changed");
    expect(pendingChange(changes, "POST /pets", "2026-10-11T12:30:00Z")).toBeNull();
    expect(pendingChange(null, "GET /pets")).toBeNull();
  });
});

describe("reimportedApi", () => {
  const edited = { title: "Unknown id returns 404", category: "negative", source: "ai_edited" };
  const idea = { title: "Idea", category: "negative", source: "ai" };
  const existing = {
    id: "pets", targetUrl: "https://staging.example.com", maxDurationMs: 800,
    overview: { ...v1, operations: [{ ...getPet, scenarios: [...getPet.scenarios, edited] }, createPet, { ...v1.operations[2], scenarios: [idea] }] },
  };
  const imported = { id: "pets", importedAt: "2026-10-11T12:00:00.000Z", targetUrl: "https://api.example.com", overview: v2 };

  it("keeps the user's checks on endpoints that still exist, and the target and time limit", () => {
    const api = reimportedApi(existing, imported);

    expect(api.overview.operations[0].scenarios.map((scenario) => scenario.title)).toEqual(["Valid request", "Unknown id returns 404"]);
    expect([api.targetUrl, api.maxDurationMs]).toEqual(["https://staging.example.com", 800]);
    expect(api.contractChanges).toMatchObject({ added: ["GET /pets"], removed: ["DELETE /pets/{id}"], droppedChecks: 1 });
  });

  it("keeps the previous comparison when the contract did not change", () => {
    const api = reimportedApi({ ...existing, contractChanges: { comparedAt: "earlier" } }, { ...imported, overview: existing.overview });
    expect(api.contractChanges).toEqual({ comparedAt: "earlier" });
  });
});
