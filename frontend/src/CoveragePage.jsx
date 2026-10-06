import { useState } from "react";
import { computeCoverage } from "./coverage.js";
import Icon from "./Icon.jsx";

const statusLabels = { failing: "Failing", untested: "Not tested", passing: "Passing" };
const filters = [
  { id: "all", label: "All", matches: () => true },
  { id: "attention", label: "Needs attention", matches: (endpoint) => endpoint.risks.length > 0 },
  { id: "failing", label: "Failing", matches: (endpoint) => endpoint.status === "failing" },
  { id: "untested", label: "Not tested", matches: (endpoint) => endpoint.status === "untested" },
];

export default function CoveragePage({ overview, apiRuns, onOpenEndpoint, onGoToSpecs }) {
  const [filterId, setFilterId] = useState("all");
  if (!overview) {
    return <section className="history-page coverage-page">
      <div className="page-eyebrow">TEST COVERAGE</div>
      <h1>Coverage &amp; risk</h1>
      <div className="history-empty"><Icon name="shield" size={25} /><strong>No active API</strong><span>Import or open an API to see which endpoints have been tested.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>
    </section>;
  }

  const { endpoints, totals } = computeCoverage(overview, apiRuns);
  const filter = filters.find((item) => item.id === filterId) ?? filters[0];
  const visible = endpoints.filter(filter.matches);

  return <section className="history-page coverage-page">
    <div className="page-eyebrow">TEST COVERAGE</div>
    <h1>Coverage &amp; risk</h1>
    <p className="page-lede">{overview.title} · based on the checks run in this browser.</p>

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
            return <button key={item.id} type="button" role="tab" aria-selected={item.id === filter.id} className={item.id === filter.id ? "selected" : ""} onClick={() => setFilterId(item.id)}>{item.label}<span>{count}</span></button>;
          })}
        </div>
      </div>
      {visible.length ? <ul className="history-runs">{visible.map((endpoint) => <li key={endpoint.key}>
        <button className="coverage-row" type="button" onClick={() => onOpenEndpoint(endpoint.operationIndex)}>
          <span className={`method-tag method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <span className="coverage-endpoint"><strong>{endpoint.path}</strong><small>{endpoint.summary || "API endpoint"}</small></span>
          <span className={`coverage-status coverage-status-${endpoint.status}`}>{statusLabels[endpoint.status]}</span>
          <span className="coverage-checks">{endpoint.coveredChecks}/{endpoint.runnableChecks} checks<small>{endpoint.lastRunAt ? `last run ${new Date(endpoint.lastRunAt).toLocaleString()}` : "never run"}</small></span>
          <span className="coverage-risks">{endpoint.risks.map((risk) => <i key={risk.id} className={`coverage-risk coverage-risk-${risk.id}`}>{risk.label}</i>)}</span>
          <Icon className="history-chevron" name="chevron" size={15} />
        </button>
      </li>)}</ul> : <p className="coverage-empty">No endpoints match this filter.</p>}
    </section>
  </section>;
}
