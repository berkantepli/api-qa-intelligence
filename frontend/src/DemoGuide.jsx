import { useState } from "react";
import { SERVER_UNREACHABLE } from "./apiClient.js";
import Icon from "./Icon.jsx";

export const DEMO_TITLE = "Demo Bookstore";

// The built-in demo API is the one imported from this app's own /demo contract.
export function isDemoApi(api) {
  return Boolean(api) && api.overview?.title === DEMO_TITLE && /\/demo\/openapi\.json$/.test(api.source ?? "");
}

// What the demo's deliberate problems are, and where each one shows up.
export const DEMO_STEPS = [
  { title: "Sign in", text: "In Target & auth, choose Get a token from a sign-in request, then Sign in. The demo email and password are already filled in, and the token is used by every endpoint.", action: "auth", label: "Open Target & auth" },
  { title: "A response that breaks its schema", text: "Run GET /books: one book's price is text, while the contract says number.", action: "endpoint", method: "GET", path: "/books", label: "Open GET /books" },
  { title: "An endpoint anyone can call", text: "GET /orders documents a token but answers without one, so Call without authentication fails.", action: "endpoint", method: "GET", path: "/orders", label: "Open GET /orders" },
  { title: "Validation gaps", text: "After signing in, run POST /books: it accepts a year that is not a number and a field the contract forbids, and rejects 1450, its documented minimum.", action: "endpoint", method: "POST", path: "/books", label: "Open POST /books" },
  { title: "A slow endpoint", text: "Set a response time limit of 1000 ms in Target & auth, then run GET /reports/sales, which takes about 1.5 seconds.", action: "endpoint", method: "GET", path: "/reports/sales", label: "Open GET /reports/sales" },
  { title: "A lifecycle that works", text: "On Flows, run Book lifecycle: it creates a book, reads it back, updates it, and deletes it.", action: "flows", label: "Open Flows" },
  { title: "Everything at once", text: "On Coverage & Risk, Run checks runs every endpoint; include data-changing endpoints to cover POST, PUT, and DELETE.", action: "coverage", label: "Open Coverage & Risk" },
];

export default function DemoGuide({ onOpenAuth, onOpenEndpoint, onOpenFlows, onOpenCoverage }) {
  const [reset, setReset] = useState({ status: "idle", message: "" });
  const act = (step) => {
    if (step.action === "auth") onOpenAuth();
    else if (step.action === "endpoint") onOpenEndpoint({ method: step.method, path: step.path });
    else if (step.action === "flows") onOpenFlows();
    else onOpenCoverage();
  };
  async function resetData() {
    setReset({ status: "loading", message: "" });
    try {
      const response = await fetch("/demo/__reset", { method: "POST" });
      if (!response.ok) throw new Error(`The demo data could not be reset (HTTP ${response.status}).`);
      setReset({ status: "done", message: "The three sample books are back." });
    } catch (caught) {
      setReset({ status: "error", message: caught instanceof TypeError ? SERVER_UNREACHABLE : caught.message });
    }
  }
  return <details className="demo-guide" open>
    <summary><Icon name="spark" size={15} /> Demo tour<small>{DEMO_STEPS.length} things to try with this API's deliberate problems</small></summary>
    <ol>{DEMO_STEPS.map((step) => <li key={step.title}>
      <div><strong>{step.title}</strong><span>{step.text}</span></div>
      <button className="text-button" type="button" onClick={() => act(step)}>{step.label}</button>
    </li>)}</ol>
    <div className="demo-guide-footer">
      <span>The demo keeps its data in memory. Deleting books changes what later checks see; reset to bring back the sample books.</span>
      <button className="secondary-button" type="button" disabled={reset.status === "loading"} onClick={resetData}>{reset.status === "loading" ? <><span className="spinner" /> Resetting…</> : "Reset demo data"}</button>
    </div>
    {reset.message && <p className={`demo-guide-note ${reset.status === "error" ? "request-input-error" : ""}`} role="status">{reset.message}</p>}
  </details>;
}
