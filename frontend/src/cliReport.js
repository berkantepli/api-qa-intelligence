// Turns the JSON report of `api-qa run --json` into Run history entries, so checks that ran in CI
// count on Coverage & Risk like checks run here. Each endpoint that ran becomes one run, marked as
// coming from the CLI; skipped endpoints add nothing. Flows that ran (--flows) become flow runs.
import { flowRunEntry } from "./flows.js";

// Flow run ids sit after the endpoint run ids of the same report.
const FLOW_ID_OFFSET = 100_000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function parseCliReport(text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON. Choose the report written by api-qa run --json.");
  }
  const valid = isObject(report) && typeof report.api === "string" && typeof report.generated_at === "string"
    && !Number.isNaN(Date.parse(report.generated_at)) && Array.isArray(report.endpoints)
    && report.endpoints.every((endpoint) => isObject(endpoint) && typeof endpoint.method === "string" && typeof endpoint.path === "string"
      && (endpoint.checks ?? []).every((check) => isObject(check) && typeof check.title === "string" && isObject(check.result)));
  if (!valid) throw new Error("This is not an api-qa run report. Choose the file written by api-qa run --json.");
  return report;
}

// The saved API the report belongs to: same title, preferring the active API and then the same version.
export function matchReportApi(report, savedApis = [], activeApiId = "") {
  const candidates = savedApis.filter((api) => api.title === report.api);
  return candidates.find((api) => api.id === activeApiId)
    ?? candidates.find((api) => api.overview?.version === report.api_version)
    ?? candidates[0]
    ?? null;
}

export function cliReportRuns(report, api, existingRuns = []) {
  const existingIds = new Set(existingRuns.map((run) => run.id));
  const known = new Set((api.overview?.operations ?? []).map((operation) => `${operation.method} ${operation.path}`));
  const createdAt = new Date(report.generated_at).toISOString();
  // Ids derive from the report's time, so importing the same report again adds nothing.
  const baseId = Date.parse(report.generated_at);
  const runs = [];
  const unknownEndpoints = [];
  let duplicates = 0;

  report.endpoints.forEach((endpoint, index) => {
    const checks = endpoint.checks ?? [];
    if (!checks.length) return;
    const key = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    if (!known.has(key)) {
      unknownEndpoints.push(key);
      return;
    }
    const id = baseId + index;
    if (existingIds.has(id)) {
      duplicates += 1;
      return;
    }
    runs.push({
      id,
      apiId: api.id,
      api: api.title,
      endpoint: key,
      target: typeof report.target === "string" ? report.target : "",
      createdAt,
      source: "cli",
      toolVersion: typeof report.tool_version === "string" ? report.tool_version : undefined,
      results: checks.map((check) => ({ ...check.result, title: check.title, category: check.category, source: "contract" })),
    });
  });

  (Array.isArray(report.flows) ? report.flows : []).forEach((flow, index) => {
    if (!isObject(flow) || !isObject(flow.result) || !Array.isArray(flow.result.steps)) return;
    const id = baseId + FLOW_ID_OFFSET + index;
    if (existingIds.has(id)) {
      duplicates += 1;
      return;
    }
    // The saved flow, when the API has it, adds each step's method and path for skipped steps.
    const definition = api.overview?.flows?.find((item) => item.id === flow.id) ?? { id: flow.id, title: flow.title, steps: [] };
    runs.push({
      ...flowRunEntry({ ...definition, title: flow.title }, flow.result, {
        id, apiId: api.id, api: api.title, target: typeof report.target === "string" ? report.target : "", createdAt,
      }),
      source: "cli",
      toolVersion: typeof report.tool_version === "string" ? report.tool_version : undefined,
    });
  });

  return {
    runs,
    duplicates,
    unknownEndpoints,
    versionMismatch: Boolean(report.api_version && api.overview?.version && report.api_version !== api.overview.version),
  };
}

export function cliImportMessage(report, api, outcome) {
  const endpointRuns = outcome.runs.filter((run) => run.kind !== "flow");
  const flows = outcome.runs.length - endpointRuns.length;
  const checks = endpointRuns.reduce((sum, run) => sum + run.results.length, 0);
  const imported = [
    ...(endpointRuns.length ? [`${checks} ${checks === 1 ? "check" : "checks"} on ${endpointRuns.length} ${endpointRuns.length === 1 ? "endpoint" : "endpoints"}`] : []),
    ...(flows ? [`${flows} ${flows === 1 ? "flow" : "flows"}`] : []),
  ];
  const parts = [imported.length
    ? `Imported ${imported.join(" and ")} from the CLI report of ${new Date(report.generated_at).toLocaleString()} into ${api.title}.`
    : "Nothing new to import from this report."];
  if (outcome.duplicates) parts.push(`${outcome.duplicates} ${outcome.duplicates === 1 ? "run was" : "runs were"} already imported.`);
  if (outcome.unknownEndpoints.length) parts.push(`Skipped endpoints not in this API: ${outcome.unknownEndpoints.join(", ")}.`);
  if (outcome.versionMismatch) parts.push(`The report is for version ${report.api_version}; the saved API is ${api.overview.version}.`);
  return parts.join(" ");
}
