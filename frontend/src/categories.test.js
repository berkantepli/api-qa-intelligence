import { describe, expect, it } from "vitest";
import { parameterLabel } from "./categories.js";

describe("parameterLabel", () => {
  it("labels optional security credentials separately from optional parameters", () => {
    expect(parameterLabel({ location: "header", credential: true, required: false })).toBe("header · credential");
    expect(parameterLabel({ location: "header", credential: true, required: true })).toBe("header · required");
    expect(parameterLabel({ location: "query", required: true })).toBe("query · required");
    expect(parameterLabel({ location: "query" })).toBe("query · optional");
  });
});
