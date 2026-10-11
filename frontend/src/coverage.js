// Derives per-endpoint test coverage and risk signals from a saved API and its Run history.
import { categoryLabels } from "./categories.js";
import { computeGaps } from "./coverageGaps.js";
import { RISK_LEVELS, scoreEndpoint } from "./riskScore.js";
import { apiIdsByTitle, runApiKey, summarizeResults } from "./runDetail.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATUS_RANK = { failing: 0, untested: 1, passing: 2 };
export const STALE_AFTER_DAYS = 7;
const FLAKY_WINDOW = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const endpointKey = (operation) => `${operation.method} ${operation.path}`;
const byNewest = (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
const hasProblems = (results) => {
  const summary = summarizeResults(results);
  return summary.failed + summary.errors > 0;
};

export function runsForApi(runs = [], apiId, savedApis = []) {
  const idsByTitle = apiIdsByTitle(savedApis);
  return runs.filter((run) => runApiKey(run, idsByTitle) === apiId);
}

// A check is flaky when its recent outcomes flip at least twice (for example PASS → FAIL → PASS);
// a single change is a regression or a fix, not instability.
function isFlaky(outcomes) {
  const recent = outcomes.slice(0, FLAKY_WINDOW);
  let flips = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if ((recent[index] === "PASS") !== (recent[index - 1] === "PASS")) flips += 1;
  }
  return flips >= 2;
}

// Newest-first outcomes for every check title on one endpoint.
function outcomesByTitle(runs) {
  const outcomes = new Map();
  for (const run of runs) {
    for (const result of run.results ?? []) {
      if (!result.title) continue;
      if (!outcomes.has(result.title)) outcomes.set(result.title, { category: result.category, outcomes: [] });
      outcomes.get(result.title).outcomes.push(result.result || "ERROR");
    }
  }
  return outcomes;
}

// Per category: "none" (no runnable check), "not_run", "passing", or "failing" by each check's latest outcome.
function categoryCoverage(runnable, outcomes) {
  return Object.entries(categoryLabels).map(([id, label]) => {
    const checks = runnable.filter((scenario) => scenario.category === id);
    const latest = [...outcomes.values()].filter((entry) => entry.category === id).map((entry) => entry.outcomes[0]);
    const state = latest.some((outcome) => outcome !== "PASS") ? "failing"
      : latest.length ? "passing"
      : checks.length ? "not_run"
      : "none";
    return { id, label, state };
  });
}

export function computeCoverage(overview, apiRuns = [], now = Date.now()) {
  const endpoints = (overview?.operations ?? []).map((operation, operationIndex) => {
    const key = endpointKey(operation);
    const runs = apiRuns.filter((run) => run.endpoint === key).sort(byNewest);
    const latest = runs[0];
    const status = !latest ? "untested" : hasProblems(latest.results) ? "failing" : "passing";
    const executed = runs.flatMap((run) => run.results ?? []);
    const executedTitles = new Set(executed.map((result) => result.title).filter(Boolean));
    const executedCategories = new Set(executed.map((result) => result.category).filter(Boolean));
    const runnable = (operation.scenarios ?? []).filter((scenario) => scenario.request_example);
    const writes = WRITE_METHODS.has(operation.method);
    const needsAuth = (operation.parameters ?? []).some((parameter) => parameter.credential);
    const hasNegativeIdeas = (operation.scenarios ?? []).some((scenario) => scenario.category && scenario.category !== "happy_path");
    const outcomes = outcomesByTitle(runs);
    const flakyChecks = [...outcomes.entries()].filter(([, entry]) => isFlaky(entry.outcomes)).map(([title]) => title);
    const stale = Boolean(latest) && now - new Date(latest.createdAt) > STALE_AFTER_DAYS * DAY_MS;

    const risks = [];
    if (status === "failing") risks.push({ id: "failing", label: "Failing in latest run" });
    if (status === "untested" && writes) risks.push({ id: "untested-write", label: "Changes data, not tested" });
    if (status !== "untested" && hasNegativeIdeas && [...executedCategories].every((category) => category === "happy_path")) {
      risks.push({ id: "happy-only", label: "Only happy path tested" });
    }
    if (needsAuth && !executedCategories.has("security_minded")) risks.push({ id: "auth", label: "Auth not checked" });
    if (flakyChecks.length) risks.push({ id: "flaky", label: "Flaky results", detail: `Outcome keeps changing: ${flakyChecks.join(", ")}` });
    if (stale) risks.push({ id: "stale", label: `Not run in ${STALE_AFTER_DAYS}+ days` });

    const coveredChecks = runnable.filter((scenario) => executedTitles.has(scenario.title)).length;
    const risk = scoreEndpoint({
      method: operation.method, path: operation.path, status, needsAuth,
      riskIds: risks.map((item) => item.id), coveredChecks, runnableChecks: runnable.length,
    });

    return {
      key,
      operationIndex,
      method: operation.method,
      path: operation.path,
      summary: operation.summary || operation.operation_id || "",
      status,
      writes,
      runCount: runs.length,
      lastRunAt: latest?.createdAt,
      coveredChecks,
      runnableChecks: runnable.length,
      categories: categoryCoverage(runnable, outcomes),
      flakyChecks,
      stale,
      risks,
      risk,
      gaps: computeGaps(operation, runs),
    };
  });

  // Highest risk score first; the status and data-changing methods break ties.
  endpoints.sort((a, b) => b.risk.score - a.risk.score
    || STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || Number(b.writes) - Number(a.writes)
    || a.operationIndex - b.operationIndex);

  const tested = endpoints.filter((endpoint) => endpoint.status !== "untested").length;
  return {
    endpoints,
    totals: {
      endpoints: endpoints.length,
      tested,
      coveragePercent: endpoints.length ? Math.round((tested / endpoints.length) * 100) : 0,
      failing: endpoints.filter((endpoint) => endpoint.status === "failing").length,
      untestedWrites: endpoints.filter((endpoint) => endpoint.status === "untested" && endpoint.writes).length,
      flaky: endpoints.filter((endpoint) => endpoint.flakyChecks.length).length,
      stale: endpoints.filter((endpoint) => endpoint.stale).length,
      highRisk: endpoints.filter((endpoint) => endpoint.risk.level === "high").length,
      withGaps: endpoints.filter((endpoint) => endpoint.gaps.gaps.length).length,
      gaps: endpoints.reduce((sum, endpoint) => sum + endpoint.gaps.gaps.length, 0),
      checksExecuted: apiRuns.reduce((sum, run) => sum + (run.results?.length ?? 0), 0),
    },
  };
}

const CATEGORY_MARKS = { passing: "pass", failing: "FAIL", not_run: "not run", none: "–" };

function reportSlug(title) {
  return String(title || "api").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "api";
}

export function coverageReportFileName(title, extension, date = new Date()) {
  return `coverage-${reportSlug(title)}-${date.toISOString().slice(0, 10)}.${extension}`;
}

// A shareable snapshot of the Coverage & Risk page; it contains no request or response evidence.
export function coverageReportJson(overview, coverage, generatedAt = new Date()) {
  return {
    api: { title: overview.title, version: overview.version },
    generated_at: generatedAt.toISOString(),
    totals: coverage.totals,
    endpoints: coverage.endpoints.map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      status: endpoint.status,
      checks: { covered: endpoint.coveredChecks, runnable: endpoint.runnableChecks },
      last_run_at: endpoint.lastRunAt ?? null,
      categories: Object.fromEntries(endpoint.categories.map((category) => [category.id, category.state])),
      flaky_checks: endpoint.flakyChecks,
      risks: endpoint.risks.map((risk) => risk.label),
      risk_score: {
        score: endpoint.risk.score,
        level: endpoint.risk.level,
        factors: endpoint.risk.factors.map(({ id, label, points }) => ({ id, label, points })),
      },
      gaps: endpoint.gaps.gaps.map((gap) => gap.text),
      inputs: endpoint.gaps.inputs.map((input) => ({
        name: input.name,
        location: input.location,
        checks: Object.fromEntries(input.checks.map((check) => [check.kind, check.state])),
      })),
      responses: Object.fromEntries(endpoint.gaps.responses.map((response) => [response.code, response.state])),
    })),
  };
}

export function coverageReportMarkdown(overview, coverage, generatedAt = new Date()) {
  const { totals } = coverage;
  const cell = (text) => String(text).replace(/\|/g, "\\|");
  const lines = [
    `# Coverage & Risk: ${overview.title} ${overview.version ?? ""}`.trimEnd(),
    "",
    `Generated ${generatedAt.toISOString()} from the checks run in this browser.`,
    "",
    `- Endpoints tested: ${totals.tested} / ${totals.endpoints} (${totals.coveragePercent}%)`,
    `- Failing endpoints: ${totals.failing}`,
    `- Untested write endpoints: ${totals.untestedWrites}`,
    `- Flaky endpoints: ${totals.flaky}`,
    `- Stale endpoints (not run in ${STALE_AFTER_DAYS}+ days): ${totals.stale}`,
    `- High-risk endpoints (score ${RISK_LEVELS[0].min}+): ${totals.highRisk}`,
    `- Coverage gaps: ${totals.gaps} across ${totals.withGaps} endpoints`,
    `- Checks executed: ${totals.checksExecuted}`,
    "",
    `Risk score: the sum of fixed rule points, capped at 100; high from ${RISK_LEVELS[0].min}, medium from ${RISK_LEVELS[1].min}.`,
    "",
    `| Endpoint | Risk | Status | Checks | ${Object.values(categoryLabels).join(" | ")} | Why |`,
    `| --- | --- | --- | --- | ${Object.keys(categoryLabels).map(() => "---").join(" | ")} | --- |`,
    ...coverage.endpoints.map((endpoint) => [
      `\`${endpoint.method} ${cell(endpoint.path)}\``,
      `${endpoint.risk.score} ${endpoint.risk.level}`,
      endpoint.status,
      `${endpoint.coveredChecks}/${endpoint.runnableChecks}`,
      ...endpoint.categories.map((category) => CATEGORY_MARKS[category.state]),
      cell(endpoint.risk.factors.map((factor) => `+${factor.points} ${factor.label}`).join(", ") || "–"),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Coverage gaps",
    "",
    ...(totals.gaps ? coverage.endpoints.filter((endpoint) => endpoint.gaps.gaps.length).flatMap((endpoint) => [
      `### \`${endpoint.method} ${endpoint.path}\``,
      "",
      ...endpoint.gaps.gaps.map((gap) => `- ${gap.text}`),
      "",
    ]) : ["No gaps: every input and documented response code is covered by a check that has run.", ""]),
  ];
  return lines.join("\n");
}
