// Turns a target connection check into the topbar indicator's tone, label, and tooltip.
export function connectionLabel(state) {
  const { status, result, message, url } = state ?? {};
  if (status === "checking") return { tone: "checking", text: "Checking connection", title: `Checking ${url}` };
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
