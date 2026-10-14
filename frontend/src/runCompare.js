// Turns Run history into what /api/v1/runs/compare and /api/v1/reports/html read: the latest
// result of each check at a moment, and a report check with its masked evidence.
import { outcomeSummary, requestLine } from "./runDetail.js";

const time = (run) => new Date(run.createdAt).getTime();
const oldestFirst = (a, b) => time(a) - time(b) || Number(a.id) - Number(b.id);
const DAY = 24 * 60 * 60 * 1000;

// Every check and flow step of these runs, oldest first; the compare route keeps the last of each.
export function checkRecords(runs = []) {
  return [...runs].sort(oldestFirst).flatMap((run) => (run.results ?? []).map((result, index) => ({
    endpoint: run.endpoint,
    title: result.title || `Check ${index + 1}`,
    result: ["PASS", "FAIL", "ERROR", "SKIPPED"].includes(result.result) ? result.result : "ERROR",
    duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
    message: (result.result || "ERROR") === "PASS" ? "" : outcomeSummary(result).slice(0, 4000),
    run_id: String(run.id),
    at: run.createdAt,
  })));
}

// The runs of the latest run: a whole bulk run when it has a batch id, otherwise the newest entry.
export function latestRun(runs = []) {
  if (!runs.length) return [];
  const newest = [...runs].sort(oldestFirst).at(-1);
  return newest.batchId ? runs.filter((run) => run.batchId === newest.batchId) : [newest];
}

function formatMoment(value) {
  return new Date(value).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// The moments the current results can be compared with, each with the runs that came before it.
export function comparisonBaselines(runs = [], now = Date.now()) {
  if (!runs.length) return [];
  const latest = latestRun(runs);
  const latestStart = Math.min(...latest.map(time));
  const baselines = [{
    id: "previous",
    label: "Before the latest run",
    description: `the results before the run of ${formatMoment(latestStart)}`,
    before: runs.filter((run) => time(run) < latestStart),
  }, {
    id: "day",
    label: "24 hours ago",
    description: `the results of ${formatMoment(now - DAY)}`,
    before: runs.filter((run) => time(run) <= now - DAY),
  }, {
    id: "week",
    label: "7 days ago",
    description: `the results of ${formatMoment(now - 7 * DAY)}`,
    before: runs.filter((run) => time(run) <= now - 7 * DAY),
  }];
  return baselines.map((baseline) => ({ ...baseline, available: baseline.before.length > 0 }));
}

// The previous run of the same endpoint or flow, for comparing one run with the one before it.
export function previousRunOf(run, runs = []) {
  return [...runs]
    .filter((other) => other.id !== run.id && other.endpoint === run.endpoint && other.apiId === run.apiId && oldestFirst(other, run) < 0)
    .sort(oldestFirst)
    .at(-1) ?? null;
}

// A check as the HTML report shows it; its evidence was masked when the run was saved.
export function reportCheck(result, group, index = 0) {
  const outcome = ["PASS", "FAIL", "ERROR", "SKIPPED"].includes(result.result) ? result.result : "ERROR";
  return {
    group,
    title: result.title || `Check ${index + 1}`,
    category: result.category ?? null,
    result: outcome,
    request: requestLine(result),
    response_status: result.response_status ?? null,
    expected_status_codes: result.expected_status_codes ?? [],
    duration_ms: Number.isFinite(result.duration_ms) ? result.duration_ms : null,
    message: outcome === "PASS" ? "" : outcomeSummary(result).slice(0, 4000),
    schema_errors: (result.schema_check?.errors ?? []).slice(0, 200),
    request_headers: result.request_headers ?? {},
    request_body: result.request_body ?? "",
    response_headers: result.response_headers ?? {},
    response_body: result.response_body ?? "",
  };
}

// The latest result of every check of these runs, as report checks.
export function latestReportChecks(runs = []) {
  const latest = new Map();
  for (const run of [...runs].sort(oldestFirst)) {
    (run.results ?? []).forEach((result, index) => latest.set(`${run.endpoint}␟${result.title || index}`, reportCheck(result, run.endpoint, index)));
  }
  return [...latest.values()];
}

export function reportFileName(...parts) {
  const name = parts.filter(Boolean).join(" ").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return `${name || "api-qa"}-report.html`;
}

// Asks the backend for the report and hands the browser the file.
export async function downloadHtmlReport(payload, fileName) {
  let response;
  try {
    response = await fetch("/api/v1/reports/html", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new Error("The app server is not responding. Check that it is still running, then try again.");
  }
  if (!response.ok) throw new Error(`The report could not be created (HTTP ${response.status}).`);
  const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
