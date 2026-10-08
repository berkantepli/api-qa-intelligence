import { describe, expect, it } from "vitest";
import { buildCheckRequest, describeOperation, requestReadiness } from "./requestBuilder.js";

const valid = { category: "happy_path", title: "Valid request", request_example: { method: "POST", path: "/pets/{id}", json_body: { name: "Rex", age: 2 }, expected_status_codes: [201] } };
const invalidAge = { category: "invalid_value", title: "Send invalid age", request_example: { method: "POST", path: "/pets/{id}", json_body: { name: "Rex", age: -1 }, expected_status_codes: [422] } };
const operation = {
  method: "POST",
  path: "/pets/{id}",
  request_body_content_type: "application/json",
  request_body_required: true,
  parameters: [
    { name: "limit", location: "query", example: 10 },
    { name: "Authorization", location: "header", credential: true },
    { name: "session", location: "cookie" },
  ],
  request_body_fields: [{ name: "name", required: true }, { name: "age", field_type: "integer" }],
  scenarios: [valid, invalidAge],
};
const described = describeOperation(operation);
const options = { targetUrl: "http://api.test" };

describe("describeOperation", () => {
  it("adds undocumented path parameters as required inputs", () => {
    expect(described.operationParameters.at(-1)).toEqual({ name: "id", location: "path", required: true });
    expect(described.validBodyTemplate).toEqual({ name: "Rex", age: 2 });
  });
});

describe("requestReadiness", () => {
  it("names each missing required input", () => {
    expect(requestReadiness(described, {})).toMatchObject({ ready: false, missing: ["id (path)", "name (body)"] });
    expect(requestReadiness(described, { "parameter:path:id": "p 1", "body:name": " " }).missing).toEqual(["name (body)"]);
    expect(requestReadiness(described, { "parameter:path:id": "p1", "body:name": "Rex" }).ready).toBe(true);
  });
});

describe("buildCheckRequest", () => {
  const inputs = { "parameter:path:id": "p 1", "parameter:header:Authorization": "Bearer t", "parameter:cookie:session": "a b", "body:name": "Max", "body:age": "3" };

  it("fills path, query, header, cookie, and valid body fields from the inputs", () => {
    expect(buildCheckRequest(described, inputs, valid, options)).toEqual({
      method: "POST",
      path: "/pets/p%201",
      query_params: { limit: "10" },
      headers: { Authorization: "Bearer t", Cookie: "session=a%20b" },
      form_body: undefined,
      form_fields: {},
      file_uploads: {},
      json_body: { name: "Max", age: 3 },
      expected_status_codes: [201],
      response_schemas: {},
      base_url: "http://api.test",
    });
  });

  it("keeps a scenario's deliberate test value instead of the input", () => {
    expect(buildCheckRequest(described, inputs, invalidAge, options).json_body).toEqual({ name: "Max", age: -1 });
  });

  it("omits parameters and sends explicit overrides, including empty values", () => {
    const edited = {
      source: "ai_edited",
      request_example: {
        method: "POST",
        path: "/pets/{id}",
        omitted_parameters: [{ name: "Authorization", location: "header" }],
        parameter_values: { "query:limit": "" },
        json_body: { name: 1 },
        expected_status_codes: [400],
      },
    };
    const request = buildCheckRequest(described, inputs, edited, options);

    expect(request.headers).toEqual({ Cookie: "session=a%20b" });
    expect(request.query_params).toEqual({ limit: "" });
    expect(request.json_body).toEqual({ name: 1 });
  });
});
