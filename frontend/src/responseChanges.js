// What changed in a response's structure since the same check last passed: fields that
// disappeared or appeared, a field whose type changed (for example number to string, or a value
// to null), and a list that was filled and is now empty. Values themselves are not compared, so
// ids, timestamps, and prices that change on every call raise nothing. No AI is involved.

import { stepOperation } from "./flows.js";

const MAX_ITEMS = 100;
const MAX_CHANGES = 20;

const typeOf = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const childPath = (path, key) => /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
// A schema whose keys are data, such as { "available": 3, "sold": 5 }: only its values are compared.
const isMap = (schema) => Boolean(schema?.additionalProperties) && !schema.properties;

// Every path in a JSON body with the types seen there; list items share one "[*]" path and map
// values one ".*" path. `filled` lists the paths of lists that had at least one item.
export function bodyShape(value, schema = null) {
  const types = new Map();
  const filled = new Set();
  const walk = (node, path, nodeSchema) => {
    const type = typeOf(node);
    if (!types.has(path)) types.set(path, new Set());
    types.get(path).add(type);
    if (type === "array") {
      if (node.length) filled.add(path);
      node.slice(0, MAX_ITEMS).forEach((item) => walk(item, `${path}[*]`, nodeSchema?.items));
    } else if (type === "object") {
      if (isMap(nodeSchema)) {
        const valueSchema = typeof nodeSchema.additionalProperties === "object" ? nodeSchema.additionalProperties : null;
        Object.values(node).slice(0, MAX_ITEMS).forEach((item) => walk(item, `${path}.*`, valueSchema));
      } else {
        for (const [key, item] of Object.entries(node)) walk(item, childPath(path, key), nodeSchema?.properties?.[key]);
      }
    }
  };
  walk(value, "$", schema);
  return { types, filled };
}

// A path counts once: a removed object does not also list each of its fields as removed.
const underAny = (path, parents) => parents.some((parent) => path.startsWith(`${parent}.`) || path.startsWith(`${parent}[`));
const typeList = (types) => [...types].sort().join(" or ");

export function shapeChanges(before, after) {
  const changes = [];
  const gone = [];
  for (const path of before.filled) {
    if (!after.filled.has(path) && after.types.get(path)?.has("array")) {
      changes.push({ kind: "emptied", path });
      gone.push(path);
    }
  }
  // Below a field whose type changed (an object that became null), the type change says it all.
  const retyped = [];
  for (const [path, types] of before.types) {
    if (underAny(path, [...gone, ...retyped])) continue;
    const now = after.types.get(path);
    if (!now) {
      changes.push({ kind: "removed", path, from: typeList(types) });
      gone.push(path);
    } else if (typeList(types) !== typeList(now)) {
      changes.push({ kind: "type", path, from: typeList(types), to: typeList(now) });
      retyped.push(path);
    }
  }
  // A list that was empty before has no item fields to compare with, so its items are not "new".
  const added = [...after.filled].filter((path) => !before.filled.has(path)).concat(retyped);
  for (const [path, types] of after.types) {
    if (before.types.has(path) || underAny(path, added)) continue;
    changes.push({ kind: "added", path, to: typeList(types) });
    added.push(path);
  }
  return changes.slice(0, MAX_CHANGES);
}

function parseBody(result) {
  if (!result?.response_body || result.response_truncated) return undefined;
  try {
    return JSON.parse(result.response_body);
  } catch {
    return undefined;
  }
}

// The same check in an earlier run: the same endpoint and title, or the same step of the same flow.
function sameCheck(run, result, other, otherResult) {
  if ((run.apiId ?? run.api) !== (other.apiId ?? other.api)) return false;
  if (run.kind === "flow") return other.kind === "flow" && other.flowId === run.flowId && otherResult.title === result.title;
  return other.kind !== "flow" && other.endpoint === run.endpoint && otherResult.title === result.title;
}

// Compares one result with the latest earlier pass of the same check that returned the same status
// code with a JSON body. Returns null when there is nothing to compare with.
export function responseChanges(runs, run, result, schema = null) {
  const body = parseBody(result);
  if (body === undefined || result.response_status == null) return null;
  const runAt = new Date(run.createdAt);
  let previous = null;
  for (const other of runs) {
    if (other === run || other.id === run.id || !(new Date(other.createdAt) < runAt)) continue;
    if (previous && new Date(other.createdAt) <= new Date(previous.run.createdAt)) continue;
    const match = (other.results ?? []).find((item) => sameCheck(run, result, other, item)
      && item.result === "PASS" && item.response_status === result.response_status && parseBody(item) !== undefined);
    if (match) previous = { run: other, result: match };
  }
  if (!previous) return null;
  return {
    previousRunId: previous.run.id,
    previousAt: previous.run.createdAt,
    changes: shapeChanges(bodyShape(parseBody(previous.result), schema), bodyShape(body, schema)),
  };
}

const KIND_TEXT = {
  removed: (change) => `${change.path} is gone (was ${change.from})`,
  added: (change) => `${change.path} is new (${change.to})`,
  type: (change) => `${change.path} changed from ${change.from} to ${change.to}`,
  emptied: (change) => `${change.path} is now an empty list`,
};
export const changeText = (change) => KIND_TEXT[change.kind](change);

// The documented response schema for a result's status code, so map-like objects are recognized.
export function responseSchema(overview, run, result) {
  const operations = overview?.operations ?? [];
  const operation = run.kind === "flow"
    ? stepOperation(overview, { method: result.method, path: result.step_path ?? result.path ?? "" })
    : operations.find((item) => `${item.method} ${item.path}` === run.endpoint);
  return operation?.response_schemas?.[result.response_status] ?? null;
}
