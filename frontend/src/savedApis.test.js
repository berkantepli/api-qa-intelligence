import { describe, expect, it } from "vitest";
import { removeSavedApi } from "./savedApis.js";

const apis = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("removeSavedApi", () => {
  it("keeps the active API when another one is removed", () => {
    expect(removeSavedApi(apis, "c", "a")).toEqual({ remaining: [{ id: "a" }, { id: "b" }], nextActiveApi: undefined, activeChanged: false });
  });

  it("activates the API that takes the removed one's place", () => {
    expect(removeSavedApi(apis, "b", "b").nextActiveApi).toEqual({ id: "c" });
    expect(removeSavedApi(apis, "c", "c").nextActiveApi).toEqual({ id: "b" });
  });

  it("leaves no active API when the last one is removed", () => {
    expect(removeSavedApi([{ id: "a" }], "a", "a")).toEqual({ remaining: [], nextActiveApi: undefined, activeChanged: true });
  });
});
