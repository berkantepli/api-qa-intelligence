import { describe, expect, it } from "vitest";
import { compareRequests, mergeInputs, suggestedInputs } from "./requestImport.js";

const operations = [
  { method: "GET", path: "/pet/{petId}", parameters: [{ name: "petId", location: "path", required: true }, { name: "verbose", location: "query" }, { name: "X-Key", location: "header", credential: true }], scenarios: [] },
  { method: "GET", path: "/pet/findByStatus", parameters: [{ name: "status", location: "query", required: true }], scenarios: [] },
  { method: "POST", path: "/pet", parameters: [], request_body_content_type: "application/json", request_body_required: true, request_body_fields: [{ name: "name", required: true, field_type: "string" }, { name: "tags", field_type: "array" }], scenarios: [] },
  { method: "DELETE", path: "/pet/{petId}", parameters: [{ name: "petId", location: "path", required: true }], scenarios: [] },
];
const collection = {
  requests: [
    { method: "GET", path: "/v3/pet/10", query: { verbose: "true", extra: "1" } },
    { method: "GET", path: "/v3/pet/findByStatus", query: { status: "sold" } },
    { method: "POST", path: "/v3/pet", query: {}, json_body: { name: "doggie", tags: [{ name: "a" }], id: 10 } },
    { method: "GET", path: "/v3/pet/{petId}", query: {} },
    { method: "GET", path: "/v3/health", query: {} },
  ],
};

describe("comparing requests with the contract", () => {
  it("matches requests to endpoints and lists what is left on each side", () => {
    const result = compareRequests({ operations }, collection);

    expect(result.matched.map((item) => [`${item.operation.method} ${item.operation.path}`, item.requests.length])).toEqual([
      ["GET /pet/{petId}", 2],
      ["GET /pet/findByStatus", 1],
      ["POST /pet", 1],
    ]);
    expect(result.unmatched.map((request) => request.path)).toEqual(["/v3/health"]);
    expect(result.uncovered.map((operation) => `${operation.method} ${operation.path}`)).toEqual(["DELETE /pet/{petId}"]);
    expect(result.total).toBe(4);
  });
});

describe("request details from requests", () => {
  it("takes path, query, and body values and never fills credentials", () => {
    const [byId] = compareRequests({ operations }, collection).matched;
    // The second request has an unresolved {petId}; the first value wins anyway.
    expect(suggestedInputs(byId.operation, byId.requests)).toEqual({ "parameter:path:petId": "10", "parameter:query:verbose": "true" });
    expect(suggestedInputs(operations[2], [collection.requests[2]])).toEqual({ "body:name": "doggie", "body:tags": '[{"name":"a"}]' });
  });

  it("fills only empty details unless asked to replace them", () => {
    const current = { "parameter:path:petId": "7", "parameter:query:verbose": " " };
    const suggested = { "parameter:path:petId": "10", "parameter:query:verbose": "true" };

    expect(mergeInputs(current, suggested)).toEqual({ inputs: { "parameter:path:petId": "7", "parameter:query:verbose": "true" }, filled: 1 });
    expect(mergeInputs(current, suggested, true)).toEqual({ inputs: suggested, filled: 2 });
  });
});
