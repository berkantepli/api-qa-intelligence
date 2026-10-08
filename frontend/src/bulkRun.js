// Plans a Coverage-page bulk run: which endpoints can run now, which still need request details,
// and which are left out because they change data (unless the user opts in). Planning is pure;
// App executes the plan.
import { describeOperation, requestReadiness, SAFE_METHODS } from "./requestBuilder.js";

export const BULK_MODES = {
  all: "All runnable checks",
  smoke: "Valid request only",
};

// Reads first, then creates, updates, and deletes, so a run creates data before it removes it.
const METHOD_ORDER = { GET: 0, HEAD: 0, OPTIONS: 0, POST: 1, PUT: 2, PATCH: 2, DELETE: 3 };

function checksFor(operation, mode) {
  const runnable = (operation.scenarios ?? []).filter((scenario) => scenario.request_example);
  return mode === "smoke" ? runnable.filter((scenario) => scenario.category === "happy_path").slice(0, 1) : runnable;
}

// endpoints: Coverage rows ({ key, operationIndex, method, path }) in display order.
// inputsByOperation / filesByOperation: request details keyed by "METHOD /path".
export function planBulkRun(overview, endpoints, { inputsByOperation = {}, filesByOperation = {}, mode = "all", includeWrites = false } = {}) {
  const plan = { ready: [], needsInput: [], dataChanging: [], noChecks: [] };
  for (const endpoint of endpoints) {
    const operation = overview?.operations?.[endpoint.operationIndex];
    if (!operation) continue;
    const item = { key: endpoint.key, operationIndex: endpoint.operationIndex, method: operation.method, path: operation.path };
    const checks = checksFor(operation, mode);
    const writes = !SAFE_METHODS.has(operation.method);
    if (writes && !includeWrites) {
      plan.dataChanging.push(item);
      continue;
    }
    if (!checks.length) {
      plan.noChecks.push(item);
      continue;
    }
    const readiness = requestReadiness(describeOperation(operation), inputsByOperation[endpoint.key], filesByOperation[endpoint.key]);
    if (!readiness.ready) plan.needsInput.push({ ...item, missing: readiness.missing });
    else plan.ready.push({ ...item, checks, writes });
  }
  plan.ready.sort((a, b) => METHOD_ORDER[a.method] - METHOD_ORDER[b.method]);
  plan.checkCount = plan.ready.reduce((sum, item) => sum + item.checks.length, 0);
  plan.writeCount = plan.ready.filter((item) => item.writes).reduce((sum, item) => sum + item.checks.length, 0);
  return plan;
}

// Only non-credential request details are kept between sessions; credentials stay in memory.
export function persistableInputs(overview, inputsByOperation = {}) {
  const credentialKeys = new Map((overview?.operations ?? []).map((operation) => [
    `${operation.method} ${operation.path}`,
    new Set((operation.parameters ?? []).filter((parameter) => parameter.credential).map((parameter) => `parameter:${parameter.location}:${parameter.name}`)),
  ]));
  const kept = {};
  for (const [operationKey, inputs] of Object.entries(inputsByOperation)) {
    const credentials = credentialKeys.get(operationKey);
    if (!credentials) continue;
    const values = Object.fromEntries(Object.entries(inputs ?? {}).filter(([key]) => !credentials.has(key)));
    if (Object.keys(values).length) kept[operationKey] = values;
  }
  return kept;
}
