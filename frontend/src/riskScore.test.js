import { describe, expect, it } from "vitest";
import { RISK_RULES, riskLevel, scoreEndpoint, sensitivePathWord } from "./riskScore.js";

const endpoint = (overrides) => ({ method: "GET", path: "/pets", status: "passing", needsAuth: false, riskIds: [], coveredChecks: 1, runnableChecks: 1, ...overrides });

describe("scoreEndpoint", () => {
  it("scores a passing public read as low with no factors", () => {
    expect(scoreEndpoint(endpoint())).toEqual({ score: 0, level: "low", factors: [] });
  });

  it("adds impact from the contract before anything has run", () => {
    const risk = scoreEndpoint(endpoint({ method: "DELETE", path: "/users/{userId}", needsAuth: true, status: "untested", coveredChecks: 0 }));

    expect(risk.factors.map((factor) => [factor.label, factor.points])).toEqual([
      ["Deletes data", 20], ["Requires authentication", 10], ["Sensitive area: users", 10], ["Never tested", 15],
    ]);
    expect([risk.score, risk.level]).toEqual([55, "high"]);
  });

  it("adds evidence from Run history and caps the score at 100", () => {
    const risk = scoreEndpoint(endpoint({
      method: "POST", path: "/payments", needsAuth: true, status: "failing",
      riskIds: ["failing", "flaky", "auth", "happy-only", "stale"], coveredChecks: 1, runnableChecks: 3,
    }));

    expect(risk.factors.map((factor) => factor.id)).toEqual(["writes", "auth-required", "sensitive", "failing", "flaky", "auth", "happy-only", "partial", "stale"]);
    expect(risk.factors.find((factor) => factor.id === "partial").label).toBe("2 of 3 checks not run yet");
    expect(risk.score).toBe(100);
  });

  it("uses the documented points for every rule", () => {
    expect(Object.fromEntries(RISK_RULES.map((rule) => [rule.id, rule.points]))).toMatchObject({ failing: 35, deletes: 20, untested: 15 });
  });
});

describe("contract changes", () => {
  it("adds points for a new or changed endpoint that has not run since", () => {
    expect(scoreEndpoint(endpoint({ contractChange: { type: "added" } })).factors).toEqual([{ id: "contract-changed", kind: "evidence", points: 15, label: "New in the contract" }]);
    expect(scoreEndpoint(endpoint({ contractChange: { type: "changed" } })).factors[0].label).toBe("Changed in the contract");
  });
});

describe("riskLevel", () => {
  it("is high from 50 and medium from 25", () => {
    expect([49, 50, 24, 25].map((score) => riskLevel(score).id)).toEqual(["medium", "high", "low", "medium"]);
  });
});

describe("sensitivePathWord", () => {
  it("finds sensitive words in the path but not in parameter names or look-alikes", () => {
    expect(sensitivePathWord("/store/orders/{orderId}")).toBe("orders");
    expect(sensitivePathWord("/user/login")).toBe("user");
    expect(sensitivePathWord("/pets/{userId}")).toBeNull();
    expect(sensitivePathWord("/payloads/rolebook")).toBeNull();
  });
});
