// Export, validate, and merge the browser-local workspace (saved APIs and Run history).
export const WORKSPACE_FORMAT = "api-qa-intelligence-workspace";
export const WORKSPACE_VERSION = 1;

export function buildWorkspaceExport(savedApis, runHistory, exportedAt = new Date().toISOString()) {
  return { format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, exportedAt, savedApis, runHistory };
}

export function workspaceFileName(date = new Date()) {
  return `api-qa-intelligence-workspace-${date.toISOString().slice(0, 10)}.json`;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isSavedApi = (api) => isObject(api) && typeof api.id === "string" && typeof api.title === "string"
  && isObject(api.overview) && Array.isArray(api.overview.operations);
const isRun = (run) => isObject(run) && (typeof run.id === "number" || typeof run.id === "string")
  && typeof run.endpoint === "string" && Array.isArray(run.results);

export function parseWorkspaceImport(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("The file is not valid JSON."); }
  if (!isObject(data) || data.format !== WORKSPACE_FORMAT) throw new Error("This is not an API QA Intelligence workspace export.");
  if (data.version !== WORKSPACE_VERSION) throw new Error(`Unsupported workspace version ${data.version}.`);
  if (!Array.isArray(data.savedApis) || !Array.isArray(data.runHistory)) throw new Error("The workspace file is missing saved APIs or Run history.");
  const invalidApi = data.savedApis.findIndex((api) => !isSavedApi(api));
  if (invalidApi >= 0) throw new Error(`Saved API #${invalidApi + 1} is incomplete.`);
  const invalidRun = data.runHistory.findIndex((run) => !isRun(run));
  if (invalidRun >= 0) throw new Error(`Run #${invalidRun + 1} is incomplete.`);
  return { savedApis: data.savedApis, runHistory: data.runHistory };
}

// Imported APIs replace saved APIs with the same id; runs already present (same id) are kept as is.
export function mergeWorkspace(current, incoming) {
  const incomingIds = new Set(incoming.savedApis.map((api) => api.id));
  const currentIds = new Set(current.savedApis.map((api) => api.id));
  const savedApis = [...incoming.savedApis, ...current.savedApis.filter((api) => !incomingIds.has(api.id))];
  const runIds = new Set(current.runHistory.map((run) => run.id));
  const newRuns = incoming.runHistory.filter((run) => !runIds.has(run.id));
  const runHistory = [...newRuns, ...current.runHistory].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    savedApis,
    runHistory,
    addedApis: incoming.savedApis.filter((api) => !currentIds.has(api.id)).length,
    updatedApis: incoming.savedApis.filter((api) => currentIds.has(api.id)).length,
    addedRuns: newRuns.length,
  };
}
