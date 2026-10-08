import { describe, expect, it } from "vitest";
import { persistableInputs, planBulkRun } from "./bulkRun.js";

const valid = { category: "happy_path", title: "Valid request", request_example: { method: "GET" } };
const negative = { category: "negative", title: "Omit a required parameter", request_example: { method: "GET" } };
const idea = { category: "boundary", title: "Idea", source: "ai", request_example: null };
const overview = {
  operations: [
    { method: "GET", path: "/pets", parameters: [{ name: "limit", location: "query", example: 5 }], scenarios: [valid, negative, idea] },
    { method: "GET", path: "/pets/{id}", parameters: [{ name: "id", location: "path", required: true }, { name: "api_key", location: "header", credential: true }], scenarios: [valid] },
    { method: "DELETE", path: "/pets/{id}", parameters: [], scenarios: [valid] },
    { method: "GET", path: "/health", parameters: [], scenarios: [idea] },
  ],
};
const endpoints = overview.operations.map((operation, operationIndex) => ({ key: `${operation.method} ${operation.path}`, operationIndex }));

describe("planBulkRun", () => {
  it("groups endpoints into ready, needs input, data-changing, and no checks", () => {
    const plan = planBulkRun(overview, endpoints);

    expect(plan.ready.map((item) => [item.key, item.checks.length])).toEqual([["GET /pets", 2]]);
    expect(plan.needsInput).toEqual([expect.objectContaining({ key: "GET /pets/{id}", missing: ["id (path)"] })]);
    expect(plan.dataChanging.map((item) => item.key)).toEqual(["DELETE /pets/{id}"]);
    expect(plan.noChecks.map((item) => item.key)).toEqual(["GET /health"]);
    expect(plan.checkCount).toBe(2);
  });

  it("uses saved request details and can run only the valid request", () => {
    const plan = planBulkRun(overview, endpoints, { inputsByOperation: { "GET /pets/{id}": { "parameter:path:id": "7" } }, mode: "smoke" });

    expect(plan.ready.map((item) => [item.key, item.checks.map((check) => check.title)])).toEqual([
      ["GET /pets", ["Valid request"]],
      ["GET /pets/{id}", ["Valid request"]],
    ]);
  });
});

describe("persistableInputs", () => {
  it("keeps request details but never credentials", () => {
    const inputs = {
      "GET /pets/{id}": { "parameter:path:id": "7", "parameter:header:api_key": "secret" },
      "GET /gone": { "parameter:query:q": "x" },
    };

    expect(persistableInputs(overview, inputs)).toEqual({ "GET /pets/{id}": { "parameter:path:id": "7" } });
  });
});
