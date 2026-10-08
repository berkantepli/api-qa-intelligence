// Keeps the backend workspace database in step with the app's state.
//
// The app still works on plain React state; after each change, these helpers work out which
// records changed (React replaces a record's object when it changes) and the app sends just
// those to /api/v1/workspace. Request details are stored without credentials.

// Saved APIs whose object or position changed, and ids that disappeared.
export function diffSavedApis(previous = [], next = []) {
  const before = new Map(previous.map((api, position) => [api.id, { api, position }]));
  const upserts = next
    .map((api, position) => ({ api, position }))
    .filter(({ api, position }) => before.get(api.id)?.api !== api || before.get(api.id)?.position !== position);
  const nextIds = new Set(next.map((api) => api.id));
  return { upserts, deletes: [...before.keys()].filter((id) => !nextIds.has(id)) };
}

export function diffRuns(previous = [], next = []) {
  const before = new Map(previous.map((run) => [String(run.id), run]));
  const nextIds = new Set(next.map((run) => String(run.id)));
  return {
    upserts: next.filter((run) => before.get(String(run.id)) !== run),
    deletes: [...before.keys()].filter((id) => !nextIds.has(id)),
  };
}

// API ids whose stored request details differ; values are already free of credentials.
export function diffInputs(previous = {}, next = {}) {
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...ids].filter((id) => JSON.stringify(previous[id] ?? {}) !== JSON.stringify(next[id] ?? {}));
}

export function isEmptyWorkspace(workspace) {
  return !workspace?.savedApis?.length && !workspace?.runHistory?.length;
}

const encode = (id) => encodeURIComponent(String(id));

// The requests that bring the backend from `previous` to `next`.
export function workspaceRequests(previous, next) {
  const apis = diffSavedApis(previous.savedApis, next.savedApis);
  const runs = diffRuns(previous.runHistory, next.runHistory);
  return [
    ...apis.upserts.map(({ api, position }) => ({ method: "PUT", url: `/api/v1/workspace/apis/${encode(api.id)}?position=${position}`, body: api })),
    ...apis.deletes.map((id) => ({ method: "DELETE", url: `/api/v1/workspace/apis/${encode(id)}` })),
    ...runs.upserts.map((run) => ({ method: "PUT", url: `/api/v1/workspace/runs/${encode(run.id)}`, body: run })),
    ...runs.deletes.map((id) => ({ method: "DELETE", url: `/api/v1/workspace/runs/${encode(id)}` })),
    ...diffInputs(previous.requestInputs, next.requestInputs)
      .filter((id) => next.savedApis.some((api) => api.id === id))
      .map((id) => ({ method: "PUT", url: `/api/v1/workspace/inputs/${encode(id)}`, body: next.requestInputs[id] ?? {} })),
  ];
}
