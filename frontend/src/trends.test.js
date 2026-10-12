import { describe, expect, it } from "vitest";
import { coverageTrend, dailyTrend, dayKey, recentRunsByEndpoint, slowdowns, trendEndpoints, trendSamples, trendSummary } from "./trends.js";
import { sparklineLabel } from "./Sparkline.jsx";

const overview = {
  operations: [
    { method: "POST", path: "/pets" },
    { method: "GET", path: "/pets/{petId}" },
  ],
};
// Local times, so the day a run lands on does not depend on the machine's time zone.
const at = (day, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const check = (result, duration_ms) => ({ title: "Valid request", result, duration_ms });
const run = (endpoint, day, results, extra = {}) => ({ id: `${endpoint}-${day}`, endpoint, createdAt: at(day), results, ...extra });
const now = new Date(2026, 9, 12, 18);

describe("trend samples", () => {
  it("counts endpoint checks and flow steps that ran, under the endpoint they called", () => {
    const samples = trendSamples(overview, [
      run("POST /pets", 10, [check("PASS", 120), check("FAIL", 80), { title: "Skipped", result: "SKIPPED" }]),
      run("Flow: Pet lifecycle", 11, [
        { method: "POST", path: "/pets", step_path: "/pets", result: "PASS", duration_ms: 90 },
        { method: "GET", path: "/pets/7", step_path: "/pets/{{petId}}", result: "ERROR", duration_ms: null },
        { method: "GET", path: "/pets/7", step_path: "/pets/{{petId}}", result: "SKIPPED" },
      ], { kind: "flow" }),
    ]);

    expect(samples.map(({ key, outcome, durationMs }) => [key, outcome, durationMs])).toEqual([
      ["POST /pets", "PASS", 120],
      ["POST /pets", "FAIL", 80],
      ["POST /pets", "PASS", 90],
      ["GET /pets/{petId}", "ERROR", null],
    ]);
    expect(trendEndpoints(samples)).toEqual(["GET /pets/{petId}", "POST /pets"]);
  });

  it("treats an imported result without a duration as untimed", () => {
    const samples = trendSamples(overview, [run("POST /pets", 10, [
      { title: "Newman", result: "PASS", imported: "newman", duration_ms: 0 },
      { title: "JUnit", result: "FAIL", imported: "junit", duration_ms: 35 },
    ])]);
    expect(samples.map((sample) => sample.durationMs)).toEqual([null, 35]);
  });
});

describe("daily trend", () => {
  const samples = trendSamples(overview, [
    run("POST /pets", 3, [check("PASS", 400)]),
    run("POST /pets", 10, [check("PASS", 100), check("PASS", 200), check("FAIL", 300), check("ERROR", null)]),
    run("GET /pets/{petId}", 12, [check("PASS", 50)]),
  ]);

  it("buckets checks per local day and leaves days without checks empty", () => {
    const trend = dailyTrend(samples, { days: 7, now });

    expect(trend).toHaveLength(7);
    expect(trend[0].day).toBe("2026-10-06");
    expect(trend.at(-1).day).toBe(dayKey(now));
    expect(trend.find((day) => day.day === "2026-10-10")).toMatchObject({ total: 4, passed: 2, passRate: 50, medianMs: 200, p95Ms: 300, timed: 3 });
    expect(trend.find((day) => day.day === "2026-10-11")).toMatchObject({ total: 0, passRate: null, medianMs: null, p95Ms: null });
  });

  it("narrows the trend to one endpoint", () => {
    const trend = dailyTrend(samples, { days: 7, now, endpoint: "GET /pets/{petId}" });
    expect(trend.filter((day) => day.total).map((day) => [day.day, day.passRate])).toEqual([["2026-10-12", 100]]);
  });

  it("compares the range with the one before it", () => {
    expect(trendSummary(samples, { days: 7, now })).toEqual({
      current: { total: 5, passRate: 60, medianMs: 100, p95Ms: 300 },
      previous: { total: 1, passRate: 100, medianMs: 400, p95Ms: 400 },
    });
  });
});

describe("slowdowns", () => {
  const timedRun = (endpoint, day, durations) => run(endpoint, day, durations.map((ms) => check("PASS", ms)));

  it("lists endpoints whose median grew by half and by 50 ms, slowest growth first", () => {
    const samples = trendSamples(overview, [
      timedRun("POST /pets", 1, [100, 110, 120]),
      timedRun("POST /pets", 10, [300, 320, 340]),
      timedRun("GET /pets/{petId}", 2, [40, 40, 40]),
      timedRun("GET /pets/{petId}", 11, [80, 80, 80]),
    ]);
    const result = slowdowns(samples, { days: 7, now });

    expect(result.compared).toBe(2);
    expect(result.items).toEqual([{ key: "POST /pets", beforeMs: 110, afterMs: 320, ratio: 320 / 110 }]);
  });

  it("needs enough timed checks in both ranges", () => {
    const samples = trendSamples(overview, [timedRun("POST /pets", 1, [100]), timedRun("POST /pets", 10, [900, 900, 900])]);
    expect(slowdowns(samples, { days: 7, now })).toEqual({ items: [], compared: 0 });
  });
});

describe("coverage trend", () => {
  it("counts each contract endpoint from the day it first ran", () => {
    const samples = trendSamples(overview, [
      run("POST /pets", 8, [check("FAIL", 10)]),
      run("POST /pets", 11, [check("PASS", 10)]),
      run("GET /pets/{petId}", 11, [check("PASS", 10)]),
      run("DELETE /gone", 9, [check("PASS", 10)]),
    ]);
    const trend = coverageTrend(samples, ["POST /pets", "GET /pets/{petId}"], { days: 7, now });

    expect(trend.map((day) => [day.day, day.percent])).toEqual([
      ["2026-10-06", 0], ["2026-10-07", 0], ["2026-10-08", 50], ["2026-10-09", 50], ["2026-10-10", 50], ["2026-10-11", 100], ["2026-10-12", 100],
    ]);
    expect(trend.at(-1)).toMatchObject({ tested: 2, total: 2 });
  });
});

describe("recent runs per endpoint", () => {
  it("keeps the latest runs, oldest first, with a failed flag and median per run", () => {
    const samples = trendSamples(overview, [
      run("POST /pets", 9, [check("PASS", 100), check("FAIL", 300), check("PASS", 200)]),
      run("POST /pets", 10, [check("PASS", 50)]),
      run("POST /pets", 11, [check("PASS", 70)]),
    ]);
    const recent = recentRunsByEndpoint(samples, 2)["POST /pets"];

    expect(recent.map(({ failed, medianMs }) => [failed, medianMs])).toEqual([[false, 50], [false, 70]]);
    expect(recentRunsByEndpoint(samples)["POST /pets"][0]).toMatchObject({ failed: true, medianMs: 200 });
    expect(sparklineLabel(recentRunsByEndpoint(samples)["POST /pets"])).toBe("Last 3 runs: 1 failed, 50 ms to 200 ms");
  });
});
