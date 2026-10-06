import { useState } from "react";
import Icon from "./Icon.jsx";
import { groupRunsByApi, summarizeResults } from "./runDetail.js";

function CountSummary({ summary }) {
  return <span className="run-counts">
    <i className="history-pass">{summary.passed} passed</i>
    {summary.failed > 0 && <i className="history-fail">{summary.failed} failed</i>}
    {summary.errors > 0 && <i className="history-fail">{summary.errors} {summary.errors === 1 ? "error" : "errors"}</i>}
  </span>;
}

function DeleteConfirm({ message, onCancel, onConfirm }) {
  return <div className="history-confirm" role="group" aria-label="Confirm deletion">
    <span>{message}</span>
    <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
    <button className="danger-button" type="button" onClick={onConfirm}>Delete</button>
  </div>;
}

export default function RunHistoryList({ runs, savedApis, openGroups, onToggleGroup, onOpenRun, onDeleteRuns, onGoToSpecs }) {
  // Only one deletion can be pending at a time: { type: "group", key } or { type: "run", id }.
  const [pendingDelete, setPendingDelete] = useState(null);
  const groups = groupRunsByApi(runs, savedApis);
  const confirmDelete = (runIds) => {
    onDeleteRuns(runIds);
    setPendingDelete(null);
  };

  return <section className="history-page">
    <div className="page-eyebrow">TEST EXECUTIONS</div>
    <h1>Run history</h1>
    <p className="page-lede">Review the checks you have run in this browser, grouped by API.</p>

    {groups.length ? <div className="history-groups">{groups.map((group, index) => {
      const open = openGroups[group.key] ?? index === 0;
      const bodyId = `run-group-${index}`;
      const groupPending = pendingDelete?.type === "group" && pendingDelete.key === group.key;
      return <section className={`history-group ${open ? "open" : ""}`} key={group.key}>
        <div className="history-group-header">
          <button className="history-group-toggle" type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggleGroup(group.key, !open)}>
            <Icon className="history-group-chevron" name="chevron" size={16} />
            <span className="history-group-title">
              <strong>{group.api}</strong>
              <small>{group.runs.length} {group.runs.length === 1 ? "run" : "runs"} · last run {new Date(group.latestAt).toLocaleString()}</small>
            </span>
            <CountSummary summary={group.summary} />
          </button>
          <button className="icon-button" type="button" aria-label={`Delete all runs for ${group.api}`} title="Delete all runs for this API" onClick={() => setPendingDelete({ type: "group", key: group.key })}><Icon name="trash" size={16} /></button>
        </div>
        {groupPending && <DeleteConfirm
          message={`Delete all ${group.runs.length} ${group.runs.length === 1 ? "run" : "runs"} for ${group.api}? This cannot be undone. The saved API is not affected.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => confirmDelete(group.runs.map((run) => run.id))}
        />}
        {open && <ul className="history-runs" id={bodyId}>{group.runs.map((run) => {
          const summary = summarizeResults(run.results);
          const healthy = summary.failed + summary.errors === 0;
          const runPending = pendingDelete?.type === "run" && pendingDelete.id === run.id;
          return <li key={run.id}>
            <div className="history-run-item">
              <button className="history-run" type="button" onClick={() => onOpenRun(run.id)}>
                <span className={`history-run-dot ${healthy ? "pass" : "fail"}`} aria-hidden="true" />
                <span className="history-run-endpoint">{run.endpoint}</span>
                <span className="history-run-meta">{summary.total} {summary.total === 1 ? "check" : "checks"} · <CountSummary summary={summary} /></span>
                <time className="history-run-time">{new Date(run.createdAt).toLocaleString()}</time>
                <Icon className="history-chevron" name="chevron" size={15} />
              </button>
              <button className="icon-button" type="button" aria-label={`Delete run ${run.endpoint} from ${new Date(run.createdAt).toLocaleString()}`} title="Delete this run" onClick={() => setPendingDelete({ type: "run", id: run.id })}><Icon name="trash" size={15} /></button>
            </div>
            {runPending && <DeleteConfirm
              message="Delete this run and its evidence? This cannot be undone."
              onCancel={() => setPendingDelete(null)}
              onConfirm={() => confirmDelete([run.id])}
            />}
          </li>;
        })}</ul>}
      </section>;
    })}</div> : <div className="history-empty"><Icon name="clock" size={25} /><strong>No runs yet</strong><span>Run selected checks from an API overview and they will appear here.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>}
  </section>;
}
