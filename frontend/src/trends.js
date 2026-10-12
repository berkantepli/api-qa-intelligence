// Daily pass rate and response times for one API, from its Run history. Endpoint runs count per
// check; flow runs count per step that ran, under the endpoint the step called.
import { stepOperation } from "./flows.js";

export const TREND_RANGES = [7, 30, 90];
const OUTCOMES = new Set(["PASS", "FAIL", "ERROR"]);

const pad = (number) => String(number).padStart(2, "0");
// The local calendar day, so a run late in the evening lands on the day the user ran it.
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// One sample per executed check or flow step: when, which endpoint, its outcome and duration.
export function trendSamples(overview, runs = []) {
  const samples = [];
  for (const run of runs) {
    const at = new Date(run.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    for (const result of run.results ?? []) {
      if (!OUTCOMES.has(result.result)) continue;
      let key = run.endpoint;
      if (run.kind === "flow") {
        const operation = stepOperation(overview, { method: result.method, path: result.step_path ?? result.path ?? "" });
        key = operation ? `${operation.method} ${operation.path}` : null;
      }
      // Imported Newman and JUnit results store 0 when the file had no duration.
      const duration = Number.isFinite(result.duration_ms) && !(result.imported && result.duration_ms === 0) ? result.duration_ms : null;
      samples.push({ at, key, outcome: result.result, durationMs: duration });
    }
  }
  return samples;
}

// Nearest-rank percentile of sorted numbers.
function percentile(sorted, share) {
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

// The last `days` days ending today, oldest first. A day without checks has null values, so the
// chart shows a gap instead of inventing a value. `endpoint` narrows it to one "METHOD /path".
export function dailyTrend(samples, { days = 30, now = new Date(), endpoint = null } = {}) {
  const buckets = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    buckets.set(dayKey(day), { day: dayKey(day), date: day, total: 0, passed: 0, durations: [] });
  }
  for (const sample of samples) {
    if (endpoint && sample.key !== endpoint) continue;
    const bucket = buckets.get(dayKey(sample.at));
    if (!bucket) continue;
    bucket.total += 1;
    if (sample.outcome === "PASS") bucket.passed += 1;
    if (sample.durationMs != null) bucket.durations.push(sample.durationMs);
  }
  return [...buckets.values()].map(({ durations, ...bucket }) => {
    const sorted = durations.sort((a, b) => a - b);
    return {
      ...bucket,
      passRate: bucket.total ? Math.round((bucket.passed / bucket.total) * 100) : null,
      medianMs: sorted.length ? percentile(sorted, 0.5) : null,
      p95Ms: sorted.length ? percentile(sorted, 0.95) : null,
      timed: sorted.length,
    };
  });
}

// Totals over the whole range, and the same figures for the range before it, for "vs previous".
export function trendSummary(samples, { days = 30, now = new Date(), endpoint = null } = {}) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const previousStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2 * days + 1);
  const totals = (from, to) => {
    const inRange = samples.filter((sample) => (!endpoint || sample.key === endpoint) && sample.at >= from && sample.at < to);
    const durations = inRange.map((sample) => sample.durationMs).filter((value) => value != null).sort((a, b) => a - b);
    const passed = inRange.filter((sample) => sample.outcome === "PASS").length;
    return {
      total: inRange.length,
      passRate: inRange.length ? Math.round((passed / inRange.length) * 100) : null,
      medianMs: durations.length ? percentile(durations, 0.5) : null,
      p95Ms: durations.length ? percentile(durations, 0.95) : null,
    };
  };
  return { current: totals(start, end), previous: totals(previousStart, start) };
}

// Endpoints that have at least one sample, for the endpoint picker.
export function trendEndpoints(samples) {
  return [...new Set(samples.map((sample) => sample.key).filter(Boolean))].sort();
}
