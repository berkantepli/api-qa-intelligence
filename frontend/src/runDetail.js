// Pure helpers for presenting a saved run and its redacted evidence.

export function summarizeResults(results = []) {
  const count = (outcome) => results.filter((result) => (result.result || "ERROR") === outcome).length;
  return { total: results.length, passed: count("PASS"), failed: count("FAIL"), errors: count("ERROR") };
}

export function formatEvidenceBody(text) {
  if (text == null || text === "") return "";
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return String(text); }
}

export function sortedHeaders(headers = {}) {
  return Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function requestLine(result) {
  return `${result.method || ""} ${result.request_url || result.path || ""}`.trim();
}

export function outcomeSummary(result) {
  const expected = result.expected_status_codes?.length ? result.expected_status_codes.join(" or ") : "a documented status";
  if (result.response_status == null) return `Expected HTTP ${expected}, but no response was received.`;
  const schema = result.schema_check;
  if ((result.result || "ERROR") === "PASS") {
    return schema?.status === "passed"
      ? `Received HTTP ${result.response_status}, as expected, and the body matches the documented schema.`
      : `Received HTTP ${result.response_status}, as expected.`;
  }
  if (result.too_slow && result.expected_status_codes?.includes(result.response_status)) {
    return `Received HTTP ${result.response_status}, as expected, but it took ${result.duration_ms} ms (limit ${result.max_duration_ms} ms).`;
  }
  if (schema?.status === "failed") return `Received HTTP ${result.response_status}, as expected, but the body does not match the documented schema: ${schema.detail}`;
  return `Expected HTTP ${expected}, received HTTP ${result.response_status}.`;
}

export function hasRequestEvidence(result) {
  return Boolean(result.request_url || result.request_body || Object.keys(result.request_headers ?? {}).length);
}

export function hasResponseEvidence(result) {
  return result.response_status != null || Boolean(result.response_body || Object.keys(result.response_headers ?? {}).length);
}

// Groups saved runs by API, newest activity first. Runs saved before apiId was recorded are
// matched to a saved API by title when that title is unambiguous.
// Maps each saved API title to its id, or null when two saved APIs share the title.
export function apiIdsByTitle(savedApis = []) {
  const idsByTitle = new Map();
  for (const api of savedApis) idsByTitle.set(api.title, idsByTitle.has(api.title) ? null : api.id);
  return idsByTitle;
}

export function runApiKey(run, idsByTitle) {
  return run.apiId || idsByTitle.get(run.api) || `title:${run.api}`;
}

export function groupRunsByApi(runs = [], savedApis = []) {
  const idsByTitle = apiIdsByTitle(savedApis);
  const groups = new Map();
  for (const run of runs) {
    const key = runApiKey(run, idsByTitle);
    if (!groups.has(key)) groups.set(key, { key, api: run.api, runs: [] });
    groups.get(key).runs.push(run);
  }
  return [...groups.values()]
    .map((group) => {
      const sortedRuns = [...group.runs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return {
        ...group,
        runs: sortedRuns,
        latestAt: sortedRuns[0]?.createdAt,
        summary: summarizeResults(sortedRuns.flatMap((run) => run.results ?? [])),
      };
    })
    .sort((a, b) => new Date(b.latestAt) - new Date(a.latestAt));
}
