import { describe, expect, it } from "vitest";
import { classifiedEndpoint, severitySummary, withClassification } from "./contractSeverity.js";

const classified = {
  totals: { endpoints: 2, breaking: 1, warning: 1, safe: 3, retest: 1 },
  endpoints: [
    { method: "GET", path: "/orders", status: "removed", severity: "breaking", changes: [], retest: [] },
    { method: "POST", path: "/pets", status: "changed", severity: "warning", changes: [], retest: ["Valid request"] },
  ],
  markdown: "## Contract changes",
};

describe("contract change severity", () => {
  it("adds the classification only to the comparison it was made for", () => {
    const api = { id: "pets", contractChanges: { comparedAt: "2026-10-12T10:00:00Z", added: [], removed: [], changed: [] } };

    expect(withClassification(api, "2026-10-12T10:00:00Z", classified).contractChanges.classified).toBe(classified);
    // A newer import replaced the comparison while the request was on its way.
    expect(withClassification(api, "2026-10-12T09:00:00Z", classified)).toBe(api);
    expect(withClassification({ id: "x" }, "2026-10-12T10:00:00Z", classified)).toEqual({ id: "x" });
  });

  it("finds an endpoint and summarizes the totals", () => {
    expect(classifiedEndpoint(classified, "POST /pets").retest).toEqual(["Valid request"]);
    expect(classifiedEndpoint(classified, "GET /pets")).toBeNull();
    expect(classifiedEndpoint(undefined, "POST /pets")).toBeNull();
    expect(severitySummary(classified)).toBe("1 breaking · 1 warning · 3 safe");
    expect(severitySummary(null)).toBe("");
  });
});
