import { describe, expect, it } from "vitest";
import { SAMPLE_APIS } from "./sampleApis.js";

describe("SAMPLE_APIS", () => {
  it("offers four public APIs with unique ids and https contract URLs", () => {
    expect(SAMPLE_APIS).toHaveLength(4);
    expect(new Set(SAMPLE_APIS.map((sample) => sample.id)).size).toBe(4);
    for (const sample of SAMPLE_APIS) {
      expect(new URL(sample.url).protocol).toBe("https:");
      expect(sample.name && sample.note).toBeTruthy();
    }
  });
});
