import { useEffect, useMemo, useRef, useState } from "react";
import { dailyTrend, TREND_RANGES, trendEndpoints, trendSamples, trendSummary } from "./trends.js";

const HEIGHT = 168;
const MARGIN = { top: 10, right: 14, bottom: 24, left: 44 };
const shortDate = (date) => date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const formatMs = (value) => value == null ? "–" : value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} s` : `${Math.round(value)} ms`;
const formatRate = (value) => value == null ? "–" : `${value}%`;

// A round upper bound for the axis, such as 250, 500, or 2,000 ms.
function niceMax(value) {
  if (!value) return 100;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * step).find((candidate) => candidate >= value);
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Lines split at days without checks; a day on its own is a dot.
function segments(points) {
  const runs = [];
  let current = [];
  for (const point of points) {
    if (point) current.push(point);
    else if (current.length) { runs.push(current); current = []; }
  }
  if (current.length) runs.push(current);
  return runs;
}

function LineChart({ label, days, series, yMax, formatValue, tooltipRows }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (index) => MARGIN.left + (days.length > 1 ? (index / (days.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value) => MARGIN.top + plotHeight - (value / yMax) * plotHeight;
  const ticks = [0, yMax / 2, yMax];
  const labelDays = [0, Math.floor((days.length - 1) / 2), days.length - 1];

  const pick = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const share = (event.clientX - box.left - MARGIN.left) / (plotWidth || 1);
    setHover(Math.min(days.length - 1, Math.max(0, Math.round(share * (days.length - 1)))));
  };
  const hovered = hover == null ? null : days[hover];

  return <div className="trend-chart" ref={ref}>
    {width > 0 && <svg width={width} height={HEIGHT} role="img" aria-label={label} onMouseMove={pick} onMouseLeave={() => setHover(null)}>
      {ticks.map((tick) => <g key={tick}>
        <line className="trend-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
        <text className="trend-axis" x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{formatValue(tick)}</text>
      </g>)}
      {[...new Set(labelDays)].map((index) => <text key={index} className="trend-axis" x={x(index)} y={HEIGHT - 6} textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}>{shortDate(days[index].date)}</text>)}
      {hovered && <line className="trend-crosshair" x1={x(hover)} x2={x(hover)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />}
      {series.map((item) => {
        const points = days.map((day, index) => item.value(day) == null ? null : [x(index), y(item.value(day))]);
        return <g key={item.id} className={`trend-series ${item.className}`}>
          {segments(points).filter((run) => run.length > 1).map((run) => <polyline key={run[0][0]} points={run.map((point) => point.join(",")).join(" ")} />)}
          {points.map((point, index) => point && <circle key={index} cx={point[0]} cy={point[1]} r={hover === index ? 5 : 4} />)}
        </g>;
      })}
    </svg>}
    {hovered && <div className={`trend-tooltip ${x(hover) > width / 2 ? "trend-tooltip-left" : ""}`} style={{ left: x(hover) }} role="status">
      <strong>{shortDate(hovered.date)}</strong>
      {hovered.total ? tooltipRows(hovered).map(([key, text, className]) => <span key={key}>{className && <i className={`trend-key ${className}`} aria-hidden="true" />}{text}</span>) : <span>No checks ran</span>}
    </div>}
  </div>;
}

function Delta({ current, previous, format, lowerIsBetter = false, days }) {
  if (current == null) return <small>No checks in the last {days} days</small>;
  if (previous == null) return <small>No checks in the {days} days before</small>;
  const change = current - previous;
  if (!change) return <small>Same as the {days} days before</small>;
  const better = lowerIsBetter ? change < 0 : change > 0;
  return <small className={better ? "trend-better" : "trend-worse"}>{change > 0 ? "▲" : "▼"} {format(Math.abs(change))} vs the {days} days before</small>;
}

export default function TrendsPanel({ overview, runs }) {
  const [days, setDays] = useState(30);
  const [endpoint, setEndpoint] = useState("");
  const samples = useMemo(() => trendSamples(overview, runs), [overview, runs]);
  const endpoints = useMemo(() => trendEndpoints(samples), [samples]);
  const selected = endpoints.includes(endpoint) ? endpoint : "";
  const now = new Date();
  const trend = dailyTrend(samples, { days, now, endpoint: selected || null });
  const { current, previous } = trendSummary(samples, { days, now, endpoint: selected || null });
  const ran = trend.some((day) => day.total);
  const timed = trend.some((day) => day.timed);
  const latencyMax = niceMax(Math.max(0, ...trend.map((day) => day.p95Ms ?? 0)));

  return <section className="panel trends-panel" aria-labelledby="trends-title">
    <div className="trends-heading">
      <div><h2 id="trends-title">Trends</h2><p>Every check and flow step in Run history, per day.</p></div>
      <div className="trends-filters">
        <select aria-label="Endpoint" value={selected} onChange={(event) => setEndpoint(event.target.value)}>
          <option value="">All endpoints</option>
          {endpoints.map((key) => <option key={key} value={key}>{key}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Time range">
          {TREND_RANGES.map((range) => <button key={range} type="button" aria-pressed={range === days} className={range === days ? "selected" : ""} onClick={() => setDays(range)}>{range} days</button>)}
        </div>
      </div>
    </div>
    {!samples.length ? <p className="trends-empty">Run checks or flows to see how the pass rate and response times change over time.</p> : <>
      <div className="trends-grid">
        <div className="trend-card">
          <div className="trend-card-heading"><span>Pass rate</span><strong>{formatRate(current.passRate)}</strong><Delta current={current.passRate} previous={previous.passRate} format={(value) => `${value} pts`} days={days} /></div>
          {ran ? <LineChart label={`Daily pass rate, last ${days} days`} days={trend} yMax={100} formatValue={(value) => `${value}%`}
            series={[{ id: "rate", className: "trend-series-1", value: (day) => day.passRate }]}
            tooltipRows={(day) => [["rate", `${day.passRate}% passed`], ["count", `${day.passed} of ${day.total} checks`]]} />
            : <p className="trends-empty">No checks ran in the last {days} days.</p>}
        </div>
        <div className="trend-card">
          <div className="trend-card-heading"><span>Response time · median</span><strong>{formatMs(current.medianMs)}</strong><Delta current={current.medianMs} previous={previous.medianMs} format={formatMs} lowerIsBetter days={days} /></div>
          {timed ? <>
            <LineChart label={`Daily median and 95th percentile response time, last ${days} days`} days={trend} yMax={latencyMax} formatValue={formatMs}
              series={[{ id: "median", className: "trend-series-1", value: (day) => day.medianMs }, { id: "p95", className: "trend-series-2", value: (day) => day.p95Ms }]}
              tooltipRows={(day) => day.timed ? [["median", `Median ${formatMs(day.medianMs)}`, "trend-series-1"], ["p95", `95th percentile ${formatMs(day.p95Ms)}`, "trend-series-2"], ["count", `${day.timed} timed`]] : [["none", "No response times"]]} />
            <div className="trend-legend"><span><i className="trend-key trend-series-1" aria-hidden="true" />Median</span><span><i className="trend-key trend-series-2" aria-hidden="true" />95th percentile</span></div>
          </> : <p className="trends-empty">No response times in the last {days} days.</p>}
        </div>
      </div>
      {ran && <details className="trends-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Checks</th><th>Pass rate</th><th>Median</th><th>95th percentile</th></tr></thead>
          <tbody>{trend.filter((day) => day.total).reverse().map((day) => <tr key={day.day}>
            <td>{shortDate(day.date)}</td><td>{day.passed} / {day.total}</td><td>{formatRate(day.passRate)}</td><td>{formatMs(day.medianMs)}</td><td>{formatMs(day.p95Ms)}</td>
          </tr>)}</tbody>
        </table>
      </details>}
    </>}
  </section>;
}
