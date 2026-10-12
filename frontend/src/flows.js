// Pure helpers for the Flows page: which inputs a suggested flow still needs, the payload for
// POST /api/v1/flows/execute, and the Run history entry a finished flow becomes.
import { SAFE_METHODS } from "./requestBuilder.js";

export const ROLE_LABELS = {
  create: "Create",
  read: "Read",
  update: "Update",
  delete: "Cleanup",
  verify_deleted: "Confirm deleted",
  custom: "Step",
};

// "/pet/{{petId}}" and "/pet/{petId}" both become "/pet/{}", so a step finds its operation.
const routeShape = (path) => path.replace(/\{\{[^{}]+\}\}|\{[^{}]+\}/g, "{}");
const UNFILLED = /(?<!\{)\{([^{}]+)\}(?!\})/g;

export function stepOperation(overview, step) {
  return overview?.operations?.find((operation) => operation.method === step.method && routeShape(operation.path) === routeShape(step.path));
}

// Credentials the flow's operations document, once per name and location (header or query).
export function flowCredentials(overview, flow) {
  const found = new Map();
  for (const step of flow.steps) {
    const operation = stepOperation(overview, step);
    for (const parameter of operation?.parameters ?? []) {
      if (!parameter.credential || !["header", "query"].includes(parameter.location)) continue;
      const key = `parameter:${parameter.location}:${parameter.name}`;
      if (!found.has(key)) found.set(key, { key, name: parameter.name, location: parameter.location, operationKeys: [] });
      found.get(key).operationKeys.push(`${operation.method} ${operation.path}`);
    }
  }
  return [...found.values()];
}

// A credential typed in the overview for any of the flow's endpoints is used for the whole flow.
export function credentialValue(credential, inputsByOperation = {}) {
  for (const key of credential.operationKeys) {
    const value = inputsByOperation[key]?.[credential.key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function missingFlowInputs(flow, pathValues = {}) {
  return (flow.missing_inputs ?? []).filter((name) => !String(pathValues[name] ?? "").trim());
}

export function dataChangingSteps(flow) {
  return flow.steps.filter((step) => !SAFE_METHODS.has(step.method));
}

export function buildFlowRequest(overview, flow, { targetUrl, maxDurationMs = null, pathValues = {}, inputsByOperation = {} }) {
  const credentials = flowCredentials(overview, flow)
    .map((credential) => ({ ...credential, value: credentialValue(credential, inputsByOperation).trim() }))
    .filter((credential) => credential.value);
  const headers = Object.fromEntries(credentials.filter((item) => item.location === "header").map((item) => [item.name, item.value]));
  const queryCredentials = credentials.filter((item) => item.location === "query");
  return {
    base_url: targetUrl,
    headers,
    max_duration_ms: maxDurationMs,
    steps: flow.steps.map((step) => {
      const operation = stepOperation(overview, step);
      const operationKey = operation ? `${operation.method} ${operation.path}` : "";
      const query = { ...step.query_params };
      for (const credential of queryCredentials) {
        if (credential.operationKeys.includes(operationKey)) query[credential.name] = credential.value;
      }
      return {
        ...step,
        path: step.path.replace(UNFILLED, (match, name) => pathValues[name]?.trim() ? encodeURIComponent(pathValues[name].trim()) : match),
        query_params: query,
      };
    }),
  };
}

// One Run history entry per flow run; each step is a result, like the checks of an endpoint run.
export function flowRunEntry(flow, outcome, { apiId, api, target, id = Date.now(), createdAt = new Date().toISOString() }) {
  return {
    id,
    kind: "flow",
    flowId: flow.id,
    apiId,
    api,
    endpoint: `Flow: ${flow.title}`,
    target,
    createdAt,
    results: outcome.steps.map((step, index) => ({
      method: flow.steps[index]?.method,
      path: flow.steps[index]?.path,
      expected_status_codes: flow.steps[index]?.expected_status_codes,
      ...step.check,
      title: step.title,
      role: step.role,
      // The check's path is the one it sent (/pets/2); the step's template finds its endpoint.
      step_path: flow.steps[index]?.path,
      // A step can fail after a matching response, for example when its value could not be saved.
      result: step.status,
      reason: step.reason ?? null,
      saved_values: step.saved_values ?? {},
    })),
  };
}

export const isFlowRun = (run) => run?.kind === "flow";
