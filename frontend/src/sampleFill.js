// Collects empty request inputs for on-demand sample filling and turns the answer into
// input values plus per-input markers ("AI-filled", "schema sample", or "fill this in yourself").

export const parameterInputKey = (parameter) => `parameter:${parameter.location}:${parameter.name}`;
export const bodyInputKey = (field) => `body:${field.name}`;

export function collectEmptyFields({ parameters = [], bodyFields = [], parameterValue, bodyFieldValue, fileCount }) {
  const fields = [];
  for (const parameter of parameters) {
    if (String(parameterValue(parameter) ?? "").trim()) continue;
    fields.push({
      key: parameterInputKey(parameter),
      name: parameter.name,
      location: parameter.location,
      required: Boolean(parameter.required),
      description: parameter.description ?? null,
      value_schema: parameter.value_schema ?? null,
      credential: Boolean(parameter.credential),
    });
  }
  for (const field of bodyFields) {
    const empty = field.is_file ? !fileCount(field) : !String(bodyFieldValue(field) ?? "").trim();
    if (!empty) continue;
    fields.push({
      key: bodyInputKey(field),
      name: field.name,
      location: "body",
      required: Boolean(field.required),
      description: field.description ?? null,
      value_schema: field.value_schema ?? null,
      is_file: Boolean(field.is_file),
    });
  }
  return fields;
}

export const toInputValue = (value) => (value !== null && typeof value === "object" ? JSON.stringify(value) : String(value));

// Only required inputs left unfilled are flagged; optional ones simply stay empty.
export function applySampleValues(answer, fields = []) {
  const required = new Set(fields.filter((field) => field.required).map((field) => field.key));
  const inputs = {};
  const marks = {};
  for (const [key, value] of Object.entries(answer.values ?? {})) {
    inputs[key] = toInputValue(value);
    marks[key] = { kind: answer.source === "schema" ? "schema" : "ai" };
  }
  const needsUserItems = (answer.unfilled ?? []).filter((item) => required.has(item.key));
  for (const item of needsUserItems) marks[item.key] = { kind: "needs-user", reason: item.reason };
  const filled = Object.keys(inputs).length;
  const needsUser = needsUserItems.length;
  const filledText = !filled ? null : answer.source === "schema"
    ? `AI unavailable · filled ${filled} with schema samples`
    : `AI filled ${filled} ${filled === 1 ? "field" : "fields"}`;
  const needsUserText = needsUser ? `${needsUser} ${needsUser === 1 ? "field needs" : "fields need"} your input` : null;
  const summary = [filledText, needsUserText].filter(Boolean).join(" · ") || "Nothing could be filled automatically.";
  return { inputs, marks, summary };
}

export function fillHint(mark) {
  if (!mark) return null;
  if (mark.kind === "ai") return { tone: "ai", text: "AI-filled — review before running." };
  if (mark.kind === "schema") return { tone: "schema", text: "Schema sample — replace it with real test data if needed." };
  return { tone: "needs-user", text: `Fill this in yourself: ${mark.reason}` };
}
