// Turns test results from other tools (read by POST /api/v1/results/parse) into Run history entries,
// so a Postman/Newman or JUnit suite counts on Coverage & Risk. A case belongs to the endpoint whose
// method matches and whose path template matches the end of the case's path, so a base path such as
// /api/v3 in front is fine; cases without a request line, or that match no endpoint, are counted
// and left out.

export const TOOL_LABELS = { newman: "Newman", junit: "JUnit" };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isParameter = (segment) => /^\{[^{}]+\}$/.test(segment);
const segmentsOf = (path) => String(path ?? "").split("?")[0].split("/").filter(Boolean);

// The endpoint a request belongs to, preferring templates with more fixed segments: /pets/mine before /pets/{id}.
export function matchOperation(operations = [], method, path) {
  if (!method || !path) return null;
  const target = segmentsOf(path);
  const candidates = operations
    .filter((operation) => operation.method === method.toUpperCase())
    .map((operation) => ({ operation, segments: segmentsOf(operation.path) }))
    .filter(({ segments }) => {
      if (segments.length > target.length) return false;
      const tail = target.slice(target.length - segments.length);
      // A JUnit name may carry the template itself ({id}); a Newman URL carries the value (7).
      return segments.every((segment, index) => isParameter(segment) || segment.toLowerCase() === tail[index].toLowerCase());
    })
    .map(({ operation, segments }) => ({
      operation,
      fixed: segments.filter((segment) => !isParameter(segment)).length,
      exact: segments.length === target.length,
    }));
  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.fixed - a.fixed);
  return candidates[0]?.operation ?? null;
}

function importedResult(item, tool, operation) {
  const result = {
    title: item.title,
    category: "imported",
    source: tool,
    imported: tool,
    result: item.result,
    method: operation.method,
    path: operation.path,
    request_url: item.path ?? "",
    response_status: item.response_status ?? null,
    expected_status_codes: [],
    duration_ms: item.duration_ms ?? 0,
  };
  if (item.result !== "PASS") result.reason = item.message || `The test ${item.result === "ERROR" ? "had an error" : "failed"} in ${TOOL_LABELS[tool]}.`;
  return result;
}

export function testResultRuns(parsed, api, existingRuns = [], now = new Date()) {
  const importKey = `${parsed.tool}:${parsed.fingerprint}`;
  const counts = { skipped: 0, unmatched: [], cases: 0 };
  if (existingRuns.some((run) => run.importKey === importKey)) return { runs: [], duplicate: true, ...counts };

  const operations = api.overview?.operations ?? [];
  const byEndpoint = new Map();
  for (const item of parsed.cases ?? []) {
    if (item.result === "SKIPPED") {
      counts.skipped += 1;
      continue;
    }
    const operation = matchOperation(operations, item.method, item.path);
    if (!operation) {
      counts.unmatched.push(item.method && item.path ? `${item.method} ${item.path}` : item.title);
      continue;
    }
    const key = `${operation.method} ${operation.path}`;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key).push(importedResult(item, parsed.tool, operation));
    counts.cases += 1;
  }

  const parsedTime = Date.parse(parsed.generated_at ?? "");
  const createdAt = new Date(Number.isNaN(parsedTime) ? now.getTime() : parsedTime).toISOString();
  const baseId = now.getTime();
  const runs = [...byEndpoint.entries()].map(([endpoint, results], index) => ({
    id: baseId + index,
    apiId: api.id,
    api: api.title,
    endpoint,
    target: "",
    createdAt,
    source: parsed.tool,
    importKey,
    importName: parsed.name,
    results,
  }));
  return { runs, duplicate: false, ...counts };
}

export function testResultsMessage(parsed, api, outcome) {
  const tool = TOOL_LABELS[parsed.tool];
  if (outcome.duplicate) return `This ${tool} report is already in Run history.`;
  const parts = [outcome.runs.length
    ? `Imported ${outcome.cases} ${tool} ${outcome.cases === 1 ? "test" : "tests"} on ${outcome.runs.length} ${outcome.runs.length === 1 ? "endpoint" : "endpoints"} of ${api.title} from “${parsed.name}”.`
    : `No test in “${parsed.name}” matched an endpoint of ${api.title}.`];
  if (outcome.unmatched.length) {
    const shown = outcome.unmatched.slice(0, 5).join(", ");
    const more = outcome.unmatched.length > 5 ? ` and ${outcome.unmatched.length - 5} more` : "";
    const hint = parsed.tool === "junit" ? " A JUnit test is matched when its suite, class, or name contains a request line such as GET /pets/{id}." : "";
    parts.push(`Left out ${outcome.unmatched.length} that matched no endpoint: ${shown}${more}.${hint}`);
  }
  if (outcome.skipped) parts.push(`${outcome.skipped} skipped ${outcome.skipped === 1 ? "test was" : "tests were"} left out.`);
  return parts.join(" ");
}
