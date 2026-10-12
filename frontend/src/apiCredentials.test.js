import { describe, expect, it } from "vitest";
import { apiCredentialList, buildSignInRequest, credentialFromToken, signInBodyTemplate, signInCandidates, withApiCredentials } from "./apiCredentials.js";

const auth = { name: "Authorization", location: "header", credential: true };
const overview = {
  operations: [
    { method: "GET", path: "/pets", parameters: [auth, { name: "limit", location: "query" }] },
    { method: "POST", path: "/pets", parameters: [auth] },
    { method: "GET", path: "/health", parameters: [] },
    { method: "POST", path: "/users/login", parameters: [], request_body_content_type: "application/json", scenarios: [{ category: "happy_path", request_example: { json_body: { email: "a@b.c", password: "x" } } }] },
    { method: "POST", path: "/token", parameters: [], request_body_content_type: "application/x-www-form-urlencoded", request_body_fields: [{ name: "username" }, { name: "password" }] },
  ],
};

describe("apiCredentialList", () => {
  it("lists each credential once with the endpoints that use it", () => {
    expect(apiCredentialList(overview)).toEqual([
      { key: "parameter:header:Authorization", name: "Authorization", location: "header", description: "", operationKeys: ["GET /pets", "POST /pets"] },
    ]);
  });
});

describe("withApiCredentials", () => {
  it("fills the shared value where an endpoint has none and keeps its own", () => {
    const inputs = { "GET /pets": { "parameter:query:limit": "5" }, "POST /pets": { "parameter:header:Authorization": "Bearer own" } };
    const merged = withApiCredentials(overview, inputs, { "parameter:header:Authorization": "Bearer shared" });

    expect(merged["GET /pets"]).toEqual({ "parameter:query:limit": "5", "parameter:header:Authorization": "Bearer shared" });
    expect(merged["POST /pets"]["parameter:header:Authorization"]).toBe("Bearer own");
    expect(merged["GET /health"]).toBeUndefined();
  });

  it("returns the same object when no shared value is set", () => {
    const inputs = { "GET /pets": {} };
    expect(withApiCredentials(overview, inputs, { "parameter:header:Authorization": "  " })).toBe(inputs);
  });
});

describe("credentialFromToken", () => {
  it("adds Bearer to a bare token for Authorization only", () => {
    expect(credentialFromToken({ name: "Authorization" }, "abc")).toBe("Bearer abc");
    expect(credentialFromToken({ name: "Authorization" }, "Basic dXNlcg==")).toBe("Basic dXNlcg==");
    expect(credentialFromToken({ name: "X-Api-Key" }, "abc")).toBe("abc");
  });
});

describe("sign-in helpers", () => {
  it("puts likely sign-in endpoints first", () => {
    expect(signInCandidates(overview)).toEqual(["POST /users/login", "POST /token", "POST /pets"]);
  });

  it("prefills the body from the contract", () => {
    expect(JSON.parse(signInBodyTemplate(overview.operations[3]))).toEqual({ email: "a@b.c", password: "x" });
    expect(JSON.parse(signInBodyTemplate(overview.operations[4]))).toEqual({ username: "", password: "" });
  });

  it("sends a JSON body or form fields depending on the endpoint", () => {
    const json = buildSignInRequest(overview.operations[3], { targetUrl: " http://api ", bodyText: "{\"email\":\"q\"}", tokenPointer: "" });
    expect(json.request).toEqual({ base_url: "http://api", method: "POST", path: "/users/login", form_body: false, form_fields: {}, json_body: { email: "q" } });

    const form = buildSignInRequest(overview.operations[4], { targetUrl: "http://api", bodyText: "{\"username\":\"q\",\"remember\":true}", tokenPointer: "/data/jwt" });
    expect(form.request).toMatchObject({ form_body: true, form_fields: { username: "q", remember: "true" }, json_body: null, token_pointer: "/data/jwt" });
  });

  it("explains a body or pointer it cannot use", () => {
    expect(buildSignInRequest(overview.operations[3], { targetUrl: "x", bodyText: "{", tokenPointer: "" }).error).toMatch(/as JSON/);
    expect(buildSignInRequest(overview.operations[3], { targetUrl: "x", bodyText: "[1]", tokenPointer: "" }).error).toMatch(/JSON object/);
    expect(buildSignInRequest(overview.operations[3], { targetUrl: "x", bodyText: "", tokenPointer: "token" }).error).toMatch(/JSON Pointer/);
  });
});
