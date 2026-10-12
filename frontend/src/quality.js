// Presents the contract quality report that imports include as `overview.quality`.

// Findings grouped by endpoint, in the overview's endpoint order; API-wide findings come first.
export function findingsByEndpoint(quality, operations = []) {
  const order = new Map(operations.map((operation, index) => [`${operation.method} ${operation.path}`, index]));
  const groups = new Map();
  for (const finding of quality?.findings ?? []) {
    const key = finding.method ? `${finding.method} ${finding.path}` : "";
    if (!groups.has(key)) groups.set(key, { key, method: finding.method, path: finding.path, operationIndex: order.get(key) ?? -1, findings: [] });
    groups.get(key).findings.push(finding);
  }
  return [...groups.values()].sort((a, b) => (a.key ? 1 : 0) - (b.key ? 1 : 0) || a.operationIndex - b.operationIndex);
}

export function qualityTone(score) {
  if (score >= 75) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export function ruleLabels(quality) {
  return Object.fromEntries((quality?.rules ?? []).map((rule) => [rule.id, rule.label]));
}
