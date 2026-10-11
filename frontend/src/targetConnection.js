// Returns why a target base URL cannot be used for checks, or "" when it looks valid.
export function targetUrlProblem(value) {
  const url = (value ?? "").trim();
  if (!url) return "Enter a Target API base URL to run checks.";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "The target base URL is not a valid URL, for example https://api.example.com/v1.";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "The target base URL must start with http:// or https://.";
  if (parsed.username || parsed.password) return "Target URLs with embedded credentials are not supported; use a request header instead.";
  if (parsed.search || parsed.hash) return "The target base URL cannot contain a query or fragment, for example https://api.example.com/v1.";
  return "";
}

// Turns a target connection check into the topbar indicator's tone, label, and tooltip.
export function connectionLabel(state) {
  const { status, result, message, url } = state ?? {};
  if (status === "checking") return { tone: "checking", text: "Checking connection", title: `Checking ${url}` };
  if (status === "empty") return { tone: "unknown", text: "No target URL", title: "Enter the target base URL of the API to check it." };
  if (status === "invalid") return { tone: "unavailable", text: "Invalid target URL", title: message };
  if (status === "blocked") return { tone: "unavailable", text: "Target not allowed", title: message };
  if (status === "error") return { tone: "unavailable", text: "Check failed", title: message };
  if (status !== "done" || !result) return { tone: "unknown", text: "No API selected", title: "Select an API with a target base URL." };

  if (!result.reachable) {
    return { tone: "unavailable", text: "API unavailable", title: `${result.error} (${result.url})` };
  }
  const summary = `${result.method} ${result.url} returned ${result.status_code} in ${result.duration_ms} ms.`;
  // A healthy answer keeps its status code in the tooltip; a problem shows it in the label.
  if (result.status_code >= 500) return { tone: "warning", text: `API error · ${result.status_code}`, title: `${summary} The server is up but reports an error.` };
  const hint = result.status_code >= 400 ? " A 4xx at the base URL usually means there is no route there; the server is up." : "";
  return { tone: "connected", text: "API reachable", title: `${summary}${hint}` };
}
