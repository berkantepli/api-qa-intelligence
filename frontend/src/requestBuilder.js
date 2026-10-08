// Turns an operation, the user's request inputs, and one scenario into the payload for
// POST /api/v1/runs/execute. The overview's "Run selected" and the Coverage page's bulk run
// both use it, so a check sends the same request wherever it is started.
//
// Request inputs are a flat map per endpoint:
//   { "parameter:<location>:<name>": "value", "body:<field>": "value", "body:__raw": "<JSON text>" }
import { isEditedScenario } from "./scenarioDraft.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const FORM_BODY = /^(multipart\/form-data|application\/x-www-form-urlencoded)/i;

export function isValidJson(value) {
  try { JSON.parse(value); return true; }
  catch { return false; }
}

export function getRawBodyValue(inputs = {}, fallback) {
  if (Object.hasOwn(inputs, "body:__raw")) return inputs["body:__raw"];
  return fallback == null ? "" : JSON.stringify(fallback, null, 2);
}

// Static facts about an operation's request shape, independent of what the user typed.
export function describeOperation(operation) {
  const parameters = operation?.parameters ?? [];
  const pathParameters = [...(operation?.path?.matchAll(/\{([^}]+)\}/g) ?? [])].map((match) => match[1]);
  const knownParameterNames = new Set(parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.name));
  const bodyFields = operation?.request_body_fields ?? [];
  const isFormBody = FORM_BODY.test(operation?.request_body_content_type || "");
  const contractScenarios = (operation?.scenarios ?? []).filter((scenario) => !isEditedScenario(scenario));
  const rawJsonFallback = contractScenarios.find((scenario) => scenario.request_example?.json_body != null)?.request_example?.json_body;
  return {
    operation,
    operationParameters: [
      ...parameters,
      ...pathParameters.filter((name) => !knownParameterNames.has(name)).map((name) => ({ name, location: "path", required: true })),
    ],
    bodyFields,
    fileFields: bodyFields.filter((field) => field.is_file),
    isFormBody,
    sendsJsonBody: Boolean(operation?.request_body_content_type) && !isFormBody,
    rawJsonFallback,
    validBodyTemplate: contractScenarios.find((scenario) => scenario.category === "happy_path" && scenario.request_example?.json_body != null)?.request_example?.json_body
      ?? rawJsonFallback
      ?? {},
    needsRawJsonBody: Boolean(operation?.request_body_required && !isFormBody && bodyFields.length === 0),
  };
}

// Current values: what the user typed, else the contract example.
export function requestValues(described, inputs = {}) {
  const getInputValue = (key, fallback = "") => Object.hasOwn(inputs, key) ? inputs[key] : fallback;
  const rawJsonBodyValue = getRawBodyValue(inputs, described.rawJsonFallback);
  return {
    getParameterValue: (parameter) => getInputValue(`parameter:${parameter.location}:${parameter.name}`, parameter.example == null ? "" : String(parameter.example)),
    getBodyFieldValue: (field) => getInputValue(`body:${field.name}`, field.example == null ? "" : typeof field.example === "object" ? JSON.stringify(field.example) : String(field.example)),
    rawJsonBodyValue,
    rawJsonBodyIsValid: Boolean(rawJsonBodyValue.trim()) && isValidJson(rawJsonBodyValue),
  };
}

// Whether the required request details are complete; `missing` names what still needs a value.
export function requestReadiness(described, inputs = {}, files = {}) {
  const { operation, operationParameters, bodyFields, isFormBody, needsRawJsonBody } = described;
  const { getParameterValue, getBodyFieldValue, rawJsonBodyIsValid } = requestValues(described, inputs);
  const bodyRequired = Boolean(operation?.request_body_required);
  const missingParameters = operationParameters.filter((parameter) => parameter.required && !getParameterValue(parameter).trim());
  const missingBodyFields = bodyRequired
    ? bodyFields.filter((field) => field.required && (field.is_file ? !(files[field.name]?.length) : !getBodyFieldValue(field).trim()))
    : [];
  const invalidJsonFields = bodyFields.filter((field) => !field.is_file && ["object", "array"].includes(field.field_type)
    && Boolean(getBodyFieldValue(field).trim()) && !isValidJson(getBodyFieldValue(field)));
  const rawBodyMissing = needsRawJsonBody && !rawJsonBodyIsValid;
  const bodyReady = !rawBodyMissing
    && !(bodyRequired && !isFormBody && bodyFields.some((field) => field.required && !getBodyFieldValue(field).trim()));
  const missing = [
    ...missingParameters.map((parameter) => `${parameter.name} (${parameter.location})`),
    ...missingBodyFields.map((field) => `${field.name} (body${field.is_file ? " file" : ""})`),
    ...invalidJsonFields.map((field) => `${field.name} (valid JSON)`),
    ...(rawBodyMissing ? ["request body (valid JSON)"] : []),
  ];
  return {
    ready: !missingParameters.length && !missingBodyFields.length && !invalidJsonFields.length && bodyReady,
    missing,
    requiredParametersMissing: missingParameters.length > 0,
    requiredBodyFieldsMissing: missingBodyFields.length > 0,
    invalidStructuredBodyValue: invalidJsonFields.length > 0,
    bodyReady,
  };
}

// The execute payload for one runnable scenario. File uploads are read by the caller.
export function buildCheckRequest(described, inputs, scenario, { targetUrl, fileUploads = {} }) {
  const { operation, operationParameters, bodyFields, isFormBody, needsRawJsonBody, validBodyTemplate } = described;
  const { getParameterValue, getBodyFieldValue, rawJsonBodyValue } = requestValues(described, inputs);
  const example = scenario.request_example;
  const isEditedCheck = isEditedScenario(scenario);
  const omittedParameters = new Set((example.omitted_parameters ?? []).map((parameter) => `${parameter.location}:${parameter.name}`));
  const parameterValue = (parameter) => example.parameter_values?.[`${parameter.location}:${parameter.name}`] ?? getParameterValue(parameter);
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, name) => omittedParameters.has(`path:${name}`) ? "" : encodeURIComponent(parameterValue({ location: "path", name })));
  const queryParams = { ...example.query_params };
  const headers = {};
  const cookieValues = [];
  for (const parameter of operationParameters) {
    if (omittedParameters.has(`${parameter.location}:${parameter.name}`)) continue;
    // An explicit override (including "send empty value") is always sent; otherwise empty inputs are skipped.
    const override = example.parameter_values?.[`${parameter.location}:${parameter.name}`];
    const value = override ?? getParameterValue(parameter).trim();
    if (override === undefined && !value) continue;
    if (parameter.location === "query") queryParams[parameter.name] = value;
    if (parameter.location === "header") headers[parameter.name] = value;
    if (parameter.location === "cookie") cookieValues.push(`${parameter.name}=${encodeURIComponent(value)}`);
  }
  if (cookieValues.length) headers.Cookie = cookieValues.join("; ");
  const formFields = { ...example.form_fields };
  // Edited AI checks send the body exactly as the user wrote it in the editor.
  const jsonBody = isEditedCheck
    ? example.json_body ?? null
    : needsRawJsonBody
    ? JSON.parse(rawJsonBodyValue)
    : example.json_body && typeof example.json_body === "object" && !Array.isArray(example.json_body)
      ? { ...example.json_body }
      : example.json_body ?? (bodyFields.length ? {} : null);
  for (const field of bodyFields) {
    const value = getBodyFieldValue(field);
    if (field.is_file || isEditedCheck) continue;
    if (isFormBody) formFields[field.name] = value;
    else if (jsonBody && typeof jsonBody === "object" && Object.hasOwn(jsonBody, field.name)) {
      const validValue = validBodyTemplate?.[field.name];
      const scenarioValue = example.json_body?.[field.name];
      // Only fields the scenario left at their valid value take the user's input; deliberate test values stay.
      if (JSON.stringify(scenarioValue) === JSON.stringify(validValue)) {
        if (!value.trim()) delete jsonBody[field.name];
        else {
          try { jsonBody[field.name] = JSON.parse(value); }
          catch { jsonBody[field.name] = value; }
        }
      }
    }
  }
  return {
    method: example.method,
    path,
    query_params: queryParams,
    headers,
    form_body: example.form_body,
    form_fields: formFields,
    file_uploads: fileUploads,
    json_body: jsonBody,
    expected_status_codes: example.expected_status_codes,
    base_url: targetUrl,
  };
}
