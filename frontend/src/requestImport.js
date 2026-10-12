// Compares the requests of a Postman collection or HAR file (read by POST /api/v1/requests/parse)
// with the contract, and turns their values into request details for the endpoints they call.
import { describeOperation } from "./requestBuilder.js";
import { matchOperation } from "./testResults.js";

const segmentsOf = (path) => String(path ?? "").split("?")[0].split("/").filter(Boolean);
const isPlaceholder = (segment) => /^\{[^{}]+\}$/.test(segment);
const keyOf = (operation) => `${operation.method} ${operation.path}`;
const asText = (value) => typeof value === "string" ? value : JSON.stringify(value);

export function compareRequests(overview, collection) {
  const operations = overview?.operations ?? [];
  const matched = new Map();
  const unmatched = [];
  for (const request of collection?.requests ?? []) {
    const operation = matchOperation(operations, request.method, request.path);
    if (!operation) {
      unmatched.push(request);
      continue;
    }
    const key = keyOf(operation);
    if (!matched.has(key)) matched.set(key, { operation, requests: [] });
    matched.get(key).requests.push(request);
  }
  const uncovered = operations.filter((operation) => !matched.has(keyOf(operation)));
  return { matched: [...matched.values()], unmatched, uncovered, total: operations.length };
}

// Path parameter values from a request whose path ends with the operation's template.
function pathValues(operation, request) {
  const template = segmentsOf(operation.path);
  const actual = segmentsOf(request.path).slice(-template.length);
  const values = {};
  template.forEach((segment, index) => {
    if (isPlaceholder(segment) && actual[index] && !isPlaceholder(actual[index])) values[segment.slice(1, -1)] = actual[index];
  });
  return values;
}

// Request details for one endpoint from its requests: the first value found for each input wins.
// Credential parameters are never filled; values come only from what the file says.
export function suggestedInputs(operation, requests) {
  const described = describeOperation(operation);
  const inputs = {};
  const set = (key, value) => {
    if (value == null || value === "" || Object.hasOwn(inputs, key)) return;
    inputs[key] = asText(value);
  };
  for (const request of requests) {
    const path = pathValues(operation, request);
    for (const parameter of described.operationParameters) {
      if (parameter.credential) continue;
      if (parameter.location === "path") set(`parameter:path:${parameter.name}`, path[parameter.name]);
      if (parameter.location === "query") set(`parameter:query:${parameter.name}`, request.query?.[parameter.name]);
    }
    const body = request.json_body && typeof request.json_body === "object" && !Array.isArray(request.json_body) ? request.json_body : null;
    for (const field of described.bodyFields) {
      if (field.is_file) continue;
      set(`body:${field.name}`, described.isFormBody ? request.form_fields?.[field.name] : body?.[field.name]);
    }
    if (described.needsRawJsonBody && request.json_body != null) set("body:__raw", JSON.stringify(request.json_body, null, 2));
  }
  return inputs;
}

// The endpoint's request details with the suggested values added: only empty ones are filled,
// unless `replace` is set.
export function mergeInputs(current = {}, suggested = {}, replace = false) {
  const merged = { ...current };
  let filled = 0;
  for (const [key, value] of Object.entries(suggested)) {
    const existing = current[key];
    if (!replace && typeof existing === "string" && existing.trim()) continue;
    if (existing === value) continue;
    merged[key] = value;
    filled += 1;
  }
  return { inputs: merged, filled };
}
