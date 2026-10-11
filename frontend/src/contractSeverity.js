// How severe each contract change is for clients, from the backend's comparison (POST
// /api/v1/specs/diff). The result is saved on the API's contract changes as `classified`; older
// saved changes have no classification and keep showing their plain list.
import { postJson } from "./apiClient.js";

export const SEVERITY_LABELS = { breaking: "Breaking", warning: "Warning", safe: "Safe" };

export function classifyContractChanges(base, head) {
  return postJson("/api/v1/specs/diff", { base, head }, "The contract changes could not be classified.");
}

// The saved API with the classification added, when its contract changes are still the compared ones.
export function withClassification(api, comparedAt, classified) {
  if (!api?.contractChanges || api.contractChanges.comparedAt !== comparedAt) return api;
  return { ...api, contractChanges: { ...api.contractChanges, classified } };
}

export function classifiedEndpoint(classified, key) {
  return classified?.endpoints?.find((endpoint) => `${endpoint.method} ${endpoint.path}` === key) ?? null;
}

export function severitySummary(classified) {
  const totals = classified?.totals;
  if (!totals) return "";
  const parts = [
    `${totals.breaking} breaking`,
    `${totals.warning} ${totals.warning === 1 ? "warning" : "warnings"}`,
    `${totals.safe} safe`,
  ];
  return parts.join(" · ");
}
