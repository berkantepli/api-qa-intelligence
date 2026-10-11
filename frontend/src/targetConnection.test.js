import { describe, expect, it } from "vitest";
import { connectionLabel, targetUrlProblem } from "./targetConnection.js";

const done = (result) => ({ status: "done", result: { url: "http://api", method: "HEAD", duration_ms: 12, ...result } });

describe("connectionLabel", () => {
  it.each([
    [undefined, "unknown", "No API selected"],
    [{ status: "empty" }, "unknown", "No target URL"],
    [{ status: "invalid", message: "The target base URL is not a valid URL." }, "unavailable", "Invalid target URL"],
    [{ status: "checking", url: "http://api" }, "checking", "Checking connection"],
    [{ status: "blocked", message: "The target URL must use a public host or localhost." }, "unavailable", "Target not allowed"],
    [{ status: "error", message: "Failed to fetch" }, "unavailable", "Check failed"],
    [done({ reachable: false, error: "Could not connect to the target API: the connection was refused." }), "unavailable", "API unavailable"],
    [done({ reachable: false, timed_out: true, error: "The target API did not respond within 8 seconds." }), "warning", "Slow to respond"],
    [done({ reachable: true, status_code: 500, fromCheck: true }), "connected", "API reachable"],
    [done({ reachable: true, status_code: 200 }), "connected", "API reachable"],
    [done({ reachable: true, status_code: 404 }), "connected", "API reachable"],
    [done({ reachable: true, status_code: 503 }), "warning", "API error · 503"],
  ])("labels %j", (state, tone, text) => {
    expect(connectionLabel(state)).toMatchObject({ tone, text });
  });

  it("explains timing and 4xx responses in the tooltip", () => {
    expect(connectionLabel(done({ reachable: true, status_code: 404 })).title)
      .toBe("HEAD http://api returned 404 in 12 ms. A 4xx at the base URL usually means there is no route there; the server is up.");
  });
});

describe("targetUrlProblem", () => {
  it.each([
    ["", "Enter a Target API base URL"],
    ["   ", "Enter a Target API base URL"],
    ["not a url", "not a valid URL"],
    ["ftp://api.example.com", "must start with http"],
    ["https://user:pw@api.example.com", "embedded credentials"],
    ["https://api.example.com/v1?x=1", "query or fragment"],
  ])("rejects %j", (url, message) => {
    expect(targetUrlProblem(url)).toContain(message);
  });

  it.each(["http://127.0.0.1:8000", "https://api.example.com/v1"])("accepts %s", (url) => {
    expect(targetUrlProblem(url)).toBe("");
  });
});
