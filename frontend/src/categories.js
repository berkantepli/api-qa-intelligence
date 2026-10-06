export const categoryLabels = {
  happy_path: "Happy path",
  negative: "Negative",
  boundary: "Boundary",
  invalid_value: "Invalid value",
  security_minded: "Security-minded",
};

export function parameterLabel(parameter) {
  if (parameter.credential && !parameter.required) return `${parameter.location} · credential`;
  return `${parameter.location}${parameter.required ? " · required" : " · optional"}`;
}
