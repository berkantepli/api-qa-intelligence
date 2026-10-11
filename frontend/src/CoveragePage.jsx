import { useRef, useState } from "react";
import { computeCoverage, coverageReportFileName, coverageReportJson, coverageReportMarkdown } from "./coverage.js";
import BulkRunPanel from "./BulkRunPanel.jsx";
import { staleChecks } from "./contractDiff.js";
import { GAP_KINDS } from "./coverageGaps.js";
import ErrorAlert from "./ErrorAlert.jsx";
import Icon from "./Icon.jsx";
import { RISK_LEVELS, RISK_RULES } from "./riskScore.js";

const statusLabels = { failing: "Failing", untested: "Not tested", passing: "Passing" };
const filters = [
  { id: "all", label: "All", matches: () => true },
  { id: "attention", label: "Needs attention", matches: (endpoint) => endpoint.risks.length > 0 },
  { id: "high", label: "High risk", matches: (endpoint) => endpoint.risk.level === "high", optional: true },
  { id: "changed", label: "Changed", matches: (endpoint) => Boolean(endpoint.contractChange), optional: true },
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

function ContractChanges({ changes, endpoints, overview }) {
  if (!changes) return null;
  const stale = staleChecks(overview);
  const pending = new Set(endpoints.filter((endpoint) => endpoint.contractChange).map((endpoint) => endpoint.key));
  const version = changes.fromVersion !== changes.toVersion ? ` · ${changes.fromVersion} → ${changes.toVersion}` : "";
  const status = (key) => pending.has(key) ? <i className="coverage-risk coverage-risk-contract-changed">Not run since</i> : <i className="coverage-category coverage-category-passing">Run since</i>;
  return <details className="contract-changes" open={pending.size > 0}>
    <summary>Contract changes since the previous import<small>{version} · imported {new Date(changes.comparedAt).toLocaleString()}</small></summary>
    <ul>
      {changes.added.map((key) => <li key={`added-${key}`}><b className="contract-change-new">New</b><code>{key}</code>{status(key)}</li>)}
      {changes.changed.map((item) => <li key={`changed-${item.key}`}><b className="contract-change-changed">Changed</b><code>{item.key}</code>{status(item.key)}
        <ul>{item.changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </li>)}
      {changes.removed.map((key) => <li key={`removed-${key}`}><b className="contract-change-removed">Removed</b><code>{key}</code></li>)}
    </ul>
    {changes.droppedChecks > 0 && <p>{changes.droppedChecks} saved AI {changes.droppedChecks === 1 ? "check was" : "checks were"} dropped with the removed endpoints.</p>}
    {stale.length > 0 ? <div className="stale-check">
      <strong>{stale.length} saved AI {stale.length === 1 ? "check needs" : "checks need"} a review</strong>
      <ul>{stale.map((item) => <li key={`${item.key}-${item.title}`}><code>{item.key}</code> · {item.title}: {item.reasons.join("; ")}</li>)}</ul>
    </div> : <p>Every saved AI check still fits the current contract.</p>}
    <p>A changed endpoint adds +15 to its risk score until it runs again; a new one counts as never tested.</p>
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
  inputsByOperation, filesByOperation, targetUrl, targetProblem, bulkRun, onBulkRun, onStopBulkRun, onDismissBulkRun, onImportCliReport, contractChanges,
  lifecycle = null, onOpenFlows,
}) {
  const [filterId, setFilterId] = useState("all");
  const [importMessage, setImportMessage] = useState(null);
  const reportInput = useRef(null);
  async function importCliReport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const result = onImportCliReport(await file.text());
      const text = result.otherApi ? `${result.message} Open ${result.otherApi} to see its coverage.` : result.message;
      setImportMessage({ tone: "success", text });
    } catch (caught) {
      setImportMessage({ tone: "error", text: caught.message || "The report could not be imported." });
    }
  }
  const [planning, setPlanning] = useState(false);
  if (!overview) {
    return <section className="history-page coverage-page">
      <div className="page-eyebrow">TEST COVERAGE</div>
      <h1>Coverage &amp; Risk</h1>
      <div className="history-empty"><Icon name="shield" size={25} /><strong>No active API</strong><span>Import or open an API to see which endpoints have been tested.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>
    </section>;
  }

  const { endpoints, totals } = computeCoverage(overview, apiRuns, Date.now(), contractChanges, lifecycle);
  const flowTotals = lifecycle?.totals;
  const filter = filters.find((item) => item.id === filterId) ?? filters[0];
  const visible = endpoints.filter(filter.matches);
  const exportReport = (format) => {
    const coverage = { endpoints, totals, contractChanges };
    if (format === "md") download(coverageReportMarkdown(overview, coverage), coverageReportFileName(overview.title, "md"), "text/markdown");
    else download(JSON.stringify(coverageReportJson(overview, coverage), null, 2), coverageReportFileName(overview.title, "json"), "application/json");
  };

  return <section className="history-page coverage-page">
    <div className="page-eyebrow">TEST COVERAGE</div>
    <h1>Coverage &amp; Risk</h1>
    <div className="coverage-heading">
      <p className="page-lede">{overview.title} · based on {totals.checksExecuted} {totals.checksExecuted === 1 ? "check" : "checks"} in Run history.</p>
      <div className="coverage-export">
        <button className="secondary-button" type="button" onClick={() => reportInput.current?.click()} title="Add the checks from an api-qa run --json report"><Icon name="upload" size={14} /> Import CI report</button>
        <input ref={reportInput} type="file" accept="application/json,.json" hidden onChange={importCliReport} />
        <button className="secondary-button" type="button" onClick={() => exportReport("md")}><Icon name="arrow" size={14} /> Export Markdown</button>
        <button className="secondary-button" type="button" onClick={() => exportReport("json")}><Icon name="arrow" size={14} /> Export JSON</button>
      </div>
    </div>

    {importMessage?.tone === "error" && <ErrorAlert message={importMessage.text} />}
    {importMessage?.tone === "success" && <div className="alert success-alert" role="status"><Icon name="check" size={16} /><span>{importMessage.text}</span></div>}

    <div className="stats-row coverage-stats">
      <div className="stat-card"><span className="stat-label">Endpoints tested</span><strong>{totals.tested} / {totals.endpoints}</strong><span className="stat-note">{totals.coveragePercent}% coverage</span><span className="coverage-meter" aria-hidden="true"><span style={{ width: `${totals.coveragePercent}%` }} /></span></div>
      <div className="stat-card"><span className="stat-label">Failing endpoints</span><strong className={totals.failing ? "history-fail" : undefined}>{totals.failing}</strong><span className="stat-note">in their latest run</span></div>
      <div className="stat-card"><span className="stat-label">Untested write endpoints</span><strong className={totals.untestedWrites ? "coverage-warning" : undefined}>{totals.untestedWrites}</strong><span className="stat-note">POST, PUT, PATCH, DELETE</span></div>
      <button className="stat-card stat-card-link" type="button" onClick={() => setFilterId("high")} title="Show high-risk endpoints"><span className="stat-label">High-risk endpoints</span><strong className={totals.highRisk ? "history-fail" : undefined}>{totals.highRisk}</strong><span className="stat-note">risk score {RISK_LEVELS[0].min} or more</span></button>
      {flowTotals?.flows > 0 && <button className="stat-card stat-card-link" type="button" onClick={onOpenFlows} title="Open Flows"><span className="stat-label">Lifecycle flows passing</span><strong className={flowTotals.failing ? "history-fail" : undefined}>{flowTotals.passing} / {flowTotals.flows}</strong><span className="stat-note">{[flowTotals.failing && `${flowTotals.failing} failing`, flowTotals.untested && `${flowTotals.untested} never run`].filter(Boolean).join(" · ") || "all passing in their latest run"}</span></button>}
    </div>

    <ContractChanges changes={contractChanges} endpoints={endpoints} overview={overview} />

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
            {endpoint.risk.factors.map((factor) => <i key={factor.id} className={factorClass(factor)} title={endpoint.risks.find((risk) => risk.id === factor.id)?.detail}>+{factor.points} {factor.label}</i>)}
          </span>
          <Icon className="history-chevron" name="chevron" size={15} />
          <span className="coverage-categories" aria-label="Checks by category">{endpoint.categories.map((category) => <i key={category.id} className={`coverage-category coverage-category-${category.state}`} title={`${category.label}: ${categoryStates[category.state]}`}>{categoryShort[category.id]}</i>)}</span>
        </button>
        <GapDetails endpoint={endpoint} />
      </li>)}</ul> : <p className="coverage-empty">No endpoints match this filter.</p>}
    </section>
  </section>;
}
