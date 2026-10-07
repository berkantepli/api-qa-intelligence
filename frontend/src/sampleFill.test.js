import { describe, expect, it } from "vitest";
import { applySampleValues, collectEmptyFields, fillHint, toInputValue } from "./sampleFill.js";

describe("collectEmptyFields", () => {
  it("collects only empty inputs, including files without a chosen file", () => {
    const fields = collectEmptyFields({
      parameters: [
        { name: "orderId", location: "path", required: true, value_schema: { type: "integer" } },
        { name: "limit", location: "query" },
      ],
      bodyFields: [
        { name: "quantity", example: 7 },
        { name: "shipDate", value_schema: { type: "string", format: "date-time" } },
        { name: "upload", is_file: true },
        { name: "photo", is_file: true },
      ],
      parameterValue: (parameter) => (parameter.name === "limit" ? "5" : ""),
      bodyFieldValue: (field) => (field.example == null ? "" : String(field.example)),
      fileCount: (field) => (field.name === "photo" ? 1 : 0),
    });

    expect(fields.map((field) => field.key)).toEqual(["parameter:path:orderId", "body:shipDate", "body:upload"]);
    expect(fields[0]).toMatchObject({ location: "path", required: true, value_schema: { type: "integer" } });
    expect(fields[2]).toMatchObject({ location: "body", is_file: true });
  });
});

describe("applySampleValues", () => {
  it("turns AI values into inputs and markers with a summary", () => {
    const result = applySampleValues({
      source: "ai",
      values: { "body:shipDate": "2026-05-04T10:30:00Z", "body:category": { id: 1, name: "Dogs" }, "body:complete": false },
      unfilled: [
        { key: "parameter:path:orderId", reason: "Needs a real ID or value from your test environment." },
        { key: "parameter:header:Authorization", reason: "Credentials are never generated; enter your own test credential." },
      ],
    }, [{ key: "parameter:path:orderId", required: true }, { key: "parameter:header:Authorization", required: false }]);

    expect(result.inputs).toEqual({ "body:shipDate": "2026-05-04T10:30:00Z", "body:category": "{\"id\":1,\"name\":\"Dogs\"}", "body:complete": "false" });
    expect(result.marks["body:shipDate"]).toEqual({ kind: "ai" });
    expect(result.marks["parameter:path:orderId"].kind).toBe("needs-user");
    expect(result.marks["parameter:header:Authorization"]).toBeUndefined();
    expect(result.summary).toBe("AI filled 3 fields · 1 field needs your input");
    expect(applySampleValues({ source: "ai", values: {}, unfilled: [{ key: "k", reason: "r" }] }, [{ key: "k", required: true }]).summary)
      .toBe("1 field needs your input");
  });

  it("labels schema fallbacks", () => {
    const result = applySampleValues({ source: "schema", values: { "body:complete": true }, unfilled: [] });

    expect(result.marks["body:complete"]).toEqual({ kind: "schema" });
    expect(result.summary).toBe("AI unavailable · filled 1 with schema samples");
  });
});

describe("hints and values", () => {
  it("describes each marker", () => {
    expect(fillHint(undefined)).toBeNull();
    expect(fillHint({ kind: "ai" }).tone).toBe("ai");
    expect(fillHint({ kind: "schema" }).tone).toBe("schema");
    expect(fillHint({ kind: "needs-user", reason: "Choose a file to upload." }).text).toBe("Fill this in yourself: Choose a file to upload.");
  });

  it("stringifies values for inputs", () => {
    expect(toInputValue(["a"])).toBe("[\"a\"]");
    expect(toInputValue(3)).toBe("3");
    expect(toInputValue(true)).toBe("true");
  });
});
