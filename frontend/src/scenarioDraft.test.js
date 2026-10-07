import { describe, expect, it } from "vitest";
import {
  buildEditedScenario,
  createDraft,
  isEditedScenario,
  parseStatusCodes,
  validateDraftFields,
  statusCodeSuggestions,
  validateDraft,
} from "./scenarioDraft.js";

const operation = { method: "POST", path: "/pets/{id}" };
const parameters = [
  { name: "id", location: "path", required: true },
  { name: "limit", location: "query", required: false },
  { name: "Authorization", location: "header", required: true },
];
const idea = { category: "negative", title: "Reject a negative age", rationale: "Ages cannot be negative.", source: "ai", request_example: null };
const jsonContext = { operation, parameters, bodyFields: [], sendsJsonBody: true, isFormBody: false };

function readyDraft(overrides = {}) {
  return { ...createDraft(idea, { ...jsonContext, initialJsonBody: { name: "Rex", age: 2 } }), expectedStatusCodes: "422", ...overrides };
}

describe("createDraft", () => {
  it("starts from the idea without an expected result", () => {
    const draft = createDraft(idea, { ...jsonContext, initialJsonBody: { name: "Rex" } });

    expect(draft.title).toBe("Reject a negative age");
    expect(draft.expectedStatusCodes).toBe("");
    expect(JSON.parse(draft.jsonBody)).toEqual({ name: "Rex" });
    expect(draft.parameters["path:id"]).toEqual({ mode: "default", value: "" });
  });

  it("prefills non-file form fields for form bodies", () => {
    const draft = createDraft(idea, {
      ...jsonContext,
      sendsJsonBody: false,
      isFormBody: true,
      bodyFields: [{ name: "note" }, { name: "file", is_file: true }],
      initialFormFields: { note: "hi" },
    });

    expect(draft.formFields).toEqual({ note: "hi" });
    expect(draft.jsonBody).toBe("");
  });

  it("reopens a saved check with its own draft", () => {
    const saved = buildEditedScenario(readyDraft({ title: "Edited" }), jsonContext);

    expect(createDraft(saved, jsonContext).title).toBe("Edited");
  });
});

describe("parseStatusCodes", () => {
  it.each([
    ["422", [422]],
    ["400, 422 400", [400, 422]],
  ])("parses %s", (text, codes) => {
    expect(parseStatusCodes(text)).toEqual({ codes, error: "" });
  });

  it.each(["", "  ", "abc", "99", "600", "4000", "1,2"])("rejects %j", (text) => {
    expect(parseStatusCodes(text).error).not.toBe("");
  });
});

describe("validateDraft", () => {
  it("blocks drafts until the expected result is stated", () => {
    const draft = createDraft(idea, { ...jsonContext, initialJsonBody: {} });

    expect(validateDraft(draft, jsonContext)).toEqual(["Enter at least one expected status code."]);
    expect(() => buildEditedScenario(draft, jsonContext)).toThrow();
  });

  it("requires a title, custom parameter values, and valid JSON", () => {
    const draft = readyDraft({
      title: " ",
      jsonBody: "{broken",
      parameters: { ...readyDraft().parameters, "query:limit": { mode: "custom", value: "" } },
    });

    expect(validateDraft(draft, jsonContext)).toHaveLength(3);
  });

  it("accepts an empty body as an intentional request without a body", () => {
    expect(validateDraft(readyDraft({ jsonBody: "" }), jsonContext)).toEqual([]);
  });
});

describe("buildEditedScenario", () => {
  it("creates a runnable check from a complete draft", () => {
    const draft = readyDraft({
      expectedStatusCodes: "400, 422",
      jsonBody: '{"name": "Rex", "age": -1}',
      parameters: {
        "path:id": { mode: "default", value: "" },
        "query:limit": { mode: "custom", value: " 0 " },
        "header:Authorization": { mode: "omit", value: "" },
      },
    });

    const scenario = buildEditedScenario(draft, jsonContext);

    expect(isEditedScenario(scenario)).toBe(true);
    expect(scenario.review_required).toBe(true);
    expect(scenario.request_example).toEqual({
      method: "POST",
      path: "/pets/{id}",
      query_params: {},
      form_body: false,
      form_fields: {},
      omitted_parameters: [{ name: "Authorization", location: "header" }],
      parameter_values: { "query:limit": "0" },
      json_body: { name: "Rex", age: -1 },
      expected_status_codes: [400, 422],
    });
  });

  it("drops empty form fields and never sends a JSON body for forms", () => {
    const formContext = { ...jsonContext, sendsJsonBody: false, isFormBody: true };
    const draft = { ...readyDraft(), jsonBody: "{}", formFields: { note: "", tag: "x" } };

    const example = buildEditedScenario(draft, formContext).request_example;

    expect(example.form_fields).toEqual({ tag: "x" });
    expect(example.json_body).toBeNull();
    expect(example.form_body).toBe(true);
  });
});

describe("statusCodeSuggestions", () => {
  it("groups contract-derived codes and ignores ideas and edited checks", () => {
    const scenarios = [
      { category: "happy_path", request_example: { expected_status_codes: [201] } },
      { category: "negative", request_example: { expected_status_codes: [422, 400] } },
      { category: "boundary", request_example: { expected_status_codes: [201] } },
      { category: "negative", source: "ai", request_example: null },
      { category: "negative", source: "ai_edited", request_example: { expected_status_codes: [418] } },
    ];

    expect(statusCodeSuggestions(scenarios)).toEqual([
      { label: "Success", codes: [201] },
      { label: "Rejected", codes: [400, 422] },
    ]);
  });
});

describe("validateDraftFields", () => {
  it("keys each problem by the input it belongs to", () => {
    const draft = readyDraft({
      title: "",
      expectedStatusCodes: "",
      jsonBody: "{broken",
      parameters: { ...readyDraft().parameters, "query:limit": { mode: "custom", value: " " } },
    });

    expect(Object.keys(validateDraftFields(draft, jsonContext)).sort()).toEqual(["body", "expected", "query:limit", "title"]);
    expect(validateDraftFields(readyDraft(), jsonContext)).toEqual({});
  });
});
