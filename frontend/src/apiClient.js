// Calls the app's own backend and turns every failure into a message a user can act on.
export const SERVER_UNREACHABLE = "The app server is not responding. Check that it is still running, then try again.";

// Field names in request bodies, as the user sees them on screen.
const FIELD_LABELS = {
  base_url: "Target API base URL",
  url: "OpenAPI URL",
  max_duration_ms: "Response time limit",
  expected_status_codes: "Expected status codes",
  path: "Request path",
  method: "HTTP method",
  headers: "Request headers",
};

function fieldLabel(location) {
  const names = (location ?? []).filter((part) => typeof part === "string" && part !== "body");
  const known = [...names].reverse().find((name) => FIELD_LABELS[name]);
  return known ? FIELD_LABELS[known] : "";
}

// FastAPI validation errors arrive as a list of { loc, msg, type, ctx } objects; describe each one plainly.
export function validationMessage(detail, fallbackMessage) {
  const messages = detail.map((item) => {
    const label = fieldLabel(item?.loc);
    const type = String(item?.type ?? "");
    const ctx = item?.ctx ?? {};
    if (type === "value_error" && typeof item.msg === "string") return item.msg.replace(/^Value error, /, "");
    if (!label) return "";
    if (type.startsWith("url_")) return `${label} must be a valid http:// or https:// URL.`;
    if (type === "missing") return `${label} is required.`;
    if (type === "greater_than_equal") return `${label} must be at least ${ctx.ge}.`;
    if (type === "less_than_equal") return `${label} must be at most ${ctx.le}.`;
    if (type === "greater_than") return `${label} must be greater than ${ctx.gt}.`;
    if (type === "less_than") return `${label} must be less than ${ctx.lt}.`;
    return `${label} is not valid.`;
  }).filter(Boolean);
  return messages.length ? [...new Set(messages)].join(" ") : fallbackMessage;
}

export async function readJsonResponse(response, fallbackMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A proxy error page or an empty body is not JSON; the status code still says what happened.
  }
  if (!response.ok) {
    const detail = payload?.detail;
    const message = Array.isArray(detail) ? validationMessage(detail, fallbackMessage)
      : typeof detail === "string" && detail ? detail
      : response.status >= 500 ? `${fallbackMessage} The app server reported an error (HTTP ${response.status}).`
      : fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.validation = Array.isArray(detail);
    throw error;
  }
  if (payload === null) throw new Error(fallbackMessage);
  return payload;
}

export async function requestJson(url, init, fallbackMessage) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (caught) {
    if (caught?.name === "AbortError") throw caught;
    throw new Error(SERVER_UNREACHABLE);
  }
  return readJsonResponse(response, fallbackMessage);
}

export function postJson(url, body, fallbackMessage) {
  return requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, fallbackMessage);
}
