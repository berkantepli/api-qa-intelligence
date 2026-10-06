import Icon from "./Icon.jsx";
import { groupRunsByApi, summarizeResults } from "./runDetail.js";

function CountSummary({ summary }) {
  return <span className="run-counts">
    <i className="history-pass">{summary.passed} passed</i>
    {summary.failed > 0 && <i className="history-fail">{summary.failed} failed</i>}
    {summary.errors > 0 && <i className="history-fail">{summary.errors} {summary.errors === 1 ? "error" : "errors"}</i>}
  </span>;
}

export default function RunHistoryList({ runs, savedApis, openGroups, onToggleGroup, onOpenRun, onGoToSpecs }) {
  const groups = groupRunsByApi(runs, savedApis);
  return <section className="history-page">
    <div className="page-eyebrow">TEST EXECUTIONS</div>
    <h1>Run history</h1>
    <p className="page-lede">Review the checks you have run in this browser, grouped by API.</p>

    {groups.length ? <div className="history-groups">{groups.map((group, index) => {
      const open = openGroups[group.key] ?? index === 0;
      const bodyId = `run-group-${index}`;
      return <section className={`history-group ${open ? "open" : ""}`} key={group.key}>
        <button className="history-group-header" type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggleGroup(group.key, !open)}>
          <Icon className="history-group-chevron" name="chevron" size={16} />
          <span className="history-group-title">
            <strong>{group.api}</strong>
            <small>{group.runs.length} {group.runs.length === 1 ? "run" : "runs"} · last run {new Date(group.latestAt).toLocaleString()}</small>
          </span>
          <CountSummary summary={group.summary} />
        </button>
        {open && <ul className="history-runs" id={bodyId}>{group.runs.map((run) => {
          const summary = summarizeResults(run.results);
          const healthy = summary.failed + summary.errors === 0;
          return <li key={run.id}>
            <button className="history-run" type="button" onClick={() => onOpenRun(run.id)}>
              <span className={`history-run-dot ${healthy ? "pass" : "fail"}`} aria-hidden="true" />
              <span className="history-run-endpoint">{run.endpoint}</span>
              <span className="history-run-meta">{summary.total} {summary.total === 1 ? "check" : "checks"} · <CountSummary summary={summary} /></span>
              <time className="history-run-time">{new Date(run.createdAt).toLocaleString()}</time>
              <Icon className="history-chevron" name="chevron" size={15} />
            </button>
          </li>;
        })}</ul>}
      </section>;
    })}</div> : <div className="history-empty"><Icon name="clock" size={25} /><strong>No runs yet</strong><span>Run selected checks from an API overview and they will appear here.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>}
  </section>;
}
