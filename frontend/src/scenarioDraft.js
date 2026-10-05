// Turns a review-only AI scenario idea into a user-confirmed, runnable check.
//
// A draft is plain editable state:
//   { title, rationale, category, expectedStatusCodes: "400, 422",
//     parameters: { "query:limit": { mode: "default" | "omit" | "custom", value } },
//     jsonBody: "<JSON text>", formFields: { name: value } }
// buildEditedScenario() converts a valid draft into a scenario whose request_example the
// existing run flow can execute. Path, header, and auth values still come from the shared
// request details unless the draft omits or overrides them.

export const EDITED_SOURCE = "ai_edited";
export const PARAMETER_MODES = ["default", "omit", "custom"];

const parameterKey = (parameter) => `${parameter.location}:${parameter.name}`;

export function isEditedScenario(scenario) {
  return scenario?.source === EDITED_SOURCE;
}

export function createDraft(scenario, { parameters, bodyFields, sendsJsonBody, isFormBody, initialJsonBody, initialFormFields }) {
  if (isEditedScenario(scenario) && scenario.draft) return structuredClone(scenario.draft);
  return {
    title: scenario.title ?? "",
    rationale: scenario.rationale ?? "",
    category: scenario.category,
    // Left empty on purpose: the user must state the expected outcome.
    expectedStatusCodes: "",
    parameters: Object.fromEntries(parameters.map((parameter) => [parameterKey(parameter), { mode: "default", value: "" }])),
    jsonBody: sendsJsonBody && initialJsonBody != null ? JSON.stringify(initialJsonBody, null, 2) : "",
    formFields: isFormBody
      ? Object.fromEntries(bodyFields.filter((field) => !field.is_file).map((field) => [field.name, initialFormFields?.[field.name] ?? ""]))
      : {},
  };
}

export function parseStatusCodes(text) {
  const tokens = String(text ?? "").split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return { codes: [], error: "Enter at least one expected status code." };
  const codes = [];
  for (const token of tokens) {
    if (!/^\d{3}$/.test(token) || Number(token) < 100 || Number(token) > 599) {
      return { codes: [], error: `"${token}" is not a valid HTTP status code (100–599).` };
    }
    if (!codes.includes(Number(token))) codes.push(Number(token));
  }
  if (codes.length > 10) return { codes: [], error: "Use at most 10 expected status codes." };
  return { codes, error: "" };
}

export function parseJsonBody(text) {
  if (!String(text ?? "").trim()) return { value: null, error: "" };
  try { return { value: JSON.parse(text), error: "" }; }
  catch { return { value: null, error: "Request body must be valid JSON, or empty to send no body." }; }
}

export function validateDraft(draft, { parameters, sendsJsonBody }) {
  const problems = [];
  if (!draft.title.trim()) problems.push("Give the check a title.");
  const status = parseStatusCodes(draft.expectedStatusCodes);
  if (status.error) problems.push(status.error);
  for (const parameter of parameters) {
    const setting = draft.parameters[parameterKey(parameter)];
    if (setting?.mode === "custom" && !setting.value.trim()) problems.push(`Enter a custom value for ${parameter.name} or choose another option.`);
  }
  if (sendsJsonBody) {
    const body = parseJsonBody(draft.jsonBody);
    if (body.error) problems.push(body.error);
  }
  return problems;
}

export function buildEditedScenario(draft, { operation, parameters, sendsJsonBody, isFormBody }) {
  if (validateDraft(draft, { parameters, sendsJsonBody }).length) throw new Error("The draft is incomplete.");
  const omittedParameters = [];
  const parameterValues = {};
  for (const parameter of parameters) {
    const setting = draft.parameters[parameterKey(parameter)];
    if (setting?.mode === "omit") omittedParameters.push({ name: parameter.name, location: parameter.location });
    if (setting?.mode === "custom") parameterValues[parameterKey(parameter)] = setting.value.trim();
  }
  return {
    category: draft.category,
    title: draft.title.trim(),
    rationale: draft.rationale,
    review_required: true,
    source: EDITED_SOURCE,
    draft: structuredClone(draft),
    request_example: {
      method: operation.method,
      path: operation.path,
      query_params: {},
      form_body: isFormBody,
      form_fields: isFormBody ? Object.fromEntries(Object.entries(draft.formFields).filter(([, value]) => value !== "")) : {},
      omitted_parameters: omittedParameters,
      parameter_values: parameterValues,
      json_body: sendsJsonBody ? parseJsonBody(draft.jsonBody).value : null,
      expected_status_codes: parseStatusCodes(draft.expectedStatusCodes).codes,
    },
  };
}

// Status codes the contract-derived checks already expect, offered as one-click hints.
export function statusCodeSuggestions(scenarios = []) {
  const contractCodes = [...new Set(scenarios
    .filter((scenario) => !isEditedScenario(scenario) && scenario.request_example)
    .flatMap((scenario) => scenario.request_example.expected_status_codes ?? []))]
    .sort((a, b) => a - b);
  return [
    { label: "Success", codes: contractCodes.filter((code) => code < 400) },
    { label: "Rejected", codes: contractCodes.filter((code) => code >= 400) },
  ].filter((suggestion) => suggestion.codes.length);
}
