import { describe, expect, it } from "vitest";
import { buildWorkspaceExport, mergeWorkspace, parseWorkspaceImport, workspaceFileName } from "./workspace.js";

const api = (id, title = id) => ({ id, title, overview: { operations: [] } });
const run = (id, createdAt) => ({ id, endpoint: "GET /x", createdAt, results: [] });

describe("workspace export and import", () => {
  it("round-trips an export", () => {
    const exported = buildWorkspaceExport([api("a")], [run(1, "2026-10-01T00:00:00Z")], "2026-10-06T00:00:00Z");

    expect(exported).toMatchObject({ format: "api-qa-intelligence-workspace", version: 1, exportedAt: "2026-10-06T00:00:00Z" });
    expect(parseWorkspaceImport(JSON.stringify(exported))).toEqual({ savedApis: exported.savedApis, runHistory: exported.runHistory });
  });

  it.each([
    ["not json", "not valid JSON"],
    [JSON.stringify({ format: "other" }), "not an API QA Intelligence"],
    [JSON.stringify({ format: "api-qa-intelligence-workspace", version: 2 }), "Unsupported workspace version"],
    [JSON.stringify({ format: "api-qa-intelligence-workspace", version: 1, savedApis: [] }), "missing saved APIs"],
    [JSON.stringify({ format: "api-qa-intelligence-workspace", version: 1, savedApis: [{ id: "a" }], runHistory: [] }), "Saved API #1 is incomplete"],
    [JSON.stringify({ format: "api-qa-intelligence-workspace", version: 1, savedApis: [], runHistory: [{ id: 1 }] }), "Run #1 is incomplete"],
  ])("rejects invalid files (%#)", (text, message) => {
    expect(() => parseWorkspaceImport(text)).toThrow(message);
  });

  it("names the file by date", () => {
    expect(workspaceFileName(new Date("2026-10-06T12:00:00Z"))).toBe("api-qa-intelligence-workspace-2026-10-06.json");
  });
});

describe("mergeWorkspace", () => {
  it("replaces same-id APIs, keeps existing runs, and sorts runs newest first", () => {
    const current = { savedApis: [api("a", "Old A"), api("b")], runHistory: [run(1, "2026-10-01T00:00:00Z")] };
    const incoming = { savedApis: [api("a", "New A"), api("c")], runHistory: [run(1, "2026-10-01T00:00:00Z"), run(2, "2026-10-03T00:00:00Z")] };

    const merged = mergeWorkspace(current, incoming);

    expect(merged.savedApis.map((item) => item.title)).toEqual(["New A", "c", "b"]);
    expect(merged.runHistory.map((item) => item.id)).toEqual([2, 1]);
    expect([merged.addedApis, merged.updatedApis, merged.addedRuns]).toEqual([1, 1, 1]);
  });
});
