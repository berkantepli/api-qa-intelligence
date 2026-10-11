import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_UNREACHABLE, postJson, readJsonResponse, validationMessage } from "./apiClient.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("validationMessage", () => {
  it.each([
    [[{ loc: ["body", "base_url"], type: "url_parsing", msg: "Input should be a valid URL" }], "Target API base URL must be a valid http:// or https:// URL."],
    [[{ loc: ["body", "url"], type: "url_scheme", msg: "URL scheme should be 'http' or 'https'" }], "OpenAPI URL must be a valid http:// or https:// URL."],
    [[{ loc: ["body", "max_duration_ms"], type: "greater_than_equal", ctx: { ge: 1 }, msg: "Input should be greater than or equal to 1" }], "Response time limit must be at least 1."],
    [[{ loc: ["body", "path"], type: "value_error", msg: "Value error, Path must be an absolute API path such as /users/123." }], "Path must be an absolute API path such as /users/123."],
    [[{ loc: ["body", "something_else"], type: "string_type", msg: "Input should be a valid string" }], "Fallback."],
  ])("describes %j", (detail, message) => {
    expect(validationMessage(detail, "Fallback.")).toBe(message);
  });
});

describe("readJsonResponse", () => {
  it("returns the payload of a successful response", async () => {
    await expect(readJsonResponse(json(200, { ok: true }), "Fallback.")).resolves.toEqual({ ok: true });
  });

  it("uses the server's message", async () => {
    await expect(readJsonResponse(json(422, { detail: "The OpenAPI URL returned 404 Not Found." }), "Fallback."))
      .rejects.toMatchObject({ message: "The OpenAPI URL returned 404 Not Found.", status: 422, validation: false });
  });

  it("explains a server error page that is not JSON", async () => {
    await expect(readJsonResponse(new Response("<html>Bad gateway</html>", { status: 502 }), "The check could not be executed."))
      .rejects.toThrow("The check could not be executed. The app server reported an error (HTTP 502).");
  });
});

describe("postJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains that the app server is down instead of 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(postJson("/api/v1/runs/execute", {}, "Fallback.")).rejects.toThrow(SERVER_UNREACHABLE);
  });

  it("lets an aborted request stay an abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(postJson("/x", {}, "Fallback.")).rejects.toMatchObject({ name: "AbortError" });
  });
});
