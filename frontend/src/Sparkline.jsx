// A row-sized line of an endpoint's latest runs: median response time per run, failed runs marked.
const WIDTH = 84;
const HEIGHT = 20;
const PAD = 3;

const formatMs = (value) => value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;

export function sparklineLabel(runs) {
  const failed = runs.filter((run) => run.failed).length;
  const timed = runs.map((run) => run.medianMs).filter((value) => value != null);
  const range = timed.length ? `, ${formatMs(Math.min(...timed))} to ${formatMs(Math.max(...timed))}` : "";
  return `Last ${runs.length} ${runs.length === 1 ? "run" : "runs"}: ${failed} failed${range}`;
}

export default function Sparkline({ runs = [] }) {
  if (runs.length < 2) return null;
  const max = Math.max(1, ...runs.map((run) => run.medianMs ?? 0));
  const x = (index) => PAD + (index / (runs.length - 1)) * (WIDTH - 2 * PAD);
  const y = (value) => HEIGHT - PAD - ((value ?? 0) / max) * (HEIGHT - 2 * PAD);
  const timed = runs.map((run, index) => run.medianMs == null ? null : `${x(index)},${y(run.medianMs)}`).filter(Boolean);
  const label = sparklineLabel(runs);
  return <svg className="sparkline" width={WIDTH} height={HEIGHT} role="img" aria-label={label}>
    <title>{label}</title>
    {timed.length > 1 && <polyline points={timed.join(" ")} />}
    {runs.map((run, index) => (run.failed || index === runs.length - 1) && <circle key={index} className={run.failed ? "sparkline-failed" : undefined} cx={x(index)} cy={y(run.medianMs)} r={2.5} />)}
  </svg>;
}
