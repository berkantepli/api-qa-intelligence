import { useState } from "react";
import { computeCoverage, coverageReportFileName, coverageReportJson, coverageReportMarkdown } from "./coverage.js";
import Icon from "./Icon.jsx";

const statusLabels = { failing: "Failing", untested: "Not tested", passing: "Passing" };
const filters = [
  { id: "all", label: "All", matches: () => true },
  { id: "attention", label: "Needs attention", matches: (endpoint) => endpoint.risks.length > 0 },
  { id: "failing", label: "Failing", matches: (endpoint) => endpoint.status === "failing" },
  { id: "untested", label: "Not tested", matches: (endpoint) => endpoint.status === "untested" },
  { id: "flaky", label: "Flaky", matches: (endpoint) => endpoint.flakyChecks.length > 0, optional: true },
  { id: "stale", label: "Stale", matches: (endpoint) => endpoint.stale, optional: true },
];
const categoryStates = { passing: "passed", failing: "has failures", not_run: "not run yet", none: "no runnable check" };
const categoryShort = { happy_path: "Happy", negative: "Negative", boundary: "Boundary", invalid_value: "Invalid", security_minded: "Auth" };

function download(content, fileName, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CoveragePage({ overview, apiRuns, onOpenEndpoint, onGoToSpecs }) {
  const [filterId, setFilterId] = useState("all");
  if (!overview) {
    return <section className="history-page coverage-page">
      <div className="page-eyebrow">TEST COVERAGE</div>
      <h1>Coverage &amp; Risk</h1>
      <div className="history-empty"><Icon name="shield" size={25} /><strong>No active API</strong><span>Import or open an API to see which endpoints have been tested.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>
    </section>;
  }

  const { endpoints, totals } = computeCoverage(overview, apiRuns);
  const filter = filters.find((item) => item.id === filterId) ?? filters[0];
  const visible = endpoints.filter(filter.matches);
  const exportReport = (format) => {
    const coverage = { endpoints, totals };
    if (format === "md") download(coverageReportMarkdown(overview, coverage), coverageReportFileName(overview.title, "md"), "text/markdown");
    else download(JSON.stringify(coverageReportJson(overview, coverage), null, 2), coverageReportFileName(overview.title, "json"), "application/json");
  };

  return <section className="history-page coverage-page">
    <div className="page-eyebrow">TEST COVERAGE</div>
    <h1>Coverage &amp; Risk</h1>
    <div className="coverage-heading">
      <p className="page-lede">{overview.title} · based on the checks run in this browser.</p>
      <div className="coverage-export">
        <button className="secondary-button" type="button" onClick={() => exportReport("md")}><Icon name="arrow" size={14} /> Export Markdown</button>
        <button className="secondary-button" type="button" onClick={() => exportReport("json")}><Icon name="arrow" size={14} /> Export JSON</button>
      </div>
    </div>

    <div className="stats-row coverage-stats">
      <div className="stat-card"><span className="stat-label">Endpoints tested</span><strong>{totals.tested} / {totals.endpoints}</strong><span className="stat-note">{totals.coveragePercent}% coverage</span><span className="coverage-meter" aria-hidden="true"><span style={{ width: `${totals.coveragePercent}%` }} /></span></div>
      <div className="stat-card"><span className="stat-label">Failing endpoints</span><strong className={totals.failing ? "history-fail" : undefined}>{totals.failing}</strong><span className="stat-note">in their latest run</span></div>
      <div className="stat-card"><span className="stat-label">Untested write endpoints</span><strong className={totals.untestedWrites ? "coverage-warning" : undefined}>{totals.untestedWrites}</strong><span className="stat-note">POST, PUT, PATCH, DELETE</span></div>
      <div className="stat-card"><span className="stat-label">Checks executed</span><strong>{totals.checksExecuted}</strong><span className="stat-note">across all runs</span></div>
    </div>

    <section className="history-group coverage-list">
      <div className="coverage-toolbar">
        <div className="coverage-filters" role="tablist" aria-label="Filter endpoints">
          {filters.map((item) => {
            const count = endpoints.filter(item.matches).length;
            if (item.optional && !count && item.id !== filter.id) return null;
            return <button key={item.id} type="button" role="tab" aria-selected={item.id === filter.id} className={item.id === filter.id ? "selected" : ""} onClick={() => setFilterId(item.id)}>{item.label}<span>{count}</span></button>;
          })}
        </div>
        <span className="coverage-legend" aria-hidden="true"><i className="coverage-category coverage-category-passing">Passed</i><i className="coverage-category coverage-category-failing">Failures</i><i className="coverage-category coverage-category-not_run">Not run</i><i className="coverage-category coverage-category-none">No check</i></span>
      </div>
      {visible.length ? <ul className="history-runs">{visible.map((endpoint) => <li key={endpoint.key}>
        <button className="coverage-row" type="button" onClick={() => onOpenEndpoint(endpoint.operationIndex)}>
          <span className={`method-tag method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <span className="coverage-endpoint"><strong>{endpoint.path}</strong><small>{endpoint.summary || "API endpoint"}</small></span>
          <span className={`coverage-status coverage-status-${endpoint.status}`}>{statusLabels[endpoint.status]}</span>
          <span className="coverage-checks">{endpoint.coveredChecks}/{endpoint.runnableChecks} checks<small>{endpoint.lastRunAt ? `last run ${new Date(endpoint.lastRunAt).toLocaleString()}` : "never run"}</small></span>
          <span className="coverage-risks">{endpoint.risks.map((risk) => <i key={risk.id} className={`coverage-risk coverage-risk-${risk.id}`} title={risk.detail}>{risk.label}</i>)}</span>
          <Icon className="history-chevron" name="chevron" size={15} />
          <span className="coverage-categories" aria-label="Checks by category">{endpoint.categories.map((category) => <i key={category.id} className={`coverage-category coverage-category-${category.state}`} title={`${category.label}: ${categoryStates[category.state]}`}>{categoryShort[category.id]}</i>)}</span>
        </button>
      </li>)}</ul> : <p className="coverage-empty">No endpoints match this filter.</p>}
    </section>
  </section>;
}
