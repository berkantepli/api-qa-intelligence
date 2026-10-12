// API-wide credentials: a token or key entered once (or read from a sign-in response) is used by
// every endpoint whose contract asks for it, unless the endpoint has its own value.

const operationKeyOf = (operation) => `${operation.method} ${operation.path}`;
export const credentialInputKey = (parameter) => `parameter:${parameter.location}:${parameter.name}`;

// The distinct credentials the contract documents, with the endpoints that use each one.
export function apiCredentialList(overview) {
  const found = new Map();
  for (const operation of overview?.operations ?? []) {
    for (const parameter of operation.parameters ?? []) {
      if (!parameter.credential || parameter.location === "path") continue;
      const key = credentialInputKey(parameter);
      if (!found.has(key)) found.set(key, { key, name: parameter.name, location: parameter.location, description: parameter.description ?? "", operationKeys: [] });
      found.get(key).operationKeys.push(operationKeyOf(operation));
    }
  }
  return [...found.values()];
}

const filled = (value) => typeof value === "string" && value.trim() !== "";

// Request details per endpoint with the API-wide credentials filled in where the endpoint has none.
export function withApiCredentials(overview, inputsByOperation = {}, shared = {}) {
  const credentials = apiCredentialList(overview).filter((credential) => filled(shared[credential.key]));
  if (!credentials.length) return inputsByOperation;
  const merged = { ...inputsByOperation };
  for (const credential of credentials) {
    for (const key of credential.operationKeys) {
      if (filled(merged[key]?.[credential.key])) continue;
      merged[key] = { ...(merged[key] ?? {}), [credential.key]: shared[credential.key] };
    }
  }
  return merged;
}

// An Authorization header needs a scheme; a bare token from a sign-in response gets "Bearer".
export function credentialFromToken(credential, token) {
  const value = String(token ?? "").trim();
  if (credential?.name.toLowerCase() !== "authorization" || /^[A-Za-z][\w-]*\s+\S/.test(value)) return value;
  return `Bearer ${value}`;
}

const SIGN_IN_PATH = /(log-?in|sign-?in|token|auth|session)/i;

// Endpoints that can sign in: POST requests, a likely sign-in path first.
export function signInCandidates(overview) {
  const posts = (overview?.operations ?? []).filter((operation) => operation.method === "POST");
  const likely = posts.filter((operation) => SIGN_IN_PATH.test(operation.path) && !/(refresh|logout|sign-?out|revoke)/i.test(operation.path));
  return [...likely, ...posts.filter((operation) => !likely.includes(operation))].map(operationKeyOf);
}

const isFormOperation = (operation) => /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(operation?.request_body_content_type ?? "");

// The body the contract's valid request sends, as editable JSON text.
export function signInBodyTemplate(operation) {
  if (!operation) return "";
  const happy = operation.scenarios?.find((scenario) => scenario.category === "happy_path")?.request_example;
  const body = isFormOperation(operation) ? happy?.form_fields : happy?.json_body;
  if (body && typeof body === "object" && Object.keys(body).length) return JSON.stringify(body, null, 2);
  const fields = (operation.request_body_fields ?? []).filter((field) => !field.is_file);
  return fields.length ? JSON.stringify(Object.fromEntries(fields.map((field) => [field.name, ""])), null, 2) : "";
}

// The /api/v1/auth/sign-in payload, or { error } when the body is not a JSON object.
export function buildSignInRequest(operation, { targetUrl, bodyText, tokenPointer }) {
  let body = null;
  if (bodyText.trim()) {
    try { body = JSON.parse(bodyText); } catch { return { error: "Enter the sign-in body as JSON, for example {\"email\": \"…\", \"password\": \"…\"}." }; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Enter the sign-in body as a JSON object." };
  }
  const pointer = tokenPointer.trim();
  if (pointer && !/^(\/[^/]*)+$/.test(pointer)) return { error: "Enter where the token is as a JSON Pointer, for example /access_token or /data/token." };
  const form = isFormOperation(operation);
  return {
    request: {
      base_url: targetUrl.trim(),
      method: operation.method,
      path: operation.path,
      form_body: form,
      form_fields: form && body ? Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])) : {},
      json_body: form ? null : body,
      ...(pointer ? { token_pointer: pointer } : {}),
    },
  };
}

// "Remember in this tab" keeps credentials across reloads of this tab only (sessionStorage).
const SESSION_KEY = "api-qa-intelligence-credentials";

export function readSessionCredentials() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) ?? {}; }
  catch { return {}; }
}

export function writeSessionCredentials(byApi) {
  try {
    if (Object.keys(byApi).length) sessionStorage.setItem(SESSION_KEY, JSON.stringify(byApi));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* storage may be blocked; credentials then live in memory only */ }
}
