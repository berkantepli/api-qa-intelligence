// Finds scenarios on one endpoint that test the same thing, and suggests which one to drop.
// Detection is local and explainable: identical requests, the same test idea on the same
// target, or very similar wording.

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "check", "confirm", "does", "endpoint", "ensure", "for",
  "from", "gracefully", "if", "in", "into", "is", "it", "its", "not", "of", "on", "or", "request", "requests",
  "send", "should", "test", "that", "the", "their", "then", "this", "to", "verify", "validate", "when", "with",
  "api", "returns", "return", "response", "responses", "system", "handles", "handle", "appropriate",
]);

// Ordered so the most specific idea wins (e.g. "rate limit" before a generic "limit").
// Endpoint-level concepts apply to the whole operation, so the fields a scenario names do not matter.
const CONCEPTS = [
  { id: "rate-limit", label: "rate limiting", endpointLevel: true, pattern: /\b(rate[- ]?limit\w*|throttl\w*)/ },
  { id: "injection", label: "injection or unsafe input", pattern: /\b(inject\w*|xss|sanitiz\w*|travers\w*|sql)/ },
  { id: "auth", label: "missing or invalid authentication", endpointLevel: true, pattern: /\b(auth\w*|unauthori[sz]ed|credential\w*|token|api[- ]?key)/ },
  { id: "missing-required", label: "a missing required input", pattern: /\b(omit\w*|missing|without|absent|lack\w*)\b.*\b(required|parameter|field|header|body)|\brequired\b.*\b(omit\w*|missing|absent)/ },
  { id: "boundary", label: "boundary values", pattern: /\b(boundar\w*|maximum|minimum|max|min|length|edge)\b/ },
  { id: "invalid-value", label: "an invalid value", pattern: /\b(invalid|malformed|wrong|non[- ]?existent|unknown|undocumented|out of range)\b/ },
];

const stem = (word) => word.replace(/(ing|ed|es|s)$/, "");

function tokens(text) {
  return new Set(String(text ?? "").toLowerCase().replace(/[^a-z0-9_{}]+/g, " ").split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem));
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export function scenarioConcept(scenario) {
  const text = `${scenario.title} ${scenario.rationale}`.toLowerCase();
  return CONCEPTS.find((concept) => concept.pattern.test(text)) ?? null;
}

// Parameter and body field names mentioned in a scenario's text.
function mentionedTargets(scenario, targetNames) {
  const text = `${scenario.title} ${scenario.rationale}`.toLowerCase();
  return new Set(targetNames.filter((name) => new RegExp(`\\b${name.toLowerCase().replace(/[^a-z0-9_]/g, "")}\\b`).test(text)));
}

// Empty objects and lists mean "nothing different", the same as a missing value.
const orNull = (value) => (value == null || (typeof value === "object" && Object.keys(value).length === 0) ? null : value);
const stable = (value) => JSON.stringify(value ?? null, (key, item) => (item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  : item));

function requestParts(example) {
  return {
    query: orNull(example.query_params),
    form: orNull(example.form_fields),
    omitted: orNull([...(example.omitted_parameters ?? [])].map((parameter) => `${parameter.location}:${parameter.name}`).sort()),
    values: orNull(example.parameter_values),
    body: example.json_body ?? null,
  };
}

function requestSignature(example) {
  if (!example) return null;
  return stable({ ...requestParts(example), expected: [...(example.expected_status_codes ?? [])].sort() });
}

// The runnable scenario that sends exactly the same request as `example`, ignoring expected status.
export function findSameRequest(example, scenarios = [], excludeIndex = -1) {
  if (!example) return null;
  const target = stable(requestParts(example));
  return scenarios.find((scenario, index) => index !== excludeIndex && scenario.request_example
    && stable(requestParts(scenario.request_example)) === target) ?? null;
}

const SOURCE_RANK = { contract: 0, ai_edited: 1, ai: 2 };
const sourceOf = (scenario) => scenario.source ?? "contract";

export function duplicatePairKey(a, b) {
  return [a.title, b.title].sort().join("␟");
}

// Returns [{ keep, drop, reason }] using indexes into `scenarios`; `drop` is the one to remove.
export function findDuplicateScenarios(scenarios = [], { targetNames = [], ignoredPairs = [] } = {}) {
  const ignored = new Set(ignoredPairs);
  const analyzed = scenarios.map((scenario, index) => ({
    index,
    scenario,
    source: sourceOf(scenario),
    signature: requestSignature(scenario.request_example),
    concept: scenarioConcept(scenario),
    targets: mentionedTargets(scenario, targetNames),
    titleTokens: tokens(scenario.title),
    allTokens: tokens(`${scenario.title} ${scenario.rationale}`),
  }));

  const pairs = [];
  const dropped = new Set();
  for (let i = 0; i < analyzed.length; i += 1) {
    for (let j = i + 1; j < analyzed.length; j += 1) {
      const a = analyzed[i];
      const b = analyzed[j];
      // Contract-generated checks are deterministic and distinct by construction.
      if (a.source === "contract" && b.source === "contract") continue;
      if (ignored.has(duplicatePairKey(a.scenario, b.scenario))) continue;

      // Scenarios aimed at different named fields or parameters are never the same test.
      const differentTargets = a.targets.size > 0 && b.targets.size > 0 && ![...a.targets].some((name) => b.targets.has(name));

      const sameConcept = a.concept && a.concept.id === b.concept?.id && a.scenario.category === b.scenario.category;

      let reason = null;
      if (a.signature && a.signature === b.signature) {
        reason = { kind: "same-request", text: "Both send the same request and expect the same status." };
      } else if (sameConcept && a.concept.endpointLevel) {
        reason = { kind: "same-idea", text: `Both test ${a.concept.label}.` };
      } else if (differentTargets) {
        continue;
      } else if (sameConcept && (a.targets.size === 0) === (b.targets.size === 0)) {
        const shared = [...a.targets].filter((name) => b.targets.has(name));
        reason = { kind: "same-idea", text: `Both test ${a.concept.label}${shared.length ? ` (${shared.join(", ")})` : ""}.` };
      } else {
        const similarity = Math.max(dice(a.titleTokens, b.titleTokens), dice(a.allTokens, b.allTokens));
        if (similarity >= 0.6) reason = { kind: "similar-wording", text: `Very similar wording (${Math.round(similarity * 100)}% overlap).` };
      }
      if (!reason) continue;

      // Keep the contract check over an edited check over an AI idea; among equals keep the earlier one.
      const [keep, drop] = SOURCE_RANK[a.source] <= SOURCE_RANK[b.source] ? [a, b] : [b, a];
      if (dropped.has(drop.index) || dropped.has(keep.index)) continue;
      dropped.add(drop.index);
      pairs.push({ keep: keep.index, drop: drop.index, reason });
    }
  }
  return pairs;
}

// Keeps only new AI ideas that do not repeat an existing scenario or an earlier new idea.
export function filterNewIdeas(existing = [], ideas = [], options = {}) {
  const candidates = [...existing, ...ideas];
  const repeated = new Set(findDuplicateScenarios(candidates, options)
    .filter((pair) => pair.drop >= existing.length)
    .map((pair) => pair.drop - existing.length));
  return { kept: ideas.filter((_, index) => !repeated.has(index)), skipped: repeated.size };
}
