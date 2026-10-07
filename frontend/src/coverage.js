// Derives per-endpoint test coverage and risk signals from a saved API and its Run history.
import { apiIdsByTitle, runApiKey, summarizeResults } from "./runDetail.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STATUS_RANK = { failing: 0, untested: 1, passing: 2 };

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

export function computeCoverage(overview, apiRuns = []) {
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

    const risks = [];
    if (status === "failing") risks.push({ id: "failing", label: "Failing in latest run" });
    if (status === "untested" && writes) risks.push({ id: "untested-write", label: "Changes data, not tested" });
    if (status !== "untested" && hasNegativeIdeas && [...executedCategories].every((category) => category === "happy_path")) {
      risks.push({ id: "happy-only", label: "Only happy path tested" });
    }
    if (needsAuth && !executedCategories.has("security_minded")) risks.push({ id: "auth", label: "Auth not checked" });

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
      coveredChecks: runnable.filter((scenario) => executedTitles.has(scenario.title)).length,
      runnableChecks: runnable.length,
      risks,
    };
  });

  endpoints.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.risks.length - a.risks.length
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
      checksExecuted: apiRuns.reduce((sum, run) => sum + (run.results?.length ?? 0), 0),
    },
  };
}
