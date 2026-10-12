// Finds what an endpoint's checks do not cover yet: for each input, the checks its contract calls for
// (leave it out, boundary values, invalid values), and for each documented response code, whether a run
// has ever received it. Matching is by rule, so every gap can be explained:
//   - a runnable check covers an input by what its request does: it leaves the input out, or sends a
//     value different from the valid request's (see requestTargets); its category decides the kind;
//   - an AI idea or a test imported from another tool has no request here, so it covers an input
//     when its title or rationale names it (strictly for short, common names such as id; see names);
//   - a response code is covered when any run of the endpoint received it.

const BOUNDARY_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"];
const TYPED = new Set(["integer", "number", "boolean"]);

const OMITS = /\b(omit\w*|missing|without|leave\w* out|absent)\b/i;

// How a check touches an input: "omitted" (left out) or "changed" (sent with another value). A runnable
// check says so through its request; an idea or imported test only through its words.
export const GAP_KINDS = {
  missing: { label: "Leave it out", fits: (scenario, touch) => touch === "omitted" && scenario.category !== "happy_path" },
  boundary: { label: "Boundary values", fits: (scenario, touch) => touch === "changed" && scenario.category === "boundary" },
  invalid: {
    label: "Invalid value",
    fits: (scenario, touch) => touch === "changed" && ["invalid_value", "negative"].includes(scenario.category),
  },
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Short or common names are matched in words only in a clear form, so "id" in "valid" or in an unrelated
// sentence does not count: {id}, `id`, "id", id parameter/field, or an adjective such as "invalid id".
const COMMON_NAMES = new Set(["id", "name", "type", "key", "value", "data", "code", "status", "query", "page", "limit", "sort", "filter", "q", "size", "date"]);
const ADJECTIVES = "without|no|invalid|missing|empty|negative|unknown|nonexistent|non-existent|wrong|bad|malformed|long|short|large|small|zero|null|blank|duplicate|max|min|maximum|minimum|too long|too short|out of range";

function names(text, name) {
  const plain = escapeRegExp(name);
  if (!COMMON_NAMES.has(name.toLowerCase()) && name.length > 2) {
    return new RegExp(`(?:^|[^a-z0-9_])${plain}(?:$|[^a-z0-9_])`, "i").test(text);
  }
  return new RegExp([
    `[{\`"']${plain}[}\`"']`,
    `\\b${plain}\\s+(?:parameter|param|field|property|value)\\b`,
    `\\b(?:parameter|param|field|property)\\s+${plain}\\b`,
    `\\b(?:${ADJECTIVES})\\s+${plain}\\b`,
  ].join("|"), "i").test(text);
}

// The inputs a runnable check's request touches compared with the valid request: { [inputKey]: "omitted" | "changed" }.
export function requestTargets(example, baseline) {
  const targets = {};
  for (const item of example.omitted_parameters ?? []) targets[`parameter:${item.location}:${item.name}`] = "omitted";
  for (const key of Object.keys(example.parameter_values ?? {})) targets[`parameter:${key}`] = "changed";
  for (const [name, value] of Object.entries(example.query_params ?? {})) {
    if (baseline?.query_params?.[name] !== value) targets[`parameter:query:${name}`] = "changed";
  }
  const body = example.form_body ? example.form_fields : example.json_body;
  const base = baseline?.form_body ? baseline.form_fields : baseline?.json_body;
  if (isObject(body) && isObject(base)) {
    for (const name of Object.keys(base)) if (!(name in body)) targets[`body:${name}`] = "omitted";
    for (const [name, value] of Object.entries(body)) {
      if (JSON.stringify(value) !== JSON.stringify(base[name])) targets[`body:${name}`] = "changed";
    }
  }
  return targets;
}

// How a check touches an input, or null: by its request when it has one, otherwise by its words.
function touches(scenario, input, baseline) {
  const example = scenario.request_example;
  if (example) return requestTargets(example, baseline)[input.key] ?? null;
  const text = `${scenario.title} ${scenario.rationale ?? ""}`;
  if (!names(text, input.name)) return null;
  return OMITS.test(text) ? "omitted" : "changed";
}

// Tests imported from other tools, as checks without a request: one per title, with its category.
function importedChecks(runs) {
  const checks = new Map();
  for (const run of runs) {
    for (const result of run.results ?? []) {
      if (result.imported && result.title && !checks.has(result.title)) {
        checks.set(result.title, { title: result.title, rationale: "", category: result.category, imported: true });
      }
    }
  }
  return [...checks.values()];
}

// The checks the contract calls for on one input.
function expectedKinds(input) {
  const schema = input.value_schema ?? {};
  const type = schema.type ?? input.field_type;
  const kinds = [];
  if (input.required && input.location !== "path") kinds.push("missing");
  if (BOUNDARY_KEYS.some((key) => key in schema)) kinds.push("boundary");
  if (input.location === "path" || schema.format || schema.pattern || Array.isArray(schema.enum) || TYPED.has(type)) kinds.push("invalid");
  return kinds;
}

function inputsOf(operation) {
  const parameters = (operation.parameters ?? [])
    .filter((parameter) => !parameter.credential)
    .map((parameter) => ({ ...parameter, key: `parameter:${parameter.location}:${parameter.name}` }));
  const fields = (operation.request_body_fields ?? [])
    .filter((field) => !field.is_file)
    .map((field) => ({ ...field, location: "body", key: `body:${field.name}` }));
  return [...parameters, ...fields];
}

// "passing", "failing", or "not_run" from the newest outcome of the given check titles.
function stateOf(checks, latestByTitle) {
  const outcomes = checks.map((check) => latestByTitle.get(check.title)).filter(Boolean);
  if (!outcomes.length) return "not_run";
  return outcomes.some((outcome) => outcome !== "PASS") ? "failing" : "passing";
}

function codeMatches(code, status) {
  if (/^\d{3}$/.test(code)) return Number(code) === status;
  if (/^\dXX$/.test(code)) return String(status)[0] === code[0];
  return false;
}

// `runs` are this endpoint's runs, newest first.
export function computeGaps(operation, runs = []) {
  const scenarios = operation?.scenarios ?? [];
  const latestByTitle = new Map();
  const received = new Set();
  for (const run of runs) {
    for (const result of run.results ?? []) {
      if (result.title && !latestByTitle.has(result.title)) latestByTitle.set(result.title, result.result || "ERROR");
      if (result.response_status != null) received.add(result.response_status);
    }
  }

  const baseline = scenarios.find((scenario) => scenario.category === "happy_path" && scenario.request_example)?.request_example;
  const candidates = [...scenarios, ...importedChecks(runs)];
  const inputs = inputsOf(operation ?? {}).map((input) => ({
    key: input.key,
    name: input.name,
    location: input.location,
    checks: expectedKinds(input).map((kind) => {
      const checks = candidates.filter((scenario) => {
        const touch = touches(scenario, input, baseline);
        return touch && GAP_KINDS[kind].fits(scenario, touch);
      });
      const usable = checks.filter((check) => check.request_example || check.imported);
      const state = !checks.length ? "no_check" : !usable.length ? "not_runnable" : stateOf(usable, latestByTitle);
      return { kind, label: GAP_KINDS[kind].label, state, titles: checks.map((check) => check.title) };
    }),
  })).filter((input) => input.checks.length);

  // Older imports only know the codes that have a JSON body.
  const codesKnown = Array.isArray(operation?.response_codes);
  const codes = (codesKnown ? operation.response_codes : Object.keys(operation?.response_schemas ?? {})).filter((code) => code !== "DEFAULT");
  const responses = codes.map((code) => {
    const expectedBy = scenarios.filter((scenario) => scenario.request_example?.expected_status_codes?.some((status) => codeMatches(code, status)));
    const seen = [...received].some((status) => codeMatches(code, status));
    const state = seen ? "received" : expectedBy.length ? "expected_not_received" : "no_check";
    return { code, state, titles: expectedBy.map((check) => check.title) };
  });

  const gaps = [
    ...inputs.flatMap((input) => input.checks
      .filter((check) => check.state !== "passing" && check.state !== "failing")
      .map((check) => ({ type: "input", input: input.name, kind: check.kind, state: check.state, text: inputGapText(input, check) }))),
    ...responses.filter((response) => response.state !== "received")
      .map((response) => ({ type: "response", code: response.code, state: response.state, text: responseGapText(response) })),
  ];
  return { inputs, responses, codesKnown, gaps };
}

const KIND_PHRASES = { missing: "a check that leaves out", boundary: "a boundary check for", invalid: "an invalid-value check for" };

function inputGapText(input, check) {
  const subject = `${input.location === "body" ? "field" : `${input.location} parameter`} ${input.name}`;
  if (check.state === "no_check") return `No ${KIND_PHRASES[check.kind].replace(/^an? /, "")} ${subject}`;
  if (check.state === "not_runnable") return `${capitalize(KIND_PHRASES[check.kind])} ${subject} is only an idea; convert it to a check`;
  return `${capitalize(KIND_PHRASES[check.kind])} ${subject} has not run yet`;
}

function responseGapText(response) {
  return response.state === "no_check"
    ? `HTTP ${response.code} is documented, but no check expects it`
    : `HTTP ${response.code} is expected by a check but has never been received`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
