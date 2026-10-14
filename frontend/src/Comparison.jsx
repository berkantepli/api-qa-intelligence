import { useEffect, useState } from "react";
import { postJson } from "./apiClient.js";
import ErrorAlert from "./ErrorAlert.jsx";
import Icon from "./Icon.jsx";
import { checkRecords, comparisonBaselines } from "./runCompare.js";

const GROUPS = [
  { id: "newly_failing", label: "Newly failing", tone: "fail", empty: "Nothing broke." },
  { id: "fixed", label: "Fixed", tone: "pass" },
  { id: "still_failing", label: "Still failing", tone: "fail" },
  { id: "slower", label: "Slower", tone: "warn" },
  { id: "only_after", label: "Only in the later results", tone: "muted" },
  { id: "only_before", label: "Only in the earlier results", tone: "muted" },
];

function detail(group, item) {
  const { before, after } = item;
  if (group === "slower") return `${before.duration_ms} ms → ${after.duration_ms} ms`;
  if (group === "newly_failing" || group === "fixed") return `${before.result} → ${after.result}${after.message ? ` · ${after.message}` : ""}`;
  if (group === "still_failing") return `${after.message}${item.message_changed ? " (a different reason than before)" : ""}`;
  return (after ?? before).result;
}

// The groups of a comparison; each row opens the run its latest result came from.
export function ComparisonResult({ comparison, onOpenRun }) {
  const shown = GROUPS.filter((group) => comparison[group.id].length || group.empty);
  return <div className="comparison-result">
    {shown.map((group) => <div className={`comparison-group comparison-${group.tone}`} key={group.id}>
      <strong><span className="comparison-count">{comparison[group.id].length}</span> {group.label}</strong>
      {comparison[group.id].length ? <ul>{comparison[group.id].map((item) => {
        const runId = (item.after ?? item.before)?.run_id;
        return <li key={`${item.endpoint}-${item.title}`}>
          {onOpenRun && runId
            ? <button className="text-button" type="button" onClick={() => onOpenRun(runId)}><code>{item.endpoint}</code> · {item.title}</button>
            : <span><code>{item.endpoint}</code> · {item.title}</span>}
          <small>{detail(group.id, item)}</small>
        </li>;
      })}</ul> : <small>{group.empty}</small>}
    </div>)}
    <p className="comparison-unchanged">{comparison.unchanged_passing} {comparison.unchanged_passing === 1 ? "check" : "checks"} passed both times without slowing down.</p>
  </div>;
}

export function compareRecords(before, after) {
  return postJson("/api/v1/runs/compare", { before, after }, "The results could not be compared.");
}

// Coverage & Risk: the API's current results against an earlier moment.
export default function ComparePanel({ runs, onOpenRun, onClose, onComparison }) {
  const baselines = comparisonBaselines(runs);
  const [baselineId, setBaselineId] = useState(baselines.find((baseline) => baseline.available)?.id ?? "previous");
  const [state, setState] = useState({ loading: false, error: "", comparison: null });
  const baseline = baselines.find((item) => item.id === baselineId);
  const runKey = runs.map((run) => run.id).join(",");

  useEffect(() => {
    if (!baseline?.available) {
      setState({ loading: false, error: "", comparison: null });
      onComparison?.(null);
      return undefined;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: "" }));
    compareRecords(checkRecords(baseline.before), checkRecords(runs))
      .then((comparison) => {
        if (cancelled) return;
        setState({ loading: false, error: "", comparison });
        onComparison?.({ comparison, label: baseline.description });
      })
      .catch((caught) => { if (!cancelled) setState({ loading: false, error: caught.message, comparison: null }); });
    return () => { cancelled = true; };
    // Recompare when the baseline or the runs change.
  }, [baselineId, runKey]);

  return <section className="compare-panel" aria-label="Compare results">
    <div className="compare-panel-heading">
      <div><h2>What changed</h2><p>Each check's latest result now, against its latest result at an earlier moment.</p></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close comparison" title="Close"><Icon name="close" size={16} /></button>
    </div>
    <div className="compare-baselines" role="radiogroup" aria-label="Compare with">
      <span>Compare with</span>
      {baselines.map((item) => <label key={item.id} className={item.available ? "" : "disabled"} title={item.available ? item.description : "No checks ran before this moment."}>
        <input type="radio" name="compare-baseline" value={item.id} checked={baselineId === item.id} disabled={!item.available} onChange={() => setBaselineId(item.id)} /> {item.label}
      </label>)}
    </div>
    {!baseline?.available && <p className="compare-note">No checks ran before this moment, so there is nothing to compare with yet. Run the checks again later, or pick another moment.</p>}
    {state.loading && <p className="compare-note"><span className="spinner" /> Comparing…</p>}
    <ErrorAlert message={state.error} />
    {state.comparison && !state.loading && <>
      <p className="compare-note">Compared with {baseline.description}.</p>
      <ComparisonResult comparison={state.comparison} onOpenRun={onOpenRun} />
    </>}
  </section>;
}
