export const categoryLabels = {
  happy_path: "Happy path",
  negative: "Negative",
  boundary: "Boundary",
  invalid_value: "Invalid value",
  security_minded: "Security-minded",
};

// Help text under a request input: the contract description plus the credential note.
export function inputHelp(item) {
  return [item.description, item.credential && !item.required && "Leave empty to call without credentials."].filter(Boolean).join(" ");
}

export function parameterLabel(parameter) {
  if (parameter.credential && !parameter.required) return `${parameter.location} · credential`;
  return `${parameter.location}${parameter.required ? " · required" : " · optional"}`;
}
