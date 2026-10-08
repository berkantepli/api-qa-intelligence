import { describe, expect, it } from "vitest";
import { diffInputs, diffRuns, diffSavedApis, isEmptyWorkspace, workspaceRequests } from "./workspaceSync.js";

const pets = { id: "Pets::https://pets.test/openapi.json", title: "Pets" };
const shop = { id: "Shop::file.yaml", title: "Shop" };
const run = (id) => ({ id, endpoint: "GET /pets", results: [] });

describe("diffs", () => {
  it("finds changed, moved, and removed saved APIs", () => {
    const renamed = { ...pets, title: "Pets v2" };

    expect(diffSavedApis([pets], [pets])).toEqual({ upserts: [], deletes: [] });
    expect(diffSavedApis([pets], [shop, pets]).upserts).toEqual([{ api: shop, position: 0 }, { api: pets, position: 1 }]);
    expect(diffSavedApis([pets, shop], [renamed])).toEqual({ upserts: [{ api: renamed, position: 0 }], deletes: [shop.id] });
  });

  it("finds new, replaced, and removed runs by id", () => {
    const first = run(1);
    const analyzed = { ...first, results: [{ analysis: {} }] };

    expect(diffRuns([first], [run(2), first])).toEqual({ upserts: [run(2)], deletes: [] });
    expect(diffRuns([first], [analyzed])).toEqual({ upserts: [analyzed], deletes: [] });
    expect(diffRuns([first, run(2)], [first])).toEqual({ upserts: [], deletes: ["2"] });
  });

  it("compares request details by value", () => {
    expect(diffInputs({ a: { x: { k: "1" } } }, { a: { x: { k: "1" } } })).toEqual([]);
    expect(diffInputs({ a: { x: { k: "1" } } }, { a: { x: { k: "2" } }, b: {} })).toEqual(["a"]);
  });
});

describe("workspaceRequests", () => {
  it("saves APIs before their request details and encodes ids", () => {
    const requests = workspaceRequests(
      { savedApis: [], runHistory: [], requestInputs: {} },
      { savedApis: [pets], runHistory: [run(7)], requestInputs: { [pets.id]: { "GET /pets": { "parameter:query:limit": "5" } }, gone: { x: {} } } },
    );

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "PUT /api/v1/workspace/apis/Pets%3A%3Ahttps%3A%2F%2Fpets.test%2Fopenapi.json?position=0",
      "PUT /api/v1/workspace/runs/7",
      "PUT /api/v1/workspace/inputs/Pets%3A%3Ahttps%3A%2F%2Fpets.test%2Fopenapi.json",
    ]);
  });

  it("knows an empty workspace", () => {
    expect(isEmptyWorkspace({ savedApis: [], runHistory: [] })).toBe(true);
    expect(isEmptyWorkspace({ savedApis: [pets], runHistory: [] })).toBe(false);
  });
});
