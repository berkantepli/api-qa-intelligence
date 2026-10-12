import { describe, expect, it } from "vitest";
import { findingsByEndpoint, qualityTone, ruleLabels } from "./quality.js";

const quality = {
  rules: [{ id: "summary", label: "Endpoints have a summary" }],
  findings: [
    { rule: "summary", method: "POST", path: "/pets", message: "No summary." },
    { rule: "server", method: null, path: null, message: "No server." },
    { rule: "summary", method: "GET", path: "/pets", message: "No summary." },
    { rule: "not-found", method: "POST", path: "/pets", message: "No 404." },
  ],
};
const operations = [{ method: "GET", path: "/pets" }, { method: "POST", path: "/pets" }];

describe("contract quality", () => {
  it("groups findings by endpoint in overview order, API-wide findings first", () => {
    const groups = findingsByEndpoint(quality, operations);

    expect(groups.map((group) => [group.key, group.operationIndex, group.findings.length])).toEqual([
      ["", -1, 1],
      ["GET /pets", 0, 1],
      ["POST /pets", 1, 2],
    ]);
    expect(findingsByEndpoint(null)).toEqual([]);
  });

  it("names rules and tones scores", () => {
    expect(ruleLabels(quality)).toEqual({ summary: "Endpoints have a summary" });
    expect([qualityTone(90), qualityTone(75), qualityTone(74), qualityTone(50), qualityTone(49)]).toEqual(["good", "good", "fair", "fair", "poor"]);
  });
});
