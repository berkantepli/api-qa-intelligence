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
  if ((result.result || "ERROR") === "PASS") return `Received HTTP ${result.response_status}, as expected.`;
  return `Expected HTTP ${expected}, received HTTP ${result.response_status}.`;
}

export function hasRequestEvidence(result) {
  return Boolean(result.request_url || result.request_body || Object.keys(result.request_headers ?? {}).length);
}

export function hasResponseEvidence(result) {
  return result.response_status != null || Boolean(result.response_body || Object.keys(result.response_headers ?? {}).length);
}
