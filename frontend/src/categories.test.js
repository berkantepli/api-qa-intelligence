import { describe, expect, it } from "vitest";
import { inputHelp, parameterLabel } from "./categories.js";

describe("parameterLabel", () => {
  it("labels optional security credentials separately from optional parameters", () => {
    expect(parameterLabel({ location: "header", credential: true, required: false })).toBe("header · credential");
    expect(parameterLabel({ location: "header", credential: true, required: true })).toBe("header · required");
    expect(parameterLabel({ location: "query", required: true })).toBe("query · required");
    expect(parameterLabel({ location: "query" })).toBe("query · optional");
  });
});

describe("inputHelp", () => {
  it("combines the description with the credential note", () => {
    expect(inputHelp({ description: "Order status" })).toBe("Order status");
    expect(inputHelp({ credential: true, required: false })).toBe("Leave empty to call without credentials.");
    expect(inputHelp({ description: "Token", credential: true, required: true })).toBe("Token");
  });
});
