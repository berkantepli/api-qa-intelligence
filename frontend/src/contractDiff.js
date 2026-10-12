// Compares two imports of the same API contract, endpoint by endpoint, and keeps the user's own
// work (edited AI checks and ideas, target URL, time limit) when an API is imported again.
import { isEditedScenario } from "./scenarioDraft.js";

const SCHEMA_RULES = ["type", "format", "pattern", "enum", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"];

const keyOf = (operation) => `${operation.method} ${operation.path}`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const responseCodes = (operation) => operation.response_codes ?? Object.keys(operation.response_schemas ?? {});

function ruleChanges(subject, before = {}, after = {}) {
  const changes = [];
  for (const rule of SCHEMA_RULES) {
    if (same(before[rule], after[rule])) continue;
    if (before[rule] === undefined) changes.push(`${subject} now has ${rule} ${JSON.stringify(after[rule])}`);
    else if (after[rule] === undefined) changes.push(`${subject} no longer has ${rule}`);
    else changes.push(`${subject} ${rule} changed from ${JSON.stringify(before[rule])} to ${JSON.stringify(after[rule])}`);
  }
  return changes;
}

// Changes to a list of named inputs (parameters or body fields), as sentences.
function inputChanges(kind, before, after, nameOf) {
  const changes = [];
  const previous = new Map(before.map((item) => [nameOf(item), item]));
  const next = new Map(after.map((item) => [nameOf(item), item]));
  for (const [name, item] of next) {
    const old = previous.get(name);
    if (!old) {
      changes.push(`New ${item.required ? "required " : ""}${kind} ${name}`);
      continue;
    }
    if (Boolean(old.required) !== Boolean(item.required)) changes.push(`${kind} ${name} is now ${item.required ? "required" : "optional"}`);
    if (Boolean(old.credential) !== Boolean(item.credential)) changes.push(`${kind} ${name} ${item.credential ? "is now" : "is no longer"} a credential`);
    changes.push(...ruleChanges(`${kind} ${name}`, { type: old.field_type, ...old.value_schema }, { type: item.field_type, ...item.value_schema }));
  }
  for (const name of previous.keys()) if (!next.has(name)) changes.push(`${kind} ${name} was removed`);
  return changes;
}

export function operationChanges(before, after) {
  const changes = [
    ...inputChanges("parameter", before.parameters ?? [], after.parameters ?? [], (item) => `${item.name} (${item.location})`),
  ];
  if ((before.request_body_content_type ?? null) !== (after.request_body_content_type ?? null)) {
    changes.push(after.request_body_content_type
      ? before.request_body_content_type ? `Request body is now ${after.request_body_content_type}` : `New request body (${after.request_body_content_type})`
      : "Request body was removed");
  }
  if (Boolean(before.request_body_required) !== Boolean(after.request_body_required) && after.request_body_content_type) {
    changes.push(`Request body is now ${after.request_body_required ? "required" : "optional"}`);
  }
  changes.push(...inputChanges("body field", before.request_body_fields ?? [], after.request_body_fields ?? [], (item) => item.name));

  const oldCodes = responseCodes(before);
  const newCodes = responseCodes(after);
  for (const code of newCodes) if (!oldCodes.includes(code)) changes.push(`New response ${code}`);
  for (const code of oldCodes) if (!newCodes.includes(code)) changes.push(`Response ${code} was removed`);
  for (const code of newCodes) {
    const oldSchema = before.response_schemas?.[code];
    const newSchema = after.response_schemas?.[code];
    if (oldCodes.includes(code) && (oldSchema || newSchema) && !same(oldSchema, newSchema)) changes.push(`Response ${code} body schema changed`);
  }
  return changes;
}

// What changed from one import to the next; null when nothing did.
export function diffOverviews(previous, next, comparedAt = new Date().toISOString()) {
  const before = new Map((previous?.operations ?? []).map((operation) => [keyOf(operation), operation]));
  const after = new Map((next?.operations ?? []).map((operation) => [keyOf(operation), operation]));
  const added = [...after.keys()].filter((key) => !before.has(key));
  const removed = [...before.keys()].filter((key) => !after.has(key));
  const changed = [...after.keys()]
    .filter((key) => before.has(key))
    .map((key) => ({ key, changes: operationChanges(before.get(key), after.get(key)) }))
    .filter((item) => item.changes.length);
  if (!added.length && !removed.length && !changed.length) return null;
  return {
    comparedAt,
    fromVersion: previous?.version ?? "",
    toVersion: next?.version ?? "",
    added,
    removed,
    changed,
  };
}

// The endpoint's change since the last import, if it has not run since: { type, changes }.
export function pendingChange(contractChanges, key, lastRunAt) {
  if (!contractChanges) return null;
  if (lastRunAt && new Date(lastRunAt) >= new Date(contractChanges.comparedAt)) return null;
  if (contractChanges.added.includes(key)) return { type: "added", changes: [] };
  const changed = contractChanges.changed.find((item) => item.key === key);
  return changed ? { type: "changed", changes: changed.changes } : null;
}

// The saved API after importing its contract again: the new contract, the user's checks and ideas
// for endpoints that still exist, the user's target and time limit, and what changed.
export function reimportedApi(existing, imported) {
  const userScenarios = new Map((existing.overview?.operations ?? []).map((operation) => [
    keyOf(operation),
    (operation.scenarios ?? []).filter((scenario) => scenario.source && scenario.source !== "contract"),
  ]));
  const operations = imported.overview.operations.map((operation) => {
    const kept = userScenarios.get(keyOf(operation)) ?? [];
    return kept.length ? { ...operation, scenarios: [...operation.scenarios, ...kept] } : operation;
  });
  const droppedChecks = [...userScenarios.entries()]
    .filter(([key]) => !operations.some((operation) => keyOf(operation) === key))
    .reduce((sum, [, scenarios]) => sum + scenarios.length, 0);
  const changes = diffOverviews(existing.overview, imported.overview, imported.importedAt);
  return {
    ...imported,
    overview: { ...imported.overview, operations },
    targetUrl: existing.targetUrl || imported.targetUrl,
    ...(existing.maxDurationMs != null ? { maxDurationMs: existing.maxDurationMs } : {}),
    // Flow edits and flows the user built belong to the API, not to one version of its contract.
    ...(existing.flowEdits ? { flowEdits: existing.flowEdits } : {}),
    ...(existing.customFlows ? { customFlows: existing.customFlows } : {}),
    // The user's critical / not critical marks; marks on endpoints the new contract removed are dropped.
    ...(existing.criticality ? { criticality: Object.fromEntries(Object.entries(existing.criticality).filter(([key]) => operations.some((operation) => keyOf(operation) === key))) } : {}),
    // A re-import without changes keeps the previous comparison, so its pending changes stay visible.
    contractChanges: changes ? { ...changes, droppedChecks } : existing.contractChanges ?? null,
  };
}

function documents(codes, status) {
  return codes.some((code) => code === "DEFAULT" || code === String(status) || (/^\dXX$/.test(code) && code[0] === String(status)[0]));
}

// Why a saved AI check may no longer fit its endpoint's contract: it sends or leaves out inputs the
// contract no longer has, sends a body the endpoint no longer takes, or expects an undocumented status.
export function staleCheckReasons(scenario, operation) {
  const example = scenario.request_example;
  if (!example || !operation) return [];
  const reasons = [];
  const parameters = new Set((operation.parameters ?? []).map((parameter) => `${parameter.location}:${parameter.name}`));
  const fields = new Set((operation.request_body_fields ?? []).map((field) => field.name));
  for (const item of example.omitted_parameters ?? []) {
    if (!parameters.has(`${item.location}:${item.name}`)) reasons.push(`Leaves out ${item.location} parameter ${item.name}, which the contract no longer has`);
  }
  for (const key of Object.keys(example.parameter_values ?? {})) {
    if (!parameters.has(key)) reasons.push(`Sends ${key.replace(":", " parameter ")}, which the contract no longer has`);
  }
  const body = example.form_body ? example.form_fields : example.json_body;
  if (body != null && !operation.request_body_content_type) {
    reasons.push("Sends a request body, but the endpoint no longer takes one");
  } else if (fields.size && body && typeof body === "object" && !Array.isArray(body)) {
    for (const name of Object.keys(body)) if (!fields.has(name)) reasons.push(`Sends body field ${name}, which the contract no longer has`);
  }
  const codes = operation.response_codes ?? [];
  if (codes.length) {
    for (const status of example.expected_status_codes ?? []) {
      if (!documents(codes, status)) reasons.push(`Expects HTTP ${status}, which the contract does not document`);
    }
  }
  return reasons;
}

// Every saved AI check in an API that may need a review, with its reasons.
export function staleChecks(overview) {
  return (overview?.operations ?? []).flatMap((operation) => (operation.scenarios ?? [])
    .filter(isEditedScenario)
    .map((scenario) => ({ key: keyOf(operation), title: scenario.title, reasons: staleCheckReasons(scenario, operation) }))
    .filter((item) => item.reasons.length));
}
