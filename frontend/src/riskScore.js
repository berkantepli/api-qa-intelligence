// An explainable risk score per endpoint: the sum of fixed rule points, capped at 100.
// Impact rules come from the contract (what a bug here could break); evidence rules come from
// Run history (what we know about it). No AI is involved, so the same inputs give the same score.

export const RISK_LEVELS = [
  { id: "high", label: "High", min: 50 },
  { id: "medium", label: "Medium", min: 25 },
  { id: "low", label: "Low", min: 0 },
];

export const RISK_RULES = [
  { id: "deletes", kind: "impact", points: 20, label: "Deletes data", description: "DELETE endpoint." },
  { id: "writes", kind: "impact", points: 15, label: "Changes data", description: "POST, PUT, or PATCH endpoint." },
  { id: "auth-required", kind: "impact", points: 10, label: "Requires authentication", description: "The contract documents a credential for it." },
  { id: "sensitive", kind: "impact", points: 10, label: "Sensitive area", description: "Its path names accounts, users, orders, payments, or access control." },
  { id: "contract-changed", kind: "evidence", points: 15, label: "Changed in the contract", description: "Changed since the previous import, and not run since. (A new endpoint counts as Never tested.)" },
  { id: "failing", kind: "evidence", points: 35, label: "Failing in latest run", description: "A check failed or errored in its latest run." },
  { id: "flaky", kind: "evidence", points: 15, label: "Flaky results", description: "A check's outcome flipped at least twice in its last five results." },
  { id: "untested", kind: "evidence", points: 15, label: "Never tested", description: "No check has run against it." },
  { id: "auth", kind: "evidence", points: 10, label: "Auth not checked", description: "It requires authentication, but no check has called it without credentials." },
  { id: "happy-only", kind: "evidence", points: 10, label: "Only happy path tested", description: "Negative or boundary checks exist but only the valid request ran." },
  { id: "partial", kind: "evidence", points: 5, label: "Checks not run yet", description: "Some of its runnable checks have never run." },
  { id: "lifecycle", kind: "evidence", points: 10, label: "Lifecycle not tested", description: "It creates records and a flow covers it, but no flow through it has run." },
  { id: "stale", kind: "evidence", points: 5, label: "Not run in 7+ days", description: "Its latest run is more than a week old." },
];

const RULES = Object.fromEntries(RISK_RULES.map((rule) => [rule.id, rule]));
const SENSITIVE_WORDS = new Set([
  "account", "admin", "auth", "billing", "checkout", "invoice", "login", "order", "password", "pay", "payment",
  "permission", "refund", "role", "token", "transfer", "user", "wallet",
]);

// The first path word that names a sensitive area, e.g. "orders" in /store/orders/{id}.
export function sensitivePathWord(path = "") {
  const words = path.replace(/\{[^}]*\}/g, " ").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.find((word) => SENSITIVE_WORDS.has(word) || SENSITIVE_WORDS.has(word.replace(/s$/, ""))) ?? null;
}

export function riskLevel(score) {
  return RISK_LEVELS.find((level) => score >= level.min);
}

// `endpoint` carries what computeCoverage knows: method, path, status, needsAuth, risk flag ids,
// covered/runnable check counts, and a contract change that has not run since (contractChange).
export function scoreEndpoint(endpoint) {
  const factors = [];
  const add = (id, label) => factors.push({ id, kind: RULES[id].kind, points: RULES[id].points, label: label ?? RULES[id].label });
  const flags = new Set(endpoint.riskIds ?? []);

  if (endpoint.method === "DELETE") add("deletes");
  else if (["POST", "PUT", "PATCH"].includes(endpoint.method)) add("writes");
  if (endpoint.needsAuth) add("auth-required");
  const word = sensitivePathWord(endpoint.path);
  if (word) add("sensitive", `Sensitive area: ${word}`);

  // A new endpoint has never run, so Never tested already scores it; only changed endpoints add points here.
  if (endpoint.contractChange?.type === "changed") add("contract-changed");
  if (endpoint.status === "failing") add("failing");
  if (flags.has("flaky")) add("flaky");
  if (endpoint.status === "untested") add("untested");
  if (flags.has("auth")) add("auth");
  if (flags.has("happy-only")) add("happy-only");
  const notRun = endpoint.runnableChecks - endpoint.coveredChecks;
  if (endpoint.status !== "untested" && notRun > 0) add("partial", `${notRun} of ${endpoint.runnableChecks} checks not run yet`);
  if (flags.has("lifecycle")) add("lifecycle");
  if (flags.has("stale")) add("stale");

  const score = Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0));
  return { score, level: riskLevel(score).id, factors };
}
