// Finds what an endpoint's checks do not cover yet: for each input, the checks its contract calls for
// (leave it out, boundary values, invalid values), and for each documented response code, whether a run
// has ever received it. Matching is by rule, so every gap can be explained:
//   - a check covers an input when it names it (title, rationale, or omitted parameters) and its
//     category fits the kind of check (see GAP_KINDS);
//   - a response code is covered when any run of the endpoint received it.

const BOUNDARY_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"];
const TYPED = new Set(["integer", "number", "boolean"]);

const OMITS = /\b(omit\w*|missing|without|leave\w* out|absent)\b/i;
const omits = (scenario, input) => (scenario.request_example?.omitted_parameters ?? []).some((item) => item.name === input.name)
  || OMITS.test(`${scenario.title} ${scenario.rationale}`);

// A negative check counts as leaving an input out when it says so, and as an invalid value otherwise.
export const GAP_KINDS = {
  missing: { label: "Leave it out", fits: (scenario, input) => scenario.category === "negative" && omits(scenario, input) },
  boundary: { label: "Boundary values", fits: (scenario) => scenario.category === "boundary" },
  invalid: {
    label: "Invalid value",
    fits: (scenario, input) => scenario.category === "invalid_value" || (scenario.category === "negative" && !omits(scenario, input)),
  },
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

function mentions(scenario, input) {
  const omitted = scenario.request_example?.omitted_parameters ?? [];
  if (omitted.some((item) => item.name === input.name && (item.location ?? input.location) === input.location)) return true;
  return new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(input.name)}(?:$|[^a-z0-9_])`, "i").test(`${scenario.title} ${scenario.rationale}`);
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

  const inputs = inputsOf(operation ?? {}).map((input) => ({
    key: input.key,
    name: input.name,
    location: input.location,
    checks: expectedKinds(input).map((kind) => {
      const checks = scenarios.filter((scenario) => mentions(scenario, input) && GAP_KINDS[kind].fits(scenario, input));
      const state = !checks.length ? "no_check" : !checks.some((check) => check.request_example) ? "not_runnable" : stateOf(checks, latestByTitle);
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
