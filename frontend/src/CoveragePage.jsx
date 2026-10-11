import { useState } from "react";
import { computeCoverage, coverageReportFileName, coverageReportJson, coverageReportMarkdown } from "./coverage.js";
import BulkRunPanel from "./BulkRunPanel.jsx";
import { GAP_KINDS } from "./coverageGaps.js";
import Icon from "./Icon.jsx";
import { RISK_LEVELS, RISK_RULES } from "./riskScore.js";

const statusLabels = { failing: "Failing", untested: "Not tested", passing: "Passing" };
const filters = [
  { id: "all", label: "All", matches: () => true },
  { id: "attention", label: "Needs attention", matches: (endpoint) => endpoint.risks.length > 0 },
  { id: "high", label: "High risk", matches: (endpoint) => endpoint.risk.level === "high", optional: true },
  { id: "gaps", label: "Has gaps", matches: (endpoint) => endpoint.gaps.gaps.length > 0, optional: true },
  { id: "failing", label: "Failing", matches: (endpoint) => endpoint.status === "failing" },
  { id: "untested", label: "Not tested", matches: (endpoint) => endpoint.status === "untested" },
  { id: "flaky", label: "Flaky", matches: (endpoint) => endpoint.flakyChecks.length > 0, optional: true },
  { id: "stale", label: "Stale", matches: (endpoint) => endpoint.stale, optional: true },
];
const categoryStates = { passing: "passed", failing: "has failures", not_run: "not run yet", none: "no runnable check" };
const levelLabels = Object.fromEntries(RISK_LEVELS.map((level) => [level.id, level.label]));
// Evidence factors reuse the risk flag colors; impact factors share one neutral style.
const factorClass = (factor) => factor.kind === "impact" ? "coverage-risk coverage-risk-impact" : `coverage-risk coverage-risk-${factor.id}`;
// Gap states reuse the category strip's colors.
const gapStates = {
  passing: ["passing", "Passed"], failing: ["failing", "Failing"], not_run: ["not_run", "Not run"],
  not_runnable: ["not_run", "Idea only"], no_check: ["none", "No check"],
  received: ["passing", "Received"], expected_not_received: ["not_run", "Never received"],
};
const GapState = ({ state }) => <i className={`coverage-category coverage-category-${gapStates[state][0]}`}>{gapStates[state][1]}</i>;

function GapDetails({ endpoint }) {
  const { inputs, responses, codesKnown, gaps } = endpoint.gaps;
  if (!inputs.length && !responses.length) return null;
  return <details className="coverage-gaps">
    <summary>{gaps.length ? `${gaps.length} coverage ${gaps.length === 1 ? "gap" : "gaps"}` : "No coverage gaps"}<small>inputs and response codes</small></summary>
    {gaps.length > 0 && <ul className="coverage-gap-list">{gaps.map((gap) => <li key={gap.text}>{gap.text}</li>)}</ul>}
    {inputs.length > 0 && <table>
      <thead><tr><th>Input</th>{Object.values(GAP_KINDS).map((kind) => <th key={kind.label}>{kind.label}</th>)}</tr></thead>
      <tbody>{inputs.map((input) => <tr key={input.key}>
        <td><code>{input.name}</code><small>{input.location}</small></td>
        {Object.keys(GAP_KINDS).map((kind) => {
          const check = input.checks.find((item) => item.kind === kind);
          return <td key={kind} title={check?.titles.join(", ") || undefined}>{check ? <GapState state={check.state} /> : <span className="coverage-gap-na">–</span>}</td>;
        })}
      </tr>)}</tbody>
    </table>}
    {responses.length > 0 && <div className="coverage-gap-codes"><span>Documented responses</span>{responses.map((response) => <span key={response.code} title={response.titles.join(", ") || "No check expects this code."}><b>{response.code}</b><GapState state={response.state} /></span>)}</div>}
    {!codesKnown && <small className="coverage-gap-note">Only responses with a JSON body are listed. Import this API again to include every documented response code.</small>}
  </details>;
}

const categoryShort = { happy_path: "Happy", negative: "Negative", boundary: "Boundary", invalid_value: "Invalid", security_minded: "Auth" };

function download(content, fileName, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function CoveragePage({
  overview, apiRuns, onOpenEndpoint, onGoToSpecs,
  inputsByOperation, filesByOperation, targetUrl, targetProblem, bulkRun, onBulkRun, onStopBulkRun, onDismissBulkRun,
}) {
  const [filterId, setFilterId] = useState("all");
  const [planning, setPlanning] = useState(false);
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
      <p className="page-lede">{overview.title} · based on {totals.checksExecuted} {totals.checksExecuted === 1 ? "check" : "checks"} in Run history.</p>
      <div className="coverage-export">
        <button className="secondary-button" type="button" onClick={() => exportReport("md")}><Icon name="arrow" size={14} /> Export Markdown</button>
        <button className="secondary-button" type="button" onClick={() => exportReport("json")}><Icon name="arrow" size={14} /> Export JSON</button>
      </div>
    </div>

    <div className="stats-row coverage-stats">
      <div className="stat-card"><span className="stat-label">Endpoints tested</span><strong>{totals.tested} / {totals.endpoints}</strong><span className="stat-note">{totals.coveragePercent}% coverage</span><span className="coverage-meter" aria-hidden="true"><span style={{ width: `${totals.coveragePercent}%` }} /></span></div>
      <div className="stat-card"><span className="stat-label">Failing endpoints</span><strong className={totals.failing ? "history-fail" : undefined}>{totals.failing}</strong><span className="stat-note">in their latest run</span></div>
      <div className="stat-card"><span className="stat-label">Untested write endpoints</span><strong className={totals.untestedWrites ? "coverage-warning" : undefined}>{totals.untestedWrites}</strong><span className="stat-note">POST, PUT, PATCH, DELETE</span></div>
      <button className="stat-card stat-card-link" type="button" onClick={() => setFilterId("high")} title="Show high-risk endpoints"><span className="stat-label">High-risk endpoints</span><strong className={totals.highRisk ? "history-fail" : undefined}>{totals.highRisk}</strong><span className="stat-note">risk score {RISK_LEVELS[0].min} or more</span></button>
    </div>

    {(planning || bulkRun) && <BulkRunPanel
      overview={overview}
      endpoints={visible}
      filterLabel={filter.label}
      inputsByOperation={inputsByOperation}
      filesByOperation={filesByOperation}
      targetUrl={targetUrl}
      targetProblem={targetProblem}
      bulkRun={bulkRun}
      onRun={onBulkRun}
      onStop={onStopBulkRun}
      onClose={() => { setPlanning(false); onDismissBulkRun(); }}
      onOpenEndpoint={onOpenEndpoint}
    />}

    <section className="history-group coverage-list">
      <div className="coverage-toolbar">
        <div className="coverage-filters" role="tablist" aria-label="Filter endpoints">
          {filters.map((item) => {
            const count = endpoints.filter(item.matches).length;
            if (item.optional && !count && item.id !== filter.id) return null;
            return <button key={item.id} type="button" role="tab" aria-selected={item.id === filter.id} className={item.id === filter.id ? "selected" : ""} onClick={() => setFilterId(item.id)}>{item.label}<span>{count}</span></button>;
          })}
        </div>
        <button className="secondary-button coverage-run-button" type="button" disabled={planning || Boolean(bulkRun) || !visible.length} onClick={() => setPlanning(true)}><Icon name="run" size={13} /> Run checks</button>
        <details className="risk-rules">
          <summary>How the risk score works</summary>
          <p>Each endpoint's score is the sum of the rules below, capped at 100: <strong>high</strong> from {RISK_LEVELS[0].min}, <strong>medium</strong> from {RISK_LEVELS[1].min}. Impact comes from the contract, evidence from Run history. No AI is used, so the same history always gives the same score.</p>
          <table>
            <thead><tr><th>Rule</th><th>Points</th><th>When it applies</th></tr></thead>
            <tbody>{RISK_RULES.map((rule) => <tr key={rule.id}><td><i className={factorClass(rule)}>{rule.label}</i></td><td>+{rule.points}</td><td>{rule.kind === "impact" ? "Impact" : "Evidence"} · {rule.description}</td></tr>)}</tbody>
          </table>
        </details>
        <span className="coverage-legend" aria-hidden="true"><i className="coverage-category coverage-category-passing">Passed</i><i className="coverage-category coverage-category-failing">Failures</i><i className="coverage-category coverage-category-not_run">Not run</i><i className="coverage-category coverage-category-none">No check</i></span>
      </div>
      {visible.length ? <ul className="history-runs">{visible.map((endpoint) => <li key={endpoint.key}>
        <button className="coverage-row" type="button" onClick={() => onOpenEndpoint(endpoint.operationIndex)}>
          <span className={`method-tag method-${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
          <span className="coverage-endpoint"><strong>{endpoint.path}</strong><small>{endpoint.summary || "API endpoint"}</small></span>
          <span className={`coverage-status coverage-status-${endpoint.status}`}>{statusLabels[endpoint.status]}</span>
          <span className="coverage-checks">{endpoint.coveredChecks}/{endpoint.runnableChecks} checks<small>{endpoint.lastRunAt ? `last run ${new Date(endpoint.lastRunAt).toLocaleString()}` : "never run"}</small></span>
          <span className="coverage-risks">
            <b className={`risk-score risk-score-${endpoint.risk.level}`} aria-label={`Risk score ${endpoint.risk.score} of 100, ${levelLabels[endpoint.risk.level]}`}>{endpoint.risk.score}<small>{levelLabels[endpoint.risk.level]}</small></b>
            {endpoint.risk.factors.map((factor) => <i key={factor.id} className={factorClass(factor)} title={factor.id === "flaky" ? endpoint.risks.find((risk) => risk.id === "flaky")?.detail : undefined}>+{factor.points} {factor.label}</i>)}
          </span>
          <Icon className="history-chevron" name="chevron" size={15} />
          <span className="coverage-categories" aria-label="Checks by category">{endpoint.categories.map((category) => <i key={category.id} className={`coverage-category coverage-category-${category.state}`} title={`${category.label}: ${categoryStates[category.state]}`}>{categoryShort[category.id]}</i>)}</span>
        </button>
        <GapDetails endpoint={endpoint} />
      </li>)}</ul> : <p className="coverage-empty">No endpoints match this filter.</p>}
    </section>
  </section>;
}
