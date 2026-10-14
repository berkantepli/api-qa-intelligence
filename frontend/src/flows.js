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

// `secondUser` holds the second user's credential values by credential key, for an access check:
// steps marked `actor: "second"` send those instead of the first user's.
export function buildFlowRequest(overview, flow, { targetUrl, maxDurationMs = null, pathValues = {}, inputsByOperation = {}, secondUser = {} }) {
  const credentials = flowCredentials(overview, flow)
    .map((credential) => ({ ...credential, value: credentialValue(credential, inputsByOperation).trim() }))
    .filter((credential) => credential.value);
  const headers = Object.fromEntries(credentials.filter((item) => item.location === "header").map((item) => [item.name, item.value]));
  const queryCredentials = credentials.filter((item) => item.location === "query");
  return {
    base_url: targetUrl,
    headers,
    max_duration_ms: maxDurationMs,
    secret_names: [...new Set(flowCredentials(overview, flow).map((credential) => credential.name))],
    steps: flow.steps.map(({ actor, ...step }) => {
      const operation = stepOperation(overview, step);
      const operationKey = operation ? `${operation.method} ${operation.path}` : "";
      const second = actor === "second";
      const query = { ...step.query_params };
      for (const credential of queryCredentials) {
        if (credential.operationKeys.includes(operationKey)) query[credential.name] = second ? String(secondUser[credential.key] ?? "").trim() : credential.value;
      }
      // A step's own header wins over the flow's, so the second user's value replaces the first's.
      const stepHeaders = second
        ? { ...step.headers, ...Object.fromEntries(credentials.filter((item) => item.location === "header").map((item) => [item.name, String(secondUser[item.key] ?? "").trim()])) }
        : step.headers;
      return {
        ...step,
        headers: stepHeaders ?? {},
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
      actor: flow.steps[index]?.actor ?? null,
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

// --- Access check (OWASP API1:2023, Broken Object Level Authorization) ---------------------------
// The first user creates a record; a second user tries to read, change, and delete it and must be
// refused; the first user then confirms the record is still there and cleans up.

const ACCESS_ATTEMPTS = { read: "Read it as the second user", update: "Change it as the second user", delete: "Delete it as the second user" };
// Refused: forbidden, or hidden as if it did not exist. 401 is not a pass: the second user's own
// credentials were rejected, so the step proves nothing about the record.
export const ACCESS_REFUSED = [403, 404];
const placeholders = (step) => JSON.stringify([step.path, step.query_params, step.headers, step.json_body]);

// The access check derived from a lifecycle flow, or null when no step reaches the created record
// by its saved value. With the overview, only steps whose endpoint documents a credential are
// tried: reading a public record (such as a catalog entry) as another user is not a finding.
// Every attempt runs even after an earlier one got through, so each gets its own answer.
export function accessCheckFlow(flow, overview = null) {
  const creates = flow.steps.filter((step) => step.role === "create");
  const saved = creates.at(-1)?.extract?.map((rule) => `{{${rule.variable}}}`) ?? [];
  const reaches = (step) => saved.some((name) => placeholders(step).includes(name));
  const protectedStep = (step) => !overview || Boolean(stepOperation(overview, step)?.parameters?.some((parameter) => parameter.credential));
  const targets = flow.steps.filter((step) => ACCESS_ATTEMPTS[step.role] && reaches(step) && protectedStep(step));
  if (!targets.length) return null;
  const firstRead = flow.steps.find((step) => step.role === "read" && reaches(step));
  const cleanup = flow.steps.filter((step) => step.role === "delete" || step.role === "verify_deleted")
    .map((step) => step.role === "delete" ? { ...step, always_run: true } : step);
  return {
    ...flow,
    id: `${flow.id}:access`,
    title: `Access check: ${flow.title}`,
    steps: [
      ...creates,
      ...targets.map((step) => ({ ...step, title: ACCESS_ATTEMPTS[step.role], expected_status_codes: ACCESS_REFUSED, extract: [], always_run: true, actor: "second" })),
      ...(firstRead ? [{ ...firstRead, title: "Read it again as the owner", extract: [], always_run: true, actor: "first" }] : []),
      ...cleanup,
    ],
  };
}

// Why an access check cannot run yet: the first user needs a credential, and the second user a
// value for each credential the first one sends.
export function accessCheckProblem(overview, flow, inputsByOperation = {}, secondUser = {}) {
  const credentials = flowCredentials(overview, flow);
  if (!credentials.length) return "The contract documents no credentials for this flow, so there is no user to compare.";
  const used = credentials.filter((credential) => credentialValue(credential, inputsByOperation).trim());
  if (!used.length) return "Enter the first user's credentials under Target & auth first.";
  const missing = used.filter((credential) => !String(secondUser[credential.key] ?? "").trim()).map((credential) => credential.name);
  return missing.length ? `Enter the second user's ${missing.join(", ")}.` : null;
}

// A plain sentence for each second-user step of a finished access check.
export function accessFinding(result) {
  if (result.actor !== "second" || result.result === "SKIPPED") return null;
  const status = result.response_status;
  const verb = { read: "read", update: "change", delete: "delete" }[result.role] ?? "reach";
  if (ACCESS_REFUSED.includes(status)) return { tone: "pass", text: `The second user could not ${verb} the record (HTTP ${status}).` };
  if (status === 401) return { tone: "unknown", text: "The second user's credentials were rejected (HTTP 401), so this step proves nothing. Check them and run again." };
  if (status >= 200 && status < 300) return { tone: "fail", text: `The second user could ${verb} the first user's record (HTTP ${status}).` };
  return { tone: "unknown", text: status == null ? "No response, so this step proves nothing." : `HTTP ${status} is neither a refusal nor a success, so this step proves nothing.` };
}
