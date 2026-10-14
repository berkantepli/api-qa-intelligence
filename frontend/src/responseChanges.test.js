import { describe, expect, it } from "vitest";
import { bodyShape, changeText, latestChangesByEndpoint, responseChanges, responseSchema, shapeChanges } from "./responseChanges.js";

const diff = (before, after, schema = null) => shapeChanges(bodyShape(before, schema), bodyShape(after, schema)).map(changeText);

describe("shape changes", () => {
  it("reports removed, new, and retyped fields, but not changed values", () => {
    expect(diff(
      { id: 7, name: "Rex", status: "available", tags: [{ id: 1, name: "dog" }], updatedAt: "2026-10-12" },
      { id: "7", name: "Max", status: null, updatedAt: "2026-10-13", owner: { id: 3 } },
    )).toEqual([
      "$.id changed from number to string",
      "$.status changed from string to null",
      "$.tags is gone (was array)",
      "$.owner is new (object)",
    ]);
  });

  it("reports a list that became empty once, without listing its item fields", () => {
    expect(diff({ items: [{ id: 1 }, { id: 2 }] }, { items: [] })).toEqual(["$.items is now an empty list"]);
  });

  it("does not call the items of a list that was empty before new", () => {
    expect(diff({ items: [] }, { items: [{ id: 1 }] })).toEqual([]);
  });

  it("merges list items, so a field missing from some items is not a change", () => {
    expect(diff([{ id: 1, tag: "a" }, { id: 2 }], [{ id: 3 }, { id: 4, tag: "b" }])).toEqual([]);
    expect(diff([{ id: 1 }], [{ id: 1 }, { id: null }])).toEqual(["$[*].id changed from number to null or number"]);
  });

  it("compares only the values of a map-like object documented with additionalProperties", () => {
    const schema = { type: "object", additionalProperties: { type: "integer" } };
    expect(diff({ available: 3, sold: 5 }, { pending: 1, available: 2 }, schema)).toEqual([]);
    expect(diff({ available: 3 }, { available: "3" }, schema)).toEqual(["$.* changed from number to string"]);
    expect(diff({ available: 3 }, { pending: 1 })).toEqual(["$.available is gone (was number)", "$.pending is new (number)"]);
  });

  it("does not list the fields of an object that became null", () => {
    expect(diff({ category: { id: 1, name: "Dogs" } }, { category: null })).toEqual(["$.category changed from object to null"]);
  });

  it("quotes keys that are not plain names", () => {
    expect(diff({ "first name": "A" }, {})).toEqual(['$["first name"] is gone (was string)']);
  });
});

describe("response changes in Run history", () => {
  const body = (value) => JSON.stringify(value);
  const check = (result, response, extra = {}) => ({ title: "Valid request", result, response_status: 200, response_body: body(response), ...extra });
  const run = (id, createdAt, results, extra = {}) => ({ id, apiId: "pets", api: "Pets", endpoint: "GET /pets/{id}", createdAt, results, ...extra });

  it("compares with the latest earlier pass of the same check and status code", () => {
    const runs = [
      run(1, "2026-10-10T10:00:00Z", [check("PASS", { id: 1, name: "Rex" })]),
      run(2, "2026-10-11T10:00:00Z", [check("PASS", { id: 1, name: "Rex", tag: "dog" })]),
      run(3, "2026-10-11T12:00:00Z", [check("FAIL", { id: 1 })]),
      run(4, "2026-10-11T13:00:00Z", [check("PASS", { error: "x" }, { response_status: 404 })]),
      run(5, "2026-10-12T10:00:00Z", [check("PASS", { id: 1, name: "Rex" })]),
      run(6, "2026-10-12T11:00:00Z", [check("PASS", { id: 1, name: "Rex", tag: "dog" })], { endpoint: "GET /pets" }),
    ];
    const latest = runs[4];

    expect(responseChanges(runs, latest, latest.results[0])).toEqual({
      previousRunId: 2, previousAt: "2026-10-11T10:00:00Z", changes: [{ kind: "removed", path: "$.tag", from: "string" }],
    });
    expect(responseChanges(runs, runs[0], runs[0].results[0])).toBeNull();
  });

  it("skips bodies that are truncated or not JSON", () => {
    const runs = [
      run(1, "2026-10-10T10:00:00Z", [check("PASS", { id: 1 }, { response_truncated: true })]),
      run(2, "2026-10-11T10:00:00Z", [check("PASS", null, { response_body: "<html>" })]),
      run(3, "2026-10-12T10:00:00Z", [check("PASS", { id: 1 })]),
    ];
    expect(responseChanges(runs, runs[2], runs[2].results[0])).toBeNull();
  });

  it("matches flow steps by flow and step title, and finds their schema through the step template", () => {
    const step = (response) => ({ title: "Read the new pet", method: "GET", path: "/pets/9", step_path: "/pets/{{petId}}", result: "PASS", response_status: 200, response_body: body(response) });
    const runs = [
      run(1, "2026-10-10T10:00:00Z", [step({ id: 9, name: "Rex" })], { kind: "flow", flowId: "f1", endpoint: "Flow: Pets" }),
      run(2, "2026-10-11T10:00:00Z", [step({ id: 9 })], { kind: "flow", flowId: "f2", endpoint: "Flow: Other" }),
      run(3, "2026-10-12T10:00:00Z", [step({ id: 9 })], { kind: "flow", flowId: "f1", endpoint: "Flow: Pets" }),
    ];
    const overview = { operations: [{ method: "GET", path: "/pets/{id}", response_schemas: { 200: { type: "object" } } }] };

    expect(responseChanges(runs, runs[2], runs[2].results[0]).changes.map(changeText)).toEqual(["$.name is gone (was string)"]);
    expect(responseSchema(overview, runs[2], runs[2].results[0])).toEqual({ type: "object" });
    expect(responseSchema(overview, run(4, "x", []), { response_status: 200 })).toEqual({ type: "object" });
  });
});

describe("latest changes per endpoint", () => {
  const body = (value) => JSON.stringify(value);
  const overview = { operations: [{ method: "GET", path: "/pets/{id}", response_schemas: {} }, { method: "GET", path: "/pets", response_schemas: {} }] };
  const check = (title, response) => ({ title, result: "PASS", response_status: 200, response_body: body(response) });
  const step = (response) => ({ ...check("Read the new pet", response), method: "GET", path: "/pets/9", step_path: "/pets/{{petId}}" });

  it("uses the latest run that called each endpoint, a flow step included", () => {
    const runs = [
      { id: 1, apiId: "pets", endpoint: "GET /pets", createdAt: "2026-10-10T10:00:00Z", results: [check("Valid request", [{ id: 1, tag: "a" }])] },
      { id: 2, apiId: "pets", endpoint: "GET /pets", createdAt: "2026-10-11T10:00:00Z", results: [check("Valid request", [{ id: 1 }])] },
      { id: 3, apiId: "pets", kind: "flow", flowId: "f1", endpoint: "Flow: Pets", createdAt: "2026-10-10T10:00:00Z", results: [step({ id: 9, name: "Rex" })] },
      { id: 4, apiId: "pets", kind: "flow", flowId: "f1", endpoint: "Flow: Pets", createdAt: "2026-10-12T10:00:00Z", results: [step({ id: 9 })] },
    ];

    expect(latestChangesByEndpoint(overview, runs)).toEqual({
      "GET /pets/{id}": ["Read the new pet: $.name is gone (was string)"],
      "GET /pets": ["Valid request: $[*].tag is gone (was string)"],
    });
  });
});
