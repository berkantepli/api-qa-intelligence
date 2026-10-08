import { useState } from "react";
import { BULK_MODES, planBulkRun } from "./bulkRun.js";
import Icon from "./Icon.jsx";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function EndpointList({ items, renderNote }) {
  return <ul className="bulk-endpoints">{items.map((item) => <li key={item.key}>
    <span className={`method-tag method-${item.method.toLowerCase()}`}>{item.method}</span>
    <code>{item.path}</code>
    {renderNote(item)}
  </li>)}</ul>;
}

// Plan and progress for running the checks of every endpoint in the current Coverage filter.
export default function BulkRunPanel({ overview, endpoints, filterLabel, inputsByOperation, filesByOperation, targetUrl, bulkRun, onRun, onStop, onClose, onOpenEndpoint }) {
  const [mode, setMode] = useState("all");
  const [includeWrites, setIncludeWrites] = useState(false);
  // Running data-changing checks needs a second, explicit confirmation.
  const [confirmingWrites, setConfirmingWrites] = useState(false);

  if (bulkRun) {
    const { status, total, done, counts, current, message } = bulkRun;
    const percent = total ? Math.round((done / total) * 100) : 0;
    const finished = status !== "running";
    const heading = { running: "Running checks…", done: "Bulk run finished", stopped: "Bulk run stopped", error: "Bulk run stopped by an error" }[status];
    return <section className="bulk-run" aria-live="polite">
      <div className="bulk-run-header">
        <div><strong>{heading}</strong><span>{done} / {total} checks · {counts.PASS} passed · {counts.FAIL} failed · {counts.ERROR} errors</span></div>
        {finished
          ? <button className="secondary-button" type="button" onClick={onClose}>Close</button>
          : <button className="secondary-button" type="button" onClick={onStop}>Stop</button>}
      </div>
      <span className="coverage-meter" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      {current && <small className="bulk-run-current">{current}</small>}
      {message && <p className="history-error">{message}</p>}
      {finished && <small className="bulk-run-note">Each endpoint’s results are saved in Run history, and the coverage below is updated.</small>}
    </section>;
  }

  const plan = planBulkRun(overview, endpoints, { inputsByOperation, filesByOperation, mode, includeWrites });
  const writeEndpoints = plan.ready.filter((item) => item.writes);
  const start = () => (plan.writeCount && !confirmingWrites ? setConfirmingWrites(true) : onRun(plan));
  return <section className="bulk-run">
    <div className="bulk-run-header">
      <div><strong>Run checks for “{filterLabel}”</strong><span>{plural(endpoints.length, "endpoint")} in this filter · requests go to <code>{targetUrl || "no target URL"}</code></span></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close bulk run"><Icon name="close" size={15} /></button>
    </div>

    <div className="bulk-modes" role="radiogroup" aria-label="Checks to run">
      {Object.entries(BULK_MODES).map(([id, label]) => <label key={id} className={mode === id ? "selected" : ""}>
        <input type="radio" name="bulk-mode" value={id} checked={mode === id} onChange={() => { setMode(id); setConfirmingWrites(false); }} />{label}
      </label>)}
    </div>
    <label className="bulk-writes-toggle">
      <input type="checkbox" checked={includeWrites} onChange={(event) => { setIncludeWrites(event.target.checked); setConfirmingWrites(false); }} />
      <span><strong>Include data-changing endpoints</strong><small>POST, PUT, PATCH, and DELETE checks can create, change, or delete real data in the target API. They run after read-only checks, with deletes last.</small></span>
    </label>

    {plan.ready.length > 0 && <div className="bulk-group bulk-group-ready">
      <strong><Icon name="check" size={14} />Ready · {plural(plan.ready.length, "endpoint")}</strong>
      <EndpointList items={plan.ready} renderNote={(item) => <>
        <small>{plural(item.checks.length, "check")}</small>
        {item.writes && <i className="coverage-risk coverage-risk-untested-write">Changes data</i>}
      </>} />
    </div>}
    {plan.needsInput.length > 0 && <div className="bulk-group bulk-group-input">
      <strong>Needs request details · skipped</strong>
      <EndpointList items={plan.needsInput} renderNote={(item) => <>
        <small>Missing {item.missing.join(", ")}</small>
        <button className="link-button" type="button" onClick={() => onOpenEndpoint(item.operationIndex)}>Open</button>
      </>} />
    </div>}
    {plan.dataChanging.length > 0 && <details className="bulk-group bulk-group-write">
      <summary><strong>Changes data · {plural(plan.dataChanging.length, "endpoint")} not included</strong></summary>
      <small className="bulk-group-note">POST, PUT, PATCH, and DELETE can create or delete real data. Turn on “Include data-changing endpoints” above to run them too, or run them from the endpoint page.</small>
      <EndpointList items={plan.dataChanging} renderNote={(item) => <button className="link-button" type="button" onClick={() => onOpenEndpoint(item.operationIndex)}>Open</button>} />
    </details>}
    {plan.noChecks.length > 0 && <small className="bulk-group-note">{plural(plan.noChecks.length, "endpoint")} without a runnable check {plan.noChecks.length === 1 ? "is" : "are"} left out.</small>}

    {confirmingWrites && <div className="execution-confirmation" role="alert">
      <div><strong>This run will change data.</strong><p>{plural(plan.writeCount, "check")} on {plural(writeEndpoints.length, "data-changing endpoint")} ({[...new Set(writeEndpoints.map((item) => item.method))].join(", ")}) will be sent to <code>{targetUrl}</code>. They can create, update, or delete data there. Use a test environment, not production.</p></div>
      <div className="execution-confirmation-actions"><button className="secondary-button" type="button" onClick={() => setConfirmingWrites(false)}>Cancel</button><button className="primary-button" type="button" onClick={() => onRun(plan)}>Confirm and run</button></div>
    </div>}
    <div className="bulk-run-actions">
      <button className="primary-button" type="button" disabled={!plan.checkCount || !targetUrl || confirmingWrites} onClick={start}>
        <Icon name="run" size={14} />{plan.checkCount ? `Run ${plural(plan.checkCount, "check")} on ${plural(plan.ready.length, "endpoint")}` : "Nothing ready to run"}
      </button>
      <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
    </div>
  </section>;
}
