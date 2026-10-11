// Decides which request details may be saved: credentials are left out, whether the contract marks
// them or only their name gives them away. Mirrors persistable_inputs in backend/app/domain/evidence.py.

export const SENSITIVE_KEY = new RegExp(
  "authorization|authentication|(?:^|[^a-z])auth(?:$|[^a-z])|cookie|token|secret|"
  + "password|passwd|passphrase|credential|api[-_]?key|private[-_]?key|(?:^|[^a-z])key(?:$|[^a-z])|"
  + "session|signature|(?:^|[^a-z])(?:pwd|pin|otp)(?:$|[^a-z])",
  "i",
);

// Plain text such as `password=secret` or `"token": "abc"`.
const SENSITIVE_ASSIGNMENT = new RegExp(
  "(?:authorization|authentication|auth|cookie|token|secret|password|passwd|passphrase|credential|"
  + "api[-_]?key|private[-_]?key|\\bkey|session\\w*|signature|\\bpwd|\\bpin|\\botp)[\"']?\\s*[:=]",
  "i",
);

export function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, stripSensitive(item)]));
  }
  return value;
}

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

// One operation's inputs, keyed `parameter:<location>:<name>`, `body:<field>`, or `body:__raw`.
export function persistableOperationInputs(inputs = {}, credentialKeys = new Set()) {
  const kept = {};
  for (const [key, original] of Object.entries(inputs)) {
    const name = key.slice(key.lastIndexOf(":") + 1);
    if (credentialKeys.has(key) || (name !== "__raw" && SENSITIVE_KEY.test(name))) continue;
    let value = original;
    if (typeof value === "string") {
      const parsed = parseJson(value);
      if (!parsed.ok) {
        if (key === "body:__raw" && SENSITIVE_ASSIGNMENT.test(value)) continue;
      } else if (parsed.value && typeof parsed.value === "object") {
        const stripped = stripSensitive(parsed.value);
        if (JSON.stringify(stripped) !== JSON.stringify(parsed.value)) {
          value = value.includes("\n") ? JSON.stringify(stripped, null, 2) : JSON.stringify(stripped);
        }
      }
    }
    kept[key] = value;
  }
  return kept;
}
