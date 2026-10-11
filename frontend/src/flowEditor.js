// Editing flows: the flows an API shows (suggested ones with the user's edits, plus flows the user
// built), and turning a flow into an editable draft and back. Edits and custom flows are saved with
// the API, apart from its overview, so importing the contract again keeps them.
import { stripSensitive } from "./credentials.js";
import { stepOperation } from "./flows.js";

export const MAX_FLOW_STEPS = 10;
export const STEP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const STEP_ROLES = ["create", "read", "update", "delete", "verify_deleted", "custom"];
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const POINTER = /^(\/[^/]*)+$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const UNFILLED = /(?<!\{)\{([^{}]+)\}(?!\})/g;

export const isCustomFlow = (flow) => flow?.source === "custom";

// Suggested flows (an edit replaces its flow), edits whose suggestion is gone, then custom flows.
export function effectiveFlows(api) {
  const edits = api?.flowEdits ?? {};
  const suggested = api?.overview?.flows ?? [];
  const suggestedIds = new Set(suggested.map((flow) => flow.id));
  return [
    ...suggested.map((flow) => edits[flow.id] ?? flow),
    ...Object.values(edits).filter((flow) => !suggestedIds.has(flow.id)),
    ...(api?.customFlows ?? []),
  ];
}

// The saved API after saving `flow`: custom flows are replaced or added, others become edits.
export function withSavedFlow(api, flow) {
  if (isCustomFlow(flow)) {
    const custom = api.customFlows ?? [];
    const exists = custom.some((item) => item.id === flow.id);
    return { ...api, customFlows: exists ? custom.map((item) => item.id === flow.id ? flow : item) : [...custom, flow] };
  }
  return { ...api, flowEdits: { ...api.flowEdits, [flow.id]: flow } };
}

// Resetting an edited flow brings back the suggestion; removing a custom flow deletes it.
export function withoutFlowChanges(api, flowId) {
  const { [flowId]: _removed, ...edits } = api.flowEdits ?? {};
  return { ...api, flowEdits: edits, customFlows: (api.customFlows ?? []).filter((flow) => flow.id !== flowId) };
}

const queryText = (params = {}) => Object.entries(params).map(([name, value]) => `${name}=${value}`).join("\n");

export function blankStep(overrides = {}) {
  return { title: "", role: "custom", method: "GET", path: "/", queryText: "", bodyText: "", codesText: "200", extract: [], always_run: false, ...overrides };
}

export function flowToDraft(flow) {
  return {
    id: flow.id,
    title: flow.title,
    source: flow.source,
    rationale: flow.rationale,
    steps: flow.steps.map((step) => ({
      title: step.title,
      role: step.role ?? "custom",
      method: step.method,
      path: step.path,
      queryText: queryText(step.query_params),
      bodyText: step.json_body == null ? "" : JSON.stringify(step.json_body, null, 2),
      codesText: (step.expected_status_codes ?? []).join(", "),
      extract: (step.extract ?? []).map((rule) => ({ ...rule })),
      always_run: Boolean(step.always_run),
      // Kept so the step is still checked against its documented response schemas.
      response_schemas: step.response_schemas,
      headers: step.headers,
    })),
  };
}

export function newFlowDraft(id = `custom:${Date.now()}`) {
  return { id, title: "", source: "custom", rationale: "", steps: [blankStep({ title: "Create a record", role: "create", method: "POST", codesText: "201" })] };
}

function parseQuery(text) {
  const params = {};
  for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const index = line.indexOf("=");
    if (index <= 0) return null;
    params[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return params;
}

function parseCodes(text) {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.length > 10 || !parts.every((part) => /^\d{3}$/.test(part))) return null;
  const codes = parts.map(Number);
  return codes.every((code) => code >= 100 && code <= 599) ? codes : null;
}

function parseBody(text) {
  if (!text.trim()) return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false }; }
}

const placeholdersIn = (step) => new Set([...`${step.path}\n${step.queryText}\n${step.bodyText}`.matchAll(PLACEHOLDER)].map((match) => match[1]));

// Errors keyed as `title` for the flow, and `steps.<index>.<field>` for a step's fields.
export function validateFlowDraft(draft) {
  const errors = {};
  if (!draft.title.trim()) errors.title = "Give the flow a name.";
  if (!draft.steps.length) errors.steps = "Add at least one step.";
  if (draft.steps.length > MAX_FLOW_STEPS) errors.steps = `A flow has at most ${MAX_FLOW_STEPS} steps.`;
  const saved = new Set();
  draft.steps.forEach((step, index) => {
    const set = (field, message) => { errors[`steps.${index}.${field}`] = message; };
    if (!step.title.trim()) set("title", "Name this step.");
    if (!step.path.startsWith("/") || step.path.startsWith("//") || /[?#]/.test(step.path)) set("path", "Use an absolute path such as /pets/{{petId}}, without a query string.");
    if (parseQuery(step.queryText) === null) set("queryText", "Write one name=value pair per line.");
    if (!parseBody(step.bodyText).ok) set("bodyText", "Enter valid JSON, or leave it empty to send no body.");
    if (parseCodes(step.codesText) === null) set("codesText", "Enter one to ten status codes from 100 to 599, such as 200, 201.");
    const unknown = [...placeholdersIn(step)].filter((name) => !saved.has(name));
    if (unknown.length) set("placeholders", `Uses ${unknown.map((name) => `{{${name}}}`).join(", ")}, which no earlier step saves.`);
    step.extract.forEach((rule, ruleIndex) => {
      if (!VARIABLE.test(rule.variable)) set(`extract.${ruleIndex}`, "A saved value needs a name of letters, digits, and _ that does not start with a digit.");
      else if (!POINTER.test(rule.pointer)) set(`extract.${ruleIndex}`, "The location must be a JSON Pointer such as /id or /data/id.");
    });
    for (const rule of step.extract) saved.add(rule.variable);
  });
  return errors;
}

export function draftHasSensitiveBody(draft) {
  return draft.steps.some((step) => {
    const body = parseBody(step.bodyText);
    return body.ok && body.value && typeof body.value === "object" && JSON.stringify(stripSensitive(body.value)) !== JSON.stringify(body.value);
  });
}

// A valid draft as a flow. Credential-like body fields are not saved, like other request details.
export function draftToFlow(draft, overview, original = null) {
  const steps = draft.steps.map((step) => {
    const body = parseBody(step.bodyText).value;
    const flowStep = {
      title: step.title.trim(),
      role: step.role,
      method: step.method,
      path: step.path.trim(),
      query_params: parseQuery(step.queryText),
      headers: step.headers ?? {},
      json_body: body && typeof body === "object" ? stripSensitive(body) : body,
      expected_status_codes: parseCodes(step.codesText),
      extract: step.extract.map((rule) => ({ variable: rule.variable, source: rule.source, pointer: rule.pointer, ...(rule.fallback ? { fallback: rule.fallback } : {}) })),
      always_run: step.always_run,
    };
    // A step that now calls another endpoint is checked against that endpoint's schemas.
    const operation = stepOperation(overview, flowStep);
    return { ...flowStep, response_schemas: operation?.response_schemas ?? (step.response_schemas ?? {}) };
  });
  const missing = [...new Set(steps.flatMap((step) => [...step.path.matchAll(UNFILLED)].map((match) => match[1])))];
  return {
    id: draft.id,
    title: draft.title.trim(),
    resource: original?.resource ?? "",
    source: draft.source ?? "custom",
    rationale: draft.source === "custom" ? "A flow you built." : `${original?.rationale ?? draft.rationale ?? ""}`,
    steps,
    missing_inputs: missing,
    notes: missing.length ? [`Fill in ${missing.join(", ")} before running; the flow cannot derive them.`] : [],
    edited: draft.source !== "custom",
  };
}

export function moveStep(steps, index, offset) {
  const target = index + offset;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
