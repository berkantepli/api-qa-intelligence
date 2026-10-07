import { describe, expect, it } from "vitest";
import { connectionLabel } from "./targetConnection.js";

const done = (result) => ({ status: "done", result: { url: "http://api", method: "HEAD", duration_ms: 12, ...result } });

describe("connectionLabel", () => {
  it.each([
    [undefined, "unknown", "No API selected"],
    [{ status: "checking", url: "http://api" }, "checking", "Checking connection"],
    [{ status: "blocked", message: "The target URL must use a public host or localhost." }, "unavailable", "Target not allowed"],
    [{ status: "error", message: "Failed to fetch" }, "unavailable", "Check failed · retry"],
    [done({ reachable: false, error: "No response within 5 seconds." }), "unavailable", "API unavailable · retry"],
    [done({ reachable: true, status_code: 200 }), "connected", "API reachable · 200"],
    [done({ reachable: true, status_code: 404 }), "connected", "API reachable · 404"],
    [done({ reachable: true, status_code: 503 }), "warning", "API error · 503"],
  ])("labels %j", (state, tone, text) => {
    expect(connectionLabel(state)).toMatchObject({ tone, text });
  });

  it("explains timing and 4xx responses in the tooltip", () => {
    expect(connectionLabel(done({ reachable: true, status_code: 404 })).title)
      .toBe("HEAD http://api returned 404 in 12 ms. A 4xx at the base URL usually means there is no route there; the server is up.");
  });
});
