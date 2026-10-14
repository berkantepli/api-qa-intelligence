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
      samples.push({ at, key, runId: run.id, outcome: result.result, durationMs: duration });
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? percentile(sorted, 0.5) : null;
};
const rangeStart = (now, daysBack) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack + 1);

// Endpoints whose median response time in the range grew the most against their usual speed: the
// median of the `baselineDays` before the range. Comparing with a long stretch instead of the range
// just before it keeps a slowdown visible when it started before the range and has not recovered.
// Both need `minSamples` timed checks, and the median must grow by `minRatio` and `minIncreaseMs`,
// so a single slow call or a few milliseconds of noise are not reported. `compared` counts the
// endpoints that had enough data in both.
export function slowdowns(samples, { days = 30, now = new Date(), baselineDays = 90, minSamples = 3, minRatio = 1.5, minIncreaseMs = 50, limit = 5 } = {}) {
  const end = rangeStart(now, 0); // the start of tomorrow
  const start = rangeStart(now, days);
  const baselineStart = rangeStart(now, days + baselineDays);
  const byEndpoint = new Map();
  for (const sample of samples) {
    if (!sample.key || sample.durationMs == null || sample.at < baselineStart || sample.at >= end) continue;
    if (!byEndpoint.has(sample.key)) byEndpoint.set(sample.key, { current: [], baseline: [] });
    byEndpoint.get(sample.key)[sample.at >= start ? "current" : "baseline"].push(sample.durationMs);
  }
  let compared = 0;
  const items = [];
  for (const [key, { current, baseline }] of byEndpoint) {
    if (current.length < minSamples || baseline.length < minSamples) continue;
    compared += 1;
    const before = median(baseline);
    const after = median(current);
    const ratio = before > 0 ? after / before : Infinity;
    if (ratio >= minRatio && after - before >= minIncreaseMs) items.push({ key, beforeMs: before, afterMs: after, ratio });
  }
  items.sort((a, b) => b.ratio - a.ratio || b.afterMs - a.afterMs);
  return { items: items.slice(0, limit), compared };
}

// Per day, the share of the contract's endpoints that had run at least once by the end of that
// day, the same rule as "Endpoints tested" on Coverage & Risk.
export function coverageTrend(samples, endpointKeys = [], { days = 30, now = new Date() } = {}) {
  const contract = new Set(endpointKeys);
  const firstRun = new Map();
  for (const sample of samples) {
    if (!contract.has(sample.key)) continue;
    const known = firstRun.get(sample.key);
    if (!known || sample.at < known) firstRun.set(sample.key, sample.at);
  }
  const firsts = [...firstRun.values()];
  return Array.from({ length: days }, (_, index) => {
    const date = rangeStart(now, days - index);
    const endOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    const tested = firsts.filter((at) => at < endOfDay).length;
    return { day: dayKey(date), date, tested, total: contract.size, percent: contract.size ? Math.round((tested / contract.size) * 100) : 0 };
  });
}

// The latest `limit` runs of each endpoint, oldest first: when, whether a check or step failed,
// and the median response time of that run. A flow run counts once per endpoint it called.
export function recentRunsByEndpoint(samples, limit = 12) {
  const runs = new Map();
  for (const sample of samples) {
    if (!sample.key) continue;
    const id = `${sample.key}::${sample.runId ?? sample.at.getTime()}`;
    if (!runs.has(id)) runs.set(id, { key: sample.key, at: sample.at, failed: false, durations: [] });
    const run = runs.get(id);
    if (sample.outcome !== "PASS") run.failed = true;
    if (sample.durationMs != null) run.durations.push(sample.durationMs);
  }
  const byEndpoint = {};
  for (const run of [...runs.values()].sort((a, b) => a.at - b.at)) {
    (byEndpoint[run.key] ??= []).push({ at: run.at, failed: run.failed, medianMs: median(run.durations) });
  }
  for (const key of Object.keys(byEndpoint)) byEndpoint[key] = byEndpoint[key].slice(-limit);
  return byEndpoint;
}
