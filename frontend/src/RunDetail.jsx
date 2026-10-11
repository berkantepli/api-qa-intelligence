import { categoryLabels } from "./categories.js";
import ErrorAlert from "./ErrorAlert.jsx";
import Icon from "./Icon.jsx";
import {
  formatEvidenceBody,
  hasRequestEvidence,
  hasResponseEvidence,
  outcomeSummary,
  requestLine,
  sortedHeaders,
  summarizeResults,
} from "./runDetail.js";
import { ROLE_LABELS } from "./flows.js";
import { isEditedScenario } from "./scenarioDraft.js";

function HeaderTable({ headers }) {
  const rows = sortedHeaders(headers);
  if (!rows.length) return <p className="evidence-empty">No headers recorded.</p>;
  return <table className="evidence-headers"><tbody>
    {rows.map(([name, value]) => <tr key={name}><th scope="row">{name}</th><td className={value === "[REDACTED]" ? "redacted" : undefined}>{value}</td></tr>)}
  </tbody></table>;
}

function EvidenceBody({ text, emptyLabel }) {
  const body = formatEvidenceBody(text);
  return body ? <pre className="evidence-body">{body}</pre> : <p className="evidence-empty">{emptyLabel}</p>;
}

function FailureAnalysis({ analysis }) {
  return <div className="failure-analysis">
    <div className="failure-analysis-title"><Icon name="spark" size={15} /><strong>AI failure analysis</strong><span>Advisory</span></div>
    <p>{analysis.summary}</p>
    {analysis.likely_causes?.length > 0 && <div><strong>Possible causes</strong><ul>{analysis.likely_causes.map((cause, index) => <li key={index}><b>{cause.cause}</b><span>{cause.evidence} · Confidence: {cause.confidence}</span></li>)}</ul></div>}
    {analysis.next_steps?.length > 0 && <div><strong>Suggested next steps</strong><ul>{analysis.next_steps.map((step, index) => <li key={index}>{step}</li>)}</ul></div>}
    <small>{analysis.limitations}</small>
  </div>;
}

// The documented-schema differences behind a FAIL whose status code was the expected one.
export function SchemaDifferences({ check }) {
  if (check?.status !== "failed" || !check.errors?.length) return null;
  return <div className="schema-differences">
    <strong>Response body differs from the contract</strong>
    <ul>{check.errors.map((error) => <li key={error}><code>{error}</code></li>)}</ul>
  </div>;
}

function CheckDetail({ result, index, analysisStatus, onAnalyze }) {
  const outcome = result.result || "ERROR";
  if (outcome === "SKIPPED") {
    return <div className="run-check run-check-skipped">
      <div className="run-check-summary">
        <span className="history-status status-skipped">SKIPPED</span>
        <span className="run-check-title"><strong>{result.title || `Step ${index + 1}`}</strong></span>
        <span className="run-check-meta">{result.reason}</span>
      </div>
    </div>;
  }
  const savedValues = Object.entries(result.saved_values ?? {});
  return <details className={`run-check run-check-${outcome.toLowerCase()}`} open={outcome !== "PASS"}>
    <summary className="run-check-summary">
      <span className={`history-status status-${outcome.toLowerCase()}`}>{outcome}</span>
      <span className="run-check-title">
        <strong>{result.title || `Check ${index + 1}`}</strong>
        <span className="run-check-pills">
          {result.category && <span className={`category-pill category-${result.category}`}>{categoryLabels[result.category] || result.category}</span>}
          {isEditedScenario(result) && <span className="edited-pill">AI idea · edited</span>}
          {result.role && <span className="review-pill">{ROLE_LABELS[result.role] ?? result.role}</span>}
        </span>
      </span>
      <span className="run-check-meta">{result.response_status != null ? `HTTP ${result.response_status}` : "No response"}{result.duration_ms != null && ` · ${result.duration_ms} ms`}</span>
      <Icon className="run-check-chevron" name="chevron" size={16} />
    </summary>

    <div className="run-check-body">
      <dl className="run-facts">
        <div><dt>Expected</dt><dd>{result.expected_status_codes?.join(", ") || "—"}</dd></div>
        <div><dt>Received</dt><dd>{result.response_status ?? "—"}</dd></div>
        <div><dt>Duration</dt><dd>{result.duration_ms != null ? `${result.duration_ms} ms` : "—"}</dd></div>
        <div><dt>Method</dt><dd>{result.method || "—"}</dd></div>
      </dl>
      <p className={`run-outcome run-outcome-${outcome.toLowerCase()}`}>{outcomeSummary(result)}</p>
      {result.error && <p className="history-error">{result.error}</p>}
      {savedValues.length > 0 && <p className="flow-saved-values">Saved for later steps: {savedValues.map(([name, value]) => <code key={name} className="flow-saved">{name} = {String(value)}</code>)}</p>}
      <SchemaDifferences check={result.schema_check} />

      <div className="evidence-grid">
        <section className="evidence-panel" aria-label="Request evidence">
          <h3>Request</h3>
          {hasRequestEvidence(result) ? <>
            <code className="evidence-line">{requestLine(result)}</code>
            <h4>Headers</h4>
            <HeaderTable headers={result.request_headers} />
            <h4>Body</h4>
            <EvidenceBody text={result.request_body} emptyLabel="No request body was sent." />
          </> : <p className="evidence-empty">This run was saved before request evidence was recorded.</p>}
        </section>
        <section className="evidence-panel" aria-label="Response evidence">
          <h3>Response</h3>
          {hasResponseEvidence(result) ? <>
            <code className="evidence-line">{result.response_status != null ? `HTTP ${result.response_status}` : "No status"}</code>
            <h4>Headers</h4>
            <HeaderTable headers={result.response_headers} />
            <h4>Body{result.response_truncated && <span className="evidence-note">truncated</span>}</h4>
            <EvidenceBody text={result.response_body} emptyLabel="The response had no body." />
          </> : <p className="evidence-empty">No response was received from the target API.</p>}
        </section>
      </div>

      {outcome === "FAIL" && !result.analysis && <div className="failure-analysis-action">
        <button className="secondary-button" type="button" disabled={analysisStatus.loading} onClick={onAnalyze}><Icon name="spark" size={14} />{analysisStatus.loading ? "Analyzing with AI…" : "Analyze with AI"}</button>
        <span>Credential-like values are redacted. Clicking sends this check’s evidence to your configured Ollama model.</span>
      </div>}
      <ErrorAlert message={analysisStatus.error} />
      {result.analysis && <FailureAnalysis analysis={result.analysis} />}
    </div>
  </details>;
}

export default function RunDetail({ run, analysisState, onAnalyze, onBack, onRerun, canRerun }) {
  const summary = summarizeResults(run.results);
  const flow = run.kind === "flow";
  return <section className="history-page run-detail">
    <button className="back-link" type="button" onClick={onBack}><Icon name="back" size={15} /> Run history</button>
    <div className="page-eyebrow">{flow ? "FLOW RUN DETAILS" : "RUN DETAILS"}</div>
    <div className="run-detail-heading">
      <div>
        <h1 className={flow ? undefined : "run-detail-endpoint"}>{run.endpoint}</h1>
        <p className="page-lede">{run.api} · {new Date(run.createdAt).toLocaleString()}{run.source === "cli" && <> · <i className="run-source-badge">CI</i> from an api-qa run report{run.toolVersion ? ` (api-qa ${run.toolVersion})` : ""}</>}</p>
      </div>
      {canRerun && <button className="secondary-button" type="button" onClick={onRerun} title={flow ? "Open this API's flows" : "Open this endpoint with the same checks selected"}><Icon name="run" size={14} /> Run again</button>}
    </div>

    <div className="run-summary">
      <div><span>Target</span><strong title={run.target}>{run.target}</strong></div>
      <div><span>{flow ? "Steps" : "Checks"}</span><strong>{summary.total}</strong></div>
      <div><span>Passed</span><strong className="history-pass">{summary.passed}</strong></div>
      <div><span>Failed</span><strong className={summary.failed ? "history-fail" : undefined}>{summary.failed}</strong></div>
      <div><span>Errors</span><strong className={summary.errors ? "history-fail" : undefined}>{summary.errors}</strong></div>
      {summary.skipped > 0 && <div><span>Skipped</span><strong>{summary.skipped}</strong></div>}
    </div>
    <p className="run-redaction-note"><Icon name="shield" size={14} /> Credential-like headers, query values, and body fields were redacted before this run was saved. Uploaded file contents are not stored.</p>

    <div className="run-checks">
      {run.results.map((result, index) => <CheckDetail
        key={`${result.title || "check"}-${index}`}
        result={result}
        index={index}
        analysisStatus={analysisState[`${run.id}:${index}`] ?? {}}
        onAnalyze={() => onAnalyze(run.id, index, result)}
      />)}
    </div>
  </section>;
}
